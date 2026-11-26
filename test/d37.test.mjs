// VRMXA 0.35 (D37, SPEC-QUESTIONS #86–#98) and VRMXW 0.17 (W29, #99): the layers the eye, mouth and skin editors share
// (§6.0), six eye targets (§6.1), a lips patch's baked.of (§6.2), the skin document (§6.3), the shared picture store
// (§3.3), skin hidden under worn items recorded in avatar.vrm (§5.2), and an item's fit.hideSkin (VRMXW §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle, setDocument, setEntry, parseGlb, buildGlb, DOCUMENTS, documentPaths, layerPath, bakedPath } from '../src/index.js';

const full = () => readBundle(fixture('characters/full.vrmxa'));
// a picture already in the bundle, used again under a new layer
const anyPicture = (b) => [...b.entries.keys()].find((k) => k.startsWith('appearance/layers/'));
const skinDoc = (pic, layers = null) => ({
  format: 'vrmxa-skin', version: 1,
  targets: { skinFace: { material: 'N00_000_00_Face_00_SKIN (Instance)', size: [1024, 1024] }, skinBody: { material: 'N00_000_00_Body_00_SKIN (Instance)', size: [1024, 1024] } },
  layers: layers || [
    { id: 's1', name: 'Skin tone', kind: 'adjust', band: 'adjust', targets: ['skinFace', 'skinBody'], tone: { from: [0.98, 0.91, 0.86], to: [0.6, 0.4, 0.3] } },
    { id: 's2', name: 'A stroke across the neck', kind: 'image', band: 'on', images: { skinFace: pic, skinBody: pic }, source: { kind: 'stroke', points: [[0, 1.36, 0.05], [0.02, 1.38, 0.04]], radius: 0.008, soft: 0.003, colour: [0.1, 0.4, 0.5] } },
  ],
});
const errorsOf = async (b) => codes(await checkBundle(await writeBundle(b)));

test('the layout knows the skin document and the shared picture store (§3.3, §6.0)', () => {
  assert.deepEqual(DOCUMENTS.skin, { path: 'appearance/skin/skin.json', format: 'vrmxa-skin', version: 1, section: 'appearance' });
  assert.equal(layerPath('0123456789ab'), 'appearance/layers/0123456789ab.png');
  assert.equal(bakedPath('0123456789ab'), 'appearance/baked/0123456789ab.png');
  const paths = documentPaths({ sections: { appearance: { version: 1, skin: { file: 'appearance/skin/skin.json', format: 'vrmxa-skin', version: 1 } } } });
  assert.deepEqual(paths.skin, { path: 'appearance/skin/skin.json', declared: 1 });
});

test('a skin document with a tone on both textures and a layer spanning them passes (§6.3)', async () => {
  const b = await full();
  setDocument(b, 'skin', skinDoc(anyPicture(b)));
  assert.deepEqual(await errorsOf(b), []);
  const back = await readBundle(await writeBundle(b));
  assert.equal(back.docs.skin.layers[1].images.skinBody, anyPicture(b));
});

test('a skin layer\'s faults are found: no adjustment, an unknown band or target, a missing picture (§6.0, §6.3)', async () => {
  const pic = (b) => anyPicture(b);
  let b = await full();
  setDocument(b, 'skin', skinDoc(pic(b), [{ id: 'x', kind: 'adjust', targets: ['skinFace'] }]));
  assert.ok((await errorsOf(b)).includes('layers.kind'), 'an adjust layer with nothing to change');
  b = await full();
  setDocument(b, 'skin', skinDoc(pic(b), [{ id: 'x', kind: 'image', band: 'top', images: { skinFace: pic(b) } }]));
  assert.ok((await errorsOf(b)).includes('layers.band'));
  b = await full();
  setDocument(b, 'skin', skinDoc(pic(b), [{ id: 'x', kind: 'image', images: { skinHead: pic(b) } }]));
  assert.ok((await errorsOf(b)).includes('layers.target'));
  b = await full();
  setDocument(b, 'skin', skinDoc(pic(b), [{ id: 'x', kind: 'image', images: { skinBody: 'appearance/layers/000000000000.png' } }]));
  assert.ok((await errorsOf(b)).includes('layers.file'));
});

test('the eyes have six targets, each with its own size; a seventh is refused (§6.1)', async () => {
  const b = await full();
  const eyes = JSON.parse(JSON.stringify(b.docs.eyes));
  eyes.targets.brow = { material: 'N00_000_00_FaceBrow_00_FACE (Instance)', size: [1024, 256] };
  eyes.states[0].layers.push({ id: 'b1', name: 'Brow colour', target: 'brow', kind: 'fill', fill: { type: 'solid', color: [0.24, 0.13, 0.1] } });
  setDocument(b, 'eyes', eyes);
  assert.deepEqual(await errorsOf(b), []);
  eyes.targets.cheek = { material: 'x' };
  setDocument(b, 'eyes', eyes);
  assert.ok((await errorsOf(b)).includes('eyes.target'));
});

test('a mouth state\'s lips patch records the skin it was flattened over, by SHA-256 (§6.2)', async () => {
  const b = await full();
  const mouth = JSON.parse(JSON.stringify(b.docs.mouth));
  const lips = anyPicture(b);
  const st = mouth.states.find((s) => s.name !== 'default');
  st.baked = { lips, of: { skin: 'a'.repeat(64), edits: null } };
  setDocument(b, 'mouth', mouth);
  assert.deepEqual(await errorsOf(b), []);
  st.baked.of = { skin: 'not a hash' };
  setDocument(b, 'mouth', mouth);
  assert.ok((await errorsOf(b)).includes('mouth.baked-of'));
});

test('skin hidden under worn items is recorded on the skin materials, { by, of } (§5.2)', async () => {
  const b = await full();
  const { json, bin } = parseGlb(b.entries.get('avatar.vrm'));
  const i = json.materials.findIndex((m) => /Body_00_SKIN/.test(m.name));
  json.materials[i].extras = { vrmxaHidden: { by: ['2de0bbfe-3b3f-49db-a82f-1964608c2927'], of: 'b'.repeat(64) } };
  setEntry(b, 'avatar.vrm', buildGlb(json, bin));
  assert.ok(!(await errorsOf(b)).includes('schema.hidden'));
  json.materials[i].extras = { vrmxaHidden: { by: 'the top' } };
  setEntry(b, 'avatar.vrm', buildGlb(json, bin));
  assert.ok((await errorsOf(b)).includes('schema.hidden'));
});
