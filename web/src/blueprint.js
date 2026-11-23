// Blueprints: what a new playground should look like, read from the page URL.
//
//   #{"landingPage": "/administrator/index.php?option=com_content", "steps": [...]}   a blueprint in the fragment
//   ?blueprint-url=https://example.org/blueprint.json                                 a blueprint to download
//   ?blueprint=heritage-demo                                                           a blueprint of the playground
//                                                                                     (web/public/blueprints/)
//   ?php=8.3  ?url=/index.php  ?login=no  ?extension=<zip URL> (repeatable)  ?language=nl-NL
//                                                                                     shortcuts, added on top
//   ?pr=48895                                                                         a pull request of joomla-cms
//                                                                                     to test: the Patch Tester
//                                                                                     blueprint, and a button to
//                                                                                     apply and revert it (main.js);
//                                                                                     with the method "package"
//                                                                                     (pull requests that need a
//                                                                                     build) no Patch Tester: the
//                                                                                     button lays Joomla CI's build
//                                                                                     of it over the site
//
// A blueprint:
//   {
//     "preferredVersions": { "php": "8.4", "joomla": "6.2" },
//     "landingPage": "/administrator/",
//     "login": true,
//     "steps": [ { "step": "installExtension", "url": "https://example.org/my_extension.zip" }, ... ]
//   }
// The steps are run by the PHP worker (see blueprint-steps.js), which also documents them.

export const PHP_VERSIONS = ['8.3', '8.4', '8.5'];
export const DEFAULT_PHP_VERSION = '8.4';

export const STEPS = {
  installExtension: ['url'],
  enableExtension: ['element'],
  disableExtension: ['element'],
  indexSmartSearch: [],
  installLanguage: ['language'],
  addModule: ['module', 'title', 'position'],
  addArticle: ['title', 'text'],
  addUserGroup: ['title'],
  login: [],
  setGlobalConfig: ['values'],
  runPHP: ['code'],
  runSql: ['sql'],
  writeFile: ['path', 'data'],
  unzip: ['url'],
  importSampleData: [],
  setSiteLanguage: ['language'],
};

const KEYS = ['$schema', 'preferredVersions', 'landingPage', 'login', 'steps', 'meta'];

/**
 * @param {URL} url
 * @param {object} [options]
 * @param {string} [options.pullRequestMethod] how ?pr= is tested (main.js): "patchtester" (the default) or
 *                                             "package", without the Patch Tester
 * @returns {Promise<object|null>} The blueprint of this page URL, or null when the URL asks for none.
 */
export async function blueprintFromUrl(url, { pullRequestMethod = 'patchtester' } = {}) {
  const params = url.searchParams;
  const fragment = decodeURIComponent(url.hash.slice(1)).trim();
  let blueprint = null;

  if (fragment.startsWith('{')) {
    blueprint = parseJson(fragment, 'the blueprint in the URL');
  } else if (params.get('blueprint-url') || params.get('blueprint') || (params.get('pr') && pullRequestMethod !== 'package')) {
    // A pull request without a blueprint gets the Patch Tester.
    const name = params.get('blueprint') || (params.get('blueprint-url') ? null : 'patchtester');

    if (name && !/^[a-z0-9-]+$/.test(name)) {
      throw new Error(`Not a blueprint name: ${name}`);
    }

    const source = name ? new URL(`blueprints/${name}.json`, new URL('./', url)) : new URL(params.get('blueprint-url'), url);
    const response = await fetch(source);

    if (!response.ok) {
      throw new Error(`Cannot download the blueprint ${source}: HTTP ${response.status}`);
    }

    const text = await response.text();

    blueprint = parseJson(text, `the blueprint ${source}`);
    blueprint.baseUrl = source.href;

    // A blueprint of the playground may have a prebuilt export (scripts/build-demos.mjs), made from this very file.
    if (name) {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

      blueprint.source = { name, sha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('') };
    }
  }

  const shortcuts = {
    php: params.get('php'),
    joomla: params.get('joomla'),
    landingPage: params.get('url'),
    login: params.get('login'),
    extensions: params.getAll('extension'),
    language: params.get('language'),
    pullRequest: params.get('pr'),
  };

  if (!blueprint && !Object.values(shortcuts).some((value) => (Array.isArray(value) ? value.length : value))) {
    return null;
  }

  blueprint = { steps: [], ...(blueprint ?? {}) };
  blueprint.steps = [...(blueprint.steps ?? [])];

  if (shortcuts.php || shortcuts.joomla) {
    blueprint.preferredVersions = { ...blueprint.preferredVersions };
    shortcuts.php && (blueprint.preferredVersions.php = shortcuts.php);
    shortcuts.joomla && (blueprint.preferredVersions.joomla = shortcuts.joomla);
  }

  if (shortcuts.pullRequest) {
    if (!/^[1-9][0-9]*$/.test(shortcuts.pullRequest)) {
      throw new Error(`Not a pull request number: ${shortcuts.pullRequest}`);
    }

    // The site as it is without the patch: the administrator, unless ?url= names the page the pull request changes.
    blueprint.pullRequest = Number(shortcuts.pullRequest);
    blueprint.landingPage = '/administrator/';
  }

  if (shortcuts.landingPage) {
    blueprint.landingPage = shortcuts.landingPage;
  }

  if (shortcuts.login) {
    blueprint.login = !['no', '0', 'false'].includes(shortcuts.login.toLowerCase());
  }

  for (const extension of shortcuts.extensions) {
    blueprint.steps.push({ step: 'installExtension', url: extension });
  }

  if (shortcuts.language) {
    blueprint.steps.push({ step: 'setSiteLanguage', language: shortcuts.language, administrator: true });
  }

  validate(blueprint);

  return blueprint;
}

/**
 * Throws an error that says what is wrong with a blueprint.
 */
export function validate(blueprint) {
  if (typeof blueprint !== 'object' || blueprint === null || Array.isArray(blueprint)) {
    throw new Error('A blueprint is a JSON object');
  }

  for (const key of Object.keys(blueprint)) {
    if (!KEYS.includes(key) && !['baseUrl', 'source', 'pullRequest'].includes(key)) {
      throw new Error(`Unknown blueprint property "${key}"; known: ${KEYS.join(', ')}`);
    }
  }

  const php = blueprint.preferredVersions?.php;

  if (php && !PHP_VERSIONS.includes(String(php))) {
    throw new Error(`PHP ${php} is not available; choose ${PHP_VERSIONS.join(', ')}`);
  }

  if (blueprint.landingPage !== undefined && !String(blueprint.landingPage).startsWith('/')) {
    throw new Error('The landing page is a path of the site, starting with "/"');
  }

  if (!Array.isArray(blueprint.steps)) {
    throw new Error('The steps of a blueprint are a list');
  }

  blueprint.steps.forEach((step, index) => {
    const required = STEPS[step?.step];

    if (!required) {
      throw new Error(`Step ${index + 1}: unknown step "${step?.step}"; known: ${Object.keys(STEPS).join(', ')}`);
    }

    for (const property of required) {
      if (step[property] === undefined) {
        throw new Error(`Step ${index + 1} (${step.step}) needs "${property}"`);
      }
    }
  });
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read ${what}: ${error.message}`, { cause: error });
  }
}
