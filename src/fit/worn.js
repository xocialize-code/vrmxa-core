// Spec-fit on a character (FITTING.md §5.2–§5.7; CLOSET.md §4 items 3, 4, 7; PRD FIT-2, FIT-4,
// FIT-7): the worn items that ask for `spec-fit`, merged into Spec (closet/avatar.js mergeWorn), are
// given new positions in Spec's bind space such that the body's own skinning — the bake's
// (bakeBody) or the live view's (three.js) — puts each vertex where Spec-fit wants it on the edited
// body. So one result serves both: written into the merged model before the bake, it lands in
// avatar.vrm in the character's bind space; set on the live view's geometry, it shows the same.
//
// For a vertex v (Spec bind space) with weights wⱼ, the shaped skinning gives p = M v + t, where
// M, t blend the joints' shaped transforms Kⱼ = shaped worldⱼ · skin scaleⱼ · inverse bindⱼ (EDITS.md
// §4). Spec-fit gives the target position p'. So v' = M⁻¹ (p' − t); normals and morph deltas go back
// through M the same way. The weights are the body's under the garment (weights.js, FITTING.md §5.6,
// SPEC-QUESTIONS #60): M and t are blended with those, and they are written with the positions, so the
// cloth follows the body in any pose. The item's own model is never changed.
//
// The target body is the merged model's own body skin under the same shaped skeleton, measured with
// the measurer (FITTING.md §4) — the same body measureEdits measures, without writing a file.

import { readAccessor } from '../glb.js';
import { parents } from '../math.js';
import { bodyRig, bodyShape, composeWorld, groundLift, soleSamples, bodyEdited, mul, scaleM, invert as invert4 } from '../edit/body.js';
import { humanBones } from '../measure/bodyMeasure.js';
import { readSkin, measuredContext, zoneOfBone, ZONE_INDEX, sOf, girthAt } from './body.js';
import { worldMatrix } from '../math.js';
import { fitCoordinates, moveGarment, fitRule, makeSurface, skinThrough, skinCover, easeKept, hemsKept, easeOf } from './specFit.js';
import { fitVerdict, estimatedShare } from './verdict.js';
import { bodyWeights } from './weights.js';

import { SPEC_FIT_SLOTS, methodFor as closetMethod } from '../closet/fit.js';

export { SPEC_FIT_SLOTS };
// when two worn items share a layer number, the slot says which is beneath (SPEC-QUESTIONS #53)
const SLOT_RANK = { socks: 0, gloves: 0, bottoms: 1, onepiece: 1, shoes: 1, tops: 2, outer: 3, accessory: 4, hair: 5 };

/**
 * Does Spec-fit fit this item here? Its manifest asks for `spec-fit`, its slot is one Spec-fit covers,
 * and the character hasn't switched the automatic fit off (VRMXA §7.5 `auto`).
 */
export function specFits(manifest, fitting = null) {
  return closetMethod(manifest, fitting) === 'spec-fit';
}

// ---- the shaped skinning ---------------------------------------------------------------------------

/**
 * The skeleton of a merged model shaped by the body edits, and each joint's skinning transform.
 * → { identity, K (node → 4×4 column-major), world, lift, ibm (node → 4×4) }
 */
export function shapedSkinning(json, bin, { body = {}, bones = {}, lift = 0 } = {}) {
  const rig = bodyRig(json);
  const sh = bodyShape(rig, { body, bones });
  const extra = Number.isFinite(lift) && lift > 0 ? lift : 0;
  const identity = !bodyEdited(body) && !extra;
  const up = identity ? 0 : groundLift(json, bin, rig, sh, soleSamples(json, bin)) + extra;
  const world = composeWorld(rig, sh, up);
  const ibm = new Map();
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices == null) continue;
    const m = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((node, j) => { if (!ibm.has(node)) ibm.set(node, Array.from(m.slice(j * 16, j * 16 + 16))); });
  }
  const K = new Map();
  const Kof = (node) => {
    let k = K.get(node);
    if (!k) { k = mul(mul(world[node], scaleM(sh.skin[node])), ibm.get(node) || invert4(world[node])); K.set(node, k); }
    return k;
  };
  return { identity, Kof, world, lift: up, ibm, rig, sh };
}

