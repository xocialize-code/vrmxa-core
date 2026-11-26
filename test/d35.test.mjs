// VRMXA 0.32 (D35, SPEC-QUESTIONS #69–#74): a designed voice's madeWith and an imported voice's source (§9.2), clip
// licences as blocks (§8.4), and a character's permissions tightened when a piece is put on, loosening only offered (§5.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, specVrm, noSpec, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle, parseGlb, readItem, writeItem } from '../src/index.js';
import * as closetOps from '../src/closet/index.js';
import * as ch from '../src/character/index.js';
import * as anim from '../src/anim/index.js';
import { addVoice, updateVoice, madeWithLicence } from '../src/voice/index.js';
import { tone } from './tone.mjs';

const full = () => readBundle(fixture('characters/full.vrmxa'));
const metaOf = (b) => parseGlb(b.entries.get('avatar.vrm')).json.extensions.VRMC_vrm.meta;

test('a designed voice records madeWith from the engine\'s stated terms; its notice is credited; no local paths (§9.2)', async () => {
  const b = await full();
  const lic = madeWithLicence({ spdx: 'LicenseRef-Example', commercial_use: true, terms_url: 'https://example.com/terms', attribution: 'Built with Example' });
  assert.deepEqual(lic, { spdx: 'LicenseRef-Example', commercialUse: true, termsUrl: 'https://example.com/terms', notice: null, attribution: 'Built with Example' });
  const r = await addVoice(b, {
    name: 'Designed', origin: 'designed', realPerson: false,
    design: { model: 'example-design', version: '1', description: 'A calm voice.', seed: 7, text: 'Hello there.', params: {} },
    madeWith: [{ model: 'example-design', version: '1', license: lic, seed: 7, prompt: 'A calm voice.', input: null }],
    clips: [{ bytes: tone(5, 24000), transcript: 'Hello there.' }],
  });
  await updateVoice(b, r.id, { name: 'Designed, renamed' });
  const v = b.docs.voices.voices.find((x) => x.id === r.id);
  assert.equal(v.madeWith[0].license.attribution, 'Built with Example', 'kept when the voice is edited');
  const c = ch.credits(b);
  assert.deepEqual(c.notices, [{ voice: 'Designed, renamed', model: 'example-design', text: 'Built with Example' }]);
  assert.ok(c.lines.includes('Designed, renamed (made with example-design): Built with Example'));
  assert.deepEqual(codes(await checkBundle(await writeBundle(b))), []);
  await assert.rejects(addVoice(b, { name: 'Bad', origin: 'imported', realPerson: false, source: 'x.wav', madeWith: [{ model: '/Users/me/models/x' }], clips: [{ bytes: tone(5, 24000), transcript: 'x' }] }), /local path/);
  const imp = await addVoice(b, { name: 'Imported', origin: 'imported', realPerson: false, source: 'hum.wav', clips: [{ bytes: tone(5, 24000), transcript: 'A hum.' }] });
  assert.equal(b.docs.voices.voices.find((x) => x.id === imp.id).source, 'hum.wav');
});

test('a clip\'s licence may be a block in VRM\'s terms: honoured in a shared copy and credited; text is shown, not judged (§8.4)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  const sha = b.docs.animations.clips[0].sha256;
  await assert.rejects(anim.setClipDetails(b, sha, { licence: { licenseUrl: 'x' } }), /authors/);
  await anim.setClipDetails(b, sha, { licence: { authors: ['Motion Maker'], licenseUrl: 'https://example.com/m', allowRedistribution: true, creditNotation: 'required' } });
  const t = ch.licenceTable(b).clips[0];
  assert.equal(t.block, true);
  assert.equal(t.whose, 'Motion Maker');
  assert.ok(ch.credits(b).makers.some((m) => m.maker === 'Motion Maker' && m.pieces[0].kind === 'clip'));
  assert.deepEqual(codes(await checkBundle(await writeBundle(b))), []);
  await anim.setClipDetails(b, sha, { licence: { authors: ['Motion Maker'], licenseUrl: 'https://example.com/m', allowRedistribution: false } });
  const r = ch.shareReport(b);
  assert.deepEqual(r.clipsOut.map((c) => c.name), ['Idle, breathing']);
  assert.ok(r.notes.some((n) => /The motion "Idle, breathing" is left out/.test(n)));
  // it fills the default set's idle on its own: the copy can't leave it out, and says why
  await assert.rejects(ch.shareCopy(b, { spec }), /may not be passed on and can't be left out/);
  await anim.setClipDetails(b, sha, { licence: 'CC0' });
  assert.equal(ch.shareReport(b).clipsOut.length, 0);
  assert.deepEqual(ch.shareReport(b).clips.map((c) => c.licence), ['CC0']);
});

