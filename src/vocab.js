// The fixed vocabularies the formats use: VRM 1.0's humanoid bones and metadata values, the item
// types and slots (VRMXW §6, VRMXA §7.2), and the published bases (VRMXA §5.1).

import BASES_JSON from './data/bases.js';

/** VRM 1.0 humanoid bone names (VRMC_vrm-1.0 humanoid.md), 55 of them. */
export const HUMAN_BONES = Object.freeze([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ...['left', 'right'].flatMap((s) => [
    `${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`,
    `${s}IndexProximal`, `${s}IndexIntermediate`, `${s}IndexDistal`,
    `${s}MiddleProximal`, `${s}MiddleIntermediate`, `${s}MiddleDistal`,
    `${s}RingProximal`, `${s}RingIntermediate`, `${s}RingDistal`,
    `${s}LittleProximal`, `${s}LittleIntermediate`, `${s}LittleDistal`,
  ]),
]);
export const HUMAN_BONE_SET = new Set(HUMAN_BONES);

/** VRM 1.0 meta values (VRMC_vrm-1.0 meta.md). */
export const META_ENUMS = Object.freeze({
  avatarPermission: ['onlyAuthor', 'onlySeparatelyLicensedPerson', 'everyone'],
  commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'],
  creditNotation: ['required', 'unnecessary'],
  modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'],
});
export const META_BOOLEANS = Object.freeze(['allowRedistribution', 'allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage',
  'allowPoliticalOrReligiousUsage', 'allowAntisocialOrHateUsage']);
export const META_STRINGS = Object.freeze(['version', 'copyrightInformation', 'contactInformation', 'licenseUrl', 'otherLicenseUrl', 'thirdPartyLicenses']);

/** Slots (VRMXA §7.2). */
export const SLOTS = Object.freeze(['tops', 'bottoms', 'onepiece', 'outer', 'socks', 'shoes', 'gloves', 'accessory', 'hair']);

/**
 * Item types and what each sets (VRMXW §6): slot, kind, the bone a pinned type follows, and the
 * default fit rule (§7).
 */
export const ITEM_TYPES = Object.freeze({
  top: { slot: 'tops', kind: 'worn', fit: { method: 'spec-fit', class: 'top', ease: 'fitted', hemAnchor: 'body' } },
  pants: { slot: 'bottoms', kind: 'worn', fit: { method: 'spec-fit', class: 'bottom', ease: 'fitted', hemAnchor: 'body' } },
  skirt: { slot: 'bottoms', kind: 'worn', fit: { method: 'spec-fit', class: 'skirt', ease: 'relaxed', hemAnchor: 'body' } },
  dress: { slot: 'onepiece', kind: 'worn', fit: { method: 'spec-fit', class: 'dress', ease: 'relaxed', hemAnchor: 'body' } },
  coat: { slot: 'outer', kind: 'worn', fit: { method: 'spec-fit', class: 'top', ease: 'relaxed', hemAnchor: 'absolute' } },
  socks: { slot: 'socks', kind: 'worn', fit: { method: 'bones' } },
  shoes: { slot: 'shoes', kind: 'worn', fit: { method: 'bones', lift: 0 } },
  gloves: { slot: 'gloves', kind: 'worn', fit: { method: 'bones' } },
  hair: { slot: 'hair', kind: 'worn', fit: { method: 'head' } },
  hat: { slot: 'accessory', kind: 'pin', bone: 'head', fit: { method: 'pin' } },
  glasses: { slot: 'accessory', kind: 'pin', bone: 'head', fit: { method: 'pin' } },
  earrings: { slot: 'accessory', kind: 'pin', bone: 'head', fit: { method: 'pin' } },
  necklace: { slot: 'accessory', kind: 'pin', bone: 'upperChest', fit: { method: 'pin' } },
  back: { slot: 'accessory', kind: 'pin', bone: 'upperChest', fit: { method: 'pin' } },
  belt: { slot: 'accessory', kind: 'pin', bone: 'hips', fit: { method: 'pin' } },
  tail: { slot: 'accessory', kind: 'pin', bone: 'hips', fit: { method: 'pin' } },
  charm: { slot: 'accessory', kind: 'pin', bone: 'hips', fit: { method: 'pin' } },
  handR: { slot: 'accessory', kind: 'pin', bone: 'rightHand', fit: { method: 'pin' } },
  handL: { slot: 'accessory', kind: 'pin', bone: 'leftHand', fit: { method: 'pin' } },
  // an accessory that bends with the body (cat ears with their springs, a ribbon over several bones): skinned, by
  // its bones (SPEC-QUESTIONS #38, decided 2026-11-17)
  bodyAccessory: { slot: 'accessory', kind: 'worn', fit: { method: 'bones' } },
});

/**
 * What a type sets, for one of §6's types or a vendor's `x-<vendor>.<name>` type (W15). A vendor
 * type names its slot and takes that slot's defaults: those of the slot's first type in §6, with
 * the kind it gives. Returns null for anything else.
 */
export function resolveItemType(type, slot, kind) {
  if (Object.hasOwn(ITEM_TYPES, type)) return ITEM_TYPES[type];
  if (typeof type !== 'string' || !/^x-[a-z0-9-]+\.[A-Za-z0-9._-]+$/.test(type)) return null;
  const like = Object.values(ITEM_TYPES).find((t) => t.slot === slot && (!kind || t.kind === kind))
    || Object.values(ITEM_TYPES).find((t) => t.slot === slot);
  if (!like) return null;
  return { ...like, kind: kind || like.kind, vendor: true };
}

export const FIT_METHODS = Object.freeze(['spec-fit', 'bones', 'head', 'pin']);
export const TAG_RE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;
export const SPECIES_RE = /^(human|x-[a-z0-9-]+\.[a-z0-9-]+)$/;

/** Animation slots of VRMXA §8.2, the starting vocabulary. */
export const ANIMATION_SLOTS = Object.freeze(['idle', 'walk', 'run', 'jump', 'fall', 'land', 'sit', 'sitIdle', 'stand',
  'talk', 'listen', 'think', 'greet', 'nod', 'shake', 'shrug', 'point', 'laugh', 'bow', 'clap',
  'emote.happy', 'emote.angry', 'emote.sad', 'emote.relaxed', 'emote.surprised', 'equip', 'unequip', 'use']);
export const VENDOR_NAME_RE = /^x-[a-z0-9-]+\.[A-Za-z0-9._-]+$/;

/** The published bases, from the specification's bases.json. */
export const BASES = Object.freeze(BASES_JSON.bases.map((b) => Object.freeze({ ...b })));

/**
 * Look a base up by SHA-256 → the bases.json entry (status 'standard' or 'retired') or null.
 * `bases` may be given to check against another list.
 */
export function findBase(sha, bases = BASES) {
  return bases.find((b) => b.sha256 === sha) || null;
}

/** The current standard base for a species. */
export function standardBase(species = 'human', bases = BASES) {
  return bases.find((b) => (b.species || 'human') === species && b.status === 'standard') || null;
}
