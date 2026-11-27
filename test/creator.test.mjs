// The Eye Creator in the library (PRD EYE-14, EYE-18 to EYE-21; VRMXA §6.1): a starter design from the base's own eye
// art that looks as the base's eyes do, and the Creator's controls, which change nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { specVrm, noSpec, SPEC_REPO, noSpecRepo } from './helpers.mjs';
import { readBundle, setEntry, setDocument, writeBundle, checkBundle } from '../src/index.js';
import { decodePng } from '../src/edit/png.js';
import { starterEyes, eyesFromArt, creatorControls, applyCreator, flattenEyes, materialPicture } from '../src/layers/index.js';

const loaderOf = (pictures) => (p) => decodePng(pictures.get(p));

test('eyesFromArt finds each eye in its half, the character\'s left in the right half', () => {
  const w = 40, h = 20, data = new Uint8ClampedArray(w * h * 4);
  const dot = (cx, cy) => { for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 3; x <= cx + 3; x++) data[(y * w + x) * 4 + 3] = 255; };
  dot(10, 10); dot(30, 9);
  const e = eyesFromArt({ width: w, height: h, data });
  assert.deepEqual(e.left, { center: [31, 10], radius: [4, 3] });
  assert.deepEqual(e.right, { center: [11, 11], radius: [4, 3] });
  assert.equal(eyesFromArt({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }), null);
});

test('the starter design looks as Spec\'s own eyes do, with default, confused and squint', { skip: noSpec }, async () => {
  const spec = specVrm();
  const { doc, pictures } = await starterEyes(spec);
  assert.deepEqual(doc.states.map((s) => s.name), ['default', 'confused', 'squint']);
  assert.deepEqual(Object.keys(doc.targets).sort(), ['brow', 'eyelash', 'eyeline', 'highlight', 'iris', 'white']);
  assert.deepEqual(doc.targets.brow.size, [1024, 256]);
  assert.equal(doc.targets.iris.size, undefined, 'the document\'s size');
  assert.deepEqual(doc.eyes.left.center, [766, 261]);
  for (const p of pictures.keys()) assert.match(p, /^appearance\/layers\/[0-9a-f]{12}\.png$/);
  const flat = flattenEyes(doc, loaderOf(pictures));
  const orig = materialPicture(spec, doc.targets.iris.material);
  let d = 0, n = 0;
  for (let k = 0; k < orig.data.length; k += 4) { if (orig.data[k + 3] < 128) continue; n++; for (let c = 0; c < 3; c++) d += Math.abs(flat.default.iris.data[k + c] - orig.data[k + c]); }
  assert.ok(d / n / 3 < 3, `the default iris is within 3 levels of Spec's (${(d / n / 3).toFixed(2)})`);
  assert.deepEqual(doc.states[1].hide, ['highlight']);
  assert.deepEqual(flat.squint.iris.width, 1024);
});

test('a character with the starter design passes the checker', { skip: noSpec || noSpecRepo }, async () => {
  const spec = specVrm();
  const b = await readBundle(new Uint8Array(readFileSync(join(SPEC_REPO, 'fixtures/characters/minimal.vrmxa'))));
  const { doc, pictures } = await starterEyes(spec);
  for (const [p, v] of pictures) setEntry(b, p, v);
  setDocument(b, 'eyes', doc);
  const problems = await checkBundle(await writeBundle(b), { spec });
  assert.deepEqual(problems.filter((p) => p.severity !== 'note'), []);
});

test('the Creator reads and changes the colour, the highlight and the overlay, and nothing else', { skip: noSpec }, async () => {
  const { doc, pictures } = await starterEyes(specVrm());
  const c = creatorControls(doc);
  assert.equal(c.colour.fill, 'eyeColour');
  assert.equal(c.colour.type, 'linear');
  assert.deepEqual([c.highlight, c.overlay], [{ strength: 1, count: 1 }, { strength: 1, count: 1 }]);
  assert.ok(c.sclera);
  const amber = applyCreator(doc, { colour: { top: [0.5, 0.25, 0.05], bottom: [0.95, 0.7, 0.3] }, highlight: 0.5, overlay: 0.25 });
  const a = creatorControls(amber);
  assert.deepEqual(a.colour.stops.map((s) => s.color), [[0.5, 0.25, 0.05], [0.95, 0.7, 0.3]]);
  assert.deepEqual([a.highlight.strength, a.overlay.strength], [0.5, 0.25]);
  // nothing else moved: the same document once the three controls are put back
  const back = applyCreator(amber, { colour: { top: c.colour.stops[0].color, bottom: c.colour.stops[1].color }, highlight: 1, overlay: 1 });
  assert.deepEqual(back, doc);
  const solid = applyCreator(doc, { colour: [0.2, 0.6, 0.3] });
  assert.deepEqual(solid.fills.eyeColour, { type: 'solid', color: [0.2, 0.6, 0.3] });
  // every state that shows the eye colour follows it (EYE-13)
  const before = flattenEyes(doc, loaderOf(pictures)), after = flattenEyes(solid, loaderOf(pictures));
  for (const s of ['default', 'confused', 'squint']) assert.ok(!before[s].iris.data.every((v, i) => v === after[s].iris.data[i]), s);
  // the sclera: white leaves Spec's eye white as it is; a colour tints it, keeping the art's shading
  assert.deepEqual(c.sclera, { color: [1, 1, 1] });
  const spec = specVrm();
  const specWhite = materialPicture(spec, doc.targets.white.material).data;
  assert.ok(flattenEyes(doc, loaderOf(pictures)).default.white.data.every((v, i) => v === specWhite[i]));
  const blue = applyCreator(doc, { sclera: [0.85, 0.9, 1] });
  assert.deepEqual(creatorControls(blue).sclera, { color: [0.85, 0.9, 1] });
  const w0 = flattenEyes(doc, loaderOf(pictures)).default.white, w1 = flattenEyes(blue, loaderOf(pictures)).default.white;
  const k = (256 * 1024 + 766) * 4;
  assert.ok(w1.data[k] < w0.data[k] && w1.data[k + 2] === w0.data[k + 2], 'red down, blue kept');
  assert.throws(() => applyCreator(doc, { sclera: 'blue' }), /a sclera colour is/);
  assert.throws(() => applyCreator(doc, { colour: [2, 0, 0] }), /an eye colour is/);
  assert.throws(() => applyCreator(doc, { highlight: 1.5 }), /highlight strength is 0 to 1/);
});

test('a design without roles: the shared fill, the highlight target and blended iris pictures are found', { skip: noSpecRepo }, async () => {
  const b = await readBundle(new Uint8Array(readFileSync(join(SPEC_REPO, 'fixtures/characters/full.vrmxa'))));
  const eyes = JSON.parse(new TextDecoder().decode(b.entries.get('appearance/eyes/eyes.json')));
  const c = creatorControls(eyes);
  assert.equal(c.colour.fill, 'eyeColour');
  assert.equal(c.highlight, null, 'Mira\'s eyes have no highlight layers');
  assert.deepEqual(c.overlay, { strength: 0.9, count: 1 });
  assert.equal(c.sclera, null, 'nor a sclera layer');
  assert.throws(() => applyCreator(eyes, { highlight: 0.5 }), /no highlight layers/);
});
