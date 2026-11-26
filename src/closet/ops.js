// The closet protocol (CLOSET.md 0.5; VRMXA §7; PRD CLO-1, CLO-2, CLO-4, CLO-9, CLO-10, REF-1): every
// operation of §5, on a bundle as readBundle or createBundle gives it. Each one is all or nothing: it
// works on copies, checks the result against the invariants (C1 to C5, C7), and only then writes the
// closet document, the animations document and the entries into the bundle. When a step fails, it
// throws a ClosetError and the bundle is as it was.
//
// Operations that change the saved look (CLOSET.md §3) need an app that can fit. This library can
// (closet/avatar.js redraws avatar.vrm), so they are allowed by default; an app that can't fit passes
// { canFit: false } and they are refused, as §3 says. Changing the look leaves avatar.vrm out of date
// until it is redrawn: redrawAvatar (closet/avatar.js), or the `redraw` option of each operation,
// which redraws it in the same step (CLOSET.md §5.2 step 4: avatar.vrm, avatar.of; the thumbnail is
// the app's, since this library has no renderer: VRMXA §5.2, D32).
//
// What is worn is recorded by `id`, with states and outfits (VRMXA §7.3); the slot rules are VRMXA §7.2's.

import { clone, isPlainObject, newUuid } from '../bytes.js';
import { isGlb } from '../glb.js';
import { sha12, sha256 } from '../hash.js';
import { closetItemPath, documentPaths } from '../layout.js';
import { avatarOf, setDocument, setEntry } from '../vrmxa.js';
import { closetEntryFor, itemFromBareGlb, readItem, RefusedError, writeItem } from '../vrmxw.js';
import { isZip } from '../zip.js';
import { cleanFitting, methodFor, stateOf } from './fit.js';

export class ClosetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClosetError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ClosetError(code, message); };

/** An empty closet document (VRMXA §7.4). */
export const emptyCloset = () => ({ format: 'vrmxa-closet', version: 1, hair: null, worn: { items: [], states: {}, outfit: null }, items: [], outfits: [] });

/** The closet document of a bundle (a copy; an empty one when it has none). */
export function closetOf(bundle) {
  const c = bundle.docs.closet ? clone(bundle.docs.closet) : emptyCloset();
  c.worn = isPlainObject(c.worn) ? c.worn : { items: [], states: {}, outfit: null };
  c.worn.items = Array.isArray(c.worn.items) ? c.worn.items : [];
  c.worn.states = isPlainObject(c.worn.states) ? c.worn.states : {};
  if (c.worn.outfit === undefined) c.worn.outfit = null;
  c.items = Array.isArray(c.items) ? c.items : [];
  c.outfits = Array.isArray(c.outfits) ? c.outfits : [];
  if (c.hair === undefined) c.hair = null;
  return c;
}

const entryOf = (closet, id) => closet.items.find((e) => e.id === id) || null;
const need = (closet, id) => entryOf(closet, id) || fail('not-in-closet', `there is no item ${id} in the closet`);
const stateNames = (e) => (Array.isArray(e?.states) ? e.states.map((s) => s.name) : []);
const isDefault = (e, name) => !stateNames(e).length || stateNames(e)[0] === name;
const fits = (opts, what) => { if (opts.canFit === false) fail('needs-fitting', `${what} changes what the character wears, which takes an app that can fit (CLOSET.md §3)`); };

// ---- the rules ----------------------------------------------------------------------------------

/**
 * The items a list can't hold together, by the slot rules (VRMXA §7.2): one per slot except
 * `accessory`; a `onepiece` with no `tops` or `bottoms`. → [text]
 */
export function slotProblems(closet, ids) {
  const out = [];
  const slots = new Map();
  for (const id of ids) {
    const e = entryOf(closet, id);
    if (!e) { out.push(`${id} is not in the closet`); continue; }
    if (e.slot === 'hair') out.push(`${e.name || id} is a hair piece: hair is chosen once, not worn or put in outfits (VRMXA §6, D4)`);
    if (!slots.has(e.slot)) slots.set(e.slot, []);
    slots.get(e.slot).push(id);
  }
  if (new Set(ids).size !== ids.length) out.push('an item is listed twice');
  for (const [s, list] of slots) if (list.length > 1 && s !== 'accessory' && s !== 'hair') out.push(`${list.length} items in the slot "${s}": one per slot except accessory (VRMXA §7.2)`);
  if (slots.has('onepiece') && (slots.has('tops') || slots.has('bottoms'))) out.push('a onepiece with tops or bottoms (VRMXA §7.2)');
  return out;
}

