// Mixamo .fbx → a clip (PRD ANI-1). three.js's FBXLoader reads the file (three is used as provided,
// REF-8); the motion is retargeted onto the normalized humanoid by the rule the vrm skill gives
// (references/animation.md, "Mixamo FBX"): for each `mixamorig<Bone>.quaternion` track, with the source
// bone's rest world rotation W and its parent's Wp, every key becomes Wp · q · W⁻¹. Hips positions are
// taken through the hips' parent into world metres (Mixamo works in centimetres). Download from Mixamo as
// FBX with the T-pose as rest ("without skin" is enough).

import { qmul, qconj, qnorm, qnear, qslerp } from './quat.js';
import { BONES, presentParent } from './humanoid.js';

/** Mixamo's bone names → VRM 1.0's. */
export const MIXAMO = {
  Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
};
for (const [S, s] of [['Left', 'left'], ['Right', 'right']]) {
  Object.assign(MIXAMO, {
    [`${S}Shoulder`]: `${s}Shoulder`, [`${S}Arm`]: `${s}UpperArm`, [`${S}ForeArm`]: `${s}LowerArm`, [`${S}Hand`]: `${s}Hand`,
    [`${S}UpLeg`]: `${s}UpperLeg`, [`${S}Leg`]: `${s}LowerLeg`, [`${S}Foot`]: `${s}Foot`, [`${S}ToeBase`]: `${s}Toes`,
    [`${S}HandThumb1`]: `${s}ThumbMetacarpal`, [`${S}HandThumb2`]: `${s}ThumbProximal`, [`${S}HandThumb3`]: `${s}ThumbDistal`,
  });
  for (const [F, f] of [['Index', 'Index'], ['Middle', 'Middle'], ['Ring', 'Ring'], ['Pinky', 'Little']]) {
    Object.assign(MIXAMO, { [`${S}Hand${F}1`]: `${s}${f}Proximal`, [`${S}Hand${F}2`]: `${s}${f}Intermediate`, [`${S}Hand${F}3`]: `${s}${f}Distal` });
  }
}
// "mixamorig:LeftArm", "mixamorigLeftArm" (FBXLoader drops the colon), "mixamorig1:LeftArm" → leftUpperArm
const vrmBone = (nodeName) => MIXAMO[String(nodeName).split(/[|:]/).pop().replace(/^mixamorig\d*_?/, '')] || null;

/**
 * A clip from a loaded Mixamo asset (an Object3D with mixamorig* bones at rest, and its THREE.AnimationClip).
 * THREE: the three module. → dense clip (clip.js shape)
 */
export function mixamoToClip(root, animation, THREE, { fps = 30, name = null } = {}) {
  root.updateMatrixWorld(true);
  const nodes = new Map();
  root.traverse((o) => { const b = vrmBone(o.name); if (b && !nodes.has(b)) nodes.set(b, o); });
  if (!nodes.has('hips')) throw new Error('no Mixamo hips bone (mixamorigHips) in this file');
  const has = new Set(nodes.keys());
  const wq = (o) => { const q = new THREE.Quaternion(); o.getWorldQuaternion(q); return [q.x, q.y, q.z, q.w]; };
  const wp = (o) => { const v = new THREE.Vector3(); o.getWorldPosition(v); return [v.x, v.y, v.z]; };
  const restWorld = Object.fromEntries([...nodes].map(([b, o]) => [b, wp(o)]));
  const unit = restWorld.hips[1] > 10 ? 0.01 : 1; // Mixamo's centimetres
  for (const b of Object.keys(restWorld)) restWorld[b] = restWorld[b].map((v) => v * unit);
  const rest = {};
  for (const b of BONES) if (has.has(b)) { const p = presentParent(b, has); rest[b] = p ? restWorld[b].map((v, i) => v - restWorld[p][i]) : restWorld[b].slice(); }
  const frames = Math.max(1, Math.round(animation.duration * fps) + 1);
  const clip = {
    name: name || animation.name || 'Mixamo', fps, frames, duration: (frames - 1) / fps, rest, restHips: restWorld.hips.slice(),
    bones: {}, hips: null, expressions: {}, custom: new Set(), lookAt: null, lookAtOffset: null, extras: null, generator: null,
  };
  for (const track of animation.tracks) {
    const dot = track.name.lastIndexOf('.');
    const nodeName = track.name.slice(0, dot), prop = track.name.slice(dot + 1);
    const bone = vrmBone(nodeName);
    if (!bone || !nodes.has(bone)) continue;
    const node = nodes.get(bone);
    const interp = track.createInterpolant();
    const at = (f) => Array.from(interp.evaluate(Math.min(animation.duration, f / fps)));
    if (prop === 'quaternion') {
      const W = wq(node), Wp = node.parent ? wq(node.parent) : [0, 0, 0, 1], Winv = qconj(W);
      const out = new Float32Array(frames * 4);
      let prev = [0, 0, 0, 1];
      for (let f = 0; f < frames; f++) { const q = qnear(qnorm(qmul(qmul(Wp, at(f)), Winv)), prev); out.set(q, f * 4); prev = q; }
      clip.bones[bone] = out;
    } else if (prop === 'position' && bone === 'hips') {
      const P = node.parent ? node.parent.matrixWorld : new THREE.Matrix4();
      const out = new Float32Array(frames * 3);
      const v = new THREE.Vector3();
      for (let f = 0; f < frames; f++) { v.fromArray(at(f)).applyMatrix4(P); out.set([v.x * unit, v.y * unit, v.z * unit], f * 3); }
      clip.hips = out;
    }
  }
  return clip;
}

/** A Mixamo .fbx's bytes → dense clip. Loads three's FBXLoader (browser or Node). */
export async function readMixamoFbx(bytes, { fps = 30, name = null } = {}) {
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  let asset;
  try { asset = new FBXLoader().parse(buf, ''); } catch (e) { throw new Error(`the FBX file could not be read: ${e.message || e}`); }
  const anim = asset.animations?.find((a) => a.name === 'mixamo.com') || asset.animations?.[0];
  if (!anim) throw new Error('the FBX file has no animation');
  return mixamoToClip(asset, anim, THREE, { fps, name });
}

export { qslerp };
