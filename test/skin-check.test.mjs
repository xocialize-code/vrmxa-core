// Finding body skin on an imported model (src/measure/skinCheck.js through donorParts.js): Spec with
// meaningless names still has its body skin, face skin and eyes found by their shape; Spec dressed in
// generated clothes (scripts/lib/dress.mjs) never has the clothes counted as skin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, buildGlb } from '../src/glb.js';
import { guessDonorParts, vroidMaterial, partSets } from '../src/measure/donorParts.js';
import { findSkinParts, SKIN_CHECK } from '../src/measure/skinCheck.js';
import { measureBody } from '../src/measure/bodyMeasure.js';
import { measureVrm } from '../src/measure/measure.js';
import { readSkin } from '../src/fit/body.js';
import { dressSpec } from '../scripts/lib/dress.mjs';
import { specVrm, noSpec } from './helpers.mjs';

const P = SKIN_CHECK;
// Spec's parts by its own names: 3 face skin, 7 body skin, 1 iris
const SPEC_ROLES = { 3: 'face', 7: 'body', 1: 'eyes' };

// a copy of Spec with meaningless material, mesh and node names (so no name can help)
function renamedSpec() {
  const g = parseGlb(specVrm());
  g.json.materials.forEach((m, i) => { m.name = `M${(i * 7919) % 97}`; });
  g.json.meshes.forEach((m, i) => { m.name = `G${i}`; });
  g.json.nodes.forEach((n, i) => { if (n.mesh != null) n.name = `N${i}`; });
  return { ...g, bytes: buildGlb(g.json, g.bin) };
}

// a part that isn't skin must miss at least one of the rules clearly
function clearlyNotSkin(p) {
  const e = p.evidence;
  return p.score <= P.threshold - 0.05 || e.coverage <= P.minCoverage / 2 || e.normal <= P.minNormal - 0.05;
}

test('the VRoid name pattern takes the forms VRoid writes (with and without a variant, a numbered kind, a two-word part)', () => {
  const cases = {
    'N00_000_00_Face_00_SKIN (Instance)': ['Face', 'face'], 'F00_000_Face_00_SKIN': ['Face', 'face'], 'M00_000_Body_00_SKIN(Clone)': ['Body', 'body'],
    'N00_000_00_EyeIris_00_EYE (Instance)': ['EyeIris', 'eyes'], 'N00_000_Hair_00_HAIR_01 (Instance)': ['Hair', 'ignore'],
    'N00_000_00_Tops_01_CLOTH_02 (Instance)': ['Tops', 'ignore'], 'N00_000_00_Accessory_Tie_00_CLOTH': ['Accessory_Tie', 'ignore'],
  };
  for (const [name, [part, role]] of Object.entries(cases)) {
    const v = vroidMaterial(name);
    assert.ok(v, name);
    assert.equal(v.part, part, name);
    assert.equal(v.role, role, name);
  }
  for (const name of ['Material.001', 'Skin_Body', 'xN00_000_00_Body_00_SKIN', 'N00_000_00_Body_00_Mixedcase']) assert.equal(vroidMaterial(name), null, name);
});

test('Spec with meaningless names: its body skin, face skin and eyes are found by shape alone', { skip: noSpec }, (t) => {
  const r = renamedSpec();
  const base = parseGlb(specVrm());
  const res = findSkinParts(r.json, r.bin, base, { names: false });
  for (const p of res.parts) {
    t.diagnostic(`${p.material} ${p.role} score ${p.score} ${JSON.stringify(p.evidence)}`);
    assert.equal(p.role, SPEC_ROLES[p.material] || 'ignore', `material ${p.material}`);
    if (p.role === 'face' || p.role === 'body') assert.ok(p.score >= P.threshold + 0.15, `skin ${p.material} by a margin: ${p.score}`);
    else assert.ok(clearlyNotSkin(p), `material ${p.material} is clearly not skin: ${JSON.stringify(p)}`);
  }
  // through the library's own entry point (the names say nothing VRoid, so Spec decides)
  const g = guessDonorParts(r.json, r.bin, { base });
  assert.equal(g.method, 'geometry');
  assert.equal(g.vroid, false);
  const sets = partSets(g.parts);
  assert.deepEqual([...sets.skinMats], [3]);
  assert.deepEqual([...sets.bodyMats], [7]);
  assert.deepEqual([...sets.irisMats], [1]);
  // without Spec, the names alone decide (and meaningless names find nothing): the old behaviour
  assert.equal(guessDonorParts(r.json, r.bin).method, 'names');
});

test('Spec with meaningless names, measured with Spec as the base, gives Spec\'s own measurements exactly', { skip: noSpec }, async () => {
  const r = renamedSpec();
  const spec = specVrm();
  const named = await measureVrm(spec, { file: 'spec.vrm' });
  const byShape = await measureVrm(r.bytes, { file: 'spec.vrm', base: spec });
  const { source: a, ...mine } = byShape;
  const { source: b, ...theirs } = named;
  assert.equal(JSON.stringify(mine), JSON.stringify(theirs));
  assert.equal(await measureVrm(r.bytes, { file: 'spec.vrm' }), null, 'without Spec there is no skin to measure');
  // Spec-fit reads the skin found: the body and face skin, as when those parts are given by hand
  const skin = readSkin(r.json, r.bin, { base: parseGlb(spec) });
  const given = readSkin(r.json, r.bin, { bodyMats: new Set([3, 7]) });
  assert.equal(JSON.stringify(skin.tris), JSON.stringify(given.tris));
});

test('Spec dressed in generated clothes: the clothes, hat and props are never counted as skin', { skip: noSpec }, (t) => {
  const g = parseGlb(specVrm());
  const dressed = dressSpec(g.json, g.bin, measureBody(g.json, g.bin));
  const base = parseGlb(specVrm());
  for (const names of [false, true]) {
    const res = findSkinParts(dressed.json, dressed.bin, base, { names });
    const fixtures = res.parts.filter((p) => p.name.startsWith('Fixture_'));
    assert.equal(fixtures.length, 5);
    for (const p of fixtures) {
      t.diagnostic(`names ${names}: ${p.name} ${p.role} score ${p.score} ${JSON.stringify(p.evidence)}`);
      assert.equal(p.role, 'ignore', p.name);
      assert.ok(clearlyNotSkin(p), `${p.name} by a margin`);
    }
    // the top lies 6 mm off the skin and agrees with it in distance and normals: only the innermost test
    // and coverage keep it out
    const top = fixtures.find((p) => p.name === 'Fixture_Top_00_CLOTH');
    assert.ok(top.evidence.near > 0.95 && top.evidence.inner < 0.15, JSON.stringify(top.evidence));
    assert.ok(top.score <= P.threshold - 0.1, `top score ${top.score}`);
    // and Spec's own skin is still found under the clothes
    assert.equal(res.parts.find((p) => p.material === 7).role, 'body');
    assert.equal(res.parts.find((p) => p.material === 3).role, 'face');
  }
});

test('the skin check is deterministic: the same model gives the same parts, byte for byte', { skip: noSpec }, () => {
  const r = renamedSpec();
  const run = () => JSON.stringify(findSkinParts(r.json, r.bin, parseGlb(specVrm()), { names: false }));
  assert.equal(run(), run());
});
