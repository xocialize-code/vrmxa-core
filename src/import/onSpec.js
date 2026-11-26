// Bringing an item cut from another body onto Spec (PRD IMP-9, ITM-3, ITM-11; VRMXW §5.3 rule 4, §7.1,
// §14; FITTING.md §7).
//
// FITTING.md §7 moves a garment onto Spec through its fit coordinates (Spec-fit, steps 2 to 4), which are
// not built yet (phase 5). Until then a garment is moved **by its bones**, the fallback CLOSET.md §4 allows
// and the item records (`origin.fit: "bones"`):
//
//   every humanoid bone of the item is put where Spec has it, and every vertex follows its bones there,
//   by its own weights: v' = Σ wⱼ · Specⱼ · Donorⱼ⁻¹ · v (linear blend skinning from the donor's rest pose
//   to Spec's). The item's own bones (spring chains) ride with their humanoid ancestor. The humanoid
//   joints then take Spec's own inverse bind matrices, which is what "fitted to Spec" means (§5.3 rule 4),
//   so wearing the item on Spec changes nothing (§13, "No change on Spec").
//
// The donor's shoe lift (VRMXW §7.1) goes with it: VRoid raises every bone of a figure in shoes by the
// sole's height, so moving each bone to Spec's takes the lift out of every item, shoes included. The
// lift is measured (`measureLift`) and recorded on the shoes as `fit.lift`.
//
// What bones cannot do: a donor's girth. A donor wider than Spec gives a garment that sits wider than Spec,
// since each bone moves and none is scaled. VRoid figures are close to Spec (the travel is reported), and
// the importer's place (move, turn, size) and the closet's fine-tuning cover small cases.

import { parseGlb, buildGlb, readAccessor } from '../glb.js';
import { invert, localMatrix, multiply, parents, worldMatrix, transformPoint, IDENTITY } from '../math.js';
import { decompose } from '../closet/fit.js';
import { humanoidOf } from '../item-writer.js';

const EPS = 1e-7;

/** Spec's skeleton, for moving items onto it: bone → rest (bind) matrix, and its own inverse bind matrices. */
export function specRig(spec) {
  const { json, bin } = spec instanceof Uint8Array ? parseGlb(spec) : spec;
  const human = humanoidOf(json);
  if (!human) throw new Error('Spec has no VRMC_vrm humanoid');
  const pOf = parents(json.nodes);
  const bind = new Map();
  const ibm = new Map();
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices === undefined) continue;
    const m = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((node, j) => {
      const bone = human.boneOfNode.get(node);
      if (!bone || ibm.has(bone)) return;
      const inv = Array.from(m.subarray(j * 16, j * 16 + 16));
      ibm.set(bone, inv);
      bind.set(bone, invert(inv));
    });
  }
  for (const [bone, node] of Object.entries(human.nodeOfBone)) {
    if (bind.has(bone)) continue;
    const w = worldMatrix(json.nodes, node, pOf);
    bind.set(bone, w);
    ibm.set(bone, invert(w));
  }
  const at = (bone) => { const m = bind.get(bone); return m ? [m[12], m[13], m[14]] : null; };
  return { json, bin, human, bind, ibm, at };
}

/** A donor's rest skeleton: bone → world matrix and position. */
export function donorRig(json) {
  const human = humanoidOf(json);
  if (!human) throw new Error('the source has no VRMC_vrm humanoid');
  const pOf = parents(json.nodes);
  const world = new Map(Object.entries(human.nodeOfBone).map(([b, n]) => [b, worldMatrix(json.nodes, n, pOf)]));
  const at = (bone) => { const m = world.get(bone); return m ? [m[12], m[13], m[14]] : null; };
  return { human, world, at };
}

/**
 * How far a donor's figure is raised by its shoes (VRMXW §7.1), in metres. The ankle's height above the
 * sole scales with the leg, so the donor's foot and toe bones are compared with Spec's scaled by the
 * ratio of the legs (hips to foot): the rest is the lift. For Elena this gives 31.3 mm, the measured
 * amount. → { lift, legRatio, bySide: { left, right } }, lift rounded to 0.1 mm and never below 0.
 */
