// Tests of the site API (web/src/site-api.js) with PHP in WebAssembly in Node, on the playground's own Joomla bundle.
// Needs the bundle: npm run bundle (web/public/joomla/<default version>/site.zip).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PHP, PHPRequestHandler, ProcessIdAllocator } from '@php-wasm/universal';
import { loadNodeRuntime } from '@php-wasm/node';
import { journalFSEvents } from '@php-wasm/fs-journal';
import { createSiteApi, normalizePath, SiteApiError } from '../../web/src/site-api.js';

const ROOT = '/var/www/html';
const SITE_URL = 'http://playground.test';
const versions = JSON.parse(readFileSync(new URL('../../joomla-versions.json', import.meta.url), 'utf8'));
const bundle = new URL(`../../web/public/joomla/${versions.default}/site.zip`, import.meta.url);

let php;
let api;
const journal = [];

const call = (operation, args) => api.call(operation, args);
const rejects = (promise, code) => assert.rejects(promise, (error) => error instanceof SiteApiError && error.code === code);

before(async () => {
  assert.ok(existsSync(bundle), `No Joomla bundle at ${bundle.pathname}: run npm run bundle first.`);
  php = new PHP(await loadNodeRuntime('8.4', { emscriptenOptions: { processId: new ProcessIdAllocator().claim() } }));
  php.mkdirTree(ROOT);
  php.writeFile('/tmp/site.zip', readFileSync(bundle));
  await php.run({ code: `<?php $zip = new ZipArchive(); $zip->open('/tmp/site.zip'); $zip->extractTo('${ROOT}');` });

  // The bundle's paths are those of the build; the playground's worker sets them the same way.
  const configuration = php
    .readFileAsText(`${ROOT}/configuration.php`)
    .replace(/(\$tmp_path = )'[^']*'/, `$1'${ROOT}/tmp'`)
    .replace(/(\$log_path = )'[^']*'/, `$1'${ROOT}/administrator/logs'`);
  php.writeFile(`${ROOT}/configuration.php`, configuration);
  journalFSEvents(php, ROOT, (entry) => journal.push(`${entry.operation} ${entry.path}`));

  const handler = new PHPRequestHandler({ php, documentRoot: ROOT, absoluteUrl: SITE_URL });
  api = createSiteApi({ php, root: ROOT, siteUrl: SITE_URL, request: (request) => handler.request(request) });
});

after(() => php?.exit());

describe('paths', () => {
  test('are normalized relative to the root', () => {
    assert.equal(normalizePath('/templates/./cassiopeia//'), 'templates/cassiopeia');
    assert.equal(normalizePath('/'), '');
    assert.equal(normalizePath(''), '');
  });

  test('cannot leave the root', async () => {
    assert.throws(() => normalizePath('../etc/passwd'), { code: 'INVALID_PATH' });
    assert.throws(() => normalizePath('images/../../x'), { code: 'INVALID_PATH' });
    assert.throws(() => normalizePath('a\\b'), { code: 'INVALID_PATH' });
    assert.throws(() => normalizePath('a\0b'), { code: 'INVALID_PATH' });
    await rejects(call('read', { path: '../../internal/shared/php.ini' }), 'INVALID_PATH');
  });

  test('a symbolic link must point inside the root', async () => {
    php.mkdirTree('/outside');
    php.writeFile('/outside/secret.txt', 'secret');
    php.symlink('/outside', `${ROOT}/images/escape`);
    php.symlink(`${ROOT}/images/joomla_black.png`, `${ROOT}/images/inside.png`);

    await rejects(call('read', { path: 'images/escape/secret.txt' }), 'OUTSIDE_ROOT');
    await rejects(call('write', { path: 'images/escape/new.txt', text: 'x' }), 'OUTSIDE_ROOT');
    assert.equal((await call('stat', { path: 'images/escape' })).type, 'symlink');
    assert.ok((await call('read', { path: 'images/inside.png' })).base64);

    // The link itself can be deleted; its target stays.
    await call('delete', { path: 'images/escape' });
    assert.ok(php.fileExists('/outside/secret.txt'));
    await call('delete', { path: 'images/inside.png' });
  });

  test('the root cannot be deleted, moved or overwritten', async () => {
    await rejects(call('delete', { path: '/', recursive: true }), 'ROOT_PROTECTED');
    await rejects(call('rename', { from: '', to: 'elsewhere' }), 'ROOT_PROTECTED');
    await rejects(call('write', { path: '/', text: 'x' }), 'ROOT_PROTECTED');
  });
});

