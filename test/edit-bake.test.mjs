// Phase 2: the edits written into a model (avatar.vrm), the hair piece merged, the body measured,
// and a character saved and read back with identical edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGlb, readAccessor, checkModel, checkItem, checkBundle, writeItem, readItem, readBundle, writeBundle, createBundle,
  setDocument, setAvatar, touchBundle, standardBase, sha256,
} from '../src/index.js';
import { bufferViewBytes } from '../src/glb.js';
import {
  newEdits, setEdits, setEdit, editsForSave, editsHash, readEdits, bakeAvatar, measureEdits, mergeItemModel, hairDesignToItem, headFrame,
  decodePng, encodePng, overlay, paintBlush, overlayColour, blushAlpha, faceLandmarks, scanHead, matchHead, HAIR_MARK,
} from '../src/edit/index.js';
import { fixture, specVrm, noSpec, SPEC_DIR } from './helpers.mjs';

const nodeByName = (json, name) => json.nodes.findIndex((n) => n.name === name);
const headNode = (json) => json.extensions.VRMC_vrm.humanoid.humanBones.head.node;
const matName = (json, re) => json.materials.findIndex((m) => re.test(m.name || ''));
const imageOf = (json, bin, mat, slot = 'base') => {
  const m = json.materials[mat];
  const t = slot === 'base' ? m.pbrMetallicRoughness.baseColorTexture.index : m.extensions.VRMC_materials_mtoon.shadeMultiplyTexture.index;
  return decodePng(bufferViewBytes(json, bin, json.images[json.textures[t].source].bufferView));
};
const FRINGE = () => {
  const strands = [];
  for (let i = -4; i <= 4; i++) { const x = i * 0.012; strands.push({ points: [[x, 0.16, 0.06], [x * 1.1, 0.14, 0.1], [x * 1.2, 0.1, 0.115], [x * 1.25, 0.06, 0.12]] }); }
  return { groups: [{ id: 'g1', name: 'Fringe', cross: 'Flat', color: [0.35, 0.22, 0.15], params: {}, strands }] };
};
const META = { authors: ['Xocialize LLC'], licenseUrl: 'https://vrm.dev/licenses/1.0/' };

test('PNG: what is written reads back pixel for pixel; Spec\'s textures decode', { skip: noSpec }, () => {
  const w = 37, h = 11, data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 4)) & 255;
  const back = decodePng(encodePng({ width: w, height: h, data }));
  assert.deepEqual([back.width, back.height], [w, h]);
  assert.deepEqual(Buffer.from(back.data), Buffer.from(data));
  assert.deepEqual(encodePng({ width: w, height: h, data }), encodePng({ width: w, height: h, data }), 'the same pixels give the same bytes');
  const { json, bin } = parseGlb(specVrm());
  const img = imageOf(json, bin, matName(json, /Face_00_SKIN/));
  assert.ok(img.width >= 256 && img.data.length === img.width * img.height * 4);
});

test('the blush and the hair colour follow the formulas EDITS.md gives', () => {
  assert.equal(overlay(0.5, 0.8), 0.8); // a neutral grey layer gives the chosen colour (§3.7)
  assert.equal(overlay(0.25, 0.5), 0.25);
  assert.equal(Math.round(overlay(0.75, 0.5) * 1000) / 1000, 0.75);
  assert.equal(blushAlpha(0, 0.8), 0.8);
  assert.equal(Math.round(blushAlpha(0.5, 0.8) * 1e6) / 1e6, 0.48); // 0.6 × the strength halfway out
  assert.equal(blushAlpha(1, 0.8), 0);
  const img = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(200) };
  paintBlush(img, [{ u: 0.5, v: 0.5, ru: 0.2, rv: 0.2 }], [1, 0, 0], 1);
  const at = (x, y) => [...img.data.slice((y * 20 + x) * 4, (y * 20 + x) * 4 + 4)];
  assert.deepEqual(at(0, 0), [200, 200, 200, 200], 'outside the ellipse nothing changes');
  assert.ok(at(10, 10)[0] > 240 && at(10, 10)[1] < 60, 'the centre takes the colour');
  const hair = overlayColour({ width: 1, height: 1, data: new Uint8ClampedArray([128, 64, 255, 77]) }, [1, 0.5, 0]);
  assert.deepEqual([...hair.data], [255, 64, 255, 77], 'overlay per channel, alpha kept');
});