/**
 * Check a closet document against the invariants an operation must keep: C3 (each item once, a file
 * for each), C4 (what is worn and every outfit: closet items, slot rules), C5 (states the items have,
 * the outfit named exists), hair a hair piece in the closet. → [text]; empty when it holds.
 * entries: the bundle's entries (for C3's files), or null to skip that part.
 */
export function closetProblems(closet, entries = null) {
  const out = [];
  const ids = new Set();
  for (const e of closet.items) {
    if (ids.has(e.id)) out.push(`C3: ${e.id} is listed twice`);
    ids.add(e.id);
    if (entries && !entries.has(e.file)) out.push(`C3: ${e.file} is listed but not in the bundle`);
  }
  if (closet.hair != null) {
    const h = entryOf(closet, closet.hair);
    if (!h) out.push(`hair names ${closet.hair}, which is not in the closet`);
    else if (h.slot !== 'hair') out.push(`hair names ${h.name}, which is not a hair piece`);
  }
  const checkList = (what, list, states) => {
    for (const p of slotProblems(closet, list)) out.push(`C4: ${what}: ${p}`);
    for (const [id, st] of Object.entries(states || {})) {
      if (!list.includes(id)) { out.push(`C5: ${what} records a state for ${id}, which it doesn't list`); continue; }
      if (!stateNames(entryOf(closet, id)).includes(st)) out.push(`C5: ${what} puts ${entryOf(closet, id)?.name || id} in the state "${st}", which it doesn't have`);
    }
  };
  checkList('what is worn', closet.worn.items, closet.worn.states);
  if (closet.worn.outfit != null && !closet.outfits.some((o) => o.id === closet.worn.outfit)) out.push('C5: worn.outfit names an outfit that does not exist');
  for (const o of closet.outfits) checkList(`the outfit "${o.name}"`, o.items || [], o.states);
  return out;
}

// ---- committing a change, all at once ---------------------------------------------------------------

/**
 * Write a changed closet (and animations document, and entries) into the bundle, after checking it.
 * change: { closet, animations (undefined: unchanged; null: removed), set: [[path, bytes]], del: [path] }
 */
async function commit(bundle, { closet, animations, set = [], del = [], look = false }) {
  // a change that leaves the saved look as it was keeps avatar.vrm current when it was (VRMXA §4: the
  // new closet.json hash is written into avatar.of); one that changes the look leaves it to be redrawn
  const wasCurrent = look ? false : await avatarIsCurrent(bundle);
  const entries = new Map(bundle.entries);
  for (const p of del) entries.delete(p);
  for (const [p, b] of set) entries.set(p, b);
  const problems = closetProblems(closet, entries);
  if (problems.length) fail('invariant', `the closet would break its rules: ${problems.slice(0, 3).join('; ')}`);
  // nothing below can fail
  for (const p of del) setEntry(bundle, p, null);
  for (const [p, b] of set) setEntry(bundle, p, b);
  setDocument(bundle, 'closet', closet);
  if (animations !== undefined) setDocument(bundle, 'animations', animations);
  bundle.avatarCurrent = wasCurrent;
  return bundle;
}

/** Does avatar.vrm show what the bundle now describes (avatar.of equal to what it would be made from)? */
export async function avatarIsCurrent(bundle) {
  if (bundle.avatarCurrent) return true;
  const of = bundle.manifest.avatar?.of;
  if (!isPlainObject(of)) return false;
  const now = await avatarOf(bundle);
  return of.base === now.base && (of.edits ?? null) === now.edits && (of.closet ?? null) === now.closet;
}

// ---- items in a bundle ----------------------------------------------------------------------------------

const itemCache = new WeakMap(); // bytes → item

