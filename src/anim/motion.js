// A character's motion, in its bundle (VRMXA §8; PRD ANI-1 to ANI-6, ANI-9): clips brought in and their
// details, the corrections kept beside them, and the sets. Every operation works on copies, checks the
// animations document as the checker does (VRMXA §8.4, CLOSET.md C7), and only then writes it and its
// entries into the bundle, all or nothing. It returns what changed (MCP-4). An app's undo snapshots the
// bundle with closet/ops.js closetSnapshot, which takes the animations document and everything under
// animations/ (edit documents included).
//
// Corrected clips (VRMXA 0.31 §8.1, §8.4, D34). A corrected clip is a clip of its own, played by the sets in
// its original's place. Its record names the original (`derivedFrom`) and its edit document (`edit`:
// animations/edits/<its sha12>.json, format `vrmxa-motion-edit` version 1), which holds this app's list of
// corrections, each with the figure it solves on. The original stays in `clips` while an edit document
// refers to it. A clip's own playback speed is `rate`; `groundedFor` records the figure its floor was set for.
// What the starter clips' records say that no field holds (a seam the converter blended, travel it removed)
// stays on the original's record as `x-xocialize.hints`, for the checker; other writers keep it (rule 5).
// Bundles written before 0.31 kept corrections in animations/x-xocialize.corrections.json: every operation
// moves them into the fields first (migrateCorrections), so the next save writes the new form.

import { sha256, sha12 } from '../hash.js';
import { jsonBytes } from '../bytes.js';
import { setDocument, setEntry } from '../vrmxa.js';
import { checkAnimations } from '../checker.js';
import { closetOf, itemOf } from '../closet/ops.js';
import { itemTags } from '../closet/fit.js';
import { readVrma, writeVrma, clipTracks, isVrma } from './clip.js';
import { applyCorrections } from './correct.js';
import { checkClip } from './check.js';
import { track, seam, travel } from './analyse.js';
import { emptyAnimations, isSlot, isTag, swapClip, clipUses, activeSets, resolveSlots } from './sets.js';
import { STARTER_SETS, starterRecord } from './starter.js';
import { newUuid } from '../bytes.js';

export const CORRECTIONS_PATH = 'animations/x-xocialize.corrections.json'; // before VRMXA 0.31: read and moved
export const CORRECTIONS_FORMAT = 'x-xocialize.clip-corrections';
export const EDIT_FORMAT = 'vrmxa-motion-edit';
export const HINTS_KEY = 'x-xocialize.hints';
export const editPath = (h) => `animations/edits/${sha12(h)}.json`;

export class MotionError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'MotionError'; }
}
const fail = (code, msg) => { throw new MotionError(code, msg); };
const clone = (x) => JSON.parse(JSON.stringify(x));
const clipPath = (h) => `animations/clips/${sha12(h)}.vrma`;
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** The animations document as it stands (a copy), or an empty one. */
export const animationsOf = (bundle) => (bundle.docs.animations ? clone(bundle.docs.animations) : emptyAnimations());

/** A clip's edit document (VRMXA §8.4 `edit`), parsed, or null. */
export function editOf(bundle, rec) {
  if (!rec?.edit) return null;
  const b = bundle.entries.get(rec.edit);
  if (!b) return null;
  try { const d = JSON.parse(new TextDecoder().decode(b)); return d?.format === EDIT_FORMAT ? d : null; } catch { return null; }
}

/**
 * Every corrected clip and every original with hints, as { original, result, ops, hints }: a view made from
 * `derivedFrom`, `edit` and the hints on the originals' records.
 */
export function correctionsOf(bundle) {
  const doc = animationsOf(bundle);
  const out = [];
  const hintsOf = (h) => doc.clips.find((c) => c.sha256 === h)?.[HINTS_KEY] || {};
  for (const c of doc.clips) {
    if (!c.derivedFrom || !c.edit) continue;
    out.push({ original: c.derivedFrom, result: c.sha256, ops: editOf(bundle, c)?.corrections || [], hints: hintsOf(c.derivedFrom) });
  }
  for (const c of doc.clips) if (c[HINTS_KEY] && !out.some((e) => e.original === c.sha256)) out.push({ original: c.sha256, result: null, ops: [], hints: c[HINTS_KEY] });
  return { clips: out };
}

