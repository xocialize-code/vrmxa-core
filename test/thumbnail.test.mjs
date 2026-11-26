// A character's thumbnail drawn in plain JavaScript (character/thumbnail.js), and a shared copy's thumbnail drawn again
// without the worn pieces it leaves out (release plan, blocker 6; VRMXA §3.3, PRD EXP-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, specVrm, noSpec, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle, readItem, writeItem, buildGlb, setEntry } from '../src/index.js';
import { decodePng } from '../src/edit/png.js';
import * as closetOps from '../src/closet/index.js';
import * as ch from '../src/character/index.js';

const full = () => readBundle(fixture('characters/full.vrmxa'));
const avatar = (b) => b.entries.get(b.manifest.avatar?.file || 'avatar.vrm');
const ITEM = '0f0e0d0c-0b0a-4908-8706-050403020100';

async function restrictedTop() {
  const item = await readItem(fixture('items/skinned-top.vrmxw'));
  item.manifest.id = ITEM;
  item.manifest.name = 'Borrowed top';
  item.manifest.meta = { authors: ['Someone Else'], licenseUrl: 'https://example.com/licence' };   // no passing on
  return writeItem(item);
}

const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
/** How many pixels differ between two pictures of the same size, in a band of rows. */
function differing(a, b, y0 = 0, y1 = a.height) {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < a.width; x++) {
    const o = (y * a.width + x) * 4;
    if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) + Math.abs(a.data[o + 3] - b.data[o + 3]) > 24) n++;
  }
  return n;
}

test('the bust camera matches the stage\'s framing: the head bone 0.62 m tall in 92% of the picture, from the front', () => {
  const c = ch.bustCamera([0, 1.4, 0]);
  const visible = 0.62 / 0.92;
  assert.ok(Math.abs(2 * c.distance * c.tanHalf - visible) < 1e-9);
  assert.deepEqual(c.forward.map((v) => Math.round(v * 1e6) / 1e6), [0, 0, -1]);
  assert.ok(Math.abs(c.position[1] - (1.4 - 0.03 - (0.46 - 0.5) * visible)) < 1e-9, 'aimed as framing.js aims it');
  assert.ok(c.position[2] > 0, 'in front of a VRM 1.0 model, which faces +Z');
  assert.ok(ch.bustCamera([0, 1.4, 0], [0, 0, -1]).position[2] < 0, 'and in front of a VRM 0.x model, which faces −Z');
});

test('Spec\'s thumbnail: 512 px, the face in the middle, the background clear', { skip: noSpec }, () => {
  const png = ch.drawThumbnail(specVrm());
  const img = decodePng(png);
  assert.equal(img.width, 512);
  assert.equal(img.height, 512);
  assert.equal(alphaAt(img, 4, 4), 0, 'a corner is transparent');
  assert.equal(alphaAt(img, 256, 200), 255, 'the face is drawn');
  const o = (200 * 512 + 256) * 4;
  assert.ok(img.data[o] > 200 && img.data[o] > img.data[o + 2], 'in skin colour, from the texture');
  assert.deepEqual(ch.drawThumbnail(specVrm()), png, 'the same model gives the same bytes');
  assert.equal(ch.drawThumbnail(specVrm(), { size: 128 }).length < png.length, true);
});

test('a model with no head bone has no bust to frame: no thumbnail', () => {
  const glb = buildGlb({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] });
  assert.equal(ch.drawThumbnail(glb), null);
});

