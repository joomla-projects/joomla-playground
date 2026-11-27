// Tests of the zip reader with Range requests (web/src/zip-ranges.js), with zips made by PHP's ZipArchive and a fake
// server. Run: npm run test:zip

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, memoryZip, openRemoteZip } from '../../web/src/zip-ranges.js';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** A zip made by PHP: files as name => content; names ending in "!" are stored, not compressed. */
function makeZip(files) {
  const folder = mkdtempSync(join(tmpdir(), 'zip-ranges-'));
  const file = join(folder, 'test.zip');

  try {
    execFileSync('php', ['-r', `
      $files = json_decode(stream_get_contents(STDIN), true);
      $zip = new ZipArchive();
      $zip->open($argv[1], ZipArchive::CREATE | ZipArchive::OVERWRITE);
      foreach ($files as $name => $content) {
          $stored = str_ends_with($name, '!');
          $name = rtrim($name, '!');
          $zip->addFromString($name, $content);
          $stored && $zip->setCompressionName($name, ZipArchive::CM_STORE);
      }
      $zip->setArchiveComment('a comment at the end');
      $zip->close();
    `, file], { input: JSON.stringify(files) });

    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A fetch that serves bytes, with or without Range support; records the ranges asked for. */
function server(bytes, { ranges = true } = {}) {
  const asked = [];

  const get = async (url, { headers = {} } = {}) => {
    const range = headers.range;
    asked.push(range ?? 'all');

    if (!ranges || !range) {
      return new Response(bytes, { status: 200 });
    }

    const suffix = range.match(/^bytes=-(\d+)$/);
    const span = range.match(/^bytes=(\d+)-(\d+)$/);
    const start = suffix ? Math.max(0, bytes.length - Number(suffix[1])) : Number(span[1]);
    const end = suffix ? bytes.length - 1 : Math.min(Number(span[2]), bytes.length - 1);

    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}` } });
  };

  return { get, asked };
}

const big = 'x'.repeat(200000) + 'end';
const files = {
  'media/one.js': 'console.log("one");',
  'stored.txt!': 'not compressed',
  'administrator/big.txt': big,
  'empty.txt': '',
  'media/ü-name.css': 'body { color: red }',
};

describe('zip reader', () => {
  test('lists the entries with their CRC-32 and size', async () => {
    const zip = await memoryZip(makeZip(files));
    const byName = Object.fromEntries(zip.entries.map((entry) => [entry.name, entry]));

    assert.deepEqual(Object.keys(byName).sort(), ['administrator/big.txt', 'empty.txt', 'media/one.js', 'media/ü-name.css', 'stored.txt']);
    assert.equal(byName['media/one.js'].crc, crc32(new TextEncoder().encode(files['media/one.js'])).toString(16).padStart(8, '0'));
    assert.equal(byName['administrator/big.txt'].size, big.length);
    assert.equal(byName['stored.txt'].method, 0);
    assert.equal(byName['administrator/big.txt'].method, 8);
  });

  test('reads only the central directory and the entries asked for, with Range requests', async () => {
    const bytes = makeZip(files);
    const { get, asked } = server(bytes);
    const zip = await openRemoteZip('https://example.org/test.zip', { fetch: get });

    assert.equal(zip.size, bytes.length);
    assert.equal(zip.whole, null);

    const wanted = zip.entries.filter((entry) => ['media/one.js', 'stored.txt', 'empty.txt', 'media/ü-name.css'].includes(entry.name));
    const read = await zip.read(wanted);
    const text = (name) => new TextDecoder().decode(read.get(name));

    assert.equal(text('media/one.js'), files['media/one.js']);
    assert.equal(text('stored.txt'), files['stored.txt!']);
    assert.equal(text('empty.txt'), '');
    assert.equal(text('media/ü-name.css'), files['media/ü-name.css']);
    assert.match(asked[0], /^bytes=-\d+$/);
    // The small zip fits in the first range: nothing else is fetched.
    assert.ok(zip.requested() <= bytes.length);
  });

  test('fetches a large entry outside the first range, and checks it', async () => {
    const bytes = makeZip({ ...files, 'z/random.bin!': Array.from({ length: 150000 }, (_, i) => String.fromCharCode(33 + ((i * 7919) % 90))).join('') });
    const { get, asked } = server(bytes);
    const zip = await openRemoteZip('https://example.org/test.zip', { fetch: get });
    const entry = zip.entries.find((e) => e.name === 'media/one.js');
    const read = await zip.read([entry]);

    assert.equal(new TextDecoder().decode(read.get('media/one.js')), files['media/one.js']);
    assert.equal(asked.length, 2);
    assert.match(asked[1], /^bytes=\d+-\d+$/);
  });

  test('uses the whole zip when the server ignores Range', async () => {
    const bytes = makeZip(files);
    const { get, asked } = server(bytes, { ranges: false });
    const zip = await openRemoteZip('https://example.org/test.zip', { fetch: get });

    assert.equal(zip.whole.length, bytes.length);
    assert.equal(asked.length, 1);

    const read = await zip.read(zip.entries.filter((entry) => entry.name === 'administrator/big.txt'));

    assert.equal(new TextDecoder().decode(read.get('administrator/big.txt')), big);
  });

  test('reads the whole zip when a part comes without its Content-Range', async () => {
    const bytes = makeZip(files);
    const asked = [];
    const get = async (url, { headers = {}, cache } = {}) => {
      asked.push({ range: headers.range ?? 'all', cache });

      return headers.range ? new Response(bytes.slice(-100), { status: 206 }) : new Response(bytes);
    };
    const zip = await openRemoteZip('https://example.org/test.zip', { fetch: get });

    assert.equal(zip.whole.length, bytes.length);
    assert.deepEqual(asked.map((item) => item.range), ['bytes=-65558', 'all']);
    assert.ok(asked.every((item) => item.cache === 'no-store'));
  });

  test('refuses an entry that does not match its checksum', async () => {
    const bytes = makeZip({ 'a.txt!': 'abcdefghij' });
    const damaged = bytes.slice();
    const at = Buffer.from(damaged).indexOf('abcdefghij');
    damaged[at] = 'X'.charCodeAt(0);
    const zip = await memoryZip(damaged);

    await assert.rejects(zip.read(zip.entries), /does not match its checksum/);
  });

  test('refuses what is not a zip', async () => {
    await assert.rejects(memoryZip(new TextEncoder().encode('not a zip at all')), /Not a zip/);
  });

  test('reads a Full Package of Joomla as PHP does, when one is in .cache/', async (t) => {
    const name = existsSync(`${root}/.cache`) && readdirSync(`${root}/.cache`).find((file) => /^Joomla_.*Full_Package\.zip$/.test(file));

    if (!name) {
      t.skip('No Full Package in .cache/');

      return;
    }

    const file = `${root}/.cache/${name}`;
    const php = JSON.parse(execFileSync('php', ['-r', `
      $zip = new ZipArchive();
      $zip->open($argv[1]);
      $list = [];
      for ($i = 0; $i < $zip->numFiles; $i++) {
          $stat = $zip->statIndex($i);
          $list[$stat['name']] = [sprintf('%08x', $stat['crc']), $stat['size']];
      }
      echo json_encode($list);
    `, file], { maxBuffer: 64 * 1024 * 1024 }).toString());
    const bytes = new Uint8Array(readFileSync(file));
    const { get } = server(bytes);
    const zip = await openRemoteZip('https://example.org/package.zip', { fetch: get });

    assert.equal(zip.entries.length, Object.keys(php).length);

    for (const entry of zip.entries) {
      assert.deepEqual([entry.crc, entry.size], php[entry.name], entry.name);
    }

    const some = zip.entries.filter((entry) => /^media\/system\/js\/core\.min\.js$|^libraries\/src\/Version\.php$|^index\.php$/.test(entry.name));
    const read = await zip.read(some);

    assert.equal(read.size, some.length);
    assert.ok(zip.requested() < bytes.length / 5, `read ${zip.requested()} of ${bytes.length} bytes`);
  });
});
