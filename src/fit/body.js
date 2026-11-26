// A body as Spec-fit sees it (FITTING.md §4, §5.1–§5.3): its skin, its measurements, and for each
// segment a stack of cross-sections running along it, so any point near the body can be given its
// fit coordinates (s, θ, e) and any (s, θ, e) turned back into a point. DOM-free.
//
// The stations of §4 are the anchors of each stack: s = k at the k-th station, counted from the
// segment's end joint (torso: the crotch; legs: the hip joint; arms: the shoulder joint), which is
// s = 0, to the far joint (the head joint; the foot; the hand), the last s. Between two anchors the
// skin is cut again at three evenly spaced heights (SUB − 1 sub-sections), so R(s, θ) is the skin's
// own radius there rather than a straight line between two stations' profiles: the shoulders sit
// between the bust and the neck base, and a line from one to the other would put them inside the
// skin (SPEC-QUESTIONS #47). On Spec → Spec nothing changes either way: the same cuts on both sides.
//
// A cut counts when skin goes most of the way round, as the measurer's own rule (§4.1 step 6). A
// station the measurer refused (skin cut away under clothes) is estimated from Spec's (§5.2): its
// height in proportion between the nearest anchors, its profile Spec's scaled by the girth ratio of
// the nearest measured stations (interpolated in s) and, across, by the shoulder or hip breadth
// ratio. Such stations, and sub-sections that were filled in rather than cut, are flagged `est`;
// garments over them take the `relaxed` rule (§5.2, §5.4).

import { readAccessor } from '../glb.js';
import { invert, parents } from '../math.js';
import { section, PROFILE_N, MIN_COVERAGE, measureBody, humanBones } from '../measure/bodyMeasure.js';
import { vroidMaterial, guessDonorParts, partSets } from '../measure/donorParts.js';
import { vertexNormals, makeSurface } from './geom.js';

export const SUB = 4; // sub-intervals between two anchors (FITTING.md §5.1, refined: SPEC-QUESTIONS #47)
const TWO_PI = Math.PI * 2;

export const SEGMENT_OF = {
  hips: 'torso', spine: 'torso', chest: 'torso', upperChest: 'torso', neck: 'torso',
  leftShoulder: 'torso', rightShoulder: 'torso',
  head: 'other', leftEye: 'other', rightEye: 'other', jaw: 'other',
  leftUpperArm: 'armL', leftLowerArm: 'armL', leftHand: 'armL',
  rightUpperArm: 'armR', rightLowerArm: 'armR', rightHand: 'armR',
  leftUpperLeg: 'legL', leftLowerLeg: 'legL', leftFoot: 'legL', leftToes: 'legL',
  rightUpperLeg: 'legR', rightLowerLeg: 'legR', rightFoot: 'legR', rightToes: 'legR',
};
/** The fitting zone of a humanoid bone: torso, armL, armR, legL, legR, or other (head; not fitted). */
export const zoneOfBone = (b) => SEGMENT_OF[b] || (/^left.*(Thumb|Index|Middle|Ring|Little)/.test(b) ? 'armL'
  : /^right.*(Thumb|Index|Middle|Ring|Little)/.test(b) ? 'armR' : 'other');
export const ZONES = Object.freeze(['torso', 'armL', 'armR', 'legL', 'legR', 'other']);
export const ZONE_INDEX = Object.freeze(Object.fromEntries(ZONES.map((z, i) => [z, i])));
const MEASURE_LABEL = { torso: 'torso', armL: 'armL', armR: 'armR', legL: 'legL', legR: 'legR', other: 'head' };

// ---- reading a body's skin, with its weights -------------------------------------------------------

function bodyMaterials(json, bin, given, base = null) {
  if (given?.size) return given;
  const out = new Set();
  (json.materials || []).forEach((m, i) => { if (vroidMaterial(m.name || '')?.role === 'body') out.add(i); });
  if (out.size) return out;
  // not named the VRoid way: by shape against Spec when it is given, else by the names
  const sets = partSets(guessDonorParts(json, bin, base ? { base } : {}).parts);
  for (const i of [...sets.bodyMats, ...sets.skinMats]) out.add(i);
  return out;
}

