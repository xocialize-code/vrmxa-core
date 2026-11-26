// Corrections (PRD ANI-9 to ANI-12): kept apart from the clip they correct, as a list of operations
// replayed onto the original in order. The original is never changed, so a correction can be changed or
// removed later and the clip made again from it.
//
//   applyCorrections(original, ops, { rig }) → { clip, details (changes to the clip's record), notes, keys }
//
// Every op is plain JSON (stored in the bundle, CLI arguments, probe commands). Times are seconds on the
// clip as it stands when the op runs (after earlier trims and speed changes). An op that solves on a
// figure (feet, floor) carries that figure (`figure`: its leg bones' rest places, scale height, root
// offset and lift), so replaying it later gives the same clip; without one it solves on Spec (`rig`).
//
//   trim        { from, to }                                   keep this range
//   speed       { rate, bake? }                                play `rate` times as fast (resampled); bake: the clip's own
//                                                              `rate` is now in the keys, so the record's rate becomes 1
//   turn        { degrees }                                    turn the whole clip about the vertical, through where it starts
//   loop        { start?, startFacing?, blend? }               rotate the cycle to start at `start` s (or at the frame facing most nearly
//                                                              ahead), and blend the seam over `blend` s, matching the motion's
//                                                              speed at both ends (a Hermite blend, not an ease)
//   ground      { figure }                                     set the clip on the floor again for this figure (shoes included)
//   pinFoot     { foot: left|right|both, from, to, easeIn, easeOut, mode: floor|stand, keepKnee, figure }
//                                                              hold a foot on the floor (floor) or where it stands (stand), leg solved
//   lockFeet    { min, ease, figure }                          pin every planted foot that slides more than `min` m where it stands
//   travel      { mode: remove|fromFeet, figure }              take travel out (and measure ground speed), or put back the travel
//                                                              the planted feet show (the clip then travels)
//   groundSpeed { value? }                                     record ground speed: measured on Spec from the feet, unless given
//   offset      { bone | bones, rotation: [x, y, z] deg, from?, to?, easeIn?, easeOut? }
//                                                              turn bones by this much on top of the motion, over the clip or a range
//   pose        { bone, keys: [{ t, rotation: [x, y, z] }] }   keyed offsets on a bone, eased between keys, held beyond them
//   thin        { from?, to?, tolerance (deg) }                thin dense keys: keep only those a straight line can't replace
//   expression  { name, keys: [{ t, w }] }                     an expression track (linear between keys, held beyond)
//   gaze        { keys: [{ t, yaw, pitch }] }                  a gaze track (degrees; yaw to her left, pitch up)

import { cloneClip, rotAt, hipsAt } from './clip.js';
import { poseAt, solePoints, makeRig } from './rig.js';
import { track, contactSpans, treadmill, meanDeg, travel as travelOf, CONTACT } from './analyse.js';
import { LEG, SIDES, FINGERS, BONES } from './humanoid.js';
import { qmul, qconj, qnorm, qslerp, qrot, qbetween, qeuler, qyaw, qaxis, qnear, qid, sub, add, scale, len, cross, dot, smooth, rad } from './quat.js';

export const OPS = ['trim', 'speed', 'turn', 'loop', 'ground', 'pinFoot', 'lockFeet', 'travel', 'groundSpeed', 'offset', 'pose', 'thin', 'expression', 'gaze'];

/** What a person reads for an op (the timeline's corrections row, the undo list). */
export function opLabel(op) {
  const s = (t) => `${(+t).toFixed(2)} s`;
  switch (op.kind) {
    case 'trim': return `Trimmed to ${s(op.from)}–${s(op.to)}`;
    case 'speed': return op.bake ? `Speed ${op.rate}× baked into the keys` : `Speed ${op.rate}×`;
    case 'turn': return `Turned ${op.degrees > 0 ? '+' : ''}${(+op.degrees).toFixed(1)}°`;
    case 'loop': return `Loop${op.start != null ? ` from ${s(op.start)}` : op.startFacing ? ' from the frame facing ahead' : ''}${op.blend ? `, seam blended over ${s(op.blend)}` : ''}`;
    case 'ground': return `Set on the floor for ${op.figure?.label || 'Spec'}`;
    case 'pinFoot': return `${op.foot === 'both' ? 'Both feet' : op.foot === 'left' ? 'Left foot' : 'Right foot'} pinned ${op.mode === 'floor' ? 'to the floor' : 'where it stands'}`;
    case 'lockFeet': return 'Feet locked where they stand';
    case 'travel': return op.mode === 'remove' ? 'Travel removed' : 'Travel kept from the feet';
    case 'groundSpeed': return op.value != null ? `Ground speed ${(+op.value).toFixed(2)} m/s` : 'Ground speed measured';
    case 'offset': return `${op.label || op.bone || (op.bones || []).join(', ')}, offset`;
    case 'pose': return `${op.bone}, ${op.keys?.length || 0} key${op.keys?.length === 1 ? '' : 's'}`;
    case 'thin': return `Keys thinned (${op.tolerance ?? 0.5}°)`;
    case 'expression': return `Expression "${op.name}"`;
    case 'gaze': return 'Gaze';
    default: return op.kind;
  }
}