test('a shared copy that takes a worn piece off draws its thumbnail again from its own avatar.vrm', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await closetOps.addItem(b, await restrictedTop(), { spec });
  await closetOps.putOn(b, ITEM, { redraw: { spec } });
  // the character's own thumbnail shows the top
  const old = ch.drawThumbnail(avatar(b));
  setEntry(b, 'thumbnail.png', old);
  b.manifest.thumbnail = 'thumbnail.png';

  const r = await ch.shareCopy(b, { spec });
  assert.ok(r.notes.some((n) => /"Borrowed top" is left out and taken off/.test(n)));
  assert.ok(r.notes.some((n) => /avatar\.vrm and thumbnail were drawn again without what was taken off/.test(n)));
  const copy = await readBundle(r.bytes);
  const thumb = copy.entries.get(copy.manifest.thumbnail);
  assert.ok(thumb, 'the copy has a thumbnail');
  assert.notDeepEqual(thumb, old, 'not the old one');
  assert.deepEqual(thumb, ch.drawThumbnail(avatar(copy)), 'drawn from the copy\'s avatar.vrm');
  // the top shows in the old picture's chest and is gone from the copy's
  const before = decodePng(old), after = decodePng(thumb);
  assert.ok(differing(before, after, 330, 512) > 2000, 'the chest differs');
  assert.ok(differing(after, decodePng(ch.drawThumbnail(spec)), 330, 512) < differing(before, decodePng(ch.drawThumbnail(spec)), 330, 512), 'the copy\'s chest is closer to the bare figure');
  assert.deepEqual(codes(await checkBundle(r.bytes, { spec })).filter((c) => c === 'bundle.thumbnail'), []);
  assert.deepEqual(b.entries.get('thumbnail.png'), old, 'the character itself is unchanged');
});

test('a shared copy whose thumbnail can\'t be drawn has none, never the old one', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await closetOps.addItem(b, await restrictedTop(), { spec });
  await closetOps.putOn(b, ITEM, { redraw: { spec } });
  setEntry(b, 'thumbnail.png', ch.drawThumbnail(avatar(b)));
  b.manifest.thumbnail = 'thumbnail.png';
  for (const drawThumbnail of [async () => null, async () => { throw new Error('no GPU'); }]) {
    const r = await ch.shareCopy(b, { spec, drawThumbnail });
    const copy = await readBundle(r.bytes);
    assert.equal(copy.manifest.thumbnail, null);
    assert.ok(![...copy.entries.keys()].some((p) => /^thumbnail\./.test(p)), 'no thumbnail entry');
    assert.ok(r.notes.some((n) => /couldn't be drawn, so the copy has none rather than the old one/.test(n)));
  }
  // a drawing the caller gives (the app's) is used as it is
  const mark = ch.drawThumbnail(spec, { size: 64 });
  const r = await ch.shareCopy(b, { spec, drawThumbnail: async (vrm, copy) => { assert.ok(vrm.length > 1000 && copy.manifest); return mark; } });
  assert.deepEqual((await readBundle(r.bytes)).entries.get('thumbnail.png'), mark);
});

test('a shared copy that leaves nothing worn out keeps the character\'s thumbnail', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  const mine = ch.drawThumbnail(avatar(b), { size: 96 });
  setEntry(b, 'thumbnail.png', mine);
  b.manifest.thumbnail = 'thumbnail.png';
  const r = await ch.shareCopy(b, { spec, drawThumbnail: async () => assert.fail('nothing to draw again') });
  assert.deepEqual((await readBundle(r.bytes)).entries.get('thumbnail.png'), mine);
  assert.ok(!r.notes.some((n) => /thumbnail/.test(n)));
  await writeBundle(b);
});

test('vrmxa share draws the copy\'s thumbnail again from the command line', { skip: noSpec }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ROOT } = await import('./helpers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-thumb-'));
  try {
    const spec = specVrm();
    const b = await full();
    await closetOps.addItem(b, await restrictedTop(), { spec });
    await closetOps.putOn(b, ITEM, { redraw: { spec } });
    const old = ch.drawThumbnail(avatar(b));
    setEntry(b, 'thumbnail.png', old);
    b.manifest.thumbnail = 'thumbnail.png';
    writeFileSync(join(dir, 'in.vrmxa'), await writeBundle(b));
    const r = spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), 'share', join(dir, 'in.vrmxa'), join(dir, 'out.vrmxa'), '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(JSON.parse(r.stdout).notes.some((n) => /thumbnail were drawn again/.test(n)));
    const copy = await readBundle(new Uint8Array(readFileSync(join(dir, 'out.vrmxa'))));
    const thumb = copy.entries.get(copy.manifest.thumbnail);
    assert.notDeepEqual(thumb, old);
    assert.deepEqual(thumb, ch.drawThumbnail(avatar(copy)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
