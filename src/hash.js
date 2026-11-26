// SHA-256 through Web Crypto (crypto.subtle), present in browsers and in Node 19+.

import { arrayBufferOf, asBytes } from './bytes.js';

/** SHA-256 of the bytes, as 64 lowercase hex digits. */
export async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto (crypto.subtle) is not available in this environment');
  const h = await subtle.digest('SHA-256', arrayBufferOf(asBytes(bytes)));
  let s = '';
  for (const b of new Uint8Array(h)) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The first 12 hex digits of a SHA-256: how models, clips and audio are named (VRMXA §2 rule 2). */
export const sha12 = (hex) => hex.slice(0, 12);
