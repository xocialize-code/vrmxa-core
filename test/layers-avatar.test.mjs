// The layered editors' textures in avatar.vrm and on the live view (VRMXA §6.0 "Writing into avatar.vrm", §6.1
// "Showing a state"; PRD EYE-7, APP-9, TEX-7): what is shown is what is saved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { SPEC_REPO, noSpecRepo, specVrm, noSpec } from './helpers.mjs';
import { readBundle, parseGlb } from '../src/index.js';
import { decodePng } from '../src/edit/png.js';
import { bakeAvatar, newEdits, setEdits, readEdits } from '../src/edit/index.js';
import { drawAvatar } from '../src/closet/avatar.js';
import { createLiveEdits } from '../src/edit/three/live.js';
import { flattenEyes, flattenSkin, pictureLoader, materialPicture, eyeStateTextures, layerTextures, refreshBakedEyes } from '../src/layers/index.js';
import { setDocument, writeBundle, checkBundle } from '../src/index.js';

const skip = noSpecRepo || noSpec;
const fullBundle = async () => readBundle(new Uint8Array(readFileSync(join(SPEC_REPO, 'fixtures/characters/full.vrmxa'))));
const docOf = (b, p) => JSON.parse(new TextDecoder().decode(b.entries.get(p)));
const samePixels = (a, b) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

// the picture each material's base colour and shade multiply use in a GLB
function slots(glb, name) {
  const { json, bin } = parseGlb(glb);
  const mats = json.materials.filter((m) => m.name === name || m.name === `${name} (left eye)`);
  const pic = (t) => { const img = json.images[json.textures[t].source]; const v = json.bufferViews[img.bufferView]; return decodePng(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength)); };
  return mats.map((m) => ({ name: m.name, base: m.pbrMetallicRoughness.baseColorTexture.index, shade: m.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture?.index, pic: pic(m.pbrMetallicRoughness.baseColorTexture.index) }));
}

test('eyeStateTextures: a state\'s own textures, default\'s for the rest, its hidden targets and its face shapes', { skip: noSpecRepo }, async () => {
  const b = await fullBundle();
  const eyes = docOf(b, 'appearance/eyes/eyes.json');
  const flat = flattenEyes(eyes, pictureLoader(b.entries));
  const iris = eyes.targets.iris.material, hl = eyes.targets.highlight.material;
  const z = eyeStateTextures(eyes, flat, 'zonedOut');
  assert.deepEqual(Object.keys(z.pictures), [iris]);
  assert.ok(samePixels(z.pictures[iris], flat.zonedOut.iris));
  assert.deepEqual(z.hide, [hl]);
  const sq = eyeStateTextures(eyes, flat, 'squint');
  assert.ok(samePixels(sq.pictures[iris], flat.squint.iris));
  assert.throws(() => eyeStateTextures(eyes, flat, 'nope'), /no eye state nope/);
});

test('the bake writes the default eye set and the skin into avatar.vrm, shade following, nothing else touched', { skip }, async () => {
  const spec = specVrm();
  const b = await fullBundle();
  const eyes = docOf(b, 'appearance/eyes/eyes.json'), skin = docOf(b, 'appearance/skin/skin.json');
  const textures = layerTextures({ eyes, skin }, b.entries, spec);
  const load = pictureLoader(b.entries);
  const want = flattenEyes(eyes, load, { states: ['default'] }).default.iris;
  // no edits, so the face skin isn't blushed and every texture is exactly the flattener's
  const out = bakeAvatar(spec, null, { textures }).bytes;
  const [i] = slots(out, eyes.targets.iris.material);
  assert.ok(samePixels(i.pic, want), 'the iris is the flattened default');
  assert.equal(i.shade, i.base, 'the shade multiply follows the base colour, as on Spec');
  const bodyMat = skin.targets.skinBody.material;
  const [body] = slots(out, bodyMat);
  const bodyWant = flattenSkin(skin, load, { skinBody: materialPicture(spec, bodyMat), skinFace: materialPicture(spec, skin.targets.skinFace.material) }).skinBody;
  assert.ok(samePixels(body.pic, bodyWant), 'the body skin is its layers over the base\'s own art');
  // the eye white has no layers: Spec's own picture stays
  const [white] = slots(out, eyes.targets.white.material);
  assert.ok(samePixels(white.pic, materialPicture(spec, eyes.targets.white.material)));
});

test('with the iris split by side, both eyes get the layered iris', { skip }, async () => {
  const spec = specVrm();
  const b = await fullBundle();
  const eyes = docOf(b, 'appearance/eyes/eyes.json');
  const textures = layerTextures({ eyes }, b.entries, spec);
  const doc = setEdits(newEdits(), [['face.colors.irisL', [0.9, 0.2, 0.2]]]);
  const both = slots(bakeAvatar(spec, doc, { textures }).bytes, eyes.targets.iris.material);
  assert.equal(both.length, 2);
  assert.equal(both[0].base, both[1].base, 'one new picture shared by the two iris materials');
});

test('drawAvatar writes the character\'s layers, so a saved character carries its eyes', { skip, timeout: 120000 }, async () => {
  const spec = specVrm();
  const b = await fullBundle();
  const eyes = docOf(b, 'appearance/eyes/eyes.json');
  const r = await drawAvatar(b, { spec });
  const [i] = slots(r.bytes, eyes.targets.iris.material);
  assert.ok(samePixels(i.pic, flattenEyes(eyes, pictureLoader(b.entries), { states: ['default'] }).default.iris));
});

