// Fitting until Spec-fit exists (PRD FIT-3, FIT-4, FIT-6, CLO-6, CLO-7, CLO-11) and avatar.vrm drawn
// from the saved look (CLOSET.md C6, §4): on Spec, against spec.vrm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBundle, readBundle, writeBundle, checkBundle, readItem, writeItem, createItem, parseGlb, readAccessor, sha256, checkModel } from '../src/index.js';
import { newEdits, setEdits, bakeAvatar } from '../src/edit/index.js';
import { worldMatrix, parents } from '../src/math.js';
import {
  addItem, putOn, setState, setFitting, closetOf, prepareItemModel, fitPositions, drawAvatar, redrawAvatar, wornPieces, mergeWorn, decompose,
} from '../src/closet/index.js';
import { fixture, specVrm, noSpec, codes } from './helpers.mjs';

const META = { authors: ['Test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' };
const TOP = fixture('items/skinned-top.vrmxw');
const SWORD = fixture('items/state-sword.vrmxw');
const HAT = fixture('items/pinned-hat.vrmxw');
const topItem = await readItem(TOP);
const topModel = topItem.entries.get('model.glb');
const TOP_ID = topItem.manifest.id;
const SWORD_ID = (await readItem(SWORD)).manifest.id;

const meshOf = (json, id) => json.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.mesh != null && n.extras?.vrmxaFit?.item === id);
function positions(json, bin, id) {
  const out = [];
  for (const { n } of meshOf(json, id)) for (const p of json.meshes[n.mesh].primitives) out.push(...readAccessor(json, bin, p.attributes.POSITION));
  return out;
}
const bbox = (pos) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { const a = i % 3; lo[a] = Math.min(lo[a], pos[i]); hi[a] = Math.max(hi[a], pos[i]); }
  return { lo, hi };
};
const boneY = (json, bone) => worldMatrix(json.nodes, json.extensions.VRMC_vrm.humanoid.humanBones[bone].node, parents(json.nodes))[13];

async function dressed(spec, wear = [], edits = null) {
  const b = createBundle({ avatar: spec });
  for (const [bytes, opts] of wear) {
    const { id } = await addItem(b, bytes);
    await putOn(b, id, opts || {});
  }
  if (edits) {
    const { setDocument } = await import('../src/index.js');
    setDocument(b, 'edits', edits);
  }
  return b;
}

