// Suitability (the Quick Look 3D preview's advice): each check with its reason, and the one-line verdict, from the
// importer's own judgement. Spec dressed by the fixtures' generator is the good case; the same body with its arms
// lowered, with no clothes, and with a licence that forbids changes are the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlb, buildGlb } from '../src/glb.js';
import { suitability, verdictOf, armAngles } from '../src/import/index.js';
import { dressSpec } from '../scripts/lib/dress.mjs';
import { SPEC_DIR, noSpec, specVrm } from './helpers.mjs';

const dressed = () => {
  const s = parseGlb(specVrm());
  const m = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
  return dressSpec(JSON.parse(JSON.stringify(s.json)), s.bin, m);
};
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

// the upper arms turned down by `deg` about Z (an A-pose), on the nodes themselves: the rest pose changes
function lowered(json, deg) {
  const j = JSON.parse(JSON.stringify(json));
  const hb = j.extensions.VRMC_vrm.humanoid.humanBones;
  for (const [bone, sign] of [['leftUpperArm', -1], ['rightUpperArm', 1]]) {
    const n = j.nodes[hb[bone].node];
    const a = (sign * deg * Math.PI) / 180;
    n.rotation = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
  }
  return j;
}

test('a dressed body in a T-pose with whole skin, close to Spec, and a licence that allows changes is a good candidate', { skip: noSpec }, async () => {
  const d = dressed();
  const r = await suitability(buildGlb(d.json, d.bin), { spec: specVrm(), fileName: 'dressed.vrm' });
  const c = byId(r);
  assert.equal(r.vrm, '1.0');
  assert.equal(c.version.level, 'good');
  assert.equal(c.pose.level, 'good');
  assert.equal(c.garments.level, 'good');
  assert.match(c.garments.title, /separate garment/);
  assert.equal(c.skin.level, 'good');
  assert.equal(c.proportions.level, 'good');
  assert.ok(c.licence);
  assert.ok(r.groups.some((g) => g.garment && g.verdict), 'each garment has its Spec-fit verdict');
  assert.ok(r.body.length > 0, 'the body pieces are listed apart');
  assert.ok(r.groups.every((g) => g.pieces.every((p) => /^\d+\/\d+$/.test(p))), 'pieces are the stage\'s "mesh/primitive" ids');
  assert.notEqual(r.verdict.level, 'unsuitable');
  for (const x of r.checks) assert.ok(x.text.length > 20 && /[.)]$/.test(x.text), `${x.id} says why in a sentence: ${x.text}`);
});

test('arms lowered 40° is not a T-pose: a problem, and at best a partial candidate', { skip: noSpec }, async () => {
  const d = dressed();
  const json = lowered(d.json, 40);
  const a = armAngles(json);
  assert.ok(a.left > 35 && a.right > 35, `both arms measured down: ${JSON.stringify(a)}`);
  const r = await suitability(buildGlb(json, d.bin), { spec: specVrm(), fileName: 'a-pose.vrm', verdicts: false });
  const c = byId(r);
  assert.equal(c.pose.level, 'problem');
  assert.match(c.pose.text, /T-pose/);
  assert.equal(r.verdict.level, 'partial');
  assert.match(r.verdict.text, /T-pose/);
});

test('Spec unclothed has no pieces: not suitable', { skip: noSpec }, async () => {
  const r = await suitability(specVrm(), { spec: specVrm(), fileName: 'spec.vrm' });
  assert.equal(byId(r).garments.level, 'problem');
  assert.equal(r.verdict.level, 'unsuitable');
});

test('a licence that forbids changes is a caveat on the verdict, not a refusal (the importer asks first: HON-1)', { skip: noSpec }, async () => {
  const d = dressed();
  const json = JSON.parse(JSON.stringify(d.json));
  Object.assign(json.extensions.VRMC_vrm.meta, { modification: 'prohibited', allowRedistribution: false, commercialUsage: 'personalNonProfit' });
  const r = await suitability(buildGlb(json, d.bin), { spec: specVrm(), fileName: 'strict.vrm', verdicts: false });
  const c = byId(r);
  assert.equal(c.licence.title, 'No changes allowed');
  assert.equal(c.licence.level, 'note');
  assert.match(c.licence.text, /asks you first/);
  assert.notEqual(r.verdict.level, 'unsuitable');
  assert.match(r.verdict.text, /doesn't allow changes/);
});

test('without Spec, the checks that need it say they were not run', { skip: noSpec }, async () => {
  const d = dressed();
  const r = await suitability(buildGlb(d.json, d.bin), { spec: null, fileName: 'dressed.vrm' });
  const c = byId(r);
  assert.equal(c.skin.level, 'note');
  assert.match(c.skin.text, /isn't available/);
  assert.equal(c.proportions, undefined);
  assert.match(c.fit.text, /wasn't tried/);
  assert.equal(r.verdict.level, 'good');
  assert.match(r.verdict.text, /wasn't tried/);
});

test('the verdict: no pieces at all is unsuitable; painted-on clothes with hair is partial', () => {
  assert.equal(verdictOf([], [], []).level, 'unsuitable');
  const v = verdictOf([{ id: 'garments', level: 'problem', title: 'No separate garments', text: '' }], [], [{ name: 'Hair' }, { name: 'Shoes' }]);
  assert.equal(v.level, 'partial');
  assert.match(v.text, /painted on, so only hair and shoes would come in/);
});

// A local copy of a VRoid Hub model, when VRMXA_DATASET_DIR names the folder of such copies (never in this repository).
const DATASET = join(process.env.VRMXA_DATASET_DIR || '/nonexistent', 'vroid/0/535847299517724940/535847299517724940.vrm');
test('a VRoid 0.x from the dataset: converted, in a T-pose, skin cut away under the clothes, garments judged', { skip: noSpec || (!existsSync(DATASET) && 'set VRMXA_DATASET_DIR to run it') }, async () => {
  const r = await suitability(new Uint8Array(readFileSync(DATASET)), { spec: specVrm(), fileName: 'dataset.vrm' });
  const c = byId(r);
  assert.equal(r.vrm, '0.x');
  assert.equal(c.version.level, 'note');
  assert.equal(c.pose.level, 'good');
  assert.equal(c.skin.title, 'Skin cut away');
  assert.ok(r.groups.filter((g) => g.verdict).length >= 2);
  assert.ok(r.ms.open + r.ms.fit + r.ms.verdicts < 5000, `within a preview's time: ${JSON.stringify(r.ms)}`);
});
