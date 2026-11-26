// A clip as the checker and the corrections work on it, read from and written to a .vrma
// (VRMC_vrm_animation 1.0): every track sampled on whole frames, rotations already turned into
// normalized pose data (identity rest, T-pose), as @pixiv/three-vrm-animation turns them.
//
//   clip = {
//     name, fps, frames (number of keys), duration (s, the last key's time),
//     rest: { bone: [x, y, z] }   each humanoid bone's T-pose offset from its nearest humanoid parent (the file's skeleton)
//     restHips: [x, y, z]         the hips' rest place in the file (a player scales the hips track by its own hips height / restHips[1])
//     bones: { bone: Float32Array(frames × 4) }   normalized local rotations [x, y, z, w]
//     hips: Float32Array(frames × 3) | null       the hips' place, in the file's metres
//     expressions: { name: Float32Array(frames) }, custom: Set of the custom ones
//     lookAt: Float32Array(frames × 4) | null, lookAtOffset: [x, y, z] | null
//     extras: the file's asset.extras (kept), generator
//   }
//
// Reading follows the player (three-vrm-animation 3.5.5, VRMAnimationLoaderPlugin._parseAnimation):
// a rotation key q of a bone whose node rests at world rotation W, under a humanoid parent at world
// rotation Wp, is the normalized rotation Wp · q · W⁻¹; the hips' translation is taken through its
// parent's world matrix. Writing gives every node an identity rotation, so the keys are the pose itself.
//
// The writer is dense: no keys and curves; the file's own skeleton is kept, with expression and gaze tracks.

import { parseGlb, buildGlb, readAccessor, BinWriter } from '../glb.js';
import { BONES, PARENT, presentParent, EXPRESSION_PRESETS } from './humanoid.js';
import { qmul, qconj, qnorm, qslerp, qnear } from './quat.js';

export const DEFAULT_FPS = 30;
const PRESETS = new Set(EXPRESSION_PRESETS);

// ---- 4×4 matrices, column-major as glTF writes them ----
function compose(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mmul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
const mpoint = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
// the rotation part of a matrix as a quaternion (scale divided out)
function mquat(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const m11 = m[0] / sx, m12 = m[4] / sy, m13 = m[8] / sz, m21 = m[1] / sx, m22 = m[5] / sy, m23 = m[9] / sz, m31 = m[2] / sx, m32 = m[6] / sy, m33 = m[10] / sz;
  const tr = m11 + m22 + m33;
  let q;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); q = [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); q = [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); q = [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); q = [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]; }
  return qnorm(q);
}
const nodeMatrix = (n) => (Array.isArray(n.matrix) ? n.matrix.slice() : compose(n.translation, n.rotation, n.scale));

/** World matrices of every node of a glTF (an array, by node index; nodes outside the scene graph as roots). */
export function worldMatrices(json) {
  const nodes = json.nodes || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const out = new Array(nodes.length);
  const get = (i) => {
    if (out[i]) return out[i];
    const local = nodeMatrix(nodes[i]);
    out[i] = parent.has(i) ? mmul(get(parent.get(i)), local) : local;
    return out[i];
  };
  nodes.forEach((_, i) => get(i));
  return { world: out, parent };
}

// values of an accessor as floats (normalized integers divided out, glTF §3.11)
function floats(json, bin, ai) {
  const a = json.accessors?.[ai];
  const v = readAccessor(json, bin, ai);
  if (!a || a.componentType === 5126 || !a.normalized) return Float32Array.from(v);
  const div = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType] || 1;
  return Float32Array.from(v, (x) => Math.max(x / div, -1));
}