/** The item a closet entry names, read from its file (cached by its bytes). */
export async function itemOf(bundle, id, opts = {}) {
  const e = entryOf(closetOf(bundle), id);
  if (!e) fail('not-in-closet', `there is no item ${id} in the closet`);
  const bytes = bundle.entries.get(e.file);
  if (!bytes) fail('missing', `${e.file} is not in the bundle`);
  if (itemCache.has(bytes)) return itemCache.get(bytes);
  const item = await readItem(bytes, opts);
  itemCache.set(bytes, item);
  return item;
}

// read what is to be added: a .vrmxw (checked), or a bare GLB packed first (CLO-2) → { item, bytes }
async function incoming(input, { spec, slot, type, name } = {}) {
  if (input?.kind === 'vrmxw' && input.manifest) {
    const bytes = await writeItem(input);
    return { item: await readItem(bytes, { spec }), bytes };
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isZip(bytes)) {
    try { return { item: await readItem(bytes, { spec }), bytes }; } catch (e) {
      if (e instanceof RefusedError) fail('refused', `the item was refused: ${e.problems.filter((p) => p.severity === 'error').slice(0, 3).map((p) => p.message).join('; ')}`);
      throw e;
    }
  }
  if (isGlb(bytes)) {
    // VRMXA §7.1, D12: a closet never holds a bare model; it is packed as a .vrmxw first (VRMXW §14)
    const item = await itemFromBareGlb(bytes, { slot, type, name });
    const packed = await writeItem(item);
    let read;
    try { read = await readItem(packed, { spec }); } catch (e) {
      if (e instanceof RefusedError) fail('refused', `the bare model could not be packed as an item: ${e.problems.filter((p) => p.severity === 'error').slice(0, 3).map((p) => p.message).join('; ')}`);
      throw e;
    }
    return { item: read, bytes: packed, packed: true };
  }
  return fail('refused', 'not a .vrmxw item or a GLB model');
}

function checkBase(bundle, item) {
  const base = bundle.manifest.base || {};
  const m = item.manifest;
  if (m.base?.sha256 !== base.sha256) fail('wrong-base', `"${m.name}" is fitted to another base (${String(m.base?.sha256).slice(0, 12)}…), not this character's: it has to be moved onto this base first (CLOSET.md C2, FITTING.md §7)`);
  if ((m.base?.species || 'human') !== (base.species || 'human')) fail('wrong-base', `"${m.name}" is for another species (${m.base?.species}) (CLOSET.md C2)`);
}

// the animation clips and sets an item brings, copied into the character's document, marked as its (VRMXW §9, §12)
async function bringAnimations(animations, item, set, { idFactory = newUuid } = {}) {
  const a = item.manifest.animations;
  if (!a?.clips?.length && !a?.sets?.length) return animations;
  const doc = animations ? clone(animations) : { format: 'vrmxa-animations', version: 1, clips: [], sets: [] };
  doc.clips ||= []; doc.sets ||= [];
  const id = item.manifest.id;
  for (const c of a.clips || []) {
    const bytes = item.entries.get(c.file);
    if (!bytes) fail('refused', `the item names the clip ${c.file}, which it doesn't carry`);
    const h = await sha256(bytes);
    if (doc.clips.some((x) => x.sha256 === h)) continue; // already the character's, or brought by another item: stored once
    const file = `animations/clips/${sha12(h)}.vrma`;
    const { file: _f, ...rest } = c;
    doc.clips.push({ ...clone(rest), sha256: h, file, from: id });
    set.push([file, bytes]);
  }
  for (const s of a.sets || []) doc.sets.push({ id: idFactory(), name: s.name, default: false, priority: s.priority ?? 0, requires: clone(s.requires || []), from: id, slots: clone(s.slots || {}) });
  return doc;
}

