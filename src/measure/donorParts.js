// Match a Donor Face: which parts of a donor avatar are its face. DOM-free.
//
// A VRoid-made avatar names its parts the same way every time (N00_000_00_Face_00_SKIN, EyeIris,
// Body_00_SKIN), so its face is found by name. Avatars made elsewhere (MMD conversions, Blender, other
// editors) use their own names — "Head - Face", "Skin_Body", "Iris" — so the face can't be found that way.
// Here every material of the donor gets a role, guessed from its name and then shown to the person
// to correct:
//   face  — the face and head skin (scanned for the head's shape)
//   body  — other skin; only its part around the head is used (the back of the head, the neck)
//   eyes  — the irises / pupils (their centres place the head: eye distance, eye height)
//   ignore — hair, clothes, eyelashes, brows, mouth inside, accessories …
// With the roles set, the head is scanned exactly as Spec's is (face.js faceLandmarks with these parts).
//
// Names are a hint. Given Spec (opts.base), a model whose names aren't VRoid's has its roles decided by
// the parts' shape against Spec's body, face and eyes (skinCheck.js), with the name as a small prior in
// the score; without Spec the names alone guess, as before.

import { readAccessor } from '../glb.js';
import { findSkinParts } from './skinCheck.js';

export const DONOR_ROLES = [
  { id: 'face', label: 'Face skin' },
  { id: 'body', label: 'Other skin' },
  { id: 'eyes', label: 'Eyes (iris)' },
  { id: 'ignore', label: 'Ignore' },
];

// The material names VRoid writes into the VRM files it exports, as read from those files:
//   {base F00 | M00 | N00}_{3-digit item}[_{2-digit variant}]_{Part}_{2-digit index}_{KIND}[_{n}]
// (sometimes followed by " (Instance)", "(Clone)" or ".n"). The part and kind say what it is.
//
// Checked against the material names of 35,144 exported VRM files (35,132 VRM 0.x, 12 VRM 1.0;
// 549,653 names, 2026-11-26). The first pattern here (variant required, nothing after the kind)
// matched 419,738 names and found a face skin in 34,633 files and a body skin in 34,644. It missed
// three forms, all VRoid's own (the first two overlap: hair has both):
//   • no variant number (older exports, and every hair material): 71,055 names, among them the face
//     skin of 474 files and the body skin of 468 that it therefore didn't recognise;
//   • a number after the kind ("…_CLOTH_01", "…_HAIR_01"): 71,011 names, none of them skin;
//   • a part with an underscore ("Accessory_Tie"): 5,727 names, none of them skin.
// This pattern takes all three: 533,465 names match, a face skin is found in 35,107 files and a body
// skin in 35,112 (both in 35,091). Of the 16,188 names it doesn't match, none has VRoid's
// {base}_{item}_ start apart from one name whose kind is not in capitals; the rest are accessories
// without the base prefix (cat ears, glasses, tails) and names from other tools ("Material.001"),
// which the name guesses and the geometry check below handle. Every SKIN name it matches has the
// part Face or Body, and no name of another kind was read as skin, so it takes nothing wrongly.
// Two files name their iris FaceEyeIR; those are not read as eyes.
export const VROID_MATERIAL = /(?:^|[^A-Za-z0-9])([FMN]00)_(\d{3})_(?:(\d{2})_)?([A-Za-z]+(?:_[A-Za-z]+)*)_(\d{2})_([A-Z]+)(?:_\d+)?(?![A-Za-z0-9])/;

/** A material name read VRoid's way -> { base, item, variant, part, index, kind, role } or null. */
export function vroidMaterial(name = '') {
  const m = VROID_MATERIAL.exec(name);
  if (!m) return null;
  const [, base, item, variant, part, index, kind] = m;
  const role = kind === 'SKIN' && part === 'Face' ? 'face'
    : kind === 'SKIN' && part === 'Body' ? 'body'
      : kind === 'EYE' && part === 'EyeIris' ? 'eyes'
        : 'ignore';
  return { base, item, variant: variant ?? null, part, index, kind, role };
}

// name guesses (estimated); checked in order
const IGNORE = /hair|bang|braid|ponytail|twintail|ahoge|cloth|clo\b|clo[\s_-]|dress|skirt|shirt|shoe|sock|acc[\s_-]|acc$|hat|ribbon|rod|misc|lash|brow|eyeline|mayu|matsuge|hilight|highlight|sclera|white|tooth|teeth|tongue|\bmo\b|mouth|kuchi|tear|shadow|cheek|blush|glass|frill/i;
const EYES = /iris|pupil|hitomi|eye(?!lash|brow|line|white)/i;
const FACE = /face|head|kao|顔|atama|頭/i;
const BODY = /skin|body|hada|肌|karada/i;

/** The role a material's name suggests. */
export function guessRole(name = '') {
  const v = vroidMaterial(name);
  if (v) return v.role; // a VRoid name says exactly what the part is
  if (IGNORE.test(name)) return 'ignore';
  if (EYES.test(name)) return 'eyes';
  if (FACE.test(name)) return 'face';
  if (BODY.test(name)) return 'body';
  return 'ignore';
}

/**
 * Every material the donor's meshes use, with its guessed role and how many vertices and triangles it
 * has. -> { vroid (named the VRoid way), parts: [{ material, name, role, triangles }], method }
 * opts.base: Spec ({ json, bin }). When given and the names aren't VRoid's, the roles come from the
 * geometry check (skinCheck.js findSkinParts; each part then also carries `score` and `evidence`) and
 * method is 'geometry'; otherwise 'names'. opts.names: false leaves the name prior out of that check.
 */
export function guessDonorParts(json, bin, opts = {}) {
  const tris = new Map();
  for (const mesh of json.meshes || [])
    for (const p of mesh.primitives || []) {
      if (p.material == null) continue;
      const n = p.indices != null ? readAccessor(json, bin, p.indices).length / 3 : (json.accessors[p.attributes.POSITION]?.count || 0) / 3;
      tris.set(p.material, (tris.get(p.material) || 0) + n);
    }
  const parts = [...tris.keys()].sort((a, b) => a - b).map((material) => {
    const name = json.materials?.[material]?.name || `Material ${material}`;
    return { material, name, role: guessRole(name), triangles: Math.round(tris.get(material)) };
  });
  const vroid = parts.some((p) => vroidMaterial(p.name)?.role === 'face');
  if (!vroid && opts.base) {
    const geo = new Map(findSkinParts(json, bin, opts.base, { names: opts.names }).parts.map((p) => [p.material, p]));
    for (const p of parts) {
      const g = geo.get(p.material);
      if (!g) { p.role = 'ignore'; continue; }
      p.role = g.role; p.score = g.score; p.evidence = g.evidence;
    }
    return { vroid, parts, method: 'geometry' };
  }
  return { vroid, parts, method: 'names' };
}

/** The roles as sets of material indices, for faceLandmarks. */
export function partSets(parts) {
  const of = (role) => new Set(parts.filter((p) => p.role === role).map((p) => p.material));
  return { skinMats: of('face'), bodyMats: of('body'), irisMats: of('eyes') };
}

/** What's missing before a face can be measured ('' when the roles are enough). */
export function partsProblem(parts) {
  if (!parts.some((p) => p.role === 'face')) return 'Mark at least one part as the face skin.';
  return '';
}