test('the fine-tuning formula', () => {
  const pos = [1, 2, 3, -1, 0, 1];
  const nrm = [0, 1, 0, 0, 0, 1];
  const out = fitPositions(pos, nrm, { loose: 0.01, size: 1.1, up: 0.02, right: 0.01, forward: -0.005 }, [0, 1, 2]);
  // p' = centre + (p + n·loose − centre)·size + (−right, up, forward)
  const exp = [0 + (1 - 0) * 1.1 - 0.01, 1 + (2.01 - 1) * 1.1 + 0.02, 2 + (3 - 2) * 1.1 - 0.005, 0 + (-1) * 1.1 - 0.01, 1 + (0 - 1) * 1.1 + 0.02, 2 + (1.01 - 2) * 1.1 - 0.005];
  out.forEach((v, i) => assert.ok(Math.abs(v - exp[i]) < 1e-6, `${i}: ${v} vs ${exp[i]}`));
  // a move in the model's space is turned into a rotated mesh's space
  const turned = fitPositions([0, 0, 0], null, { up: 0.01 }, [0, 0, 0], [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  assert.ok(Math.abs(turned[0] - 0.01) < 1e-9 && Math.abs(turned[1]) < 1e-9);
  const d = decompose([0.7071068, 0.7071068, 0, 0, -0.7071068, 0.7071068, 0, 0, 0, 0, 1, 0, 0.12, 0.05, -0.16, 1]);
  assert.deepEqual(d.translation, [0.12, 0.05, -0.16]);
  assert.ok(Math.abs(d.rotation[2] - Math.sin(Math.PI / 8)) < 1e-6);
});

test('no change on Spec: a worn item in avatar.vrm sits exactly where its model puts it (VRMXW §13)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await dressed(spec, [[TOP]]);
  const { bytes, methods } = await drawAvatar(b, { spec });
  assert.equal(methods[TOP_ID], 'spec-fit'); // a top is fitted by Spec-fit (FITTING.md §5; phase 5), a no-op on Spec
  const a = parseGlb(bytes), it = parseGlb(topModel);
  const got = positions(a.json, a.bin, TOP_ID);
  const want = it.json.meshes[0].primitives.flatMap((p) => [...readAccessor(it.json, it.bin, p.attributes.POSITION)]);
  assert.equal(got.length, want.length);
  let worst = 0;
  for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  assert.ok(worst < 1e-6, `moved ${worst} m`);
  assert.deepEqual(checkModel(bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
});

test('bones: a worn top follows the edited body; a pinned hat follows its bone (FIT-3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const edits = setEdits(newEdits(), [['body.height', 1], ['body.shoulderWidth', 1]]);
  const plain = parseGlb((await drawAvatar(await dressed(spec, [[TOP], [HAT]]), { spec })).bytes);
  const tall = parseGlb((await drawAvatar(await dressed(spec, [[TOP], [HAT]], edits), { spec })).bytes);
  const p = bbox(positions(plain.json, plain.bin, TOP_ID)), t = bbox(positions(tall.json, tall.bin, TOP_ID));
  const chestRise = boneY(tall.json, 'upperChest') - boneY(plain.json, 'upperChest');
  assert.ok(chestRise > 0.05, `the chest rose ${chestRise}`);
  assert.ok(Math.abs((t.hi[1] - p.hi[1]) - chestRise) < 0.03, `the top's collar rose ${t.hi[1] - p.hi[1]} with the chest ${chestRise}`);
  // the hat is a child of the head bone and rides it
  const hatId = (await readItem(HAT)).manifest.id;
  const hatNode = (j) => meshOf(j, hatId)[0].i;
  const hatY = (j) => worldMatrix(j.nodes, hatNode(j), parents(j.nodes))[13];
  const headRise = boneY(tall.json, 'head') - boneY(plain.json, 'head');
  assert.ok(Math.abs((hatY(tall.json) - hatY(plain.json)) - headRise) < 1e-4);
});

test('fine-tuning is written into avatar.vrm, never into the item (CLO-7)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await dressed(spec, [[TOP]]);
  const base = bbox(positions(...Object.values(parseGlb((await drawAvatar(b, { spec })).bytes)).slice(0, 2), TOP_ID));
  await setFitting(b, TOP_ID, { adjust: { size: 1.1, up: 0.01 } });
  const a = parseGlb((await drawAvatar(b, { spec })).bytes);
  const t = bbox(positions(a.json, a.bin, TOP_ID));
  for (let ax = 0; ax < 3; ax++) {
    const w0 = base.hi[ax] - base.lo[ax], w1 = t.hi[ax] - t.lo[ax];
    assert.ok(Math.abs(w1 / w0 - 1.1) < 0.002, `axis ${ax} grew ${w1 / w0}`);
  }
  const mid = (x) => (x.lo[1] + x.hi[1]) / 2;
  assert.ok(Math.abs(mid(t) - mid(base) - 0.01) < 1e-4);
  const kept = await readItem(b.entries.get(closetOf(b).items[0].file));
  assert.equal(await sha256(kept.entries.get('model.glb')), await sha256(topModel));
});

test('a pinned item\'s state moves it to its bone and placement (CLO-6, VRMXW §8)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await dressed(spec, [[SWORD, { state: 'stowed' }]]);
  const parentName = (j) => { const i = meshOf(j, SWORD_ID)[0].i; return j.nodes.find((n) => (n.children || []).includes(i)).name; };
  let a = parseGlb((await drawAvatar(b, { spec })).bytes).json;
  assert.equal(parentName(a), 'J_Bip_C_UpperChest');
  const n = a.nodes[meshOf(a, SWORD_ID)[0].i];
  assert.ok(Math.abs(n.rotation[2] - Math.sin(Math.PI / 8)) < 1e-5, 'turned 45° as the state matrix says');
  assert.deepEqual(n.translation.map((v) => Math.round(v * 1000) / 1000), [0.12, 0.05, -0.16]);
  await setState(b, SWORD_ID, 'held');
  a = parseGlb((await drawAvatar(b, { spec })).bytes).json;
  assert.equal(parentName(a), 'J_Bip_R_Hand');
});

test('a state\'s shown meshes: a hidden mesh and the spring chain it alone uses are left out (VRMXW §8, §8.1)', async () => {
  const states = [{ name: 'on', tags: [], show: [8] }, { name: 'packed', tags: [], show: [] }];
  const manifest = { ...topItem.manifest, states };
  const on = prepareItemModel(topModel, manifest, { state: 'on' });
  assert.equal(on.json.nodes[8].mesh, 0);
  assert.equal(on.json.extensions.VRMC_springBone.springs.length, 1);
  const packed = prepareItemModel(topModel, manifest, { state: 'packed' });
  assert.equal(packed.json.nodes[8].mesh, undefined);
  assert.deepEqual(packed.hidden, [8]);
  assert.equal(packed.json.extensions.VRMC_springBone.springs.length, 0);
  // morph targets by name: none in the fixtures, so a state without them changes nothing
  assert.equal(on.json.meshes[0].weights, undefined);
});

