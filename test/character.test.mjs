// Phase 7: a character's details, licence and origin (LIC-1 to LIC-4), honouring licences (HON-1, HON-2, HON-4), and
// export and share (CHR-6, EXP-2 to EXP-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, specVrm, noSpec, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle, checkModel, parseGlb, createBundle, standardBase, readItem, writeItem } from '../src/index.js';
import { newEdits, bakeAvatar } from '../src/edit/index.js';
import * as closetOps from '../src/closet/index.js';
import * as ch from '../src/character/index.js';
import { addVoice } from '../src/voice/index.js';
import { tone } from './tone.mjs';

const full = () => readBundle(fixture('characters/full.vrmxa'));
const metaOf = (bytes) => parseGlb(bytes).json.extensions.VRMC_vrm.meta;
const avatar = (b) => b.entries.get('avatar.vrm');

// an item with terms that don't allow passing it on or changing it (VRM's defaults: it states none)
async function restrictedItem(name = 'Thigh boots') {
  const item = await readItem(fixture('items/skinned-top.vrmxw'));
  item.manifest.id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  item.manifest.name = name;
  item.manifest.meta = { authors: ['Someone Else'], licenseUrl: 'https://example.com/licence' };
  return writeItem(item);
}

test('a new character starts at the most restricted permissions, not Spec\'s (LIC-3)', { skip: noSpec }, async () => {
  const meta = ch.newCharacterMeta({ name: 'Nova', authors: ['Xocialize LLC'] });
  for (const [k, v] of Object.entries(ch.RESTRICTED)) assert.equal(meta[k], v, k);
  const spec = specVrm();
  assert.equal(metaOf(spec).allowRedistribution, true, 'Spec itself allows passing on');
  const av = bakeAvatar(spec, newEdits(), { meta, metaMode: 'replace' }).bytes;
  const m = metaOf(av);
  assert.equal(m.allowRedistribution, false);
  assert.equal(m.commercialUsage, 'personalNonProfit');
  assert.equal(m.allowExcessivelyViolentUsage, false);
  assert.equal(m.copyrightInformation, undefined, 'nothing of Spec\'s details is left behind');
  assert.equal(m.thumbnailImage, metaOf(spec).thumbnailImage, 'Spec\'s thumbnail picture is kept');
  const b = createBundle({ avatar: av, base: standardBase('human') });
  assert.equal(ch.detailsOf(b).chosen, null, 'the permissions are not chosen yet');
});

test('details are edited in avatar.vrm\'s meta, the binary chunk untouched; the manifest follows (LIC-1)', async () => {
  const b = await full();
  const binBefore = parseGlb(avatar(b)).bin;
  const d = await ch.setDetails(b, { name: 'Mira Vale', version: '1.2', authors: ['Xocialize LLC', 'A. Maker'], contactInformation: 'studio@example.com', copyrightInformation: null, commercialUsage: 'personalProfit' }, { now: '2026-11-17T10:00:00.000Z' });
  assert.equal(d.meta.name, 'Mira Vale');
  assert.equal(d.meta.version, '1.2');
  assert.equal(d.meta.copyrightInformation, undefined);
  assert.equal(d.chosen, '2026-11-17T10:00:00.000Z', 'setting a permission records that they were chosen');
  assert.equal(b.manifest.title, 'Mira Vale');
  assert.equal(b.manifest.author, 'Xocialize LLC, A. Maker');
  assert.deepEqual(Buffer.compare(Buffer.from(parseGlb(avatar(b)).bin), Buffer.from(binBefore)), 0);
  const again = await readBundle(await writeBundle(b));
  assert.equal(ch.detailsOf(again).meta.contactInformation, 'studio@example.com');
  assert.equal(ch.detailsOf(again).chosen, '2026-11-17T10:00:00.000Z');
  await assert.rejects(ch.setDetails(b, { authors: [] }), /maker/);
  await assert.rejects(ch.setDetails(b, { commercialUsage: 'free' }), /commercialUsage/);
  await assert.rejects(ch.setDetails(b, { price: 3 }), /not one of the character's details/);
});

test('origin: url, marketplace and listing id, no price (LIC-2)', async () => {
  const b = await full();
  assert.deepEqual(await ch.setListing(b, { url: 'https://example.com/m', marketplace: 'Booth', listing_id: '77' }), { url: 'https://example.com/m', marketplace: 'Booth', listing_id: '77' });
  await assert.rejects(ch.setListing(b, { url: 'x', price: 12 }), /no price/);
  assert.equal(await ch.setListing(b, null), null);
  const again = await readBundle(await writeBundle(b));
  assert.equal(ch.detailsOf(again).listing, null);
  assert.equal(again.database.persona.name, 'Mira', 'the persona is kept when the origin changes');
});

test('every avatar.vrm drawn afterwards carries the details whole, and each piece its licence (LIC-4)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await ch.setDetails(b, { name: 'Mira Vale', contactInformation: 'studio@example.com', copyrightInformation: null, references: ['https://example.com/mira'] });
  await closetOps.redrawAvatar(b, { spec });
  const m = metaOf(avatar(b));
  assert.equal(m.name, 'Mira Vale');
  assert.equal(m.contactInformation, 'studio@example.com');
  assert.equal(m.copyrightInformation, undefined, 'a removed field does not come back from Spec');
  assert.deepEqual(m.references, ['https://example.com/mira']);
  const pieces = parseGlb(avatar(b)).json.extras.vrmxaPieces;
  assert.equal(pieces.length, 2);
  for (const p of pieces) assert.ok(p.meta?.authors?.length && p.meta.licenseUrl, `${p.name} carries its licence`);
});

