// The one flattener (PRD REF-10; VRMXA §6.0, D37): blend arithmetic, fills, per-eye layers, bands on a skin
// texture, scaled states, refusals, and the specification's full character flattened to known bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_REPO, noSpecRepo } from './helpers.mjs';
import { readBundle, sha256 } from '../src/index.js';
import { flattenTarget, flattenEyes, flattenSkin, pictureLoader, scaleAboutEyes, eyesOf, inBands, bandOf } from '../src/layers/index.js';

const solid = (w, h, rgba) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).map((_, i) => rgba[i % 4]) });
const px = (p, x = 0, y = 0) => [...p.data.slice((y * p.width + x) * 4, (y * p.width + x) * 4 + 4)];
const one = (layers, opts = {}) => px(flattenTarget({ size: [1, 1] }, layers, opts));
const RED = solid(1, 1, [255, 0, 0, 255]), BLUE = solid(1, 1, [0, 0, 255, 255]), GREY = solid(1, 1, [128, 128, 128, 255]);

test('normal at half opacity over an opaque backdrop is the W3C source-over', () => {
  assert.deepEqual(one([{ id: 'a', kind: 'image', image: BLUE }, { id: 'b', kind: 'image', image: RED, opacity: 0.5 }]), [128, 0, 128, 255]);
});

test('multiply, screen and overlay over grey give the W3C results', () => {
  const over = (blend, src) => one([{ id: 'a', kind: 'image', image: GREY }, { id: 'b', kind: 'image', image: src, blend }]);
  assert.deepEqual(over('multiply', RED), [128, 0, 0, 255]);
  assert.deepEqual(over('screen', RED), [255, 128, 128, 255]);
  // overlay: backdrop 128/255 > 0.5, so screen(2b−1, s): red 255, the others 2·0.502−1 ≈ 0.004 → 1
  assert.deepEqual(over('overlay', RED), [255, 1, 1, 255]);
});

test('a layer alone over nothing keeps its own colour and alpha, whatever its blend', () => {
  const half = solid(1, 1, [200, 100, 50, 128]);
  for (const blend of ['normal', 'multiply', 'screen', 'overlay']) assert.deepEqual(one([{ id: 'a', kind: 'image', image: half, blend }]), [200, 100, 50, 128], blend);
});

test('a hidden layer and one for another target are left out', () => {
  assert.deepEqual(one([{ id: 'a', kind: 'image', image: RED, visible: false }]), [0, 0, 0, 0]);
  assert.deepEqual(one([{ id: 'a', kind: 'image', target: 'iris', image: RED }], { name: 'white' }), [0, 0, 0, 0]);
  assert.deepEqual(one([{ id: 'a', kind: 'image', images: { white: RED } }], { name: 'white' }), [255, 0, 0, 255]);
});

test('a mask limits a layer by its alpha', () => {
  const m = solid(1, 1, [0, 0, 0, 51]); // 0.2
  assert.deepEqual(one([{ id: 'a', kind: 'fill', fill: { type: 'solid', color: [1, 0, 0] }, mask: m }]), [255, 0, 0, 51]);
});

test('an adjust layer changes colour, not alpha, through its opacity', () => {
  const half = solid(1, 1, [128, 128, 128, 128]);
  const darker = one([{ id: 'a', kind: 'image', image: half }, { id: 'b', kind: 'adjust', brightness: -20 }]);
  assert.equal(darker[3], 128);
  assert.ok(darker[0] < 128 && darker[0] === darker[1] && darker[1] === darker[2]);
  const none = one([{ id: 'a', kind: 'image', image: half }, { id: 'b', kind: 'adjust', brightness: -20, opacity: 0 }]);
  assert.deepEqual(none, [128, 128, 128, 128]);
});

test('a linear fill runs top to bottom of each eye; a one-eye layer paints only its half', () => {
  const target = { size: [8, 4], eyes: { left: { center: [6, 2], radius: [2, 2] }, right: { center: [2, 2], radius: [2, 2] } } };
  const fill = { type: 'linear', stops: [{ at: 0, color: [0, 0, 0] }, { at: 1, color: [1, 1, 1] }] };
  const p = flattenTarget(target, [{ id: 'f', kind: 'fill', fill, eye: 'left' }]);
  assert.deepEqual(px(p, 1, 0), [0, 0, 0, 0], 'the right eye (left half) is untouched');
  assert.ok(px(p, 6, 0)[0] < px(p, 6, 3)[0], 'darker at the top, lighter at the bottom');
  assert.equal(px(p, 6, 0)[3], 255);
});

test('without eyes, the left eye is the right half of the texture (VRMXA §6.1)', () => {
  const [right, left] = eyesOf([1024, 512]);
  assert.deepEqual([right.side, right.cx, left.side, left.cx, left.cy], ['right', 256, 'left', 768, 256]);
});

test('skin layers stack by band, whatever order they are listed in', () => {
  const layers = [{ id: 'mark', kind: 'image', images: { skinFace: RED }, opacity: 0.5 }, { id: 'tone', kind: 'adjust', targets: ['skinFace'], brightness: -50 }];
  assert.deepEqual(inBands(layers).map((l) => l.id), ['tone', 'mark']);
  assert.deepEqual([bandOf(layers[0]), bandOf(layers[1]), bandOf({ kind: 'image', band: 'worn' })], ['on', 'adjust', 'worn']);
  const doc = { targets: { skinFace: { size: [1, 1] } }, layers };
  const out = flattenSkin(doc, null, { skinFace: GREY }).skinFace;
  // the tone darkens the base, then half the red mark goes over it: the mark's red is not darkened
  const toneOnly = one([{ id: 'b', kind: 'image', image: GREY }, { id: 't', kind: 'adjust', brightness: -50 }]);
  assert.equal(px(out)[0], Math.round((255 + toneOnly[0]) / 2));
});