/** Where an op sits on the timeline: { from, to } seconds, or null for the whole clip. */
export function opRange(op) {
  if (op.from != null && op.to != null && op.kind !== 'trim') return { from: +op.from, to: +op.to };
  if (op.keys?.length) return { from: Math.min(...op.keys.map((k) => +k.t)), to: Math.max(...op.keys.map((k) => +k.t)) };
  return null;
}

/** A figure as a correction stores it: the bones the feet and floor need, rounded to 0.1 mm. */
export function figureOf(rig) {
  const keep = ['hips', ...SIDES.flatMap((s) => Object.values(LEG(s)))];
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  return {
    label: rig.label, lift: r4(rig.lift || 0), ...(rig.bodyLift ? { bodyLift: r4(rig.bodyLift) } : {}), scaleHeight: r4(rig.scaleHeight), ...(rig.of ? { of: { ...rig.of } } : {}),
    restWorld: Object.fromEntries(keep.filter((b) => rig.restWorld[b]).map((b) => [b, rig.restWorld[b].map(r4)])),
  };
}
const rigOf = (figure, rig) => (figure?.restWorld ? makeRig(figure.restWorld, { scaleHeight: figure.scaleHeight, lift: figure.lift || 0, label: figure.label || 'figure' }) : rig);

// ---- helpers on dense tracks -------------------------------------------------------------------------
const frameOf = (clip, t) => Math.max(0, Math.min(clip.frames - 1, Math.round(+t * clip.fps)));
function setRot(clip, bone, f, q) {
  if (!clip.bones[bone]) { clip.bones[bone] = new Float32Array(clip.frames * 4); for (let i = 0; i < clip.frames; i++) clip.bones[bone][i * 4 + 3] = 1; }
  const prev = f > 0 ? rotAt(clip, bone, f - 1) : q;
  clip.bones[bone].set(qnear(qnorm(q), prev), f * 4);
}
function ensureHips(clip) {
  if (!clip.hips) { clip.hips = new Float32Array(clip.frames * 3); for (let f = 0; f < clip.frames; f++) clip.hips.set(clip.restHips, f * 3); }
}
// resample every track at the given (fractional) source frames
function resample(clip, at) {
  const out = { ...clip, frames: at.length, duration: (at.length - 1) / clip.fps, bones: {}, expressions: {} };
  const lerpF = (arr, n, x) => {
    const i = Math.max(0, Math.min(clip.frames - 1, Math.floor(x))), j = Math.min(clip.frames - 1, i + 1), u = Math.max(0, Math.min(1, x - i));
    if (n === 4) return qslerp(Array.from(arr.subarray(i * 4, i * 4 + 4)), Array.from(arr.subarray(j * 4, j * 4 + 4)), u);
    const r = [];
    for (let c = 0; c < n; c++) r.push(arr[i * n + c] + (arr[j * n + c] - arr[i * n + c]) * u);
    return r;
  };
  for (const [b, arr] of Object.entries(clip.bones)) { const o = new Float32Array(at.length * 4); at.forEach((x, f) => o.set(lerpF(arr, 4, x), f * 4)); out.bones[b] = o; }
  if (clip.hips) { const o = new Float32Array(at.length * 3); at.forEach((x, f) => o.set(lerpF(clip.hips, 3, x), f * 3)); out.hips = o; }
  for (const [e, arr] of Object.entries(clip.expressions)) { const o = new Float32Array(at.length); at.forEach((x, f) => { o[f] = lerpF(arr, 1, x)[0]; }); out.expressions[e] = o; }
  if (clip.lookAt) { const o = new Float32Array(at.length * 4); at.forEach((x, f) => o.set(lerpF(clip.lookAt, 4, x), f * 4)); out.lookAt = o; }
  return out;
}
// a weight over frames: 1 inside [a, b], eased to 0 over easeIn before and easeOut after (frames)
function rangeWeight(f, a, b, ein, eout) {
  if (f >= a && f <= b) return 1;
  if (f < a) return ein > 0 ? smooth(1 - (a - f) / ein) : 0;
  return eout > 0 ? smooth(1 - (f - b) / eout) : 0;
}
// log and exp of unit quaternions (rotation vectors), for blending angular motion
function qlog(q) {
  const qq = q[3] < 0 ? q.map((v) => -v) : q;
  const s = Math.hypot(qq[0], qq[1], qq[2]);
  if (s < 1e-9) return [qq[0] * 2, qq[1] * 2, qq[2] * 2];
  const a = 2 * Math.atan2(s, qq[3]);
  return [(qq[0] / s) * a, (qq[1] / s) * a, (qq[2] / s) * a];
}
function qexp(v) {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return qnorm([v[0] / 2, v[1] / 2, v[2] / 2, 1]);
  const s = Math.sin(a / 2) / a;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}
const hermite = (t) => [2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2];

// ---- two-bone leg IK on the normalized skeleton ---------------------------------------------------------------
/**
 * Move a leg so its ankle reaches `target` (figure space), keeping the knee bending in the plane it bent in
 * and the foot's turn in the world. Writes the upper leg, lower leg and foot rotations of frame f.
 * → how far from the target the ankle ended (m; > 0 when the leg can't reach)
 */
