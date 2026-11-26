// The figure a clip is played on, and playing it there: forward kinematics on the normalized bones, as
// a VRM player does (three-vrm: the clip's normalized rotations over the avatar's own T-pose offsets, the
// hips track multiplied by avatar hips height / the clip's rest hips height).
//
//   rig = { restWorld: { bone: [x, y, z] }   every humanoid bone's place in the T-pose, in the figure's space, the
//                                            floor at y = 0 (with shoes on, the bones stand `lift` higher)
//           scaleHeight,                     the hips height a player scales the hips track by (three-vrm: the
//                                            normalized rest hips; the stage keeps Spec's and raises the figure)
//           rootOffset,                      how far the figure is raised over what the hips track gives it (the
//                                            body's own ground lift and shoes, which the stage puts above the hips)
//           lift,                            the shoes' lift (VRMXW §7.1), for what is reported
//           label }
//
// A sole point (as the converter measured, tools/kimodo-to-vrma) is the spot on the floor straight under
// the ankle or the toe joint in the T-pose, turning with the foot or the toes: four per figure (heel and
// ball of each foot). With shoes on, the bones stand higher, so the same rule finds the shoe's sole.

import { parseGlb } from '../glb.js';
import { BONES, presentParent, SIDES, LEG } from './humanoid.js';
import { qmul, qrot, add, scale } from './quat.js';
import { worldMatrices, rotAt, hipsAt } from './clip.js';

/** A rig from a VRM 1.0's humanoid (its raw bones' places at rest, which VRM 1.0 makes the T-pose), as a player plays it. */
export function rigFromVrm(bytes, { label = 'model' } = {}) {
  const { json } = parseGlb(bytes);
  const human = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (!human) throw new Error('not a VRM 1.0 (no VRMC_vrm humanoid)');
  const { world } = worldMatrices(json);
  const restWorld = {};
  for (const [b, v] of Object.entries(human)) if (Number.isInteger(v?.node)) restWorld[b] = [world[v.node][12], world[v.node][13], world[v.node][14]];
  return makeRig(restWorld, { label });
}

/**
 * A rig from the bones' rest places. The stage's live figure gives them (rest pose, edits and shoes applied),
 * with `scaleHeight` the hips height three-vrm scales the track by (Spec's): the difference is `rootOffset`.
 */
export function makeRig(restWorld, { scaleHeight = null, lift = 0, label = 'figure' } = {}) {
  if (!restWorld.hips) throw new Error('the figure has no hips bone');
  const rw = Object.fromEntries(Object.entries(restWorld).map(([b, v]) => [b, v.slice(0, 3)]));
  const sh = scaleHeight ?? rw.hips[1];
  return { restWorld: rw, scaleHeight: sh, rootOffset: rw.hips[1] - sh, hipsHeight: rw.hips[1], ground: 0, lift, label };
}

/** The clip's own figure (its file's skeleton). */
export function rigFromClip(clip) {
  const restWorld = {};
  const has = new Set(Object.keys(clip.rest));
  for (const b of BONES) {
    if (!has.has(b)) continue;
    const p = presentParent(b, has);
    restWorld[b] = p ? add(restWorld[p], clip.rest[b]) : clip.rest[b].slice();
  }
  return makeRig(restWorld, { label: 'the clip\'s own skeleton' });
}

/** The same figure in shoes that lift it `lift` metres (the stage raises the figure; the soles are the shoes'). */
export function withLift(rig, lift, label = rig.label) {
  const d = lift - (rig.lift || 0);
  const restWorld = Object.fromEntries(Object.entries(rig.restWorld).map(([b, v]) => [b, [v[0], v[1] + d, v[2]]]));
  return { ...rig, restWorld, rootOffset: rig.rootOffset + d, hipsHeight: rig.hipsHeight + d, lift, label, _has: null, _order: null };
}

/**
 * The figure posed at frame f: { pos: { bone: [x, y, z] }, rot: { bone: world quaternion } } for every bone
 * the rig has (a bone the clip doesn't move keeps its T-pose turn). `hipsOffset` ([x, y, z], figure metres)
 * is added to the hips (a grounding correction being tried).
 */
