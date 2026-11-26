// Face > Face Shape > Match a Donor Face: measure another avatar's head and set the Face Shape
// controls so Spec's head comes close to it. DOM-free (runs under Node for tests).
//
// Only the head's basic shape is taken. The donor's head skin is scanned exactly as Spec's is
// (headShape.js scanHead: a radius map from the head's centre) and compared with the head the Face
// Shape sliders would make on Spec (targetMap). The sliders only reach broad areas (width, forehead,
// cheekbones, jaw, chin …), so the donor's eyes, nose and mouth never come across: Spec keeps her own
// features and mesh, and the result is ordinary slider values to fine-tune. The donor's overall head
// size is matched separately, on the Body page's Head Size (±15 %).
//
// The steps:
//   1. Head skin only. Of the parts marked as face and other skin, only the triangles that hang at
//      least half on the head bones (head, jaw, eyes and the helper bones under them) are kept, so
//      the neck, shoulders and anything else the skin parts hold never reach the scan.
//   2. Alignment on landmarks. Both heads give the same landmarks: the head and eye joints, the iris
//      centres, the nose tip, the crown, the chin and the back of the head. The donor is brought onto
//      Spec by a weighted similarity (Umeyama, "Least-squares estimation of transformation parameters
//      between two point patterns", IEEE TPAMI 13(4), 1991), restricted to what a symmetric head
//      allows: a turn about X (pitch) and a shift in Y and Z. Its scale is not fitted from the landmark
//      spread (that would swallow Head Width); it is the ratio of the two faces' heights, chin to
//      crown. The donor is then scanned again from Spec's own head centre, along Spec's directions.
//   3. Head size from face height. The head's height, chin to crown, as a share of the figure (the
//      head joint's height above the floor), against the same on the head the sliders ask for.
//   4. A bounded, regularised least-squares fit of the sliders: Gauss–Newton steps (the radius map's
//      change per slider by central differences), Tikhonov regularisation toward each slider's default,
//      Levenberg–Marquardt damping, and the sliders' ranges as bounds (projected Gauss–Seidel on the
//      step's quadratic). The sections marked global (whole-head proportions) are solved first with the
//      local ones held at their defaults; then every section together. Fixed iteration counts.
// Everything here uses + − × ÷ and Math.sqrt only, in fixed loop order. (The radius maps themselves
// come from headShape.js, whose grid directions and target fields use the library's existing Math.cos /
// Math.exp code; those values are what the bake uses, so they are kept as they are.)

import { faceLandmarks } from './face.js';
import { parseGlb } from '../glb.js';
import { isZip } from '../zip.js';
import { guessDonorParts, partSets } from '../measure/donorParts.js';
import { targetMap, scanHead, headField, movePoint, headCell, NLAT, NLON, STEP, HEAD_TUNES, CENTRE_UP } from './headShape.js';
import { readPrims, weightOn } from '../measure/meshRead.js';
import { sinCosDeg } from '../measure/meshIndex.js';
import { shoeLift } from '../measure/bodyMeasure.js';