/**
 * The body skin of a VRM 1.0 (glTF json + bin) in bind space, as the measurer reads it (same vertices,
 * same order, same labels), with each vertex's skin and weights kept so it can be moved by a shaped
 * skeleton. → { verts, label, tris ([[a, b, c]]), joints ({ bone: [x, y, z] }), fwd, skin: { node:
 * Int32Array (4 per vertex, node indices), weight: Float32Array (4 per vertex) } }
 */
export function readSkin(json, bin, { bodyMats, base } = {}) {
  if (!json.extensions?.VRMC_vrm) throw new Error('Spec-fit reads VRM 1.0 bodies (a VRM 0.x is converted first)');
  const bones = humanBones(json);
  const boneOfNode = new Map(Object.entries(bones).map(([k, n]) => [n, k]));
  const par = parents(json.nodes || []);
  const humanOf = (node) => { for (let n = node; n != null; n = par.get(n)) if (boneOfNode.has(n)) return boneOfNode.get(n); return null; };
  const joints = {};
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices == null) continue;
    const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((node, j) => {
      const bone = boneOfNode.get(node);
      if (!bone || joints[bone]) return;
      const inv = invert(Array.from(ibm.slice(j * 16, j * 16 + 16)));
      if (inv) joints[bone] = [inv[12], inv[13], inv[14]];
    });
  }
  const mats = bodyMaterials(json, bin, bodyMats, base);
  const verts = [], label = [], tris = [], nodes = [], weights = [];
  const seen = new Map();
  (json.meshes || []).forEach((mesh, mi) => {
    const holder = (json.nodes || []).find((n) => n.mesh === mi && n.skin != null);
    const skin = holder ? json.skins[holder.skin] : null;
    for (const p of mesh.primitives) {
      if (!mats.has(p.material) || p.indices == null || !skin) continue;
      const a = p.attributes;
      if (a.POSITION == null || a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
      const pos = readAccessor(json, bin, a.POSITION), jn = readAccessor(json, bin, a.JOINTS_0), wt = readAccessor(json, bin, a.WEIGHTS_0);
      const wa = json.accessors[a.WEIGHTS_0];
      const norm = wa.normalized ? (wa.componentType === 5121 ? 255 : 65535) : 1;
      const idx = readAccessor(json, bin, p.indices);
      const our = (i) => {
        const key = `${a.POSITION}:${i}`;
        if (seen.has(key)) return seen.get(key);
        let best = -1, bw = -1;
        for (let k = 0; k < 4; k++) if (wt[i * 4 + k] > bw) { bw = wt[i * 4 + k]; best = jn[i * 4 + k]; }
        const bone = humanOf(skin.joints[best]);
        verts.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        const z = bone ? zoneOfBone(bone) : 'other';
        label.push(MEASURE_LABEL[z] || 'other');
        for (let k = 0; k < 4; k++) { nodes.push(skin.joints[jn[i * 4 + k]] ?? 0); weights.push(wt[i * 4 + k] / norm); }
        seen.set(key, label.length - 1);
        return label.length - 1;
      };
      for (let t = 0; t + 2 < idx.length; t += 3) tris.push([our(idx[t]), our(idx[t + 1]), our(idx[t + 2])]);
    }
  });
  return { verts: Float32Array.from(verts), label, tris, joints, fwd: 1, skin: { node: Int32Array.from(nodes), weight: Float32Array.from(weights) } };
}

// ---- the stacks --------------------------------------------------------------------------------------

const TORSO = ['hip', 'highHip', 'waist', 'underbust', 'bust', 'neckBase', 'neck'];
const LEG = ['thigh', 'knee', 'calf', 'ankle'];
const ARM = ['upperArm', 'elbow', 'forearm', 'wrist'];

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// the radius of a closed polygon (points around the origin) toward angle th
function polyRadius(pts, th) {
  const dx = Math.cos(th), dy = Math.sin(th);
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (a[0] * ey - a[1] * ex) / den, s = (a[0] * dy - a[1] * dx) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.max(best, t);
  }
  return best;
}

