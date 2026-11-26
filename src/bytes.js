// Small byte and text helpers shared by every module. Plain JavaScript: runs in a browser and in Node.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** Bytes from a Uint8Array, an ArrayBuffer, a view, or a string (UTF-8). */
export function asBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return enc.encode(x);
  throw new TypeError('expected bytes or a string');
}

export const utf8 = (s) => enc.encode(s);

/** UTF-8 text from bytes; throws on invalid UTF-8. */
export const text = (u8) => dec.decode(u8);

/** A standalone ArrayBuffer holding exactly these bytes. */
export const arrayBufferOf = (u8) =>
  u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/**
 * The JSON form every document and manifest is written in: two-space indent, keys in the order
 * the object holds them, and a final newline. The same object always gives the same bytes.
 */
export const jsonBytes = (obj) => enc.encode(JSON.stringify(obj, null, 2) + '\n');

/** Parse JSON from bytes. Returns { value } or { error } (never throws). */
export function parseJson(u8) {
  try {
    return { value: JSON.parse(text(u8)) };
  } catch (err) {
    return { error: err.message };
  }
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep copy of JSON-like data. */
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA256_RE = /^[0-9a-f]{64}$/;
export const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A new random UUID (Web Crypto, present in browsers and Node 19+). */
export function newUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The current time as the format writes it: ISO 8601 UTC with milliseconds. */
export const nowIso = () => new Date().toISOString();