// sample one glTF channel on whole frames: n values per key (3 or 4; rotations by slerp)
function sampleChannel(json, bin, sampler, frames, fps, n) {
  const times = floats(json, bin, sampler.input);
  let values = floats(json, bin, sampler.output);
  const interp = sampler.interpolation || 'LINEAR';
  if (interp === 'CUBICSPLINE') { // in-tangent, value, out-tangent per key: keep the values
    const v = new Float32Array(times.length * n);
    for (let k = 0; k < times.length; k++) v.set(values.subarray((k * 3 + 1) * n, (k * 3 + 2) * n), k * n);
    values = v;
  }
  const out = new Float32Array(frames * n);
  const at = (k) => Array.from(values.subarray(k * n, k * n + n));
  let k = 0;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    while (k < times.length - 2 && times[k + 1] <= t) k++;
    let v;
    if (times.length === 1 || t <= times[0]) v = at(0);
    else if (t >= times[times.length - 1]) v = at(times.length - 1);
    else {
      const t0 = times[k], t1 = times[k + 1];
      const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      if (interp === 'STEP') v = at(k);
      else if (n === 4) v = qslerp(at(k), at(k + 1), u);
      else { const a = at(k), b = at(k + 1); v = a.map((x, i) => x + (b[i] - x) * u); }
    }
    out.set(v, f * n);
  }
  return out;
}

/** Is this a .vrma (a GLB with VRMC_vrm_animation)? */
export function isVrma(bytes) {
  try { return !!parseGlb(bytes).json.extensions?.VRMC_vrm_animation; } catch { return false; }
}

/**
 * Read a .vrma into a dense clip, sampled at `fps` (default: the file's own key spacing, else 30). Throws
 * when it is not a VRM animation.
 */
export function readVrma(bytes, { fps = null, name = null } = {}) {
  const { json, bin } = parseGlb(bytes);
  const ext = json.extensions?.VRMC_vrm_animation;
  if (!ext) throw new Error('not a VRM animation (no VRMC_vrm_animation)');
  const anim = json.animations?.[0];
  const human = ext.humanoid?.humanBones || {};
  const nodeOf = Object.fromEntries(Object.entries(human).filter(([b, v]) => Number.isInteger(v?.node) && b !== 'leftEye' && b !== 'rightEye').map(([b, v]) => [b, v.node]));
  if (nodeOf.hips === undefined) throw new Error('the animation has no hips bone');
  const boneOfNode = new Map(Object.entries(nodeOf).map(([b, n]) => [n, b]));
  const { world, parent } = worldMatrices(json);
  const has = new Set(Object.keys(nodeOf));
  // rest: each bone's offset from its nearest humanoid parent, in world terms (the T-pose)
  const restWorld = {};
  for (const b of BONES) if (has.has(b)) restWorld[b] = mpoint(world[nodeOf[b]], [0, 0, 0]);
  const rest = {};
  for (const b of BONES) {
    if (!has.has(b)) continue;
    const p = presentParent(b, has);
    rest[b] = p ? restWorld[b].map((v, i) => v - restWorld[p][i]) : restWorld[b].slice();
  }
  const restHips = restWorld.hips.slice();

  // key spacing and length
  let end = 0, minStep = Infinity;
  for (const s of anim?.samplers || []) {
    const t = floats(json, bin, s.input);
    if (t.length) end = Math.max(end, t[t.length - 1]);
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > 1e-6) minStep = Math.min(minStep, t[i] - t[i - 1]);
  }
  const rate = fps || (Number.isFinite(minStep) ? Math.min(120, Math.max(1, Math.round(1 / minStep))) : DEFAULT_FPS);
  const frames = Math.max(1, Math.round(end * rate) + 1);

  const clip = {
    name: name || anim?.name || 'Motion', fps: rate, frames, duration: (frames - 1) / rate,
    rest, restHips, bones: {}, hips: null, expressions: {}, custom: new Set(), lookAt: null, lookAtOffset: null,
    extras: json.asset?.extras ?? null, generator: json.asset?.generator ?? null,
  };
  const exprOfNode = new Map();
  for (const [group, map] of Object.entries(ext.expressions || {})) {
    for (const [e, v] of Object.entries(map || {})) if (Number.isInteger(v?.node)) { exprOfNode.set(v.node, e); if (group === 'custom') clip.custom.add(e); }
  }
  const lookNode = Number.isInteger(ext.lookAt?.node) ? ext.lookAt.node : null;
  if (lookNode !== null) clip.lookAtOffset = (ext.lookAt.offsetFromHeadBone || [0, 0, 0]).slice(0, 3);

  for (const ch of anim?.channels || []) {
    const node = ch.target?.node, path = ch.target?.path;
    const sampler = anim.samplers?.[ch.sampler];
    if (node === undefined || !sampler) continue;
    const bone = boneOfNode.get(node);
    if (bone && path === 'rotation') {
      const raw = sampleChannel(json, bin, sampler, frames, rate, 4);
      const p = presentParent(bone, has);
      const W = mquat(world[node]);
      const Wp = p ? mquat(world[nodeOf[p]]) : (parent.has(nodeOf.hips) ? mquat(world[parent.get(nodeOf.hips)]) : [0, 0, 0, 1]);
      const Winv = qconj(W);
      const out = new Float32Array(frames * 4);
      let prev = [0, 0, 0, 1];
      for (let f = 0; f < frames; f++) {
        const q = qnear(qnorm(qmul(qmul(Wp, Array.from(raw.subarray(f * 4, f * 4 + 4))), Winv)), prev);
        out.set(q, f * 4);
        prev = q;
      }
      clip.bones[bone] = out;
    } else if (bone === 'hips' && path === 'translation') {
      const raw = sampleChannel(json, bin, sampler, frames, rate, 3);
      const P = parent.has(node) ? world[parent.get(node)] : null;
      if (P) for (let f = 0; f < frames; f++) raw.set(mpoint(P, Array.from(raw.subarray(f * 3, f * 3 + 3))), f * 3);
      clip.hips = raw;
    } else if (exprOfNode.has(node) && path === 'translation') {
      const raw = sampleChannel(json, bin, sampler, frames, rate, 3);
      const w = new Float32Array(frames);
      for (let f = 0; f < frames; f++) w[f] = Math.min(1, Math.max(0, raw[f * 3]));
      clip.expressions[exprOfNode.get(node)] = w;
    } else if (node === lookNode && path === 'rotation') {
      clip.lookAt = sampleChannel(json, bin, sampler, frames, rate, 4);
    }
  }
  return clip;
}

