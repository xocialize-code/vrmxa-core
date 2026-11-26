// Phase 0: the measurer brought into the package reproduces the published measurements of Spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureVrm } from '../src/index.js';
import { findSpecDir } from '../src/node/spec.js';

const dir = findSpecDir();

test('measuring spec.vrm reproduces spec.measurements.json exactly (apart from the source record)', { skip: !dir && 'spec.vrm not found (set VRMXA_SPEC_DIR)' }, async () => {
  const bytes = readFileSync(join(dir, 'spec.vrm'));
  const m = await measureVrm(bytes, { file: 'spec.vrm' });
  const ref = JSON.parse(readFileSync(join(dir, 'spec.measurements.json'), 'utf8'));
  assert.equal(m.source.sha256, ref.source.sha256);
  const { source: a, ...mine } = m;
  const { source: b, ...theirs } = ref;
  // compared as the published file writes it, so key order and every rounded value count
  assert.equal(JSON.stringify(mine, null, 1), JSON.stringify(theirs, null, 1));
});

// FITTING.md §9 "Shoe lift", §11 question 4 (decided 2026-11-17): heights are barefoot; the lift taken out is reported
test('a figure raised by its shoes is measured barefoot, and the lift is reported; one on the floor keeps its heights', { skip: !dir && 'spec.vrm not found (set VRMXA_SPEC_DIR)' }, async (t) => {
  const { parseGlb } = await import('../src/glb.js');
  const { readBody, measureBody, shoeLift } = await import('../src/measure/bodyMeasure.js');
  const g = parseGlb(new Uint8Array(readFileSync(join(dir, 'spec.vrm'))));
  const base = measureBody(g.json, g.bin);
  assert.equal(base.lengths.lift, undefined); // Spec stands on the floor: nothing taken out, nothing reported
  // Spec raised 31.3 mm, every joint and skin vertex (as Elena is: VRoid raises a figure in shoes by its sole)
  const raise = (L, skinToo = true) => {
    const b = readBody(g.json, g.bin);
    const verts = Float32Array.from(b.verts);
    if (skinToo) for (let i = 1; i < verts.length; i += 3) verts[i] += L;
    const joints = Object.fromEntries(Object.entries(b.joints).map(([k, p]) => [k, [p[0], p[1] + L, p[2]]]));
    return { ...b, verts, joints };
  };
  const up = measureBody(null, null, { body: raise(0.0313) });
  t.diagnostic(`raised 31.3 mm: lift ${up.lengths.lift}, stature ${up.lengths.stature} (Spec ${base.lengths.stature}), crotch ${up.lengths.crotchHeight} (${base.lengths.crotchHeight})`);
  assert.ok(Math.abs(up.lengths.lift - 0.0313) < 2e-4, `lift ${up.lengths.lift}`);
  for (const k of ['stature', 'crotchHeight', 'kneeHeight', 'ankleHeight']) assert.ok(Math.abs(up.lengths[k] - base.lengths[k]) < 2e-4, `${k} ${up.lengths[k]} vs ${base.lengths[k]}`);
  assert.equal(up.lengths.ground, up.lengths.lift);
  // the stations stay where the body is (the fit works in station space; the importer takes the lift out itself)
  const bust = (m) => m.stations.find((s) => s.id === 'bust');
  assert.ok(Math.abs(bust(up).at - bust(base).at - 0.0313) < 2e-4);
  // the bones say "raised" but the skin stands on the floor (other proportions, barefoot): no lift
  assert.equal(shoeLift(raise(0.02, false).joints, 0), 0);
  const floor = measureBody(null, null, { body: raise(0.02, false) });
  assert.equal(floor.lengths.lift, undefined);
});
