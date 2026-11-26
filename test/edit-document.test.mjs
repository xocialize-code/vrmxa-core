// Phase 2: the edit document (EDITS.md version 7) read, changed and written without losing anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newEdits, readEdits, editsRefusal, setEdit, setEdits, editsForSave, upgradeEdits, editProblem, editLabel, changedPaths,
  editsHash, editsChangeLook, BODY_SLIDERS, FACE_SHAPES, COLOR_ROLES, STORED_HEAD_SHAPES,
} from '../src/edit/index.js';
import { jsonBytes, sha256 } from '../src/index.js';

test('the vocabulary matches EDITS.md: 17 body sliders, 21 shape keys, the colour roles and five stored head shapes', () => {
  assert.equal(Object.keys(BODY_SLIDERS).length, 17);
  assert.deepEqual(Object.keys(BODY_SLIDERS).sort(), ['armLength', 'bustOpen', 'bustSize', 'bustY', 'footSize', 'handSize', 'headSize', 'headWidth', 'height',
    'legLength', 'neckLength', 'neckWidth', 'physique', 'shoulderWidth', 'slender', 'waistLength', 'waistSize']);
  // §3.4 lists 21 keys: 6 nose, 2 cheek, blush, canvas and 11 head controls (headFemale and headMale count as two)
  assert.equal(Object.keys(FACE_SHAPES).length, 21);
  assert.deepEqual([FACE_SHAPES.blush.min, FACE_SHAPES.blush.max, FACE_SHAPES.blush.def], [0, 1, 0.6]);
  assert.deepEqual([FACE_SHAPES.canvas.min, FACE_SHAPES.canvas.def], [0, 1]);
  assert.deepEqual([FACE_SHAPES.jawSize.min, FACE_SHAPES.jawSize.max], [0, 1]);
  assert.deepEqual(COLOR_ROLES, ['skin', 'brow', 'eyeline', 'mouth', 'eyeWhite', 'irisL', 'irisR', 'cheek', 'hair', 'hairEmission']);
  assert.deepEqual(STORED_HEAD_SHAPES, ['egg', 'round', 'oval', 'heart', 'square']);
});

test('reading applies known keys clamped to their ranges, and reports the rest without dropping them', () => {
  const doc = {
    format: 'vrmxa-edits', version: 7, editor: 'x', madeOn: null, 'x-vendor': { a: 1 },
    face: { morphs: { EYE_Surprised: 1.4, 'bad key': 1 }, colors: { skin: [1.2, 0.5, -1], gold: [1, 1, 0] }, bones: { iris: 2 }, shapes: { jawSize: -0.1, noseSize: 3, wiggle: 1 }, headShape: 'blob', glow: true },
    body: { height: 5, tail: 1 },
  };
  const { edits, ignored, refused } = readEdits(doc);
  assert.equal(refused, null);
  assert.equal(edits.face.morphs.EYE_Surprised, 1);
  assert.deepEqual(edits.face.colors.skin, [1, 0.5, 0]);
  assert.equal(edits.face.bones.iris, 1.3);
  assert.equal(edits.face.shapes.jawSize, 0); // the fixture's -0.1 is outside 0 … 1
  assert.equal(edits.face.shapes.noseSize, 1);
  assert.equal(edits.face.headShape, 'spec');
  assert.equal(edits.body.height, 1);
  assert.deepEqual(ignored.sort(), ['body.tail', 'face.colors.gold', 'face.glow', 'face.headShape', 'face.morphs.bad key', 'face.shapes.wiggle', 'x-vendor'].sort());
  // the stored document still has every key: changing one edit keeps the rest (CHR-8)
  const changed = setEdit(doc, 'body.legLength', 0.25);
  assert.deepEqual(changed['x-vendor'], { a: 1 });
  assert.equal(changed.face.glow, true);
  assert.equal(changed.face.shapes.wiggle, 1);
  assert.equal(changed.body.tail, 1);
  assert.equal(changed.body.legLength, 0.25);
  assert.equal(doc.body.legLength, undefined, 'the old document is untouched (for undo)');
});

test('a newer version is refused as a whole, never applied in part (EDITS.md §1)', () => {
  const doc = { format: 'vrmxa-edits', version: 8, face: { shapes: { noseSize: 1 } }, body: { height: 1 } };
  assert.match(editsRefusal(doc), /version 8, newer/);
  const r = readEdits(doc);
  assert.match(r.refused, /newer/);
  assert.deepEqual(r.edits.body, {});
  assert.deepEqual(editsForSave(doc), doc); // written back exactly as read
  assert.match(editsRefusal({ format: 'other', version: 7 }), /format/);
});

