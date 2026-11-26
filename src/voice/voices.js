// Voices (VRMXA §9, §9.2, §9.3; PRD VOI-1 to VOI-5, HON-3): the voices document `voice/voices.json` and its clips
// `voice/clips/<sha12>.wav`, changed only through these operations, each all or nothing.
//
//   - Every voice has a licence block in VRM's terms; a new one starts at the most restricted (VOI-4, §9.3): only its
//     maker may use it, not passed on, no changes, non-commercial, credit required. A writer states every permission.
//   - A designed voice keeps what makes it repeatable (VOI-3): model, version, description, seed, the words, params.
//   - A real person's voice is not saved without their consent recorded (HON-3, VOI-5): who, that they agreed, when,
//     and to what. `consent.record` (where the agreement is kept) is optional.
//   - Clips are WAV 16-bit mono at their own rate, with their exact transcript (VOI-2); outside 3–20 s is a warning.

import { clone, isPlainObject, newUuid, nowIso } from '../bytes.js';
import { sha12, sha256 } from '../hash.js';
import { setDocument, setEntry } from '../vrmxa.js';
import { databaseData, writeDatabase, VRM_LICENCE } from '../character/details.js';
import { RESTRICTED, PERMISSION_KEYS, licenceLine } from '../character/terms.js';
import { META_BOOLEANS, META_ENUMS, META_STRINGS } from '../vocab.js';
import { audioInfo, clipWarnings, standardClip } from './wav.js';

export const ORIGINS = Object.freeze(['designed', 'recorded', 'imported', 'preset']);
export const STYLES = Object.freeze(['neutral', 'happy', 'sad', 'angry', 'whisper', 'calm', 'excited']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/;
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class VoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new VoiceError(code, message); };

export const emptyVoices = () => ({ format: 'vrmxa-voices', version: 1, default: null, voices: [] });

/** The voices document as it stands (a copy), or an empty one. */
export function voicesOf(bundle) {
  const d = bundle.docs.voices ? clone(bundle.docs.voices) : emptyVoices();
  d.voices = Array.isArray(d.voices) ? d.voices : [];
  if (d.default === undefined) d.default = null;
  return d;
}

