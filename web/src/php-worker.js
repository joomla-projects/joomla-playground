// PHP worker of the Joomla Playground: runs Joomla in PHP compiled to WebAssembly.
//
// It puts a Joomla site into PHP's in-memory filesystem, points it at this tab's scope URL, sets the Super User
// password, logs in, and answers the requests the service worker sends for that scope. The site comes from:
// - a pre-installed bundle (joomla/<version>/site.zip, see bin/build-browser-bundles.php): a temporary playground;
// - a saved site in the browser's private file system (OPFS): the zip it started from plus a snapshot of the files
//   that changed since, rewritten shortly after requests that change files (see storage.js);
// - an imported zip (an export of a playground).
// A new playground can follow a blueprint (see blueprint.js): PHP version, landing page, steps to set it up.
//
// The page talks to it with messages { type, id, ... }; the worker answers { type: 'result', id, value | error }
// and sends { type: 'progress', message } while it works.

import { PHP, PHPRequestHandler, setPhpIniEntries } from '@php-wasm/universal';
import { certificateToPEM, generateCertificate, loadWebRuntime } from '@php-wasm/web';
import { journalFSEvents } from '@php-wasm/fs-journal';
import { createSpawnHandler } from '@php-wasm/util';
import { hasBase, readBase, readMeta, readSnapshot, siteLockName, writeBase, writeMeta, writeSnapshot } from './storage.js';
import { DEFAULT_PHP_VERSION } from './blueprint.js';
import { BlueprintError, joomlaPhp, runSteps } from './blueprint-steps.js';
import { createSiteApi } from './site-api.js';
import { memoryZip, openRemoteZip } from './zip-ranges.js';

const DOCUMENT_ROOT = '/var/www/html';
const CA_BUNDLE = '/internal/shared/ca-bundle.crt';
const PREPEND_FILE = '/internal/shared/playground-prepend.php';

/** Caches, logs and temporary files: left out of exports and snapshots (a PHP regular expression). */
const SKIP = '#^(tmp|cache|administrator/cache|administrator/logs)/(?!index\\.html$)#';

/** The zip comment of a media file in an export that the bundle has: an import empties it again (see exportSite()). */
const MEDIA_COMMENT = 'joomla-playground:bundle-media';

/**
 * After a form submission (any method but GET and HEAD) that changed files, a snapshot is written before the next
 * request runs. After other requests (sessions, caches) it is written this long after the last one that changed
 * files, and at most this long after the first.
 */
const SNAPSHOT_DELAY = 500;
const SNAPSHOT_MAX_DELAY = 5000;

const channel = new BroadcastChannel('joomla-playground');

/**
 * base:    the zip the site started from; its bytes are kept until the site is saved
 * changes: paths below the document root that changed since the site was unpacked from its base, and the folders
 *          that were renamed (moved with all their files)
 * dirty:   whether files changed since the last snapshot
 * api:     the site API (see site-api.js)
 *
 * @type {{php: PHP, phpVersion: string, handler: PHPRequestHandler, manifest: object, bundleUrl: string, password: string, site: string|null,
 *   base: {id: string|null, bytes: Uint8Array|null}, changes: {paths: Set<string>, trees: Set<string>}, dirty: boolean, api: ReturnType<typeof createSiteApi>}}
 */
let state = null;

/**
 * Runs PHP requests one after the other. With a single PHP instance, @php-wasm rejects a request that arrives
 * while another one runs (SinglePHPInstanceManager), and pages fire several AJAX requests at once. Snapshots run
 * in this queue too, so no request changes files while one is taken.
 */
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});

  return run;
}

const actions = { boot, save, exportSite, flush, site: siteApi, pullRequestTest, patchTester, pullRequestPackage };

self.onmessage = async ({ data }) => {
  const action = actions[data?.type];

  if (!action) {
    return;
  }

  try {
    const { value, transfer = [] } = await action(data);
    self.postMessage({ type: 'result', id: data.id, value }, transfer);
  } catch (error) {
    self.postMessage({ type: 'result', id: data.id, error: String(error?.message ?? error), code: error?.code ?? null });
  }
};

function progress(message) {
  self.postMessage({ type: 'progress', message });
}

/**
 * @param {object} options
 * @param {string} options.base   URL of the playground (the folder of index.html)
 * @param {string} options.scope  This tab's scope, e.g. "scope-abc123-6-2-0"
 * @param {string} options.joomla The Joomla version of the bundle to use (joomla/<version>/)
 * @param {string} [options.site] Slug of a saved site to open, or to create from the bundle
 * @param {string} [options.title] Title for a new saved site
 * @param {ArrayBuffer} [options.zip] An exported playground to start from
 * @param {string} [options.zipUrl] An exported playground to download and start from (a prebuilt demo)
 * @param {string} [options.php] PHP version; default: the saved site's, or DEFAULT_PHP_VERSION
 * @param {object} [options.blueprint] How to set up a new playground (see blueprint.js)
 * @param {string} [options.corsProxy] URL of a CORS proxy (proxy/cors-proxy.js) for downloads
 */