// The sections a person can tick. Each groups sliders that act on the same part of the radius map, so
// they have to be solved together (they trade off against each other there), while sections that act
// on different parts can be taken or left independently.
//   proportions — Head Width / Height / Depth: the whole head scaled along each axis. They measure the
//     head's overall breadth, height and front-to-back length, and every other slider is a local change
//     on top of them, so they are global (solved first) and on by default.
//   size — the Body page's Head Size: the head as a whole against the body, read from the face height
//     (chin to crown) as a share of the figure. A uniform size change and equal changes of Width, Height
//     and Depth make the same head, so one of them must give way: with Head size taken, the face height
//     is Head Size's, and Head Height is held at 0 (Width and Depth then say how broad and deep the head
//     is for its height). Leave Head size out to have Head Height matched instead. On by default.
//   forehead — Forehead: the upper front of the skull raised or lowered. It measures the brow-to-crown
//     slope, which nothing else reaches. On.
//   cheekbones — Cheekbone Width: the sides of the face below the eyes. It measures the face's width at
//     the cheekbones against the head's. On.
//   jaw — Jaw Size, Chin Slim, Chin Tip Up / Down: the lower face. Their regions overlap (jaw angle,
//     lower front, chin tip), so they are one section. They measure the jaw's breadth, the taper to the
//     chin and the chin's length. On.
//   character — Head Shape (Female) / (Male), Round Face: leans of the whole head toward fixed
//     proportions. Each is a blend of the proportions and the lower-face shape above, so with those taken
//     they add nothing the fit can tell apart and only spread the result over more sliders. Off; tick it
//     (perhaps instead of proportions and jaw) to describe a head by its character. Global.
//   canvas — Blank Egg → Head Shape: how much of Spec's own face detail is kept. Lowering it flattens
//     Spec's nose and features toward the smooth egg instead of reshaping the head, which is not what a
//     match is for. Off; only for a donor whose head is much plainer than Spec's. Global.
export const MATCH_SECTIONS = [
  { id: 'proportions', label: 'Head proportions', keys: ['headWidth', 'headHeight', 'headDepth'], global: true, on: true },
  { id: 'size', label: 'Head size (Body page)', keys: [], size: true, on: true },
  { id: 'forehead', label: 'Forehead', keys: ['forehead'], on: true },
  { id: 'cheekbones', label: 'Cheekbones', keys: ['cheekbone'], on: true },
  { id: 'jaw', label: 'Jaw and chin', keys: ['jawSize', 'chinSlim', 'chinLength'], on: true },
  { id: 'character', label: 'Female / male / round', keys: ['headFemale', 'headMale', 'faceRound'], global: true, on: false },
  { id: 'canvas', label: 'Blank egg', keys: ['canvas'], global: true, on: false },
];
export const MATCH_KEYS = MATCH_SECTIONS.flatMap((s) => s.keys);
export const DEFAULT_SECTIONS = MATCH_SECTIONS.filter((s) => s.on).map((s) => s.id);
const RANGE = Object.fromEntries(HEAD_TUNES.map((t) => [t.key, [t.min, t.max]]));
const DEF = Object.fromEntries(HEAD_TUNES.map((t) => [t.key, t.def ?? 0]));
// Body page Head Size: ±1 is ±15 % (body.js AMOUNTS.headSize)
export const HEAD_SIZE_STEP = 0.15;
// Tikhonov weight: the pull of each slider toward its default, in mm² (of the fit's mean squared gap)
// per slider unit². Small: a slider moves when it closes even a fraction of a millimetre (estimated).
export const MATCH_PRIOR = 0.003;
// Levenberg–Marquardt damping (a share of each slider's own curvature) and the fixed iteration counts
export const MATCH_DAMPING = 0.1;
export const MATCH_ITERATIONS = { global: 4, all: 6 };
// alignment-and-fit turns (each alignment uses the sliders and head size the previous fit found)
export const MATCH_PASSES = 3;
const DIFF_STEP = 0.05; // central-difference step, slider units
const SWEEPS = 100; // projected Gauss–Seidel sweeps per step
const HEAD_GROUP = new Set(['head', 'jaw', 'leftEye', 'rightEye']);

// ---- the grid's sines, cosines and cell weights (trig-free tables) -------------------------------------

const SIN_LAT = new Float64Array(NLAT), COS_LAT = new Float64Array(NLAT);
for (let i = 0; i < NLAT; i++) [SIN_LAT[i], COS_LAT[i]] = sinCosDeg(-90 + i * STEP);
// each head cell weighted by the area it stands for on the sphere (cos latitude; the pole rows share
// the polar cap), so the many cells near the crown don't outvote the face
const CELL_W = new Float64Array(NLAT * NLON);
{
  const cap = sinCosDeg(STEP / 2)[0] / 4;
  let sum = 0;
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) {
    if (!headCell(i, j)) continue;
    const w = i === 0 || i === NLAT - 1 ? cap : COS_LAT[i];
    CELL_W[i * NLON + j] = w; sum += w;
  }
  for (let k = 0; k < CELL_W.length; k++) CELL_W[k] /= sum;
}