test('worn shoes raise the whole figure by their lift (CLO-11, VRMXW §7.1)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const shoes = await writeItem(await createItem({ model: topModel, name: 'Test shoes', type: 'shoes', lift: 0.025, rig: topItem.manifest.rig, meta: META }));
  const bare = parseGlb((await drawAvatar(await dressed(spec, []), { spec })).bytes).json;
  const r = await drawAvatar(await dressed(spec, [[shoes]]), { spec });
  assert.equal(r.lift, 0.025);
  const shod = parseGlb(r.bytes).json;
  for (const bone of ['hips', 'head', 'leftFoot']) assert.ok(Math.abs(boneY(shod, bone) - boneY(bare, bone) - 0.025) < 1e-5, `${bone} raised`);
});

test('layer order: inner items are merged first (FIT-4, FITTING.md §5.5)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const coat = await writeItem(await createItem({ model: topModel, name: 'Test coat', type: 'coat', layer: 1, rig: topItem.manifest.rig, meta: META }));
  const coatId = (await readItem(coat)).manifest.id;
  const b = createBundle({ avatar: spec });
  await addItem(b, coat); await addItem(b, TOP);
  await putOn(b, coatId); await putOn(b, TOP_ID); // worn order: coat, then top
  const w = await wornPieces(b);
  assert.deepEqual(w.items.map((x) => x.id), [TOP_ID, coatId]);
  const j = parseGlb((await drawAvatar(b, { spec })).bytes).json;
  assert.ok(meshOf(j, TOP_ID)[0].i < meshOf(j, coatId)[0].i);
});

test('avatar.vrm redrawn: avatar.of names the real closet, no stale warning; springs, colliders and licences carried (C6)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await readBundle(fixture('characters/full.vrmxa'));
  const before = await checkBundle(fixture('characters/full.vrmxa'));
  assert.ok(codes(before, 'warning').includes('bundle.avatar-stale'));
  const r = await redrawAvatar(b, { spec });
  const bytes = await writeBundle(b);
  const problems = await checkBundle(bytes, { spec });
  assert.deepEqual(codes(problems), []);
  assert.ok(!codes(problems, 'warning').includes('bundle.avatar-stale'));
  const again = await readBundle(bytes);
  assert.equal(again.manifest.avatar.of.closet, await sha256(again.entries.get('closet/closet.json')));
  assert.notEqual(again.manifest.avatar.of.closet, null);
  const j = parseGlb(r.bytes).json;
  const sb = j.extensions.VRMC_springBone;
  const ribbon = sb.springs.find((s) => s.name === 'FixtureRibbon');
  assert.ok(ribbon, 'the top\'s spring came with it');
  assert.ok(ribbon.joints.every((jt) => j.nodes[jt.node].name.startsWith('J_Sec_Ribbon')));
  assert.ok(sb.colliderGroups.some((g) => g.name === 'FixtureBack'));
  assert.deepEqual(j.extras.vrmxaPieces.map((p) => [p.name, p.state ?? null]), [['Fixture top', null], ['Fixture sword', 'stowed']]);
  assert.deepEqual(j.extras.vrmxaPieces[0].meta.authors, ['Xocialize LLC']);
});

test('the live view\'s model: Spec with the pieces merged and marked, nothing else applied', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await dressed(spec, [[TOP], [SWORD, { state: 'stowed' }]]);
  await setFitting(b, TOP_ID, { adjust: { size: 1.1 } });
  const w = await wornPieces(b, { adjust: false });
  const j = parseGlb(mergeWorn(spec, w));
  const it = parseGlb(topModel);
  const got = positions(j.json, j.bin, TOP_ID);
  const want = readAccessor(it.json, it.bin, it.json.meshes[0].primitives[0].attributes.POSITION);
  assert.ok(Math.abs(got[0] - want[0]) < 1e-7, 'the fine-tuning is left to the live view');
  const mark = j.json.nodes[meshOf(j.json, TOP_ID)[0].i].extras.vrmxaFit;
  assert.equal(mark.item, TOP_ID);
  assert.equal(mark.centre.length, 3);
  // the same formula on the marked centre gives what the bake writes
  const baked = parseGlb((await drawAvatar(b, { spec })).bytes);
  const ref = positions(baked.json, baked.bin, TOP_ID);
  const nrm = readAccessor(it.json, it.bin, it.json.meshes[0].primitives[0].attributes.NORMAL);
  const live = fitPositions(want, nrm, { size: 1.1 }, mark.centre);
  for (let i = 0; i < 30; i++) assert.ok(Math.abs(live[i] - ref[i]) < 1e-6);
  assert.ok(bakeAvatar); // (bakeAvatar is what drawAvatar calls)
});
