// ZIP read and write under the specification's ZIP rules (VRMXA §3.2, §3.5; VRMXW §3).
//
// Notes:
//   - Writing is repeatable: zeroed timestamps, no extra fields, no comments, entries in the order
//     given, and deflate done by fflate in plain JavaScript at a fixed level. The browser's
//     CompressionStream was dropped because its output is not guaranteed to be the same bytes in
//     every browser and in Node (each links its own zlib), so "same input, same bytes" could fail.
//   - Reading never trusts the archive: every structural fact is checked before it is used, and the
//     result is a list of problems instead of an exception (scanZip). readZip throws only when asked
//     to refuse a damaged archive.

import { deflateSync, inflateSync } from 'fflate';
import { asBytes, utf8 } from './bytes.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_END64_LOCATOR = 0x07064b50;

export const DEFLATE_LEVEL = 6;

/** Default ceilings. An app sets its own (VRMXA §3.5, "Sizes"). */
export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 10000,
  maxEntryBytes: 1024 * 1024 * 1024, // one entry, unpacked
  maxTotalBytes: 2 * 1024 * 1024 * 1024, // all entries, unpacked
  maxRatio: 500, // unpacked over packed size, for an entry over 1 MB (deflate tops out near 1032:1)
});

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(u8) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** True when the bytes start with a ZIP local-file header ("PK\x03\x04"). */
export function isZip(bytes) {
  const u8 = asBytes(bytes);
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
}

/**
 * Why an entry name is unsafe, or null when it is fine (VRMXA §3.5, "Entry names"): absolute, a `..`
 * segment, a backslash, a drive letter, empty. Also refused here: `.` and empty segments and control
 * characters, which let two different names unpack to the same place.
 */
export function entryNameProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'the name is empty';
  if (name.startsWith('/')) return 'the name is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'the name starts with a drive letter';
  if (name.includes('\\')) return 'the name contains a backslash';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'the name contains a control character';
  const segs = name.split('/');
  if (segs.includes('..')) return 'the name contains a ".." segment (it would point outside the folder)';
  if (segs.includes('.')) return 'the name contains a "." segment';
  if (name.endsWith('/')) return 'the entry is a folder, not a file';
  if (segs.includes('')) return 'the name contains an empty segment ("//")';
  return null;
}

/** Entries the writer stores rather than deflates: already compressed, or a ZIP of its own. */
export function storedByDefault(name) {
  return /\.(vrmxw|vrmxa|zip|png|jpe?g|webp|flac|ogg|mp3|mp4)$/i.test(name);
}

/**
 * Build a ZIP from [{ name, data, store? }]. Entries are written in the order given; put the manifest
 * first. The same entries always give the same bytes: zeroed timestamps, no extra fields, no
 * comments, deflate at a fixed level, and an entry is stored when deflating doesn't make it smaller.
 * `store: true` (or a name storedByDefault picks) stores the entry as it is.
 */
export function writeZip(entries, { level = DEFLATE_LEVEL } = {}) {
  if (entries.length > 0xfffe) throw new Error('too many entries for a ZIP without zip64');
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const bad = entryNameProblem(e.name);
    if (bad) throw new Error(`${e.name}: ${bad}`);
    if (seen.has(e.name)) throw new Error(`${e.name}: appears twice`);
    seen.add(e.name);
    const name = utf8(e.name);
    const raw = asBytes(e.data);
    if (raw.length >= 0xffffffff) throw new Error(`${e.name}: too large for a ZIP without zip64`);
    const crc = crc32(raw);
    let method = 0;
    let data = raw;
    if (!(e.store ?? storedByDefault(e.name)) && raw.length > 0) {
      const d = deflateSync(raw, { level });
      if (d.length < raw.length) {
        method = 8;
        data = d;
      }
    }
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, 0x0800, true); // bit 11: the name is UTF-8
    lv.setUint16(8, method, true);
    // 10..13: time and date, zeroed (VRMXW §3, "Repeatable")
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, data);

    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // made by: MS-DOS host, 2.0 (no Unix modes, so no links)
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    centrals.push(cen);
    offset += local.length + data.length;
  }
  if (offset >= 0xffffffff) throw new Error('archive too large for a ZIP without zip64');
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, SIG_END, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of locals) { out.set(part, p); p += part.length; }
  for (const part of centrals) { out.set(part, p); p += part.length; }
  out.set(end, p);
  return out;
}

