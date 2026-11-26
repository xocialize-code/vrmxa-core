// Containers: ZIP read and write under the specification's rules (VRMXA §3.2, §3.5; VRMXW §3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeZip, readZip, scanZip, entryNameProblem, isZip, ZipError } from '../src/zip.js';
import { rawZip } from '../scripts/lib/rawzip.mjs';
import { same } from './helpers.mjs';

const enc = (s) => new TextEncoder().encode(s);
const sample = () => [
  { name: 'vrmxa.json', data: enc('{"format":"vrmxa"}\n') },
  { name: 'big.json', data: enc('x'.repeat(5000)) },
  { name: 'pic.png', data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
  { name: 'déjà/vu.txt', data: enc('UTF-8 names') },
];

test('the same entries always give the same bytes (zeroed times, fixed deflate)', () => {
  const a = writeZip(sample());
  const b = writeZip(sample());
  assert.ok(same(a, b));
  // timestamps are zero in every local header
  const dv = new DataView(a.buffer);
  assert.equal(dv.getUint32(10, true), 0);
});

test('write then read gives back every entry, in order, manifest first', () => {
  const out = readZip(writeZip(sample()));
  assert.deepEqual(out.map((e) => e.name), sample().map((e) => e.name));
  sample().forEach((e, i) => assert.ok(same(out[i].data, e.data)));
  assert.equal(out[1].method, 8, 'JSON is deflated');
  assert.equal(out[2].method, 0, 'a PNG is stored');
});

test('entry names that are unsafe are refused (§3.5, "Entry names")', () => {
  for (const n of ['', '/abs', 'C:/x', 'a\\b', '../up', 'a/../b', './a', 'a//b', 'dir/', 'nul\u0000']) assert.ok(entryNameProblem(n), n);
  for (const n of ['vrmxa.json', 'closet/items/tops-x.vrmxw', 'déjà/vu.txt']) assert.equal(entryNameProblem(n), null, n);
  assert.throws(() => writeZip([{ name: '../x', data: enc('') }]));
  assert.throws(() => writeZip([{ name: 'a', data: enc('') }, { name: 'a', data: enc('') }]));
});

test('a hostile archive is reported, never thrown, by scanZip', () => {
  const bad = rawZip([{ name: 'ok.txt', data: enc('fine') }, { name: '../escape', data: enc('no') }, { name: 'ok.txt', data: enc('twice') }]);
  const { entries, problems } = scanZip(bad);
  const c = problems.map((p) => p.code);
  assert.ok(c.includes('zip.entry-name'));
  assert.ok(c.includes('zip.duplicate'));
  assert.deepEqual(entries.map((e) => e.name), ['ok.txt']);
  assert.throws(() => readZip(bad), ZipError);
});

test('a declared size smaller than the data is caught, not truncated; a CRC mismatch is caught', () => {
  const lie = rawZip([{ name: 'a.txt', data: enc('y'.repeat(1000)), declaredSize: 10 }]);
  assert.ok(scanZip(lie).problems.some((p) => p.code === 'zip.size'));
  const z = writeZip([{ name: 'a.txt', data: enc('hello hello hello'), store: true }]);
  z[30 + 5 + 2] ^= 0xff; // flip a data byte of the stored entry
  assert.ok(scanZip(z).problems.some((p) => p.code === 'zip.crc'));
});

test('a zip bomb is refused before it is unpacked', () => {
  const bomb = rawZip([{ name: 'zeros.bin', data: new Uint8Array(20 * 1024 * 1024) }]);
  const { problems } = scanZip(bomb);
  assert.ok(problems.some((p) => p.code === 'zip.ratio'));
  assert.ok(scanZip(bomb, { limits: { maxEntryBytes: 1024 } }).problems.some((p) => p.code === 'zip.entry-too-large'));
});

test('random damage never throws (500 corrupted archives)', () => {
  const good = writeZip(sample());
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 500; k++) {
    const b = good.slice(0, k % 3 === 0 ? Math.floor(rnd() * good.length) : good.length);
    for (let i = 0; i < 1 + (k % 5); i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => scanZip(b));
  }
  assert.equal(isZip(new Uint8Array([1, 2])), false);
});
