// Spec-fit (PRD phase 5; FITTING.md §5–§8; VRMXW §7; CLOSET.md §4 items 3, 4, 7): fitting tops,
// bottoms, one-pieces and coats to any body. DOM-free: browsers and Node.
//
//   body.js     a body's fitting context: skin, measurements, stacks of cross-sections; estimated stations
//   specFit.js  the method: fit coordinates, the move, clean-up, morph targets, the §8 checks
//   worn.js     on a character: the merged model, the shaped skeleton, back into Spec's bind space
//   donor.js    a garment from another body onto Spec (§7), for the importer

import { readAccessor, parseGlb } from '../glb.js';
import { fitPositions, adjustEdited, writeVec3 } from '../closet/fit.js';
import { fitWorn, specContext } from './worn.js';

export {
  readSkin, bodyContext, measuredContext, zoneOfBone, ZONES, SUB, sOf, hAt, radiusAt, girthAt, centreAt, estimatedAt, anchorS,
} from './body.js';
export {
  C_MIN, SEARCH, SMOOTH_PASSES, RATIO_WARN, SLOPE, GROWN, fitRule, fitCoordinates, zoneMove, moveGarment, girthRatios,
  skinCover, skinThrough, easeKept, hemsKept, easeOf, makeSurface,
} from './specFit.js';
export { SPEC_FIT_SLOTS, specFits, shapedSkinning, shapeBody, specContext, itemGeometry, fitWorn, skinThroughWorn, skinCoverWorn, RELAXED_POSE, posedSkinning, skinPositions } from './worn.js';
export { NEAR as WEIGHTS_NEAR, FAR as WEIGHTS_FAR, bodyWeights, weightsDiffer } from './weights.js';
export { vertexNormals, nearest, rayHit, weldGroups } from './geom.js';
export { garmentOntoSpec, donorContext } from './donor.js';
export { VERDICT, FITS, WARNS, FAILS, fitVerdict, estimatedShare } from './verdict.js';

const specCache = new WeakMap();
/** Spec's context for spec.vrm's bytes, made once per bytes object (the app and the CLI keep one). */
export function specContextFor(specBytes) {
  let c = specCache.get(specBytes);
  if (!c) { c = specContext(parseGlb(specBytes)); specCache.set(specBytes, c); }
  return c;
}

/**
 * Write a fitWorn result into a merged model (json changed, bin returned), then each Spec-fitted
 * item's hand adjustments on top (VRMXA §7.5: applied after the automatic fit), the same way the
 * live view does. adjusts: { itemId: adjust }.
 */
export function applyFitResult(json, bin, result, adjusts = {}) {
  for (const [acc, e] of result.accessors) {
    bin = writeVec3(json, bin, acc, e.pos);
    if (e.normals && e.normalAcc != null) bin = writeVec3(json, bin, e.normalAcc, e.normals);
    for (const [ta, d] of e.targets) bin = writeVec3(json, bin, ta, d);
  }
  // the items' own spring chains, by the girth ratio at each root (FITTING.md §5.6)
  const springs = json.extensions?.VRMC_springBone?.springs || [];
  for (const it of result.items) for (const { spring, ratio } of it.springs || []) {
    if (Math.abs(ratio - 1) < 1e-4) continue;
    for (const j of springs[spring]?.joints || []) for (const k of ['stiffness', 'gravityPower', 'hitRadius']) if (Number.isFinite(j[k])) j[k] = Math.round(j[k] * ratio * 1e6) / 1e6;
  }
  bin = writeBodyWeights(json, bin, result);
  const fitted = new Set([...result.accessors.values()].map((e) => e.item));
  const done = new Set();
  (json.nodes || []).forEach((node) => {
    const f = node.extras?.vrmxaFit;
    if (node.mesh == null || !f || !fitted.has(f.item)) return;
    const adjust = adjusts[f.item];
    if (!adjust || !adjustEdited(adjust)) return;
    for (const p of json.meshes[node.mesh].primitives || []) {
      const ai = p.attributes?.POSITION;
      if (ai == null || done.has(ai)) continue;
      done.add(ai);
      const pos = readAccessor(json, bin, ai);
      const nrm = p.attributes.NORMAL != null ? readAccessor(json, bin, p.attributes.NORMAL) : null;
      bin = writeVec3(json, bin, ai, fitPositions(pos, nrm, adjust, f.centre, f.basis || null));
    }
  });
  return bin;
}