// blend the joints' transforms for one vertex → { M (3×3 column-major), t }
function blendK(Kof, nodes, weights, o) {
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0], t = [0, 0, 0];
  let ws = 0;
  for (let k = 0; k < 4; k++) {
    const w = weights[o + k];
    if (!(w > 1e-6)) continue;
    const K = Kof(nodes[o + k]);
    M[0] += w * K[0]; M[1] += w * K[1]; M[2] += w * K[2];
    M[3] += w * K[4]; M[4] += w * K[5]; M[5] += w * K[6];
    M[6] += w * K[8]; M[7] += w * K[9]; M[8] += w * K[10];
    t[0] += w * K[12]; t[1] += w * K[13]; t[2] += w * K[14];
    ws += w;
  }
  if (ws < 1e-6) return { M: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  for (let i = 0; i < 9; i++) M[i] /= ws;
  for (let i = 0; i < 3; i++) t[i] /= ws;
  return { M, t };
}
const apply3 = (M, v) => [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];
function inv3(M) {
  const [a, b, c, d, e, f, g, h, i] = M; // columns: (a b c), (d e f), (g h i)
  const A = e * i - f * h, B = -(b * i - c * h), C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const D = -(d * i - g * f), E = a * i - g * c, F = -(a * f - d * c);
  const G = d * h - g * e, H = -(a * h - g * b), I = a * e - d * b;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
}
const transpose3 = (M) => [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]];

/** A body skin read by readSkin, moved by the shaped skinning. → a body object for the measurer. */
export function shapeBody(base, sk) {
  if (sk.identity) return base;
  const n = base.verts.length / 3;
  const verts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { M, t } = blendK(sk.Kof, base.skin.node, base.skin.weight, i * 4);
    const v = apply3(M, [base.verts[i * 3], base.verts[i * 3 + 1], base.verts[i * 3 + 2]]);
    verts[i * 3] = v[0] + t[0]; verts[i * 3 + 1] = v[1] + t[1]; verts[i * 3 + 2] = v[2] + t[2];
  }
  const joints = {};
  const hb = sk.humanBones;
  for (const [bone, node] of Object.entries(hb || {})) if (sk.world[node] && base.joints[bone]) joints[bone] = [sk.world[node][12], sk.world[node][13], sk.world[node][14]];
  return { ...base, verts, joints };
}

// ---- a pose on the shaped skeleton, for checking cloth in a pose -----------------------------------------

/** The stage's relaxed arms (app/src/stage/engine.js RELAXED): the normalized upper arms turned about world z. */
export const RELAXED_POSE = Object.freeze({ leftUpperArm: -1.12, rightUpperArm: 1.12 });

/**
 * The shaped skinning with a pose: each named humanoid bone turned about world z by its angle (radians),
 * about its own shaped joint, carrying everything under it — what a normalized bone's rotation.z does at
 * rest. → Kof (node → 4×4) for blendK-style skinning.
 */
export function posedSkinning(json, sk, pose = RELAXED_POSE) {
  const hb = sk.humanBones || humanBones(json);
  const par = parents(json.nodes || []);
  const turns = [];
  for (const [bone, z] of Object.entries(pose)) {
    const node = hb[bone];
    if (node == null || !sk.world[node] || !z) continue;
    const w = sk.world[node];
    const j = [w[12], w[13], w[14]], c = Math.cos(z), s = Math.sin(z);
    // T(j) · Rz · T(−j), column-major
    const R = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, j[0] - c * j[0] + s * j[1], j[1] - s * j[0] - c * j[1], 0, 1];
    turns.push({ node, R });
  }
  const under = new Map();
  const turnOf = (node) => {
    if (under.has(node)) return under.get(node);
    let R = null;
    for (let n = node; n != null && !R; n = par.get(n)) { const t = turns.find((x) => x.node === n); if (t) R = t.R; }
    under.set(node, R);
    return R;
  };
  const K = new Map();
  return (node) => {
    let k = K.get(node);
    if (!k) { const R = turnOf(node); k = R ? mul(R, sk.Kof(node)) : sk.Kof(node); K.set(node, k); }
    return k;
  };
}