// the arm's frame at a point along it, as the measurer cuts arms (square to the bone; u up-ish, v front)
function armFrame(nAxis) {
  const v = norm3(sub3(Z, [nAxis[0] * nAxis[2], nAxis[1] * nAxis[2], nAxis[2] * nAxis[2]]));
  let u = cross3(v, nAxis);
  if (dot3(u, Y) < 0) u = [-u[0], -u[1], -u[2]];
  return { u, v, n: nAxis };
}

/** The axis of a segment: where along it (h) is the origin, and the cut's frame there. */
function makeAxis(kind, J, side) {
  if (kind === 'torso' || kind === 'leg') {
    const x0 = kind === 'torso' ? (J.leftUpperLeg[0] + J.rightUpperLeg[0]) / 2 : J[`${side}UpperLeg`][0];
    return { kind: 'y', x0, at: (h) => ({ o: [x0, h, 0], u: X, v: Z, n: Y }) };
  }
  const a = J[`${side}UpperArm`], b = J[`${side}LowerArm`], c = J[`${side}Hand`];
  const l1 = len3(sub3(b, a)), l2 = len3(sub3(c, b)), total = l1 + l2;
  const n1 = norm3(sub3(b, a)), n2 = norm3(sub3(c, b));
  const f1 = armFrame(n1), f2 = armFrame(n2);
  return {
    kind: 'arm', a, b, c, l1, l2, total, n1, n2,
    at(t) {
      const d = t * total;
      if (d <= l1) return { o: [a[0] + n1[0] * d, a[1] + n1[1] * d, a[2] + n1[2] * d], ...f1 };
      const e = d - l1;
      return { o: [b[0] + n2[0] * e, b[1] + n2[1] * e, b[2] + n2[2] * e], ...f2 };
    },
    // a point's place along the arm: t (0 shoulder joint … 1 hand joint; beyond, extended)
    tOf(p) {
      const ap = sub3(p, a), bp = sub3(p, b);
      const d1 = dot3(ap, n1), d2 = dot3(bp, n2);
      // which bone's stretch is it nearer: square distance to each (extended) line, the upper arm up to the elbow
      const r1 = len3(sub3(ap, [n1[0] * d1, n1[1] * d1, n1[2] * d1]));
      const r2 = len3(sub3(bp, [n2[0] * d2, n2[1] * d2, n2[2] * d2]));
      if (d1 <= l1 && (d2 < 0 || r1 <= r2)) return d1 / total;
      return (l1 + d2) / total;
    },
  };
}

/**
 * Build a body's fitting context. body: readSkin's (or readBody's) object; m: its measurements
 * (measureBody); ref: Spec's context, for estimating stations this body is missing (§5.2).
 * → { m, body, skin (surface), segments: { torso, legL, legR, armL, armR }, refused, estimated: [ids], warnings }
 */
