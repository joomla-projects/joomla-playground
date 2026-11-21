// The site API: what the page (and through it an editor or an AI agent) may do with the running site, besides
// browsing it. Files below the document root, PHP code, requests to the site and Joomla's console.
//
// The PHP worker runs every call in its request queue, so a call never overlaps a page request, and takes a
// snapshot afterwards when the site is saved (the filesystem journal sees these changes like any other).
//
// Paths are relative to the document root ("templates/cassiopeia/index.php"; a leading slash is allowed). They
// cannot leave it: "..", NUL and backslashes are refused, and a symbolic link must point inside it. A file's
// revision is the SHA-256 of its contents: a write that names the revision it read fails when the file changed
// since, so a change made by Joomla (or another tab of the editor) is not overwritten unnoticed.

/** Limits, so a call cannot exhaust the worker's memory or the page's patience. */
export const SITE_API_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 * 1024,
  listEntries: 20_000,
  searchResults: 200,
  searchFileBytes: 1024 * 1024,
  searchFiles: 50_000,
});

/** Folders a search skips unless it is asked to look in them. */
const SEARCH_SKIP = /^(tmp|cache|administrator\/cache|administrator\/logs|media\/vendor)(\/|$)/;

export class SiteApiError extends Error {
  /**
   * @param {string} code    NOT_FOUND, EXISTS, CONFLICT, INVALID_PATH, OUTSIDE_ROOT, IS_DIRECTORY, NOT_DIRECTORY,
   *                         ROOT_PROTECTED, NOT_EMPTY, TOO_LARGE, INVALID_ARGUMENT, UNKNOWN_OPERATION
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SiteApiError';
    this.code = code;
  }
}

/**
 * Normalizes a path relative to the document root: "a/./b/" becomes "a/b", "/" and "" become "".
 */
export function normalizePath(path = '') {
  if (typeof path !== 'string' || path.length > 4096 || /[\0\\]/.test(path)) {
    throw new SiteApiError('INVALID_PATH', 'A path is a string without NUL or backslashes, at most 4096 characters.');
  }

  const parts = path.split('/').filter((part) => part !== '' && part !== '.');

  if (parts.includes('..')) {
    throw new SiteApiError('INVALID_PATH', `"${path}" goes outside the site: ".." is not allowed.`);
  }

  return parts.join('/');
}

/**
 * @param {object} options
 * @param {import('@php-wasm/universal').PHP} options.php
 * @param {string} options.root    The document root, e.g. /var/www/html
 * @param {string} options.siteUrl The site's URL, for requests
 * @param {(request: object) => Promise<import('@php-wasm/universal').PHPResponse>} options.request Sends a request
 *        to the site, with the session (cookies) of the playground
 */
export function createSiteApi({ php, root, siteUrl, request }) {
  root = root.replace(/\/+$/, '');

  const within = (absolute) => absolute === root || absolute.startsWith(`${root}/`);

  /**
   * The absolute path of a site path, after following symbolic links, which must stay inside the root. With
   * { followLast: false } the last part may be a link itself (to rename or delete the link, not its target).
   */
  function resolve(path, { followLast = true } = {}) {
    const parts = normalizePath(path).split('/').filter(Boolean);
    let current = root;

    for (let index = 0; index < parts.length; index++) {
      current = `${current}/${parts[index]}`;

      for (let hops = 0; (followLast || index < parts.length - 1) && php.isSymlink(current); hops++) {
        if (hops > 16) {
          throw new SiteApiError('INVALID_PATH', `Too many symbolic links in "${path}".`);
        }

        const target = php.readlink(current);
        current = collapse(target.startsWith('/') ? target : `${current.slice(0, current.lastIndexOf('/'))}/${target}`);
      }

      if (!within(current)) {
        throw new SiteApiError('OUTSIDE_ROOT', `"${path}" leads outside the site.`);
      }
    }

    return current;
  }

  function relative(absolute) {
    return absolute === root ? '' : absolute.slice(root.length + 1);
  }

  function type(absolute) {
    if (php.isSymlink(absolute)) {
      return 'symlink';
    }

    if (php.isDir(absolute)) {
      return 'directory';
    }

    return php.fileExists(absolute) ? 'file' : null;
  }

  function existing(path, options) {
    const absolute = resolve(path, options);
    const kind = type(absolute);

    if (!kind) {
      throw new SiteApiError('NOT_FOUND', `"${normalizePath(path)}" does not exist.`);
    }

    return { absolute, kind };
  }

  function notRoot(absolute, what) {
    if (absolute === root) {
      throw new SiteApiError('ROOT_PROTECTED', `The site's root folder cannot be ${what}.`);
    }
  }

  /** PHP files below a path, to remove from OPcache after a change. */
  function phpFiles(absolute) {
    if (!php.isDir(absolute) || php.isSymlink(absolute)) {
      return absolute.endsWith('.php') ? [absolute] : [];
    }

    return php.listFiles(absolute).flatMap((name) => phpFiles(`${absolute}/${name}`));
  }

  async function invalidate(files) {
    if (files.length) {
      // OPcache checks timestamps by itself, but a file written twice within its resolution could be served from
      // the cache; this makes a saved file count from the next request on.
      await php.run({ code: `<?php foreach (${JSON.stringify(files)} as $file) { opcache_invalidate($file, true); }` }).catch(() => {});
    }
  }

  const operations = {
    /** The site and the API: what an editor or agent needs to know first. */
    async info() {
      const response = await php.run({
        code: `<?php
          const _JEXEC = 1;
          require_once '${root}/libraries/src/Version.php';
          echo json_encode(['php' => PHP_VERSION, 'joomla' => (new \\Joomla\\CMS\\Version())->getShortVersion()]);`,
      });

      return { siteUrl, root, limits: SITE_API_LIMITS, ...JSON.parse(response.text) };
    },

    async stat({ path = '' } = {}) {
      const absolute = resolve(path, { followLast: false });
      const kind = type(absolute);

      if (!kind) {
        return { path: normalizePath(path), type: null };
      }

      const result = { path: relative(absolute) || normalizePath(path), type: kind };

      if (kind === 'symlink') {
        result.target = php.readlink(absolute);
      } else if (kind === 'file') {
        const bytes = php.readFileAsBuffer(absolute);
        result.size = bytes.length;
        result.revision = await sha256(bytes);
      }

      return result;
    },

    async list({ path = '' } = {}) {
      const { absolute, kind } = existing(path);

      if (kind !== 'directory') {
        throw new SiteApiError('NOT_DIRECTORY', `"${normalizePath(path)}" is not a folder.`);
      }

      const names = php.listFiles(absolute);

      if (names.length > SITE_API_LIMITS.listEntries) {
        throw new SiteApiError('TOO_LARGE', `"${normalizePath(path)}" has more than ${SITE_API_LIMITS.listEntries} entries.`);
      }

      return names
        .map((name) => ({ name, type: type(`${absolute}/${name}`) }))
        .sort((a, b) => (b.type === 'directory') - (a.type === 'directory') || a.name.localeCompare(b.name));
    },

    /** A file as text (UTF-8), or as base64 when it is not valid UTF-8 or { encoding: 'base64' } is asked. */
    async read({ path, encoding = 'auto' } = {}) {
      const { absolute, kind } = existing(path);

      if (kind === 'directory') {
        throw new SiteApiError('IS_DIRECTORY', `"${normalizePath(path)}" is a folder.`);
      }

      const bytes = php.readFileAsBuffer(absolute);

      if (bytes.length > SITE_API_LIMITS.fileBytes) {
        throw new SiteApiError('TOO_LARGE', `"${normalizePath(path)}" is larger than ${SITE_API_LIMITS.fileBytes} bytes.`);
      }

      const result = { path: relative(absolute), size: bytes.length, revision: await sha256(bytes) };
      const text = encoding === 'base64' ? null : utf8(bytes);

      return text === null ? { ...result, base64: toBase64(bytes) } : { ...result, text };
    },

    /**
     * Writes a file, with its folders. revision: the revision read before (fails with CONFLICT when the file
     * changed since), null (fails with EXISTS when the file exists), or left out (overwrites).
     */
    async write({ path, text, base64, revision } = {}) {
      if ((text === undefined) === (base64 === undefined)) {
        throw new SiteApiError('INVALID_ARGUMENT', 'Give the contents as either text or base64.');
      }

      const bytes = text !== undefined ? new TextEncoder().encode(String(text)) : fromBase64(base64);

      if (bytes.length > SITE_API_LIMITS.fileBytes) {
        throw new SiteApiError('TOO_LARGE', `The contents are larger than ${SITE_API_LIMITS.fileBytes} bytes.`);
      }

      const absolute = resolve(path);
      notRoot(absolute, 'overwritten');
      const kind = type(absolute);

      if (kind === 'directory') {
        throw new SiteApiError('IS_DIRECTORY', `"${normalizePath(path)}" is a folder.`);
      }

      if (revision === null && kind) {
        throw new SiteApiError('EXISTS', `"${normalizePath(path)}" exists already.`);
      }

      if (typeof revision === 'string') {
        if (!kind) {
          throw new SiteApiError('CONFLICT', `"${normalizePath(path)}" was deleted since it was read.`);
        }

        if ((await sha256(php.readFileAsBuffer(absolute))) !== revision) {
          throw new SiteApiError('CONFLICT', `"${normalizePath(path)}" changed since it was read.`);
        }
      }

      const parent = absolute.slice(0, absolute.lastIndexOf('/'));

      if (type(parent) === null) {
        php.mkdirTree(parent);
      } else if (type(parent) !== 'directory') {
        throw new SiteApiError('NOT_DIRECTORY', `"${relative(parent)}" is not a folder.`);
      }

      php.writeFile(absolute, bytes);
      await invalidate(phpFiles(absolute));

      return { path: relative(absolute), size: bytes.length, revision: await sha256(bytes), created: !kind };
    },

    async mkdir({ path } = {}) {
      const absolute = resolve(path);
      const kind = type(absolute);

      if (kind === 'directory') {
        return { path: relative(absolute), created: false };
      }

      if (kind) {
        throw new SiteApiError('EXISTS', `"${normalizePath(path)}" exists and is not a folder.`);
      }

      php.mkdirTree(absolute);

      return { path: relative(absolute), created: true };
    },

    /** Renames or moves a file or folder; { overwrite: true } replaces an existing file (never a folder). */
    async rename({ from, to, overwrite = false } = {}) {
      const source = existing(from, { followLast: false });
      notRoot(source.absolute, 'moved');
      const target = resolve(to, { followLast: false });
      notRoot(target, 'replaced');

      if (target === source.absolute || target.startsWith(`${source.absolute}/`)) {
        throw new SiteApiError('INVALID_ARGUMENT', 'A folder cannot be moved into itself.');
      }

      const targetKind = type(target);

      if (targetKind && (!overwrite || targetKind === 'directory' || source.kind === 'directory')) {
        throw new SiteApiError('EXISTS', `"${normalizePath(to)}" exists already.`);
      }

      const parent = target.slice(0, target.lastIndexOf('/'));

      if (type(parent) === null) {
        php.mkdirTree(parent);
      }

      const changed = phpFiles(source.absolute);

      if (targetKind) {
        php.unlink(target);
      }

      php.mv(source.absolute, target);
      await invalidate([...changed, ...phpFiles(target)]);

      return { from: relative(source.absolute), to: relative(target) };
    },

    /** Deletes a file, a link, or a folder; a folder that is not empty only with { recursive: true }. */
    async delete({ path, recursive = false } = {}) {
      const { absolute, kind } = existing(path, { followLast: false });
      notRoot(absolute, 'deleted');
      const changed = phpFiles(absolute);

      if (kind === 'directory') {
        if (!recursive && php.listFiles(absolute).length) {
          throw new SiteApiError('NOT_EMPTY', `"${normalizePath(path)}" is not empty; delete it with recursive.`);
        }

        php.rmdir(absolute, { recursive: true });
      } else {
        php.unlink(absolute);
      }

      await invalidate(changed);

      return { path: relative(absolute), deleted: kind };
    },

    /**
     * Finds text in the site's files: { query } (plain text, or a regular expression with { regex: true }),
     * below { path }, in files whose path matches { glob } ("*.php", "**\/*.ini"). Caches, logs and media/vendor
     * are skipped unless { all: true }. Results: path, line number and the line, at most { limit }.
     */
    async search({ query, path = '', regex = false, caseSensitive = false, glob = null, all = false, limit = SITE_API_LIMITS.searchResults } = {}) {
      if (typeof query !== 'string' || query === '') {
        throw new SiteApiError('INVALID_ARGUMENT', 'Give a query to search for.');
      }

      let pattern;
      // To skip files without a match quickly: the same pattern on the whole file, where ^ and $ match at lines.
      let filePattern;

      try {
        const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pattern = new RegExp(source, caseSensitive ? '' : 'i');
        filePattern = new RegExp(source, caseSensitive ? 'm' : 'im');
      } catch (error) {
        throw new SiteApiError('INVALID_ARGUMENT', `Not a regular expression: ${error.message}`);
      }

      const fileFilter = glob ? globToRegExp(glob) : null;
      const { absolute, kind } = existing(path);
      const results = [];
      let files = 0;
      let truncated = false;
      const stack = kind === 'directory' ? [absolute] : [];

      if (kind !== 'directory') {
        searchFile(absolute);
      }

      while (stack.length && !truncated) {
        const folder = stack.pop();

        for (const name of php.listFiles(folder).sort().reverse()) {
          const child = `${folder}/${name}`;
          const childPath = relative(child);

          if (php.isSymlink(child)) {
            continue;
          }

          if (php.isDir(child)) {
            if (all || !SEARCH_SKIP.test(childPath)) {
              stack.push(child);
            }
          } else if (!fileFilter || fileFilter.test(childPath)) {
            searchFile(child);
          }

          if (truncated) {
            break;
          }
        }
      }

      function searchFile(file) {
        if (++files > SITE_API_LIMITS.searchFiles) {
          truncated = true;

          return;
        }

        const bytes = php.readFileAsBuffer(file);

        if (bytes.length > SITE_API_LIMITS.searchFileBytes) {
          return;
        }

        const text = utf8(bytes);

        if (text === null || !filePattern.test(text)) {
          return;
        }

        const lines = text.split('\n');

        for (let index = 0; index < lines.length; index++) {
          if (pattern.test(lines[index])) {
            if (results.length >= limit) {
              truncated = true;

              return;
            }

            results.push({ path: relative(file), line: index + 1, text: lines[index].slice(0, 500) });
          }
        }
      }

      return { results, truncated };
    },

    /**
     * Runs PHP code in the site's root folder. code is PHP source: "<?php" at the start may be left out. The
     * result has the output, the errors, and the exit code; a failure in the code is a result, not an error.
     */
    async runPhp({ code } = {}) {
      if (typeof code !== 'string' || code.trim() === '') {
        throw new SiteApiError('INVALID_ARGUMENT', 'Give the PHP code to run.');
      }

      const source = /^\s*<\?php/.test(code) ? code : `<?php\n${code}`;
      const response = await runAllowingFailure(() => {
        php.chdir(root);

        return php.run({ code: source });
      });

      return { exitCode: response.exitCode, output: response.text, errors: response.errors };
    },

    /**
     * Sends a request to the site, as the playground's own session (logged in to the administrator). path is
     * relative to the site ("/administrator/index.php?option=com_content"). The body is text, or base64.
     */
    async request({ path = '/', method = 'GET', headers = {}, body, base64 } = {}) {
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
        throw new SiteApiError('INVALID_ARGUMENT', 'The path of a request starts with a single "/".');
      }

      const data = base64 !== undefined ? fromBase64(base64) : body !== undefined ? new TextEncoder().encode(String(body)) : undefined;
      const response = await request({ url: `${siteUrl}${path}`, method: String(method).toUpperCase(), headers, body: data });
      const text = utf8(response.bytes);
      const result = { status: response.httpStatusCode, headers: response.headers };

      return text === null ? { ...result, base64: toBase64(response.bytes) } : { ...result, text };
    },

    /**
     * Runs Joomla's console (cli/joomla.php) with these arguments, e.g. ["extension:list", "--type=component"].
     * It never asks questions: --no-interaction is added.
     */
    async cli({ args = [] } = {}) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new SiteApiError('INVALID_ARGUMENT', 'Give the arguments as an array of strings.');
      }

