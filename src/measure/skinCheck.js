// Which parts of an imported model are its body skin, face skin and eyes, by their shape against Spec's.
// DOM-free. Used by donorParts.js when a model's material names don't say.
//
// Spec's own parts are known by their names (Body / Face SKIN, EyeIris). An imported model's parts are
// compared with them:
//   1. Rest pose, facing +Z (meshRead.js), then bone-relative normalisation onto Spec: each humanoid
//      bone gets a map taking the model's bone segment onto Spec's (a turn from one axis to the other,
//      a stretch along it by the length ratio, and across it by the shoulder or hip width ratio), and a
//      vertex moves by its bones' maps blended by its weights. Different proportions (a child, a tall
//      figure, a big head) then land on Spec's body.
//   2. Every part is sampled (meshIndex.js sampleSurface: area-weighted, stratified, a fixed sequence),
//      and so is Spec's skin.
//   3. Per sample: the nearest point of Spec's skin (distance in units of τ, the tolerance of the body
//      region that point is on), whether the normals agree, and whether this part is the innermost
//      surface there — a ray from just under Spec's skin, outward along its normal: the first surface of
//      the model it meets. Skin is the inner layer; clothes, hats and anything lying on the skin are
//      outer layers, and eyes, teeth and mouth sit behind the face's skin, so a ray from that skin
//      outward meets the face first.
//   4. Coverage: the share of each of Spec's body regions that has a sample of the part within τ.
//   5. A score per part, sum of weight × evidence, with the name as a small prior (+1 skin-like word,
//      −1 a word for something else, 0 none); a part is skin when its score passes the threshold, it
//      covers a real share of some region (decals such as brows and eyelines lie on the skin and
//      agree with it everywhere, but cover almost nothing), and its normals agree with Spec's over most
//      of it (hair, shoes and props don't). A skin part is face skin when most of its samples lie on
//      Spec's face skin.
//   6. Eyes: of the parts that aren't skin, those lying on Spec's irises (most samples within a few
//      millimetres) and covering a good share of them.
// Everything is computed with + − × ÷ and Math.sqrt in a fixed order (meshIndex.js), so the same model
// always gets the same roles in every engine.

import { readPrims } from './meshRead.js';
import { TriangleIndex, sampleSurface, pointGrid, triangleArea } from './meshIndex.js';
import { parents } from '../math.js';

/**
 * The check's parameters (this library's own). They start from a geometry-first skin test's usual
 * tolerances and were set on Spec (renamed, and dressed in generated clothes); minNormal and the eye
 * values were then set after an evaluation run on exported VRoid files with their names hidden.
 */
export const SKIN_CHECK = Object.freeze({
  samples: 20000,          // samples per model, spread by area
  minSamples: 64,          // at least this many per part, so small parts are judged too
  // τ, by Spec's body region: a share of Spec's height (looser at the hands and feet, whose fingers and
  // toes are often posed differently, and at the head)
  tau: Object.freeze({ torso: 0.03, armL: 0.03, armR: 0.03, legL: 0.03, legR: 0.03, handL: 0.05, handR: 0.05, footL: 0.05, footR: 0.05, head: 0.04 }),
  normalAgree: 0.7,        // n_part · n_Spec above this counts as agreeing …
  minNormal: 0.7,          // … and a skin part agrees over at least this share of its samples
  innerStart: 0.1,         // the inner ray starts this many τ under Spec's skin …
  innerReach: 3,           // … and looks this many τ out
  // the usual starting weights (0.25, 0.2, 0.25, 0.15, 0.1, and 0.05 for a colour prior, not used here) moved toward
  // the innermost test and coverage: on Spec dressed, a shell 6 mm off the skin agrees with the skin in
  // distance and normals everywhere and only those two tell it apart
  weights: Object.freeze({ near: 0.2, normal: 0.15, inner: 0.35, coverage: 0.2, name: 0.1 }),
  threshold: 0.6,
  coverTau: 0.25,          // coverage counts a sample of the part within this many τ of Spec's sample
  minCoverage: 0.15,       // a skin part covers at least this share of some region
  eyeTol: 0.005,           // eyes: within this share of Spec's height of Spec's iris …
  eyeNear: 0.6,            // … for this share of the part's samples …
  eyeCover: 0.3,           // … covering this share of Spec's iris (the best such part)
});