export function measureLift(donor, spec) {
  const per = [];
  for (const side of ['left', 'right']) {
    const dHip = donor.at(`${side}UpperLeg`), dFoot = donor.at(`${side}Foot`), dToe = donor.at(`${side}Toes`);
    const sHip = spec.at(`${side}UpperLeg`), sFoot = spec.at(`${side}Foot`), sToe = spec.at(`${side}Toes`);
    if (!dHip || !dFoot || !sHip || !sFoot) continue;
    const ratio = (dHip[1] - dFoot[1]) / (sHip[1] - sFoot[1]);
    if (!(ratio > 0.3 && ratio < 3)) continue;
    const vals = [dFoot[1] - sFoot[1] * ratio];
    if (dToe && sToe) vals.push(dToe[1] - sToe[1] * ratio);
    per.push({ side, ratio, lift: vals.reduce((a, b) => a + b, 0) / vals.length });
  }
  if (!per.length) return { lift: 0, legRatio: null, bySide: {} };
  const lift = per.reduce((a, p) => a + p.lift, 0) / per.length;
  return {
    lift: Math.max(0, Math.round(lift * 1e4) / 1e4),
    legRatio: Math.round((per.reduce((a, p) => a + p.ratio, 0) / per.length) * 1e4) / 1e4,
    bySide: Object.fromEntries(per.map((p) => [p.side, Math.round(p.lift * 1e5) / 1e5])),
  };
}

// ---- the importer's place: move, turn (degrees, three.js's XYZ order) and size, about a centre -------

const finite3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : d);

/**
 * A place block cleaned: { move: [x, y, z] metres, turn: [x, y, z] degrees, size }. The importer's limits by
 * default (half a metre, half to twice the size); `wide` for a plain model of any scale (the four steps).
 */
export const WIDE = Object.freeze({ move: 10, sizeMin: 1e-4, sizeMax: 1e4 });
export function cleanPlace(p, limits = { move: 0.5, sizeMin: 0.5, sizeMax: 2 }) {
  const size = Number.isFinite(p?.size) && p.size > 0 ? Math.min(limits.sizeMax, Math.max(limits.sizeMin, p.size)) : 1;
  const round = (v, k) => Math.round(v * k) / k;
  return {
    move: finite3(p?.move, [0, 0, 0]).map((v) => round(Math.min(limits.move, Math.max(-limits.move, v)), 1e5)),
    turn: finite3(p?.turn, [0, 0, 0]).map((v) => round(((v + 540) % 360) - 180, 1e3)),
    size: Number(size.toPrecision(6)),
  };
}

export const placeEdited = (p) => { const c = cleanPlace(p); return c.move.some((v) => v !== 0) || c.turn.some((v) => v !== 0) || c.size !== 1; };

/** Euler angles in degrees (XYZ, as three.js's default order) → quaternion [x, y, z, w]. */
export function quatFromTurn(turn) {
  const [x, y, z] = turn.map((d) => (d * Math.PI) / 360);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

/** The place as one matrix acting about `centre`: T(centre + move) · R(turn) · S(size) · T(−centre). */
export function placeMatrix(place, centre = [0, 0, 0], limits) {
  const p = cleanPlace(place, limits);
  const rs = localMatrix({ rotation: quatFromTurn(p.turn), scale: [p.size, p.size, p.size] });
  const toCentre = localMatrix({ translation: centre.map((c) => -c) });
  const back = localMatrix({ translation: centre.map((c, i) => c + p.move[i]) });
  return multiply(back, multiply(rs, toCentre));
}

// ---- writing into a model ------------------------------------------------------------------------------

function writeFloats(json, bin, ai, data) {
  const a = json.accessors[ai];
  const bv = json.bufferViews[a.bufferView];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const stride = bv.byteStride || nc * 4;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) dv.setFloat32(off + i * stride + c * 4, data[i * nc + c], true);
  if (a.min && a.max && nc <= 4) {
    const mn = Array(nc).fill(Infinity), mx = Array(nc).fill(-Infinity);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) { const v = Math.fround(data[i * nc + c]); if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
    a.min = mn; a.max = mx;
  }
}

const lin = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function setLocal(node, m) {
  const d = decompose(m);
  delete node.matrix;
  if (d.translation.some((v) => Math.abs(v) > EPS)) node.translation = d.translation; else delete node.translation;
  if (Math.abs(d.rotation[3] - 1) > EPS || d.rotation.slice(0, 3).some((v) => Math.abs(v) > EPS)) node.rotation = d.rotation; else delete node.rotation;
  if (d.scale.some((v) => Math.abs(v - 1) > EPS)) node.scale = d.scale; else delete node.scale;
}