async function boot({ base, scope, joomla, site = null, title = null, zip = null, zipUrl = null, php: phpVersion = null, blueprint = null, corsProxy = null }) {
  const started = performance.now();
  const timings = {};
  const lap = (name) => (timings[name] = Math.round(performance.now() - started));
  const siteUrl = new URL(`${scope}/`, base).href.replace(/\/$/, '');

  if (site) {
    await lockSite(site);
  }

  const meta = site ? await readMeta(site) : null;

  phpVersion = phpVersion ?? meta?.php ?? DEFAULT_PHP_VERSION;
  progress(`Loading PHP ${phpVersion}`);
  const caRoot = await generateCertificate({
    subject: { commonName: 'Joomla Playground CA', organizationName: 'Joomla Playground', countryName: 'NL' },
    basicConstraints: { ca: true },
  });
  const [php, manifest, files] = await Promise.all([
    // Outgoing HTTP(S) from PHP goes through the browser's fetch() (see enableNetwork()).
    loadWebRuntime(phpVersion, { tcpOverFetch: { CAroot: caRoot, ...(corsProxy ? { corsProxyUrl: corsProxy } : {}) } }).then((runtime) => (lap('php'), new PHP(runtime))),
    fetch(new URL(`joomla/${joomla}/manifest.json`, base)).then((response) => response.json()),
    siteFiles({ bundle: new URL(`joomla/${joomla}/`, base), site, meta, zip, zipUrl }).then((files) => (lap(meta ? 'read' : 'download'), files)),
  ]);

  const password = meta?.password ?? randomPassword();

  // php.ini settings, before PHP runs anything.
  await enableNetwork(php, caRoot);
  const bundleUrl = new URL(`joomla/${joomla}/`, base).href;

  await prependFile(php, { sitePath: new URL(siteUrl).pathname, hasCorsProxy: Boolean(corsProxy), password, bundleUrl, languagePacks: manifest.languages ?? 0 });
  await setPhpIniEntries(php, { sendmail_path: '/usr/sbin/sendmail -t -i' });

  progress(meta ? 'Opening the saved site' : 'Unpacking Joomla');
  php.mkdir(DOCUMENT_ROOT);
  php.writeFile('/tmp/site.zip', files.bytes);
  const unpacked = await runPhp(php, `
    $zip = new ZipArchive();
    if ($zip->open('/tmp/site.zip') !== true || !$zip->extractTo('${DOCUMENT_ROOT}')) {
        throw new RuntimeException('Cannot unpack the site');
    }
    // An export says which Joomla version and driver it holds (see exportSite()).
    file_put_contents('/tmp/archive-comment.json', (string) $zip->getArchiveComment());
    // The media files an export got from the bundle: placeholders again, as in the bundle. The service worker serves
    // them from the bundle.
    $emptied = 0;
    for ($index = 0; $index < $zip->numFiles; $index++) {
        if ($zip->getCommentIndex($index) === ${JSON.stringify(MEDIA_COMMENT)}) {
            file_put_contents('${DOCUMENT_ROOT}/' . $zip->getNameIndex($index), '');
            $emptied++;
        }
    }
    $zip->close();
    if (!is_file('${DOCUMENT_ROOT}/configuration.php') || !is_file('${DOCUMENT_ROOT}/data/joomla.sqlite')) {
        throw new RuntimeException('This zip is not a Joomla Playground export');
    }
    echo $emptied;
  `);

  php.unlink('/tmp/site.zip');

  // The base of the site when it is saved: the export with those placeholders.
  if (Number(unpacked.text) > 0) {
    files.bytes = withoutBundleMedia(files.bytes);
  }

  lap('unpack');

  const changes = { paths: new Set(), trees: new Set() };

  if (files.snapshot) {
    for (const path of await restoreSnapshot(php, files.snapshot)) {
      changes.paths.add(path);
    }

    lap('restore');
  }

  // The media files with content (an export's own, a pull request's build, files of extensions): the service
  // worker takes those from the site instead of the bundle. From here on, changes below media/ update the list.
  const mediaOverrides = await scanMediaOverrides(php);

  // Before the journal starts: a change that is made at every start, not saved with the site.
  trustPlaygroundCa(php, caRoot);

  // From here on, note every path below the document root that changes: those go into the snapshots.
  journalFSEvents(php, DOCUMENT_ROOT, (entry) => trackChange(changes, entry));


  // Mail: PHP's mail() and Joomla's sendmail mailer start "sendmail"; the worker catches the message instead.
  php.setCommandSpawnHandler('sendmail', createSpawnHandler(catchMail));

  progress('Configuring the site');
  php.writeFile('/tmp/playground.json', JSON.stringify({ siteUrl, password, root: DOCUMENT_ROOT }));
  await runPhp(php, `
    $settings = json_decode(file_get_contents('/tmp/playground.json'), true);
    unlink('/tmp/playground.json');

    // configuration.php: this tab's URL and the in-memory paths.
    $file   = $settings['root'] . '/configuration.php';
    $values = [
        'live_site' => $settings['siteUrl'],
        'tmp_path'  => $settings['root'] . '/tmp',
        'log_path'  => $settings['root'] . '/administrator/logs',
        // Mails go to the playground's inbox (see catchMail()).
        'mailonline' => true,
        'mailer'     => 'sendmail',
        'sendmail'   => '/usr/sbin/sendmail',
    ];
    $configuration = file_get_contents($file);
    foreach ($values as $key => $value) {
        $configuration = preg_replace('/public \\$' . $key . ' = [^;]*;/', 'public $' . $key . ' = ' . var_export($value, true) . ';', $configuration);
    }
    chmod($file, 0644);
    file_put_contents($file, $configuration);

    // The Super User password of this playground. The tables are plain SQLite tables for either driver.
    $db = new PDO('sqlite:' . $settings['root'] . '/data/joomla.sqlite');
    $statement = $db->prepare("UPDATE jos_users SET password = ? WHERE username = 'admin'");
    $statement->execute([password_hash($settings['password'], PASSWORD_DEFAULT)]);
  `);
  lap('configure');

  const createHandler = () =>
    new PHPRequestHandler({
      php,
      documentRoot: DOCUMENT_ROOT,
      absoluteUrl: siteUrl,
      // Joomla's .htaccess sends unknown site paths to index.php (SEF URLs).
      getFileNotFoundAction: (relativePath) =>
        relativePath.startsWith('/administrator') || relativePath.startsWith('/api')
          ? { type: '404' }
          : { type: 'internal-redirect', uri: '/index.php' },
    });

  state = {
    php,
    phpVersion,
    handler: createHandler(),
    manifest,
    bundleUrl,
    scope,
    corsProxy,
    caRoot,
    mediaOverrides,
    password,
    site: null,
    base: { id: meta?.base ?? null, bytes: meta ? null : files.bytes },
    changes,
    dirty: false,
  };
  // Requests of the site API go through the current handler: a blueprint with "login": false replaces it.
  state.api = createSiteApi({ php, root: DOCUMENT_ROOT, siteUrl, request: (request) => state.handler.request(request) });

  if (meta) {
    state.site = site;
    await writeMeta(site, { ...meta, php: phpVersion, opened: new Date().toISOString() });
  }

  // A blueprint sets up a new playground only; a saved site is opened as it was. Steps with "background": true run
  // after the playground is ready, between the requests of the page.
  const allSteps = meta ? [] : (blueprint?.steps ?? []);
  const steps = allSteps.filter((step) => !step.background);
  const backgroundSteps = allSteps.filter((step) => step.background);
  const login = blueprint?.login !== false;
  let blueprintError = null;

  if (login || allSteps.length) {
    progress('Logging in');
    await logIn(state.handler, siteUrl, password);
    lap('login');
  }

  const stepContext = (handler, run) => ({
    php,
    siteUrl,
    root: DOCUMENT_ROOT,
    corsProxy,
    baseUrl: blueprint.baseUrl ?? base,
    languagePacks: manifest.languages ? new URL('languages/', bundleUrl).href : null,
    request: (url, init = {}) => run(() => handler.request({ url, ...init })),
    runPhp: (code) => run(() => runPhp(php, code)),
    logIn: () => run(() => logIn(handler, siteUrl, password)),
  });
  const stepHandler = state.handler;

  if (steps.length) {
    try {
      await runSteps(steps, { ...stepContext(stepHandler, (task) => task()), progress });
    } catch (error) {
      if (!(error instanceof BlueprintError)) {
        throw error;
      }

      blueprintError = error.message;
    }

    lap('blueprint');

    // The steps ran logged in; a blueprint with "login": false starts logged out.
    if (!login) {
      state.handler = createHandler();
    }
  }

  if (site && !meta) {
    await persist(site, title ?? site);
  }

  lap('ready');
  scheduleSnapshot();

  if (backgroundSteps.length) {
    // Through the request queue, so the page's own requests get their turn in between. The pause lets a request
    // from the service worker (a message event) join the queue first: without it, the next background request would
    // always be queued at once, and the page would wait until all background steps are done.
    const queued = async (task) => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return serialized(task).finally(() => {
        updateMediaOverrides();
        scheduleSnapshot();
      });
    };
    const notice = (message) => self.postMessage({ type: 'background', message });

    runSteps(backgroundSteps, { ...stepContext(stepHandler, queued), progress: notice })
      .then(() => notice(null))
      .catch((error) => notice(String(error?.message ?? error)));
  }

  channel.onmessage = ({ data }) => {
    if (data?.scope !== scope) {
      return;
    }

    if (data.type === 'request') {
      answer(data);
    } else if (data.type === 'media-overrides-request') {
      publishMediaOverrides();
    }
  };

  // The blueprint's steps may have written media files: the service worker gets the list before the first page.
  updateMediaOverrides();
  publishMediaOverrides();

  return {
    value: {
      siteUrl,
      username: 'admin',
      password,
      manifest,
      timings,
      phpVersion,
      site: state.site,
      landingPage: blueprint?.landingPage ?? null,
      blueprintError,
      importedFrom: zip ? siteComment(php) : null,
    },
  };
}

