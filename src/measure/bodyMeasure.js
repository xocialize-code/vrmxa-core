// Body measurements of a VRM, the way a tailor's tape would take them, for garment fitting
// (FITTING.md, step 1). DOM-free (runs under Node for tests). It reproduces
// VRMXA_Specification/assets/spec/spec.measurements.json exactly from spec.vrm (test/measure.test.mjs).
//
// The frame is the VRM T-pose (VRMC_vrm-1.0 tpose.md): standing toward +Z, symmetrical on X, feet on
// Y = 0, arms out along X. A VRM 0.x model faces −Z, so it is turned round (x, z → −x, −z) first.
// Everything is read in the skinned mesh's bind space: joint positions come from the skin's inverse
// bind matrices (inverse(IBM) = the joint's bind world matrix), the same reading wearAnchor.js uses,
// so bones and skin always agree whatever rest rotations the file's nodes carry.
//
// Each body-skin vertex is labelled by the humanoid bone that carries most of its weight (a helper
// bone counts as its nearest humanoid ancestor): torso, head, left / right arm, left / right leg.
// A measurement is a cross-section ("station"): the skin is cut by a plane across the segment
// (horizontal for the torso and legs, square to the arm for arms) and the cut points are wrapped in
// their convex hull, which is what a tape does — it bridges hollows such as the gap between the
// breasts. Each station gives the girth (hull perimeter), width, depth, centre and a radius profile
// at 32 angles around the centre (angle 0 = toward the model's left, +X; 90° = front, +Z for the
// torso and legs; for arms 0 = up, 90° = front).

import { readAccessor } from '../glb.js';
import { vroidMaterial, guessDonorParts } from './donorParts.js';

export const MEASURE_VERSION = 1;

// Barefoot heights (FITTING.md §9 "Shoe lift", §11 question 4, decided 2026-11-17): a dressed VRoid figure stands
// higher than it would barefoot by its soles (Elena 31.3 mm, Smoke 20.4, Twist 14.7), with its skin raised too.
// Spec's foot and toe joints sit this far above the floor per metre of leg (hip joint to foot joint), read from
// spec.vrm (the gender-neutral Spec, 2026-11-13); a figure's own joints above those, scaled by its leg, are the
// lift (the importer's measureLift computes the same, VRMXW §7.1). It is taken out only when the skin agrees —
// the body's lowest skin is off the floor by at least half of it — so a barefoot body of other proportions
// standing on the floor is never shortened.
export const SPEC_FOOT = Object.freeze({ foot: 0.11196, toes: 0.02982 });
export const LIFT_MIN = 0.002; // metres: less is no lift