test('no edits: the bake is Spec, checked clean, with the character\'s name', { skip: noSpec }, () => {
  const spec = specVrm();
  const r = bakeAvatar(spec, newEdits(), { meta: { name: 'Plain' } });
  assert.deepEqual(checkModel(r.bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
  const { json } = parseGlb(r.bytes);
  assert.equal(json.extensions.VRMC_vrm.meta.name, 'Plain');
  assert.equal(r.changed, false);
});

test('the body and Iris Size are written into the mesh and bones; the feet stay on the ground (EDITS.md §4)', { skip: noSpec }, () => {
  const spec = specVrm();
  const before = parseGlb(spec);
  const r = bakeAvatar(spec, setEdits(newEdits(), [['body.height', 1], ['body.headSize', 1], ['face.bones.iris', 1.3]]));
  const after = parseGlb(r.bytes);
  assert.deepEqual(checkModel(r.bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
  // every bone keeps scale 1 (the file needs nothing special to show the shape)
  for (const n of after.json.nodes) if (n.scale) assert.deepEqual(n.scale, [1, 1, 1]);
  // the head sits higher: the whole figure is 12 % taller
  const y = (g, i) => { let p = 0; const par = new Map(); g.json.nodes.forEach((n, k) => (n.children || []).forEach((c) => par.set(c, k))); for (let k = i; k != null; k = par.get(k)) p += g.json.nodes[k].translation?.[1] ?? 0; return p; };
  const h0 = y(before, headNode(before.json)), h1 = y(after, headNode(after.json));
  assert.ok(Math.abs(h1 / h0 - 1.12) < 0.02, `head height ${h0.toFixed(3)} → ${h1.toFixed(3)}`);
  // the lowest point of the body skin stays where it was
  const minY = (g) => { const mi = g.json.meshes.findIndex((m) => m.primitives.some((p) => /Body_00_SKIN/.test(g.json.materials[p.material].name))); const a = g.json.meshes[mi].primitives[0].attributes.POSITION; return g.json.accessors[a].min[1]; };
  assert.ok(Math.abs(minY(after) - minY(before)) < 0.003, `ground ${minY(before)} → ${minY(after)}`);
});

test('the face: the head shape and nose move the face mesh, the eyes split per side, the blush is painted, colours set (EDITS.md §3)', { skip: noSpec }, () => {
  const spec = specVrm();
  const doc = setEdits(newEdits(), [
    ['face.headShape', 'square'], ['face.shapes.noseSize', 1], ['face.colors.irisL', [0, 1, 0]], ['face.colors.irisR', [1, 0, 0]],
    ['face.colors.cheek', [1, 0.3, 0.4]], ['face.shapes.blush', 1], ['face.colors.skin', [1, 0.8, 0.7]],
  ]);
  const before = parseGlb(spec);
  const r = bakeAvatar(spec, doc);
  const after = parseGlb(r.bytes);
  assert.deepEqual(checkModel(r.bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
  const face = after.json.meshes.findIndex((m) => m.primitives.some((p) => /Face_00_SKIN/.test(after.json.materials[p.material].name)));
  const a0 = readAccessor(before.json, before.bin, before.json.meshes[face].primitives[0].attributes.POSITION);
  const a1 = readAccessor(after.json, after.bin, after.json.meshes[face].primitives[0].attributes.POSITION);
  let moved = 0;
  for (let i = 0; i < a0.length; i++) if (Math.abs(a0[i] - a1[i]) > 1e-5) moved++;
  assert.ok(moved > 100, `${moved} face coordinates moved`);
  const irisMats = after.json.materials.filter((m) => /EyeIris/.test(m.name));
  assert.equal(irisMats.length, 2, 'a left-eye copy of the iris material');
  const colours = irisMats.map((m) => m.pbrMetallicRoughness.baseColorFactor.slice(0, 3));
  assert.ok(colours.some((c) => c[1] > 0.5 && c[0] < 0.1) && colours.some((c) => c[0] > 0.5 && c[1] < 0.1), JSON.stringify(colours));
  const skin = matName(after.json, /Face_00_SKIN/);
  assert.deepEqual(after.json.materials[skin].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((v) => Math.round(v * 100) / 100),
    before.json.materials[skin].pbrMetallicRoughness.baseColorFactor.slice(0, 3).map((v, i) => Math.round(v * [1, 0.8, 0.7][i] * 100) / 100));
  // the blush: the cheek's pixel changed, a far corner did not
  const lm = faceLandmarks(before.json, before.bin);
  const i0 = imageOf(before.json, before.bin, skin), i1 = imageOf(after.json, after.bin, skin);
  const px = (img, u, v) => { const x = Math.floor(u * img.width), y = Math.floor(v * img.height); return [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)]; };
  const c = lm.cheekUV[0];
  assert.notDeepEqual(px(i1, c.u, c.v), px(i0, c.u, c.v));
  assert.deepEqual(px(i1, 0.01, 0.01), px(i0, 0.01, 0.01));
});

test('drawn hair becomes a hair item that passes the checker, and the hair piece is merged with its colour and glow (EDITS.md §3.2, §6)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const item = await hairDesignToItem(spec, FRINGE(), { name: 'Test fringe', meta: META });
  assert.equal(item.manifest.slot, 'hair');
  assert.equal(item.manifest.type, 'hair');
  const bytes = await writeItem(item);
  assert.deepEqual((await checkItem(bytes, { spec })).filter((p) => p.severity === 'error'), [], 'bound where Spec binds');
  const back = await readItem(bytes);
  const doc = setEdits(newEdits(), [['face.colors.hair', [0.9, 0.3, 0.5]], ['face.colors.hairEmission', [0.2, 0, 0.1]], ['body.headSize', 0.5]]);
  const r = bakeAvatar(spec, doc, { hair: { model: back.entries.get('model.glb'), humanBones: back.manifest.rig.humanBones } });
  assert.deepEqual(checkModel(r.bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
  const { json, bin } = parseGlb(r.bytes);
  const hairMat = json.materials.findIndex((m) => m.extras?.[HAIR_MARK] === 'piece');
  assert.ok(hairMat >= 0);
  assert.deepEqual(json.materials[hairMat].emissiveFactor, [0.2, 0, 0.1]);
  // the hair's texture was repainted by overlay, the piece's own file is not touched
  const own = parseGlb(back.entries.get('model.glb'));
  const ownImg = decodePng(bufferViewBytes(own.json, own.bin, own.json.images[0].bufferView));
  const baked = imageOf(json, bin, hairMat);
  const i = 4 * Math.floor(ownImg.width * ownImg.height / 2);
  assert.equal(baked.data[i], Math.round(overlay(ownImg.data[i] / 255, 0.9) * 255));
  // the hair follows the head: skinned to the head bone
  const hairNode = json.nodes.find((n) => n.mesh != null && json.meshes[n.mesh].primitives.some((p) => p.material === hairMat));
  assert.ok(json.skins[hairNode.skin].joints.includes(headNode(json)));
});

test('a worn item\'s spring bones and colliders come along when it is merged, bones matched by humanoid role', { skip: noSpec }, async () => {
  const spec = specVrm();
  const top = await readItem(fixture('items/skinned-top.vrmxw'));
  const { json, bin } = parseGlb(spec);
  const j = JSON.parse(JSON.stringify(json));
  const before = { nodes: j.nodes.length, springs: j.extensions.VRMC_springBone.springs.length, colliders: j.extensions.VRMC_springBone.colliders?.length || 0 };
  const item = parseGlb(top.entries.get('model.glb'));
  const r = mergeItemModel(j, bin, { json: JSON.parse(JSON.stringify(item.json)), bin: item.bin }, { humanBones: top.manifest.rig.humanBones });
  const sb = j.extensions.VRMC_springBone;
  assert.equal(sb.springs.length, before.springs + 1);
  assert.equal(sb.colliders.length, before.colliders + 1);
  assert.equal(r.nodes.length - 1, 3, 'three ribbon bones added (and the mesh node); the spine bones are Spec\'s own');
  const spine = j.extensions.VRMC_vrm.humanoid.humanBones.spine.node;
  assert.equal(sb.colliders[sb.colliders.length - 1].node, spine, 'the collider sits on Spec\'s spine');
  const ribbon = sb.springs[sb.springs.length - 1].joints.map((x) => j.nodes[x.node].name);
  assert.deepEqual(ribbon, ['J_Sec_Ribbon_1', 'J_Sec_Ribbon_2', 'J_Sec_Ribbon_3']);
  assert.equal(r.bin.length >= bin.length + item.bin.length, true);
});

test('measuring the edited body: no edits give Spec\'s published measurements; Height +1 gives FITTING.md §4.3\'s 176.7 cm', { skip: noSpec }, async () => {
  const spec = specVrm();
  const ref = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
  const m0 = await measureEdits(spec, newEdits());
  assert.equal(m0.lengths.stature, ref.lengths.stature);
  assert.equal(m0.stations.find((s) => s.id === 'waist').girth, ref.stations.find((s) => s.id === 'waist').girth);
  const doc = setEdit(newEdits(), 'body.height', 1);
  const m1 = await measureEdits(spec, doc);
  assert.equal(Math.round(m1.lengths.stature * 1000) / 10, 176.7);
  assert.equal(m1.of.base, await sha256(spec));
  assert.equal(m1.of.edits, await editsHash(doc));
  const waist = await measureEdits(spec, setEdit(newEdits(), 'body.waistSize', 1));
  assert.equal(Math.round(waist.stations.find((s) => s.id === 'waist').girth * 1000) / 10, 53.2);
});

test('matching a head to itself leaves the Face Shape sliders where they are', { skip: noSpec }, () => {
  const { json, bin } = parseGlb(specVrm());
  const lm = faceLandmarks(json, bin);
  assert.ok(lm.head, 'Spec\'s head is scanned');
  const r = matchHead(lm.head, lm.head);
  assert.ok(r.after <= 0.5, `${r.after} mm`);
  assert.ok(Object.values(r.shapes).every((v) => Math.abs(v) < 0.05), JSON.stringify(r.shapes));
  assert.ok(headFrame(json, bin).radius > 0.05);
  assert.equal(typeof scanHead, 'function');
});

test('a character saved with edits, a hair piece, avatar.vrm and measurements reads back with identical edits and passes the checker', { skip: noSpec }, async () => {
  const spec = specVrm();
  const specSha = await sha256(spec);
  const doc = editsForSave(setEdits(newEdits({ madeOn: specSha }), [['body.legLength', 0.4], ['face.shapes.cheekFull', -0.3], ['face.colors.hair', [0.2, 0.3, 0.9]], ['hairDesign', FRINGE()]]), { madeOn: specSha });
  const thumbnail = encodePng({ width: 4, height: 4, data: new Uint8ClampedArray(64).fill(200) });
  const b = createBundle({ avatar: bakeAvatar(spec, null, { meta: { name: 'Round trip' } }).bytes, base: standardBase('human'), thumbnail });
  setDocument(b, 'edits', doc);
  setAvatar(b, bakeAvatar(spec, doc, { meta: { name: 'Round trip' } }).bytes);
  setDocument(b, 'measurements', await measureEdits(spec, doc));
  touchBundle(b);
  const bytes = await writeBundle(b);
  assert.deepEqual((await checkBundle(bytes, { spec })).filter((p) => p.severity !== 'info'), [], 'no errors and no warnings: avatar.vrm is current');
  const again = await readBundle(bytes);
  assert.deepEqual(again.docs.edits, doc);
  assert.deepEqual(readEdits(again.docs.edits).ignored, []);
  assert.equal(again.manifest.avatar.of.edits, await editsHash(doc));
  assert.equal(again.docs.measurements.of.edits, await editsHash(doc));
  const avatar = parseGlb(again.entries.get('avatar.vrm'));
  assert.ok(avatar.json.meshes.some((m) => /^DrawnHair/.test(m.name || '')), 'the drawn hair is in avatar.vrm');
});

test('the fixture character reads with every edit applied, its values all in range, and bakes clean', { skip: noSpec }, async () => {
  const b = await readBundle(fixture('characters/full.vrmxa'));
  const { edits, ignored } = readEdits(b.docs.edits);
  assert.deepEqual(ignored, []);
  assert.equal(edits.face.headShape, 'heart');
  assert.equal(edits.face.shapes.jawSize, 0.1); // was -0.1 until SPEC-QUESTIONS #28
  const r = bakeAvatar(specVrm(), b.docs.edits);
  assert.deepEqual(checkModel(r.bytes, { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
});