/**
 * The zip to start from (the bundle, an imported export, or a saved site's base), and a saved site's snapshot.
 */
async function siteFiles({ bundle, site, meta, zip, zipUrl }) {
  if (zipUrl) {
    return { bytes: await download(new URL(zipUrl), 'the prebuilt demo'), snapshot: null };
  }

  if (!meta) {
    return { bytes: zip ? new Uint8Array(zip) : await download(new URL('site.zip', bundle)), snapshot: null };
  }

  if (!meta.base) {
    throw new Error(`The site "${site}" was saved by an earlier version of the playground and cannot be opened`);
  }

  const [bytes, snapshot] = await Promise.all([readBase(meta.base), readSnapshot(site)]);

  if (!bytes) {
    throw new Error(`The files of the site "${site}" are missing in this browser`);
  }

  return { bytes, snapshot };
}

/**
 * Saves the running playground as a site in OPFS. From then on, a snapshot of its changes is written there shortly
 * after requests that change files.
 */
async function save({ site, title }) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  if (state.site) {
    throw new Error(`This playground is already saved as "${state.site}"`);
  }

  await lockSite(site);
  await serialized(() => persist(site, title));

  return { value: { site } };
}

/**
 * Writes the base (once per zip), a first snapshot and then meta.json: a site is listed only when it is complete.
 */
async function persist(site, title) {
  progress('Saving the site in this browser');

  const id = await sha256(state.base.bytes);

  if (!(await hasBase(id))) {
    await writeBase(id, state.base.bytes);
  }

  await snapshot(site);
  await writeMeta(site, {
    title,
    password: state.password,
    joomla: state.manifest.joomla,
    driver: state.manifest.driver,
    php: state.phpVersion,
    base: id,
    created: new Date().toISOString(),
  });
  state.base = { id, bytes: null };
  state.site = site;
}

/**
 * Notes a filesystem operation of PHP (see journalFSEvents()) as a changed path, relative to the document root.
 */
function trackChange(changes, { operation, path, toPath, nodeType }) {
  const relative = (absolute) => (absolute?.startsWith(`${DOCUMENT_ROOT}/`) ? absolute.slice(DOCUMENT_ROOT.length + 1) : null);
  const from = relative(path);
  const to = operation === 'RENAME' ? relative(toPath) : null;

  for (const path of [from, to]) {
    if (path === 'media' || path?.startsWith('media/')) {
      mediaTouched.add(path);
    }
  }

  if (from) {
    changes.paths.add(from);
  }

  if (to) {
    changes.paths.add(to);

    if (nodeType === 'directory') {
      changes.trees.add(to);
    }
  }

  if (state && (from || to)) {
    state.dirty = true;
  }
}

/** Paths below media/ that PHP created, changed, renamed or deleted since the media overrides were last updated. */
const mediaTouched = new Set();

/**
 * The files below media/ that have content, relative to the document root. The bundle's media files are empty
 * placeholders in the site (see bin/build-browser-bundle.php); the service worker serves those from the bundle.
 */
async function scanMediaOverrides(php) {
  const response = await runPhp(php, `
    $root  = '${DOCUMENT_ROOT}';
    $found = [];
    if (is_dir($root . '/media')) {
        $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/media', FilesystemIterator::SKIP_DOTS));
        foreach ($files as $file) {
            if ($file->isFile() && $file->getSize() > 0) {
                $found[] = substr($file->getPathname(), strlen($root) + 1);
            }
        }
    }
    echo json_encode($found);
  `);

  return new Set(JSON.parse(response.text));
}

/**
 * Brings the media overrides up to date with the paths PHP touched, and sends them to the service worker when they
 * changed: before the answer to the request that changed them, so the next page gets the new files.
 */
function updateMediaOverrides() {
  if (!state || !mediaTouched.size) {
    return;
  }

  const overrides = state.mediaOverrides;
  const before = overrides.size;
  let changed = false;

  const check = (relative) => {
    const absolute = `${DOCUMENT_ROOT}/${relative}`;

    if (state.php.isDir(absolute)) {
      for (const name of state.php.listFiles(absolute)) {
        check(`${relative}/${name}`);
      }

      return;
    }

    const hasContent = state.php.isFile(absolute) && state.php.readFileAsBuffer(absolute).length > 0;

    if (hasContent !== overrides.has(relative)) {
      hasContent ? overrides.add(relative) : overrides.delete(relative);
      changed = true;
    }
  };

  for (const relative of mediaTouched) {
    // A deleted or renamed folder: its files are gone from that place.
    if (!state.php.fileExists(`${DOCUMENT_ROOT}/${relative}`)) {
      for (const path of overrides) {
        if (path === relative || path.startsWith(`${relative}/`)) {
          overrides.delete(path);
          changed = true;
        }
      }

      continue;
    }

    check(relative);
  }

  mediaTouched.clear();

  if (changed || overrides.size !== before) {
    publishMediaOverrides();
  }
}

function publishMediaOverrides() {
  if (state) {
    channel.postMessage({ type: 'media-overrides', scope: state.scope, paths: [...state.mediaOverrides] });
  }
}

let snapshotTimer = null;
let firstChange = 0;

/**
 * Writes a snapshot of a saved site: next in the request queue, or after a quiet moment but not later than
 * SNAPSHOT_MAX_DELAY after the first change, so a busy site is saved too.
 */
function scheduleSnapshot({ now: immediately = false } = {}) {
  if (!state?.site || !state.dirty) {
    return;
  }

  const now = performance.now();

  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
  } else {
    firstChange = now;
  }

  if (immediately) {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));

    return;
  }

  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    serialized(() => state.dirty && snapshot(state.site)).catch((error) => console.error('Cannot save the site:', error));
  }, Math.max(0, Math.min(SNAPSHOT_DELAY, firstChange + SNAPSHOT_MAX_DELAY - now)));
}

/**
 * The Patch Tester's test of a pull request of joomla-cms: the id of its row in #__patchtester_tests (which its revert
 * task takes), or null when the pull request is not applied.
 */
async function pullRequestTest({ pullRequest }) {
  const response = await serialized(() =>
    runPhp(state.php, `
      $db = new PDO('sqlite:' . ${JSON.stringify(DOCUMENT_ROOT)} . '/data/joomla.sqlite');
      try {
          $statement = $db->prepare('SELECT MAX(id) FROM jos_patchtester_tests WHERE pull_id = ?');
          $statement->execute([${Number(pullRequest)}]);
          echo (int) $statement->fetchColumn();
      } catch (PDOException) {
          echo 0;
      }
    `)
  );

  return { value: Number(response.text.trim()) || null };
}

