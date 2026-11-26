// The item editor's library (PRD ITM-1 to ITM-12): states, tags, the licence and origin, animations, how it is
// worn, revisions and duplicates, each edit leaving the item valid and MToon and springs in place; and a plain
// model made wearable in four steps (ITM-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, buildGlb, readAccessor } from '../src/glb.js';
import { readItem, checkItem } from '../src/index.js';
import { parents, worldMatrix } from '../src/math.js';
import * as ed from '../src/item/index.js';
import { fixture, noSpec, specVrm } from './helpers.mjs';

const top = () => readItem(fixture('items/skinned-top.vrmxw'));
const sword = () => readItem(fixture('items/state-sword.vrmxw'));
const staff = () => readItem(fixture('items/animated-staff.vrmxw'));
const errors = async (it, spec) => (await checkItem((await ed.saveItem(it, { spec, bump: false })).bytes, { spec })).filter((p) => p.severity === 'error');

test('states: placement and bone for a pinned item, shown meshes and morphs for any, the first the default (ITM-5, VRMXW §8)', { skip: noSpec }, async () => {
  const spec = specVrm();
  let it = await sword();
  const bones = Object.keys(it.manifest.rig.humanBones);
  const other = bones.find((b) => b !== it.manifest.attach.bone);
  it = ed.addState(it, { name: 'drawn', tags: ['drawn:sword'] });
  it = ed.addState(it, { name: 'away', tags: ['stowed:sword'], bone: other, matrix: ed.stateMatrix({ move: [0, 0.1, -0.12], turn: [0, 0, 90] }) });
  assert.deepEqual(it.manifest.states.slice(-2).map((s) => s.name), ['drawn', 'away']);
  assert.throws(() => ed.addState(it, { name: 'held' }), /already a state/);
  assert.throws(() => ed.addState(it, { name: 'x', tags: ['Not A Tag'] }), /not a tag/);
  assert.throws(() => ed.addState(it, { name: 'x', bone: 'leftToes' }), /no leftToes bone/);
  it = ed.moveState(it, 'away', 0);
  assert.equal(it.manifest.states[0].name, 'away', 'made the default');
  it = ed.updateState(it, 'away', { name: 'on the back', matrix: null });
  assert.equal(it.manifest.states[0].matrix, undefined);
  assert.deepEqual(await errors(it, spec), []);
  // a worn item: split a part out and show it in one state only
  let t = await top();
  const meshes = ed.itemMeshes(t);
  const multi = meshes.find((m) => m.prims > 1);
  assert.ok(multi, 'the fixture top has a mesh of two primitives');
  const r = ed.splitMesh(t, multi.node, [1], { name: 'Ribbon' });
  t = r.item;
  assert.equal(ed.itemMeshes(t).length, meshes.length + 1);
  t = ed.addState(t, { name: 'with ribbon', show: [multi.node, r.node] });
  t = ed.addState(t, { name: 'no ribbon', show: [multi.node] });
  assert.throws(() => ed.addState(t, { name: 'bad', show: [999] }), /not one of the item's meshes/);
  assert.deepEqual(await errors(t, spec), []);
  const json = parseGlb(t.entries.get('model.glb')).json;
  assert.ok(json.materials.every((m) => m.extensions?.VRMC_materials_mtoon), 'MToon kept (ITM-2)');
  assert.ok(json.extensions.VRMC_springBone.springs.length, 'springs kept (ITM-2)');
  assert.equal(json.nodes[r.node].skin, json.nodes[multi.node].skin, 'the new part keeps the skin');
});

test('tags, licence, listing and origin: checked, never left invalid (ITM-7 to ITM-9, VRMXW §11)', async () => {
  let it = await top();
  it = ed.setTags(it, ['outfit:sailor', 'outfit:sailor', 'style:school']);
  assert.deepEqual(it.manifest.tags, ['outfit:sailor', 'style:school']);
  assert.throws(() => ed.setTags(it, ['sailor']), /not a tag/);
  it = ed.setMeta(it, { version: '2.0', commercialUsage: 'corporation', allowRedistribution: true, name: 'ignored' });
  assert.equal(it.manifest.meta.version, '2.0');
  assert.equal(it.manifest.meta.name, undefined, "VRM's name is the manifest's own (VRMXW §11)");
  assert.throws(() => ed.setMeta(it, { authors: [] }), /authors/);
  assert.throws(() => ed.setMeta(it, { licenseUrl: 'not a url' }), /licenseUrl/);
  assert.throws(() => ed.setMeta(it, { commercialUsage: 'everyone' }), /commercialUsage must be one of/);
  it = ed.setListing(it, { url: 'https://example.com/items/1', marketplace: 'Example', id: 'A-1', price: '9.99' });
  assert.deepEqual(it.manifest.listing, { url: 'https://example.com/items/1', marketplace: 'Example', id: 'A-1' }, 'no price');
  assert.throws(() => ed.setListing(it, { url: 'ftp://x' }), /http/);
  it = ed.setOrigin(it, { made: 'authored', note: 'kept' });
  assert.equal(it.manifest.origin.note, 'kept');
  assert.throws(() => ed.setOrigin(it, { made: 'stolen' }), /made is/);
  assert.deepEqual((await checkItem((await ed.saveItem(it, { bump: false })).bytes)).filter((p) => p.severity === 'error'), []);
});

test('how it is worn: type, slot and fit follow VRMXW §6; a pinned item moves to another bone and stays where it was (ITM-4)', { skip: noSpec }, async () => {
  const spec = specVrm();
  let t = await top();
  t = ed.setWear(t, { type: 'coat', layer: 1 });
  assert.deepEqual([t.manifest.type, t.manifest.slot, t.manifest.layer, t.manifest.fit.class, t.manifest.fit.ease], ['coat', 'outer', 1, 'top', 'relaxed']);
  assert.throws(() => ed.setWear(t, { type: 'hat' }), /pinned to a bone/);
  t = ed.setWear(t, { type: 'shoes', fit: { lift: 0.02 } });
  assert.equal(t.manifest.fit.lift, 0.02);
  assert.throws(() => ed.setWear(t, { fit: { lift: 3 } }), /lift/);
  // re-pin the sword: its world place on Spec is unchanged
  let s = await sword();
  const other = Object.keys(s.manifest.rig.humanBones).find((b) => b !== s.manifest.attach.bone && b !== 'hips');
  const worldOf = (it) => { const { json } = parseGlb(it.entries.get('model.glb')); const n = json.nodes.findIndex((x) => x.mesh !== undefined); return worldMatrix(json.nodes, n, parents(json.nodes)); };
  const before = worldOf(s);
  s = ed.repin(s, other);
  assert.equal(s.manifest.attach.bone, other);
  const after = worldOf(s);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(before[i] - after[i]) < 1e-5);
  assert.deepEqual(await errors(s, spec), []);
});