/** The mean radius of a head map over the head itself (not the neck). */
export function headScale(R) {
  let s = 0, n = 0;
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) if (headCell(i, j)) { s += R[i * NLON + j]; n++; }
  return n ? s / n : 1;
}

/**
 * The face height of a head map: from the chin's lowest point to the crown, along Y (metres), read off
 * the head cells (the crown from the upper ones, the chin from the lower front ones).
 */
export function faceHeight(R) {
  let top = 0, bottom = 0;
  for (let i = 0; i < NLAT; i++) {
    const s = SIN_LAT[i];
    for (let j = 0; j < NLON; j++) {
      if (!headCell(i, j)) continue;
      const r = R[i * NLON + j];
      if (!(r > 0)) continue;
      if (s > 0.5 && r * s > top) top = r * s;
      if (s < -0.5 && -r * s > bottom) bottom = -r * s;
    }
  }
  return top + bottom;
}

// ---- reading a head for matching ---------------------------------------------------------------------

const FACE_SKIN = /(^|_)Face_\d+_SKIN/i;
const BODY_SKIN = /(^|_)Body_\d+_SKIN/i;

/**
 * Scan a head for matching: the head skin only, in the +Z-facing frame, with its landmarks.
 * parts: the model's parts with their roles (measure/donorParts.js) for a model not named the way
 * VRoid's exported files name parts; without them the face is found by those names.
 * → the scanned head (as headShape.js scanHead returns it) with a `match` record (not enumerable):
 *   { landmarks: { name: [x, y, z] }, faceTris, bodyTris, lm: { mid, d }, bodyHeight, lift }, or null.
 */