export function poseAt(clip, rig, f, { hipsOffset = null, bones = null } = {}) {
  const has = rig._has || (rig._has = new Set(Object.keys(rig.restWorld)));
  const k = rig.scaleHeight / (clip.restHips[1] || rig.scaleHeight || 1);
  const pos = {}, rot = {};
  const h = hipsAt(clip, f);
  pos.hips = clip.hips === null ? rig.restWorld.hips.slice() : [h[0] * k, h[1] * k + rig.rootOffset, h[2] * k];
  if (hipsOffset) pos.hips = add(pos.hips, hipsOffset);
  rot.hips = rotAt(clip, 'hips', f);
  const order = rig._order || (rig._order = BONES.filter((b) => b !== 'hips' && has.has(b)).map((b) => [b, presentParent(b, has)]));
  for (const [b, p] of order) {
    if (bones && !bones.has(b)) continue;
    if (!pos[p]) continue;
    rot[b] = qmul(rot[p], rotAt(clip, b, f));
    pos[b] = add(pos[p], qrot(rot[p], [rig.restWorld[b][0] - rig.restWorld[p][0], rig.restWorld[b][1] - rig.restWorld[p][1], rig.restWorld[b][2] - rig.restWorld[p][2]]));
  }
  return { pos, rot };
}

/** The four sole points of a pose (left heel, left ball, right heel, right ball): [{ side, at: [x, y, z] }]. */
export function solePoints(pose, rig) {
  const out = [];
  for (const side of SIDES) {
    const L = LEG(side);
    for (const bone of [L.foot, L.toes]) {
      if (!pose.pos[bone]) continue;
      const under = [0, -rig.restWorld[bone][1], 0];
      out.push({ side, bone, at: add(pose.pos[bone], qrot(pose.rot[bone], under)) });
    }
  }
  return out;
}

/**
 * Every frame's facts the checker reads, on one figure: hips place, each foot's lowest sole point, the
 * facing (from the hip line), head height. → { frames, fps, hips: [[x,y,z]], soles: { left: [[x,y,z]], right }, lowest: [y],
 * facing: [deg], standing: [bool] }. The stage makes the same from the live, dressed model (MCP-3: one checker).
 */
export function sampleClip(clip, rig, { hipsOffsets = null } = {}) {
  const S = { frames: clip.frames, fps: clip.fps, hips: [], soles: { left: [], right: [] }, lowest: [], facing: [], standing: [], figure: rig.label, lift: rig.lift };
  const standH = rig.hipsHeight;
  for (let f = 0; f < clip.frames; f++) {
    const pose = poseAt(clip, rig, f, { hipsOffset: hipsOffsets ? hipsOffsets[f] : null });
    S.hips.push(pose.pos.hips);
    const pts = solePoints(pose, rig);
    let low = Infinity;
    for (const side of SIDES) {
      const mine = pts.filter((p) => p.side === side);
      const best = mine.reduce((a, p) => (!a || p.at[1] < a[1] ? p.at : a), null) || [NaN, NaN, NaN];
      S.soles[side].push(best);
      for (const p of mine) low = Math.min(low, p.at[1]);
    }
    S.lowest.push(low);
    S.facing.push(facingOf(pose));
    // on its feet: the hips at 65 % of their standing height or more (the converter's rule)
    S.standing.push(pose.pos.hips[1] / standH >= 0.65);
  }
  return S;
}

/** Which way a pose faces, degrees about +Y (0 = ahead, +Z): square to the line from the right hip to the left. */
export function facingOf(pose) {
  const l = pose.pos.leftUpperLeg, r = pose.pos.rightUpperLeg;
  if (!l || !r) { const f = qrot(pose.rot.hips, [0, 0, 1]); return (Math.atan2(f[0], f[2]) * 180) / Math.PI; }
  const line = [l[0] - r[0], 0, l[2] - r[2]]; // towards the character's left (+X at rest)
  // forward = up × left ... with +X left and +Z front, forward = (−line.z, line.x)… rotate the line by −90° about Y
  return (Math.atan2(-line[2], line[0]) * 180) / Math.PI;
}

export { scale };