// take an item's brought sets out, then its clips that no remaining set uses (CLOSET.md §5.8 step 3).
// A clip of the item's that a remaining set still uses is the character's now: its `from` goes.
function dropAnimations(animations, id, del) {
  if (!animations) return animations;
  const doc = clone(animations);
  doc.sets = (doc.sets || []).filter((s) => s.from !== id);
  const used = new Set(doc.sets.flatMap((s) => Object.values(s.slots || {}).flat().map((e) => e?.clip)));
  // an original an edit document refers to stays while it does (VRMXA §8.1, D34): the character's now
  for (const c of doc.clips || []) if (c.edit && c.derivedFrom) used.add(c.derivedFrom);
  doc.clips = (doc.clips || []).filter((c) => {
    if (c.from !== id) return true;
    if (used.has(c.sha256)) { delete c.from; return true; }
    del.push(c.file);
    return false;
  });
  return doc;
}

// ---- §5.1 add an item ----------------------------------------------------------------------------------

/**
 * Add an item to the closet as a spare (§5.1). Any app may. input: a .vrmxw's bytes, an item object,
 * or a bare GLB (packed first, CLO-2; opts.slot and opts.type say what it is). opts: { source (the file
 * name, shown only), spec (spec.vrm's bytes, for the bind check), thumbnail }.
 * → { id, entry, packed (true when a bare model was packed) }
 */
export async function addItem(bundle, input, opts = {}) {
  const { item, bytes, packed = false } = await incoming(input, opts);
  checkBase(bundle, item);
  const closet = closetOf(bundle);
  const m = item.manifest;
  if (entryOf(closet, m.id)) fail('duplicate', `"${m.name}" (${m.id}) is in the closet already: a newer revision of it is an update (§5.11)`);
  const file = closetItemPath(m.slot, m.id);
  const set = [[file, bytes]];
  let thumbnail = null;
  if (item.entries.has('thumbnail.png')) { thumbnail = `closet/thumbs/${m.id}.png`; set.push([thumbnail, item.entries.get('thumbnail.png')]); }
  const entry = await closetEntryFor(item, { file, thumbnail, source: opts.source ?? null });
  closet.items.push(entry);
  const animations = await bringAnimations(bundle.docs.animations, item, set, opts);
  await commit(bundle, { closet, animations: animations === bundle.docs.animations ? undefined : animations, set });
  itemCache.set(bytes, item);
  return { id: m.id, entry, packed };
}

// ---- §5.2 put on, §5.3 take off, §5.4 state ----------------------------------------------------------------

/** What putting this item on takes off by the slot rules (VRMXA §7.2): ids. */
export function displacedBy(closet, id) {
  const e = entryOf(closet, id);
  if (!e) return [];
  return closet.worn.items.filter((w) => {
    if (w === id) return false;
    const o = entryOf(closet, w);
    if (!o) return false;
    if (e.slot !== 'accessory' && o.slot === e.slot) return true;
    if (e.slot === 'onepiece' && (o.slot === 'tops' || o.slot === 'bottoms')) return true;
    if ((e.slot === 'tops' || e.slot === 'bottoms') && o.slot === 'onepiece') return true;
    return false;
  });
}

// the method an item asking for spec-fit is fitted by is recorded in its fine-tuning: `spec-fit` for
// the slots Spec-fit covers, `bones` where it isn't used (shoes, socks; the automatic fit switched off;
// CLOSET.md §4, VRMXA §7.5 `method`)
function recordMethod(closet, id, manifestFit, slot) {
  const e = entryOf(closet, id);
  const asked = manifestFit?.method || null;
  if (asked !== 'spec-fit') return;
  const used = methodFor({ fit: manifestFit, slot: slot ?? e.slot }, e.fitting);
  e.fitting = { ...(e.fitting || {}), method: used };
}

/**
 * Put an item on (§5.2), in its default state or opts.state. What its slot rules replace is taken off
 * and returned in `removed`, so an app can offer to put it back (PRD CLO-5). → { removed: [ids] }
 */