test('versions 1 and 2 keep Head Size as a bone scale; it reads and is written as body.headSize', () => {
  const v2 = { format: 'vrmxa-edits', version: 2, face: { bones: { head: 1.075, iris: 1.1 }, shapes: { noseY: 0.2 } } };
  assert.equal(readEdits(v2).edits.body.headSize, 0.5);
  const up = upgradeEdits(v2);
  assert.equal(up.version, 7);
  assert.equal(up.body.headSize, 0.5);
  assert.equal(up.face.bones.head, undefined);
  assert.equal(up.face.bones.iris, 1.1);
  const saved = editsForSave(v2, { madeOn: 'a'.repeat(64) });
  assert.equal(saved.version, 7);
  assert.deepEqual(saved.madeOn, { sha256: 'a'.repeat(64) });
});

test('setting edits: values stored clamped, null removes, bad paths refused with a reason', () => {
  let d = newEdits({ madeOn: 'b'.repeat(64) });
  d = setEdit(d, 'face.shapes.blush', 2);
  assert.equal(d.face.shapes.blush, 1);
  d = setEdit(d, 'face.colors.irisL', [0.2, 0.5, 1.5]);
  assert.deepEqual(d.face.colors.irisL, [0.2, 0.5, 1]);
  d = setEdit(d, 'face.headShape', 'heart');
  assert.equal(d.face.headShape, 'heart');
  d = setEdit(d, 'face.headShape', null);
  assert.equal('headShape' in d.face, false);
  d = setEdits(d, [['body.height', 0.3], ['body.slender', -0.2]]);
  assert.deepEqual(d.body, { height: 0.3, slender: -0.2 });
  d = setEdit(d, 'body.height', null);
  assert.deepEqual(d.body, { slender: -0.2 });
  assert.throws(() => setEdit(d, 'body.tail', 1), /no slider "tail"/);
  assert.throws(() => setEdit(d, 'face.colors.gold', [1, 1, 0]), /colour role/);
  assert.throws(() => setEdit(d, 'face.headShape', 'blob'), /head shape/);
  assert.match(editProblem('face.bones.head', 1), /only iris/);
  assert.equal(editProblem('face.morphs.EYE_Close_R', 0.5), null);
  assert.equal(editLabel('body.legLength'), 'Leg Length');
  assert.equal(editLabel('face.colors.hair'), 'Hair colour');
});

test('drawn hair: kept cleaned and bounded, removed when it has no strokes', () => {
  const strands = [{ points: [[0, 0.15, 0.08], [0, 0.1, 0.12], [9, 0, 0]] }, { points: [[0, 0, 0]] }];
  let d = setEdit(newEdits(), 'hairDesign', { groups: [{ id: 'g1', name: 'Fringe', cross: 'Square', params: { width: 1, bogus: 2 }, strands }] });
  const g = d.hairDesign.groups[0];
  assert.equal(g.cross, 'Flat');
  assert.equal(g.params.width, 0.06);
  assert.equal(g.params.bogus, undefined);
  assert.equal(g.strands.length, 1, 'a one-point stroke is not a stroke');
  assert.deepEqual(g.strands[0].points[2], [1, 0, 0], 'points are clamped to ±1 m of the head');
  d = setEdit(d, 'hairDesign', { groups: [{ id: 'g1', strands: [] }] });
  assert.equal('hairDesign' in d, false);
});

test('written for a bundle: version 7, this editor, no per-item fit, keys in the order EDITS.md shows; hashed as the bundle stores it', async () => {
  const doc = { body: { height: 0.1 }, items: { ['c'.repeat(64)]: { loose: 0.01 } }, face: { shapes: {} }, version: 6, format: 'vrmxa-edits', editor: 'old' };
  const out = editsForSave(doc, { editor: 'Test', madeOn: 'd'.repeat(64) });
  assert.deepEqual(Object.keys(out), ['format', 'version', 'editor', 'madeOn', 'face', 'body']);
  assert.equal(out.items, undefined);
  assert.equal(await editsHash(out), await sha256(jsonBytes(out)));
  assert.equal(editsChangeLook(readEdits(out).edits), true);
  assert.equal(editsChangeLook(readEdits(newEdits()).edits), false);
  assert.ok(changedPaths(newEdits(), out).includes('body.height'));
  assert.deepEqual(changedPaths(out, setEdit(out, 'face.shapes.noseY', 0.5)), ['face.shapes.noseY']);
});
