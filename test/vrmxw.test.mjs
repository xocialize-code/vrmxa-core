// .vrmxw, item format version 1: write, read, carry the licence, keep what isn't understood.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readItem, writeItem, touchItem, duplicateItem, itemToEntries, itemFromEntries, closetEntryFor, itemFromBareGlb, RefusedError } from '../src/vrmxw.js';
import { checkItem } from '../src/checker.js';
import { parseGlb, buildGlb } from '../src/glb.js';
import { sha256 } from '../src/hash.js';
import { fixture, same, codes } from './helpers.mjs';

const FILES = ['skinned-top', 'pinned-hat', 'state-sword', 'animated-staff'];

test('every item fixture reads and writes back to the same bytes', async () => {
  for (const f of FILES) {
    const bytes = fixture(`items/${f}.vrmxw`);
    const item = await readItem(bytes);
    assert.ok(same(await writeItem(item), bytes), f);
    const open = await itemToEntries(item);
    assert.ok(same(await writeItem(itemFromEntries(open.entries)), bytes), `${f} through the open form`);
  }
});

test('licence, listing and origin are carried through an edit and a save (LIC-4, ITM-8, ITM-9)', async () => {
  const item = await readItem(fixture('items/skinned-top.vrmxw'));
  const before = JSON.parse(JSON.stringify({ meta: item.manifest.meta, listing: item.manifest.listing, origin: item.manifest.origin }));
  item.manifest.name = 'Renamed top';
  touchItem(item);
  const again = await readItem(await writeItem(item));
  assert.equal(again.manifest.revision, 2);
  assert.deepEqual({ meta: again.manifest.meta, listing: again.manifest.listing, origin: again.manifest.origin }, before);
});

test('unknown manifest keys and extension files are kept (VRMXW §4, §10)', async () => {
  const item = await readItem(fixture('items/animated-staff.vrmxw'));
  item.manifest['x-future'] = { anything: [1, 2, 3] };
  const again = await readItem(await writeItem(item));
  assert.deepEqual(again.manifest['x-future'], { anything: [1, 2, 3] });
  assert.equal(new TextDecoder().decode(again.entries.get('extensions/x-xocialize.fixture-note/note.txt')), 'kept byte for byte\n');
  assert.ok(again.manifest.extensions['x-xocialize.fixture-note']);
});

test('a duplicate is a different item: new id, revision 1 (ITM-10)', async () => {
  const item = await readItem(fixture('items/pinned-hat.vrmxw'));
  const dup = duplicateItem(item);
  assert.notEqual(dup.manifest.id, item.manifest.id);
  assert.equal(dup.manifest.revision, 1);
  assert.deepEqual(await checkItem(await writeItem(dup)), []);
});

test('the closet entry copies the manifest fields and hashes the model (VRMXA §7.4)', async () => {
  const item = await readItem(fixture('items/state-sword.vrmxw'));
  const e = await closetEntryFor(item, { file: `closet/items/accessory-${item.manifest.id}.vrmxw` });
  assert.equal(e.model, await sha256(item.entries.get('model.glb')));
  assert.equal(e.bone, 'rightHand');
  assert.deepEqual(e.states, [{ name: 'held', bone: 'rightHand', tags: ['held:sword'] }, { name: 'stowed', bone: 'upperChest', tags: ['stowed:sword'] }]);
  assert.ok(!('fitting' in e), 'fine-tuning is the character\'s own and starts empty');
});

test('a bare GLB from the earlier tools is packed as version 1, its rig and licence read from extras (§14)', async () => {
  const top = await readItem(fixture('items/skinned-top.vrmxw'));
  const g = parseGlb(top.entries.get('model.glb'));
  g.json.asset.extras = { rig: { humanBones: top.manifest.rig.humanBones }, provenance: { extractedFrom: 'Someone.vrm', sourceMeta: { author: 'A, B', licenseUrl: 'https://vrm.dev/licenses/1.0/' } } };
  const item = await itemFromBareGlb(buildGlb(g.json, g.bin), { slot: 'tops', name: 'Old top' });
  assert.equal(item.manifest.type, 'top');
  assert.deepEqual(item.manifest.meta.authors, ['A', 'B']);
  assert.deepEqual(item.manifest.rig.humanBones, top.manifest.rig.humanBones);
  assert.equal(item.manifest.origin.source, 'Someone.vrm');
  const problems = await checkItem(await writeItem(item));
  assert.deepEqual(codes(problems), []);
  // a bare GLB as such is refused, with the way forward
  assert.ok(codes(await checkItem(top.entries.get('model.glb'))).includes('container.bare-glb'));
});

test('a hostile item is refused as a whole', async () => {
  await assert.rejects(readItem(fixture('hostile/item-external.vrmxw')), RefusedError);
});
