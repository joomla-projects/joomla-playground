// Keeps the Joomla versions of the playground up to date with the stable releases of joomla/joomla-cms.
//
// The playground offers the two maintained major versions: the default is the release GitHub marks as Latest, the
// other one the newest stable release of the major version below it. The integration tests and the browser bundle
// install the default (when JOOMLA_VERSION is not set), so joomla-versions.json is the only file this changes.
//
// Usage: node scripts/update-joomla-versions.mjs [--check]
//   --check  only says what would change; exit code 1 if anything would
// Prints "changed=true|false" and a summary; GITHUB_TOKEN, if set, raises GitHub's rate limit.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {Array<{tag_name: string, prerelease: boolean, draft: boolean}>} releases
 * @param {string} latest The tag GitHub marks as Latest
 * @returns {{default: string, versions: string[]}}
 */
export function pickVersions(releases, latest) {
  const stable = releases
    .filter((release) => !release.prerelease && !release.draft && /^\d+\.\d+\.\d+$/.test(release.tag_name))
    .map((release) => release.tag_name)
    .sort(compareVersions)
    .reverse();

  if (!stable.length) {
    throw new Error('No stable Joomla release found');
  }

  // Latest is a stable release, unless GitHub marks something else; then the newest stable release.
  const newest = stable.includes(latest) ? latest : stable[0];
  const major = Number(newest.split('.')[0]);
  const previous = stable.find((tag) => Number(tag.split('.')[0]) === major - 1);

  return { default: newest, versions: previous ? [newest, previous] : [newest] };
}

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));

  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

async function github(path) {
  const response = await fetch(`https://api.github.com/repos/joomla/joomla-cms/${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  }

  return response.json();
}

async function main() {
  const check = process.argv.includes('--check');
  const file = `${root}/joomla-versions.json`;
  const current = JSON.parse(readFileSync(file, 'utf8'));
  const [releases, latest] = await Promise.all([github('releases?per_page=100'), github('releases/latest')]);
  const next = pickVersions(releases, latest.tag_name);
  const changed = JSON.stringify(next) !== JSON.stringify({ default: current.default, versions: current.versions });

  console.log(`changed=${changed}`);
  console.log(`Joomla versions: ${current.versions.join(', ')} (default ${current.default}) -> ${next.versions.join(', ')} (default ${next.default})`);

  if (!changed || check) {
    process.exit(check && changed ? 1 : 0);
  }

  writeFileSync(file, JSON.stringify({ ...current, ...next }, null, 2) + '\n');

}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(2);
  });
}