export async function putOn(bundle, id, opts = {}) {
  fits(opts, 'Putting an item on');
  const closet = closetOf(bundle);
  const e = need(closet, id);
  if (e.slot === 'hair') fail('is-hair', `"${e.name}" is a hair piece: hair is changed with changeHair (§5.7)`);
  if (opts.state != null && !stateNames(e).includes(opts.state)) fail('no-state', `"${e.name}" has no state "${opts.state}" (it has ${stateNames(e).join(', ') || 'none'})`);
  const removed = displacedBy(closet, id);
  closet.worn.items = closet.worn.items.filter((w) => !removed.includes(w));
  for (const r of removed) delete closet.worn.states[r];
  if (!closet.worn.items.includes(id)) closet.worn.items.push(id);
  if (opts.state != null && !isDefault(e, opts.state)) closet.worn.states[id] = opts.state; else delete closet.worn.states[id];
  const item = await itemOf(bundle, id);
  recordMethod(closet, id, item.manifest.fit);
  await commit(bundle, { closet, look: true });
  await maybeRedraw(bundle, opts);
  return { removed };
}

/** Take an item off (§5.3). → { taken: true } (false when it wasn't worn) */
export async function takeOff(bundle, id, opts = {}) {
  fits(opts, 'Taking an item off');
  const closet = closetOf(bundle);
  need(closet, id);
  if (!closet.worn.items.includes(id)) return { taken: false };
  closet.worn.items = closet.worn.items.filter((w) => w !== id);
  delete closet.worn.states[id];
  await commit(bundle, { closet, look: true });
  await maybeRedraw(bundle, opts);
  return { taken: true };
}

/** Change a worn item's state (§5.4). → { state } */
export async function setState(bundle, id, state, opts = {}) {
  fits(opts, 'Changing a worn item\'s state');
  const closet = closetOf(bundle);
  const e = need(closet, id);
  if (!closet.worn.items.includes(id)) fail('not-worn', `"${e.name}" is not worn: a state is recorded for worn items (§5.4)`);
  if (!stateNames(e).includes(state)) fail('no-state', `"${e.name}" has no state "${state}" (it has ${stateNames(e).join(', ') || 'none'})`);
  if (isDefault(e, state)) delete closet.worn.states[id]; else closet.worn.states[id] = state;
  await commit(bundle, { closet, look: true });
  await maybeRedraw(bundle, opts);
  return { state };
}

// ---- §5.5 apply an outfit, §5.12 outfits ---------------------------------------------------------------------

/** Apply an outfit (§5.5): everything worn is replaced by its items, in the states it records. → { removed, added } */
export async function applyOutfit(bundle, outfitId, opts = {}) {
  fits(opts, 'Applying an outfit');
  const closet = closetOf(bundle);
  const o = closet.outfits.find((x) => x.id === outfitId) || fail('no-outfit', `there is no outfit ${outfitId}`);
  const before = closet.worn.items;
  closet.worn.items = [...(o.items || [])];
  closet.worn.states = clone(o.states || {});
  closet.worn.outfit = o.id;
  for (const id of closet.worn.items) recordMethod(closet, id, (await itemOf(bundle, id)).manifest.fit);
  await commit(bundle, { closet, look: true });
  await maybeRedraw(bundle, opts);
  return { removed: before.filter((x) => !closet.worn.items.includes(x)), added: closet.worn.items.filter((x) => !before.includes(x)) };
}

/** Does what is worn still match the outfit last applied (PRD CLO-12)? → { outfit (id or null), name, changed } */
export function outfitStatus(closet) {
  const c = closet?.worn ? closet : closetOf({ docs: { closet } });
  const o = c.worn.outfit != null ? c.outfits.find((x) => x.id === c.worn.outfit) : null;
  if (!o) return { outfit: null, name: null, changed: false };
  const a = [...c.worn.items].sort(), b = [...(o.items || [])].sort();
  const sameItems = a.length === b.length && a.every((x, i) => x === b[i]);
  const st = (s) => JSON.stringify(Object.entries(s || {}).sort());
  return { outfit: o.id, name: o.name, changed: !sameItems || st(c.worn.states) !== st(o.states) };
}

function outfitBody(closet, items, states) {
  const probs = slotProblems(closet, items);
  if (probs.length) fail('slot', `the outfit breaks the slot rules: ${probs[0]}`);
  const s = {};
  for (const [id, st] of Object.entries(states || {})) {
    if (!items.includes(id)) continue;
    const e = entryOf(closet, id);
    if (!stateNames(e).includes(st)) fail('no-state', `"${e?.name}" has no state "${st}"`);
    if (!isDefault(e, st)) s[id] = st;
  }
  return { items: [...items], states: s };
}