export function scanMatchHead(json, bin, parts = null) {
  const sets = parts ? partSets(parts) : null;
  const lm = faceLandmarks(json, bin, sets);
  if (!lm) return null;
  const { prims, boneNames, joints } = readPrims(json, bin);
  const f = lm.fwd || 1;
  const turn = (p) => [p[0] * f, p[1], p[2] * f];
  const mats = (re) => new Set((json.materials || []).map((m, i) => (re.test(m.name || '') ? i : -1)).filter((i) => i >= 0));
  const skinMats = sets?.skinMats || mats(FACE_SKIN);
  const bodyMats = sets?.bodyMats || mats(BODY_SKIN);
  const faceMeshes = new Set(prims.filter((p) => skinMats.has(p.material)).map((p) => p.mesh));
  const mid = turn(lm.mid), d = lm.d;
  const reach = 2.4 * d, cy = mid[1] + CENTRE_UP * d;
  const faceTris = [], bodyTris = [];
  for (const p of prims) {
    const isFace = skinMats.has(p.material);
    const isBody = !isFace && bodyMats.has(p.material) && (sets || !faceMeshes.has(p.mesh));
    if (!isFace && !isBody) continue;
    const w = weightOn(p, boneNames, HEAD_GROUP);
    let any = false;
    for (let i = 0; i < p.bone.length; i += 4) if (p.bone[i] >= 0) { any = true; break; }
    for (let t = 0; t < p.tris.length; t += 3) {
      const a = p.tris[t], b = p.tris[t + 1], c = p.tris[t + 2];
      // a part with no weights at all counts as the head's when it is the face skin
      const hw = any ? (w[a] + w[b] + w[c]) / 3 : isFace ? 1 : 0;
      if (hw < 0.5) continue;
      const tri = [a, b, c].map((v) => [p.verts[v * 3], p.verts[v * 3 + 1], p.verts[v * 3 + 2]]);
      if (isBody && !tri.every((q) => Math.abs(q[1] - cy) < reach && Math.abs(q[0] - mid[0]) < reach)) continue;
      (isFace ? faceTris : bodyTris).push(tri);
    }
  }
  if (!faceTris.length) return null;
  let head;
  try { head = scanHead({ mid, d, fwd: 1 }, faceTris, bodyTris); } catch { return null; }
  // surface landmarks: extremes of the head skin near the midline (first one found wins a tie)
  const c = head.c;
  let crown = null, chin = null, back = null;
  for (const [list, isFace] of [[faceTris, true], [bodyTris, false]])
    for (const tri of list) for (const q of tri) {
      const ax = Math.abs(q[0] - mid[0]);
      if (ax < 0.3 * d && (!crown || q[1] > crown[1])) crown = q;
      if (isFace && ax < 0.15 * d && q[2] > c[2] && (!chin || q[1] < chin[1])) chin = q;
      if (ax < 0.3 * d && Math.abs(q[1] - c[1]) < 0.35 * d && (!back || q[2] < back[2])) back = q;
    }
  const eyes = [turn(lm.eyeL), turn(lm.eyeR)];
  const landmarks = {
    eyePlus: eyes[0][0] >= eyes[1][0] ? eyes[0] : eyes[1],
    eyeMinus: eyes[0][0] >= eyes[1][0] ? eyes[1] : eyes[0],
    nose: turn(lm.noseTip),
  };
  if (crown) landmarks.crown = crown;
  if (chin) landmarks.chin = chin;
  if (back) landmarks.back = back;
  for (const b of ['head', 'leftEye', 'rightEye']) if (joints[b]) landmarks[`joint:${b}`] = joints[b];
  // the figure's height: the head joint above the floor, barefoot (a figure in shoes stands higher by its
  // soles; bodyMeasure.js shoeLift finds the lift from the joints and the body skin's lowest point)
  let ground = Infinity;
  for (const p of prims) if (bodyMats.has(p.material) || skinMats.has(p.material)) for (let i = 1; i < p.verts.length; i += 3) if (p.verts[i] < ground) ground = p.verts[i];
  const lift = Number.isFinite(ground) ? shoeLift(joints, ground) : 0;
  const bodyHeight = joints.head && joints.head[1] - lift > 0 ? joints.head[1] - lift : c[1];
  Object.defineProperty(head, 'match', { value: { landmarks, faceTris, bodyTris, lm: { mid, d }, bodyHeight, lift }, enumerable: false, configurable: true, writable: true });
  return head;
}

/**
 * A donor's head from its file (glTF JSON and binary) -> the scanned head, or null.
 * parts: the donor's parts with their roles (measure/donorParts.js) for an avatar not named the way
 * VRoid's exported files name parts; without them the face is found by those names.
 */
export function donorHead(json, bin, parts = null) {
  return scanMatchHead(json, bin, parts);
}

/**
 * A donor file read: { json, bin, vroid, parts (guessed roles) }. Bytes: a .vrm / .glb or a .vrmxa.
 * opts.base: Spec ({ json, bin }) to find the parts by their shape when the names don't say
 * (measure/donorParts.js guessDonorParts).
 */
export async function readDonor(bytes, opts = {}) {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isZip(u8)) { // a .vrmxa: its avatar.vrm (checked first, as every bundle is)
    const { readBundle } = await import('../vrmxa.js');
    const b = await readBundle(u8);
    u8 = b.entries.get(b.manifest.avatar?.file || 'avatar.vrm');
  }
  const { json, bin } = parseGlb(u8);
  const { vroid, parts } = guessDonorParts(json, bin, opts.base ? { base: opts.base } : {});
  return { json, bin, vroid, parts };
}

/** A donor's head from file bytes: VRoid-style names first, else the guessed parts. -> head or null */
export async function donorHeadFromBytes(bytes, parts = null, opts = {}) {
  const d = await readDonor(bytes, opts);
  return donorHead(d.json, d.bin, parts || (d.vroid ? null : d.parts));
}