/** A deep copy of a clip. */
export function cloneClip(c) {
  return {
    ...c, rest: Object.fromEntries(Object.entries(c.rest).map(([b, v]) => [b, v.slice()])), restHips: c.restHips.slice(),
    bones: Object.fromEntries(Object.entries(c.bones).map(([b, v]) => [b, v.slice()])), hips: c.hips ? c.hips.slice() : null,
    expressions: Object.fromEntries(Object.entries(c.expressions).map(([e, v]) => [e, v.slice()])), custom: new Set(c.custom),
    lookAt: c.lookAt ? c.lookAt.slice() : null, lookAtOffset: c.lookAtOffset ? c.lookAtOffset.slice() : null,
    extras: c.extras ? JSON.parse(JSON.stringify(c.extras)) : null,
  };
}

/** The rotation of `bone` at frame f (identity when the clip doesn't move it). */
export function rotAt(clip, bone, f) {
  const t = clip.bones[bone];
  return t ? [t[f * 4], t[f * 4 + 1], t[f * 4 + 2], t[f * 4 + 3]] : [0, 0, 0, 1];
}
/** The hips' place at frame f, in the file's metres (rest when it has no track). */
export function hipsAt(clip, f) {
  const h = clip.hips;
  return h ? [h[f * 3], h[f * 3 + 1], h[f * 3 + 2]] : clip.restHips.slice();
}

/** Which tracks a clip drives (VRMXA §8.4 clips[].tracks). */
export function clipTracks(clip) {
  const out = [];
  if (Object.keys(clip.bones).length || clip.hips) out.push('humanoid');
  if (Object.keys(clip.expressions).length) out.push('expressions');
  if (clip.lookAt) out.push('lookAt');
  return out;
}