// the name prior: our own generic words, matched without case in material and mesh names
export const SKIN_WORDS = Object.freeze({
  skin: /skin|body|face|head|hand|arm|leg|foot|feet|hada|karada|kao|肌|体|顔|頭/i,
  other: /hair|eye|iris|pupil|lash|brow|mayu|matsuge|tooth|teeth|tongue|mouth|cloth|shirt|pant|skirt|dress|shoe|sock|glove|hat|cap|ribbon|acc|glass|tail|ear\b|wing|frill|tie|bag|weapon|sword/i,
});

/** The name prior of a part: −1, 0 or +1. */
export function namePrior(...names) {
  for (const n of names) {
    if (!n) continue;
    if (SKIN_WORDS.other.test(n)) return -1;
    if (SKIN_WORDS.skin.test(n)) return 1;
  }
  return 0;
}

const REGIONS = ['torso', 'head', 'armL', 'armR', 'handL', 'handR', 'legL', 'legR', 'footL', 'footR'];
const HEAD = new Set(['head', 'jaw', 'leftEye', 'rightEye']);
/** The body region of a humanoid bone. */
export function regionOfBone(b) {
  if (!b) return 'torso';
  if (HEAD.has(b)) return 'head';
  const side = b.startsWith('left') ? 'L' : b.startsWith('right') ? 'R' : '';
  if (!side) return 'torso';
  if (/Shoulder$/.test(b)) return 'torso';
  if (/(Hand|Thumb|Index|Middle|Ring|Little)/.test(b)) return `hand${side}`;
  if (/(Foot|Toes)$/.test(b)) return `foot${side}`;
  if (/Arm$/.test(b)) return `arm${side}`;
  if (/Leg$/.test(b)) return `leg${side}`;
  return 'torso';
}

// the role VRoid's names give Spec's parts (Spec is named that way by construction)
const SPEC_ROLE = (name) => (/_Face_\d+_SKIN/.test(name) ? 'face' : /_Body_\d+_SKIN/.test(name) ? 'body' : /_EyeIris_\d+_EYE/.test(name) ? 'eyes' : null);

// the dominant humanoid bone of a vertex → index into boneNames, or −1
const topBone = (p, i) => {
  let b = -1, w = -1;
  for (let k = 0; k < 4; k++) if (p.bone[i * 4 + k] >= 0 && p.weight[i * 4 + k] > w) { w = p.weight[i * 4 + k]; b = p.bone[i * 4 + k]; }
  return b;
};

const BASES = new WeakMap();

/**
 * Spec's skin and irises, prepared once per Spec (cached on its JSON): BVHs, samples, regions.
 * base: { json, bin } of Spec (or any base figure named the VRoid way).
 */