/** The clip record by sha256 (or 12-digit prefix, or name). */
export function findClip(bundle, ref) {
  const doc = animationsOf(bundle);
  return doc.clips.find((x) => x.sha256 === ref) || doc.clips.find((x) => typeof ref === 'string' && ref.length >= 6 && x.sha256.startsWith(ref)) || doc.clips.find((x) => x.name === ref) || null;
}

/** For a clip (original or corrected), its corrections: { original, result, ops, hints } or null. */
export function correctionFor(bundle, sha) {
  return correctionsOf(bundle).clips.find((e) => e.original === sha || e.result === sha) || null;
}

/**
 * How far a figure stands above its base's bare soles, as `groundedFor.lift` means it (VRMXA §8.4): its shoes'
 * lift plus the body's own ground lift (the measurer's `lengths.lift`, FITTING §9). Not its hips over Spec's:
 * other legs are the edit document's part (`edits`).
 */
export const liftOf = (figure) => figure?.of?.lift ?? ((figure?.lift ?? 0) + (figure?.bodyLift ?? 0));

/** The figure a ground correction solved on, as `groundedFor` records it (VRMXA §8.4). */
export function groundedForOf(figure, { base = null } = {}) {
  if (!figure) return null;
  return { base: figure.of?.base ?? base, lift: r4(liftOf(figure)), edits: figure.of?.edits ?? null };
}

// write it all, after checking: { doc, set: [[path, bytes]], del: [path] }
async function commit(bundle, { doc, set = [], del = [] }) {
  const entries = new Map(bundle.entries);
  for (const p of del) entries.delete(p);
  for (const [p, b] of set) entries.set(p, b);
  const closetIds = bundle.docs.closet ? new Set((bundle.docs.closet.items || []).map((i) => i.id)) : new Set();
  const problems = (await checkAnimations(doc, entries, { closetIds })).filter((p) => p.severity === 'error');
  if (problems.length) fail('invalid', `the animations would break the specification's rules: ${problems.slice(0, 3).map((p) => `${p.where}: ${p.message}`).join('; ')}`);
  for (const p of del) setEntry(bundle, p, null);
  for (const [p, b] of set) setEntry(bundle, p, b);
  setDocument(bundle, 'animations', doc.clips.length || doc.sets.length ? doc : null);
  return bundle;
}

/**
 * Move corrections kept the way this app kept them before VRMXA 0.31 (animations/x-xocialize.corrections.json)
 * into the fields: each corrected clip gets `derivedFrom`, `edit` (its edit document written) and
 * `groundedFor` when it was grounded; each original its `rate` and hints. The old file goes. Nothing happens
 * when there is no old file. → { moved: number of corrected clips }
 */
export async function migrateCorrections(bundle, { base = null, specHips = null } = {}) {
  const b = bundle.entries.get(CORRECTIONS_PATH);
  if (!b) return { moved: 0 };
  let old = null;
  try { old = JSON.parse(new TextDecoder().decode(b)); } catch { old = null; }
  const doc = animationsOf(bundle);
  const set = [];
  let moved = 0;
  for (const e of (old?.format === CORRECTIONS_FORMAT && Array.isArray(old.clips) ? old.clips : [])) {
    const orig = doc.clips.find((c) => c.sha256 === e.original);
    if (orig && e.hints) {
      const { playbackRate, ...rest } = e.hints;
      if (playbackRate && orig.rate == null) orig.rate = playbackRate;
      if (Object.keys(rest).length) orig[HINTS_KEY] = rest;
    }
    const res = e.result && doc.clips.find((c) => c.sha256 === e.result);
    if (!res || !orig) continue;
    res.derivedFrom = e.original;
    res.edit = editPath(e.result);
    const ground = [...(e.ops || [])].reverse().find((o) => o.kind === 'ground' && !o.off);
    const gf = ground ? groundedForOf(ground.figure || {}, { base: base ?? bundle.manifest.base?.sha256 ?? null }) : null;
    if (gf) res.groundedFor = gf;
    if (res.rate == null) res.rate = (e.ops || []).some((o) => o.kind === 'speed' && !o.off) ? 1 : orig.rate ?? 1;
    delete res.from;
    set.push([res.edit, jsonBytes({ format: EDIT_FORMAT, version: 1, generator: 'VRMXA Avatar Studio', derivedFrom: e.original, corrections: e.ops || [] })]);
    moved++;
  }
  await commit(bundle, { doc, set, del: [CORRECTIONS_PATH] });
  return { moved };
}

