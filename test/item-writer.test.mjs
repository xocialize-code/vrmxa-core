// The one item writer (ITM-2): toon materials and springs survive, the skeleton is pruned, and a
// pinned item sits where it sat on Spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlb, readAccessor } from '../src/glb.js';
import { extractItemModel, metaFromVrm } from '../src/item-writer.js';
import { checkModel } from '../src/checker.js';
import { invert, multiply, parents, transformPoint, worldMatrix } from '../src/math.js';
import { dressSpec } from '../scripts/lib/dress.mjs';
import { SPEC_DIR, noSpec, specVrm } from './helpers.mjs';

const dressed = () => {
  const s = parseGlb(specVrm());
  const m = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
  return dressSpec(JSON.parse(JSON.stringify(s.json)), s.bin, m);
};

test('a skinned item keeps MToon, its texture, its spring and its collider', { skip: noSpec }, () => {
  const d = dressed();
  const r = extractItemModel(d, { prims: d.parts.top, kind: 'worn', name: 'Top' });
  const { json } = parseGlb(r.glb);
  assert.deepEqual(checkModel(r.glb, { kind: 'item' }).problems, []);
  assert.ok(json.extensionsUsed.includes('VRMC_materials_mtoon'));
  assert.ok(json.materials.every((m) => m.extensions?.VRMC_materials_mtoon), 'every material is still MToon');
  const src = d.json.materials.find((m) => m.name === 'Fixture_Top_00_CLOTH');
  const out = json.materials.find((m) => m.name === 'Fixture_Top_00_CLOTH');
  assert.deepEqual(out.extensions.VRMC_materials_mtoon.shadeColorFactor, src.extensions.VRMC_materials_mtoon.shadeColorFactor);
  assert.equal(json.images.length, 1, 'the texture shared by two slots of one material is copied once');
  assert.equal(r.springs, 1);
  assert.equal(r.colliders, 1);
  const sb = json.extensions.VRMC_springBone;
  assert.equal(sb.springs[0].joints.length, 3);
  assert.equal(sb.colliders[0].node, r.rig.humanBones.spine, 'the collider stays on the spine');
  assert.ok(!json.extensions.VRMC_vrm, 'an item model has no VRMC_vrm');
  assert.ok(!json.asset.extras, 'no metadata in the model (W2)');
});

test('the skeleton is pruned and each skin lists only joints that carry weight', { skip: noSpec }, () => {
  const d = dressed();
  const r = extractItemModel(d, { prims: d.parts.top, kind: 'worn' });
  const { json } = parseGlb(r.glb);
  assert.ok(json.nodes.length < d.json.nodes.length);
  assert.deepEqual(Object.keys(r.rig.humanBones), ['hips', 'spine', 'chest', 'upperChest']);
  assert.equal(json.skins[0].joints.length, 7, 'four humanoid bones and three ribbon bones');
});

test('humanoid joints are bound where Spec binds them (VRMXW §5.3 rule 4)', { skip: noSpec }, () => {
  const d = dressed();
  const r = extractItemModel(d, { prims: d.parts.top, kind: 'worn' });
  const { json, bin } = parseGlb(r.glb);
  const ibm = readAccessor(json, bin, json.skins[0].inverseBindMatrices);
  const spec = parseGlb(specVrm());
  const hb = spec.json.extensions.VRMC_vrm.humanoid.humanBones;
  const pOf = parents(spec.json.nodes);
  for (const [bone, n] of Object.entries(r.rig.humanBones)) {
    const slot = json.skins[0].joints.indexOf(n);
    const bind = invert([...ibm.subarray(slot * 16, slot * 16 + 16)]);
    const rest = worldMatrix(spec.json.nodes, hb[bone].node, pOf);
    for (const k of [12, 13, 14]) assert.ok(Math.abs(bind[k] - rest[k]) < 1e-5, `${bone} is where Spec has it`);
  }
});

test('a pinned item is a child of its bone, unskinned, placed exactly as on Spec', { skip: noSpec }, () => {
  const d = dressed();
  for (const [part, bone] of [['sword', 'rightHand'], ['hat', 'head']]) {
    const r = extractItemModel(d, { prims: d.parts[part], kind: 'pin', attach: bone });
    const { json, bin } = parseGlb(r.glb);
    assert.ok(!json.skins, 'no skin');
    const meshNode = json.nodes.findIndex((n) => n.mesh !== undefined);
    const pOf = parents(json.nodes);
    assert.equal(pOf.get(meshNode), r.rig.humanBones[bone]);
    // the first vertex, in the item's world, equals the same vertex in the dressed source
    const p = readAccessor(json, bin, json.meshes[0].primitives[0].attributes.POSITION);
    const world = transformPoint(worldMatrix(json.nodes, meshNode, pOf), [p[0], p[1], p[2]]);
    const srcMesh = d.parts[part][0][0];
    const srcNode = d.json.nodes.findIndex((n) => n.mesh === srcMesh);
    const sp = readAccessor(d.json, d.bin, d.json.meshes[srcMesh].primitives[0].attributes.POSITION);
    const srcWorld = d.json.nodes[srcNode].skin !== undefined ? [sp[0], sp[1], sp[2]] : transformPoint(worldMatrix(d.json.nodes, srcNode), [sp[0], sp[1], sp[2]]);
    world.forEach((v, k) => assert.ok(Math.abs(v - srcWorld[k]) < 1e-5, `${part}: vertex ${k}`));
  }
});

test('the licence block comes from the source VRM, less what does not apply to an item', { skip: noSpec }, () => {
  const meta = metaFromVrm(parseGlb(specVrm()).json);
  assert.deepEqual(meta.authors, ['Xocialize']);
  assert.ok(!('name' in meta) && !('avatarPermission' in meta) && !('thumbnailImage' in meta));
});

test('bad requests are refused with a reason', { skip: noSpec }, () => {
  const d = dressed();
  assert.throws(() => extractItemModel(d, { prims: d.parts.sword, kind: 'worn' }), /must be skinned/);
  assert.throws(() => extractItemModel(d, { prims: [[99, 0]] }), /does not exist/);
  assert.throws(() => extractItemModel(d, { prims: d.parts.sword, kind: 'pin', attach: 'tail' }), /no humanoid bone/);
});
