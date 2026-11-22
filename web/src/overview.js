// The overview of the playground (overview/index.html, at .../overview/): the Joomla versions, the sites saved in
// this browser, a form to test a pull request, and the guided tours of the Joomla User Guide. The demos and the other
// links are plain HTML in overview/index.html. The playground itself is the folder above, as it always was.

import { listSites } from './storage.js';

/** The playground: the folder above this page. */
const base = new URL('../', location.href);

/** The link of a playground with parameters. */
function playgroundLink(parameters) {
  return `../?${new URLSearchParams(parameters)}`;
}

function element(name, attributes = {}, ...children) {
  const node = document.createElement(name);

  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, value);
  }

  node.append(...children);

  return node;
}

/**
 * The Joomla versions of the playground, from its bundles: the default in the main button, the others next to it.
 */
async function renderVersions() {
  try {
    const bundles = await (await fetch(new URL('joomla/versions.json', base))).json();
    const others = bundles.versions.filter((bundle) => bundle.joomla !== bundles.default);

    document.querySelector('#home-default-version').textContent = `Joomla ${bundles.default}`;
    document.querySelector('#home-versions').replaceChildren(
      ...others.flatMap((bundle, index) => [
        index ? ' · ' : '',
        element('a', { href: playgroundLink({ joomla: bundle.branch ?? bundle.joomla.split('.').slice(0, 2).join('.') }) },
          bundle.branch ? `Joomla ${bundle.branch}` : `Joomla ${bundle.joomla}`),
        bundle.branch ? ' (the development branch, a nightly build)' : '',
      ])
    );
    document.querySelector('#home-other-versions').hidden = !others.length;
  } catch {
    // Without the list the page still works: the main button starts the default version.
  }
}

/**
 * The sites saved in this browser, if any.
 */
async function renderSites() {
  let sites = [];

  try {
    sites = await listSites();
  } catch {
    // No origin private file system (e.g. a private window in some browsers): nothing saved.
  }

  if (!sites.length) {
    return;
  }

  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  document.querySelector('#home-sites-list').replaceChildren(
    ...sites.map((site) =>
      element('li', {},
        element('a', { href: playgroundLink({ site: site.slug }) }, site.title || site.slug),
        element('span', { class: 'muted' }, ` Joomla ${site.joomla ?? ''} · saved ${site.updated ? date.format(new Date(site.updated)) : ''}`)
      )
    )
  );
  document.querySelector('#home-sites').hidden = false;
}

/**
 * Test a pull request: ?pr=<number>, and the page to open when given.
 */
function setUpPullRequestForm() {
  const form = document.querySelector('#home-pr-form');

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const number = form.elements.pr.value.trim().replace(/^#/, '').match(/(\d+)\/?$/)?.[1];
    const page = form.elements.url.value.trim();

    if (!number) {
      form.elements.pr.setCustomValidity('A pull request number, or its address on GitHub');
      form.reportValidity();

      return;
    }

    location.href = playgroundLink({ pr: number, ...(page ? { url: page.startsWith('/') ? page : `/${page}` } : {}) });
  });
  form.elements.pr.addEventListener('input', () => form.elements.pr.setCustomValidity(''));
}

/** Language tags and how the list of tours names them. */
const TOUR_LANGUAGES = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fa: 'فارسی',
  fr: 'Français',
  it: 'Italiano',
  nl: 'Nederlands',
  pt: 'Português',
  'pt-br': 'Português do Brasil',
  ru: 'Русский',
};

/**
 * The guided tours, from their list (blueprints/tours/README.md): per section a table with a row per language.
 *
 * @returns {Promise<{languages: string[], sections: Array<{title: string, tours: Map<string, {title: string, href: string}>}>}>}
 */
async function loadTours() {
  const text = await (await fetch(new URL('blueprints/tours/README.md', base))).text();
  const sections = [];
  const languages = [];

  for (const line of text.split('\n')) {
    const heading = line.match(/^## (.+)$/);
    const row = line.match(/^\| ([^|]+?) \| \[(.+?)\]\((\S+?)\) \|/);

    if (heading) {
      sections.push({ title: heading[1].trim(), tours: new Map() });
    } else if (row && sections.length) {
      const [, language, title, url] = row;

      // The list links to the public playground; here the links stay on this one (e.g. a local development server).
      sections.at(-1).tours.set(language, { title, href: `../${new URL(url, base).search}` });
      languages.includes(language) || languages.push(language);
    }
  }

  return { languages, sections: sections.filter((section) => section.tours.size) };
}

async function renderTours() {
  const select = document.querySelector('#home-tours-language');
  const list = document.querySelector('#home-tours-list');
  let tours;

  try {
    tours = await loadTours();
  } catch {
    document.querySelector('#home-tours-picker').hidden = true;

    return;
  }

  // The browser's language, if there are tours in it (the list names the languages in their own language).
  const preferred = navigator.languages
    .flatMap((tag) => [TOUR_LANGUAGES[tag.toLowerCase()], TOUR_LANGUAGES[tag.split('-')[0].toLowerCase()]])
    .find((language) => language && tours.languages.includes(language));

  select.replaceChildren(...tours.languages.map((language) => new Option(language, language)));
  select.value = preferred ?? tours.languages[0];

  const render = () => {
    list.replaceChildren(
      ...tours.sections
        .filter((section) => section.tours.has(select.value))
        .map((section) => {
          const tour = section.tours.get(select.value);

          return element('li', {},
            element('a', { href: tour.href, dir: 'auto' }, tour.title),
            element('span', { class: 'muted' }, ` ${section.title.match(/^[\d.]+/)?.[0] ?? ''}`)
          );
        })
    );
  };

  select.addEventListener('change', render);
  render();
}

renderVersions();
renderSites();
setUpPullRequestForm();
renderTours();
