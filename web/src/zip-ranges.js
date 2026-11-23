// Reads files from a zip on a server without downloading all of it: the central directory (the list at the end of
// the zip, with the name, CRC-32 and size of every file) and then only the entries asked for, with HTTP Range
// requests. For the packages Joomla's CI builds of a pull request (35 MB), of which a test needs a few files.
//
// A reader is made from a function that fetches a byte range, so the same code reads a zip in memory (when the
// server ignores Range and sends the whole file).

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The end of a zip asked for first: the end record (22 bytes + a comment of at most 64 KB) is in it. */
const TAIL_BYTES = 64 * 1024 + 22;

/** Ranges closer than this are fetched as one: a request costs more than some bytes in between. */
const MERGE_GAP = 64 * 1024;

/**
 * A zip on a server, read with Range requests.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch]
 * @returns {Promise<{size: number, entries: object[], read: (entries: object[]) => Promise<Map<string, Uint8Array>>, whole: Uint8Array|null, requested: () => number}>}
 *   whole is the zip itself when the server sent all of it instead of a range.
 */
export async function openRemoteZip(url, { fetch: get = fetch } = {}) {
  let requested = 0;

  // Not from the browser's cache: a cached copy of the whole file answers a range itself, with the CORS headers of
  // that copy, which may not expose Content-Range.
  const range = async (start, end) => {
    const response = await get(url, { headers: { range: `bytes=${start}-${end - 1}` }, cache: 'no-store' });

    if (response.status !== 206) {
      throw new Error(`Expected part of the zip (HTTP 206), got HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    requested += bytes.length;

    if (bytes.length !== end - start) {
      throw new Error(`Asked for ${end - start} bytes of the zip, got ${bytes.length}`);
    }

    return bytes;
  };

  // A suffix range: the server says the zip's size in Content-Range. A server without Range support sends it all.
  const response = await get(url, { headers: { range: `bytes=-${TAIL_BYTES}` }, cache: 'no-store' });

  if (!response.ok) {
    throw new Error(`Cannot read the zip: HTTP ${response.status}`);
  }

  const first = new Uint8Array(await response.arrayBuffer());
  requested += first.length;

  if (response.status !== 206) {
    return { ...(await memoryZip(first)), whole: first, requested: () => requested };
  }

  const size = Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]);

  if (!Number.isFinite(size) || size < first.length) {
    // Part of the zip, but not where it is (Content-Range missing or not exposed): read all of it instead.
    const all = await get(url, { cache: 'no-store' });

    if (!all.ok) {
      throw new Error(`Cannot read the zip: HTTP ${all.status}`);
    }

    const whole = new Uint8Array(await all.arrayBuffer());
    requested += whole.length;

    return { ...(await memoryZip(whole)), whole, requested: () => requested };
  }

  const tailStart = size - first.length;
  const at = async (start, end) => (start >= tailStart ? first.subarray(start - tailStart, end - tailStart) : range(start, end));
  const entries = await centralDirectory(first, tailStart, at);

  return { size, entries, read: (wanted) => readEntries(wanted, entries, at, { merge: true }), whole: null, requested: () => requested };
}

/**
 * A zip in memory, read the same way.
 *
 * @param {Uint8Array} bytes
 */
export async function memoryZip(bytes) {
  const at = async (start, end) => bytes.subarray(start, end);
  const tailStart = Math.max(0, bytes.length - TAIL_BYTES);
  const entries = await centralDirectory(bytes.subarray(tailStart), tailStart, at);

  return { size: bytes.length, entries, read: (wanted) => readEntries(wanted, entries, at, { merge: false }) };
}

/**
 * The entries of the central directory: { name, crc (8 hex digits), size, compressedSize, method, offset }.
 */
async function centralDirectory(tail, tailStart, at) {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;

  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  }

  if (end < 0) {
    throw new Error('Not a zip: it has no end of central directory record');
  }

  let count = view.getUint16(end + 10, true);
  let cdSize = view.getUint32(end + 12, true);
  let cdOffset = view.getUint32(end + 16, true);

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // Zip64: the locator just before the end record points to the zip64 end record.
    const locator = end - 20;

    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) {
      throw new Error('A zip64 zip without its zip64 locator');
    }

    const recordOffset = Number(view.getBigUint64(locator + 8, true));
    const record = await at(recordOffset, recordOffset + 56);
    const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);

    if (recordView.getUint32(0, true) !== ZIP64_EOCD) {
      throw new Error('A zip64 zip without its zip64 end record');
    }

    count = Number(recordView.getBigUint64(32, true));
    cdSize = Number(recordView.getBigUint64(40, true));
    cdOffset = Number(recordView.getBigUint64(48, true));
  }

  const cd = await at(cdOffset, cdOffset + cdSize);
  const cdView = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const names = new TextDecoder();
  const entries = [];
  let p = 0;

  for (let n = 0; n < count; n++) {
    if (cdView.getUint32(p, true) !== CENTRAL) {
      throw new Error(`The central directory of the zip is damaged at entry ${n}`);
    }

    const nameLength = cdView.getUint16(p + 28, true);
    const extraLength = cdView.getUint16(p + 30, true);
    const commentLength = cdView.getUint16(p + 32, true);
    const entry = {
      name: names.decode(cd.subarray(p + 46, p + 46 + nameLength)),
      method: cdView.getUint16(p + 10, true),
      crc: cdView.getUint32(p + 16, true).toString(16).padStart(8, '0'),
      compressedSize: cdView.getUint32(p + 20, true),
      size: cdView.getUint32(p + 24, true),
      offset: cdView.getUint32(p + 42, true),
    };

    // Zip64 extra field: the 64-bit values, in this order, of those that are 0xffffffff above.
    for (let e = p + 46 + nameLength; e + 4 <= p + 46 + nameLength + extraLength; ) {
      const id = cdView.getUint16(e, true);
      const length = cdView.getUint16(e + 2, true);

      if (id === 0x0001) {
        let q = e + 4;

        for (const field of ['size', 'compressedSize', 'offset']) {
          if (entry[field] === 0xffffffff) {
            entry[field] = Number(cdView.getBigUint64(q, true));
            q += 8;
          }
        }
      }

      e += 4 + length;
    }

    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }

  // Where each entry's bytes end: the next entry's local header, or the central directory.
  const byOffset = [...entries].sort((a, b) => a.offset - b.offset);

  byOffset.forEach((entry, i) => {
    entry.end = byOffset[i + 1]?.offset ?? cdOffset;
  });

  return entries;
}

/**
 * The contents of the given entries, by name. With merge, entries close together are fetched in one range.
 */
async function readEntries(wanted, entries, at, { merge }) {
  const files = new Map();
  const sorted = [...wanted].sort((a, b) => a.offset - b.offset);
  const groups = [];

  for (const entry of sorted) {
    const last = groups.at(-1);

    if (merge && last && entry.offset - last.end <= MERGE_GAP) {
      last.end = Math.max(last.end, entry.end);
      last.entries.push(entry);
    } else {
      groups.push({ start: entry.offset, end: entry.end, entries: [entry] });
    }
  }

  for (const group of groups) {
    const bytes = await at(group.start, group.end);

    for (const entry of group.entries) {
      files.set(entry.name, await entryContent(bytes.subarray(entry.offset - group.start, entry.end - group.start), entry));
    }
  }

  return files;
}

async function entryContent(bytes, entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (view.getUint32(0, true) !== LOCAL) {
    throw new Error(`The zip is damaged at ${entry.name}`);
  }

  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  let content;

  if (entry.method === 0) {
    content = data.slice();
  } else if (entry.method === 8) {
    content = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  } else {
    throw new Error(`${entry.name} is compressed with a method this reader does not know (${entry.method})`);
  }

  if (content.length !== entry.size || crc32(content).toString(16).padStart(8, '0') !== entry.crc) {
    throw new Error(`${entry.name} in the zip does not match its checksum`);
  }

  return content;
}

let table = null;

export function crc32(bytes) {
  table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }

    return c >>> 0;
  });

  let crc = 0xffffffff;

  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