/** A new voice's licence block (VOI-4): its makers, VRM's licence, every permission at its strictest, stated. */
export function newVoiceMeta({ authors = ['VRMXA Avatar Studio'] } = {}) {
  return { authors: [...authors], licenseUrl: VRM_LICENCE, ...RESTRICTED };
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/** Why a real person's voice can't be saved yet (HON-3), or null. */
export function consentProblem(v) {
  if (v.realPerson !== true) return null;
  const c = v.consent;
  if (!nonEmpty(v.speaker)) return 'a real person\'s voice needs whose it is (speaker) before it is saved (VRMXA §9.3)';
  if (!isPlainObject(c) || c.given !== true) return `${v.speaker}'s voice can't be saved without their consent recorded: that they agreed to it being cloned for this character (VRMXA §9.3, PRD HON-3)`;
  if (!nonEmpty(c.date) || !DATE_RE.test(c.date)) return `record when ${v.speaker} agreed (consent.date, as 2026-11-17)`;
  if (!nonEmpty(c.scope)) return `record what ${v.speaker} agreed to, in words (consent.scope)`;
  if (c.record != null && typeof c.record !== 'string') return 'consent.record is where the agreement is kept, as text';
  return null;
}

function metaProblems(meta) {
  const P = [];
  if (!isPlainObject(meta)) return ['a voice needs its licence block (meta)'];
  if (!Array.isArray(meta.authors) || !meta.authors.length || !meta.authors.every(nonEmpty)) P.push('the licence block must name who made or recorded the voice (authors)');
  if (!nonEmpty(meta.licenseUrl)) P.push('the licence block must give the licence (licenseUrl)');
  for (const [k, vals] of Object.entries(META_ENUMS)) if (meta[k] !== undefined && !vals.includes(meta[k])) P.push(`${k} must be one of ${vals.join(', ')}`);
  for (const k of META_BOOLEANS) if (meta[k] !== undefined && typeof meta[k] !== 'boolean') P.push(`${k} must be true or false`);
  for (const k of META_STRINGS) if (meta[k] !== undefined && typeof meta[k] !== 'string') P.push(`${k} must be text`);
  return P;
}

/** A voice's problems before it is written → [text]. */
export function voiceProblems(v) {
  const P = [];
  if (!nonEmpty(v.name)) P.push('a voice needs a name');
  if (!ORIGINS.includes(v.origin)) P.push(`origin must be ${ORIGINS.join(', ')}`);
  if (typeof v.realPerson !== 'boolean') P.push('say whether the voice is a real person\'s (realPerson), even when it is not');
  if (v.language != null && !(typeof v.language === 'string' && LANG_RE.test(v.language))) P.push('language must be a BCP 47 tag (en, ja, en-GB)');
  if (v.origin === 'designed') {
    const d = v.design;
    if (!isPlainObject(d)) P.push('a designed voice keeps how it was made (design: model, version, description, seed, text)');
    else {
      if (!nonEmpty(d.model)) P.push('design.model: the model that designed it');
      if (!nonEmpty(d.description)) P.push('design.description: the words given to the model');
      if (!Number.isInteger(d.seed)) P.push('design.seed: the seed of the sample kept');
      if (!nonEmpty(d.text)) P.push('design.text: what the sample says');
    }
  }
  if (v.origin === 'preset' && !(isPlainObject(v.engines) && Object.keys(v.engines).length)) P.push('a preset voice names its engine and preset (engines)');
  const c = consentProblem(v);
  if (c) P.push(c);
  P.push(...metaProblems(v.meta));
  if (v.listing != null && (!isPlainObject(v.listing) || 'price' in v.listing)) P.push('listing is { url, marketplace, id }, with no price');
  P.push(...madeWithProblems(v.madeWith));
  if (v.source != null && typeof v.source !== 'string') P.push('source is text: what an imported voice was made from');
  return P;
}

const LOCAL_PATH = /^(\/|~\/|file:|[A-Za-z]:[\\/])/;
/**
 * The models that made a voice and on what terms (§9.2 `madeWith`, D35): [{ model, version, license: { spdx,
 * commercialUse, termsUrl, notice, attribution }, seed, prompt, input }]. No local paths. → [text]
 */
export function madeWithProblems(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return ['madeWith is a list, one entry per model'];
  const P = [];
  for (const [i, m] of list.entries()) {
    const at = `madeWith[${i}]`;
    if (!isPlainObject(m) || !nonEmpty(m.model)) { P.push(`${at} names its model`); continue; }
    if (m.license != null && !isPlainObject(m.license)) P.push(`${at}.license is { spdx, commercialUse, termsUrl, notice, attribution }`);
    if (m.seed != null && !Number.isInteger(m.seed)) P.push(`${at}.seed is a whole number`);
    if (m.input != null && !/^[0-9a-f]{64}$/.test(m.input)) P.push(`${at}.input is the sha256 of an input, or null`);
    const texts = [m.model, m.version, m.prompt, m.license?.termsUrl].filter((x) => typeof x === 'string');
    if (texts.some((t) => LOCAL_PATH.test(t))) P.push(`${at} holds a local path: madeWith never does (§9.2)`);
  }
  return P;
}

/** A Gaea offer's stated licence (MES Base §10.2) as a madeWith entry's `license`. */
export function madeWithLicence(l) {
  if (!l) return null;
  return { spdx: l.spdx ?? null, commercialUse: l.commercial_use ?? l.commercialUse ?? null, termsUrl: l.terms_url ?? l.termsUrl ?? null, notice: l.notice ?? null, attribution: l.attribution ?? null };
}

// a clip given as { bytes, transcript, style?, language?, primary? } → its record and bytes, in the standard form
async function takeClip(c, voice) {
  if (!c?.bytes) fail('clip', 'a clip needs its sound (bytes)');
  if (!nonEmpty(c.transcript)) fail('clip.transcript', 'every clip needs its exact transcript (VRMXA §9.1, D8)');
  let std;
  try { std = standardClip(c.bytes); } catch (e) { fail('clip.format', e.message); }
  const h = await sha256(std.bytes);
  const file = `voice/clips/${sha12(h)}.wav`;
  const rec = {
    sha256: h, file, transcript: c.transcript.trim(), language: c.language || voice.language || 'en',
    duration: Math.round(std.duration * 1000) / 1000, sampleRate: std.rate, style: c.style || 'neutral', primary: !!c.primary,
  };
  return { rec, bytes: std.bytes, changed: std.changed, warnings: clipWarnings({ duration: std.duration, rate: std.rate }) };
}

const usedClips = (doc) => new Set(doc.voices.flatMap((v) => (v.clips || []).map((c) => c.file)));

async function commit(bundle, doc, { add = [], before = null } = {}) {
  for (const [path, bytes] of add) setEntry(bundle, path, bytes);
  // clips no voice uses any more go (rule 2: named by content, so another voice may share one)
  const used = usedClips(doc);
  const old = before ? before.voices.flatMap((v) => (v.clips || []).map((c) => c.file)) : [];
  for (const p of old) if (!used.has(p)) setEntry(bundle, p, null);
  setDocument(bundle, 'voices', doc.voices.length || doc.default ? doc : null);
}

const fillMeta = (meta) => {
  const m = { ...newVoiceMeta(), ...(meta || {}) };
  for (const k of PERMISSION_KEYS) if (m[k] === undefined) m[k] = RESTRICTED[k]; // stated, never left to a default
  return m;
};

/**
 * Add a voice (VOI-1): spec { name, language, origin, design?, realPerson, speaker?, consent?, meta?, listing?, source?,
 * engines?, clips: [{ bytes, transcript, style?, language?, primary? }] }. The first clip is primary unless one says so;
 * the first voice becomes the default. A real person's voice without recorded consent is refused (HON-3).
 * → { id, voice (its record), warnings: [text], changed: [text] }
 */
export async function addVoice(bundle, spec, { idFactory = newUuid, now = nowIso() } = {}) {
  if (!isPlainObject(spec)) fail('voice.shape', 'a voice is an object');
  const before = voicesOf(bundle);
  const doc = clone(before);
  const v = {
    id: spec.id || idFactory(), name: spec.name, language: spec.language || 'en', origin: spec.origin,
    design: spec.origin === 'designed' ? clone(spec.design) : null,
    realPerson: spec.realPerson, speaker: spec.realPerson ? (spec.speaker ?? null) : null, consent: spec.realPerson ? clone(spec.consent ?? null) : null,
    meta: fillMeta(spec.meta), listing: spec.listing ? clone(spec.listing) : null,
    ...(spec.source ? { source: String(spec.source) } : {}),
    ...(Array.isArray(spec.madeWith) && spec.madeWith.length ? { madeWith: clone(spec.madeWith) } : {}),
    created: now, clips: [],
    ...(isPlainObject(spec.engines) ? { engines: clone(spec.engines) } : {}),
  };
  const problems = voiceProblems(v);
  if (problems.length) fail('voice.refused', problems.join('; '));
  if (doc.voices.some((x) => x.id === v.id)) fail('voice.duplicate', `there is a voice ${v.id} already`);
  const clips = Array.isArray(spec.clips) ? spec.clips : [];
  if (!clips.length && v.origin !== 'preset') fail('voice.clips', 'a voice is one or more reference clips with their transcripts (VRMXA §9)');
  const add = [];
  const warnings = [], changed = [];
  for (const c of clips) {
    const t = await takeClip(c, v);
    if (v.clips.some((x) => x.sha256 === t.rec.sha256)) continue;
    v.clips.push(t.rec);
    add.push([t.rec.file, t.bytes]);
    warnings.push(...t.warnings);
    changed.push(...t.changed);
  }
  if (v.clips.length && !v.clips.some((c) => c.primary)) v.clips[0].primary = true;
  if (v.origin === 'designed' && v.design && v.clips[0] && v.design.text !== v.clips.find((c) => c.primary).transcript) warnings.push('the designed sample\'s text and the primary clip\'s transcript differ');
  doc.voices.push(v);
  if (!doc.default) doc.default = v.id;
  await commit(bundle, doc, { add, before });
  return { id: v.id, voice: clone(v), warnings, changed };
}

const need = (doc, id) => doc.voices.find((v) => v.id === id) || fail('voice.missing', `there is no voice ${id}`);

/**
 * Change a voice: any of name, language, meta (merged; permissions stated), listing, realPerson, speaker, consent,
 * design (a designed voice), engines, source. Rechecked whole: making it a real person's without consent is refused.
 * → the voice's record
 */
export async function updateVoice(bundle, id, patch) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  const v = need(doc, id);
  for (const k of Object.keys(patch)) if (!['name', 'language', 'meta', 'listing', 'realPerson', 'speaker', 'consent', 'design', 'engines', 'source'].includes(k)) fail('voice.key', `"${k}" can't be changed on a voice`);
  if ('meta' in patch) v.meta = fillMeta({ ...v.meta, ...patch.meta });
  for (const k of ['name', 'language', 'listing', 'realPerson', 'speaker', 'consent', 'design', 'engines', 'source']) if (k in patch) v[k] = clone(patch[k]);
  if (v.realPerson === false) { v.speaker = null; v.consent = null; }
  if (v.origin !== 'designed') v.design = null;
  const problems = voiceProblems(v);
  if (problems.length) fail('voice.refused', problems.join('; '));
  await commit(bundle, doc, { before });
  return clone(v);
}