// a clip record for new bytes
async function recordFor(bytes, details = {}) {
  const clip = readVrma(bytes);
  const h = await sha256(bytes);
  return {
    clip, h,
    rec: {
      sha256: h, file: clipPath(h), name: details.name || clip.name || 'Motion',
      duration: details.duration ?? +clip.duration.toFixed(4), loops: details.loops ?? null, rootMotion: details.rootMotion ?? null, speed: details.speed ?? null,
      ...(details.rate != null && details.rate !== 1 ? { rate: details.rate } : {}),
      tracks: details.tracks || clipTracks(clip), source: details.source ?? null, licence: details.licence ?? null,
    },
  };
}

/**
 * What a clip probably is, from its keys: loops when its last pose is its first (2 cm), travels when its
 * hips leave where they start by 25 cm. For a clip brought in with no record.
 */
export function guessDetails(clip, rig) {
  if (!rig) return { loops: null, rootMotion: null };
  const T = track(clip, rig);
  return { loops: seam(T).gap < 0.02, rootMotion: travel(T).far > 0.25 ? 'travel' : 'inPlace' };
}

/**
 * Bring a clip in (ANI-1): a .vrma's bytes, stored once by its hash, with its details (VRMXA §8.4, `rate`
 * included). opts: { details, hints (kept on its record for the checker), rig (to guess loops and travel) }
 * → { sha256, record, added (false when it was there already) }
 */
export async function addClip(bundle, bytes, { details = {}, hints = null, rig = null } = {}) {
  if (!isVrma(bytes)) fail('refused', 'not a VRM animation (.vrma)');
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const { clip, h, rec } = await recordFor(bytes, details);
  const known = doc.clips.find((c) => c.sha256 === h);
  if (known) return { sha256: h, record: known, added: false };
  if (rig && (details.loops === undefined || details.rootMotion === undefined)) {
    const g = guessDetails(clip, rig);
    if (details.loops === undefined) rec.loops = g.loops;
    if (details.rootMotion === undefined) rec.rootMotion = g.rootMotion;
  }
  if (hints && Object.keys(hints).length) rec[HINTS_KEY] = hints;
  doc.clips.push(rec);
  await commit(bundle, { doc, set: [[rec.file, bytes]] });
  return { sha256: h, record: rec, added: true };
}

/**
 * Bring in the starter clips and the sets they make (STARTER_SETS): `files` is [{ entry (clips.json's),
 * bytes }], `listing` clips.json itself. Clips already there are kept. A set is added, or, when the
 * character has one of the same name (its own "Default"), the starter slots it leaves empty are filled in
 * and its own are kept; the starter default becomes the default only when the character has none.
 * → { clips, sets (added), filled (sets given slots) }
 */
export async function addStarterClips(bundle, files, listing = {}) {
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const set = [];
  const byId = {};
  for (const { entry, bytes } of files) {
    const r = starterRecord(entry, { listing });
    const { playbackRate, ...hints } = r.hints;
    const { h, rec } = await recordFor(bytes, { ...r.details, ...(playbackRate ? { rate: playbackRate } : {}) });
    byId[r.id] = h;
    if (doc.clips.some((c) => c.sha256 === h)) continue;
    rec[HINTS_KEY] = hints;
    doc.clips.push(rec);
    set.push([rec.file, bytes]);
  }
  const hasDefault = doc.sets.some((s) => s.default);
  const madeSets = [], filled = [];
  for (const s of STARTER_SETS) {
    const slots = {};
    for (const [slot, list] of Object.entries(s.slots)) {
      const l = list.filter((e) => byId[e.clip]).map((e) => ({ ...e, clip: byId[e.clip] }));
      if (l.length) slots[slot] = l;
    }
    const same = doc.sets.find((x) => x.name === s.name && !x.from);
    if (same) {
      let n = 0;
      for (const [slot, l] of Object.entries(slots)) if (!same.slots?.[slot]?.length) { (same.slots ||= {})[slot] = l; n++; }
      if (n) filled.push(same.id);
      continue;
    }
    const made = { id: newUuid(), name: s.name, default: s.default && !hasDefault, priority: s.priority, requires: [...s.requires], slots };
    doc.sets.push(made);
    madeSets.push(made.id);
  }
  await commit(bundle, { doc, set });
  return { clips: Object.values(byId), sets: madeSets, filled };
}

/** Change a clip's details (ANI-4): name, loops, rootMotion, speed, rate, source, licence. → the record */
/**
 * Why a clip's licence can't be written, or null (§8.4, D35): text, null, or a licence block in VRM's terms as an item's
 * `meta` (authors and licenseUrl required; VRM's values).
 */