test('putting a piece on tightens what it doesn\'t allow; nothing is loosened on its own; loosening is offered (§5.3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full();
  await ch.setDetails(b, { allowRedistribution: true, modification: 'allowModificationRedistribution', commercialUsage: 'corporation' });
  const hat = await readItem(fixture('items/borrowed-hat.vrmxw'));
  await closetOps.addItem(b, fixture('items/borrowed-hat.vrmxw'), { spec });
  const piece = { id: hat.manifest.id, name: hat.manifest.name, meta: hat.manifest.meta };
  const q = ch.questionsBeforeWearing(b, [piece.id]);
  assert.deepEqual(q.filter((x) => x.term === 'tighten').map((x) => x.key).sort(), ['allowRedistribution', 'commercialUsage', 'modification']);
  const changes = await ch.tightenPermissions(b, [piece]);
  assert.equal(changes.length, 3);
  await closetOps.putOn(b, piece.id, { redraw: { spec } });
  const m = metaOf(b);
  assert.deepEqual([m.allowRedistribution, m.modification, m.commercialUsage], [false, 'prohibited', 'personalNonProfit']);
  assert.deepEqual(ch.detailsOf(b).looser, []);
  assert.equal((await checkBundle(await writeBundle(b), { spec })).filter((p) => p.code === 'details.looser').length, 0, 'avatar.vrm never claims more than its parts');
  assert.deepEqual(ch.looseningOffer(b), [], 'nothing to offer while it is worn');
  await closetOps.takeOff(b, piece.id, { redraw: { spec } });
  assert.equal(metaOf(b).allowRedistribution, false, 'never loosened on its own');
  assert.deepEqual(ch.looseningOffer(b).map((o) => [o.key, o.to]).sort(), [['allowRedistribution', true], ['commercialUsage', 'corporation'], ['modification', 'allowModificationRedistribution']]);
  await ch.loosenPermissions(b);
  assert.equal(metaOf(b).allowRedistribution, true);
  assert.deepEqual(ch.looseningOffer(b), []);
  // Spec's permissions taken over unchosen are tightened from what is shown (nothing allowed), not from Spec's
  const f = await full();
  await closetOps.addItem(f, fixture('items/borrowed-hat.vrmxw'), { spec });
  await ch.tightenPermissions(f, [piece]);
  assert.equal(ch.permissionsState(f), 'restricted');
});

test('a save writes the permissions as shown: Spec\'s never chosen go out as nothing allowed, so validate has nothing looser to warn about (LIC-3, §5.3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const b = await full(); // Mira: Spec's permissions, never chosen; her fixture items state no usage flags (VRM's: off)
  await closetOps.redrawAvatar(b, { spec });
  assert.equal(metaOf(b).allowExcessivelyViolentUsage, false, 'drawn as shown');
  assert.equal(ch.permissionsState(b), 'restricted');
  assert.equal((await checkBundle(await writeBundle(b), { spec })).filter((p) => p.code === 'details.looser').length, 0);
  const c = await full();
  assert.equal(ch.writeShownPermissions(c), true);
  assert.equal(metaOf(c).commercialUsage, 'personalNonProfit');
  assert.equal(ch.writeShownPermissions(c), false, 'once is enough');
});