/** Add a clip to a voice (another style, say). → { clip, warnings } */
export async function addClip(bundle, id, clip) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  const v = need(doc, id);
  const t = await takeClip(clip, v);
  if (v.clips.some((c) => c.sha256 === t.rec.sha256)) fail('clip.duplicate', 'this clip is in the voice already');
  if (t.rec.primary) for (const c of v.clips) c.primary = false;
  v.clips.push(t.rec);
  if (!v.clips.some((c) => c.primary)) v.clips[0].primary = true;
  await commit(bundle, doc, { add: [[t.rec.file, t.bytes]], before });
  return { clip: clone(t.rec), warnings: t.warnings, changed: t.changed };
}

/** Remove a clip (by sha256) from a voice; a voice keeps at least one. */
export async function removeClip(bundle, id, sha) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  const v = need(doc, id);
  if (!v.clips.some((c) => c.sha256 === sha)) fail('clip.missing', 'the voice has no such clip');
  if (v.clips.length === 1 && v.origin !== 'preset') fail('clip.last', 'a voice keeps at least one clip: remove the voice instead');
  v.clips = v.clips.filter((c) => c.sha256 !== sha);
  if (!v.clips.some((c) => c.primary) && v.clips[0]) v.clips[0].primary = true;
  await commit(bundle, doc, { before });
}