// ---- live -----------------------------------------------------------------------------------------------
// a scene of three-vrm-like meshes: one material per name, each with a DataTexture used for base colour and shade
function liveScene(names) {
  const scene = new THREE.Group();
  const byName = {};
  for (const name of names) {
    const map = new THREE.DataTexture(new Uint8Array([10, 20, 30, 255]), 1, 1);
    const m = new THREE.MeshBasicMaterial({ name, map });
    m.shadeMultiplyTexture = map;
    scene.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    byName[name] = m;
  }
  return { scene, byName, humanoid: { getRawBoneNode: () => null } };
}

test('live textures(): a state shown, a target hidden, then everything back', { skip: noSpec }, () => {
  const g = parseGlb(specVrm());
  const vrm = liveScene(['Iris', 'Highlight', 'White']);
  const live = createLiveEdits(vrm, g);
  const orig = vrm.byName.Iris.map;
  const pic = { width: 1, height: 1, data: new Uint8ClampedArray([200, 100, 50, 255]) };
  live.textures({ Iris: pic }, { hide: ['Highlight'] });
  const iris = vrm.byName.Iris;
  assert.notEqual(iris.map, orig);
  assert.deepEqual([...iris.map.image.data], [200, 100, 50, 255]);
  assert.equal(iris.shadeMultiplyTexture, iris.map, 'the shade follows');
  assert.equal(vrm.byName.Highlight.visible, false);
  assert.equal(vrm.byName.White.map.image.data[0], 10, 'a material left out keeps its own texture');
  // new pixels reuse the same texture (a stroke drawn live)
  const tex = iris.map;
  live.textures({ Iris: { ...pic, data: new Uint8ClampedArray([1, 2, 3, 255]) } });
  assert.equal(iris.map, tex);
  assert.deepEqual([...iris.map.image.data], [1, 2, 3, 255]);
  assert.equal(vrm.byName.Highlight.visible, true, 'not hidden any more');
  live.textures({});
  assert.equal(iris.map, orig);
  assert.equal(iris.shadeMultiplyTexture, orig);
});

test('live: the blush is painted over a layered face skin, and the plain skin comes back without it', { skip: noSpec }, () => {
  const g = parseGlb(specVrm());
  const face = g.json.materials.find((m) => /Face_\d+_SKIN/.test(m.name)).name;
  const spec = materialPicture(specVrm(), face);
  const vrm = liveScene([face]);
  vrm.byName[face].map = new THREE.DataTexture(new Uint8Array(spec.data), spec.width, spec.height);
  vrm.byName[face].shadeMultiplyTexture = vrm.byName[face].map;
  const orig = vrm.byName[face].map;
  const live = createLiveEdits(vrm, g);
  const blushed = readEdits(setEdits(newEdits(), [['face.colors.cheek', [1, 0.5, 0.6]], ['face.shapes.blush', 0.8]])).edits;
  live.apply(blushed);
  const grey = { width: spec.width, height: spec.height, data: new Uint8ClampedArray(spec.data.length).fill(128) };
  live.textures({ [face]: grey });
  const shown = vrm.byName[face].map.image.data;
  let changed = 0, kept = 0;
  for (let k = 0; k < shown.length; k += 4) { if (shown[k] === 128 && shown[k + 1] === 128) kept++; else changed++; }
  assert.ok(kept > changed && changed > 0, `the grey skin shows, blushed in places (${changed} pixels)`);
  live.textures({});
  live.apply(readEdits(newEdits()).edits);
  assert.equal(vrm.byName[face].map, orig, 'no layers and no blush: Spec\'s own texture');
});

test('refreshBakedEyes writes each state\'s finished pictures by content and drops the ones nothing uses', { skip: noSpecRepo }, async () => {
  const b = await fullBundle();
  const eyes = docOf(b, 'appearance/eyes/eyes.json');
  const oldDefault = eyes.states[0].baked.iris;
  const r1 = await refreshBakedEyes(b);
  assert.equal(r1.changed, true, 'the fixture\'s baked pictures were drawn by hand, not flattened');
  assert.deepEqual(Object.keys(r1.baked), ['default', 'zonedOut'], 'squint is made from default and keeps none');
  const flat = flattenEyes(b.docs.eyes, pictureLoader(b.entries));
  for (const s of ['default', 'zonedOut']) assert.ok(samePixels(decodePng(b.entries.get(b.docs.eyes.states.find((x) => x.name === s).baked.iris)), flat[s].iris), s);
  assert.equal(b.entries.has(oldDefault), false, 'the old picture is gone');
  assert.match(r1.baked.default.iris, /^appearance\/baked\/[0-9a-f]{12}\.png$/);
  assert.equal((await refreshBakedEyes(b)).changed, false, 'the same layers, the same pictures');
  const next = JSON.parse(JSON.stringify(b.docs.eyes));
  next.states[0].layers[1].opacity = 0.2;
  setDocument(b, 'eyes', next);
  const r3 = await refreshBakedEyes(b);
  assert.notEqual(r3.baked.default.iris, r1.baked.default.iris);
  assert.equal(r3.baked.zonedOut.iris, r1.baked.zonedOut.iris, 'a state whose layers did not change keeps its picture');
  const problems = await checkBundle(await writeBundle(b));
  assert.deepEqual(problems.filter((p) => p.severity === 'error'), []);
});