export class ZipError extends Error {
  constructor(problems) {
    super(problems.map((p) => (p.where ? `${p.where}: ${p.message}` : p.message)).join('; '));
    this.name = 'ZipError';
    this.problems = problems;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Read a ZIP without trusting it. Returns { entries, problems }:
 *   entries:  [{ name, method, crc, packedSize, size, data? }] in central-directory order
 *   problems: [{ severity, where, code, message }]
 *   names:    every entry name read from the directory, refused ones included
 * Never throws. With `inflate: false` only the directory is read (no entry is unpacked).
 * Entries with a problem of their own are left out of `entries`.
 */
export function scanZip(input, { limits = {}, inflate = true, where = '' } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const problems = [];
  const err = (code, message, at = where) => problems.push({ severity: 'error', where: at, code, message });
  const warn = (code, message, at = where) => problems.push({ severity: 'warning', where: at, code, message });
  let u8;
  try {
    u8 = asBytes(input);
  } catch {
    err('zip.not-bytes', 'not a file');
    return { entries: [], problems };
  }
  const entries = [];
  if (u8.length < 22) {
    err('zip.not-zip', 'not a ZIP archive: the file is too short');
    return { entries, problems };
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // the end record: last 22 bytes plus at most a 64 KB comment
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_END && i + 22 + dv.getUint16(i + 20, true) === u8.length) { end = i; break; }
  }
  if (end < 0) {
    err('zip.not-zip', 'not a ZIP archive: no end-of-archive record');
    return { entries, problems };
  }
  if (end >= 20 && dv.getUint32(end - 20, true) === SIG_END64_LOCATOR) err('zip.zip64', 'the archive uses zip64, which the format does not allow');
  const disk = dv.getUint16(end + 4, true), cdDisk = dv.getUint16(end + 6, true);
  const countDisk = dv.getUint16(end + 8, true), count = dv.getUint16(end + 10, true);
  const cdSize = dv.getUint32(end + 12, true), cdOffset = dv.getUint32(end + 16, true);
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) {
    err('zip.multi-disk', 'the archive is split across disks, which the format does not allow');
    return { entries, problems };
  }
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    err('zip.zip64', 'the archive uses zip64, which the format does not allow');
    return { entries, problems };
  }
  if (cdOffset + cdSize !== end) {
    err('zip.directory', 'the central directory is not where the end record says it is (the file was changed or has data before or after the archive)');
    return { entries, problems };
  }
  if (count > L.maxEntries) {
    err('zip.too-many', `the archive has ${count} entries; the limit is ${L.maxEntries}`);
    return { entries, problems };
  }
  const names = new Set();
  const allNames = [];
  const lowerNames = new Map();
  const spans = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > end || dv.getUint32(p, true) !== SIG_CENTRAL) {
      err('zip.directory', `the central directory is damaged at entry ${n + 1}`);
      return { entries, problems };
    }
    const madeBy = dv.getUint16(p + 4, true);
    const needed = dv.getUint16(p + 6, true);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const packedSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const diskStart = dv.getUint16(p + 34, true);
    const external = dv.getUint32(p + 38, true);
    const localAt = dv.getUint32(p + 42, true);
    const recEnd = p + 46 + nameLen + extraLen + commentLen;
    if (recEnd > end) {
      err('zip.directory', `the central directory is damaged at entry ${n + 1}`);
      return { entries, problems };
    }
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    const extra = u8.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p = recEnd;
    let name;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      err('zip.name-encoding', `entry ${n + 1}: its name is not valid UTF-8`, where);
      continue;
    }
    const at = where ? `${where} → ${name}` : name;
    allNames.push(name);
    let bad = false;
    const nameProblem = entryNameProblem(name);
    if (nameProblem) { err('zip.entry-name', nameProblem, at); bad = true; }
    if (!(flags & 0x0800) && /[^\x20-\x7e]/.test(name)) { err('zip.name-encoding', 'the name is not ASCII and is not marked as UTF-8', at); bad = true; }
    if (names.has(name)) { err('zip.duplicate', 'two entries have this name', at); bad = true; }
    names.add(name);
    const lower = name.toLowerCase();
    if (lowerNames.has(lower) && lowerNames.get(lower) !== name) warn('zip.case-duplicate', `differs only in case from "${lowerNames.get(lower)}": unpacked on a disk that ignores case, one would replace the other`, at);
    lowerNames.set(lower, name);
    const host = madeBy >>> 8;
    const mode = external >>> 16;
    if (host === 3 && (mode & 0o170000) === 0o120000) { err('zip.link', 'the entry is a link', at); bad = true; }
    if (flags & 0x0001 || flags & 0x0040) { err('zip.encrypted', 'the entry is encrypted, which the format does not allow', at); bad = true; }
    if (method !== 0 && method !== 8) { err('zip.method', `compression method ${method} is not allowed (only stored and deflated)`, at); bad = true; }
    if (needed > 20 && method === 8) warn('zip.version', `the entry asks for ZIP version ${needed / 10}`, at);
    if (diskStart !== 0) { err('zip.multi-disk', 'the entry is on another disk', at); bad = true; }
    for (let q = 0; q + 4 <= extra.length;) {
      const id = extra[q] | (extra[q + 1] << 8);
      const len = extra[q + 2] | (extra[q + 3] << 8);
      if (id === 0x0001) { err('zip.zip64', 'the entry uses zip64, which the format does not allow', at); bad = true; }
      q += 4 + len;
    }
    if (method === 0 && packedSize !== size) { err('zip.size', 'a stored entry whose packed and unpacked sizes differ', at); bad = true; }
    if (size > L.maxEntryBytes) { err('zip.entry-too-large', `the entry unpacks to ${size} bytes; the limit is ${L.maxEntryBytes}`, at); bad = true; }
    if (packedSize > 0 && size / packedSize > L.maxRatio && size > 1024 * 1024) { err('zip.ratio', `the entry unpacks to ${Math.round(size / packedSize)} times its packed size, which is how a zip bomb looks`, at); bad = true; }
    total += size;
    // the local header must agree with the directory
    if (localAt + 30 > cdOffset || dv.getUint32(localAt, true) !== SIG_LOCAL) {
      err('zip.local-header', 'its local header is missing or damaged', at);
      continue;
    }
    const lNameLen = dv.getUint16(localAt + 26, true);
    const lExtraLen = dv.getUint16(localAt + 28, true);
    const lMethod = dv.getUint16(localAt + 8, true);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const lName = u8.subarray(localAt + 30, localAt + 30 + lNameLen);
    if (lNameLen !== nameLen || lName.some((b, i) => b !== nameBytes[i])) { err('zip.local-header', 'its local header gives a different name', at); bad = true; }
    if (lMethod !== method) { err('zip.local-header', 'its local header gives a different compression method', at); bad = true; }
    if (dataAt + packedSize > cdOffset) { err('zip.size', 'its data runs past the end of the archive', at); continue; }
    for (const [a, b, other] of spans) {
      if (localAt < b && dataAt + packedSize > a) { err('zip.overlap', `its data overlaps the entry "${other}"`, at); bad = true; break; }
    }
    spans.push([localAt, dataAt + packedSize, name]);
    if (bad) continue;
    entries.push({ name, method, crc, packedSize, size, dataAt, flags });
  }
  if (total > L.maxTotalBytes) err('zip.total-too-large', `the entries unpack to ${total} bytes in all; the limit is ${L.maxTotalBytes}`);
  if (problems.some((x) => x.severity === 'error' && ['zip.total-too-large'].includes(x.code))) return { entries: [], problems, names: allNames };

  if (inflate) {
    for (const e of entries) {
      const r = inflateEntry(u8, e, { where });
      if (r.problem) {
        problems.push(r.problem);
        e.bad = true;
      } else e.data = r.data;
    }
    return { entries: entries.filter((e) => !e.bad).map(({ dataAt, bad, ...rest }) => rest), problems, names: allNames };
  }
  // directory only: entries keep `dataAt` so inflateEntry can unpack them one at a time
  return { entries, problems, names: allNames };
}

