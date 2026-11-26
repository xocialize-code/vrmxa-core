// Bringing a garment made for another body onto Spec (FITTING.md §7; VRMXW §14, §11 `origin.fit`;
// PRD IMP-9): measure the donor's body, give the garment its fit coordinates against it, and move it
// to the same place around Spec. DOM-free.
//
// The importer first moves the garment onto Spec by its bones (import/onSpec.js moveOntoSpec): every
// humanoid bone to Spec's, Spec's inverse bind matrices, the shoe lift taken out. That model keeps its
// bones, weights and own spring chains; Spec-fit then gives its vertices their places around Spec's
// body, so it no longer keeps the donor's girth. Where Spec-fit can't run (the donor's body can't be
// measured, or isn't in a T-pose: §9), the bones' result stands and says so (`origin.fit: "bones"`).

import { parseGlb, buildGlb } from '../glb.js';
import { writeVec3 } from '../closet/fit.js';
import { readSkin, measuredContext } from './body.js';
import { itemGeometry } from './worn.js';
import { fitCoordinates, moveGarment, fitRule, girthRatios, skinThrough, easeKept, hemsKept, makeSurface } from './specFit.js';
import { fitVerdict, estimatedShare, FAILS } from './verdict.js';

/**
 * The donor body's fitting context, from its VRM 1.0 (a 0.x model is converted first). Stations the
 * measurer refuses (skin cut away under clothes) are estimated from Spec's (§5.2). bodyMats: the
 * body-skin materials for a model not named the VRoid way; base: Spec's { json, bin }, to find them by their
 * shape instead (donorParts.js). → context, or { refused: reason }
 */
export function donorContext(json, bin, spec, { bodyMats, base } = {}) {
  let body;
  try { body = readSkin(json, bin, { bodyMats, base }); } catch (e) { return { refused: e.message || String(e) }; }
  if (!body.tris.length) return { refused: 'no body skin found in the source to measure' };
  const ctx = measuredContext(body, { ref: spec });
  if (!ctx) return { refused: 'the source body could not be measured (a humanoid bone or the skin is missing)' };
  return ctx;
}

/**
 * A garment onto Spec by Spec-fit. cut: the garment as cut from the donor (its model.glb bytes, in the
 * donor's bind space); moved: the same model moved onto Spec by its bones (same accessors); rig: the
 * item's rig.humanBones; donor, spec: contexts; fit: the item's fit rule (VRMXW §7).
 * → { glb (bytes), method: 'spec-fit' | 'bones', reason?, stats?, ratios?, estimated? }
 */
export function garmentOntoSpec(cut, moved, rig, donor, spec, fit = {}) {
  if (!donor || donor.refused) { const reason = donor?.refused || 'no donor body'; return { glb: moved, method: 'bones', reason, verdict: fitVerdict({ refused: reason }) }; }
  const c = parseGlb(cut);
  const g = itemGeometry(c.json, c.bin, null, { rig, all: true });
  if (!g) return { glb: moved, method: 'bones', reason: 'no skinned meshes' };
  const m = parseGlb(moved);
  const mg = itemGeometry(m.json, m.bin, null, { rig, all: true });
  const rule = fitRule(fit);
  const coords = fitCoordinates(donor, g, rule);
  // the bones' move (on Spec) is what weight on no fitted segment follows, and what is blended in where
  // the skin runs across the axis (SPEC-QUESTIONS #50, #54)
  const r = moveGarment(coords, donor, spec, g, { bones: mg.pos, foreign: true });
  const json = JSON.parse(JSON.stringify(m.json));
  let bin = m.bin.slice();
  for (const p of mg.parts) {
    bin = writeVec3(json, bin, p.acc, r.pos.slice(p.offset * 3, (p.offset + p.n) * 3));
    if (r.normals && p.normalAcc != null) bin = writeVec3(json, bin, p.normalAcc, r.normals.slice(p.offset * 3, (p.offset + p.n) * 3));
  }
  if (r.targets) g.targetAccs.forEach((ta, k) => { bin = writeVec3(json, bin, ta.acc, r.targets[k].slice(ta.part.offset * 3, (ta.part.offset + ta.part.n) * 3)); });
  if (json.buffers?.[0]) json.buffers[0].byteLength = bin.length;
  const { ratios } = girthRatios(donor, spec);
  // the verdict (verdict.js): skin through cloth on Spec, the bodies' ratios, the pushes, ease kept, estimated stations
  const th = skinThrough(spec, [makeSurface(r.pos, g.tris, { cell: 0.02 })]);
  const verdict = fitVerdict({
    through: th.share, throughCount: th.through, covered: th.covered, girthRatios: ratios, pushedShare: r.stats.groups ? r.stats.pushed / r.stats.groups : 0,
    easeRms: easeKept(coords, donor, spec, r.pos, r.pushed).rms, estimatedShare: estimatedShare(coords), estimated: donor.estimated,
    hemsMm: Math.round(hemsKept(coords, spec, g, r.pos).maxM * 1e5) / 100, ms: Math.round(r.stats.ms * 10) / 10,
  });
  return { glb: buildGlb(json, bin), method: 'spec-fit', stats: r.stats, ratios, estimated: donor.estimated, coords, fitted: r.pos, tris: g.tris, source: g.pos, verdict };
}