export function skinBase(base) {
  if (BASES.has(base.json)) return BASES.get(base.json);
  const { prims, boneNames, joints } = readPrims(base.json, base.bin);
  const skinV = [], skinT = [], triRegion = [], triFace = [];
  const irisV = [], irisT = [];
  let top = -Infinity;
  for (const p of prims) {
    const role = SPEC_ROLE(p.name);
    if (!role) continue;
    const V = role === 'eyes' ? irisV : skinV, T = role === 'eyes' ? irisT : skinT;
    const off = V.length / 3;
    for (let i = 0; i < p.verts.length; i++) V.push(p.verts[i]);
    for (let t = 0; t < p.tris.length; t += 3) {
      T.push(p.tris[t] + off, p.tris[t + 1] + off, p.tris[t + 2] + off);
      if (role === 'eyes') continue;
      // region: the dominant bone of the triangle's first corner that has one
      let b = -1;
      for (let k = 0; k < 3 && b < 0; k++) b = topBone(p, p.tris[t + k]);
      triRegion.push(REGIONS.indexOf(regionOfBone(boneNames[b])));
      triFace.push(role === 'face' ? 1 : 0);
    }
    if (role !== 'eyes') for (let i = 1; i < p.verts.length; i += 3) if (p.verts[i] > top) top = p.verts[i];
  }
  const height = top > 0 ? top : 1;
  const skin = new TriangleIndex(skinV, skinT);
  const iris = new TriangleIndex(irisV, irisT);
  let area = 0;
  for (let t = 0; t < skinT.length; t += 3) {
    const a = skinT[t] * 3, b = skinT[t + 1] * 3, c = skinT[t + 2] * 3;
    area += triangleArea(skinV[a], skinV[a + 1], skinV[a + 2], skinV[b], skinV[b + 1], skinV[b + 2], skinV[c], skinV[c + 1], skinV[c + 2]);
  }
  const samples = sampleSurface(skinV, skinT, SKIN_CHECK.samples / (area || 1));
  const sampleRegion = new Int32Array(samples.count);
  const regionCount = new Int32Array(REGIONS.length);
  for (let k = 0; k < samples.count; k++) { sampleRegion[k] = triRegion[samples.tri[k]]; regionCount[sampleRegion[k]]++; }
  const irisSamples = sampleSurface(irisV, irisT, 2000 / Math.max(1e-9, (() => { let s = 0; for (let t = 0; t < irisT.length; t += 3) { const a = irisT[t] * 3, b = irisT[t + 1] * 3, c = irisT[t + 2] * 3; s += triangleArea(irisV[a], irisV[a + 1], irisV[a + 2], irisV[b], irisV[b + 1], irisV[b + 2], irisV[c], irisV[c + 1], irisV[c + 2]); } return s; })()));
  const out = { skin, triRegion: Int32Array.from(triRegion), triFace: Uint8Array.from(triFace), iris, samples, sampleRegion, regionCount, irisSamples, joints, height, json: base.json };
  BASES.set(base.json, out);
  return out;
}

// ---- bone-relative normalisation -----------------------------------------------------------------------

const AXIS_CHILD = {
  hips: ['spine'], spine: ['chest', 'upperChest', 'neck'], chest: ['upperChest', 'neck'], upperChest: ['neck'], neck: ['head'],
  leftShoulder: ['leftUpperArm'], leftUpperArm: ['leftLowerArm'], leftLowerArm: ['leftHand'],
  rightShoulder: ['rightUpperArm'], rightUpperArm: ['rightLowerArm'], rightLowerArm: ['rightHand'],
  leftUpperLeg: ['leftLowerLeg'], leftLowerLeg: ['leftFoot'], leftFoot: ['leftToes'],
  rightUpperLeg: ['rightLowerLeg'], rightLowerLeg: ['rightFoot'], rightFoot: ['rightToes'],
};
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.sqrt(dot(a, a));
const dist = (a, b) => len(sub(a, b));

// 3×3 row-major: the minimal turn taking unit a onto unit b (Rodrigues' formula in its trig-free form,
// R v = c·v + k × v + (k·v)/(1 + c)·k with k = a × b, c = a·b), times
// (ℓ along a, σ across a)
function boneLinear(a, b, l, s) {
  const k = cross(a, b), c = dot(a, b);
  const M = new Float64Array(9);
  for (let j = 0; j < 3; j++) {
    // column j: the image of the j-th unit vector
    const e = [0, 0, 0]; e[j] = 1;
    const along = dot(a, e);
    const v = [s * e[0] + (l - s) * along * a[0], s * e[1] + (l - s) * along * a[1], s * e[2] + (l - s) * along * a[2]];
    let r = v;
    if (c > -0.999) {
      const kv = cross(k, v), f = dot(k, v) / (1 + c);
      r = [c * v[0] + kv[0] + f * k[0], c * v[1] + kv[1] + f * k[1], c * v[2] + kv[2] + f * k[2]];
    }
    M[j] = r[0]; M[3 + j] = r[1]; M[6 + j] = r[2];
  }
  return M;
}

/**
 * The per-bone maps taking a model's body onto the base's: { bone: { from, to, L } } with
 * p ↦ to + L·(p − from). Bones the base lacks take their nearest humanoid ancestor's map.
 */