/**
 * Unpack one entry found by scanZip({ inflate: false }) → { data } or { problem }. The declared size
 * is never exceeded: a stream that runs longer is caught, not truncated. The CRC-32 is checked.
 */
export function inflateEntry(input, e, { where = '' } = {}) {
  const u8 = asBytes(input);
  const at = where ? `${where} → ${e.name}` : e.name;
  const fail = (code, message) => ({ problem: { severity: 'error', where: at, code, message } });
  const raw = u8.subarray(e.dataAt, e.dataAt + e.packedSize);
  let data;
  if (e.method === 0) data = raw;
  else {
    try {
      // one byte of room past the declared size
      const out = inflateSync(raw, { out: new Uint8Array(e.size + 1) });
      if (out.length !== e.size) return fail('zip.size', out.length > e.size ? 'the entry unpacks to more than its declared size' : 'the entry unpacks to less than its declared size');
      data = out;
    } catch (ex) {
      return fail('zip.inflate', `the entry could not be unpacked (${ex.message})`);
    }
  }
  if (crc32(data) !== e.crc) return fail('zip.crc', 'its CRC-32 does not match its data (the archive is damaged)');
  return { data };
}

/**
 * Read a ZIP into [{ name, data, method, ... }] in archive order, refusing it as a whole (ZipError)
 * when it breaks any rule.
 */
export function readZip(input, opts = {}) {
  const { entries, problems } = scanZip(input, opts);
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) throw new ZipError(errors);
  return entries;
}