/**
 * Save what is worn as an outfit (§5.12): a new one named `name`, or over an existing one
 * (opts.over, its id: "update from what is worn"). Any app may. → { id }
 */
export async function saveOutfit(bundle, name, opts = {}) {
  const closet = closetOf(bundle);
  const body = outfitBody(closet, closet.worn.items, closet.worn.states);
  let id;
  if (opts.over != null) {
    const o = closet.outfits.find((x) => x.id === opts.over) || fail('no-outfit', `there is no outfit ${opts.over}`);
    Object.assign(o, body);
    if (name) o.name = name;
    id = o.id;
  } else {
    if (!String(name || '').trim()) fail('name', 'an outfit needs a name');
    id = (opts.idFactory || newUuid)();
    closet.outfits.push({ id, name: String(name).trim(), ...body, thumbnail: null });
  }
  if (opts.markWorn !== false) closet.worn.outfit = id; // the look now matches it
  await commit(bundle, { closet });
  return { id };
}

/** Make or change an outfit by listing its items and states directly (§5.12). Any app may. → { id } */
export async function makeOutfit(bundle, { id = null, name, items, states = {} }, opts = {}) {
  const closet = closetOf(bundle);
  const body = outfitBody(closet, items || [], states);
  if (id != null && closet.outfits.some((o) => o.id === id)) {
    const o = closet.outfits.find((x) => x.id === id);
    Object.assign(o, body);
    if (name) o.name = name;
  } else {
    if (!String(name || '').trim()) fail('name', 'an outfit needs a name');
    id = id ?? (opts.idFactory || newUuid)();
    closet.outfits.push({ id, name: String(name).trim(), ...body, thumbnail: null });
  }
  await commit(bundle, { closet });
  return { id };
}

/** Rename an outfit (§5.12). */
export async function renameOutfit(bundle, id, name) {
  if (!String(name || '').trim()) fail('name', 'an outfit needs a name');
  const closet = closetOf(bundle);
  const o = closet.outfits.find((x) => x.id === id) || fail('no-outfit', `there is no outfit ${id}`);
  o.name = String(name).trim();
  await commit(bundle, { closet });
  return { id };
}

/** Duplicate an outfit, as a new one (PRD CLO-3). → { id } */
export async function duplicateOutfit(bundle, id, { name, idFactory = newUuid } = {}) {
  const closet = closetOf(bundle);
  const o = closet.outfits.find((x) => x.id === id) || fail('no-outfit', `there is no outfit ${id}`);
  const copy = { ...clone(o), id: idFactory(), name: name || `${o.name} (copy)`, thumbnail: null };
  closet.outfits.splice(closet.outfits.indexOf(o) + 1, 0, copy);
  await commit(bundle, { closet });
  return { id: copy.id };
}

/** Delete an outfit (§5.12). Deleting the one in worn.outfit clears that hint; what is worn stays. */
export async function deleteOutfit(bundle, id) {
  const closet = closetOf(bundle);
  if (!closet.outfits.some((x) => x.id === id)) fail('no-outfit', `there is no outfit ${id}`);
  closet.outfits = closet.outfits.filter((x) => x.id !== id);
  if (closet.worn.outfit === id) closet.worn.outfit = null;
  await commit(bundle, { closet });
  return { id };
}

// ---- §5.6 fine-tune, §5.7 hair ---------------------------------------------------------------------------

/**
 * Fine-tune an item on this body (§5.6; VRMXA §7.5): its `fitting` in closet.json, never in the item.
 * fitting: the whole block (null removes it); with opts.merge, the given keys are merged into what is
 * there (adjust merged control by control). A worn item needs an app that can fit; a spare, any app.
 * → { fitting }
 */