/**
 * The Patch Tester's GitHub token (its options gh_auth and gh_token in #__extensions), for the token this browser
 * remembers (github-token.js):
 *
 * - set: a token to fill in. Only when the Patch Tester has none yet, unless overwrite is true.
 * - clear: a token to remove again, if the Patch Tester has exactly that one.
 *
 * @returns {{installed: boolean, hasToken: boolean, changed: boolean}}
 */
async function patchTester({ set = null, overwrite = false, clear = null } = {}) {
  for (const token of [set, clear]) {
    if (token !== null && !/^[A-Za-z0-9_]{20,255}$/.test(token)) {
      throw new Error('Not a GitHub token');
    }
  }

  const response = await serialized(() =>
    runPhp(state.php, `
      $db = new PDO('sqlite:' . ${JSON.stringify(DOCUMENT_ROOT)} . '/data/joomla.sqlite');
      $args = json_decode('${JSON.stringify({ set, overwrite: Boolean(overwrite), clear })}', true);
      $result = ['installed' => false, 'hasToken' => false, 'changed' => false];

      try {
          $row = $db->query("SELECT extension_id, params FROM jos_extensions WHERE element = 'com_patchtester' AND type = 'component'")->fetch(PDO::FETCH_ASSOC);
      } catch (PDOException) {
          $row = false;
      }

      if ($row) {
          $params = json_decode((string) $row['params'], true) ?: [];
          $current = (string) ($params['gh_token'] ?? '');

          if ($args['set'] !== null && ($current === '' || $args['overwrite']) && $current !== $args['set']) {
              $params = array_merge($params, ['gh_auth' => 'token', 'gh_token' => $args['set']]);
              $result['changed'] = true;
          } elseif ($args['clear'] !== null && $current === $args['clear']) {
              $params['gh_token'] = '';
              $result['changed'] = true;
          }

          if ($result['changed']) {
              $statement = $db->prepare('UPDATE jos_extensions SET params = ? WHERE extension_id = ?');
              $statement->execute([json_encode($params), $row['extension_id']]);
          }

          $result['installed'] = true;
          $result['hasToken'] = ($params['gh_token'] ?? '') !== '';
      }

      echo json_encode($result);
    `)
  );

  const result = JSON.parse(response.text.trim());

  // A saved site keeps the change.
  if (result.changed) {
    scheduleSnapshot({ now: true });
  }

  return { value: result };
}

/** A build folder of Joomla's CI for a pull request of joomla-cms, as its "Download" status links it. */
const PACKAGE_FOLDER = /^https:\/\/artifacts\.joomla\.org\/drone\/joomla\/joomla-cms\/[A-Za-z0-9._-]+\/[1-9][0-9]*\/downloads\/[1-9][0-9]*$/;

/** The originals of the files a pull request's package replaced or deleted, and the list of its changes. */
const PACKAGE_BACKUPS = 'data/pull-requests';

/**
 * Up to this many Range requests, the files that differ are read from the package piece by piece; above it, the
 * package is downloaded in one request. The CORS proxy allows 60 requests per minute per visitor (proxy/wrangler.toml),
 * and the page makes other requests through it too: half of that.
 */
const PACKAGE_RANGE_REQUESTS_UP_TO = 30;

/**
 * Files of a package that stay as they are: what the bundle leaves out or changes on purpose (see
 * bin/build-browser-bundle.php), and what is no part of a site's code (images/ is the site's own).
 */
function skippedInPackage(name) {
  return name.endsWith('/')
    || name.startsWith('installation/')
    || name.startsWith('images/')
    || /^(tmp|cache|administrator\/cache|administrator\/logs)\//.test(name)
    || /^media\/.*\.(gz|scss|less|ts|map)$/.test(name)
    || name === 'plugins/system/webauthn/fido.jwt'
    || name === 'configuration.php';
}

/**
 * A pull request's build from Joomla's CI (its Full Package on artifacts.joomla.org), laid over the site, or taken
 * off again. For pull requests the Patch Tester cannot test: changed JavaScript, CSS or Vue sources that need
 * building ("NPM Resource Changed"), or changed Composer dependencies.
 *
 * - apply: true   reads the list of files at the end of the package (Range requests, see zip-ranges.js), compares
 *                 every file with the package the bundle was made from (its package index, see
 *                 bin/build-browser-bundle.php), reads and writes the ones that differ, deletes the ones
 *                 the pull request removed, and keeps the originals in data/pull-requests/<number>/. Then it clears
 *                 the caches, refreshes Joomla's media version and, when the pull request has database changes,
 *                 runs Joomla's update queries.
 * - apply: false  puts the originals back (database changes stay).
 * - apply: null   only says whether the package is applied.
 *
 * @returns {{applied: boolean, changes: object|null}}
 */