test('animations: clips the item brings and sets that require its tags (ITM-6, VRMXW §9)', async () => {
  let it = await staff();
  // the sword fixture already brings clips: replace its sets, then remove a clip
  const clips = it.manifest.animations.clips;
  assert.ok(clips.length >= 1);
  assert.throws(() => ed.setSets(it, [{ name: 'Loose', requires: ['nobody:has-this'], slots: { idle: [{ clip: clips[0].sha256 }] } }]), /must require one of the item's own tags/);
  const tag = ed.allTags(it.manifest)[0];
  it = ed.setSets(it, [{ name: 'Ready', requires: [tag], slots: { idle: [{ clip: clips[0].sha256 }] } }]);
  assert.equal(it.manifest.animations.sets.length, 1);
  assert.throws(() => ed.setSets(it, [{ name: 'Odd', requires: [tag], slots: { flying: [{ clip: clips[0].sha256 }] } }]), /not an animation slot/);
  const file = clips[0].file;
  it = ed.removeClip(it, clips[0].sha256);
  assert.ok(!it.entries.has(file), 'the clip file goes with it');
  assert.ok(!(it.manifest.animations?.sets || []).length, 'a set left empty goes too');
  assert.deepEqual((await checkItem((await ed.saveItem(it, { bump: false })).bytes)).filter((p) => p.severity === 'error'), []);
  // a clip that is not a .vrma is refused
  await assert.rejects(ed.addClip(it, new Uint8Array([1, 2, 3])), /can't be used/);
});

test('saving is the next revision, refused when invalid; a duplicate is a new item (ITM-10, ITM-12)', async () => {
  const it = await top();
  const r = await ed.saveItem(ed.setTags(it, ['outfit:sailor']));
  assert.equal(r.item.manifest.revision, it.manifest.revision + 1);
  assert.equal(r.item.manifest.id, it.manifest.id, 'the same item');
  const again = await readItem(r.bytes);
  assert.deepEqual(again.manifest.tags, ['outfit:sailor']);
  const broken = { ...it, manifest: { ...it.manifest, meta: { authors: [] } } };
  await assert.rejects(ed.saveItem(broken), /would not be valid/);
  const d = ed.duplicateAsNew(it);
  assert.notEqual(d.manifest.id, it.manifest.id);
  assert.equal(d.manifest.revision, 1);
  assert.match(d.manifest.name, /\(copy\)$/);
  assert.ok(ed.itemChanged(d, it));
  assert.ok(!ed.itemChanged(it, it));
});

test('movement: a spring chain\'s stiffness, weight and drag are set on its joints (ITM-3 step 4)', async () => {
  let it = await top();
  const springs = ed.itemSprings(it);
  assert.ok(springs.length >= 1);
  it = ed.setSpring(it, 0, { stiffness: 2.5, gravityPower: 0.1, dragForce: 0.8 });
  const s = ed.itemSprings(it)[0];
  assert.deepEqual([s.stiffness, s.gravityPower, s.dragForce], [2.5, 0.1, 0.8]);
  assert.throws(() => ed.setSpring(it, 99, {}), /no spring chain/);
});

// a plain model: a cylinder one unit tall, as a TRELLIS mesh arrives (at the origin, its own scale)
function cylinder() {
  const seg = 24, rings = 10, pos = [], idx = [];
  for (let r = 0; r <= rings; r++) for (let s = 0; s < seg; s++) { const a = (s / seg) * Math.PI * 2; pos.push(Math.cos(a) * 0.4, r / rings - 0.5, Math.sin(a) * 0.3); }
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) { const a = r * seg + s, b = r * seg + ((s + 1) % seg), c = a + seg, d = b + seg; idx.push(a, c, b, b, c, d); }
  const P = new Float32Array(pos), I = new Uint16Array(idx);
  const bin = new Uint8Array(P.byteLength + I.byteLength);
  bin.set(new Uint8Array(P.buffer), 0); bin.set(new Uint8Array(I.buffer), P.byteLength);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Shirt' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }], materials: [{ name: 'Cloth', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.5, 0.9, 1] } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: [-0.4, -0.5, -0.3], max: [0.4, 0.5, 0.3] }, { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }], buffers: [{ byteLength: bin.length }] };
  return buildGlb(json, bin);
}

test('four steps: a plain model is placed on Spec by its type, bound to the body\'s bones, and is a valid item (ITM-3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const s = ed.wearSpec(spec);
  const glb = cylinder();
  const info = ed.plainModelInfo(glb);
  assert.equal(info.triangles, 480);
  const place = ed.autoPlace(glb, 'top', s);
  const L = ed.specLandmarks(s);
  // its top lands at the shoulders and its bottom at the hips
  assert.ok(Math.abs(place.size - (L.shoulder - L.hips)) < 1e-3, `size ${place.size}`);
  const w = await ed.makeWearable(glb, s, { type: 'top', place, name: 'Plain shirt', meta: { authors: ['Test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' } });
  const torso = w.bones.filter((b) => ['hips', 'spine', 'chest', 'upperChest'].includes(b.bone)).reduce((a, b) => a + b.share, 0);
  assert.ok(torso > 0.7, `mostly the torso (${torso})`);
  assert.ok(!w.bones.some((b) => /LowerLeg|Foot/.test(b.bone) && b.share > 0.01), 'not the lower legs');
  const saved = await ed.saveItem(w.item, { spec, bump: false });
  assert.deepEqual(saved.problems.filter((p) => p.severity === 'error'), []);
  assert.equal(saved.item.manifest.type, 'top');
  // the item sits where Place put it: its box spans the hips to the shoulders
  const { json, bin } = parseGlb(saved.item.entries.get('model.glb'));
  const pos = readAccessor(json, bin, json.meshes[0].primitives[0].attributes.POSITION);
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
  assert.ok(Math.abs(hi - L.shoulder) < 2e-3 && Math.abs(lo - L.hips) < 2e-3, `${lo}..${hi}`);
  // "how closely it follows" changes the weights; the far side's arm never pulls
  const loose = ed.bindToSpec(glb, s, { type: 'top', place, follow: 0 });
  assert.notDeepEqual(loose.bones, w.bones);
  // a hat: pinned to the head, at the top of the head
  const hat = await ed.makeWearable(glb, s, { type: 'hat', place: ed.autoPlace(glb, 'hat', s), name: 'Plain hat', meta: { authors: ['Test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' } });
  assert.equal(hat.item.manifest.kind, 'pin');
  assert.equal(hat.item.manifest.attach.bone, 'head');
  assert.deepEqual((await ed.saveItem(hat.item, { spec, bump: false })).problems.filter((p) => p.severity === 'error'), []);
});

test('parts shown follow VRMXW §8: a part listed in no state is shown in all; hiding it in one state keeps the others as they were (ITM-5)', async () => {
  let t = await top();
  const body = ed.itemMeshes(t)[0].node;
  const r = ed.splitMesh(t, body, [1], { name: 'Ribbon' });
  t = r.item;
  const ribbon = r.node;
  t = ed.addState(t, { name: 'No ribbon' });
  assert.deepEqual([...ed.partsShown(t, 'No ribbon')].sort(), [body, ribbon].sort(), 'nothing listed: everything shown');
  assert.throws(() => ed.setPartShown(t, 'No ribbon', ribbon, false), /only one state/);
  t = ed.addState(t, { name: 'Tied' });
  t = ed.setPartShown(t, 'No ribbon', ribbon, false);
  assert.deepEqual([...ed.partsShown(t, 'No ribbon')], [body]);
  assert.deepEqual([...ed.partsShown(t, 'Tied')].sort(), [body, ribbon].sort(), 'the other state keeps the ribbon');
  assert.deepEqual(t.manifest.states.map((s) => s.show), [[], ['Ribbon']], 'the body is shown everywhere, so listed nowhere; parts by name (#44)');
  assert.throws(() => ed.setPartShown(t, 'Tied', ribbon, false), /shown in no state/);
  t = ed.setPartShown(t, 'No ribbon', ribbon, true);
  assert.ok(t.manifest.states.every((s) => s.show === undefined), 'shown everywhere again: no lists');
  // the model the closet fits shows what partsShown says
  const { prepareItemModel } = await import('../src/closet/fit.js');
  t = ed.setPartShown(t, 'No ribbon', ribbon, false);
  const p = prepareItemModel(t.entries.get('model.glb'), t.manifest, { state: 'No ribbon' });
  assert.deepEqual(p.hidden, [ribbon]);
  assert.deepEqual(prepareItemModel(t.entries.get('model.glb'), t.manifest, { state: 'Tied' }).hidden, []);
});