      const argv = ['joomla.php', ...args, ...(args.includes('--no-interaction') || args.includes('-n') ? [] : ['--no-interaction'])];
      const response = await runAllowingFailure(() => {
        php.chdir(root);

        return php.run({ code: consoleRunner(root, argv) });
      });

      return { exitCode: response.exitCode, output: response.text, errors: response.errors };
    },
  };

  return {
    operations: Object.keys(operations),

    /** Runs one operation: call('read', { path: 'index.php' }). */
    call(operation, args = {}) {
      if (!Object.hasOwn(operations, operation)) {
        throw new SiteApiError('UNKNOWN_OPERATION', `There is no operation "${operation}".`);
      }

      return operations[operation](args ?? {});
    },
  };
}

/**
 * Joomla's console, as cli/joomla.php starts it, for php.run(). There STDIN and STDOUT do not exist (the console
 * application closes itself without them) and php://stdout is not part of the output, so the console gets an empty
 * input and writes to php://output.
 */
function consoleRunner(root, argv) {
  return `<?php
    $_SERVER['argv'] = $argv = json_decode(base64_decode('${toBase64(new TextEncoder().encode(JSON.stringify(argv)))}'), true);
    $_SERVER['argc'] = $argc = count($argv);
    defined('STDIN') || define('STDIN', fopen('php://memory', 'r'));
    defined('STDOUT') || define('STDOUT', fopen('php://output', 'w'));
    defined('STDERR') || define('STDERR', STDOUT);
    const _JEXEC = 1;

    if (file_exists('${root}/defines.php')) {
        require_once '${root}/defines.php';
    }

    if (!defined('_JDEFINES')) {
        define('JPATH_BASE', '${root}');
        require_once JPATH_BASE . '/includes/defines.php';
    }

    require_once JPATH_BASE . '/includes/framework.php';

    $container = \\Joomla\\CMS\\Factory::getContainer();
    $container->alias('session', 'session.cli')
        ->alias('JSession', 'session.cli')
        ->alias(\\Joomla\\CMS\\Session\\Session::class, 'session.cli')
        ->alias(\\Joomla\\Session\\Session::class, 'session.cli')
        ->alias(\\Joomla\\Session\\SessionInterface::class, 'session.cli');

    $app = $container->get(\\Joomla\\Console\\Application::class);
    (new ReflectionProperty(\\Joomla\\Console\\Application::class, 'consoleOutput'))
        ->setValue($app, new \\Symfony\\Component\\Console\\Output\\StreamOutput(fopen('php://output', 'w')));
    \\Joomla\\CMS\\Factory::$application = $app;
    $app->execute();
  `;
}

/** php.run() throws when the exit code is not 0; for running code that is a result. */
async function runAllowingFailure(run) {
  try {
    return await run();
  } catch (error) {
    if (error?.response) {
      return error.response;
    }

    throw error;
  }
}

function collapse(path) {
  const parts = [];

  for (const part of path.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '' && part !== '.') {
      parts.push(part);
    }
  }

  return `/${parts.join('/')}`;
}

function globToRegExp(glob) {
  const source = glob
    .split('**/')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('(?:.*/)?');

  return new RegExp(glob.includes('/') ? `^${source}$` : `(?:^|/)${source}$`);
}

function utf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function toBase64(bytes) {
  let binary = '';

  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return btoa(binary);
}

function fromBase64(text) {
  try {
    return Uint8Array.from(atob(String(text)), (char) => char.charCodeAt(0));
  } catch {
    throw new SiteApiError('INVALID_ARGUMENT', 'Not valid base64.');
  }
}

async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