test('a character\'s permissions are never looser than a worn piece allows (§5.3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await ch.setDetails(b, { allowRedistribution: false }, { limits: false });
  await closetOps.addItem(b, await restrictedItem(), { spec });
  await closetOps.putOn(b, '0f0e0d0c-0b0a-4908-8706-050403020100', { redraw: { spec } });
  const lim = ch.permissionLimits(b);
  assert.equal(lim.allowRedistribution.loosest, false);
  assert.ok(lim.allowRedistribution.by.some((p) => p.name === 'Thigh boots'));
  await assert.rejects(ch.setDetails(b, { allowRedistribution: true }), /Thigh boots/);
  await ch.setDetails(b, { commercialUsage: 'personalNonProfit' }); // stricter is always fine
});

test('the questions before wearing a piece name it and the term, and an answer is kept (HON-1)', async () => {
  const b = await full();
  await closetOps.addItem(b, await restrictedItem());
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const q = ch.questionsBeforeWearing(b, [id]);
  assert.deepEqual(q.map((x) => x.term), ['modification', 'redistribution']);
  assert.match(q[0].text, /"Thigh boots": Someone Else doesn't allow changes/);
  assert.match(q[1].text, /doesn't allow passing it on/);
  assert.deepEqual(ch.questionsBeforeWearing(b, b.docs.closet.items.filter((e) => e.id !== id).map((e) => e.id)), [], 'the fixture\'s own items allow both');
  const [k, v] = ch.answerSetting(id, ['modification', 'redistribution'], { now: '2026-11-17T00:00:00.000Z' });
  await ch.setSetting(b, k, v);
  assert.deepEqual(ch.questionsBeforeWearing(b, [id]), []);
  assert.equal(ch.termsToAsk({ id: 'x', name: 'Coat', meta: { authors: ['A'], licenseUrl: 'u' } }, { action: 'import' })[0].text.includes('moves it onto Spec'), true);
});

test('credits list the makers of every piece that asks for credit (HON-4)', async () => {
  const b = await full();
  await closetOps.addItem(b, await restrictedItem());
  await addVoice(b, { name: 'Hum', origin: 'imported', realPerson: false, source: 'test tone', clips: [{ bytes: tone(4, 24000), transcript: 'A test tone, not speech.' }] });
  const c = ch.credits(b, { baseMeta: metaOf(specVrm()) });
  const someone = c.makers.find((m) => m.maker === 'Someone Else');
  assert.deepEqual(someone.pieces.map((p) => p.name), ['Thigh boots']);
  const studio = c.makers.find((m) => m.maker === 'VRMXA Avatar Studio');
  assert.deepEqual(studio.pieces.map((p) => [p.kind, p.name]), [['voice', 'Hum']], 'a new voice asks for credit by default');
  assert.ok(!c.makers.some((m) => m.pieces.some((p) => p.kind === 'base')), 'Spec asks for none');
  assert.ok(c.lines.includes('Motions: CC0'));
});

test('a plain VRM for yourself is avatar.vrm; for sharing, pieces that may not be passed on are left out (CHR-6, EXP-3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await closetOps.redrawAvatar(b, { spec });
  const mine = await ch.exportVrm(b, { spec });
  assert.equal(mine.drawn, false);
  // the same model as avatar.vrm; Mira's permissions were never chosen and are Spec's, so they go out as nothing allowed (LIC-3)
  assert.equal(Buffer.compare(Buffer.from(parseGlb(mine.bytes).bin), Buffer.from(parseGlb(avatar(b)).bin)), 0);
  assert.equal(mine.permissions, 'restricted', 'redrawn as shown: nothing allowed');
  assert.equal(metaOf(mine.bytes).allowRedistribution, false);
  assert.deepEqual(codes(checkModel(mine.bytes, { kind: 'vrm' }).problems), []);
  await closetOps.addItem(b, await restrictedItem(), { spec });
  await closetOps.putOn(b, '0f0e0d0c-0b0a-4908-8706-050403020100', { redraw: { spec } });
  const shared = await ch.exportVrm(b, { spec, forSharing: true });
  assert.equal(shared.drawn, true);
  assert.deepEqual(shared.leftOut.map((x) => x.name), ['Thigh boots']);
  const pieces = parseGlb(shared.bytes).json.extras.vrmxaPieces.map((p) => p.name);
  assert.ok(!pieces.includes('Thigh boots') && pieces.includes('Fixture sword'), pieces.join());
  assert.equal(metaOf(shared.bytes).name, 'Mira', 'the character\'s details are carried');
  assert.deepEqual(codes(shared.problems), []);
  assert.ok(b.docs.closet.worn.items.includes('0f0e0d0c-0b0a-4908-8706-050403020100'), 'the character itself is unchanged');
  const leaves = ch.vrmLeavesOut(b);
  assert.ok(leaves.some((l) => /No voice/.test(l)) && leaves.some((l) => /No persona/.test(l)) && leaves.some((l) => /No motions/.test(l)));
});

test('an item exports as its .vrmxw, exactly as it arrived (EXP-3)', async () => {
  const b = await full();
  const id = b.docs.closet.items[0].id;
  const r = await ch.exportItem(b, id);
  assert.equal(r.bytes, closetOps.copyOut(b, id));
  assert.deepEqual(codes(r.problems), []);
});

test('a shared copy leaves out a voice and an item that may not be passed on, says so, and passes the checker (EXP-2, HON-2)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await closetOps.addItem(b, await restrictedItem(), { spec });
  await closetOps.putOn(b, '0f0e0d0c-0b0a-4908-8706-050403020100', { redraw: { spec } });
  const kept = await addVoice(b, { name: 'Private hum', origin: 'imported', realPerson: false, source: 'test tone', clips: [{ bytes: tone(5, 24000), transcript: 'Another test tone.' }] });
  const [k, v] = ch.answerSetting('0f0e0d0c-0b0a-4908-8706-050403020100', ['modification', 'redistribution']);
  await ch.setSetting(b, k, v);
  const before = { id: b.manifest.id, fileId: b.manifest.fileId };

  const same = await ch.shareCopy(b, { spec });
  assert.equal(same.sameCharacter, true);
  assert.equal(same.bundle.manifest.id, before.id);
  assert.notEqual(same.bundle.manifest.fileId, before.fileId);
  assert.ok(same.notes.some((n) => /keys its data by character alone will treat the copy as the same character/.test(n)));
  assert.ok(same.notes.some((n) => /The voice "Private hum" is left out/.test(n)));
  assert.ok(same.notes.some((n) => /"Thigh boots" is left out and taken off/.test(n)));
  const copy = await readBundle(same.bytes);
  assert.deepEqual(copy.docs.voices.voices.map((x) => x.name), ['Mira'], 'the voice that may be passed on goes');
  assert.ok(![...copy.entries.keys()].some((p) => p.includes(kept.voice.clips[0].file.slice(12))), 'its clip is gone');
  assert.ok(!copy.docs.closet.items.some((e) => e.name === 'Thigh boots'));
  assert.ok(!parseGlb(copy.entries.get('avatar.vrm')).json.extras.vrmxaPieces.some((p) => p.name === 'Thigh boots'));
  assert.ok(!Object.keys(copy.database.settings).some((s) => s.startsWith(ch.HONOURED_PREFIX)), 'the person\'s answers stay with them');
  assert.deepEqual(codes(await checkBundle(same.bytes, { spec })), []);
  assert.ok(b.docs.voices.voices.some((x) => x.name === 'Private hum'), 'the character itself is unchanged');

  const fresh = await ch.shareCopy(b, { spec, newIdentity: true });
  assert.equal(fresh.sameCharacter, false);
  assert.notEqual(fresh.bundle.manifest.id, before.id);
  assert.ok(fresh.notes.some((n) => /new identity/.test(n)));
});