export async function setFitting(bundle, id, fitting, opts = {}) {
  const closet = closetOf(bundle);
  const e = need(closet, id);
  if (closet.worn.items.includes(id) || closet.hair === id) fits(opts, 'Fine-tuning a worn item');
  let next = fitting;
  if (opts.merge && fitting) {
    next = { ...(e.fitting || {}), ...fitting };
    if (fitting.adjust) next.adjust = { ...(e.fitting?.adjust || {}), ...fitting.adjust };
    if (fitting.rule) next.rule = { ...(e.fitting?.rule || {}), ...fitting.rule };
  }
  const { fitting: clean, problems } = cleanFitting(next);
  if (problems.length) fail('fitting', problems.join('; '));
  if (clean) e.fitting = clean; else delete e.fitting;
  // switching the automatic fit on or off changes the method used (VRMXA §7.5 `auto`, `method`)
  if (closet.worn.items.includes(id) && 'auto' in (fitting || {}) || clean?.method) recordMethod(closet, id, (await itemOf(bundle, id)).manifest.fit);
  await commit(bundle, { closet, look: closet.worn.items.includes(id) || closet.hair === id });
  await maybeRedraw(bundle, opts);
  return { fitting: clean };
}

/** Change hair (§5.7): wear this hair piece (an id in the closet), or none (null). Outfits never change it. */
export async function changeHair(bundle, id, opts = {}) {
  fits(opts, 'Changing hair');
  const closet = closetOf(bundle);
  if (id != null) {
    const e = need(closet, id);
    if (e.slot !== 'hair') fail('not-hair', `"${e.name}" is a ${e.slot} item, not a hair piece`);
  }
  const look = closet.hair !== (id ?? null);
  closet.hair = id ?? null;
  await commit(bundle, { closet, look });
  await maybeRedraw(bundle, opts);
  return { hair: closet.hair };
}

// ---- §5.8 remove, §5.9 copy out, §5.11 update ---------------------------------------------------------------

/**
 * Remove an item from the closet (§5.8). A spare: any app. A worn item (or the hair worn) is taken off
 * first only with opts.takeOff (and an app that can fit); otherwise it is refused. It leaves every
 * outfit; the animation sets it brought go, then the clips it brought that no remaining set uses.
 * → { removed: id, outfits: [ids of the outfits it left] }
 */
export async function removeItem(bundle, id, opts = {}) {
  const closet = closetOf(bundle);
  const e = need(closet, id);
  const worn = closet.worn.items.includes(id) || closet.hair === id;
  if (worn) {
    if (!opts.takeOff) fail('worn', `"${e.name}" is worn: take it off first (§5.8 step 1)`);
    fits(opts, 'Taking a worn item off before removing it');
    closet.worn.items = closet.worn.items.filter((w) => w !== id);
    delete closet.worn.states[id];
    if (closet.hair === id) closet.hair = null;
  }
  const left = [];
  for (const o of closet.outfits) {
    if (!(o.items || []).includes(id)) continue;
    o.items = o.items.filter((x) => x !== id);
    if (o.states) delete o.states[id];
    left.push(o.id);
  }
  const del = [e.file];
  if (e.thumbnail) del.push(e.thumbnail);
  if (e.fitting?.fitted?.file) del.push(e.fitting.fitted.file);
  closet.items = closet.items.filter((x) => x.id !== id);
  const animations = dropAnimations(bundle.docs.animations, id, del);
  await commit(bundle, { closet, animations: bundle.docs.animations ? animations : undefined, del: del.filter((p) => bundle.entries.has(p)), look: worn });
  if (worn) await maybeRedraw(bundle, opts);
  return { removed: id, outfits: left };
}

/** Copy an item out (§5.9): its file exactly as it arrived. Its fine-tuning stays with the character. → bytes */
export function copyOut(bundle, id) {
  const e = need(closetOf(bundle), id);
  const bytes = bundle.entries.get(e.file);
  if (!bytes) fail('missing', `${e.file} is not in the bundle`);
  return bytes;
}

/**
 * Update an item in place (§5.11; PRD CLO-9): a newer revision of the same item (same id, higher
 * revision, this base). Its fine-tuning is kept; a stored fitted shape goes out of date. A worn item
 * needs an app that can fit, and is fitted again. A state the new revision lacks falls back to the
 * default, worn and in outfits. → { id, revision, worn, outfitsChanged: [outfit names] }
 */