async function pullRequestPackage({ pullRequest, folder = null, apply = null }) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  const number = Number(pullRequest);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`Not a pull request number: ${pullRequest}`);
  }

  const backup = `${DOCUMENT_ROOT}/${PACKAGE_BACKUPS}/${number}`;
  const changesFile = `${backup}/changes.json`;
  const current = () => (state.php.fileExists(changesFile) ? JSON.parse(state.php.readFileAsText(changesFile)) : null);

  if (apply === null) {
    const changes = current();

    return { value: { applied: Boolean(changes), changes } };
  }

  if (apply && current()) {
    return { value: { applied: true, changes: current() } };
  }

  if (!apply && !current()) {
    return { value: { applied: false, changes: null } };
  }

  if (apply) {
    if (!PACKAGE_FOLDER.test(String(folder))) {
      throw new Error(`Not a package folder of Joomla's CI: ${folder}`);
    }

    if (!state.manifest.packageIndex) {
      throw new Error('This Joomla bundle has no package index (bin/build-browser-bundle.php makes it): it cannot compare a pull request package with it');
    }

    progress(`PR #${number}: reading the package of Joomla's CI`);
    const details = new TextDecoder().decode(await downloadAllowingProxy(`${folder}/pr_extension.xml`, 'the package details'));
    const url = details.match(/<downloadurl[^>]*>\s*([^<\s]+)\s*<\/downloadurl>/)?.[1]?.replace(/&amp;/g, '&');
    const version = details.match(/<version>([^<]+)<\/version>/)?.[1] ?? null;

    if (!url?.startsWith(`${folder}/`) || !url.endsWith('-Update_Package.zip')) {
      throw new Error(`The package details of PR #${number} name no update package in its folder: ${url ?? 'none'}`);
    }

    // The details name the Update Package, which leaves out images/ (a site's own images): a file missing from it is
    // not one the pull request deleted. The Full Package beside it has all files.
    const fullPackage = url.replace(/-Update_Package\.zip$/, '-Full_Package.zip');

    if (!state.corsProxy) {
      throw new Error(`Joomla's CI does not allow downloads from other sites (CORS), and this playground has no CORS proxy`);
    }

    const index = await fetch(new URL(state.manifest.packageIndex, state.bundleUrl)).then((response) => {
      if (!response.ok) {
        throw new Error(`Cannot read the bundle's package index: HTTP ${response.status}`);
      }

      return response.json();
    });

    // Only the list at the end of the package (about 1 MB) and the files that differ, with Range requests; the whole
    // package (35 MB) when the server or the proxy sends it all, or when that would take too many requests.
    const proxied = `${state.corsProxy}?url=${encodeURIComponent(fullPackage)}`;
    let zip = await openRemoteZip(proxied);
    const inPackage = zip.entries.filter((entry) => !skippedInPackage(entry.name));
    const changed = inPackage.filter((entry) => {
      const known = index[entry.name];

      return !known || known[0] !== entry.crc || known[1] !== entry.size;
    });

    let requests = zip.requestsFor(changed);

    if (requests > PACKAGE_RANGE_REQUESTS_UP_TO) {
      requests = 1;
      progress(`PR #${number}: downloading its build (${changed.length} files differ, spread over the package)`);
      zip = await memoryZip(await downloadAllowingProxy(fullPackage, `the build of PR #${number}`));
    } else {
      progress(`PR #${number}: reading the ${changed.length} files of its build that differ`);
    }

    // The same file either way, so the entries (and their offsets) are the same.
    const contents = await zip.read(changed);
    const names = new Set(inPackage.map((entry) => entry.name));
    const deleted = Object.keys(index).filter((name) => !names.has(name) && !skippedInPackage(name));

    progress(`PR #${number}: laying its build over the site`);
    const result = await serialized(async () => {
      for (const [name, bytes] of contents) {
        state.php.mkdir(`/tmp/pr-files/${name.slice(0, name.lastIndexOf('/'))}`);
        state.php.writeFile(`/tmp/pr-files/${name}`, bytes);
      }

      state.php.writeFile('/tmp/pr-details.json', JSON.stringify({
        details: { pullRequest: number, folder, package: fullPackage, version, applied: new Date().toISOString(), downloaded: zip.requested?.() ?? zip.size, requests },
        changed: [...contents.keys()],
        deleted,
      }));

      try {
        const response = await runPhp(state.php, `
          $root    = '${DOCUMENT_ROOT}';
          $backup  = ${JSON.stringify(backup)};
          $input   = json_decode(file_get_contents('/tmp/pr-details.json'), true);
          $changes = $input['details'] + ['added' => [], 'replaced' => [], 'deleted' => []];

          $keep = static function (string $name) use ($root, $backup): void {
              $target = $backup . '/original/' . $name;
              is_dir(dirname($target)) || mkdir(dirname($target), 0777, true);
              copy($root . '/' . $name, $target);
          };

          is_dir($backup) || mkdir($backup, 0777, true);

          foreach ($input['changed'] as $name) {
              $target = $root . '/' . $name;

              if (is_file($target)) {
                  $keep($name);
                  $changes['replaced'][] = $name;
              } else {
                  $changes['added'][] = $name;
              }

              is_dir(dirname($target)) || mkdir(dirname($target), 0777, true);
              is_file($target) && chmod($target, 0666);
              copy('/tmp/pr-files/' . $name, $target);
          }

          foreach ($input['deleted'] as $name) {
              if (is_file($root . '/' . $name)) {
                  $keep($name);
                  chmod($root . '/' . $name, 0666);
                  unlink($root . '/' . $name);
                  $changes['deleted'][] = $name;
              }
          }

          file_put_contents($backup . '/changes.json', json_encode($changes, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
          echo json_encode($changes);
        `);

        return JSON.parse(response.text);
      } finally {
        state.php.fileExists('/tmp/pr-details.json') && state.php.unlink('/tmp/pr-details.json');
        state.php.isDir('/tmp/pr-files') && state.php.rmdir('/tmp/pr-files', { recursive: true });
      }
    });

    const database = /^administrator\/components\/com_admin\/sql\/updates\//;
    const sql = [...result.added, ...result.replaced].some((name) => database.test(name)) ? await runDatabaseUpdates() : null;

    if (sql) {
      result.sql = sql;
      state.php.writeFile(changesFile, JSON.stringify(result, null, 2));
    }

    await afterPackageChange();

    return { value: { applied: true, changes: result } };
  }

  progress(`PR #${number}: putting the original files back`);
  const changes = current();

  await serialized(() =>
    runPhp(state.php, `
      $root    = '${DOCUMENT_ROOT}';
      $backup  = ${JSON.stringify(backup)};
      $changes = json_decode(file_get_contents($backup . '/changes.json'), true);

      foreach ($changes['added'] as $name) {
          if (is_file($root . '/' . $name)) {
              chmod($root . '/' . $name, 0666);
              unlink($root . '/' . $name);
          }
      }

      foreach ([...$changes['replaced'], ...$changes['deleted']] as $name) {
          $target = $root . '/' . $name;
          is_dir(dirname($target)) || mkdir(dirname($target), 0777, true);
          is_file($target) && chmod($target, 0666);
          copy($backup . '/original/' . $name, $target);
      }

      $remove = function (string $path) use (&$remove) {
          if (is_dir($path)) {
              array_map(fn ($name) => $remove($path . '/' . $name), array_diff(scandir($path), ['.', '..']));
              rmdir($path);
          } elseif (is_file($path)) {
              unlink($path);
          }
      };
      $remove($backup);
    `)
  );

  await afterPackageChange();

  return { value: { applied: false, changes } };
}

/**
 * After files of a pull request's package were laid over the site or taken off: Joomla rebuilds its caches (its
 * namespace map, for one), the browser loads the changed scripts and styles again (a new media version), the
 * playground's CA stays in Joomla's CA bundle, and the service worker learns which media files changed.
 */
async function afterPackageChange() {
  await serialized(() =>
    runPhp(state.php, `
      $root = '${DOCUMENT_ROOT}';
      foreach (['administrator/cache', 'cache'] as $folder) {
          $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $folder, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
          foreach ($items as $item) {
              if ($item->isDir()) {
                  @rmdir($item->getPathname());
              } elseif ($item->getFilename() !== 'index.html') {
                  unlink($item->getPathname());
              }
          }
      }
      ${joomlaPhp(DOCUMENT_ROOT)}
      (new \\Joomla\\CMS\\Version())->refreshMediaVersion();
    `)
  );

  trustPlaygroundCa(state.php, state.caRoot);
  updateMediaOverrides();
  publishMediaOverrides();
  scheduleSnapshot({ now: true });
}

/**
 * Runs Joomla's own update queries (administrator/components/com_admin/sql/updates) that are newer than the
 * database, as Joomla Update does after an update.
 *
 * @returns {{ok: boolean, message: string}}
 */
async function runDatabaseUpdates() {
  progress('Running the database changes of the pull request');

  try {
    const response = await serialized(() =>
      runPhp(state.php, `
        ${joomlaPhp(DOCUMENT_ROOT)}
        $extension = \\Joomla\\CMS\\Extension\\ExtensionHelper::getExtensionRecord('joomla', 'file');
        $manifest  = simplexml_load_file(JPATH_ADMINISTRATOR . '/manifests/files/joomla.xml');
        $installer = \\Joomla\\CMS\\Installer\\Installer::getInstance();
        $installer->setPath('extension_root', JPATH_ROOT);
        $result = $installer->parseSchemaUpdates($manifest->update->schemas, $extension->extension_id);
        echo json_encode(['ok' => $result !== false, 'message' => $result === false ? 'Joomla could not run the update queries' : 'Update queries run: ' . (int) $result]);
      `)
    );

    return JSON.parse(response.text.slice(response.text.indexOf('{')));
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error).slice(0, 500) };
  }
}