test('permissions never chosen: Spec\'s are shown and written as nothing allowed; a file\'s own are kept, marked (LIC-3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full(); // Mira: Spec's permissions, never chosen
  assert.equal(ch.permissionsState(b), 'from-spec');
  const d = ch.detailsOf(b);
  for (const [k, v] of Object.entries(ch.RESTRICTED)) assert.equal(d.meta[k], v, k);
  const vrm = await ch.exportVrm(b, { spec });
  for (const [k, v] of Object.entries(ch.RESTRICTED)) assert.equal(metaOf(vrm.bytes)[k], v, `exported ${k}`);
  assert.ok(vrm.notes.some((n) => /never chosen and were Spec's: written as nothing allowed/.test(n)));
  const copy = await ch.shareCopy(b, { spec });
  const cm = metaOf((await readBundle(copy.bytes)).entries.get('avatar.vrm'));
  for (const [k, v] of Object.entries(ch.RESTRICTED)) assert.equal(cm[k], v, `shared ${k}`);
  assert.ok(copy.notes.some((n) => /the copy says nothing is allowed/.test(n)));
  // the first choice: the others become what was shown (nothing allowed), not Spec's
  await ch.setDetails(b, { commercialUsage: 'personalProfit' });
  assert.equal(ch.permissionsState(b), 'chosen');
  const m = metaOf(avatar(b));
  assert.equal(m.commercialUsage, 'personalProfit');
  assert.equal(m.allowRedistribution, false);
  assert.equal(m.avatarPermission, 'onlyAuthor');

  // a file's own permissions (not Spec's, not chosen here) are kept as they are, and said to be the file's
  const f = await full();
  const own = { ...ch.avatarMeta(f), allowRedistribution: true, commercialUsage: 'personalProfit', avatarPermission: 'onlySeparatelyLicensedPerson', allowExcessivelySexualUsage: false };
  delete own.thumbnailImage;
  ch.setWholeMeta(f, own);
  assert.equal(ch.permissionsState(f), 'from-file');
  assert.equal(ch.detailsOf(f).meta.commercialUsage, 'personalProfit');
  const fv = await ch.exportVrm(f, { spec });
  assert.equal(metaOf(fv.bytes).avatarPermission, 'onlySeparatelyLicensedPerson');
  assert.ok(fv.notes.some((n) => /the file's own, not confirmed here/.test(n)));
  // a new character's own strict permissions are 'restricted'
  const n = createBundle({ avatar: bakeAvatar(spec, newEdits(), { meta: ch.newCharacterMeta({ name: 'Nova' }), metaMode: 'replace' }).bytes, base: standardBase('human') });
  assert.equal(ch.permissionsState(n), 'restricted');
});

test('permissions chosen before a restricted piece was put on: validate warns and the VRM export says so (§5.3, LIC-4)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await ch.setDetails(b, { allowRedistribution: true, modification: 'allowModificationRedistribution', commercialUsage: 'corporation' });
  await closetOps.addItem(b, await restrictedItem(), { spec });
  await closetOps.putOn(b, '0f0e0d0c-0b0a-4908-8706-050403020100', { redraw: { spec } });
  const d = ch.detailsOf(b);
  assert.deepEqual(d.looser.map((l) => l.key).sort(), ['allowRedistribution', 'commercialUsage', 'modification']);
  const warns = (await checkBundle(await writeBundle(b), { spec })).filter((p) => p.code === 'details.looser');
  assert.equal(warns.length, 3);
  assert.ok(warns.some((w) => /May be passed on is looser than "Thigh boots" allows \(May not be passed on\)/.test(w.message)));
  const mine = await ch.exportVrm(b, { spec });
  assert.ok(mine.notes.some((n) => /May be passed on is looser than "Thigh boots" allows/.test(n)));
  assert.equal(mine.looser.length, 3);
});