/** Positions skinned by Kof with per-vertex nodes and weights (4 each). → Float32Array */
export function skinPositions(Kof, pos, nodes, weights) {
  const n = pos.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { M, t } = blendK(Kof, nodes, weights, i * 4);
    const v = apply3(M, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    out[i * 3] = v[0] + t[0]; out[i * 3 + 1] = v[1] + t[1]; out[i * 3 + 2] = v[2] + t[2];
  }
  return out;
}

// ---- Spec's context, made once ---------------------------------------------------------------------

/** Spec's fitting context (its skin, measurements and stacks), from spec.vrm's parsed GLB. Cache it. */
export function specContext({ json, bin }) {
  const body = readSkin(json, bin);
  const ctx = measuredContext(body);
  if (!ctx) throw new Error('Spec could not be measured');
  return ctx;
}

// ---- the items in a merged model --------------------------------------------------------------------

/**
 * The geometry of one worn item in a merged model (mesh nodes marked extras.vrmxaFit.item): every
 * vertex list it uses once, concatenated, with zones, triangles, normals and morph targets. With
 * `all`, every skinned mesh of the model (an item's own model.glb), its humanoid bones from `rig`
 * (rig.humanBones: bone → node).
 */
export function itemGeometry(json, bin, id, { rig = null, all = false } = {}) {
  const hb = rig || humanBones(json);
  const boneOfNode = new Map(Object.entries(hb).map(([b, n]) => [n, b]));
  const par = parents(json.nodes || []);
  const humanOf = (node) => { for (let n = node; n != null; n = par.get(n)) if (boneOfNode.has(n)) return boneOfNode.get(n); return null; };
  const parts = [];
  const byAcc = new Map();
  (json.nodes || []).forEach((node, ni) => {
    if (node.mesh == null || node.skin == null || (!all && node.extras?.vrmxaFit?.item !== id)) return;
    const skin = json.skins[node.skin];
    for (const prim of json.meshes[node.mesh].primitives || []) {
      const a = prim.attributes || {};
      if (a.POSITION == null || a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
      let part = byAcc.get(a.POSITION);
      if (!part) {
        const pos = readAccessor(json, bin, a.POSITION);
        const jn = readAccessor(json, bin, a.JOINTS_0), wt = readAccessor(json, bin, a.WEIGHTS_0);
        const wa = json.accessors[a.WEIGHTS_0];
        const norm = wa.normalized ? (wa.componentType === 5121 ? 255 : 65535) : 1;
        const n = pos.length / 3;
        const nodes = new Int32Array(n * 4), weights = new Float32Array(n * 4);
        for (let i = 0; i < n * 4; i++) { nodes[i] = skin.joints[jn[i]] ?? 0; weights[i] = wt[i] / norm; }
        part = { acc: a.POSITION, normalAcc: a.NORMAL ?? null, n, pos: Float32Array.from(pos), nodes, weights, tris: [], targets: (prim.targets || []).map((t) => t.POSITION).filter((x) => x != null), node: ni };
        byAcc.set(a.POSITION, part);
        parts.push(part);
      }
      if (prim.indices != null) part.tris.push(...readAccessor(json, bin, prim.indices));
      else for (let i = 0; i < part.n; i++) part.tris.push(i);
    }
  });
  if (!parts.length) return null;
  let total = 0;
  for (const p of parts) { p.offset = total; total += p.n; }
  const pos = new Float32Array(total * 3), zones = new Float32Array(total * 6), nodes = new Int32Array(total * 4), weights = new Float32Array(total * 4);
  const tris = [];
  let normals = new Float32Array(total * 3);
  let hasNormals = true;
  const zoneCache = new Map();
  const zoneOfNode = (node) => { let z = zoneCache.get(node); if (z === undefined) { const b = humanOf(node); z = ZONE_INDEX[b ? zoneOfBone(b) : 'other']; zoneCache.set(node, z); } return z; };
  // morph targets: one list across the item (an item's parts rarely share them; each keeps its own accessor)
  const targetAccs = [];
  for (const p of parts) {
    pos.set(p.pos, p.offset * 3);
    nodes.set(p.nodes, p.offset * 4);
    weights.set(p.weights, p.offset * 4);
    for (let i = 0; i < p.n; i++) for (let k = 0; k < 4; k++) {
      const w = p.weights[i * 4 + k];
      if (w > 1e-6) zones[(p.offset + i) * 6 + zoneOfNode(p.nodes[i * 4 + k])] += w;
    }
    for (const t of p.tris) tris.push(t + p.offset);
    if (p.normalAcc != null) normals.set(readAccessor(json, bin, p.normalAcc), p.offset * 3); else hasNormals = false;
    for (const ta of p.targets) if (!targetAccs.some((x) => x.acc === ta)) targetAccs.push({ acc: ta, part: p });
  }
  const targets = targetAccs.map(({ acc, part }) => {
    const d = new Float32Array(total * 3);
    d.set(readAccessor(json, bin, acc), part.offset * 3);
    return d;
  });
  return { parts, pos, zones, nodes, weights, tris: Int32Array.from(tris), normals: hasNormals ? normals : null, targets, targetAccs, n: total };
}

// FNV-1a over a float array's bits: the cache key of a garment's positions
function hashFloats(a) {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = 2166136261;
  for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

/**
 * Fit the worn items that use Spec-fit, on a merged model, for these body edits.
 *
 * json, bin: the merged model (mergeWorn), in Spec's bind space. items: [{ id, manifest, fitting }] in
 * the order worn (inner layers first). edits: { body, bones (face.bones), lift }. opts: { spec (Spec's
 * context, specContext), cache (a Map kept between calls, for fit coordinates), checks (true: run
 * FITTING.md §8's checks on the result), verdict (true: each item's fit verdict, verdict.js), shape
 * ((itemId, segment, s, θ) → { radius, ease } multipliers: the seam for reshaping controls), weights (true,
 * the default: the body's weights under each garment, weights.js; false keeps the item's own, for comparison) }.
 *
 * → { identity, accessors: Map(POSITION accessor → { pos, normals?, normalAcc, targets: Map(acc → delta),
 *     skin?: { nodes, weights } (per vertex, 4 each: merged-model nodes; the body's weights) })
 *     (all in Spec's bind space, ready for the bake or the live view), items: [{ id, method, rule,
 *     stats, refused?, checks?, springs: [{ spring, node, name, ratio }] }], target (the body's context), ms }
 */
export function fitWorn(json, bin, items, edits = {}, { spec, cache = new Map(), checks = false, verdict = false, shape = null, weights = true } = {}) {
  const t0 = now();
  if (!spec) spec = specContext({ json, bin });
  const sk = shapedSkinning(json, bin, edits);
  sk.humanBones = humanBones(json);
  const out = { identity: sk.identity, accessors: new Map(), items: [], target: null, ms: 0, lift: sk.lift };
  Object.defineProperty(out, 'skinning', { value: sk, enumerable: false }); // for the posed check (checks.js)
  const asked = items.filter((it) => specFits(it.manifest, it.fitting));
  for (const it of items) if (!asked.includes(it)) out.items.push({ id: it.id, method: methodFor(it) });
  if (!asked.length) { out.ms = now() - t0; return out; }
  // the target body, measured (§5.2)
  let target = spec;
  if (!sk.identity) {
    const base = spec.body.skin ? spec.body : readSkin(json, bin);
    const body = shapeBody(base, sk);
    target = measuredContext(body, { ref: spec });
    if (!target) throw new Error('the edited body could not be measured');
  }
  out.target = target;
  out.msMeasure = now() - t0;
  const order = asked.map((it, k) => ({ it, k, rank: [Number.isFinite(it.manifest.layer) ? it.manifest.layer : 0, SLOT_RANK[it.manifest.slot] ?? 2, k] }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const done = []; // fitted inner garments: { rank, src surface, tgt surface }
  for (const { it, rank } of order) {
    const rec = { id: it.id, method: 'spec-fit' };
    out.items.push(rec);
    const g = itemGeometry(json, bin, it.id);
    if (!g) { rec.method = 'bones'; rec.refused = 'no skinned meshes to fit'; continue; }
    if (target.refused) { rec.method = 'bones'; rec.refused = target.refused; continue; }
    const rule = fitRule(it.manifest.fit, it.fitting?.rule || null);
    rec.rule = rule;
    const key = `${it.id}:${hashFloats(g.pos)}:${rule.class}:${spec.m?.source?.sha256 || ''}`;
    let coords = cache.get(key);
    if (!coords) { coords = fitCoordinates(spec, g, rule); cache.set(key, coords); }
    // the bones-fitted positions (weight on no fitted zone follows them) and each vertex's blend
    const n = g.n;
    const bones = new Float32Array(n * 3);
    const blends = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = blendK(sk.Kof, g.nodes, g.weights, i * 4);
      blends[i] = b;
      const v = apply3(b.M, [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]);
      bones[i * 3] = v[0] + b.t[0]; bones[i * 3 + 1] = v[1] + b.t[1]; bones[i * 3 + 2] = v[2] + b.t[2];
    }
    const inner = done.filter((d) => d.rank[0] < rank[0] || (d.rank[0] === rank[0] && d.rank[1] < rank[1])).map((d) => ({ src: d.src, tgt: d.tgt }));
    // the garment's normals and morph deltas in target space before the move (the bones' rotation),
    // so the move's normal change is measured where the cloth is
    const tgtGarment = { pos: g.pos, zones: g.zones, tris: g.tris, normals: g.normals, targets: g.targets };
    // the skin this garment covers on Spec, vertex for vertex the edited body's (for clearance by triangle, #57)
    if (!coords.covered) coords.covered = skinCover(spec, [makeSurface(g.pos, g.tris, { cell: 0.02 })]);
    const sameSkin = target.skin.verts.length === spec.skin.verts.length;
    const r = moveGarment(coords, spec, target, tgtGarment, { bones, inner, identity: sk.identity, covered: sameSkin ? coords.covered : null, shape: shape ? (seg, s, th) => shape(it.id, seg, s, th) : null });
    rec.stats = r.stats;
    if (checks && !sk.identity) {
      const surf = makeSurface(r.pos, g.tris, { cell: 0.02 });
      rec.checks = {
        ease: easeKept(coords, spec, target, r.pos, r.pushed),
        hems: hemsKept(coords, target, g, r.pos),
      };
      rec.surface = surf;
      rec.bones = bones;
    }
    done.push({ rank, src: makeSurface(g.pos, g.tris, { cell: 0.02 }), tgt: makeSurface(r.pos, g.tris, { cell: 0.02 }) });
    // the body's weights under the garment where it now lies (FITTING.md §5.6, #60): the edited body is Spec's skin
    // moved, so Spec's skin weights read on it; a foreign body (not Spec's mesh) is read where the garment sat on Spec
    const bw = !weights ? null : sameSkin ? bodyWeights(target.skin, spec.body.skin, r.pos, g) : (coords.bodyW ||= bodyWeights(spec.skin, spec.body.skin, g.pos, g));
    if (bw) rec.weights = { taken: bw.taken, blended: bw.blended, kept: bw.kept, ms: Math.round(bw.ms * 10) / 10 };
    const skinBlends = bw ? Array.from({ length: n }, (_, i) => blendK(sk.Kof, bw.nodes, bw.weights, i * 4)) : blends;
    // back into Spec's bind space through each vertex's blended skinning (v' = M⁻¹ (p' − t))
    const pre = new Float32Array(n * 3);
    const preN = r.normals ? new Float32Array(n * 3) : null;
    const preT = r.targets ? r.targets.map(() => new Float32Array(n * 3)) : null;
    for (let i = 0; i < n; i++) {
      const { M, t } = skinBlends[i];
      const Mi = inv3(M);
      const v = apply3(Mi, [r.pos[i * 3] - t[0], r.pos[i * 3 + 1] - t[1], r.pos[i * 3 + 2] - t[2]]);
      pre[i * 3] = v[0]; pre[i * 3 + 1] = v[1]; pre[i * 3 + 2] = v[2];
      if (preN) {
        // the bake turns normals by M's inverse transpose; going back is Mᵀ
        const q = apply3(transpose3(M), [r.normals[i * 3], r.normals[i * 3 + 1], r.normals[i * 3 + 2]]);
        const l = Math.hypot(q[0], q[1], q[2]) || 1;
        preN[i * 3] = q[0] / l; preN[i * 3 + 1] = q[1] / l; preN[i * 3 + 2] = q[2] / l;
      }
      if (preT) r.targets.forEach((d, k) => {
        if (!d[i * 3] && !d[i * 3 + 1] && !d[i * 3 + 2]) return;
        const q = apply3(Mi, [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]]);
        preT[k][i * 3] = q[0]; preT[k][i * 3 + 1] = q[1]; preT[k][i * 3 + 2] = q[2];
      });
    }
    if (sk.identity) { pre.set(g.pos); if (preN && g.normals) preN.set(g.normals); }
    if (checks) {
      // for the posed check (checks.js posedWorn): the same fit under the item's own weights
      const own = new Float32Array(n * 3);
      if (sk.identity) own.set(g.pos);
      else for (let i = 0; i < n; i++) {
        const { M, t } = blends[i];
        const v = apply3(inv3(M), [r.pos[i * 3] - t[0], r.pos[i * 3 + 1] - t[1], r.pos[i * 3 + 2] - t[2]]);
        own[i * 3] = v[0]; own[i * 3 + 1] = v[1]; own[i * 3 + 2] = v[2];
      }
      rec.bind = { pre, own, tris: g.tris, ownSkin: { nodes: g.nodes, weights: g.weights }, bodySkin: bw };
    }
    for (const p of g.parts) {
      const entry = { item: it.id, pos: pre.slice(p.offset * 3, (p.offset + p.n) * 3), normalAcc: p.normalAcc, normals: preN ? preN.slice(p.offset * 3, (p.offset + p.n) * 3) : null, targets: new Map() };
      if (bw) entry.skin = { nodes: bw.nodes.slice(p.offset * 4, (p.offset + p.n) * 4), weights: bw.weights.slice(p.offset * 4, (p.offset + p.n) * 4) };
      g.targetAccs.forEach((ta, k) => { if (ta.part === p && preT) entry.targets.set(ta.acc, preT[k].slice(p.offset * 3, (p.offset + p.n) * 3)); });
      out.accessors.set(p.acc, entry);
    }
    rec.fitted = { pos: r.pos, tris: g.tris };
    // the ease on Spec (the heat map, FITTING.md §10 step 2), by the merged model's vertex lists
    const ease = coords.ease ||= easeOf(coords);
    rec.ease = new Map(g.parts.map((p) => [p.acc, ease.subarray(p.offset, p.offset + p.n)]));
    if (!sk.identity) rec.springs = springRatios(json, g, spec, target);
    if (verdict) {
      // the verdict on this body (verdict.js): skin through what it covered on Spec, the pushes, ease kept, ratios
      const th = sk.identity ? { share: 0 } : skinThrough(target, [makeSurface(r.pos, g.tris, { cell: 0.02 })], { covered: sameSkin ? coords.covered : null });
      const hem = sk.identity ? { max: 0, maxM: 0 } : hemsKept(coords, target, g, r.pos);
      rec.verdict = fitVerdict({
        through: th.share, girthRatios: r.stats.ratios || {}, pushedShare: r.stats.groups ? r.stats.pushed / r.stats.groups : 0,
        easeRms: sk.identity ? 0 : easeKept(coords, spec, target, r.pos, r.pushed).rms, estimatedShare: estimatedShare(coords), estimated: target.estimated,
        hemsDs: hem.max, hemsMm: Math.round(hem.maxM * 1e5) / 100, ms: Math.round(r.stats.ms * 10) / 10,
      });
    }
  }
  out.ms = now() - t0;
  return out;
}

const methodFor = (it) => closetMethod(it.manifest, it.fitting);

const SEG_OF = ['torso', 'armL', 'armR', 'legL', 'legR'];
/**
 * The item's own spring chains (VRMC_springBone springs whose first joint is one of its skins' own bones)
 * and the girth ratio at each root's station, target over Spec (FITTING.md §5.6): their stiffness, gravity
 * and hit radius are scaled by it. → [{ spring (index), node (root), name, ratio }]
 */
function springRatios(json, g, spec, target) {
  const springs = json.extensions?.VRMC_springBone?.springs || [];
  const hb = humanBones(json);
  const human = new Set(Object.values(hb));
  const boneOfNode = new Map(Object.entries(hb).map(([b, n]) => [n, b]));
  const par = parents(json.nodes || []);
  const own = new Set();
  for (let i = 0; i < g.nodes.length; i++) if (g.weights[i] > 1e-6 && !human.has(g.nodes[i])) own.add(g.nodes[i]);
  // a chain's bones may carry no weight themselves (its root above the weighted ones): take their descendants' too
  const out = [];
  springs.forEach((sp, k) => {
    const root = sp.joints?.[0]?.node;
    if (root == null || human.has(root)) return;
    const chain = (sp.joints || []).map((j) => j.node);
    if (!chain.some((n) => own.has(n))) return;
    let bone = null;
    for (let n = par.get(root); n != null; n = par.get(n)) if (boneOfNode.has(n)) { bone = boneOfNode.get(n); break; }
    const z = bone ? ZONE_INDEX[zoneOfBone(bone)] : null;
    if (z == null || z > 4) return;
    const a = spec.segments[SEG_OF[z]], b = target.segments[SEG_OF[z]];
    if (!a || !b) return;
    const w = worldMatrix(json.nodes, root, par);
    const p = [w[12], w[13], w[14]];
    const h = a.axis.kind === 'y' ? p[1] : a.axis.tOf(p);
    const s = sOf(a, h);
    const ga = girthAt(a, s), gb = girthAt(b, s);
    if (!(ga > 0 && gb > 0)) return;
    out.push({ spring: k, node: root, name: json.nodes[root].name || null, ratio: Math.round((gb / ga) * 1e4) / 1e4 });
  });
  return out;
}

/**
 * Skin through cloth on the fitted body, for every worn Spec-fitted item together (§8). On a body made
 * from Spec (result.target's skin is Spec's, vertex for vertex) the covered skin is what the same items
 * cover on Spec; pass `specCovered` (skinCoverWorn on the unedited result) to reuse it.
 */
export function skinThroughWorn(result, { covered = null, ...opts } = {}) {
  const garments = result.items.filter((r) => r.fitted).map((r) => makeSurface(r.fitted.pos, r.fitted.tris, { cell: 0.02 }));
  if (!garments.length || !result.target) return null;
  return skinThrough(result.target, garments, { covered, ...opts });
}

/** The skin the worn Spec-fitted items cover (on result.target's body). → Uint8Array */
export function skinCoverWorn(result, opts) {
  const garments = result.items.filter((r) => r.fitted).map((r) => makeSurface(r.fitted.pos, r.fitted.tris, { cell: 0.02 }));
  return garments.length && result.target ? skinCover(result.target, garments, opts) : null;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