export function clipLicenceProblem(l) {
  if (l === null || typeof l === 'string') return null;
  if (typeof l !== 'object' || Array.isArray(l)) return 'a clip\'s licence is text, or a licence block in VRM\'s terms';
  if (!Array.isArray(l.authors) || !l.authors.length || !l.authors.every((a) => typeof a === 'string' && a.trim())) return 'a clip\'s licence block names who made it (authors)';
  if (!(typeof l.licenseUrl === 'string' && l.licenseUrl.trim())) return 'a clip\'s licence block gives the licence (licenseUrl)';
  const enums = { commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'], creditNotation: ['required', 'unnecessary'], modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'] };
  for (const [k, vals] of Object.entries(enums)) if (l[k] !== undefined && !vals.includes(l[k])) return `${k} must be one of ${vals.join(', ')}`;
  if (l.allowRedistribution !== undefined && typeof l.allowRedistribution !== 'boolean') return 'allowRedistribution must be true or false';
  return null;
}

export async function setClipDetails(bundle, sha, patch) {
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const c = doc.clips.find((x) => x.sha256 === sha);
  if (!c) fail('no-clip', `there is no clip ${String(sha).slice(0, 12)}…`);
  for (const k of Object.keys(patch)) if (!['name', 'loops', 'rootMotion', 'speed', 'rate', 'source', 'licence'].includes(k)) fail('refused', `"${k}" is not a clip detail that can be changed`);
  if (patch.rootMotion !== undefined && ![null, 'inPlace', 'travel'].includes(patch.rootMotion)) fail('refused', 'rootMotion is inPlace, travel or null');
  if (patch.speed !== undefined && patch.speed !== null && !(Number.isFinite(+patch.speed) && +patch.speed >= 0)) fail('refused', 'speed is metres per second, 0 or more, or null');
  if (patch.rate !== undefined && patch.rate !== null && !(Number.isFinite(+patch.rate) && +patch.rate > 0)) fail('refused', 'rate is a playback speed above 0, or null');
  if (patch.loops !== undefined && ![true, false, null].includes(patch.loops)) fail('refused', 'loops is true, false or null');
  if (patch.licence !== undefined) { const why = clipLicenceProblem(patch.licence); if (why) fail('refused', why); }
  Object.assign(c, patch, patch.speed != null ? { speed: +patch.speed } : {}, patch.rate != null ? { rate: +patch.rate } : {});
  if (c.from !== undefined) delete c.from; // edited: the character's own now (§8.3)
  await commit(bundle, { doc });
  return c;
}

/**
 * Take a clip out of the character and out of every set; sets left empty lose the slot. A corrected clip goes
 * with its edit document, and its original too unless another edit document still refers to it; an original
 * goes with every corrected clip whose edit document refers to it (the original stays while one does, D34).
 * A clip that only names where it came from (`derivedFrom` with no `edit`) holds nothing back. → { removed }
 */
export async function removeClip(bundle, sha) {
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const rec = doc.clips.find((c) => c.sha256 === sha);
  if (!rec) fail('no-clip', `there is no clip ${String(sha).slice(0, 12)}…`);
  const gone = new Set([sha]);
  for (const c of doc.clips) if (c.edit && c.derivedFrom === sha) gone.add(c.sha256);
  if (rec.edit && rec.derivedFrom && !doc.clips.some((c) => c.edit && c.derivedFrom === rec.derivedFrom && !gone.has(c.sha256))) gone.add(rec.derivedFrom);
  const del = doc.clips.filter((c) => gone.has(c.sha256)).flatMap((c) => [c.file, ...(c.edit ? [c.edit] : [])]);
  doc.clips = doc.clips.filter((c) => !gone.has(c.sha256));
  for (const s of doc.sets) {
    for (const [slot, list] of Object.entries(s.slots || {})) { s.slots[slot] = (list || []).filter((x) => !gone.has(x.clip)); if (!s.slots[slot].length) delete s.slots[slot]; }
  }
  if (doc.sets.some((s) => s.default && !(s.slots?.idle || []).length)) fail('refused', 'the clip fills the default set\'s idle on its own: give idle another clip first (VRMXA §8.2)');
  await commit(bundle, { doc, del: del.filter((p) => bundle.entries.has(p)) });
  return { removed: [...gone] };
}

