// A small, repeatable PNG encoder (RGBA, 8 bits, no filtering) for fixture pictures.
import { zlibSync } from 'fflate';
import { crc32 } from '../../src/zip.js';

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t);
  body.set(data, t.length);
  return new Uint8Array([...be32(data.length), ...body, ...be32(crc32(body))]);
}

/** PNG bytes from width, height and a function (x, y) → [r, g, b, a] (0–255). */
export function png(w, h, pixel) {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (1 + w * 4) + 1 + x * 4);
  }
  const ihdr = new Uint8Array([...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