// vertices of a skinned mesh, moved by per-joint matrices blended by their weights
function skinVertices(json, bin, meshIndex, jointMats) {
  let travel = 0;
  for (const p of json.meshes[meshIndex].primitives) {
    const J = readAccessor(json, bin, p.attributes.JOINTS_0);
    const W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
    const blend = (i) => {
      const m = new Array(16).fill(0);
      for (let k = 0; k < 4; k++) {
        const w = W[i * 4 + k];
        if (!(w > 0)) continue;
        const jm = jointMats[J[i * 4 + k]];
        for (let e = 0; e < 16; e++) m[e] += w * jm[e];
      }
      return m;
    };
    const mats = Array.from({ length: J.length / 4 }, (_, i) => blend(i));
    const pos = readAccessor(json, bin, p.attributes.POSITION);
    const out = new Float32Array(pos.length);
    for (let i = 0; i < pos.length / 3; i++) {
      const v = transformPoint(mats[i], [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      out.set(v, i * 3);
      travel = Math.max(travel, Math.hypot(v[0] - pos[i * 3], v[1] - pos[i * 3 + 1], v[2] - pos[i * 3 + 2]));
    }
    writeFloats(json, bin, p.attributes.POSITION, out);
    for (const name of ['NORMAL', 'TANGENT']) {
      if (p.attributes[name] === undefined) continue;
      const a = readAccessor(json, bin, p.attributes[name]);
      const nc = name === 'TANGENT' ? 4 : 3;
      for (let i = 0; i < a.length / nc; i++) a.set(norm(lin(mats[i], [a[i * nc], a[i * nc + 1], a[i * nc + 2]])), i * nc);
      writeFloats(json, bin, p.attributes[name], a);
    }
    for (const t of p.targets || []) for (const name of ['POSITION', 'NORMAL', 'TANGENT']) {
      if (t[name] === undefined) continue;
      const a = readAccessor(json, bin, t[name]);
      for (let i = 0; i < a.length / 3; i++) a.set(lin(mats[i], [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]]), i * 3);
      writeFloats(json, bin, t[name], a);
    }
  }
  return travel;
}

/**
 * Move an item's model, cut from a donor, onto Spec by its bones (see the top of this file).
 *   model: the item's GLB (from extractItemModel), with the donor's skeleton
 *   humanBones: its rig (bone → node)
 *   spec: specRig(spec.vrm)
 *   opts.head: { from, to, k } — the donor's head centre, Spec's, and Spec's head size over the donor's. What the
 *     head carries (hair, hats, the head's own spring chains) is then moved from head centre to head centre and
 *     scaled by k, as VRMXW §7's `head` rule has hair follow the head's size; the bones themselves stay unscaled.
 * → { glb, travel (largest vertex move, metres), moves: { bone: metres } (how far each bone moved) }
 */
export function moveOntoSpec(model, humanBones, spec, { head = null } = {}) {
  const parsed = parseGlb(model);
  const json = JSON.parse(JSON.stringify(parsed.json));
  const bin = parsed.bin.slice();
  const nodes = json.nodes || [];
  const pOf = parents(nodes);
  const boneOf = new Map(Object.entries(humanBones).map(([b, n]) => [n, b]));
  const oldW = nodes.map((_, i) => worldMatrix(nodes, i, pOf));
  const newW = new Array(nodes.length);
  const mapped = (n) => boneOf.has(n) && spec.bind.has(boneOf.get(n));
  const nearestMapped = (n) => {
    for (let c = pOf.get(n), k = 0; c !== undefined && k < 512; c = pOf.get(c), k++) if (mapped(c)) return c;
    return null;
  };
  const order = [];
  const visit = (i, depth = 0) => { if (depth > 512) return; order.push(i); for (const c of nodes[i].children || []) visit(c, depth + 1); };
  nodes.forEach((_, i) => { if (!pOf.has(i)) visit(i); });
  const moves = {};
  // geo: where each node takes the geometry it carries (may scale, at the head); newW: the node itself, unscaled
  const geo = new Array(nodes.length);
  const H = head && head.k > 0.75 && head.k < 1.33 ? multiply(localMatrix({ translation: head.to }), multiply(localMatrix({ scale: [head.k, head.k, head.k] }), localMatrix({ translation: head.from.map((v) => -v) }))) : null;
  const unscaled = (m) => {
    const o = m.slice();
    for (const c of [0, 4, 8]) { const l = Math.hypot(o[c], o[c + 1], o[c + 2]) || 1; o[c] /= l; o[c + 1] /= l; o[c + 2] /= l; }
    return o;
  };
  for (const n of order) {
    if (mapped(n)) {
      const bone = boneOf.get(n);
      newW[n] = spec.bind.get(bone).slice();
      geo[n] = bone === 'head' && H ? multiply(H, oldW[n]) : newW[n];
      moves[bone] = Math.round(Math.hypot(newW[n][12] - oldW[n][12], newW[n][13] - oldW[n][13], newW[n][14] - oldW[n][14]) * 1e5) / 1e5;
    } else {
      const a = nearestMapped(n);
      geo[n] = a === null ? oldW[n].slice() : multiply(geo[a], multiply(invert(oldW[a]) || IDENTITY, oldW[n]));
      newW[n] = nodes[n].mesh !== undefined ? geo[n] : unscaled(geo[n]); // a bone never carries scale; a pinned mesh may
    }
  }
  for (const n of order) {
    const p = pOf.get(n);
    if (nodes[n].skin !== undefined && nodes[n].mesh !== undefined) continue; // a skinned mesh's node transform is not used
    setLocal(nodes[n], p === undefined ? newW[n] : multiply(invert(newW[p]) || IDENTITY, newW[n]));
  }
  // the bones that carry the item: its skins' humanoid joints, and the bone above each unskinned mesh
  const carrying = new Set();
  let travel = 0;
  for (const [i, node] of nodes.entries()) {
    if (node.mesh === undefined) continue;
    if (node.skin !== undefined) { for (const j of json.skins[node.skin].joints) if (mapped(j)) carrying.add(boneOf.get(j)); }
    else {
      const a = nearestMapped(i);
      if (a !== null) { const b = boneOf.get(a); carrying.add(b); travel = Math.max(travel, moves[b] || 0); }
    }
  }
  for (const b of Object.keys(moves)) if (!carrying.has(b)) delete moves[b];
  for (const [ni, node] of nodes.entries()) {
    if (node.mesh === undefined || node.skin === undefined) continue;
    const skin = json.skins[node.skin];
    const ibmOld = readAccessor(json, bin, skin.inverseBindMatrices);
    const jointMats = skin.joints.map((j, k) => multiply(geo[j], Array.from(ibmOld.subarray(k * 16, k * 16 + 16))));
    travel = Math.max(travel, skinVertices(json, bin, node.mesh, jointMats));
    const ibmNew = new Float32Array(skin.joints.length * 16);
    skin.joints.forEach((j, k) => ibmNew.set(mapped(j) ? spec.ibm.get(boneOf.get(j)) : invert(newW[j]) || IDENTITY, k * 16));
    writeFloats(json, bin, skin.inverseBindMatrices, ibmNew);
    void ni;
  }
  return { glb: buildGlb(json, bin), travel: Math.round(travel * 1e5) / 1e5, moves };
}

/** The middle of an item's geometry as it sits on Spec (the box's centre), in metres. */
export function itemCentre(model) {
  const { json, bin } = model instanceof Uint8Array ? parseGlb(model) : model;
  const nodes = json.nodes || [];
  const pOf = parents(nodes);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const [i, n] of nodes.entries()) {
    if (n.mesh === undefined) continue;
    const w = n.skin !== undefined ? IDENTITY : worldMatrix(nodes, i, pOf);
    for (const p of json.meshes[n.mesh].primitives) {
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      for (let k = 0; k < pos.length; k += 3) {
        const v = transformPoint(w, [pos[k], pos[k + 1], pos[k + 2]]);
        for (let a = 0; a < 3; a++) { if (v[a] < mn[a]) mn[a] = v[a]; if (v[a] > mx[a]) mx[a] = v[a]; }
      }
    }
  }
  if (!Number.isFinite(mn[0])) return [0, 0, 0];
  return mn.map((v, a) => Math.round(((v + mx[a]) / 2) * 1e5) / 1e5);
}

/**
 * Apply the importer's place to an item's model on Spec. Skinned meshes have their vertices moved
 * (bind space is Spec's rest, so this is where they sit); a pinned item's meshes have their node moved
 * under the bone. → { glb, centre }
 */
export function placeItemModel(model, place, { centre = null } = {}) {
  const parsed = parseGlb(model);
  const c = centre || itemCentre(parsed);
  if (!placeEdited(place)) return { glb: model, centre: c };
  const P = placeMatrix(place, c);
  const json = JSON.parse(JSON.stringify(parsed.json));
  const bin = parsed.bin.slice();
  const nodes = json.nodes || [];
  const pOf = parents(nodes);
  for (const [i, n] of nodes.entries()) {
    if (n.mesh === undefined) continue;
    if (n.skin !== undefined) {
      const skin = json.skins[n.skin];
      skinVertices(json, bin, n.mesh, skin.joints.map(() => P));
    } else {
      const parent = pOf.get(i);
      const pw = parent === undefined ? IDENTITY : worldMatrix(nodes, parent, pOf);
      const w = worldMatrix(nodes, i, pOf);
      setLocal(n, multiply(invert(pw) || IDENTITY, multiply(P, w)));
    }
  }
  return { glb: buildGlb(json, bin), centre: c };
}