// ---- alignment -----------------------------------------------------------------------------------------

// how much each landmark counts in the alignment: the joints most (a face-shape edit never moves a bone),
// the iris centres next, the surface extremes least (the sliders being matched move them)
const LANDMARK_WEIGHT = { 'joint:head': 4, 'joint:leftEye': 2, 'joint:rightEye': 2, eyePlus: 1, eyeMinus: 1, nose: 0.5, crown: 0.5, chin: 0.5, back: 0.5 };

/**
 * The similarity bringing the donor's head onto the base's: p' = s·R·p + t, R a turn about X.
 * scale: s, given (by default the two figures' heights, head joint above the floor); R and t: weighted
 * least squares over the landmarks both heads have (Umeyama 1991 with the scale given and the rotation
 * restricted to pitch, the only turn a symmetric head allows).
 * → { s, cos, sin, t: [x, y, z], used: [landmark names], rms (metres, after) } or null.
 */
export function alignHead(base, donor, scale = null, baseLandmarks = null) {
  const A = donor.match?.landmarks, B = baseLandmarks || base.match?.landmarks;
  if (!A || !B) return null;
  const names = Object.keys(LANDMARK_WEIGHT).filter((n) => A[n] && B[n]);
  if (names.length < 3) return null;
  const s = scale ?? base.match.bodyHeight / donor.match.bodyHeight;
  let W = 0;
  const ma = [0, 0, 0], mb = [0, 0, 0];
  for (const n of names) { const w = LANDMARK_WEIGHT[n]; W += w; for (let k = 0; k < 3; k++) { ma[k] += w * A[n][k]; mb[k] += w * B[n][k]; } }
  for (let k = 0; k < 3; k++) { ma[k] /= W; mb[k] /= W; }
  let P = 0, Q = 0;
  for (const n of names) {
    const w = LANDMARK_WEIGHT[n];
    const ay = A[n][1] - ma[1], az = A[n][2] - ma[2], by = B[n][1] - mb[1], bz = B[n][2] - mb[2];
    P += w * (by * ay + bz * az);
    Q += w * (bz * ay - by * az);
  }
  const l = Math.sqrt(P * P + Q * Q);
  const cos = l > 0 ? P / l : 1, sin = l > 0 ? Q / l : 0;
  const rot = (p) => [p[0], cos * p[1] - sin * p[2], sin * p[1] + cos * p[2]];
  const rma = rot(ma);
  const t = [mb[0] - s * rma[0], mb[1] - s * rma[1], mb[2] - s * rma[2]];
  let e = 0;
  for (const n of names) {
    const q = rot(A[n]);
    for (let k = 0; k < 3; k++) { const dd = s * q[k] + t[k] - B[n][k]; e += LANDMARK_WEIGHT[n] * dd * dd; }
  }
  return { s, cos, sin, t, used: names, rms: Math.sqrt(e / W) };
}

/** The donor's head scanned again from the base head's centre after alignment. → radius map (donor metres) */
function rescan(base, donor, al) {
  const move = (q) => {
    const y = al.cos * q[1] - al.sin * q[2], z = al.sin * q[1] + al.cos * q[2];
    return [al.s * q[0] + al.t[0], al.s * y + al.t[1], al.s * z + al.t[2]];
  };
  const m = donor.match;
  const h = scanHead({ mid: base.match.lm.mid, d: base.match.lm.d, fwd: 1 }, m.faceTris.map((tr) => tr.map(move)), m.bodyTris.map((tr) => tr.map(move)));
  const R = new Float64Array(h.R.length);
  for (let k = 0; k < R.length; k++) R[k] = h.R[k] / al.s;
  return R;
}

// ---- the fit -------------------------------------------------------------------------------------------