describe('files', () => {
  test('info names the site', async () => {
    const info = await call('info');

    assert.equal(info.joomla, versions.default);
    assert.match(info.php, /^8\.4\./);
    assert.equal(info.siteUrl, SITE_URL);
  });

  test('list shows folders first', async () => {
    const entries = await call('list', { path: '' });
    const names = entries.map(({ name }) => name);
    const firstFile = entries.findIndex(({ type }) => type !== 'directory');

    assert.ok(names.includes('administrator') && names.includes('index.php'));
    assert.ok(firstFile > 0 && entries.slice(firstFile).every(({ type }) => type !== 'directory'), 'folders come first');
    await rejects(call('list', { path: 'index.php' }), 'NOT_DIRECTORY');
    await rejects(call('list', { path: 'nothing-here' }), 'NOT_FOUND');
  });

  test('read gives text and a revision; binary files as base64', async () => {
    const file = await call('read', { path: '/index.php' });

    assert.match(file.text, /^<\?php/);
    assert.match(file.revision, /^[0-9a-f]{64}$/);
    assert.equal((await call('stat', { path: 'index.php' })).revision, file.revision);

    const image = await call('read', { path: 'images/joomla_black.png' });

    assert.equal(image.text, undefined);
    assert.equal(atob(image.base64).slice(1, 4), 'PNG');
    await rejects(call('read', { path: 'images' }), 'IS_DIRECTORY');
  });

  test('write creates folders and refuses to overwrite a changed file', async () => {
    const created = await call('write', { path: 'tmp/playground/a/note.txt', text: 'one', revision: null });

    assert.equal(created.created, true);
    await rejects(call('write', { path: 'tmp/playground/a/note.txt', text: 'two', revision: null }), 'EXISTS');

    const second = await call('write', { path: 'tmp/playground/a/note.txt', text: 'two', revision: created.revision });

    // Someone else changes the file: a write with the old revision fails, without one it overwrites.
    php.writeFile(`${ROOT}/tmp/playground/a/note.txt`, 'changed by Joomla');
    await rejects(call('write', { path: 'tmp/playground/a/note.txt', text: 'three', revision: second.revision }), 'CONFLICT');
    await call('write', { path: 'tmp/playground/a/note.txt', text: 'three' });
    assert.equal((await call('read', { path: 'tmp/playground/a/note.txt' })).text, 'three');

    await call('write', { path: 'tmp/playground/a/bytes.bin', base64: btoa('\x00\xff') });
    assert.equal((await call('read', { path: 'tmp/playground/a/bytes.bin' })).base64, btoa('\x00\xff'));
  });

  test('a saved PHP file counts from the next request on', async () => {
    for (const value of ['first', 'second', 'third']) {
      await call('write', { path: 'tmp/playground/value.php', text: `<?php echo '${value}';` });
      assert.equal((await call('runPhp', { code: `include 'tmp/playground/value.php';` })).output, value);
    }
  });

  test('mkdir, rename and delete', async () => {
    assert.equal((await call('mkdir', { path: 'tmp/playground/b' })).created, true);
    assert.equal((await call('mkdir', { path: 'tmp/playground/b' })).created, false);

    await call('rename', { from: 'tmp/playground/a', to: 'tmp/playground/b/a' });
    assert.equal((await call('stat', { path: 'tmp/playground/b/a/note.txt' })).type, 'file');
    assert.equal((await call('stat', { path: 'tmp/playground/a' })).type, null);
    await rejects(call('rename', { from: 'tmp/playground/b', to: 'tmp/playground/b/a/c' }), 'INVALID_ARGUMENT');

    await call('write', { path: 'tmp/playground/c.txt', text: 'c' });
    await rejects(call('rename', { from: 'tmp/playground/c.txt', to: 'tmp/playground/b/a/note.txt' }), 'EXISTS');
    await call('rename', { from: 'tmp/playground/c.txt', to: 'tmp/playground/b/a/note.txt', overwrite: true });
    assert.equal((await call('read', { path: 'tmp/playground/b/a/note.txt' })).text, 'c');

    await rejects(call('delete', { path: 'tmp/playground/b' }), 'NOT_EMPTY');
    await call('delete', { path: 'tmp/playground/b', recursive: true });
    assert.equal((await call('stat', { path: 'tmp/playground/b' })).type, null);
  });

  test('the filesystem journal sees the changes, so a saved site keeps them', () => {
    assert.ok(journal.includes(`CREATE ${ROOT}/tmp/playground/a/note.txt`));
    assert.ok(journal.some((entry) => entry.startsWith(`RENAME ${ROOT}/tmp/playground/a`)));
    assert.ok(journal.includes(`DELETE ${ROOT}/tmp/playground/b`));
  });

  test('search finds lines, skips caches and stops at its limit', async () => {
    const found = await call('search', { query: 'class HtmlView extends', path: 'administrator/components/com_content', glob: '*.php' });

    // The administrator's com_content has three such views: Article, Articles and Featured.
    assert.deepEqual(
      found.results.map(({ path }) => path.split('/').at(-2)).sort(),
      ['Article', 'Articles', 'Featured'],
    );
    assert.ok(found.results.every(({ path, line, text }) => path.endsWith('.php') && line > 0 && text.includes('class HtmlView')));

    const limited = await call('search', { query: '^namespace Joomla\\\\', regex: true, path: 'components', limit: 5 });

    assert.equal(limited.results.length, 5);
    assert.equal(limited.truncated, true);
    await rejects(call('search', { query: '(', regex: true }), 'INVALID_ARGUMENT');
  });
});