/**
 * Keep a corrected clip's corrections fixed: its edit document goes, `derivedFrom` stays as where it came from,
 * and its original may then be removed (D34). → the record
 */
export async function flattenClip(bundle, sha) {
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const c = doc.clips.find((x) => x.sha256 === sha);
  if (!c?.edit) fail('refused', 'the clip has no edit document to keep fixed');
  const del = [c.edit];
  delete c.edit;
  await commit(bundle, { doc, del: del.filter((p) => bundle.entries.has(p)) });
  return c;
}

/**
 * Correct a clip (ANI-9): `ops` replace the corrections kept for it (correct.js). The original is kept; the
 * corrected clip is made from it, names it (`derivedFrom`), keeps the ops in its edit document (`edit`), records
 * its `rate` and, when grounded, `groundedFor`; the sets play it. Empty ops take the corrections away and the
 * sets play the original again. opts: { rig (Spec's), figure (for checking) }.
 * → { original, result (sha256 or null), record, notes, before, after (check results), keys }
 */
export async function correctClip(bundle, sha, ops, { rig, figure = null } = {}) {
  if (!rig) fail('refused', 'correcting needs Spec\'s rig');
  await migrateCorrections(bundle, { specHips: rig.restWorld.hips[1] });
  const doc = animationsOf(bundle);
  const cur = doc.clips.find((c) => c.sha256 === sha);
  if (!cur) fail('no-clip', `there is no clip ${String(sha).slice(0, 12)}…`);
  const originalSha = cur.edit && cur.derivedFrom ? cur.derivedFrom : sha;
  const orig = doc.clips.find((c) => c.sha256 === originalSha);
  if (!orig) fail('no-clip', `the original ${String(originalSha).slice(0, 12)}… is not in the character`);
  const oldResults = doc.clips.filter((c) => c.edit && c.derivedFrom === originalSha).map((c) => c.sha256);
  const original = readVrma(bundle.entries.get(orig.file));
  const details = { loops: orig.loops, rootMotion: orig.rootMotion, speed: orig.speed, rate: orig.rate ?? 1 };
  const hints = orig[HINTS_KEY] || {};
  const set = [], del = [];
  const before = checkClip(original, { details: orig, rig, figure, hints, corrections: [] });
  let result = null, record = orig, notes = [], after = before, keys = null;
  if (ops.length) {
    const r = applyCorrections(original, ops, { rig, details });
    notes = r.notes; keys = r.keys;
    const bytes = writeVrma(r.clip, { extras: { ...(original.extras || {}), 'x-xocialize.corrected': { from: originalSha } } });
    const h = await sha256(bytes);
    result = h;
    const { file: _f, sha256: _s, from: _from, edit: _e, derivedFrom: _d, groundedFor: _g, [HINTS_KEY]: _h, ...base } = orig;
    record = { ...base, sha256: h, file: clipPath(h), ...r.details, rate: r.details.rate ?? orig.rate ?? 1, tracks: clipTracks(r.clip), derivedFrom: originalSha, edit: editPath(h) };
    if (r.details.speed === undefined) record.speed = orig.speed;
    if (record.groundedFor) record.groundedFor = { ...record.groundedFor, base: record.groundedFor.base ?? bundle.manifest.base?.sha256 ?? null };
    const existing = doc.clips.find((c) => c.sha256 === h);
    if (existing) Object.assign(existing, record); else { doc.clips.push(record); set.push([record.file, bytes]); }
    set.push([record.edit, jsonBytes({ format: EDIT_FORMAT, version: 1, generator: 'VRMXA Avatar Studio', derivedFrom: originalSha, corrections: ops })]);
    after = checkClip(r.clip, { details: record, rig, figure, hints, corrections: ops });
  }
  // the sets play the corrected clip (or the original again); a brought set that is edited is the character's
  const playing = result || originalSha;
  for (const from of [originalSha, ...oldResults].filter((x) => x && x !== playing)) {
    for (const s of doc.sets) if (clipUses({ sets: [s] }, from).length) delete s.from;
    swapClip(doc, from, playing);
  }
  for (const old of oldResults) {
    if (old === result) continue;
    const o = doc.clips.find((c) => c.sha256 === old);
    if (o) { doc.clips = doc.clips.filter((c) => c !== o); del.push(o.file, o.edit); }
  }
  await commit(bundle, { doc, set, del: del.filter((p) => p && bundle.entries.has(p) && !set.some(([q]) => q === p)) });
  return { original: originalSha, result, record, notes, before, after, keys };
}

