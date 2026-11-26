// Animation sets (VRMXA §8.2, §8.3): which set is active for what is worn, and which clips each slot then
// plays. Pure functions on the animations document; the bundle operations are in motion.js.

import { ANIMATION_SLOTS, TAG_RE, VENDOR_NAME_RE } from '../vocab.js';

export const emptyAnimations = () => ({ format: 'vrmxa-animations', version: 1, clips: [], sets: [] });

/** Is this a slot name a set may use (the starting vocabulary, or x-<vendor>.<name>)? */
export const isSlot = (s) => ANIMATION_SLOTS.includes(s) || VENDOR_NAME_RE.test(s);
export const isTag = (t) => typeof t === 'string' && TAG_RE.test(t);

/** Is a set active for the equipped state (every tag it requires is worn)? */
export const setActive = (set, tags) => (set.requires || []).every((t) => tags.has(t));

/**
 * The sets active for these tags, highest priority first; at equal priority the character's own set wins
 * over one an item brought (§8.3), then document order. The default set is always last.
 */
export function activeSets(doc, tags) {
  const T = tags instanceof Set ? tags : new Set(tags || []);
  const sets = (doc?.sets || []).map((s, i) => ({ s, i })).filter(({ s }) => !s.default && setActive(s, T));
  sets.sort((a, b) => (b.s.priority ?? 0) - (a.s.priority ?? 0) || (a.s.from ? 1 : 0) - (b.s.from ? 1 : 0) || a.i - b.i);
  const def = (doc?.sets || []).find((s) => s.default);
  return [...sets.map(({ s }) => s), ...(def ? [def] : [])];
}

/**
 * For each slot, the clips the player takes and the set they come from (§8.3: the active set with the
 * highest priority that fills the slot, else the default). → { slot: { set: { id, name, from }, clips: [entry] } }
 */
export function resolveSlots(doc, tags) {
  const out = {};
  for (const s of activeSets(doc, tags)) {
    for (const [slot, list] of Object.entries(s.slots || {})) {
      if (out[slot] || !list?.length) continue;
      out[slot] = { set: { id: s.id, name: s.name, from: s.from ?? null, default: !!s.default }, clips: list.map((e) => ({ weight: 1, rate: 1, blendIn: 0.25, ...e })) };
    }
  }
  return out;
}

/** Pick one clip of a slot by weight (§8.4 weight: chance among the slot's clips). r: 0..1. */
export function pickClip(entries, r = Math.random()) {
  const total = entries.reduce((a, e) => a + (e.weight ?? 1), 0);
  let x = r * total;
  for (const e of entries) { x -= e.weight ?? 1; if (x <= 0) return e; }
  return entries[entries.length - 1] || null;
}

/** Which sets use a clip (by sha256): [{ set, slot }]. */
export function clipUses(doc, sha) {
  const out = [];
  for (const s of doc?.sets || []) for (const [slot, list] of Object.entries(s.slots || {})) if ((list || []).some((e) => e.clip === sha)) out.push({ set: s.id, name: s.name, slot });
  return out;
}

/** Replace a clip by another in every set (a correction made again). */
export function swapClip(doc, from, to) {
  for (const s of doc.sets || []) for (const list of Object.values(s.slots || {})) for (const e of list || []) if (e.clip === from) e.clip = to;
}