test('a scale of 1 leaves a texture as it is; a smaller scale shrinks it towards each eye', () => {
  const p = flattenTarget({ size: [16, 8] }, [{ id: 'a', kind: 'fill', fill: { type: 'solid', color: [1, 1, 1] } }]);
  assert.deepEqual(scaleAboutEyes(p, null, 1).data, p.data);
  const s = scaleAboutEyes(p, null, 0.5);
  assert.equal(px(s, 0, 0)[3], 0, 'the corner is now outside the art');
  assert.equal(px(s, 4, 4)[3], 255, 'the eye centre still covered');
});

test('refusals name the layer: an unknown blend, a missing fill, a picture of the wrong size', () => {
  assert.throws(() => one([{ id: 'x', kind: 'image', image: RED, blend: 'dodge' }]), /layer x: blend must be/);
  assert.throws(() => one([{ id: 'y', kind: 'fill', fill: 'nope' }]), /layer y names a fill/);
  assert.throws(() => flattenTarget({ size: [2, 2] }, [{ id: 'z', kind: 'image', image: RED }]), /layer z's picture is 1×1, not the target's 2×2/);
});

test('a state made from itself is refused', () => {
  assert.throws(() => flattenEyes({ size: [1, 1], targets: { iris: {} }, states: [{ name: 'a', from: 'a', scale: 0.5 }] }, null), /made from itself/);
});

// The specification's full character (VRMXA_Specification/fixtures). These bytes are the same as the T-4 trial
// flattener's for the same layers (checked when the flattener moved into the library, 2026-11-26); a change here
// is a change to every finished texture, so it needs a decision, not a new hash.
const KNOWN = {
  'default/iris': '73e9ac62f9a616507933c8061be9dd41c8e3e20e1f26c1e0afc0689064a38c15',
  'confused/iris': '7883a254867516bae1447a5ab57515ee7364ee4f25b67a7f3448cbbb4b20d624',
  'smitten/iris': '9e9072b85622bff7d3b4b6f8271d55826b242020acabc7ece28ea636e27e0e3a', // a finished texture alone (D39)
  'squint/iris': 'eb8b214d1de18dd4886c473cf153eedd1dc2bd6aac9e3aae30906619b6500a9d',
  'skin/skinFace': 'bb9f8df61474d25e71fa00722318cd387396ca1736605e1248821cc0de3d3af8',
  'skin/skinBody': 'c5c0218e76207f7d56bf16202e578fbf63797b09c762cbbede320904a4c450d7',
};

test('the specification\'s full character flattens to known bytes, the same twice', { skip: noSpecRepo }, async () => {
  const b = await readBundle(new Uint8Array(readFileSync(join(SPEC_REPO, 'fixtures/characters/full.vrmxa'))));
  const doc = (p) => JSON.parse(new TextDecoder().decode(b.entries.get(p)));
  const eyes = doc('appearance/eyes/eyes.json'), skin = doc('appearance/skin/skin.json');
  const got = {};
  for (const run of [1, 2]) {
    const load = pictureLoader(b.entries);
    const e = flattenEyes(eyes, load), s = flattenSkin(skin, load);
    for (const [st, ts] of Object.entries(e)) for (const [t, p] of Object.entries(ts)) got[`${st}/${t}`] = [...(got[`${st}/${t}`] || []), await sha256(p.data)];
    for (const [t, p] of Object.entries(s)) got[`skin/${t}`] = [...(got[`skin/${t}`] || []), await sha256(p.data)];
  }
  assert.deepEqual(Object.keys(got).sort(), Object.keys(KNOWN).sort());
  for (const [k, [a, c]] of Object.entries(got)) { assert.equal(a, c, `${k} differs between runs`); assert.equal(a, KNOWN[k], k); }
});

test('changing the shared fill recolours every state that uses it, and only those layers', { skip: noSpecRepo }, async () => {
  const b = await readBundle(new Uint8Array(readFileSync(join(SPEC_REPO, 'fixtures/characters/full.vrmxa'))));
  const eyes = JSON.parse(new TextDecoder().decode(b.entries.get('appearance/eyes/eyes.json')));
  const load = pictureLoader(b.entries);
  const before = flattenEyes(eyes, load);
  const amber = { ...eyes, fills: { eyeColour: { type: 'linear', stops: [{ at: 0, color: [0.5, 0.3, 0.05] }, { at: 1, color: [0.95, 0.75, 0.3] }] } } };
  const after = flattenEyes(amber, load);
  for (const s of ['default', 'confused', 'squint']) assert.notEqual(await sha256(after[s].iris.data), await sha256(before[s].iris.data), s);
  // the confused ring is black in both: pick a ring pixel, the left eye's top edge
  const ring = (p) => px(p, 766, 260 - 120);
  assert.deepEqual(ring(after.confused.iris), ring(before.confused.iris));
  // a state given as a finished texture alone doesn't follow the fill (D39)
  assert.deepEqual([...after.smitten.iris.data.slice(0, 64)], [...before.smitten.iris.data.slice(0, 64)]);
  assert.equal(await sha256(after.smitten.iris.data), await sha256(before.smitten.iris.data));
});

test('vrmxa flatten gives the same bytes from the command line', { skip: noSpecRepo }, async () => {
  const { execFileSync } = await import('node:child_process');
  const r = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '../bin/vrmxa.mjs'), 'flatten', join(SPEC_REPO, 'fixtures/characters/full.vrmxa'), '--state', 'default,squint', '--json'], { encoding: 'utf8' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.textures.map((t) => [t.path, t.pixels]), [['eyes/default-iris.png', KNOWN['default/iris']], ['eyes/squint-iris.png', KNOWN['squint/iris']]]);
});
