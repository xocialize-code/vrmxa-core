// A ZIP writer that skips every safety rule, for writing hostile fixtures only. Each entry may set
// `declaredSize` to lie about its unpacked size in the headers.
import { deflateSync } from 'fflate';
import { crc32 } from '../../src/zip.js';

export function rawZip(entries) {
  const enc = new TextEncoder();
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = e.data;
    const data = e.store ? raw : deflateSync(raw, { level: 6 });
    const method = e.store ? 0 : 8;
    const size = e.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const l = new Uint8Array(30 + name.length); const lv = new DataView(l.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); l.set(name, 30);
    locals.push(l, data);
    const c = new Uint8Array(46 + name.length); const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); c.set(name, 46);
    centrals.push(c);
    offset += l.length + data.length;
  }
  const cd = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, cd, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cd + 22);
  let p = 0;
  for (const x of [...locals, ...centrals, end]) { out.set(x, p); p += x.length; }
  return out;
}
