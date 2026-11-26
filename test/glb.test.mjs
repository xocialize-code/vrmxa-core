// Models are read without trusting them (VRMXA §3.5, "Models").
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, buildGlb, readAccessor, GltfError, BinWriter } from '../src/glb.js';
import { checkModel } from '../src/checker.js';
import { miniVrm } from '../scripts/lib/minivrm.mjs';

test('a small VRM parses and passes the model check', () => {
  const r = checkModel(miniVrm(), { kind: 'vrm' });
  assert.deepEqual(r.problems, []);
});

test('an accessor reaching past its buffer view is an error, not a read outside the file', () => {
  const g = { asset: { version: '2.0' } };
  const w = new BinWriter(g);
  const a = w.accessor(new Float32Array([1, 2, 3]), 5126, 'VEC3');
  g.accessors[a].count = 1000;
  const bin = w.bytes();
  g.buffers = [{ byteLength: bin.length }];
  const glb = buildGlb(g, bin);
  const { json, bin: b } = parseGlb(glb);
  assert.throws(() => readAccessor(json, b, 0), GltfError);
  assert.ok(checkModel(glb, { kind: 'item' }).problems.some((p) => p.code === 'model.bounds'));
});

test('external buffers and images are refused', () => {
  const g = parseGlb(miniVrm());
  g.json.buffers.push({ uri: 'https://example.com/x.bin', byteLength: 4 });
  g.json.images = [{ uri: 'file:///etc/passwd' }];
  const p = checkModel(buildGlb(g.json, g.bin), { kind: 'vrm' }).problems.map((x) => x.code);
  assert.ok(p.filter((c) => c === 'model.external').length >= 2);
});

test('a VRM 0.x is refused with the reason', () => {
  const g = parseGlb(miniVrm());
  g.json.extensions = { VRM: { meta: {} } };
  assert.ok(checkModel(buildGlb(g.json, g.bin), { kind: 'vrm' }).problems.some((p) => p.code === 'model.vrm0'));
});

test('random damage to a GLB never throws (300 corrupted models)', () => {
  const good = miniVrm();
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 300; k++) {
    const b = good.slice();
    for (let i = 0; i < 1 + (k % 6); i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => checkModel(b, { kind: 'vrm' }));
  }
});