/** Hosts that never allow downloads from other sites (CORS): straight to the CORS proxy, without trying first. */
const NO_CORS_HOSTS = ['artifacts.joomla.org'];

/**
 * Downloads a file: directly when its host allows it (CORS), otherwise through the CORS proxy.
 */
async function downloadAllowingProxy(url, what) {
  if (state.corsProxy && NO_CORS_HOSTS.includes(new URL(url).host)) {
    return download(new URL(`${state.corsProxy}?url=${encodeURIComponent(url)}`), what);
  }

  try {
    return await download(new URL(url), what);
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    if (!state.corsProxy) {
      throw new Error(`Cannot download ${what}: ${new URL(url).host} does not allow it (CORS), and this playground has no CORS proxy`);
    }

    return download(new URL(`${state.corsProxy}?url=${encodeURIComponent(url)}`), what);
  }
}

/**
 * An operation of the site API (see site-api.js): files, PHP code, requests and Joomla's console, for tools such
 * as an editor or an MCP connection. It runs in the request queue, between the page's requests; a change is saved
 * in a saved site's snapshot right after it.
 */
async function siteApi({ operation, args }) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  try {
    return { value: await serialized(() => state.api.call(operation, args)) };
  } finally {
    scheduleSnapshot({ now: true });
  }
}

/**
 * The page is hidden or closing: write the pending snapshot now.
 */
async function flush() {
  if (state?.site) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
    await serialized(() => state.dirty && snapshot(state.site));
  }

  return { value: null };
}

/**
 * Zips the changed files (files/<path>) and the deleted paths (deleted.json), and writes the zip to OPFS.
 * Runs in the request queue: no request changes files meanwhile.
 */
async function snapshot(site) {
  const started = performance.now();

  state.dirty = false;

  try {
    state.php.writeFile('/tmp/changes.json', JSON.stringify({ paths: [...state.changes.paths], trees: [...state.changes.trees] }));
    await runPhp(state.php, `
      $root    = '${DOCUMENT_ROOT}';
      $changes = json_decode(file_get_contents('/tmp/changes.json'), true);
      unlink('/tmp/changes.json');
      $zip = new ZipArchive();
      $zip->open('/tmp/snapshot.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $deleted = [];
      $add = function (string $relative) use ($root, $zip, &$deleted) {
          if (preg_match(${JSON.stringify(SKIP)}, $relative)) {
              return;
          }
          $path = $root . '/' . $relative;
          if (is_file($path)) {
              $zip->addFile($path, 'files/' . $relative);
          } elseif (is_dir($path)) {
              $zip->addEmptyDir('files/' . $relative);
          } else {
              $deleted[] = $relative;
          }
      };
      foreach ($changes['paths'] as $relative) {
          $add($relative);
      }
      foreach ($changes['trees'] as $tree) {
          if (is_dir($root . '/' . $tree)) {
              $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/' . $tree, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
              foreach ($files as $file) {
                  $add(substr($file->getPathname(), strlen($root) + 1));
              }
          }
      }
      $zip->addFromString('deleted.json', json_encode($deleted));
      $zip->close();
    `);

    const bytes = state.php.readFileAsBuffer('/tmp/snapshot.zip');

    state.php.unlink('/tmp/snapshot.zip');
    await writeSnapshot(site, bytes);
    console.debug(`Snapshot of "${site}": ${bytes.length} bytes in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    state.dirty = true;

    throw error;
  }
}

/**
 * Puts a snapshot on top of the unpacked base: removes the deleted paths, writes the changed files.
 *
 * @returns {Promise<string[]>} The paths in the snapshot: the changes of the site so far.
 */
async function restoreSnapshot(php, bytes) {
  php.writeFile('/tmp/snapshot.zip', bytes);

  const response = await runPhp(php, `
    $root = '${DOCUMENT_ROOT}';
    $zip  = new ZipArchive();
    if ($zip->open('/tmp/snapshot.zip') !== true) {
        throw new RuntimeException('Cannot open the snapshot of the site');
    }
    $remove = function (string $path) use (&$remove) {
        if (is_dir($path) && !is_link($path)) {
            foreach (array_diff(scandir($path), ['.', '..']) as $name) {
                $remove($path . '/' . $name);
            }
            rmdir($path);
        } elseif (file_exists($path) || is_link($path)) {
            unlink($path);
        }
    };
    $paths = json_decode((string) $zip->getFromName('deleted.json'), true) ?: [];
    foreach ($paths as $relative) {
        $remove($root . '/' . $relative);
    }
    for ($index = 0; $index < $zip->numFiles; $index++) {
        $name = $zip->getNameIndex($index);
        if (!str_starts_with($name, 'files/')) {
            continue;
        }
        $relative = rtrim(substr($name, 6), '/');
        $path     = $root . '/' . $relative;
        $paths[]  = $relative;
        if (str_ends_with($name, '/')) {
            is_dir($path) || mkdir($path, 0777, true);
            continue;
        }
        if (is_dir($path)) {
            $remove($path);
        }
        is_dir(dirname($path)) || mkdir(dirname($path), 0777, true);
        file_put_contents($path, $zip->getFromIndex($index));
    }
    $zip->close();
    unlink('/tmp/snapshot.zip');
    echo json_encode($paths);
  `);

  return JSON.parse(response.text);
}

/**
 * Zips the site (without caches, logs and temporary files) as a download.
 *
 * The site's core media files are empty placeholders (see bin/build-browser-bundle.php); an export gets their real
 * content from the bundle, so it runs on a server as it is. Those entries carry the comment MEDIA_COMMENT, and an
 * import empties them again (see boot()). With media: false, the placeholders stay (prebuilt demos).
 */
async function exportSite({ media = true } = {}) {
  if (!state) {
    throw new Error('The playground is not running');
  }

  const comment = JSON.stringify({ joomlaPlayground: 1, joomla: state.manifest.joomla, driver: state.manifest.driver, exported: new Date().toISOString() });
  const started = performance.now();
  const fetched = media ? await bundleMedia() : new Map();
  const downloaded = performance.now();

  await serialized(() => {
    for (const [relative, bytes] of fetched) {
      state.php.mkdir(`/tmp/export-media/${relative.slice(0, relative.lastIndexOf('/'))}`);
      state.php.writeFile(`/tmp/export-media/${relative}`, bytes);
    }

    return runPhp(state.php, `
      $root  = '${DOCUMENT_ROOT}';
      $media = '/tmp/export-media';
      $skip  = ${JSON.stringify(SKIP)};
      $zip   = new ZipArchive();
      $zip->open('/tmp/export.zip', ZipArchive::CREATE | ZipArchive::OVERWRITE);
      $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS));
      foreach ($files as $file) {
          $relative = substr($file->getPathname(), strlen($root) + 1);
          if (!$file->isFile() || preg_match($skip, $relative)) {
              continue;
          }
          // Still a placeholder (an extension may have written the file since the download).
          if ($file->getSize() === 0 && is_file($media . '/' . $relative)) {
              $zip->addFile($media . '/' . $relative, $relative);
              $zip->setCommentName($relative, ${JSON.stringify(MEDIA_COMMENT)});
              // The fastest compression: these are ~30 MB, mostly scripts and styles.
              $zip->setCompressionName($relative, ZipArchive::CM_DEFLATE, 1);
          } else {
              $zip->addFile($file->getPathname(), $relative);
          }
      }
      $zip->setArchiveComment(${JSON.stringify(comment)});
      $zip->close();
      $remove = function (string $path) use (&$remove) {
          if (is_dir($path)) {
              array_map(fn ($name) => $remove($path . '/' . $name), array_diff(scandir($path), ['.', '..']));
              rmdir($path);
          } elseif (is_file($path)) {
              unlink($path);
          }
      };
      $remove($media);
    `);
  });

  const bytes = state.php.readFileAsBuffer('/tmp/export.zip');
  state.php.unlink('/tmp/export.zip');
  console.debug(`Export: ${bytes.length} bytes, ${fetched.size} media files from the bundle (${Math.round(downloaded - started)} ms), in ${Math.round(performance.now() - started)} ms`);

  return { value: bytes.buffer, transfer: [bytes.buffer] };
}

/**
 * The content of the site's empty media files that the bundle has (joomla/<version>/media/), by relative path.
 * Downloaded outside the request queue, so the site keeps answering meanwhile.
 */
async function bundleMedia() {
  const response = await serialized(() =>
    runPhp(state.php, `
      $root  = '${DOCUMENT_ROOT}';
      $empty = [];
      if (is_dir($root . '/media')) {
          $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root . '/media', FilesystemIterator::SKIP_DOTS));
          foreach ($files as $file) {
              if ($file->isFile() && $file->getSize() === 0) {
                  $empty[] = substr($file->getPathname(), strlen($root) + 1);
              }
          }
      }
      echo json_encode($empty);
    `)
  );
  const paths = JSON.parse(response.text);
  const total = paths.length;
  const fetched = new Map();
  let done = 0;

  progress(`Exporting the site: Joomla's media files (0 of ${total})`);

  // A few downloads at a time: enough to fill the connection, without hundreds of requests waiting.
  const next = async () => {
    for (let relative = paths.pop(); relative; relative = paths.pop()) {
      const bytes = await bundleFile(new URL(relative, state.bundleUrl));

      if (bytes?.length) {
        fetched.set(relative, bytes);
      }

      if (++done % 100 === 0) {
        progress(`Exporting the site: Joomla's media files (${done} of ${total})`);
      }
    }
  };

  await Promise.all(Array.from({ length: 12 }, next));
  progress('Exporting the site');

  return fetched;
}