export function boneMaps(json, joints, baseJoints) {
  const scale = (b1, b2, fallback) => {
    const d = joints[b1] && joints[b2] ? dist(joints[b1], joints[b2]) : 0, e = baseJoints[b1] && baseJoints[b2] ? dist(baseJoints[b1], baseJoints[b2]) : 0;
    return d > 1e-6 && e > 1e-6 ? e / d : fallback;
  };
  const figure = joints.head && baseJoints.head && joints.head[1] > 1e-6 ? baseJoints.head[1] / joints.head[1] : 1;
  const shoulder = scale('leftUpperArm', 'rightUpperArm', figure), hip = scale('leftUpperLeg', 'rightUpperLeg', figure);
  const headS = scale('leftEye', 'rightEye', scale('neck', 'head', shoulder));
  const maps = {};
  const id = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const eyesBoth = joints.leftEye && joints.rightEye && baseJoints.leftEye && baseJoints.rightEye;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  for (const b of Object.keys(joints).sort()) {
    if (!baseJoints[b]) continue;
    const lateral = /Leg|Foot|Toes/.test(b) || b === 'hips' ? hip : shoulder;
    const child = (AXIS_CHILD[b] || []).find((c) => joints[c] && baseJoints[c]);
    let L;
    if (child) {
      const ad = sub(joints[child], joints[b]), ab = sub(baseJoints[child], baseJoints[b]);
      const ld = len(ad), lb = len(ab);
      L = ld > 1e-6 && lb > 1e-6 ? boneLinear(ad.map((v) => v / ld), ab.map((v) => v / lb), lb / ld, lateral) : id.map((v) => v * lateral);
    } else if (HEAD.has(b)) L = id.map((v) => v * headS);
    else L = null; // a hand, toe or finger: its parent's map, about its own joint (below)
    maps[b] = { from: joints[b], to: baseJoints[b], L };
    // the head scales about the eyes (the face is what has to land on Spec's face)
    if (HEAD.has(b) && eyesBoth) maps[b] = { from: mid(joints.leftEye, joints.rightEye), to: mid(baseJoints.leftEye, baseJoints.rightEye), L };
  }
  // bones with no map of their own, and bones the base lacks: the nearest humanoid ancestor's linear map
  const bones = {};
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (hb) for (const [k, v] of Object.entries(hb)) bones[k] = v.node;
  for (const x of json.extensions?.VRM?.humanoid?.humanBones || []) if (bones[x.bone] == null) bones[x.bone] = x.node;
  const boneOf = new Map(Object.entries(bones).map(([k, n]) => [n, k]));
  const par = parents(json.nodes || []);
  const ancestorMap = (b) => {
    const seen = new Set();
    for (let n = par.get(bones[b]); n != null && !seen.has(n); n = par.get(n)) {
      seen.add(n);
      const a = boneOf.get(n);
      if (a && maps[a]?.L) return maps[a];
    }
    return null;
  };
  for (const b of Object.keys(bones).sort()) {
    if (maps[b]?.L) continue;
    const a = ancestorMap(b);
    if (maps[b]) maps[b].L = a ? a.L : id.map((v) => v * figure);
    else if (a && joints[b]) {
      // the base lacks this bone: follow the ancestor's map rigidly
      maps[b] = a;
    }
  }
  return maps;
}

/** A primitive's vertices moved onto the base by its bones' maps. → Float64Array */
export function normalisePrim(p, boneNames, maps) {
  const nv = p.verts.length / 3;
  const out = new Float64Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const x = p.verts[i * 3], y = p.verts[i * 3 + 1], z = p.verts[i * 3 + 2];
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (let k = 0; k < 4; k++) {
      const b = p.bone[i * 4 + k];
      if (b < 0) continue;
      const m = maps[boneNames[b]];
      const w = p.weight[i * 4 + k];
      if (!m || !(w > 0)) continue;
      const dx = x - m.from[0], dy = y - m.from[1], dz = z - m.from[2], L = m.L;
      sx += w * (m.to[0] + L[0] * dx + L[1] * dy + L[2] * dz);
      sy += w * (m.to[1] + L[3] * dx + L[4] * dy + L[5] * dz);
      sz += w * (m.to[2] + L[6] * dx + L[7] * dy + L[8] * dz);
      sw += w;
    }
    if (sw > 0) { out[i * 3] = sx / sw; out[i * 3 + 1] = sy / sw; out[i * 3 + 2] = sz / sw; } else { out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z; }
  }
  return out;
}

// ---- the check -----------------------------------------------------------------------------------------

