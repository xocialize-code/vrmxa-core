// The closet protocol (CLOSET.md §5): every operation, all or nothing, keeping C1 to C5 and C7, with
// the refusals of §3 for an app that can't fit and the slot rules of VRMXA §7.2. Uses the item
// fixtures, plus items made here from the top's model in other slots (bottoms, onepiece, shoes, hair).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBundle, readBundle, writeBundle, checkBundle, readItem, writeItem, createItem, parseGlb, buildGlb, sha256, setDocument } from '../src/index.js';
import {
  addItem, putOn, takeOff, setState, applyOutfit, outfitStatus, saveOutfit, makeOutfit, renameOutfit, duplicateOutfit, deleteOutfit,
  setFitting, changeHair, removeItem, copyOut, updateItem, closetSnapshot, restoreCloset, closetOf, ClosetError, slotProblems,
} from '../src/closet/index.js';
import { fixture, codes, same } from './helpers.mjs';

const META = { authors: ['Test'], licenseUrl: 'https://vrm.dev/licenses/1.0/' };
const TOP = fixture('items/skinned-top.vrmxw');
const HAT = fixture('items/pinned-hat.vrmxw');
const SWORD = fixture('items/state-sword.vrmxw');
const STAFF = fixture('items/animated-staff.vrmxw');

// a stand-in avatar: the minimal fixture's (a VRM 1.0 on the standard Spec)
const minimal = await readBundle(fixture('characters/minimal.vrmxa'));
const AVATAR = minimal.entries.get('avatar.vrm');
const newChar = () => createBundle({ avatar: AVATAR });

const topItem = await readItem(TOP);
const topModel = topItem.entries.get('model.glb');
const made = new Map();
async function makeItem(type, extra = {}) {
  const item = await createItem({ model: topModel, name: extra.name || `Test ${type}`, type, rig: topItem.manifest.rig, meta: META, ...extra });
  return writeItem(item);
}
const PANTS = await makeItem('pants');
const DRESS = await makeItem('dress');
const SHOES = await makeItem('shoes', { lift: 0.02 });
const HAIR = await makeItem('hair');
const idOf = async (bytes) => (await readItem(bytes)).manifest.id;

/** Write the bundle and check it: no errors (C1 to C5, C7, C8 as the checker sees them). */
async function holds(bundle, msg = '') {
  const bytes = await writeBundle(bundle);
  const problems = await checkBundle(bytes);
  assert.deepEqual(codes(problems), [], `${msg}: ${problems.filter((p) => p.severity === 'error').map((p) => p.message).join('; ')}`);
  return { bytes, problems };
}
const refused = async (p, code) => { await assert.rejects(p, (e) => e instanceof ClosetError && e.code === code, `expected ${code}`); };

test('add (§5.1): each kind of item goes in unchanged, as a spare; its picture and animations come with it', async () => {
  const b = newChar();
  for (const bytes of [TOP, HAT, SWORD, STAFF]) await addItem(b, bytes, { source: 'fixture.vrmxw' });
  const c = closetOf(b);
  assert.equal(c.items.length, 4);
  assert.deepEqual(c.worn.items, []); // spares
  for (const [bytes, e] of [[TOP, c.items[0]], [HAT, c.items[1]], [SWORD, c.items[2]], [STAFF, c.items[3]]]) {
    assert.ok(same(b.entries.get(e.file), bytes), `${e.name} stored byte for byte (C1)`);
    assert.equal(e.source, 'fixture.vrmxw');
  }
  assert.equal(c.items[0].thumbnail, `closet/thumbs/${c.items[0].id}.png`);
  assert.ok(b.entries.has(c.items[0].thumbnail));
  assert.deepEqual(c.items[2].states.map((s) => s.name), ['held', 'stowed']);
  // the staff brings a clip and a set, marked as its own (VRMXW §9, §12)
  const anim = b.docs.animations;
  assert.equal(anim.clips.length, 1);
  assert.equal(anim.clips[0].from, c.items[3].id);
  assert.ok(b.entries.has(anim.clips[0].file) && anim.clips[0].file.startsWith('animations/clips/'));
  assert.equal(anim.sets[0].from, c.items[3].id);
  assert.ok(anim.sets[0].id);
  await holds(b, 'after adding');
});