export function solveLeg(clip, rig, f, side, target, pose = poseAt(clip, rig, f)) {
  const L = LEG(side);
  const A = pose.pos[L.upper], B = pose.pos[L.lower], C = pose.pos[L.foot];
  if (!A || !B || !C) return 0;
  const a = len(sub(B, A)), b = len(sub(C, B));
  const toT = sub(target, A);
  const d0 = len(toT);
  const d = Math.min(Math.max(d0, Math.abs(a - b) + 1e-4), a + b - 1e-4);
  const u = scale(toT, 1 / (d0 || 1));
  // the bend plane: the knee's side of the hip–ankle line; a straight leg bends forward (+Z of the hips)
  let side0 = sub(sub(B, A), scale(u, dot(sub(B, A), u)));
  if (len(side0) < 1e-5) side0 = qrot(pose.rot.hips, [0, 0, 1]);
  const v = scale(side0, 1 / len(side0));
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const B2 = add(A, add(scale(u, a * cosA), scale(v, a * sinA)));
  const C2 = add(A, scale(u, d));
  const d1 = qbetween(sub(B, A), sub(B2, A));
  const Wu = qmul(d1, pose.rot[L.upper]);
  const childDir = qrot(d1, sub(C, B));
  const d2 = qbetween(childDir, sub(C2, B2));
  const Wl = qmul(d2, qmul(d1, pose.rot[L.lower]));
  const parentRot = pose.rot.hips; // the upper leg's parent is the hips in VRM's humanoid
  setRot(clip, L.upper, f, qmul(qconj(parentRot), Wu));
  setRot(clip, L.lower, f, qmul(qconj(Wu), Wl));
  setRot(clip, L.foot, f, qmul(qconj(Wl), pose.rot[L.foot]));
  return Math.max(0, d0 - d);
}

const lockPass = (clip, op, ctx) => OPF._lockPass(clip, op, ctx);

