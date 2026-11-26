// A small PNG reader and writer in plain JavaScript (fflate for zlib), so a texture painted by the
// edit library comes out the same in a browser and in Node (PRD REF-10). Reads 8-bit greyscale,
// grey + alpha, RGB, RGBA and palette images, not interlaced; anything else is refused with the
// reason. Writes 8-bit RGBA with each row's filter chosen the same way every time.

import { unzlibSync, zlibSync } from 'fflate';
import { crc32 } from '../zip.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class PngError extends Error {
  constructor(message) { super(message); this.name = 'PngError'; }
}

const be32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;

export const isPng = (u8) => u8?.length > 8 && SIGNATURE.every((b, i) => u8[i] === b);

/** PNG bytes → { width, height, data: Uint8ClampedArray RGBA }. */
export function decodePng(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isPng(u8)) throw new PngError('not a PNG');
  let at = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (at + 8 <= u8.length) {
    const len = be32(u8, at);
    const name = String.fromCharCode(u8[at + 4], u8[at + 5], u8[at + 6], u8[at + 7]);
    const data = u8.subarray(at + 8, at + 8 + len);
    if (at + 12 + len > u8.length) throw new PngError(`the ${name} chunk runs past the end`);
    if (name === 'IHDR') {
      width = be32(data, 0); height = be32(data, 4); depth = data[8]; type = data[9]; interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height) throw new PngError('no IHDR');
  if (width * height > 8192 * 8192) throw new PngError(`${width} × ${height} is larger than 8192 × 8192`);
  if (depth !== 8) throw new PngError(`bit depth ${depth}: only 8-bit pictures are read`);
  if (interlace) throw new PngError('interlaced pictures are not read');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels) throw new PngError(`colour type ${type} is not a PNG colour type`);
  if (type === 3 && !palette) throw new PngError('a palette picture without a palette');
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = unzlibSync(z);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new PngError('the picture data is short');
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new PngError(`row ${y} has filter ${f}`);
      row[x] = v & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (type === 6) { data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2]; data[d + 3] = px[s + 3]; }
    else if (type === 2) {
      data[d] = px[s]; data[d + 1] = px[s + 1]; data[d + 2] = px[s + 2];
      data[d + 3] = trns && trns.length >= 6 && px[s] === trns[1] && px[s + 1] === trns[3] && px[s + 2] === trns[5] ? 0 : 255;
    } else if (type === 0) { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = trns && trns.length >= 2 && px[s] === trns[1] ? 0 : 255; }
    else if (type === 4) { data[d] = data[d + 1] = data[d + 2] = px[s]; data[d + 3] = px[s + 1]; }
    else {
      const k = px[s];
      if (k * 3 + 2 >= palette.length) throw new PngError('a palette index is out of range');
      data[d] = palette[k * 3]; data[d + 1] = palette[k * 3 + 1]; data[d + 2] = palette[k * 3 + 2];
      data[d + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  }
  return { width, height, data };
}

function chunk(name, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = name.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * { width, height, data (RGBA) } → PNG bytes, 8-bit RGBA. Each row uses the filter whose output has
 * the smallest sum of absolute values (the usual rule), so the same pixels give the same bytes.
 */
export function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray ? data.subarray(y * stride, (y + 1) * stride) : data.slice(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0, b = up ? up[x] : 0, cc = up && x >= 4 ? up[x - 4] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const v = (row[x] - pred) & 255;
        c[x] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    raw.set(cand[best], y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