// ---- sets ------------------------------------------------------------------------------------------------

function checkSetPatch(p) {
  if (p.requires !== undefined && (!Array.isArray(p.requires) || !p.requires.every(isTag))) fail('refused', 'requires is a list of namespace:value tags');
  if (p.priority !== undefined && !Number.isFinite(+p.priority)) fail('refused', 'priority is a number');
  if (p.slots !== undefined) for (const [slot, list] of Object.entries(p.slots)) {
    if (!isSlot(slot)) fail('refused', `"${slot}" is not a slot (VRMXA §8.2's vocabulary, or x-<vendor>.<name>)`);
    if (!Array.isArray(list)) fail('refused', `slot ${slot} is a list of clips`);
  }
}

/** Make a set (ANI-2). → its id */
export async function createSet(bundle, { name = 'New set', requires = [], priority = 0, slots = {}, default: isDefault = false } = {}) {
  checkSetPatch({ requires, priority, slots });
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  if (isDefault) for (const s of doc.sets) s.default = false;
  const id = newUuid();
  doc.sets.push({ id, name, default: !!isDefault || !doc.sets.some((s) => s.default) && !!(slots.idle || []).length, priority: +priority, requires: [...requires], slots: clone(slots) });
  await commit(bundle, { doc });
  return id;
}

/**
 * Change a set (name, requires, priority, slots, default). Editing a set an item brought makes it the
 * character's own: its `from` goes (§8.3, ANI-6). → the set
 */
export async function updateSet(bundle, id, patch) {
  checkSetPatch(patch);
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const s = doc.sets.find((x) => x.id === id);
  if (!s) fail('no-set', `there is no set ${id}`);
  if (patch.default === true) for (const x of doc.sets) x.default = x === s;
  else if (patch.default === false && s.default) fail('refused', 'one set is the default: make another the default instead (VRMXA §8.2)');
  for (const k of ['name', 'requires', 'priority', 'slots']) if (patch[k] !== undefined) s[k] = k === 'priority' ? +patch[k] : clone(patch[k]);
  delete s.from;
  await commit(bundle, { doc });
  return s;
}

/** Put clips in a slot of a set (entries: [{ clip, weight?, rate?, blendIn? }]; empty takes the slot out). */
export async function setSlot(bundle, id, slot, entries) {
  const doc = animationsOf(bundle);
  const s = doc.sets.find((x) => x.id === id);
  if (!s) fail('no-set', `there is no set ${id}`);
  const slots = { ...(s.slots || {}) };
  if (entries?.length) slots[slot] = entries; else delete slots[slot];
  return updateSet(bundle, id, { slots });
}

/** Remove a set (not the default while others need it). */
export async function removeSet(bundle, id) {
  await migrateCorrections(bundle);
  const doc = animationsOf(bundle);
  const s = doc.sets.find((x) => x.id === id);
  if (!s) fail('no-set', `there is no set ${id}`);
  if (s.default && doc.sets.some((x) => x !== s && !x.from)) fail('refused', 'the default set can\'t be removed while the character has other sets of its own: make another the default first');
  doc.sets = doc.sets.filter((x) => x !== s);
  await commit(bundle, { doc });
  return { removed: id };
}

/**
 * The equipped state (§8.3): every worn item's tags plus its state's, and per item what it adds.
 * → { tags: [..], items: [{ id, name, state, tags }] }
 */
export async function equippedState(bundle) {
  const c = closetOf(bundle);
  const items = [];
  for (const id of c.worn.items) {
    const e = c.items.find((x) => x.id === id);
    let tags = [];
    try { tags = itemTags((await itemOf(bundle, id)).manifest, c.worn.states[id]); } catch { tags = [...(e?.tags || [])]; }
    items.push({ id, name: e?.name || id, state: c.worn.states[id] ?? null, tags });
  }
  return { tags: [...new Set(items.flatMap((i) => i.tags))].sort(), items };
}

/** Which set is active and what each slot plays, for what is worn (ANI-3's preview), or for given tags. */
export async function motionPlan(bundle, { tags = null } = {}) {
  const eq = tags ? { tags, items: [] } : await equippedState(bundle);
  const doc = animationsOf(bundle);
  const T = new Set(eq.tags);
  return { equipped: eq, active: activeSets(doc, T).map((s) => ({ id: s.id, name: s.name, priority: s.priority ?? 0, from: s.from ?? null, default: !!s.default })), slots: resolveSlots(doc, T) };
}