test('add refuses another base, a duplicate and a broken file, and leaves the bundle as it was', async () => {
  const b = newChar();
  await addItem(b, TOP);
  const before = await writeBundle(b);
  const other = await createItem({ model: topModel, name: 'Elsewhere', type: 'top', rig: topItem.manifest.rig, meta: META, base: { name: 'Other', species: 'human', sha256: 'a'.repeat(64) } });
  await refused(addItem(b, await writeItem(other)), 'refused'); // the checker refuses an unknown base before C2 is reached
  await refused(addItem(b, TOP), 'duplicate');
  await refused(addItem(b, new Uint8Array([1, 2, 3])), 'refused');
  assert.ok(same(await writeBundle(b), before));
});

test('a bare model is packed as a .vrmxw before it goes in (CLO-2, VRMXA §7.1)', async () => {
  const b = newChar();
  const g = parseGlb(topModel);
  const json = JSON.parse(JSON.stringify(g.json));
  json.asset.extras = { rig: topItem.manifest.rig, provenance: { role: 'Bare top', sourceMeta: { author: 'Someone', licenseUrl: 'https://vrm.dev/licenses/1.0/' } } };
  const r = await addItem(b, buildGlb(json, g.bin), { slot: 'tops', type: 'top', source: 'top.glb' });
  assert.equal(r.packed, true);
  const e = closetOf(b).items[0];
  assert.ok(e.file.endsWith('.vrmxw'));
  assert.equal((await readItem(b.entries.get(e.file))).manifest.slot, 'tops');
  await holds(b, 'bare model packed');
});

test('put on and take off (§5.2, §5.3) follow the slot rules and say what a swap took off (CLO-4, CLO-5)', async () => {
  const b = newChar();
  const [top, pants, dress, hat, sword] = [await idOf(TOP), await idOf(PANTS), await idOf(DRESS), await idOf(HAT), await idOf(SWORD)];
  for (const x of [TOP, PANTS, DRESS, HAT, SWORD]) await addItem(b, x);
  assert.deepEqual((await putOn(b, top)).removed, []);
  assert.deepEqual((await putOn(b, pants)).removed, []);
  await putOn(b, hat);
  await putOn(b, sword); // accessories: any number
  assert.deepEqual(closetOf(b).worn.items, [top, pants, hat, sword]);
  // a one-piece takes off the top and the trousers
  assert.deepEqual((await putOn(b, dress)).removed.sort(), [top, pants].sort());
  assert.deepEqual(closetOf(b).worn.items, [hat, sword, dress]);
  // the top back on takes the dress off, and leaves her without trousers: the protocol doesn't put them back (§7)
  assert.deepEqual((await putOn(b, top)).removed, [dress]);
  assert.ok(!closetOf(b).worn.items.includes(pants));
  // spec-fit asked for and used: recorded in the fine-tuning (VRMXA §7.5 `method`)
  assert.equal(closetOf(b).items.find((e) => e.id === top).fitting.method, 'spec-fit');
  assert.equal(closetOf(b).items.find((e) => e.id === hat).fitting, undefined); // pin is its own method
  assert.deepEqual(await takeOff(b, hat), { taken: true });
  assert.deepEqual(await takeOff(b, hat), { taken: false });
  await holds(b, 'after swapping');
  await refused(putOn(b, '00000000-0000-4000-8000-000000000000'), 'not-in-closet');
});

test('states (§5.4): recorded for worn items only, the default not written, an unknown one refused (C5)', async () => {
  const b = newChar();
  const sword = await idOf(SWORD);
  await addItem(b, SWORD);
  await refused(setState(b, sword, 'stowed'), 'not-worn');
  await putOn(b, sword, { state: 'stowed' });
  assert.equal(closetOf(b).worn.states[sword], 'stowed');
  await setState(b, sword, 'held');
  assert.deepEqual(closetOf(b).worn.states, {}); // held is the first state: the default
  await refused(setState(b, sword, 'thrown'), 'no-state');
  await setState(b, sword, 'stowed');
  await takeOff(b, sword);
  assert.deepEqual(closetOf(b).worn.states, {});
  await holds(b, 'states');
});