/** How many keys the clip holds (one per frame per track), and per lane, for the timeline. */
export function keyCount(clip) {
  return (Object.keys(clip.bones).length + (clip.hips ? 1 : 0) + Object.keys(clip.expressions).length + (clip.lookAt ? 1 : 0)) * clip.frames;
}

/**
 * Write a clip as a .vrma: the humanoid nodes in the humanoid hierarchy at the clip's rest offsets with
 * identity rotations (so the keys are normalized pose data), one animation with LINEAR samplers at the
 * clip's frames, each expression as a node whose X translation is its weight, and gaze as the rotation of
 * a lookAt node. `extras` goes into asset.extras (the corrections that made it, its source). → Uint8Array
 */
export function writeVrma(clip, { generator = 'VRMXA Avatar Studio', extras = clip.extras } = {}) {
  const has = new Set(Object.keys(clip.rest));
  if (!has.has('hips')) throw new Error('the clip has no hips bone');
  const bones = BONES.filter((b) => has.has(b));
  const index = new Map(bones.map((b, i) => [b, i]));
  const nodes = bones.map((b) => ({ name: b, translation: clip.rest[b].map((v) => +v.toFixed(6)) }));
  for (const b of bones) {
    const p = presentParent(b, has);
    if (p) (nodes[index.get(p)].children ||= []).push(index.get(b));
  }
  const json = {
    asset: { version: '2.0', generator, ...(extras ? { extras } : {}) },
    extensionsUsed: ['VRMC_vrm_animation'],
    scene: 0, scenes: [{ nodes: [0] }], nodes, animations: [{ name: clip.name, channels: [], samplers: [] }],
    bufferViews: [], accessors: [], buffers: [],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(bones.map((b) => [b, { node: index.get(b) }])) } } },
  };
  const w = new BinWriter(json);
  const times = new Float32Array(clip.frames);
  for (let f = 0; f < clip.frames; f++) times[f] = f / clip.fps;
  const tAcc = w.accessor(times, 5126, 'SCALAR', { minmax: true });
  const A = json.animations[0];
  const add = (node, path, values, type) => {
    const out = w.accessor(Float32Array.from(values), 5126, type);
    A.samplers.push({ input: tAcc, output: out, interpolation: 'LINEAR' });
    A.channels.push({ sampler: A.samplers.length - 1, target: { node, path } });
  };
  if (clip.hips) add(0, 'translation', clip.hips, 'VEC3');
  for (const b of bones) if (clip.bones[b]) add(index.get(b), 'rotation', clip.bones[b], 'VEC4');
  const exprNames = Object.keys(clip.expressions).filter((e) => !/^look(Up|Down|Left|Right)$/.test(e));
  if (exprNames.length) {
    const preset = {}, custom = {};
    for (const e of exprNames) {
      const n = nodes.length;
      nodes.push({ name: `expression.${e}` });
      json.scenes[0].nodes.push(n);
      const v = new Float32Array(clip.frames * 3);
      for (let f = 0; f < clip.frames; f++) v[f * 3] = clip.expressions[e][f];
      add(n, 'translation', v, 'VEC3');
      ((PRESETS.has(e) && !clip.custom.has(e)) ? preset : custom)[e] = { node: n };
    }
    json.extensions.VRMC_vrm_animation.expressions = { ...(Object.keys(preset).length ? { preset } : {}), ...(Object.keys(custom).length ? { custom } : {}) };
  }
  if (clip.lookAt) {
    const n = nodes.length;
    nodes.push({ name: 'lookAt' });
    json.scenes[0].nodes.push(n);
    add(n, 'rotation', clip.lookAt, 'VEC4');
    json.extensions.VRMC_vrm_animation.lookAt = { node: n, offsetFromHeadBone: clip.lookAtOffset || [0, 0.06, 0] };
  }
  const bin = w.bytes();
  json.buffers = [{ byteLength: bin.length }];
  return buildGlb(json, bin);
}

export { PARENT };
