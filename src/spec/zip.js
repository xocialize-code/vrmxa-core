// Reading a .vrmxa or .vrmxw as untrusted input (VRMXA §3.2, §3.5), in Node, with no reference library.
// Only what a checker needs: the central directory, each entry's name, sizes, method and flags, and an
// entry's bytes on request, checked against its CRC-32 and the size its headers declare.

import { crc32, inflateRawSync } from 'node:zlib';

export const LIMITS = Object.freeze({ entry: 1024 ** 3, total: 2 * 1024 ** 3, entries: 10000, ratioOver: 1024 ** 2, ratio: 500 });

/** Why an entry name is refused (VRMXA §3.5 Entry names), or null. */
export function entryNameProblem(name) {
  if (typeof name !== 'string' || name === '') return 'the name is empty';
  if (name.endsWith('/')) return 'it is a folder entry (a name ending in "/")';
  if (name.startsWith('/')) return 'the name is absolute';
  if (/^[A-Za-z]:/.test(name)) return 'the name has a drive letter';
  if (name.includes('\\')) return 'the name contains a backslash';
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'the name contains a control character';
  for (const seg of name.split('/')) {
    if (seg === '') return 'the name has an empty segment';
    if (seg === '.' || seg === '..') return `the name contains a "${seg}" segment (it would point outside the folder)`;
  }
  return null;
}

/**
 * The entries of a ZIP → { entries: [{ name, method, flags, csize, size, crc, offset, external }], problems }.
 * problems are { code, message, where }; the archive's structure is never trusted.
 */
export function readDirectory(u8, limits = LIMITS) {
  const problems = [];
  const P = (code, message, where = '') => problems.push({ code, message, where });
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 22 || dv.getUint32(0, true) !== 0x04034b50) { P('container.not-zip', 'is not a ZIP archive'); return { entries: [], problems }; }
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) { P('container.not-zip', 'has no end of central directory'); return { entries: [], problems }; }
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) { P('zip.zip64', 'uses zip64, which the format does not allow (VRMXA §3.2)'); return { entries: [], problems }; }
  if (cdOffset + cdSize > u8.length) { P('zip.overlap', 'its central directory runs past the end of the file'); return { entries: [], problems }; }
  if (count > limits.entries) { P('zip.too-many', `has ${count} entries; the default ceiling is ${limits.entries}`); return { entries: [], problems }; }
  const entries = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  let p = cdOffset, total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) { P('zip.overlap', 'its central directory is damaged'); break; }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const external = dv.getUint32(p + 38, true);
    const offset = dv.getUint32(p + 42, true);
    let name;
    try { name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)); } catch { name = null; P('zip.name-encoding', 'an entry name is not UTF-8 (VRMXA §3.2)'); }
    p += 46 + nlen + xlen + clen;
    if (name === null) continue;
    entries.push({ name, method, flags, csize, size, crc, offset, external });
    if (flags & 1) P('zip.encrypted', 'is encrypted; the format allows no encryption (VRMXA §3.2)', name);
    if (method !== 0 && method !== 8) P('zip.method', `uses compression method ${method}; entries are stored (0) or deflated (8)`, name);
    if (size === 0xffffffff || csize === 0xffffffff) P('zip.zip64', 'uses zip64 sizes (VRMXA §3.2)', name);
    const bad = entryNameProblem(name);
    if (bad) P('zip.entry-name', bad, name);
    if (((external >>> 16) & 0o170000) === 0o120000) P('zip.link', 'is a link; a bundle has no links (VRMXA §3.5)', name);
    if (size > limits.entry) P('zip.entry-too-large', `unpacks to ${size} bytes; the default ceiling is ${limits.entry}`, name);
    if (size > limits.ratioOver && size > csize * limits.ratio) P('zip.ratio', `unpacks to ${size} bytes from ${csize}: more than ${limits.ratio} times its packed size; not unpacked (VRMXA §3.5 Sizes, D31)`, name);
    total += size;
  }
  if (total > limits.total) P('zip.total-too-large', `unpacks to ${total} bytes; the default ceiling is ${limits.total}`);
  const seen = new Map();
  for (const e of entries) {
    if (seen.has(e.name)) P('zip.duplicate', 'appears twice', e.name);
    const low = e.name.toLowerCase();
    if (!seen.has(e.name) && [...seen.keys()].some((n) => n.toLowerCase() === low)) P('zip.case-duplicate', 'differs from another entry only in case: they collide on a Mac or Windows disk', e.name);
    seen.set(e.name, true);
  }
  return { entries, problems };
}

/** One entry's bytes → { data } or { problem }; never more than its headers declare. */
export function readEntry(u8, e) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const o = e.offset;
  if (o + 30 > u8.length || dv.getUint32(o, true) !== 0x04034b50) return { problem: { code: 'zip.local-header', message: 'its local header is missing', where: e.name } };
  const start = o + 30 + dv.getUint16(o + 26, true) + dv.getUint16(o + 28, true);
  if (start + e.csize > u8.length) return { problem: { code: 'zip.overlap', message: 'its data runs past the end of the file', where: e.name } };
  const raw = u8.subarray(start, start + e.csize);
  let data;
  try {
    data = e.method === 0 ? raw : new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }));
  } catch (err) {
    return { problem: { code: 'zip.inflate', message: `could not be unpacked within the size it declares (${err.code || err.message})`, where: e.name } };
  }
  if (data.length !== e.size) return { problem: { code: 'zip.size', message: `unpacks to ${data.length} bytes, not the ${e.size} its headers declare`, where: e.name } };
  if ((crc32(data) >>> 0) !== e.crc) return { problem: { code: 'zip.crc', message: 'fails its CRC-32', where: e.name } };
  return { data };
}