test('outfits (§5.5, §5.12): save, apply, rename, duplicate, update and delete; a shortcut, not a lock (CLO-3, CLO-12)', async () => {
  const b = newChar();
  const [top, pants, dress, sword, hat] = [await idOf(TOP), await idOf(PANTS), await idOf(DRESS), await idOf(SWORD), await idOf(HAT)];
  for (const x of [TOP, PANTS, DRESS, SWORD, HAT]) await addItem(b, x);
  await putOn(b, top); await putOn(b, pants); await putOn(b, sword, { state: 'stowed' });
  const { id: adv } = await saveOutfit(b, 'Adventurer');
  let c = closetOf(b);
  assert.deepEqual(c.outfits[0].items, [top, pants, sword]);
  assert.deepEqual(c.outfits[0].states, { [sword]: 'stowed' });
  assert.deepEqual(outfitStatus(c), { outfit: adv, name: 'Adventurer', changed: false });
  const { id: eve } = await makeOutfit(b, { name: 'Evening', items: [dress, hat] });
  await refused(makeOutfit(b, { name: 'Bad', items: [dress, top] }), 'slot');
  // applying replaces everything worn, not only the slots it covers
  const r = await applyOutfit(b, eve);
  assert.deepEqual(closetOf(b).worn.items, [dress, hat]);
  assert.deepEqual(r.removed.sort(), [top, pants, sword].sort());
  assert.equal(closetOf(b).worn.outfit, eve);
  // putting the sword on afterwards changes what is worn and leaves the outfit as it was
  await putOn(b, sword);
  c = closetOf(b);
  assert.deepEqual(c.outfits.find((o) => o.id === eve).items, [dress, hat]);
  assert.deepEqual(outfitStatus(c), { outfit: eve, name: 'Evening', changed: true });
  // applying one that records the sword stowed puts it on stowed
  await applyOutfit(b, adv);
  assert.equal(closetOf(b).worn.states[sword], 'stowed');
  await renameOutfit(b, adv, 'Explorer');
  const { id: copy } = await duplicateOutfit(b, adv);
  c = closetOf(b);
  assert.equal(c.outfits.find((o) => o.id === copy).name, 'Explorer (copy)');
  assert.deepEqual(c.outfits.find((o) => o.id === copy).items, [top, pants, sword]);
  // update from what is worn
  await takeOff(b, pants);
  await saveOutfit(b, null, { over: copy });
  assert.deepEqual(closetOf(b).outfits.find((o) => o.id === copy).items, [top, sword]);
  // deleting the outfit last applied clears the hint and leaves what is worn alone
  assert.equal(closetOf(b).worn.outfit, copy);
  await deleteOutfit(b, copy);
  c = closetOf(b);
  assert.equal(c.worn.outfit, null);
  assert.deepEqual(c.worn.items, [top, sword]);
  await holds(b, 'outfits');
});

test('fine-tuning (§5.6, VRMXA §7.5): stored in closet.json, clamped, never in the item; unknown controls refused', async () => {
  const b = newChar();
  const top = await idOf(TOP);
  await addItem(b, TOP);
  const r = await setFitting(b, top, { auto: true, rule: { ease: 'relaxed' }, adjust: { loose: 0.004, size: 2, up: 0 } });
  assert.deepEqual(r.fitting, { auto: true, rule: { ease: 'relaxed' }, adjust: { loose: 0.004, size: 1.15 } });
  await setFitting(b, top, { adjust: { up: 0.01 } }, { merge: true });
  assert.deepEqual(closetOf(b).items[0].fitting.adjust, { loose: 0.004, size: 1.15, up: 0.01 });
  await refused(setFitting(b, top, { adjust: { twist: 1 } }), 'fitting');
  await refused(setFitting(b, top, { rule: { ease: 'baggy' } }), 'fitting');
  assert.ok(same(copyOut(b, top), TOP), 'the item file is untouched (C1)');
  await setFitting(b, top, null);
  assert.equal(closetOf(b).items[0].fitting, undefined);
  await holds(b, 'fine-tuning');
});

test('hair (§5.7): a hair piece only, kept apart from what is worn and from outfits', async () => {
  const b = newChar();
  const [hair, top] = [await idOf(HAIR), await idOf(TOP)];
  await addItem(b, HAIR); await addItem(b, TOP);
  assert.ok(closetOf(b).items[0].file.startsWith('appearance/hair/hair-'));
  await changeHair(b, hair);
  assert.equal(closetOf(b).hair, hair);
  await refused(changeHair(b, top), 'not-hair');
  await refused(putOn(b, hair), 'is-hair');
  await putOn(b, top);
  const { id } = await saveOutfit(b, 'Plain');
  await changeHair(b, null);
  await applyOutfit(b, id);
  assert.equal(closetOf(b).hair, null, 'an outfit never changes the hair');
  assert.equal(slotProblems(closetOf(b), [hair]).length, 1);
  await holds(b, 'hair');
});