/**
 * A file of the static bundle, or null when the bundle does not have it (a 404, or a development server's index
 * page instead).
 */
async function bundleFile(url) {
  const response = await fetch(url);
  const fallbackPage = response.headers.get('content-type')?.includes('text/html') && !/\.html?$/.test(url.pathname);

  if (!response.ok || fallbackPage) {
    return null;
  }

  return new Uint8Array(await response.arrayBuffer());
}

/**
 * A copy of an export whose entries with the comment MEDIA_COMMENT are empty: the other entries are copied as they
 * are, without unpacking them. (Replacing the entries with ZipArchive takes minutes in WebAssembly, or fails.)
 * A zip it cannot read (Zip64) is returned as it is.
 */
function withoutBundleMedia(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;

  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) {
    end--;
  }

  const count = end >= 0 ? view.getUint16(end + 10, true) : 0xffff;
  const directory = end >= 0 ? view.getUint32(end + 16, true) : 0xffffffff;

  if (count === 0xffff || directory === 0xffffffff) {
    return bytes;
  }

  // The central directory: per entry its record, where its local header starts, and whether it is a media file.
  const entries = [];

  for (let offset = directory, index = 0; index < count; index++) {
    const length = 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const nameEnd = offset + 46 + view.getUint16(offset + 28, true);
    const comment = new TextDecoder().decode(bytes.subarray(nameEnd + view.getUint16(offset + 30, true), offset + length));

    entries.push({ record: bytes.subarray(offset, offset + length), name: bytes.subarray(offset + 46, nameEnd), local: view.getUint32(offset + 42, true), media: comment === MEDIA_COMMENT });
    offset += length;
  }

  // An entry's local part (header, data, data descriptor) ends where the next one starts.
  const starts = [...entries.map((entry) => entry.local), directory].sort((a, b) => a - b);
  const next = new Map(starts.map((start, index) => [start, starts[index + 1]]));
  const parts = [];
  const records = [];
  let size = 0;

  for (const entry of entries) {
    const record = new Uint8Array(entry.media ? 46 + entry.name.length : entry.record.length);
    const fields = new DataView(record.buffer);

    if (entry.media) {
      // Stored, empty: no CRC, no sizes, no extra field or comment. Version, flags (only UTF-8 names), time and
      // attributes as before.
      record.set(entry.record.subarray(0, 46));
      record.set(entry.name, 46);
      fields.setUint16(8, fields.getUint16(8, true) & 0x800, true);
      fields.setUint16(10, 0, true);
      fields.setUint32(16, 0, true);
      fields.setUint32(20, 0, true);
      fields.setUint32(24, 0, true);
      fields.setUint16(30, 0, true);
      fields.setUint16(32, 0, true);

      const local = new Uint8Array(30 + entry.name.length);
      const header = new DataView(local.buffer);

      header.setUint32(0, 0x04034b50, true);
      local.set(record.subarray(6, 30), 4);
      header.setUint16(28, 0, true);
      local.set(entry.name, 30);
      parts.push(local);
    } else {
      record.set(entry.record);
      parts.push(bytes.subarray(entry.local, next.get(entry.local)));
    }

    fields.setUint32(42, size, true);
    size += parts.at(-1).length;
    records.push(record);
  }

  const eocd = bytes.slice(end);
  const eocdFields = new DataView(eocd.buffer);

  eocdFields.setUint32(12, records.reduce((total, record) => total + record.length, 0), true);
  eocdFields.setUint32(16, size, true);

  const zip = new Uint8Array(size + eocdFields.getUint32(12, true) + eocd.length);
  let offset = 0;

  for (const part of [...parts, ...records, eocd]) {
    zip.set(part, offset);
    offset += part.length;
  }

  return zip;
}

/**
 * The comment an export carries: Joomla version and driver of the site.
 */
function siteComment(php) {
  try {
    return JSON.parse(php.readFileAsText('/tmp/archive-comment.json'));
  } catch {
    return null;
  }
}

/**
 * One tab per saved site: two PHP workers writing the same files would overwrite each other's changes.
 * The lock is held until this worker ends. After a reload, the previous page's worker may still hold it for a
 * moment, so wait a few seconds before giving up.
 */
async function lockSite(site) {
  const acquired = await new Promise((resolve) => {
    navigator.locks
      .request(siteLockName(site), { signal: AbortSignal.timeout(5000) }, () => {
        resolve(true);

        return new Promise(() => {});
      })
      .catch(() => resolve(false));
  });

  if (!acquired) {
    throw new Error(`The site "${site}" is open in another tab. Close that tab first.`);
  }
}