export async function updateItem(bundle, input, opts = {}) {
  const { item, bytes } = await incoming(input, opts);
  checkBase(bundle, item);
  const closet = closetOf(bundle);
  const m = item.manifest;
  const e = entryOf(closet, m.id) || fail('not-in-closet', `"${m.name}" (${m.id}) is not in the closet: a new item is added (§5.1)`);
  const old = await itemOf(bundle, m.id);
  if (!(m.revision > (old.manifest.revision ?? 0))) fail('revision', `"${m.name}" revision ${m.revision} is not newer than the one in the closet (${old.manifest.revision})`);
  const worn = closet.worn.items.includes(m.id) || closet.hair === m.id;
  if (worn) fits(opts, 'Updating a worn item');
  if ((m.slot === 'hair') !== (e.slot === 'hair')) fail('slot', `"${m.name}" changed between a hair piece and a closet item; add it as a new item instead`);
  const file = closetItemPath(m.slot, m.id);
  const del = [], set = [[file, bytes]];
  if (file !== e.file) del.push(e.file);
  let thumbnail = null;
  if (item.entries.has('thumbnail.png')) { thumbnail = `closet/thumbs/${m.id}.png`; set.push([thumbnail, item.entries.get('thumbnail.png')]); }
  else if (e.thumbnail) del.push(e.thumbnail);
  const entry = await closetEntryFor(item, { file, thumbnail, source: opts.source ?? e.source ?? null });
  if (e.fitting) entry.fitting = clone(e.fitting); // kept; a stored fitted shape now names another model (C8)
  closet.items[closet.items.indexOf(e)] = entry;
  // a state the new revision no longer has goes back to the default, where it is worn and in every outfit
  // that records it (CLOSET.md §5.11, decided 2026-11-16), so C5 holds; the outfits changed are reported
  const names = stateNames(entry);
  if (closet.worn.states[m.id] && !names.includes(closet.worn.states[m.id])) delete closet.worn.states[m.id];
  const outfitsChanged = [];
  for (const o of closet.outfits || []) {
    if (o.states?.[m.id] && !names.includes(o.states[m.id])) { delete o.states[m.id]; outfitsChanged.push(o.name); }
  }
  if (worn && m.slot !== 'hair') recordMethod(closet, m.id, m.fit);
  let animations = dropAnimations(bundle.docs.animations, m.id, del);
  animations = await bringAnimations(animations, item, set, opts);
  await commit(bundle, { closet, animations: animations ?? undefined, set, del: del.filter((p) => bundle.entries.has(p) && !set.some(([s]) => s === p)), look: worn });
  itemCache.set(bytes, item);
  if (worn) await maybeRedraw(bundle, opts);
  return { id: m.id, revision: m.revision, worn, outfitsChanged };
}

// ---- snapshots, for an app's undo -------------------------------------------------------------------------

const closetPath = (p) => /^(closet\/|appearance\/hair\/|animations\/)/.test(p);

/**
 * Everything the closet operations touch, as it stands: the closet and animations documents and the
 * entries under closet/, appearance/hair/ and animations/ (shared bytes, not copies). For undo.
 */
export function closetSnapshot(bundle) {
  const files = new Map([...bundle.entries].filter(([p]) => closetPath(p) && !Object.values(documentPaths(bundle.manifest)).some((d) => d.path === p)));
  return { closet: bundle.docs.closet ? clone(bundle.docs.closet) : null, animations: bundle.docs.animations ? clone(bundle.docs.animations) : null, files };
}

/** Put the closet back as a snapshot had it. */
export function restoreCloset(bundle, snap) {
  const docs = new Set(Object.values(documentPaths(bundle.manifest)).map((d) => d.path));
  for (const p of [...bundle.entries.keys()]) if (closetPath(p) && !docs.has(p) && !snap.files.has(p)) bundle.entries.delete(p);
  for (const [p, b] of snap.files) bundle.entries.set(p, b);
  setDocument(bundle, 'closet', snap.closet);
  setDocument(bundle, 'animations', snap.animations);
  return bundle;
}

// ---- redrawing avatar.vrm in the same step ------------------------------------------------------------------

async function maybeRedraw(bundle, opts) {
  if (!opts.redraw) return;
  const { redrawAvatar } = await import('./avatar.js');
  await redrawAvatar(bundle, opts.redraw);
}