export function bodyContext(body, m, { ref = null, cell = 0.01 } = {}) {
  const J = body.joints;
  const warnings = [];
  const notT = (m.warnings || []).filter((w) => /not a T-pose/.test(w));
  const refused = notT.length ? `the body is not in a T-pose (${notT.join('; ')}): it has to be posed before it can be fitted (FITTING.md §9)` : null;
  const flatTris = Int32Array.from(body.tris.flat());
  const normals = vertexNormals(body.verts, flatTris);
  const skin = makeSurface(body.verts, flatTris, { normals, cell });
  const ctx = { m, body, skin, segments: {}, refused, estimated: [], warnings };
  if (refused) return ctx;
  const station = (id) => m.stations.find((s) => s.id === id) || null;
  const ground = m.lengths?.ground ?? 0;
  const bySeg = (labels) => body.tris.filter((t) => t.every((i) => labels.includes(body.label[i])));
  const torsoTris = bySeg(['torso']);
  const trunkTris = bySeg(['torso', 'legL', 'legR']);
  const bin = (tris) => { // triangles bucketed by height (1 cm), for cutting only what can be cut
    const b = new Map();
    for (const t of tris) {
      let lo = Infinity, hi = -Infinity;
      for (const i of t) { const y = body.verts[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
      for (let k = Math.floor(lo * 100); k <= Math.floor(hi * 100); k++) { let l = b.get(k); if (!l) b.set(k, (l = [])); l.push(t); }
    }
    return (y) => b.get(Math.floor(y * 100)) || [];
  };
  const shoulderBreadth = m.lengths?.shoulderBreadth;
  const defs = [
    { id: 'torso', kind: 'torso', ids: TORSO, ends: [m.lengths.crotchHeight + ground, J.head[1]],
      tris: (s, waistS) => (s < waistS ? trunkTris : torsoTris), binned: { trunk: bin(trunkTris), torso: bin(torsoTris) } },
    ...['L', 'R'].map((side) => {
      const s = side === 'L' ? 'left' : 'right';
      const tris = bySeg([`leg${side}`]);
      return { id: `leg${side}`, kind: 'leg', side: s, ids: LEG.map((x) => x + side), ends: [J[`${s}UpperLeg`][1], J[`${s}Foot`][1]], tris: () => tris, binned: { all: bin(tris) } };
    }),
    ...['L', 'R'].map((side) => {
      const s = side === 'L' ? 'left' : 'right';
      const tris = bySeg([`arm${side}`]);
      return { id: `arm${side}`, kind: 'arm', side: s, ids: ARM.map((x) => x + side), ends: [0, 1], tris: () => tris };
    }),
  ];
  for (const d of defs) {
    const axis = makeAxis(d.kind, J, d.side);
    // anchors: the end joints and the stations, measured or (with Spec) estimated
    const anchors = [{ id: 'end0', h: d.ends[0], end: true }];
    for (const id of d.ids) {
      const st = station(id);
      if (st) anchors.push({ id, h: st.at, girth: st.girth });
      else anchors.push({ id, h: null, missing: true });
    }
    anchors.push({ id: 'end1', h: d.ends[1], end: true });
    // arms' upper arm and elbow are at fixed places along the arm, measured or not
    if (d.kind === 'arm') {
      const t1 = axis.l1 / axis.total;
      for (const an of anchors) {
        if (an.id.startsWith('upperArm') && an.h == null) an.h = 0.5 * t1;
        if (an.id.startsWith('elbow') && an.h == null) an.h = t1;
      }
    }
    const rseg = ref?.segments?.[d.id];
    // heights of missing stations: in proportion between the nearest anchors that have one, as on Spec
    for (let k = 0; k < anchors.length; k++) {
      if (anchors[k].h != null) continue;
      let lo = k - 1; while (lo > 0 && anchors[lo].h == null) lo--;
      let hi = k + 1; while (hi < anchors.length - 1 && anchors[hi].h == null) hi++;
      const rh = (i) => rseg?.anchors?.[i]?.h;
      const f = rseg && rh(hi) !== rh(lo) ? (rh(k) - rh(lo)) / (rh(hi) - rh(lo)) : (k - lo) / (hi - lo);
      anchors[k].h = anchors[lo].h + (anchors[hi].h - anchors[lo].h) * f;
    }
    // keep h strictly monotone (an estimated station can't land on another)
    const dir = Math.sign(anchors[anchors.length - 1].h - anchors[0].h) || 1;
    for (let k = 1; k < anchors.length; k++) if ((anchors[k].h - anchors[k - 1].h) * dir < 1e-4) anchors[k].h = anchors[k - 1].h + dir * 1e-4;
    const waistS = d.kind === 'torso' ? (anchors.findIndex((a) => a.id === 'waist')) : -1;
    // the slices: every anchor, SUB − 1 cuts between each two
    const slices = [];
    for (let k = 0; k < anchors.length; k++) {
      const steps = k === anchors.length - 1 ? 1 : SUB;
      for (let j = 0; j < steps; j++) {
        const s = k + j / SUB;
        const h = j === 0 ? anchors[k].h : anchors[k].h + (anchors[k + 1].h - anchors[k].h) * (j / SUB);
        const fr = axis.at(h);
        const anchor = j === 0 ? anchors[k] : null;
        let cut = null;
        if (!(anchor?.missing)) {
          let tris;
          if (d.kind === 'arm') tris = d.tris();
          else if (d.kind === 'torso') tris = (s < waistS ? d.binned.trunk : d.binned.torso)(h);
          else tris = d.binned.all(h);
          cut = tris.length ? section(body, tris, fr.o, fr.n, fr.u, fr.v) : null;
        }
        const ok = !!cut && cut.coverage >= MIN_COVERAGE;
        const sl = { s, h, ok, est: false, anchor: anchor?.id || null, end: !!anchor?.end, girth: 0, c: [0, 0], prof: new Float64Array(PROFILE_N) };
        if (ok) {
          const dc = sub3(cut.center, fr.o);
          sl.c = [dot3(dc, fr.u), dot3(dc, fr.v)];
          sl.prof.set(cut.profile);
          sl.girth = cut.girth;
        }
        slices.push(sl);
      }
    }
    // stations the measurer refused: estimated from Spec's by the girth ratio of the measured ones (§5.2)
    if (rseg) {
      const ratioAt = (k) => { const sl = slices[k * SUB]; const rs = rseg.slices[k * SUB]; return sl.ok && rs?.ok && rs.girth > 0 ? sl.girth / rs.girth : null; };
      for (let k = 1; k < anchors.length - 1; k++) {
        const sl = slices[k * SUB];
        if (sl.ok) continue;
        let lo = k - 1; while (lo > 0 && ratioAt(lo) == null) lo--;
        let hi = k + 1; while (hi < anchors.length - 1 && ratioAt(hi) == null) hi++;
        const rl = ratioAt(lo), rh = ratioAt(hi);
        let kg = rl != null && rh != null ? rl + (rh - rl) * ((k - lo) / (hi - lo)) : (rl ?? rh);
        if (kg == null) kg = (m.lengths.stature || 1) / (ref.m.lengths.stature || 1);
        let kw = kg;
        if (d.kind === 'torso') {
          const above = k >= waistS;
          const rb = above ? ref.m.lengths?.shoulderBreadth : ref.m.stations.find((x) => x.id === 'hip')?.width;
          const tb = above ? shoulderBreadth : station('hip')?.width;
          if (rb > 0 && tb > 0) kw = tb / rb;
        }
        const kd = Math.max(0.3 * kg, 2 * kg - kw);
        const rs = rseg.slices[k * SUB];
        const pts = Array.from(rs.prof, (r, i) => { const th = (TWO_PI * i) / PROFILE_N; return [r * Math.cos(th) * kw, r * Math.sin(th) * kd]; });
        for (let i = 0; i < PROFILE_N; i++) sl.prof[i] = polyRadius(pts, (TWO_PI * i) / PROFILE_N);
        sl.c = [rs.c[0] * kw, rs.c[1] * kd];
        sl.girth = rs.girth * kg;
        sl.ok = true;
        sl.est = true;
        ctx.estimated.push(anchors[k].id);
      }
    }
    // anything still not cut: filled in from the nearest cut slices (interpolated in s; clamped at the ends)
    const okIdx = slices.map((x, i) => (x.ok ? i : -1)).filter((i) => i >= 0);
    if (!okIdx.length) { warnings.push(`${d.id}: no skin to fit to`); ctx.segments[d.id] = null; continue; }
    const firstAnchor = SUB, lastAnchor = (anchors.length - 2) * SUB;
    for (let i = 0; i < slices.length; i++) {
      const sl = slices[i];
      if (sl.ok) continue;
      let lo = -1, hi = -1;
      for (const k of okIdx) { if (k < i) lo = k; if (k > i && hi < 0) hi = k; }
      const A = slices[lo >= 0 ? lo : hi], B = slices[hi >= 0 ? hi : lo];
      const f = lo >= 0 && hi >= 0 ? (i - lo) / (hi - lo) : 0;
      for (let q = 0; q < PROFILE_N; q++) sl.prof[q] = A.prof[q] + (B.prof[q] - A.prof[q]) * f;
      sl.c = [A.c[0] + (B.c[0] - A.c[0]) * f, A.c[1] + (B.c[1] - A.c[1]) * f];
      sl.girth = A.girth + (B.girth - A.girth) * f;
      sl.filled = true;
      // filled between measured stations: the skin there was cut away, so it's an estimate
      if (i > firstAnchor && i < lastAnchor) sl.est = true;
      if (lo >= 0 && hi >= 0 && (A.est || B.est)) sl.est = true;
    }
    // beyond the end joints, s runs in metres (in t, the arm's own length, for arms): under the torso by the
    // thigh's length, so a skirt below the crotch keeps its share of the thigh (SPEC-QUESTIONS #51)
    const ext = d.kind === 'torso' ? [m.lengths.thigh || 1, 1] : [1, 1];
    ctx.segments[d.id] = { id: d.id, kind: d.kind, axis, anchors, slices, dir, ext, n: slices.length };
  }
  return ctx;
}

/** Measure a body read by readSkin and build its context in one step. → context (with .m), or null. */
export function measuredContext(body, opts = {}) {
  const m = measureBody(null, null, { body });
  if (!m) return null;
  return bodyContext(body, m, opts);
}

// ---- looking things up ---------------------------------------------------------------------------------

/** s of a place h along a segment (height, or t for arms). Beyond the ends it continues linearly. */
export function sOf(seg, h) {
  const sl = seg.slices, n = sl.length, dir = seg.dir;
  if ((h - sl[0].h) * dir <= 0) return ((h - sl[0].h) * dir) / seg.ext[0];
  if ((h - sl[n - 1].h) * dir >= 0) return sl[n - 1].s + ((h - sl[n - 1].h) * dir) / seg.ext[1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((h - sl[mid].h) * dir >= 0) lo = mid; else hi = mid; }
  return sl[lo].s + (h - sl[lo].h) / (sl[hi].h - sl[lo].h) * (sl[hi].s - sl[lo].s);
}

/** The slice interval of s: { i, f (0…1 inside), fx (unclamped, for extrapolating h) } */
function bracket(seg, s) {
  const step = 1 / SUB;
  const n = seg.slices.length;
  let i = Math.floor(s / step + 1e-12);
  if (i < 0) i = 0;
  if (i > n - 2) i = n - 2;
  const fx = (s - seg.slices[i].s) / step;
  return { i, f: Math.min(1, Math.max(0, fx)), fx };
}

/** h at s (height, or t along the arm), extrapolating beyond the ends. */
export function hAt(seg, s) {
  const sl = seg.slices, n = sl.length;
  if (s <= 0) return sl[0].h + s * seg.ext[0] * seg.dir;
  if (s >= sl[n - 1].s) return sl[n - 1].h + (s - sl[n - 1].s) * seg.ext[1] * seg.dir;
  const { i, fx } = bracket(seg, s);
  return sl[i].h + (sl[i + 1].h - sl[i].h) * fx;
}

/** The skin radius at (s, θ): linear in s between slices, wrapping linear in θ. With `floorS`, never less than at that s (skirts). */
export function radiusAt(seg, s, th, floorS = null) {
  const { i, f } = bracket(seg, s);
  const a = seg.slices[i].prof, b = seg.slices[i + 1].prof;
  let x = ((th % TWO_PI) + TWO_PI) % TWO_PI / TWO_PI * PROFILE_N;
  const k0 = Math.floor(x) % PROFILE_N, k1 = (k0 + 1) % PROFILE_N, g = x - Math.floor(x);
  const r0 = a[k0] + (a[k1] - a[k0]) * g, r1 = b[k0] + (b[k1] - b[k0]) * g;
  const r = r0 + (r1 - r0) * f;
  if (floorS != null && s < floorS) return Math.max(r, radiusAt(seg, floorS, th));
  return r;
}

/** The girth at s (for the `relaxed` rule). */
export function girthAt(seg, s, floorS = null) {
  const { i, f } = bracket(seg, s);
  const g = seg.slices[i].girth + (seg.slices[i + 1].girth - seg.slices[i].girth) * f;
  if (floorS != null && s < floorS) return Math.max(g, girthAt(seg, floorS));
  return g;
}

/** The centre offset (in the cut's u, v) at s. */
export function centreAt(seg, s) {
  const { i, f } = bracket(seg, s);
  const a = seg.slices[i].c, b = seg.slices[i + 1].c;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Is s over an estimated slice (either side of it)? */
export function estimatedAt(seg, s) {
  const { i } = bracket(seg, s);
  return seg.slices[i].est || seg.slices[i + 1].est;
}

/** s of an anchor (station) by id, or null. */
export function anchorS(seg, id) {
  const k = seg.anchors.findIndex((a) => a.id === id);
  return k < 0 ? null : k;
}