/** Make a clip the one to clone from by default. */
export async function setPrimaryClip(bundle, id, sha) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  const v = need(doc, id);
  if (!v.clips.some((c) => c.sha256 === sha)) fail('clip.missing', 'the voice has no such clip');
  for (const c of v.clips) c.primary = c.sha256 === sha;
  await commit(bundle, doc, { before });
}

/** The voice the character speaks with (§9.2 `default`); the persona's voice_id follows when it named the old one. */
export async function setDefaultVoice(bundle, id) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  need(doc, id);
  const old = doc.default;
  doc.default = id;
  await commit(bundle, doc, { before });
  const data = databaseData(bundle);
  if (data.persona && (!data.persona.voice_id || data.persona.voice_id === old)) {
    data.persona = { ...data.persona, voice_id: id };
    await writeDatabase(bundle, data);
  }
}

/** Remove a voice and the clips only it used; the default moves to the next voice; the persona's voice_id follows. */
export async function removeVoice(bundle, id) {
  const before = voicesOf(bundle);
  const doc = clone(before);
  need(doc, id);
  doc.voices = doc.voices.filter((v) => v.id !== id);
  if (doc.default === id) doc.default = doc.voices[0]?.id ?? null;
  await commit(bundle, doc, { before });
  const data = databaseData(bundle);
  if (data.persona?.voice_id === id) {
    data.persona = { ...data.persona, voice_id: doc.default };
    await writeDatabase(bundle, data);
  }
}

/**
 * Each voice as the Voice screen and `vrmxa voice list` show it: its record, whose it is and what its maker allows
 * (LIC-5), its clips' facts and warnings, and whether it may go into a shared copy (HON-2).
 */
export function voiceSummaries(bundle) {
  const doc = voicesOf(bundle);
  return doc.voices.map((v) => ({
    id: v.id, name: v.name, language: v.language ?? null, origin: v.origin, default: doc.default === v.id, madeWith: clone(v.madeWith ?? null),
    realPerson: v.realPerson === true, speaker: v.speaker ?? null, consent: v.consent ?? null,
    consentProblem: consentProblem(v), design: v.design ?? null, source: v.source ?? null,
    licence: licenceLine(v.meta, { kind: 'voice' }), meta: clone(v.meta),
    shareable: v.meta?.allowRedistribution === true,
    clips: (v.clips || []).map((c) => {
      const bytes = bundle.entries.get(c.file);
      const info = bytes ? audioInfo(bytes) : null;
      return {
        sha256: c.sha256, file: c.file, transcript: c.transcript, style: c.style ?? null, primary: !!c.primary,
        duration: info?.duration ?? c.duration ?? null, sampleRate: info?.rate ?? c.sampleRate ?? null, missing: !bytes,
        warnings: info ? clipWarnings({ duration: info.duration, rate: info.rate, channels: info.channels, bits: info.bits }) : ['the clip file is missing'],
      };
    }),
  }));
}