test('remove (§5.8): refused while worn unless taken off; leaves outfits; its animations go with it (C7)', async () => {
  const b = newChar();
  const [staff, top] = [await idOf(STAFF), await idOf(TOP)];
  await addItem(b, STAFF); await addItem(b, TOP);
  await putOn(b, staff); await putOn(b, top);
  await saveOutfit(b, 'With staff');
  await refused(removeItem(b, staff), 'worn');
  await refused(removeItem(b, staff, { takeOff: true, canFit: false }), 'needs-fitting');
  const r = await removeItem(b, staff, { takeOff: true });
  const c = closetOf(b);
  assert.equal(r.outfits.length, 1);
  assert.deepEqual(c.outfits[0].items, [top]);
  assert.ok(!c.items.some((e) => e.id === staff));
  assert.ok(![...b.entries.keys()].some((p) => p.includes(staff)));
  assert.deepEqual(b.docs.animations.sets, []);
  assert.deepEqual(b.docs.animations.clips, []);
  await holds(b, 'after removing');
});

test('remove keeps a clip an edited set still uses, as the character\'s own (§5.8 step 3)', async () => {
  const b = newChar();
  const staff = await idOf(STAFF);
  await addItem(b, STAFF);
  const anim = JSON.parse(JSON.stringify(b.docs.animations));
  const clip = anim.clips[0].sha256;
  // the person made the brought set their own (its `from` cleared) and a default set uses the clip
  anim.sets[0] = { ...anim.sets[0] }; delete anim.sets[0].from;
  anim.sets.push({ id: 'd0000000-0000-4000-8000-000000000001', name: 'Default', default: true, priority: 0, requires: [], slots: { idle: [{ clip }] } });
  setDocument(b, 'animations', anim);
  await removeItem(b, staff);
  assert.equal(b.docs.animations.clips.length, 1);
  assert.equal(b.docs.animations.clips[0].from, undefined);
  assert.ok(b.entries.has(b.docs.animations.clips[0].file));
  await holds(b, 'clip kept');
});

test('copy out (§5.9): the file exactly as it arrived, the bundle untouched', async () => {
  const b = newChar();
  await addItem(b, SWORD);
  const sword = await idOf(SWORD);
  await putOn(b, sword, { state: 'stowed' });
  await setFitting(b, sword, { adjust: { up: 0.01 } });
  const before = await writeBundle(b);
  assert.ok(same(copyOut(b, sword), SWORD));
  assert.ok(same(await writeBundle(b), before));
});

test('update in place (§5.11, CLO-9): a newer revision, fine-tuning kept; worn needs fitting; animations replaced', async () => {
  const b = newChar();
  const staffItem = await readItem(STAFF);
  await addItem(b, STAFF);
  const id = staffItem.manifest.id;
  await setFitting(b, id, { adjust: { size: 1.05 } });
  const next = await readItem(STAFF);
  next.manifest.revision = 2;
  next.manifest.name = 'Staff, recoloured';
  next.manifest.animations = { ...next.manifest.animations, sets: [{ ...next.manifest.animations.sets[0], name: 'Staff 2' }] };
  const nextBytes = await writeItem(next);
  await refused(updateItem(b, STAFF), 'revision');
  const r = await updateItem(b, nextBytes);
  assert.deepEqual(r, { id, revision: 2, worn: false, outfitsChanged: [] });
  const e = closetOf(b).items[0];
  assert.equal(e.name, 'Staff, recoloured');
  assert.deepEqual(e.fitting, { adjust: { size: 1.05 } });
  assert.deepEqual(b.docs.animations.sets.map((s) => s.name), ['Staff 2']);
  assert.ok(same(copyOut(b, id), nextBytes));
  // worn: an app that can't fit may not
  await putOn(b, id);
  next.manifest.revision = 3;
  await refused(updateItem(b, await writeItem(next), { canFit: false }), 'needs-fitting');
  assert.equal((await updateItem(b, await writeItem(next))).worn, true);
  await holds(b, 'updated');
});

