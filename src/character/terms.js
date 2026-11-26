// A licence block in VRM 1.0's terms (VRMC_vrm meta.md), read the way this app shows and honours it
// (PRD LIC-5, HON). A character's details, an item's `meta` (VRMXW §11) and a voice's `meta` (VRMXA §9.3) all use
// the same field names and values; what differs is the default when a field is absent:
//   - a character (VRMXA §5.3) and an item (VRMXW §11): VRM's defaults: non-commercial, credit required, not passed
//     on, no changes, the four usage flags off
//   - a voice (§9.3): the same, and `avatarPermission` onlyAuthor
// A clip's licence is free text (VRMXA §8.4): it is shown, never judged (SPEC-QUESTIONS #71).

import { META_ENUMS } from '../vocab.js';

/** VRM's most restricted values: what a field absent from a block means, and where a new character or voice starts. */
export const RESTRICTED = Object.freeze({
  avatarPermission: 'onlyAuthor',
  commercialUsage: 'personalNonProfit',
  creditNotation: 'required',
  allowRedistribution: false,
  modification: 'prohibited',
  allowExcessivelyViolentUsage: false,
  allowExcessivelySexualUsage: false,
  allowPoliticalOrReligiousUsage: false,
  allowAntisocialOrHateUsage: false,
});

export const PERMISSION_KEYS = Object.freeze(Object.keys(RESTRICTED));
export const USAGE_FLAGS = Object.freeze(['allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage', 'allowPoliticalOrReligiousUsage', 'allowAntisocialOrHateUsage']);

/** Each permission's values from the strictest to the loosest. */
export const ORDER = Object.freeze({
  avatarPermission: ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'],
  commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'],
  creditNotation: ['required', 'unnecessary'],
  modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'],
  allowRedistribution: [false, true],
  allowExcessivelyViolentUsage: [false, true],
  allowExcessivelySexualUsage: [false, true],
  allowPoliticalOrReligiousUsage: [false, true],
  allowAntisocialOrHateUsage: [false, true],
});
for (const k of Object.keys(META_ENUMS)) if (!ORDER[k]) throw new Error(`terms.js: no order for ${k}`);

/** How loose a value is: 0 for the strictest. An unknown value counts as the strictest. */
export const rank = (key, value) => Math.max(0, ORDER[key]?.indexOf(value ?? RESTRICTED[key]) ?? 0);

/** The stricter of two values of one permission. */
export const stricter = (key, a, b) => (rank(key, a) <= rank(key, b) ? (a ?? RESTRICTED[key]) : (b ?? RESTRICTED[key]));

/** A block's permissions with every absent field at VRM's default (most restricted). kind 'item' has no avatarPermission. */
export function effective(meta, { kind = 'item' } = {}) {
  const m = meta || {};
  const out = {};
  for (const k of PERMISSION_KEYS) {
    if (k === 'avatarPermission' && kind === 'item') continue;
    out[k] = m[k] ?? RESTRICTED[k];
  }
  return out;
}

const WORDS = {
  avatarPermission: { onlyAuthor: 'Only its maker may use it', onlySeparatelyLicensedPerson: 'Only people its maker licenses', everyone: 'Anyone may use it' },
  commercialUsage: { personalNonProfit: 'Personal, non-commercial use only', personalProfit: 'Commercial use by a person', corporation: 'Commercial use, by companies too' },
  creditNotation: { required: 'Credit the maker', unnecessary: 'No credit needed' },
  modification: { prohibited: 'No changes', allowModification: 'May be changed, not passed on changed', allowModificationRedistribution: 'May be changed and passed on changed' },
  allowRedistribution: { true: 'May be passed on', false: 'May not be passed on' },
  allowExcessivelyViolentUsage: { true: 'Violent content allowed', false: 'No violent content' },
  allowExcessivelySexualUsage: { true: 'Sexual content allowed', false: 'No sexual content' },
  allowPoliticalOrReligiousUsage: { true: 'Political or religious use allowed', false: 'No political or religious use' },
  allowAntisocialOrHateUsage: { true: 'Antisocial or hateful use allowed', false: 'No antisocial or hateful use' },
};

/** The plain words for one permission's value. */
export const wordsFor = (key, value) => WORDS[key]?.[String(value ?? RESTRICTED[key])] ?? `${key}: ${value}`;

// whether a value counts as allowing (shown with a tick) or restricting
const okOf = (key, v) => (key === 'creditNotation' ? v === 'unnecessary' : key === 'modification' ? v !== 'prohibited' : rank(key, v) > 0);