async function answer({ id, request }) {
  try {
    const started = performance.now();
    const response = await serialized(() =>
      state.handler.request({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body ? new Uint8Array(request.body) : undefined,
      })
    );
    const duration = performance.now() - started;

    if (duration > 2000) {
      console.warn(`PHP took ${Math.round(duration)} ms (queue included) for ${request.method} ${request.url}`);
    }

    if (response.httpStatusCode >= 500) {
      console.warn(`PHP ${response.httpStatusCode} for ${request.method} ${request.url}`, response.errors, response.text.slice(0, 500));
    }

    updateMediaOverrides();
    channel.postMessage({ type: 'response', id, status: response.httpStatusCode, headers: response.headers, body: response.bytes });
  } catch (error) {
    updateMediaOverrides();
    channel.postMessage({
      type: 'response',
      id,
      status: 500,
      headers: { 'content-type': ['text/plain; charset=utf-8'] },
      body: new TextEncoder().encode(String(error?.stack ?? error)),
    });
  } finally {
    scheduleSnapshot({ now: !['GET', 'HEAD'].includes(String(request.method ?? 'GET').toUpperCase()) });
  }
}

/**
 * Stands in for sendmail: reads the message from stdin and sends it to the page's inbox.
 */
async function catchMail(command, processApi) {
  const chunks = [];

  processApi.on('stdin', (data) => chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)));

  const stdin = processApi.childProcess.stdin;

  if (!(stdin.ended || stdin.writableEnded || stdin.writableFinished)) {
    await new Promise((resolve) => stdin.once('finish', resolve));
  }

  const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  self.postMessage({ type: 'mail', mail: { raw: new TextDecoder().decode(bytes), received: new Date().toISOString() } });
  processApi.exit(0);
}

/**
 * PHP has no sockets in the browser. With tcpOverFetch, @php-wasm turns the bytes PHP writes to a socket into a
 * fetch(): it ends PHP's TLS connection itself, with a certificate for the host signed by the given CA, which PHP
 * must trust. Without it, a connection never answers and curl waits for its connect timeout of 300 s, which blocks
 * every following request (e.g. System > Install Languages, which reads the list from update.joomla.org).
 *
 * The browser's rules apply: a server must allow cross-origin requests (update.joomla.org does, the language pack
 * downloads do not). A refused fetch() comes back to PHP at once, as "400 Bad Request".
 */
async function enableNetwork(php, caRoot) {
  php.writeFile(CA_BUNDLE, certificateToPEM(caRoot.certificate));
  await setPhpIniEntries(php, { 'openssl.cafile': CA_BUNDLE, 'curl.cainfo': CA_BUNDLE });
}

/**
 * Joomla's own HTTP client (Joomla\CMS\Http\Transport\CurlTransport and StreamTransport, used by HttpFactory)
 * always gives curl the CA bundle that comes with Joomla (composer/ca-bundle's cacert.pem), not the one php.ini
 * names. Without this playground's CA in it, every HTTPS request through it failed with "self signed certificate in
 * certificate chain": extension updates, the Patch Tester's GitHub requests, and so on. So the CA is added to that
 * file too. A new CA is made at every start; the block of an earlier start (e.g. in an export) is replaced.
 */
function trustPlaygroundCa(php, caRoot) {
  const file = `${DOCUMENT_ROOT}/libraries/vendor/composer/ca-bundle/res/cacert.pem`;

  if (!php.fileExists(file)) {
    return;
  }

  const begin = '# Joomla Playground CA: begin';
  const end = '# Joomla Playground CA: end';
  const text = php.readFileAsText(file);
  const start = text.indexOf(begin);
  const bundle = start === -1 ? text : text.slice(0, start) + text.slice(text.indexOf(end, start) + end.length);
  const block = [begin, certificateToPEM(caRoot.certificate).trim(), end].join('\n');

  php.writeFile(file, `${bundle.trimEnd()}\n\n${block}\n`);
}

/**
 * @php-wasm sets SCRIPT_NAME to the script's path below the document root (/administrator/index.php), without the
 * path of the site URL (/scope-abc123), which REQUEST_URI and PHP_SELF do have. Joomla takes its base URL from
 * SCRIPT_NAME, so a redirect to a relative "index.php?..." (e.g. after installing a language or an extension)
 * would leave the scope and end on a 404 of the web server. A file PHP runs before every script corrects it, and
 * tells the playground's system plugin that it runs in the browser.
 */
async function prependFile(php, { sitePath, hasCorsProxy, password, bundleUrl, languagePacks }) {
  // The Super User's account, for the notice on the login form (plg_system_playground). It is this playground's
  // random password, which the toolbar shows anyway.
  php.writeFile(PREPEND_FILE, `<?php
    $_SERVER['JOOMLA_PLAYGROUND'] = 'browser';
    $_SERVER['JOOMLA_PLAYGROUND_CORS_PROXY'] = ${hasCorsProxy ? "'1'" : "''"};
    $_SERVER['JOOMLA_PLAYGROUND_USERNAME'] = 'admin';
    $_SERVER['JOOMLA_PLAYGROUND_PASSWORD'] = ${JSON.stringify(password)};
    $_SERVER['JOOMLA_PLAYGROUND_BUNDLE_URL'] = ${JSON.stringify(bundleUrl)};
    $_SERVER['JOOMLA_PLAYGROUND_LANGUAGE_PACKS'] = ${JSON.stringify(String(languagePacks))};
    $prefix = ${JSON.stringify(sitePath)};
    if (isset($_SERVER['SCRIPT_NAME']) && !str_starts_with($_SERVER['SCRIPT_NAME'], $prefix . '/')) {
        $_SERVER['SCRIPT_NAME'] = $prefix . $_SERVER['SCRIPT_NAME'];
        $path = strtok($_SERVER['REQUEST_URI'] ?? '', '?');
        if (str_starts_with($path, $_SERVER['SCRIPT_NAME'] . '/')) {
            $_SERVER['PATH_INFO'] = substr($path, strlen($_SERVER['SCRIPT_NAME']));
        }
    }
  `);
  await setPhpIniEntries(php, { auto_prepend_file: PREPEND_FILE });
}

async function runPhp(php, code) {
  const response = await php.run({ code: `<?php ${code}` });

  if (response.exitCode !== 0 || response.errors) {
    throw new Error(`PHP failed: ${response.errors || response.text}`);
  }

  return response;
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function download(url, what = 'Joomla') {
  progress(`Downloading ${what}`);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPercent = -1;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    received += value.length;

    if (total) {
      const percent = Math.min(100, Math.round((received / total) * 100));

      if (percent !== lastPercent) {
        lastPercent = percent;
        progress(`Downloading ${what}: ${percent}% of ${(total / 1048576).toFixed(1)} MB`);
      }
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

/**
 * Logs in to the administrator, so the cookie store of the request handler holds a Super User session.
 * The cookies stay in this worker: the browser never sees them.
 */
async function logIn(handler, siteUrl, password) {
  const form = await handler.request({ url: `${siteUrl}/administrator/index.php` });
  const token = form.text.match(/name="([a-f0-9]{32})" value="1"/)?.[1];

  if (!token) {
    const message = form.text.match(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/)?.[1] ?? form.text;
    const page = message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);

    throw new Error(`No login form in the administrator (HTTP ${form.httpStatusCode}): ${page} ${form.errors}`);
  }

  const body = new URLSearchParams({
    username: 'admin',
    passwd: password,
    option: 'com_login',
    task: 'login',
    return: btoa('index.php'),
    [token]: '1',
  });

  await handler.request({
    url: `${siteUrl}/administrator/index.php`,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(body.toString()),
  });
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