describe('running code', () => {
  test('runPhp runs in the root folder and reports errors as a result', async () => {
    const ok = await call('runPhp', { code: 'echo getcwd(), " ", PHP_INT_SIZE;' });

    assert.equal(ok.output, `${ROOT} 8`);
    assert.equal(ok.exitCode, 0);

    const failed = await call('runPhp', { code: '<?php throw new RuntimeException("broken");' });

    assert.equal(failed.exitCode, 255);
    assert.match(failed.errors, /broken/);
  });

  test('request reaches the site', async () => {
    const response = await call('request', { path: '/robots.txt.dist' });

    assert.equal(response.status, 200);
    assert.match(response.text, /User-agent/);

    const page = await call('request', { path: '/administrator/index.php' });

    assert.equal(page.status, 200);
    assert.match(page.text, /<form[^>]+id="form-login"/);
    await rejects(call('request', { path: 'http://example.com/' }), 'INVALID_ARGUMENT');
  });

  test('cli runs Joomla\'s console and returns its output', async () => {
    const list = await call('cli', { args: ['extension:list', '--type=template'] });

    assert.equal(list.exitCode, 0, list.errors || list.output);
    assert.match(list.output, /cassiopeia/i);

    const unknown = await call('cli', { args: ['no:such-command'] });

    assert.notEqual(unknown.exitCode, 0);
    assert.match(unknown.output, /not defined|no:such-command/i);
  });

  test('an unknown operation is refused', async () => {
    assert.throws(() => api.call('format'), { code: 'UNKNOWN_OPERATION' });
    assert.throws(() => api.call('toString'), { code: 'UNKNOWN_OPERATION' });
  });
});