/**
 * The roles of a model's parts by their shape against the base (Spec). json, bin: the model;
 * base: { json, bin } of Spec. opts: { names: false } leaves the name prior out (to test the geometry
 * alone); { check }: parameters other than SKIN_CHECK.
 * → { parts: [{ material, name, role, triangles, skin, score, evidence: { samples, near, normal, inner,
 *     coverage, region, faceShare, namePrior, irisNear, irisCover } }], height (the base's) }
 */
export function findSkinParts(json, bin, base, opts = {}) {
  const P = { ...SKIN_CHECK, ...(opts.check || {}) };
  const B = skinBase(base);
  const H = B.height;
  const { prims, boneNames, joints } = readPrims(json, bin);
  const maps = boneMaps(json, joints, B.joints);
  // the parts (materials) and their primitives' triangles, moved onto Spec
  const byMat = new Map();
  const allV = [], allT = [], triMat = [];
  for (const p of prims) {
    const v = normalisePrim(p, boneNames, maps);
    const off = allV.length / 3;
    for (let i = 0; i < v.length; i++) allV.push(v[i]);
    for (let t = 0; t < p.tris.length; t++) allT.push(p.tris[t] + off);
    for (let t = 0; t < p.tris.length; t += 3) triMat.push(p.material);
    if (!byMat.has(p.material)) byMat.set(p.material, { material: p.material, name: p.name, meshNames: new Set(), prims: [] });
    const m = byMat.get(p.material);
    m.meshNames.add(p.meshName);
    m.prims.push({ v, tris: p.tris });
  }
  const model = new TriangleIndex(allV, allT);
  // samples per part: by area at the model's density, never fewer than minSamples
  let total = 0;
  const areaOf = (v, tris) => { let s = 0; for (let t = 0; t < tris.length; t += 3) { const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3; s += triangleArea(v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]); } return s; };
  for (const m of byMat.values()) { m.area = 0; for (const q of m.prims) m.area += areaOf(q.v, q.tris); total += m.area; }
  const density = P.samples / (total || 1);
  const mats = [...byMat.values()].sort((a, b) => a.material - b.material);
  const tauOf = (r) => P.tau[REGIONS[r]] * H;
  const maxTau = Math.max(...Object.values(P.tau)) * H;
  const eyeTol = P.eyeTol * H;
  // every part's samples in one list, for coverage
  const SX = [], SY = [], SZ = [], SM = [];
  for (const m of mats) {
    const rho = m.area > 0 ? Math.max(density, P.minSamples / m.area) : 0;
    const ev = { samples: 0, near: 0, normal: 0, inner: 0, face: 0, nearCount: 0, irisNear: 0, offsets: [], irisD: [] };
    for (const q of m.prims) {
      const s = sampleSurface(q.v, q.tris, rho);
      for (let k = 0; k < s.count; k++) {
        const x = s.x[k], y = s.y[k], z = s.z[k];
        SX.push(x); SY.push(y); SZ.push(z); SM.push(m.material);
        ev.samples++;
        const hit = B.skin.closest(x, y, z, 9 * maxTau * maxTau);
        if (hit) {
          const r = B.triRegion[hit.tri], tau = tauOf(r);
          const d = Math.sqrt(hit.d2);
          const n = B.skin.normal(hit.tri);
          if (d < tau) {
            ev.near++; ev.nearCount++; if (B.triFace[hit.tri]) ev.face++;
            // which side of Spec's skin, in τ: + outside (a layer on top), − inside
            ev.offsets.push(((x - hit.x) * n[0] + (y - hit.y) * n[1] + (z - hit.z) * n[2]) / tau);
          }
          if (s.nx[k] * n[0] + s.ny[k] * n[1] + s.nz[k] * n[2] > P.normalAgree) ev.normal++;
          // innermost: from just under Spec's skin, outward, the first surface of the model met
          const e = P.innerStart * tau;
          const ray = model.ray(hit.x - e * n[0], hit.y - e * n[1], hit.z - e * n[2], n[0], n[1], n[2], 0, e + P.innerReach * tau);
          if (ray && triMat[ray.tri] === m.material) ev.inner++;
        }
        const ih = B.iris.closest(x, y, z, eyeTol * eyeTol);
        if (ih) { ev.irisNear++; ev.irisD.push(ih.d2); }
      }
    }
    m.ev = ev;
  }
  // coverage: per region of Spec's skin, the share of its samples with a sample of the part within τ
  const grid = pointGrid(SX, SY, SZ, P.coverTau * maxTau);
  const covered = new Map(mats.map((m) => [m.material, new Float64Array(REGIONS.length)]));
  const seen = new Map();
  for (let k = 0; k < B.samples.count; k++) {
    const r = B.sampleRegion[k], tau = P.coverTau * tauOf(r);
    seen.clear();
    grid.near(B.samples.x[k], B.samples.y[k], B.samples.z[k], tau, (i) => { seen.set(SM[i], true); });
    for (const mat of seen.keys()) covered.get(mat)[r]++;
  }
  // irises covered
  const irisCovered = new Map(mats.map((m) => [m.material, 0]));
  for (let k = 0; k < B.irisSamples.count; k++) {
    seen.clear();
    grid.near(B.irisSamples.x[k], B.irisSamples.y[k], B.irisSamples.z[k], eyeTol, (i) => { seen.set(SM[i], true); });
    for (const mat of seen.keys()) irisCovered.set(mat, irisCovered.get(mat) + 1);
  }
  const W = P.weights;
  const parts = mats.map((m) => {
    const n = m.ev.samples || 1;
    let coverage = 0, region = null;
    const cov = covered.get(m.material);
    for (let r = 0; r < REGIONS.length; r++) {
      if (!B.regionCount[r]) continue;
      const c = cov[r] / B.regionCount[r];
      if (c > coverage) { coverage = c; region = REGIONS[r]; }
    }
    const prior = opts.names === false ? 0 : namePrior(m.name, ...[...m.meshNames].sort());
    const near = m.ev.near / n, normal = m.ev.normal / n, inner = m.ev.inner / n;
    const score = W.near * near + W.normal * normal + W.inner * inner + W.coverage * coverage + W.name * prior;
    const skin = score >= P.threshold && coverage >= P.minCoverage && normal >= P.minNormal;
    const faceShare = m.ev.nearCount ? m.ev.face / m.ev.nearCount : 0;
    const offs = Float64Array.from(m.ev.offsets).sort();
    const ids = Float64Array.from(m.ev.irisD).sort();
    const irisGap = ids.length ? Math.sqrt(ids[ids.length >> 1]) : Infinity;
    const offset = offs.length ? offs[offs.length >> 1] : 0;
    const irisNear = m.ev.irisNear / n, irisCover = B.irisSamples.count ? irisCovered.get(m.material) / B.irisSamples.count : 0;
    const eyes = !skin && irisNear >= P.eyeNear && irisCover >= P.eyeCover;
    const role = skin ? (faceShare >= 0.5 ? 'face' : 'body') : eyes ? 'eyes' : 'ignore';
    let triangles = 0;
    for (const q of m.prims) triangles += q.tris.length / 3;
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    return {
      material: m.material, name: m.name || `Material ${m.material}`, role, triangles, skin, score: r4(score),
      evidence: { samples: m.ev.samples, near: r4(near), normal: r4(normal), inner: r4(inner), coverage: r4(coverage), region, offset: r4(offset), faceShare: r4(faceShare), namePrior: prior, irisNear: r4(irisNear), irisCover: r4(irisCover), irisGap: Number.isFinite(irisGap) ? Math.round(irisGap * 1e6) / 1e6 : null },
    };
  });
  // one part is the eyes: the one lying best on Spec's irises (share of samples on them × share of them
  // covered); when two lie about as well (a highlight floats just in front of the iris), the one closer
  // to Spec's iris surface; ties go to the lower material number
  const fit = (p) => p.evidence.irisNear * p.evidence.irisCover;
  let top = 0;
  for (const p of parts) if (p.role === 'eyes' && fit(p) > top) top = fit(p);
  let best = null;
  for (const p of parts) if (p.role === 'eyes' && fit(p) >= top - 0.1 && (!best || p.evidence.irisGap < best.evidence.irisGap)) best = p;
  for (const p of parts) if (p.role === 'eyes' && p !== best) p.role = 'ignore';
  return { parts: parts.filter((p) => p.material >= 0), height: H };
}