/**
 * A licence block as a list of terms in plain words (LIC-5), each { key, value, ok, text, stated } (stated: false when
 * the field was absent and VRM's default applies). The four usage flags are left out unless `flags`.
 */
export function termsOf(meta, { kind = 'item', flags = false } = {}) {
  const m = meta || {};
  const e = effective(m, { kind });
  return Object.entries(e)
    .filter(([k]) => flags || !USAGE_FLAGS.includes(k))
    .map(([key, value]) => ({ key, value, ok: okOf(key, value), text: wordsFor(key, value), stated: m[key] !== undefined }));
}

/**
 * Whose a piece is and what its maker allows, in one line each (LIC-5): { whose, allows, passOn, change, commercial,
 * credit, licenseUrl }. `whose` is the authors joined; `allows` is a short summary for a list row.
 */
export function licenceLine(meta, { kind = 'item' } = {}) {
  if (typeof meta === 'string' || meta == null) {
    // a clip's licence: free text, shown as it is (VRMXA §8.4)
    return { whose: null, allows: meta ? String(meta) : 'No licence stated', text: meta ?? null, passOn: null, change: null, commercial: null, credit: null, licenseUrl: null };
  }
  const e = effective(meta, { kind });
  const passOn = e.allowRedistribution === true;
  const change = e.modification;
  const commercial = e.commercialUsage;
  const credit = e.creditNotation === 'required';
  const bits = [
    passOn ? 'may be passed on' : 'not to be passed on',
    change === 'prohibited' ? 'no changes' : change === 'allowModification' ? 'changes kept private' : 'changes allowed',
    commercial === 'personalNonProfit' ? 'non-commercial' : commercial === 'personalProfit' ? 'commercial by a person' : 'commercial',
  ];
  if (credit) bits.push('credit the maker');
  const whose = Array.isArray(meta.authors) && meta.authors.length ? meta.authors.join(', ') : null;
  return { whose, allows: bits.join(' · ').replace(/^./, (c) => c.toUpperCase()), passOn, change, commercial, credit, licenseUrl: meta.licenseUrl ?? null };
}

/**
 * Spec's own permissions, as every published Spec states them (`assets/spec/spec.vrm`): everything but antisocial use
 * allowed. A character whose permissions are exactly these and were never chosen took them over from Spec, which LIC-3
 * doesn't allow: it is treated as allowing nothing until the person chooses.
 */
export const SPEC_PERMISSIONS = Object.freeze({
  avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true,
  modification: 'allowModificationRedistribution', allowExcessivelyViolentUsage: true, allowExcessivelySexualUsage: true,
  allowPoliticalOrReligiousUsage: true, allowAntisocialOrHateUsage: false,
});

/** A licence block's permissions only (every key, absent ones at VRM's defaults). */
export const permissionsOf = (meta) => Object.fromEntries(PERMISSION_KEYS.map((k) => [k, meta?.[k] ?? RESTRICTED[k]]));

/**
 * The permissions of `meta` (a character's) that are looser than a merged piece allows (VRMXA §5.3): pieces are
 * `extras.vrmxaPieces` entries ({ name, meta }); items have no avatarPermission. → [{ key, value, loosest, by: [names] }]
 */
export function looserThanPieces(meta, pieces) {
  const out = [];
  for (const key of PERMISSION_KEYS) {
    if (key === 'avatarPermission') continue;
    const v = meta?.[key] ?? RESTRICTED[key];
    let loosest = ORDER[key][ORDER[key].length - 1];
    for (const p of pieces || []) loosest = rank(key, p.meta?.[key]) < rank(key, loosest) ? (p.meta?.[key] ?? RESTRICTED[key]) : loosest;
    if (rank(key, v) <= rank(key, loosest)) continue;
    const by = (pieces || []).filter((p) => rank(key, p.meta?.[key]) === rank(key, loosest)).map((p) => p.name || p.id);
    out.push({ key, value: v, loosest, by });
  }
  return out;
}

/** One line per looser permission, naming the piece and the term. */
export const looserLines = (looser) => looser.map((l) => `${wordsFor(l.key, l.value)} is looser than ${l.by.map((n) => `"${n}"`).join(' and ')} ${l.by.length === 1 ? 'allows' : 'allow'} (${wordsFor(l.key, l.loosest)}) (VRMXA §5.3)`);
