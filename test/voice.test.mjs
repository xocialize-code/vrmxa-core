// Phase 7: voices (VRMXA §9; PRD VOI-1 to VOI-5, HON-3). Test sounds are synthetic tones, never a person's voice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle } from '../src/index.js';
import * as v from '../src/voice/index.js';
import { personaOf, setPersona } from '../src/persona/index.js';
import { tone } from './tone.mjs';

const full = () => readBundle(fixture('characters/full.vrmxa'));
const designed = (extra = {}) => ({
  name: 'Mira, bright', language: 'en', origin: 'designed', realPerson: false,
  design: { model: 'qwen3-tts-design', version: '0.1.4', description: 'A young woman, soft and bright.', seed: 418207, text: 'Good morning. I was hoping you would come by.', params: { language: 'en' } },
  clips: [{ bytes: tone(8.4, 24000), transcript: 'Good morning. I was hoping you would come by.' }],
  ...extra,
});

test('clips in the standard form: 16-bit mono at their own rate, never resampled (VOI-2)', () => {
  const plain = tone(4, 24000);
  const s = v.standardClip(plain);
  assert.equal(s.bytes, plain, 'a clip already in the standard form is kept byte for byte');
  const stereo = tone(4, 48000, { float: true, channels: 2 });
  const c = v.standardClip(stereo);
  const info = v.audioInfo(c.bytes);
  assert.deepEqual([info.format, info.bits, info.channels, info.rate], [1, 16, 1, 48000]);
  assert.ok(Math.abs(info.duration - 4) < 1e-3);
  assert.deepEqual(c.changed, ['mixed down from 2 channels', 'converted from 32-bit float']);
  assert.throws(() => v.standardClip(new Uint8Array([1, 2, 3, 4])), /WAV/);
  assert.match(v.clipWarnings({ duration: 2.1, rate: 24000 })[0], /shorter than 3 s/);
  assert.match(v.clipWarnings({ duration: 24, rate: 24000 })[0], /longer than 20 s/);
  assert.match(v.clipWarnings({ duration: 5, rate: 16000 })[0], /under 24 kHz/);
  assert.deepEqual(v.clipWarnings({ duration: 8, rate: 48000 }), []);
});

test('a designed voice keeps what makes it repeatable, and starts at the most restricted licence (VOI-3, VOI-4)', async () => {
  const b = await full();
  const r = await v.addVoice(b, designed());
  const rec = b.docs.voices.voices.find((x) => x.id === r.id);
  assert.deepEqual(rec.design, designed().design);
  assert.equal(rec.meta.avatarPermission, 'onlyAuthor');
  assert.equal(rec.meta.allowRedistribution, false);
  assert.equal(rec.meta.modification, 'prohibited');
  assert.equal(rec.meta.commercialUsage, 'personalNonProfit');
  assert.equal(rec.meta.creditNotation, 'required');
  assert.equal(rec.clips[0].primary, true);
  assert.equal(rec.clips[0].sampleRate, 24000);
  assert.match(rec.clips[0].file, /^voice\/clips\/[0-9a-f]{12}\.wav$/);
  const bytes = await writeBundle(b);
  assert.deepEqual(codes(await checkBundle(bytes)), []);
  await assert.rejects(v.addVoice(b, designed({ design: { model: 'x', description: 'y', text: 'z' } })), /design.seed/);
  await assert.rejects(v.addVoice(b, designed({ clips: [{ bytes: tone(4, 24000), transcript: '' }] })), /transcript/);
});

test('a real person\'s voice is not saved without recorded consent (VOI-5, HON-3)', async () => {
  const b = await full();
  const rec = { name: 'Studio take', origin: 'recorded', realPerson: true, speaker: 'Sam Example', clips: [{ bytes: tone(6, 48000), transcript: 'Hello, this is a short recording.' }] };
  await assert.rejects(v.addVoice(b, rec), /can't be saved without their consent recorded/);
  await assert.rejects(v.addVoice(b, { ...rec, consent: { given: true, scope: 'This character only.' } }), /when Sam Example agreed/);
  await assert.rejects(v.addVoice(b, { ...rec, consent: { given: true, date: '2026-11-17' } }), /what Sam Example agreed to/);
  await assert.rejects(v.addVoice(b, { ...rec, realPerson: undefined }), /realPerson/);
  const ok = await v.addVoice(b, { ...rec, consent: { given: true, date: '2026-11-17', scope: 'This character only. Not to be passed on. Non-commercial.', record: 'Signed form, studio files' } });
  const saved = b.docs.voices.voices.find((x) => x.id === ok.id);
  assert.equal(saved.speaker, 'Sam Example');
  assert.equal(saved.consent.given, true);
  // taking the consent back away is refused too
  await assert.rejects(v.updateVoice(b, ok.id, { consent: { given: false, date: '2026-11-17', scope: 'x' } }), /consent/);
  assert.deepEqual(codes(await checkBundle(await writeBundle(b))), []);
});

test('an imported clip outside 3–20 s is kept with a warning; voices, clips and the default can be changed (VOI-1)', async () => {
  const b = await full();
  const r = await v.addVoice(b, { name: 'Short hum', origin: 'imported', realPerson: false, source: 'hum.wav', clips: [{ bytes: tone(2, 24000), transcript: 'A short tone.' }] });
  assert.match(r.warnings[0], /shorter than 3 s/);
  const sum = v.voiceSummaries(b).find((x) => x.id === r.id);
  assert.equal(sum.shareable, false);
  assert.match(sum.licence.allows, /Not to be passed on/);
  assert.match(sum.clips[0].warnings[0], /shorter than 3 s/);
  const c2 = await v.addClip(b, r.id, { bytes: tone(6, 24000), transcript: 'A longer tone, in a happy style.', style: 'happy' });
  await v.setPrimaryClip(b, r.id, c2.clip.sha256);
  await v.removeClip(b, r.id, r.voice.clips[0].sha256);
  assert.ok(!b.entries.has(r.voice.clips[0].file), 'a clip no voice uses goes');
  await v.setDefaultVoice(b, r.id);
  assert.equal(b.docs.voices.default, r.id);
  assert.equal(personaOf(b).voice_id, r.id, 'the persona speaks with the new default');
  await v.updateVoice(b, r.id, { name: 'Hum', meta: { allowRedistribution: true } });
  assert.equal(b.docs.voices.voices.find((x) => x.id === r.id).meta.allowRedistribution, true);
  await v.removeVoice(b, r.id);
  assert.notEqual(b.docs.voices.default, r.id);
  assert.equal(personaOf(b).voice_id, b.docs.voices.default);
  assert.ok(!b.entries.has(c2.clip.file));
  assert.deepEqual(codes(await checkBundle(await writeBundle(b))), []);
});

test('the persona keeps pointing at a voice that exists', async () => {
  const b = await full();
  await setPersona(b, { voice_id: b.docs.voices.default });
  assert.equal(personaOf(b).voice_id, b.docs.voices.default);
});