/**
 * Find the Face Shape slider values that make `base` (Spec's scanned head) closest to `donor`, using
 * only the sections asked for (ids from MATCH_SECTIONS; default DEFAULT_SECTIONS).
 * Heads from scanMatchHead / donorHead are aligned first; plain scanned heads (headShape.js scanHead,
 * face.js faceLandmarks) are compared in their own frames.
 * -> { keys (the sliders this match owns), shapes: { key: value } (those away from their default),
 *    headSize (Body page value, or null when the Head size section isn't taken), sizeRatio, before (mm),
 *    after (mm), rms (mm), held (sliders kept at their default, with why), align (the similarity, or
 *    null), method ('aligned' | 'own-frame') }
 *    before / after: the average distance between the heads, at Spec's size, without / with the match.
 */
export function matchHead(base, donor, sections = DEFAULT_SECTIONS) {
  const used = MATCH_SECTIONS.filter((s) => sections.includes(s.id));
  const sizeOn = used.some((s) => s.size);
  const keys = used.flatMap((s) => s.keys);
  const held = {};
  if (sizeOn && keys.includes('headHeight')) held.headHeight = 'the face height is read as Head Size';
  const free = keys.filter((k) => !held[k]);
  const globalKeys = new Set(used.filter((s) => s.global).flatMap((s) => s.keys));
  const aligned = !!(base.match && donor.match);
  const Hd = aligned ? donor.match.bodyHeight : donor.c[1];
  const Hb = aligned ? base.match.bodyHeight : base.c[1]; // the same reference on both sides
  const scale = Hb * 1000; // residuals in millimetres at Spec's size
  const s = Object.fromEntries(keys.map((k) => [k, DEF[k]]));
  const mapOf = (v) => targetMap(base, { shapes: { ...v } });

  // one fit of the sliders (in place, from where they are) to a donor map in metres about the base centre
  const fit = (Rd) => {
    const Ld = faceHeight(Rd);
    // residual (donor − model), each head cell weighted by its area; and the head size ratio
    const evaluate = (v) => {
      const T = mapOf(v);
      const k = (Ld / Hd) / (faceHeight(T) / Hb);
      const kk = sizeOn ? k : 1;
      const r = new Float64Array(NLAT * NLON);
      for (let c = 0; c < r.length; c++) {
        if (!(CELL_W[c] > 0)) continue;
        r[c] = Math.sqrt(CELL_W[c]) * (Rd[c] / (Hd * kk) - T[c] / Hb) * scale;
      }
      return { r, k };
    };
    const cost = (r, v) => {
      let e = 0;
      for (let c = 0; c < r.length; c++) e += r[c] * r[c];
      for (const key of free) { const d = v[key] - DEF[key]; e += MATCH_PRIOR * d * d; }
      return e;
    };
    const step = (active) => {
      const n = active.length;
      const r0 = evaluate(s).r;
      const J = active.map((key) => {
        const [lo, hi] = RANGE[key];
        const a = Math.max(lo, s[key] - DIFF_STEP), b = Math.min(hi, s[key] + DIFF_STEP);
        const ra = evaluate({ ...s, [key]: a }).r, rb = evaluate({ ...s, [key]: b }).r;
        const col = new Float64Array(r0.length);
        for (let c = 0; c < col.length; c++) col[c] = (rb[c] - ra[c]) / (b - a);
        return col;
      });
      // normal equations of min |r + JΔ|² + λ|s + Δ − def|², with LM damping on the diagonal
      const M = new Float64Array(n * n), g = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
          let v = 0;
          for (let c = 0; c < r0.length; c++) v += J[i][c] * J[j][c];
          M[i * n + j] = v; M[j * n + i] = v;
        }
        let v = 0;
        for (let c = 0; c < r0.length; c++) v += J[i][c] * r0[c];
        g[i] = v + MATCH_PRIOR * (s[active[i]] - DEF[active[i]]);
      }
      for (let i = 0; i < n; i++) M[i * n + i] += MATCH_DAMPING * M[i * n + i] + MATCH_PRIOR;
      // the step within the bounds: projected Gauss–Seidel on ½ΔᵀMΔ + gᵀΔ
      const D = new Float64Array(n);
      for (let sweep = 0; sweep < SWEEPS; sweep++)
        for (let i = 0; i < n; i++) {
          if (!(M[i * n + i] > 0)) continue;
          let gi = g[i];
          for (let j = 0; j < n; j++) gi += M[i * n + j] * D[j];
          const [lo, hi] = RANGE[active[i]];
          const v = D[i] - gi / M[i * n + i];
          D[i] = Math.max(lo - s[active[i]], Math.min(hi - s[active[i]], v));
        }
      // take the step, halving it (at most three times) when it doesn't lower the cost
      const c0 = cost(r0, s);
      for (let tries = 0, f = 1; tries < 4; tries++, f /= 2) {
        const next = { ...s };
        active.forEach((key, i) => { next[key] = s[key] + f * D[i]; });
        if (cost(evaluate(next).r, next) < c0) { Object.assign(s, next); return; }
      }
    };
    const g0 = free.filter((k) => globalKeys.has(k));
    if (g0.length && g0.length < free.length) for (let it = 0; it < MATCH_ITERATIONS.global; it++) step(g0);
    if (free.length) for (let it = 0; it < MATCH_ITERATIONS.all; it++) step(free);
    return { evaluate, start: evaluate(Object.fromEntries(keys.map((k) => [k, DEF[k]]))), fin: evaluate(s) };
  };

  // aligned: the alignment and the fit take turns (MATCH_PASSES times). The first alignment is to
  // Spec's own landmarks, at the figures' scale (with Head size taken: at the landmarks' face height
  // ratio, chin to crown). Each later one is to Spec's landmarks as the sliders found so far move them
  // (headShape.js movePoint, the bake's own move), at the head size found, so the surface landmarks
  // the matched sliders move stop pulling the alignment, and the donor's head centre is placed for a
  // head of its size.
  let al = null, res;
  if (aligned) {
    const body = Hb / Hd;
    const A = donor.match.landmarks, B = base.match.landmarks;
    let ratio = body;
    if (sizeOn && A.crown && A.chin && B.crown && B.chin && A.crown[1] > A.chin[1]) ratio = (B.crown[1] - B.chin[1]) / (A.crown[1] - A.chin[1]);
    for (let pass = 0; pass < MATCH_PASSES; pass++) {
      let target = B;
      if (pass) {
        const field = headField(base, { shapes: { ...s } });
        if (field) target = Object.fromEntries(Object.entries(B).map(([n, p]) => [n, n.startsWith('joint:') ? p : movePoint(field, p)]));
      }
      al = alignHead(base, donor, pass === 0 ? ratio : sizeOn ? body / res.fin.k : body, target);
      if (!al) break;
      res = fit(rescan(base, donor, al));
    }
  }
  if (!res) res = fit(Float64Array.from(donor.R));

  const shapes = {};
  for (const k of keys) if (Math.abs(s[k] - DEF[k]) >= 0.005) shapes[k] = Math.round(s[k] * 1000) / 1000;
  const sizeRatio = res.fin.k;
  const headSize = sizeOn ? Math.round(Math.max(-1, Math.min(1, (sizeRatio - 1) / HEAD_SIZE_STEP)) * 1000) / 1000 : null;
  const meanAbs = (r) => { let e = 0; for (let c = 0; c < r.length; c++) if (CELL_W[c] > 0) e += Math.sqrt(CELL_W[c]) * Math.abs(r[c]); return e; };
  let ss = 0;
  for (let c = 0; c < res.fin.r.length; c++) ss += res.fin.r[c] * res.fin.r[c];
  return {
    keys, shapes, headSize, sizeRatio, before: meanAbs(res.start.r), after: meanAbs(res.fin.r), rms: Math.sqrt(ss),
    held, align: al, method: al ? 'aligned' : 'own-frame',
  };
}
