// Measure a VRM's body (FITTING.md §4) from its bytes: the `vrm-body-measurements` document that
// VRMXA keeps as appearance/measurements.json (VRMXA §6), with a source record.
//
// VRoid-named avatars are measured by their material names; others by the skin parts found by their
// shape against Spec when Spec is given (`base`), else guessed from their names.

import { asBytes } from '../bytes.js';
import { parseGlb } from '../glb.js';
import { sha256 } from '../hash.js';
import { measureBody } from './bodyMeasure.js';
import { guessDonorParts, partSets } from './donorParts.js';

/**
 * Measure a VRM. Returns the measurements document with `source: { file, sha256, vroidNamed }`,
 * or null when the model has no body skin or humanoid to measure.
 * `of` (optional) is added as VRMXA §6 asks for a bundle's cache: { base, edits }.
 * `base` (optional): Spec, as { json, bin } or its bytes, to find a model's skin by its shape when its names
 * aren't VRoid's (donorParts.js guessDonorParts).
 */
export async function measureVrm(bytes, { file = 'model.vrm', of, base } = {}) {
  const u8 = asBytes(bytes);
  const { json, bin } = parseGlb(u8);
  const spec = base && !base.json ? parseGlb(asBytes(base)) : base;
  const { vroid, parts } = guessDonorParts(json, bin, spec ? { base: spec } : {});
  const sets = vroid ? null : partSets(parts);
  const m = measureBody(json, bin, sets ? { bodyMats: new Set([...sets.bodyMats, ...sets.skinMats]) } : {});
  if (!m) return null;
  if (of) m.of = of;
  m.source = { file, sha256: await sha256(u8), vroidNamed: vroid };
  return m;
}