// ---- the ops ------------------------------------------------------------------------------------------------------
const OPF = {
  trim(clip, op) {
    const a = frameOf(clip, op.from ?? 0), b = Math.max(a + 1, frameOf(clip, op.to ?? clip.duration));
    return { clip: resample(clip, Array.from({ length: b - a + 1 }, (_, i) => a + i)) };
  },
  speed(clip, op, ctx) {
    const rate = +op.rate;
    if (!(rate > 0.05 && rate < 20)) throw new Error('speed: rate must be between 0.05 and 20');
    const n = Math.max(2, Math.round((clip.frames - 1) / rate) + 1);
    const span = clip.frames - 1;
    // bake: the clip's own rate (VRMXA §8.4 `rate`) goes into the keys and is set to 1; otherwise it is kept
    return { clip: resample(clip, Array.from({ length: n }, (_, i) => Math.min(span, (i * span) / (n - 1)))), details: op.bake ? { rate: 1 } : { rate: ctx.details?.rate ?? 1 } };
  },
  turn(clip, op) {
    const y = qyaw(rad(+op.degrees || 0));
    const out = cloneClip(clip);
    ensureHips(out);
    const o = hipsAt(clip, 0);
    for (let f = 0; f < out.frames; f++) {
      setRot(out, 'hips', f, qmul(y, rotAt(clip, 'hips', f)));
      const h = hipsAt(clip, f), r = qrot(y, [h[0] - o[0], 0, h[2] - o[2]]);
      out.hips.set([o[0] + r[0], h[1], o[2] + r[2]], f * 3);
    }
    if (out.lookAt) { /* gaze is relative to the head: unchanged */ }
    return { clip: out };
  },
  loop(clip, op, ctx) {
    let out = cloneClip(clip);
    const n = out.frames - 1; // the cycle: frames 0..n-1; frame n repeats frame 0
    if (n < 3) return { clip: out };
    let k = op.start != null ? frameOf(out, op.start) % n : 0;
    if (op.startFacing) {
      const T = track(out, ctx.rig);
      const mean = meanDeg(T.facing.slice(0, n));
      let best = 0;
      for (let f = 0; f < n; f++) if (Math.abs(T.facing[f] - mean) < Math.abs(T.facing[best] - mean)) best = f;
      // turn so the cycle faces ahead on average, then start where it faces most nearly that way
      if (Math.abs(mean) > 0.05) out = OPF.turn(out, { degrees: -mean }).clip;
      k = best;
    }
    if (k) {
      const at = Array.from({ length: n + 1 }, (_, i) => (i + k) % n);
      const rolled = resample(out, at);
      // a travelling cycle keeps going: frames that wrapped carry one cycle's travel
      if (out.hips && ctx.details?.rootMotion === 'travel') {
        const d = sub(hipsAt(out, n), hipsAt(out, 0));
        for (let i = 0; i <= n; i++) if (i + k >= n) { const h = hipsAt(rolled, i); rolled.hips.set([h[0] + d[0], h[1], h[2] + d[2]], i * 3); }
      }
      out = rolled;
    }
    // close the cycle exactly: the last key is the first pose
    for (const arr of Object.values(out.bones)) arr.set(arr.subarray(0, 4), n * 4);
    if (out.hips) { const h0 = hipsAt(out, 0), hn = hipsAt(out, n); out.hips.set([hn[0], h0[1], hn[2]], n * 3); }
    for (const arr of Object.values(out.expressions)) arr[n] = arr[0];
    if (out.lookAt) out.lookAt.set(out.lookAt.subarray(0, 4), n * 4);
    const B = Math.round((+op.blend || 0) * out.fps);
    if (B > 0) blendSeam(out, Math.min(B, n - 3), ctx.details?.rootMotion === 'travel');
    return { clip: out, details: { loops: true } };
  },
  ground(clip, op, ctx) {
    const fig = rigOf(op.figure, ctx.rig);
    const S = track(clip, ctx.rig); // where Spec's bare soles touch the floor: there hers should too
    const F = track(clip, fig);
    const n = clip.frames;
    const touch = Array.from({ length: n }, (_, f) => S.standing[f] && Math.abs(S.lowest[f]) < 0.003);
    const want = new Array(n).fill(null);
    for (let f = 0; f < n; f++) if (touch[f]) want[f] = -F.lowest[f];
    // between touching frames (a jump, a step), the correction runs straight across; never under the floor on its feet
    const off = new Array(n).fill(0);
    const known = want.map((w, f) => (w === null ? -1 : f)).filter((f) => f >= 0);
    for (let f = 0; f < n; f++) {
      if (want[f] !== null) { off[f] = want[f]; continue; }
      const p = known.filter((x) => x < f).pop(), q = known.find((x) => x > f);
      off[f] = p === undefined && q === undefined ? 0 : p === undefined ? want[q] : q === undefined ? want[p] : want[p] + ((want[q] - want[p]) * (f - p)) / (q - p);
    }
    // contact frames take the exact correction; the frames between are smoothed so the hips don't jolt
    const sm = off.map((v, f) => { if (want[f] !== null) return v; let s = 0, c = 0; for (let g = f - 2; g <= f + 2; g++) if (g >= 0 && g < n) { s += off[g]; c++; } return s / c; });
    for (let f = 0; f < n; f++) if (F.standing[f]) sm[f] = Math.max(sm[f], -F.lowest[f]);
    const out = cloneClip(clip);
    ensureHips(out);
    const k = fig.scaleHeight / clip.restHips[1];
    for (let f = 0; f < n; f++) out.hips[f * 3 + 1] += sm[f] / k;
    // with both feet down only the lower one touched: plant each step's foot on the floor too, its leg solved,
    // by that step's own distance (constant over the step, eased in and out over 3 frames)
    const F2 = track(out, fig);
    let planted = 0;
    const steps = contactSpans(F2, 0, { minFrames: 2 }).map((sp) => {
      let m = Infinity;
      for (let f = sp.from; f <= sp.to; f++) m = Math.min(m, Math.min(...F2.soles[f].filter((q) => q.side === sp.side).map((q) => q.at[1])));
      return { ...sp, m };
    });
    // in a loop a step held across the seam is one step: the same distance at both ends
    if (ctx.details?.loops) for (const side of SIDES) {
      const a = steps.find((x) => x.side === side && x.from === 0), b = steps.find((x) => x.side === side && x.to === n - 1);
      if (a && b && a !== b) a.m = b.m = Math.min(a.m, b.m);
    }
    for (const sp of steps) {
      const m = sp.m;
      if (Math.abs(m) < 0.001) continue;
      planted++;
      for (let f = Math.max(0, sp.from - 3); f <= Math.min(n - 1, sp.to + 3); f++) {
        const w = rangeWeight(f, sp.from, sp.to, 3, 3);
        const pose = poseAt(out, fig, f);
        const a = pose.pos[LEG(sp.side).foot];
        solveLeg(out, fig, f, sp.side, [a[0], a[1] - m * w, a[2]], pose);
      }
    }
    const lo = Math.min(...sm), hi = Math.max(...sm), cm = (v) => `${Math.abs(v * 100).toFixed(1)} cm`;
    const how = lo >= -5e-4 ? `raised up to ${cm(hi)}` : hi <= 5e-4 ? `lowered up to ${cm(lo)}` : `lowered up to ${cm(lo)} and raised up to ${cm(hi)}`;
    // the figure the floor now holds for (VRMXA §8.4 groundedFor; the bundle operation fills in the base when it isn't known here)
    // lift: the shoes' plus the body's own ground lift (§8.4), not the hips over Spec's (other legs are `edits`)
    const lift = op.figure?.of?.lift ?? ((op.figure?.lift ?? 0) + (op.figure?.bodyLift ?? 0));
    const groundedFor = { base: op.figure?.of?.base ?? null, lift: Math.round(lift * 1e4) / 1e4, edits: op.figure?.of?.edits ?? null };
    return { clip: out, details: { groundedFor }, notes: [`${how} for ${fig.label}${planted ? `; ${planted} step${planted === 1 ? '' : 's'} planted on the floor` : ''}`] };
  },
  pinFoot(clip, op, ctx) {
    const fig = rigOf(op.figure, ctx.rig);
    const out = cloneClip(clip);
    const a = frameOf(out, op.from ?? 0), b = frameOf(out, op.to ?? out.duration);
    const ein = Math.round((op.easeIn ?? 0.1) * out.fps), eout = Math.round((op.easeOut ?? 0.1) * out.fps);
    const sides = op.foot === 'both' ? SIDES : [op.foot || 'left'];
    let miss = 0;
    const hold = {};
    for (const side of sides) {
      const p = poseAt(out, fig, a);
      hold[side] = p.pos[LEG(side).foot].slice();
    }
    for (let f = Math.max(0, a - ein); f <= Math.min(out.frames - 1, b + eout); f++) {
      const w = rangeWeight(f, a, b, ein, eout);
      if (w <= 0) continue;
      for (const side of sides) {
        const pose = poseAt(out, fig, f);
        const ankle = pose.pos[LEG(side).foot];
        const low = Math.min(...solePoints(pose, fig).filter((s) => s.side === side).map((s) => s.at[1]));
        let target;
        if (op.mode === 'stand') target = [hold[side][0], ankle[1] + Math.max(0, -low), hold[side][2]];
        else target = [ankle[0], ankle[1] + Math.max(0, -low), ankle[2]];
        const t = [ankle[0] + (target[0] - ankle[0]) * w, ankle[1] + (target[1] - ankle[1]) * w, ankle[2] + (target[2] - ankle[2]) * w];
        miss = Math.max(miss, solveLeg(out, fig, f, side, t, pose));
      }
    }
    return { clip: out, notes: miss > 0.002 ? [`the leg could not reach by ${(miss * 100).toFixed(1)} cm`] : [] };
  },
  lockFeet(clip, op, ctx) {
    // a held foot can show a slide the first pass didn't (a leg that couldn't reach, a new weight point): up to three passes
    let cur = clip, notes = [], worst = Infinity;
    for (let pass = 0; pass < 3; pass++) {
      const r = lockPass(cur, op, ctx);
      const fig = rigOf(op.figure, ctx.rig);
      const w = contactSpans(track(r.clip, fig)).reduce((m, x) => Math.max(m, x.slide), 0);
      if (w >= worst - 1e-4) break;
      cur = r.clip; worst = w; if (!notes.length) notes = r.notes;
      if (w <= (op.min ?? 0.03) || r.done) break;
    }
    return { clip: cur, notes };
  },
  _lockPass(clip, op, ctx) {
    const fig = rigOf(op.figure, ctx.rig);
    const T = track(clip, fig);
    let spans = contactSpans(T);
    if (treadmill(spans, meanDeg(T.facing)).moving) return { clip, done: true, notes: ['it walks on the spot: the feet move with the ground, so they were not locked (keep the travel first)'] };
    const out = cloneClip(clip);
    const n = clip.frames;
    const loops = !!ctx.details?.loops;
    const ease = Math.max(1, Math.round((op.ease ?? 0.1) * out.fps));
    // the foot is held by its weight-bearing point (heel or ball): when the weight moves to the other
    // point, that point is held from where it then is, so rolling from heel to ball is kept
    const corr = { left: new Array(n).fill(null), right: new Array(n).fill(null) };
    let miss = 0;
    const cyc = loops ? n - 1 : n; // a loop's frames 0..n-2 go round; frame n-1 is frame 0
    const held = { left: new Array(cyc).fill(false), right: new Array(cyc).fill(false) };
    let locked = 0;
    for (const s of spans) {
      if (s.slide <= (op.min ?? 0.03)) continue;
      locked++;
      for (let f = s.from; f <= s.to; f++) held[s.side][loops ? f % cyc : f] = true;
    }
    for (const side of SIDES) {
      const H = held[side];
      if (!H.some(Boolean)) continue;
      // runs of held frames; in a loop a run may go round the seam
      const all = H.every(Boolean);
      let start = 0;
      if (loops && !all) { start = H.findIndex((h, f) => h && !H[(f - 1 + cyc) % cyc]); }
      const seen = new Array(cyc).fill(false);
      for (let i0 = 0; i0 < cyc; i0++) {
        const f0 = loops ? (start + i0) % cyc : i0;
        if (!H[f0] || seen[f0] || (!all && H[(f0 - 1 + cyc) % cyc] && loops && !seen[(f0 - 1 + cyc) % cyc] && i0 !== 0) || (!loops && f0 > 0 && H[f0 - 1])) continue;
        const run = [];
        for (let f = f0; H[f] && !seen[f] && run.length < cyc; f = loops ? (f + 1) % cyc : f + 1) { run.push(f); seen[f] = true; if (!loops && f + 1 >= cyc) break; }
        let pt = -1, anchor = null, shift = [0, 0];
        const sh = [];
        for (const f of [...run, ...(all ? [run[0]] : [])]) {
          const pts = T.soles[f].filter((p) => p.side === side);
          const low = pts[1] && pts[1].at[1] < pts[0].at[1] ? 1 : 0;
          const raw = pts[low].at;
          if (low !== pt) { anchor = [raw[0] + shift[0], raw[2] + shift[1]]; pt = low; }
          shift = [anchor[0] - raw[0], anchor[1] - raw[2]];
          sh.push(shift.slice());
        }
        if (all) { // held all the way round: what the hand-overs added up to is spread over the cycle
          const r = [sh[sh.length - 1][0] - sh[0][0], sh[sh.length - 1][1] - sh[0][1]];
          sh.pop();
          sh.forEach((v, i) => { v[0] -= (r[0] * i) / run.length; v[1] -= (r[1] * i) / run.length; });
        }
        run.forEach((f, i) => { corr[side][f] = sh[i]; });
      }
      if (loops && corr[side][0]) corr[side][n - 1] = corr[side][0].slice();
    }
    for (const side of SIDES) {
      const c = corr[side];
      const w = new Array(n).fill(0), v = new Array(n).fill(null);
      for (let f = 0; f < n; f++) if (c[f]) { w[f] = 1; v[f] = c[f]; }
      // ease in and out of each held run over `ease` frames, from the run's edge value
      for (let f = 0; f < n; f++) {
        if (c[f]) continue;
        let best = null;
        for (let d = 1; d <= ease; d++) {
          for (const g of [f - d, f + d]) {
            const gg = loops ? ((g % (n - 1)) + (n - 1)) % (n - 1) : g;
            if (gg >= 0 && gg < n && c[gg]) { best = { g: gg, d }; break; }
          }
          if (best) break;
        }
        if (best) { w[f] = smooth(1 - best.d / (ease + 1)); v[f] = c[best.g]; }
      }
      if (loops) { w[n - 1] = w[0]; v[n - 1] = v[0]; }
      for (let f = 0; f < n; f++) {
        if (!v[f] || w[f] <= 0) continue;
        const pose = poseAt(out, fig, f);
        const ankle = pose.pos[LEG(side).foot];
        const low = Math.min(...solePoints(pose, fig).filter((p) => p.side === side).map((p) => p.at[1]));
        miss = Math.max(miss, solveLeg(out, fig, f, side, [ankle[0] + v[f][0] * w[f], ankle[1] + Math.max(0, -low) * w[f], ankle[2] + v[f][1] * w[f]], pose));
      }
    }
    return { clip: out, notes: [`${locked} step${locked === 1 ? '' : 's'} locked${miss > 0.005 ? `; a leg could not reach by ${(miss * 100).toFixed(1)} cm` : ''}`] };
  },
  travel(clip, op, ctx) {
    const out = cloneClip(clip);
    ensureHips(out);
    const n = out.frames;
    if (op.mode === 'remove') {
      const tr = travelOf(track(clip, ctx.rig));
      const h0 = hipsAt(clip, 0);
      for (let f = 0; f < n; f++) { out.hips[f * 3] = h0[0]; out.hips[f * 3 + 2] = h0[2]; }
      const speed = clip.duration > 0 ? tr.net / clip.duration : 0;
      return { clip: out, details: { rootMotion: 'inPlace', speed: +speed.toFixed(3) }, notes: [`${(tr.net * 100).toFixed(1)} cm of travel taken out: ${speed.toFixed(2)} m/s`] };
    }
    // fromFeet: the hips travel the opposite way to the planted feet's drift, so the feet stay put
    const fig = rigOf(op.figure, ctx.rig);
    const T = track(clip, fig);
    const k = fig.scaleHeight / clip.restHips[1];
    let acc = [0, 0], last = [0, 0];
    for (let f = 1; f < n; f++) {
      const ds = [];
      for (const side of SIDES) {
        const p0 = T.soles[f - 1].filter((p) => p.side === side), p1 = T.soles[f].filter((p) => p.side === side);
        const i0 = p0[1]?.at[1] < p0[0].at[1] ? 1 : 0, i1 = p1[1]?.at[1] < p1[0].at[1] ? 1 : 0;
        if (p0[i0].at[1] < CONTACT && p1[i1].at[1] < CONTACT) {
          const mid = (p) => [(p[0].at[0] + (p[1] || p[0]).at[0]) / 2, (p[0].at[2] + (p[1] || p[0]).at[2]) / 2];
          const a = mid(p0), b = mid(p1);
          ds.push([b[0] - a[0], b[1] - a[1]]);
        }
      }
      const d = ds.length ? [ds.reduce((s, x) => s + x[0], 0) / ds.length, ds.reduce((s, x) => s + x[1], 0) / ds.length] : last;
      last = d;
      acc = [acc[0] - d[0], acc[1] - d[1]];
      out.hips[f * 3] += acc[0] / k;
      out.hips[f * 3 + 2] += acc[1] / k;
    }
    const dist = Math.hypot(...acc);
    const speed = clip.duration > 0 ? dist / clip.duration : 0;
    return { clip: out, details: { rootMotion: 'travel', speed: +(speed * (ctx.rig.scaleHeight / fig.scaleHeight)).toFixed(3) }, notes: [`travels ${(dist * 100).toFixed(0)} cm: ${speed.toFixed(2)} m/s`] };
  },
  groundSpeed(clip, op, ctx) {
    if (op.value != null) return { clip, details: { speed: +(+op.value).toFixed(3) } };
    const T = track(clip, ctx.rig);
    const tm = treadmill(contactSpans(T), meanDeg(T.facing));
    if (tm.moving) return { clip, details: { speed: +tm.speed.toFixed(3) }, notes: [`${tm.speed.toFixed(2)} m/s on Spec, from the feet`] };
    const tr = travelOf(T);
    const speed = clip.duration > 0 ? tr.net / clip.duration : 0;
    return { clip, details: { speed: +speed.toFixed(3) }, notes: [`${speed.toFixed(2)} m/s on Spec, from the hips`] };
  },
  offset(clip, op) {
    const out = cloneClip(clip);
    const bones = boneList(op);
    const delta = qeuler(op.rotation || [0, 0, 0]);
    const a = op.from != null ? frameOf(out, op.from) : 0, b = op.to != null ? frameOf(out, op.to) : out.frames - 1;
    const ein = Math.round((op.easeIn ?? 0) * out.fps), eout = Math.round((op.easeOut ?? 0) * out.fps);
    for (const bone of bones) for (let f = 0; f < out.frames; f++) {
      const w = rangeWeight(f, a, b, ein, eout);
      if (w > 0) setRot(out, bone, f, qmul(rotAt(clip, bone, f), qslerp(qid(), delta, w)));
    }
    return { clip: out };
  },
  pose(clip, op) {
    const out = cloneClip(clip);
    const keys = [...(op.keys || [])].map((k) => ({ f: +k.t * clip.fps, q: qeuler(k.rotation || [0, 0, 0]) })).sort((x, y) => x.f - y.f);
    if (!keys.length) return { clip: out };
    for (let f = 0; f < out.frames; f++) {
      let q;
      if (f <= keys[0].f) q = keys[0].q;
      else if (f >= keys[keys.length - 1].f) q = keys[keys.length - 1].q;
      else { const i = keys.findIndex((k) => k.f > f) - 1; q = qslerp(keys[i].q, keys[i + 1].q, smooth((f - keys[i].f) / (keys[i + 1].f - keys[i].f))); }
      for (const bone of boneList(op)) setRot(out, bone, f, qmul(rotAt(clip, bone, f), q));
    }
    return { clip: out };
  },
  thin(clip, op) {
    const out = cloneClip(clip);
    const a = op.from != null ? frameOf(out, op.from) : 0, b = op.to != null ? frameOf(out, op.to) : out.frames - 1;
    const tol = rad(op.tolerance ?? 0.5);
    let before = 0, after = 0;
    for (const [bone, arr] of Object.entries(clip.bones)) {
      const kept = reduceKeys(a, b, (f) => Array.from(arr.subarray(f * 4, f * 4 + 4)), tol);
      before += b - a + 1;
      after += kept.length;
      for (let i = 0; i < kept.length - 1; i++) {
        const f0 = kept[i], f1 = kept[i + 1];
        const q0 = rotAt(clip, bone, f0), q1 = rotAt(clip, bone, f1);
        for (let f = f0 + 1; f < f1; f++) setRot(out, bone, f, qslerp(q0, q1, (f - f0) / (f1 - f0)));
      }
    }
    return { clip: out, keys: { before, after }, notes: [`${before} keys → ${after}`] };
  },
  expression(clip, op) {
    const out = cloneClip(clip);
    const keys = [...(op.keys || [])].map((k) => ({ f: +k.t * clip.fps, w: Math.min(1, Math.max(0, +k.w)) })).sort((x, y) => x.f - y.f);
    if (!op.name) throw new Error('expression: a name is needed');
    if (!keys.length) { delete out.expressions[op.name]; return { clip: out }; }
    const w = new Float32Array(out.frames);
    for (let f = 0; f < out.frames; f++) {
      if (f <= keys[0].f) w[f] = keys[0].w;
      else if (f >= keys[keys.length - 1].f) w[f] = keys[keys.length - 1].w;
      else { const i = keys.findIndex((k) => k.f > f) - 1; w[f] = keys[i].w + ((keys[i + 1].w - keys[i].w) * (f - keys[i].f)) / (keys[i + 1].f - keys[i].f); }
    }
    out.expressions[op.name] = w;
    if (op.custom) out.custom.add(op.name);
    return { clip: out, details: { tracksAdd: 'expressions' } };
  },
  gaze(clip, op) {
    const out = cloneClip(clip);
    const keys = [...(op.keys || [])].map((k) => ({ f: +k.t * clip.fps, q: qmul(qyaw(rad(+k.yaw || 0)), qaxis([1, 0, 0], rad(-(+k.pitch || 0)))) })).sort((x, y) => x.f - y.f);
    if (!keys.length) { out.lookAt = null; return { clip: out }; }
    out.lookAt = new Float32Array(out.frames * 4);
    let prev = keys[0].q;
    for (let f = 0; f < out.frames; f++) {
      let q;
      if (f <= keys[0].f) q = keys[0].q;
      else if (f >= keys[keys.length - 1].f) q = keys[keys.length - 1].q;
      else { const i = keys.findIndex((k) => k.f > f) - 1; q = qslerp(keys[i].q, keys[i + 1].q, smooth((f - keys[i].f) / (keys[i + 1].f - keys[i].f))); }
      q = qnear(q, prev); prev = q;
      out.lookAt.set(q, f * 4);
    }
    out.lookAtOffset ||= [0, 0.06, 0];
    return { clip: out, details: { tracksAdd: 'lookAt' } };
  },
};