test('update in place: a state the new revision lacks falls back to the default, worn and in outfits (§5.11, decided 2026-11-16)', async () => {
  const b = newChar();
  const sword = await readItem(SWORD);
  const id = sword.manifest.id;
  await addItem(b, SWORD);
  await putOn(b, id);
  const stowed = sword.manifest.states.at(-1).name;
  await setState(b, id, stowed);
  await saveOutfit(b, 'Travelling');
  assert.equal(closetOf(b).worn.states[id], stowed);
  const next = await readItem(SWORD);
  next.manifest.revision = (next.manifest.revision ?? 1) + 1;
  next.manifest.states = next.manifest.states.filter((st) => st.name !== stowed);
  const r = await updateItem(b, await writeItem(next));
  assert.deepEqual(r.outfitsChanged, ['Travelling']);
  assert.equal(closetOf(b).worn.states[id], undefined, 'worn: back to the default state');
  assert.equal(closetOf(b).outfits[0].states?.[id], undefined, 'the outfit too, so C5 holds');
  await holds(b, 'updated with a state gone');
});

test('an app that can\'t fit (CLOSET.md §3, §7): changes to the look refused, everything else allowed, the look unchanged', async () => {
  const b = newChar();
  const [top, sword, dress, hair] = [await idOf(TOP), await idOf(SWORD), await idOf(DRESS), await idOf(HAIR)];
  for (const x of [TOP, SWORD, DRESS, HAIR]) await addItem(b, x);
  await putOn(b, top); await putOn(b, sword);
  const { id: outfit } = await saveOutfit(b, 'Day');
  const look = () => { const c = closetOf(b); return JSON.stringify([c.hair, c.worn.items, c.worn.states, c.items.filter((e) => e.id !== dress).map((e) => e.fitting ?? null)]); };
  const before = look();
  const noFit = { canFit: false };
  // the seven refusals of §7
  await refused(putOn(b, dress, noFit), 'needs-fitting');
  await refused(takeOff(b, top, noFit), 'needs-fitting');
  await refused(applyOutfit(b, outfit, noFit), 'needs-fitting');
  await refused(setState(b, sword, 'stowed', noFit), 'needs-fitting');
  await refused(setFitting(b, top, { adjust: { up: 0.01 } }, noFit), 'needs-fitting');
  await refused(changeHair(b, hair, noFit), 'needs-fitting');
  await refused(removeItem(b, top, { takeOff: true, ...noFit }), 'needs-fitting');
  // allowed: outfits, fine-tuning a spare, adding, removing a spare
  await makeOutfit(b, { name: 'Party', items: [dress] }, noFit);
  await setFitting(b, dress, { adjust: { loose: 0.002 } }, noFit);
  assert.equal(look(), before, 'the saved look is unchanged');
  await removeItem(b, hair, noFit);
  assert.deepEqual(closetOf(b).worn.items, [top, sword]);
  await holds(b, 'no-fit app');
});

test('undo: a snapshot puts the closet, its files and its animations back', async () => {
  const b = newChar();
  await addItem(b, TOP);
  const snap = closetSnapshot(b);
  const before = await writeBundle(b);
  await addItem(b, STAFF);
  await putOn(b, await idOf(STAFF));
  await removeItem(b, await idOf(TOP));
  restoreCloset(b, snap);
  assert.ok(same(await writeBundle(b), before));
});

test('a change that leaves the look alone keeps avatar.vrm current; one that changes it marks it stale until redrawn', async () => {
  const b = newChar();
  await holds(b, 'new');
  await addItem(b, TOP);
  let { problems } = await holds(b, 'spare added');
  assert.ok(!codes(problems, 'warning').includes('bundle.avatar-stale'), 'adding a spare writes the new closet hash (VRMXA §4)');
  const read = await readBundle(await writeBundle(b));
  await makeOutfit(read, { name: 'Empty', items: [] });
  ({ problems } = await holds(read, 'outfit made on a read bundle'));
  assert.ok(!codes(problems, 'warning').includes('bundle.avatar-stale'));
  const of = read.manifest.avatar.of.closet;
  assert.equal(of, await sha256(read.entries.get('closet/closet.json')));
  await putOn(read, await idOf(TOP));
  ({ problems } = await holds(read, 'worn'));
  assert.ok(codes(problems, 'warning').includes('bundle.avatar-stale'), 'not redrawn: the checker says so (C6)');
  assert.equal(read.manifest.avatar.of.closet, of, 'avatar.of still names what avatar.vrm was made from');
});
