// Measuring a clip on a figure: the facts the checker (check.js) and the corrections (correct.js) both
// read. Every number is in the figure's metres and seconds.
//
// Contact: a foot carries weight while its lowest sole point is within CONTACT of the floor (1 cm:
// measured on the starter walks, a swing foot passes 1.3–2.5 cm over the floor) and the figure is on its
// feet (hips at 65 % of their standing height or more, the converter's rule): sitting or lying, the weight
// is not on the feet, and a foot dragged as she falls is not a planted foot sliding. Sliding is measured on
// the point that carries the weight (heel or ball), as how far it wanders from where it was put down:
// a pivot on the heel or a roll from heel to ball is not a slide; sub-millimetre jitter doesn't add up.

import { poseAt, solePoints, facingOf } from './rig.js';
import { SIDES } from './humanoid.js';

export const CONTACT = 0.01;

/**
 * Per frame: the four sole points, the hips, facing (degrees), standing (hips ≥ 65 % of their height),
 * and the pose itself. `offsets` (per frame [x, y, z]) are added to the hips.
 */
export function track(clip, rig, { offsets = null } = {}) {
  const T = { frames: clip.frames, fps: clip.fps, poses: [], soles: [], hips: [], facing: [], standing: [], lowest: [] };
  for (let f = 0; f < clip.frames; f++) {
    const pose = poseAt(clip, rig, f, { hipsOffset: offsets ? offsets[f] : null });
    const soles = solePoints(pose, rig);
    T.poses.push(pose);
    T.soles.push(soles);
    T.hips.push(pose.pos.hips);
    T.facing.push(facingOf(pose));
    T.standing.push(pose.pos.hips[1] / rig.hipsHeight >= 0.65);
    T.lowest.push(Math.min(...soles.map((p) => p.at[1])));
  }
  return T;
}

/** A foot's sole points at frame f, and which is lowest: { pts, low (index), y }. */
export function footAt(T, f, side, ground = 0) {
  const pts = T.soles[f].filter((p) => p.side === side);
  const low = pts.length > 1 && pts[1].at[1] < pts[0].at[1] ? 1 : 0;
  return { pts, low, y: pts.length ? pts[low].at[1] - ground : Infinity };
}

/**
 * Spans in which each foot carries weight, with how far its weight-bearing point slides and its mean
 * velocity over the floor. → [{ side, from, to (frames, inclusive), slide (m), velocity: [vx, vz] (m/s), anchor: [x, y, z] }]
 */
export function contactSpans(T, ground = 0, { minFrames = 3 } = {}) {
  const out = [];
  for (const side of SIDES) {
    let from = -1, pt = -1, anchor = null, far = 0, slide = 0, start = null;
    const close = (to) => {
      slide += far;
      if (from >= 0 && to - from + 1 >= minFrames) {
        const a = start, b = footAt(T, to, side, ground).pts;
        const mid = (p) => [(p[0].at[0] + (p[1] || p[0]).at[0]) / 2, (p[0].at[2] + (p[1] || p[0]).at[2]) / 2];
        const ma = mid(a), mb = mid(b), dt = Math.max(1, to - from) / T.fps;
        const midF = Math.round((from + to) / 2);
        const fm = footAt(T, midF, side, ground);
        out.push({ side, from, to, slide, velocity: [(mb[0] - ma[0]) / dt, (mb[1] - ma[1]) / dt], anchor: fm.pts[fm.low].at.slice() });
      }
      from = -1; pt = -1; far = 0; slide = 0;
    };
    for (let f = 0; f < T.frames; f++) {
      const ft = footAt(T, f, side, ground);
      const on = ft.y < CONTACT && T.standing[f];
      if (!on) { if (from >= 0) close(f - 1); continue; }
      if (from < 0) { from = f; start = ft.pts; }
      const p = ft.pts[ft.low].at;
      if (ft.low !== pt) { slide += far; far = 0; anchor = p; pt = ft.low; }
      far = Math.max(far, Math.hypot(p[0] - anchor[0], p[2] - anchor[2]));
    }
    if (from >= 0) close(T.frames - 1);
  }
  return out.sort((a, b) => a.from - b.from);
}

/**
 * Does the clip walk on the spot? An in-place locomotion clip's planted feet all move the same way over
 * the floor (a treadmill): their mean velocity is the ground speed. → { moving, speed (m/s), direction (deg,
 * the way the character goes, against its facing), coherence }
 */