/** The bones an offset or pose names: `bone`, `bones`, or a group (`fingers`, `fingers.left`, `thumbs`, …). */
export function boneList(op) {
  const list = op.bones || (op.bone ? [op.bone] : []);
  const out = [];
  for (const b of list) {
    if (b === 'fingers') out.push(...FINGERS);
    else if (b === 'fingers.left' || b === 'fingers.right') out.push(...FINGERS.filter((x) => x.startsWith(b.split('.')[1])));
    else if (b === 'thumbs') out.push(...FINGERS.filter((x) => /Thumb/.test(x)));
    else if (BONES.includes(b)) out.push(b);
    else throw new Error(`"${b}" is not a humanoid bone`);
  }
  return [...new Set(out)];
}

// keep the frames a straight line between kept neighbours can't replace within tol (radians)
function reduceKeys(a, b, at, tol) {
  const out = [a];
  let s = a;
  for (let i = a + 2; i <= b; i++) {
    let ok = true;
    const qa = at(s), qb = at(i);
    for (let j = s + 1; j < i && ok; j++) {
      const q = qslerp(qa, qb, (j - s) / (i - s));
      const c = Math.abs(q[0] * at(j)[0] + q[1] * at(j)[1] + q[2] * at(j)[2] + q[3] * at(j)[3]);
      if (2 * Math.acos(Math.min(1, c)) > tol) ok = false;
    }
    if (!ok) { out.push(i - 1); s = i - 1; }
  }
  if (out[out.length - 1] !== b) out.push(b);
  return out;
}