// put typed values in a fresh stretch of the buffer and point accessor `ai` at it (its old bytes are left unused)
function rewriteAccessor(json, bin, ai, typed, componentType, type, target) {
  const pad = (4 - (bin.length % 4)) % 4;
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const out = new Uint8Array(bin.length + pad + bytes.length);
  out.set(bin, 0);
  out.set(bytes, bin.length + pad);
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad, byteLength: bytes.length, ...(target ? { target } : {}) });
  if (json.buffers?.[0]) json.buffers[0].byteLength = out.length;
  const a = json.accessors[ai];
  a.bufferView = json.bufferViews.length - 1;
  delete a.byteOffset; delete a.sparse; delete a.normalized; delete a.min; delete a.max;
  a.componentType = componentType; a.type = type;
  a.count = typed.length / (type === 'MAT4' ? 16 : 4);
  return out;
}

/**
 * The body's weights under each Spec-fitted garment (FITTING.md §5.6, #60), written into the merged model:
 * the garment's skin gains the body joints it now uses (with their bind matrices, the ones the fit's
 * skinning used), and its JOINTS_0 / WEIGHTS_0 hold the new weights. Other meshes on the same skin are
 * unaffected (a skin's joint list only grows).
 */
export function writeBodyWeights(json, bin, result) {
  const sk = result.skinning;
  if (!sk) return bin;
  const written = new Set();
  (json.nodes || []).forEach((node) => {
    if (node.mesh == null || node.skin == null || !node.extras?.vrmxaFit) return;
    const prims = (json.meshes[node.mesh].primitives || []).filter((p) => result.accessors.get(p.attributes?.POSITION)?.skin && p.attributes.JOINTS_0 != null && p.attributes.WEIGHTS_0 != null);
    if (!prims.length) return;
    const skin = json.skins[node.skin];
    const slot = new Map(skin.joints.map((n, j) => [n, j]));
    const added = [];
    for (const p of prims) {
      const e = result.accessors.get(p.attributes.POSITION).skin;
      for (let i = 0; i < e.nodes.length; i++) if (e.weights[i] > 0 && !slot.has(e.nodes[i])) { slot.set(e.nodes[i], skin.joints.length + added.length); added.push(e.nodes[i]); }
    }
    if (added.length) {
      const old = skin.inverseBindMatrices != null ? readAccessor(json, bin, skin.inverseBindMatrices) : null;
      const ibm = new Float32Array((skin.joints.length + added.length) * 16);
      skin.joints.forEach((n, j) => ibm.set(old ? old.subarray(j * 16, j * 16 + 16) : (sk.ibm.get(n) || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), j * 16));
      added.forEach((n, k) => {
        const m = sk.ibm.get(n);
        if (!m) throw new Error(`no bind matrix for node ${n}`);
        ibm.set(m, (skin.joints.length + k) * 16);
      });
      skin.joints = [...skin.joints, ...added];
      if (skin.inverseBindMatrices != null) bin = rewriteAccessor(json, bin, skin.inverseBindMatrices, ibm, 5126, 'MAT4', null);
      else { json.accessors.push({}); skin.inverseBindMatrices = json.accessors.length - 1; bin = rewriteAccessor(json, bin, skin.inverseBindMatrices, ibm, 5126, 'MAT4', null); }
    }
    for (const p of prims) {
      const key = `${p.attributes.JOINTS_0}:${p.attributes.WEIGHTS_0}`;
      if (written.has(key)) continue;
      written.add(key);
      const e = result.accessors.get(p.attributes.POSITION).skin;
      const jn = new Uint16Array(e.nodes.length);
      for (let i = 0; i < e.nodes.length; i++) jn[i] = e.weights[i] > 0 ? slot.get(e.nodes[i]) : 0;
      bin = rewriteAccessor(json, bin, p.attributes.JOINTS_0, jn, 5123, 'VEC4', 34962);
      bin = rewriteAccessor(json, bin, p.attributes.WEIGHTS_0, Float32Array.from(e.weights), 5126, 'VEC4', 34962);
    }
    for (const p of prims) { delete p.attributes.JOINTS_1; delete p.attributes.WEIGHTS_1; } // the four weights are the whole of it
  });
  return bin;
}

/**
 * Fit and write in one step, for the bake: → { bin, result }. items: [{ id, manifest, fitting }];
 * edits: { body, bones, lift }; opts: { spec (context), cache, adjusts, weights (false: keep the items' own) }.
 */
export function fitMerged(json, bin, items, edits, { spec, cache, adjusts = {}, weights = true } = {}) {
  const result = fitWorn(json, bin, items, edits, { spec, cache, weights });
  if (!result.accessors.size) return { bin, result };
  return { bin: applyFitResult(json, bin, result, adjusts), result };
}