export function treadmill(spans, meanFacing = 0) {
  const sp = spans.filter((s) => s.to > s.from);
  if (sp.length < 2) return { moving: false, speed: 0, direction: 0, coherence: 0 };
  const mv = [0, 0];
  let ms = 0;
  for (const s of sp) { mv[0] += s.velocity[0] / sp.length; mv[1] += s.velocity[1] / sp.length; ms += Math.hypot(...s.velocity) / sp.length; }
  const speed = Math.hypot(...mv), coherence = ms ? speed / ms : 0;
  // the feet move backwards under a character going forwards: its way is the opposite of the feet's
  const heading = (Math.atan2(-mv[0], -mv[1]) * 180) / Math.PI;
  let direction = heading - meanFacing;
  direction = ((((direction + 180) % 360) + 360) % 360) - 180;
  return { moving: speed > 0.3 && coherence > 0.8, speed, direction, coherence };
}

/** Joint places with the hips' travel over the floor taken out (height kept): the pose itself, frame by frame. */
export function posePoints(T, { fingers = false } = {}) {
  return T.poses.map((p) => Object.entries(p.pos).filter(([b]) => fingers || !/Thumb|Index|Middle|Ring|Little/.test(b)).map(([, v]) => [v[0] - p.pos.hips[0], v[1], v[2] - p.pos.hips[2]]));
}
const jointMax = (a, b, fn) => { let m = 0; for (let j = 0; j < a.length; j++) m = Math.max(m, fn(j)); return m; };

/**
 * The seam of a loop: the gap between the last and first pose (largest joint move, m), and how abrupt the
 * wrap is against the clip itself: the largest second difference of any joint across the wrap, over the
 * 95th percentile of the clip's own (the last key is the first pose, so the wrap runs …, n−3, n−2,
 * [n−1 = 0], 1). Against the median, a clip that turns its head at the end looked rough everywhere it
 * moved; against the 95th percentile only a wrap rougher than nearly all of the clip stands out.
 * → { gap, roughness, wrap, p95 }
 */
export function seam(T) {
  const P = posePoints(T), n = P.length;
  if (n < 4) return { gap: 0, roughness: 0, wrap: 0, p95: 0 };
  const gap = jointMax(P[0], P[n - 1], (j) => Math.hypot(P[0][j][0] - P[n - 1][j][0], P[0][j][1] - P[n - 1][j][1], P[0][j][2] - P[n - 1][j][2]));
  const d2 = (a, b, c) => jointMax(a, b, (j) => Math.hypot(a[j][0] - 2 * b[j][0] + c[j][0], a[j][1] - 2 * b[j][1] + c[j][1], a[j][2] - 2 * b[j][2] + c[j][2]));
  const inside = [];
  for (let f = 1; f < n - 1; f++) inside.push(d2(P[f + 1], P[f], P[f - 1]));
  inside.sort((a, b) => a - b);
  const p95 = inside[Math.min(inside.length - 1, Math.floor(inside.length * 0.95))] || 1e-9;
  const wrap = Math.max(d2(P[1], P[0], P[n - 2]), d2(P[n - 1], P[n - 2], P[n - 3]));
  return { gap, roughness: wrap / Math.max(p95, 1e-6), wrap, p95 };
}

/** Horizontal travel of the hips: from first to last frame, and the largest distance from where they start (m). */
export function travel(T) {
  const a = T.hips[0], b = T.hips[T.frames - 1];
  let far = 0;
  for (const h of T.hips) far = Math.max(far, Math.hypot(h[0] - a[0], h[2] - a[2]));
  return { net: Math.hypot(b[0] - a[0], b[2] - a[2]), far, vector: [b[0] - a[0], b[2] - a[2]] };
}

/** Mean of angles in degrees (by their unit vectors). */
export function meanDeg(list) {
  let s = 0, c = 0;
  for (const d of list) { s += Math.sin((d * Math.PI) / 180); c += Math.cos((d * Math.PI) / 180); }
  return (Math.atan2(s, c) * 180) / Math.PI;
}

/** Frame ranges (inclusive) where test(f) holds, as [[from, to]]. */
export function ranges(n, test) {
  const out = [];
  let s = -1;
  for (let f = 0; f <= n; f++) {
    const on = f < n && test(f);
    if (on && s < 0) s = f;
    if (!on && s >= 0) { out.push([s, f - 1]); s = -1; }
  }
  return out;
}