/** The shoe lift of a body (metres, 0 when none): J, its joints; skinGround, its lowest skin vertex's height. */
export function shoeLift(J, skinGround, ref = SPEC_FOOT) {
  const per = [];
  for (const side of ['left', 'right']) {
    const hip = J[`${side}UpperLeg`], foot = J[`${side}Foot`], toes = J[`${side}Toes`];
    if (!hip || !foot) continue;
    const leg = hip[1] - foot[1];
    if (!(leg > 0.2)) continue;
    const vals = [foot[1] - ref.foot * leg];
    if (toes) vals.push(toes[1] - ref.toes * leg);
    per.push(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  if (!per.length) return 0;
  const lift = per.reduce((a, b) => a + b, 0) / per.length;
  return lift >= LIFT_MIN && skinGround >= 0.5 * lift ? lift : 0;
}
export const PROFILE_N = 32;          // radius samples around each station
export const SCAN_STEP = 0.005;       // 5 mm between cuts when searching for a fullest / narrowest place
export const SECTORS = 16;            // a cut must reach skin in at least MIN_COVERAGE of these to count
export const MIN_COVERAGE = 0.75;
export const T_POSE_TOLERANCE = 20;   // degrees an upper arm may point away from X before it's "not a T-pose"

const SEGMENT_OF = {
  hips: 'torso', spine: 'torso', chest: 'torso', upperChest: 'torso', neck: 'torso',
  leftShoulder: 'torso', rightShoulder: 'torso',
  head: 'head', leftEye: 'head', rightEye: 'head', jaw: 'head',
  leftUpperArm: 'armL', leftLowerArm: 'armL', leftHand: 'armL',
  rightUpperArm: 'armR', rightLowerArm: 'armR', rightHand: 'armR',
  leftUpperLeg: 'legL', leftLowerLeg: 'legL', leftFoot: 'legL', leftToes: 'legL',
  rightUpperLeg: 'legR', rightLowerLeg: 'legR', rightFoot: 'legR', rightToes: 'legR',
};
const segmentOfBone = (b) => SEGMENT_OF[b] || (/^left.*(Thumb|Index|Middle|Ring|Little)/.test(b) ? 'armL'
  : /^right.*(Thumb|Index|Middle|Ring|Little)/.test(b) ? 'armR' : null);

// ---- small vector helpers ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function invertAffine(m) {
  // column-major 4x4 with last row 0 0 0 1 -> its inverse
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const r = [
    (e * i - f * h) / det, (f * g - d * i) / det, (d * h - e * g) / det, 0,
    (c * h - b * i) / det, (a * i - c * g) / det, (b * g - a * h) / det, 0,
    (b * f - c * e) / det, (c * d - a * f) / det, (a * e - b * d) / det, 0,
    0, 0, 0, 1,
  ];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}

/** The humanoid bone map of a VRM 1.0 or 0.x file: { boneName: nodeIndex }. */
export function humanBones(json) {
  const out = {};
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (hb) for (const [k, v] of Object.entries(hb)) out[k] = v.node;
  for (const b of json.extensions?.VRM?.humanoid?.humanBones || []) if (out[b.bone] == null) out[b.bone] = b.node;
  return out;
}

/**
 * Which materials are body skin: the ones given, else the names VRoid writes into exported files, else the skin parts
 * found for avatars named their own way (lib/donorParts.js: Other skin and Face skin) — by their shape against Spec
 * when `base` (Spec's { json, bin }) is given, else guessed from the names.
 */
function bodySkinMaterials(json, bin, given, base = null) {
  if (given?.size) return given;
  const out = new Set();
  (json.materials || []).forEach((m, i) => { if (vroidMaterial(m.name || '')?.role === 'body') out.add(i); });
  if (out.size) return out;
  for (const p of guessDonorParts(json, bin, base ? { base } : {}).parts) if (p.role === 'body' || p.role === 'face') out.add(p.material);
  return out;
}

/**
 * Read the body: skin vertices with their segment labels, and the humanoid joints, in the T-pose
 * frame (facing +Z). opts.bodyMats: Set of material indices that are body skin (for avatars not
 * named the VRoid way); opts.base: Spec's { json, bin }, to find that skin by its shape instead. -> { verts: Float32Array xyz, label: string[], tris: [[a,b,c]], joints, fwd }
 */
export function readBody(json, bin, opts = {}) {
  const fwd = json.extensions?.VRMC_vrm ? 1 : -1;
  const turn = (p) => (fwd === 1 ? p : [-p[0], p[1], -p[2]]);
  const bones = humanBones(json);
  const boneOfNode = new Map(Object.entries(bones).map(([k, n]) => [n, k]));
  const parent = new Map();
  (json.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const humanOf = (node) => { for (let n = node; n != null; n = parent.get(n)) if (boneOfNode.has(n)) return boneOfNode.get(n); return null; };

  // joint positions from the skins' inverse bind matrices
  const joints = {};
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices == null) continue;
    const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((node, j) => {
      const bone = boneOfNode.get(node);
      if (!bone || joints[bone]) return;
      const inv = invertAffine([...ibm.slice(j * 16, j * 16 + 16)]);
      if (inv) joints[bone] = turn([inv[12], inv[13], inv[14]]);
    });
  }

  const mats = bodySkinMaterials(json, bin, opts.bodyMats, opts.base);
  const verts = [], label = [], tris = [];
  const seen = new Map(); // "accessor:index" -> our vertex index
  (json.meshes || []).forEach((mesh, mi) => {
    const holder = (json.nodes || []).find((n) => n.mesh === mi && n.skin != null);
    const skin = holder ? json.skins[holder.skin] : null;
    for (const p of mesh.primitives) {
      if (!mats.has(p.material) || p.indices == null || !skin) continue;
      const a = p.attributes;
      if (a.POSITION == null || a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
      const pos = readAccessor(json, bin, a.POSITION), jn = readAccessor(json, bin, a.JOINTS_0), wt = readAccessor(json, bin, a.WEIGHTS_0);
      const idx = readAccessor(json, bin, p.indices);
      const our = (i) => {
        const key = `${a.POSITION}:${i}`;
        if (seen.has(key)) return seen.get(key);
        let best = -1, bw = -1;
        for (let k = 0; k < 4; k++) if (wt[i * 4 + k] > bw) { bw = wt[i * 4 + k]; best = jn[i * 4 + k]; }
        const bone = humanOf(skin.joints[best]);
        const q = turn([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
        verts.push(q[0], q[1], q[2]);
        label.push(segmentOfBone(bone) || 'other');
        seen.set(key, label.length - 1);
        return label.length - 1;
      };
      for (let t = 0; t + 2 < idx.length; t += 3) tris.push([our(idx[t]), our(idx[t + 1]), our(idx[t + 2])]);
    }
  });
  return { verts: Float32Array.from(verts), label, tris, joints, fwd };
}

// ---- cutting and wrapping ----

/** The points where a plane (through p0, normal n) cuts the given triangles. */
function cutPoints(body, triList, p0, n) {
  const { verts } = body;
  const d = (i) => (verts[i * 3] - p0[0]) * n[0] + (verts[i * 3 + 1] - p0[1]) * n[1] + (verts[i * 3 + 2] - p0[2]) * n[2];
  const out = [];
  for (const [a, b, c] of triList) {
    const da = d(a), db = d(b), dc = d(c);
    for (const [i, j, di, dj] of [[a, b, da, db], [b, c, db, dc], [c, a, dc, da]]) {
      if ((di < 0) === (dj < 0) || di === dj) continue;
      const t = di / (di - dj);
      out.push([verts[i * 3] + (verts[j * 3] - verts[i * 3]) * t, verts[i * 3 + 1] + (verts[j * 3 + 1] - verts[i * 3 + 1]) * t, verts[i * 3 + 2] + (verts[j * 3 + 2] - verts[i * 3 + 2]) * t]);
    }
  }
  return out;
}

/** Convex hull of 2D points (Andrew's monotone chain), counter-clockwise. */
export function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const perimeter = (h) => h.reduce((s, q, i) => s + Math.hypot(h[(i + 1) % h.length][0] - q[0], h[(i + 1) % h.length][1] - q[1]), 0);
function centroid(h) {
  // area centroid of the polygon
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length];
    const c = x0 * y1 - x1 * y0;
    A += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  if (Math.abs(A) < 1e-12) return h.reduce((s, q) => [s[0] + q[0] / h.length, s[1] + q[1] / h.length], [0, 0]);
  return [cx / (3 * A), cy / (3 * A)];
}
/** The hull's radius from c toward angle th (ray / polygon). */
function radiusAt(h, c, th) {
  const dx = Math.cos(th), dy = Math.sin(th);
  let best = 0;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const ax = a[0] - c[0], ay = a[1] - c[1];
    const t = (ax * ey - ay * ex) / den, s = (ax * dy - ay * dx) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
  }
  return best;
}

/**
 * One cross-section of the given triangles: plane through p0 with normal n, measured in the plane's
 * (u, v) axes. -> { girth, width, depth, center (3D), profile[PROFILE_N], points } or null (no cut)
 */
export function section(body, triList, p0, n, u, v) {
  const pts3 = cutPoints(body, triList, p0, n);
  if (pts3.length < 3) return null;
  const pts = pts3.map((q) => { const r = sub(q, p0); return [dot(r, u), dot(r, v)]; });
  const h = hull2(pts);
  if (h.length < 3) return null;
  const c = centroid(h);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [a, b] of h) { minU = Math.min(minU, a); maxU = Math.max(maxU, a); minV = Math.min(minV, b); maxV = Math.max(maxV, b); }
  const profile = [];
  for (let k = 0; k < PROFILE_N; k++) profile.push(radiusAt(h, c, (2 * Math.PI * k) / PROFILE_N));
  const center = [p0[0] + u[0] * c[0] + v[0] * c[1], p0[1] + u[1] * c[0] + v[1] * c[1], p0[2] + u[2] * c[0] + v[2] * c[1]];
  // how much of the way round real skin was cut (16 sectors around the centre): a body whose skin
  // was cut away under clothes gives only part of a ring, which isn't a measurement
  const filled = new Set(pts.map(([a, b]) => Math.floor(((Math.atan2(b - c[1], a - c[0]) + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS));
  return { girth: perimeter(h), width: maxU - minU, depth: maxV - minV, center, profile, n: pts.length, coverage: filled.size / SECTORS };
}

const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Measure a body. -> the measurements document (FITTING.md §3):
 * { format: 'vrm-body-measurements', version, units: 'm', frame, joints, lengths, stations: [...] }
 * Heights in `lengths` (stature, crotch, knee and ankle heights) are barefoot: for a figure raised by its shoes
 * `lengths.lift` is the lift taken out and `lengths.ground` the floor they are measured from (shoeLift); `joints`
 * and the stations' `at` stay where the file has them.
 * Each station: { id, segment, axis: 'y' | 'arm', at (height in m, or 0…1 along the arm), girth,
 * width, depth, center, profile }.
 */
export function measureBody(json, bin, opts = {}) {
  const body = opts.body || readBody(json, bin, opts);
  const J = body.joints;
  const need = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'head'];
  if (!body.tris.length || need.some((b) => !J[b])) return null;
  const bySeg = (segs) => body.tris.filter((t) => t.every((i) => segs.includes(body.label[i])));
  const torso = bySeg(['torso']);
  const trunk = body.tris.filter((t) => t.every((i) => ['torso', 'legL', 'legR'].includes(body.label[i])));
  const legL = bySeg(['legL']), legR = bySeg(['legR']), armL = bySeg(['armL']), armR = bySeg(['armR']);

  const Y = [0, 1, 0], X = [1, 0, 0], Z = [0, 0, 1];
  const yOf = (b) => J[b][1];
  const avgY = (a, b) => (yOf(a) + yOf(b)) / 2;
  const legTop = avgY('leftUpperLeg', 'rightUpperLeg'), knee = avgY('leftLowerLeg', 'rightLowerLeg'), ankle = avgY('leftFoot', 'rightFoot');
  const shoulder = avgY('leftUpperArm', 'rightUpperArm');
  const neckY = J.neck ? J.neck[1] : (shoulder + yOf('head')) / 2;
  const chestY = J.upperChest ? J.upperChest[1] : J.chest ? J.chest[1] : (legTop + shoulder) / 2;
  const midX = (J.leftUpperLeg[0] + J.rightUpperLeg[0]) / 2;

  // a cut only counts when skin goes most of the way round (not where skin was cut away under clothes)
  const ok = (s) => !!s && s.coverage >= MIN_COVERAGE;
  const horiz = (tris, y, x0 = midX) => section(body, tris, [x0, y, 0], Y, X, Z);
  // the fullest / narrowest cut in a band. It isn't trusted (-> null, reason kept) when most of the
  // band has no full ring of skin, or when it sits right next to a cut that has none: then the real
  // fullest / narrowest place may be in the part that was cut away.
  const doubts = {};
  const scan = (tris, y0, y1, pick, x0, id) => {
    const cuts = [];
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1) + 1e-9; y += SCAN_STEP) cuts.push({ y, s: horiz(tris, y, x0) });
    let bi = -1;
    cuts.forEach((c, i) => { if (ok(c.s) && (bi < 0 || pick(c.s.girth, cuts[bi].s.girth))) bi = i; });
    const valid = cuts.filter((c) => ok(c.s)).length;
    if (bi < 0) return null;
    if (valid < 0.6 * cuts.length) { if (id) doubts[id] = 'most of its band has no full ring of skin (cut away under clothes?)'; return null; }
    const hole = [cuts[bi - 1], cuts[bi + 1]].some((c) => c && !ok(c.s));
    if (hole) { if (id) doubts[id] = 'its fullest / narrowest place is next to skin that was cut away'; return null; }
    return cuts[bi];
  };
  const max = (a, b) => a > b, min = (a, b) => a < b;
  const stations = [], missing = [];
  const put = (id, segment, axis, at, s) => {
    if (!ok(s)) { missing.push({ id, reason: doubts[id] || (s ? 'only part of the skin there (cut away under clothes?)' : 'no skin there') }); return; }
    stations.push({ id, segment, axis, at: round(at), girth: round(s.girth), width: round(s.width), depth: round(s.depth), center: s.center.map((q) => round(q)), profile: s.profile.map((q) => round(q)), coverage: round(s.coverage, 3) });
  };

  // the torso runs from the leg joints (not the hips bone: some rigs, e.g. MMD conversions, put the
  // hips bone below the legs) up to the armpits
  const pelvis = Math.max(J.hips[1], legTop);
  const armpit = shoulder - 0.045;
  // crotch: the highest cut below the pelvis where no trunk skin crosses the middle
  let crotch = legTop;
  for (let y = pelvis + 0.05; y > knee; y -= SCAN_STEP / 2) {
    const pts = cutPoints(body, trunk, [0, y, 0], Y);
    if (pts.length && !pts.some((p) => Math.abs(p[0] - midX) < 0.004)) { crotch = y; break; }
  }
  const thighLen = legTop - knee;
  // torso: waist = narrowest between the pelvis and the chest; bust = fullest above it, below the
  // armpits; when one can't be measured, the others are searched where Spec has them (the waist
  // 53 % of the way from the leg joints to the armpits)
  const waistGuess = legTop + 0.53 * (armpit - legTop);
  const waist = scan(torso, pelvis + 0.02, Math.max(chestY, pelvis + 0.06), min, midX, 'waist');
  const wy = waist ? waist.y : waistGuess;
  const bust = scan(torso, wy + 0.02, armpit, max, midX, 'bust');
  // underbust: the narrowest cut in the band 2–9 cm under the fullest bust (never below the waist)
  const underbust = bust && scan(torso, Math.max(wy + 0.01, bust.y - 0.09), bust.y - 0.02, min, midX, 'underbust');
  if (!bust) doubts.underbust = 'found from the bust, which couldn’t be measured';
  const hip = scan(trunk, crotch + 0.01, wy - 0.02, max, midX, 'hip');
  put('neck', 'torso', 'y', (neckY + yOf('head')) / 2, horiz(torso, (neckY + yOf('head')) / 2));
  put('neckBase', 'torso', 'y', neckY, horiz(torso, neckY));
  put('bust', 'torso', 'y', bust?.y ?? 0, bust?.s);
  put('underbust', 'torso', 'y', underbust?.y ?? 0, underbust?.s);
  put('waist', 'torso', 'y', wy, waist?.s);
  const hy = hip ? hip.y : crotch + 0.03;
  put('highHip', 'torso', 'y', (wy + hy) / 2, horiz(trunk, (wy + hy) / 2));
  put('hip', 'torso', 'y', hy, hip?.s);

  // legs, each on its own: thigh = fullest in the top 40 % below the crotch, knee, calf, ankle
  for (const [side, tris, up, lo, ft] of [['L', legL, 'leftUpperLeg', 'leftLowerLeg', 'leftFoot'], ['R', legR, 'rightUpperLeg', 'rightLowerLeg', 'rightFoot']]) {
    const x0 = J[up][0];
    // (from 3 cm under the crotch: right at the crotch the leg's ring of skin isn't closed yet)
    const thigh = scan(tris, crotch - 0.03, crotch - 0.4 * (crotch - J[lo][1]), max, x0, `thigh${side}`);
    const calf = scan(tris, J[lo][1] - 0.03, J[lo][1] - 0.5 * (J[lo][1] - J[ft][1]), max, x0, `calf${side}`);
    const ank = scan(tris, J[ft][1] + 0.015, J[ft][1] + 0.25 * (J[lo][1] - J[ft][1]), min, x0, `ankle${side}`);
    put(`thigh${side}`, `leg${side}`, 'y', thigh?.y ?? 0, thigh?.s);
    put(`knee${side}`, `leg${side}`, 'y', J[lo][1], horiz(tris, J[lo][1], x0));
    put(`calf${side}`, `leg${side}`, 'y', calf?.y ?? 0, calf?.s);
    put(`ankle${side}`, `leg${side}`, 'y', ank?.y ?? 0, ank?.s);
  }

  // arms: cut square to each bone; `at` runs 0 (shoulder joint) … 1 (wrist) over the whole arm
  for (const [side, tris, up, lo, hd] of [['L', armL, 'leftUpperArm', 'leftLowerArm', 'leftHand'], ['R', armR, 'rightUpperArm', 'rightLowerArm', 'rightHand']]) {
    const a = J[up], b = J[lo], c = J[hd];
    const l1 = len(sub(b, a)), l2 = len(sub(c, b)), total = l1 + l2;
    const along = (t) => (t * total <= l1 ? { p: lerp3(a, b, (t * total) / l1), n: norm(sub(b, a)) } : { p: lerp3(b, c, (t * total - l1) / l2), n: norm(sub(c, b)) });
    const cutArm = (t) => {
      const { p, n } = along(t);
      const v = norm(sub(Z, [n[0] * n[2], n[1] * n[2], n[2] * n[2]])); // front, square to the arm
      const u = cross(v, n);                                             // up-ish, square to both
      return section(body, tris, p, n, dot(u, Y) < 0 ? [-u[0], -u[1], -u[2]] : u, v);
    };
    const pick = (t0, t1, better) => { let best = null; for (let t = t0; t <= t1 + 1e-9; t += 0.01) { const s = cutArm(t); if (ok(s) && (!best || better(s.girth, best.s.girth))) best = { t, s }; } return best; };
    // upper arm: half-way from the shoulder joint to the elbow, as a tape is taken
    const upperArm = { t: 0.5 * (l1 / total) }; upperArm.s = cutArm(upperArm.t);
    const forearm = pick(l1 / total + 0.03, l1 / total + 0.5 * (l2 / total), max);
    const wrist = pick(1 - 0.12 * (l2 / total), 0.995, min);
    put(`upperArm${side}`, `arm${side}`, 'arm', upperArm.t, upperArm.s);
    put(`elbow${side}`, `arm${side}`, 'arm', l1 / total, cutArm(l1 / total));
    put(`forearm${side}`, `arm${side}`, 'arm', forearm?.t ?? 0, forearm?.s);
    put(`wrist${side}`, `arm${side}`, 'arm', wrist?.t ?? 0, wrist?.s);
  }

  // lengths
  let top = -Infinity, ground = Infinity;
  for (let i = 1; i < body.verts.length; i += 3) { top = Math.max(top, body.verts[i]); ground = Math.min(ground, body.verts[i]); }
  const armLen = (s) => len(sub(J[`${s}LowerArm`], J[`${s}UpperArm`])) + len(sub(J[`${s}Hand`], J[`${s}LowerArm`]));
  // shoulder breadth: the torso skin's width just under the shoulder joints
  const sb = horiz(torso, shoulder - 0.01);
  // heights from the floor the bare feet would stand on: a figure in shoes has its lift taken out (barefoot)
  const lift = shoeLift(J, ground);
  if (lift) ground = lift;
  const lengths = {
    stature: round(top - ground), ground: round(ground), ...(lift ? { lift: round(lift) } : {}),
    shoulderJoints: round(len(sub(J.leftUpperArm, J.rightUpperArm))),
    shoulderBreadth: ok(sb) ? round(sb.width) : null,
    armL: round(armLen('left')), armR: round(armLen('right')),
    upperArmL: round(len(sub(J.leftLowerArm, J.leftUpperArm))), upperArmR: round(len(sub(J.rightLowerArm, J.rightUpperArm))),
    torso: round(neckY - pelvis),
    backWaist: waist ? round(neckY - waist.y) : null, waistToHip: waist && hip ? round(waist.y - hip.y) : null,
    crotchHeight: round(crotch - ground), kneeHeight: round(knee - ground), ankleHeight: round(ankle - ground),
    legL: round(len(sub(J.leftLowerLeg, J.leftUpperLeg)) + len(sub(J.leftFoot, J.leftLowerLeg))),
    legR: round(len(sub(J.rightLowerLeg, J.rightUpperLeg)) + len(sub(J.rightFoot, J.rightLowerLeg))),
    thigh: round(thighLen),
  };
  // the VRM T-pose has the arms out along X (tpose.md definition 1.4); an arm pointing well away from
  // X (an A-pose) would have its stations cut at the wrong angle
  const warnings = [];
  for (const s of ['left', 'right']) {
    const dir = norm(sub(J[`${s}LowerArm`], J[`${s}UpperArm`]));
    const deg = (Math.acos(Math.min(1, Math.abs(dir[0]))) * 180) / Math.PI;
    if (deg > T_POSE_TOLERANCE) warnings.push(`the ${s} upper arm points ${deg.toFixed(0)}° away from the T-pose (along X): not a T-pose`);
  }
  const jointsOut = Object.fromEntries(Object.entries(J).filter(([k]) => SEGMENT_OF[k] && k !== 'leftEye' && k !== 'rightEye').map(([k, p]) => [k, p.map((q) => round(q))]));
  return {
    format: 'vrm-body-measurements', version: MEASURE_VERSION, units: 'm',
    frame: { up: '+Y', forward: '+Z', turned: body.fwd === -1, profileAngles: PROFILE_N, profileZero: '+X (the model’s left); 90° = front' },
    joints: jointsOut, lengths, stations, missing, warnings,
  };
}

/** A station by id. */
export const stationOf = (m, id) => m?.stations?.find((s) => s.id === id) || null;