// The seam of a closed cycle (frame n is frame 0), blended over the B frames before it: each track is
// replaced there by a Hermite curve from frame n−B−1 to frame n (= 0) whose ends match the motion's own
// speed (the step before n−B−1, and the step after 0), so it neither stalls nor jerks at the wrap.
function blendSeam(clip, B, travels) {
  const n = clip.frames - 1, s = n - B - 1, span = B + 1;
  const prevOf = (f) => (f - 1 + n) % n;
  for (const arr of Object.values(clip.bones)) {
    const q = (f) => Array.from(arr.subarray(f * 4, f * 4 + 4));
    const qa = q(s), qb = qnear(q(0), qa);
    const r1 = qlog(qmul(qconj(qa), qb));
    const m0 = qlog(qmul(qconj(q(prevOf(s))), qa)).map((v) => v * span);
    const m1 = qlog(qmul(qconj(q(0)), q(1))).map((v) => v * span);
    for (let i = 1; i <= B; i++) {
      const [, h10, h01, h11] = hermite(i / span);
      const r = [0, 1, 2].map((c) => h10 * m0[c] + h01 * r1[c] + h11 * m1[c]);
      arr.set(qnear(qnorm(qmul(qa, qexp(r))), q(s + i - 1)), (s + i) * 4);
    }
  }
  const lin = (get, set, n3) => {
    for (let c = 0; c < n3; c++) {
      const p0 = get(s, c), p1 = get(n, c), m0 = (get(s, c) - get(prevOf(s), c)) * span, m1 = (get(1, c) - get(0, c)) * span;
      for (let i = 1; i <= B; i++) { const [h00, h10, h01, h11] = hermite(i / span); set(s + i, c, h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1); }
    }
  };
  if (clip.hips) {
    // height always; across the floor only when the clip travels (an in-place clip's hips stay put there)
    const comps = travels ? [0, 1, 2] : [1];
    for (const c of comps) lin((f, _c) => clip.hips[f * 3 + c], (f, _c, v) => { clip.hips[f * 3 + c] = v; }, 1);
  }
  for (const arr of Object.values(clip.expressions)) lin((f) => arr[f], (f, _c, v) => { arr[f] = Math.min(1, Math.max(0, v)); }, 1);
}

/**
 * Replay corrections onto the original clip. ctx: { rig (Spec), details (the original's record) }.
 * → { clip, details (the record's changes: loops, rootMotion, speed, duration, tracks), notes: [[opIndex, text]], keys }
 */
export function applyCorrections(original, ops = [], { rig, details = {} } = {}) {
  if (!rig) throw new Error('applyCorrections needs Spec\'s rig');
  let clip = cloneClip(original);
  let rec = {};
  const notes = [];
  let keys = null;
  for (const [i, op] of ops.entries()) {
    if (op.off) continue;
    const fn = OPF[op.kind];
    if (!fn) throw new Error(`correction ${i + 1}: "${op.kind}" is not a correction (${OPS.join(', ')})`);
    const r = fn(clip, op, { rig, details: { ...details, ...rec } });
    clip = r.clip;
    if (r.details) {
      const { tracksAdd, ...d } = r.details;
      rec = { ...rec, ...d };
    }
    if (r.keys) keys = r.keys;
    for (const t of r.notes || []) notes.push([i, t]);
  }
  rec.duration = +clip.duration.toFixed(4);
  return { clip, details: rec, notes, keys };
}
