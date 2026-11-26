// A tiny VRM animation (.vrma, VRMC_vrm_animation 1.0) made from nothing: a few humanoid nodes and
// rotation keys. Used for the fixtures' clips.
import { BinWriter, buildGlb } from '../../src/glb.js';

const REST = { hips: [0, 0.8934, 0.0036], spine: [0, 0.052, 0.0125], chest: [0, 0.1131, 0.003], upperChest: [0, 0.1076, -0.0081],
  neck: [0, 0.1323, -0.0207], head: [0, 0.0718, 0.0071], leftUpperArm: [0.1135, 0.0207, -0.0197], rightUpperArm: [-0.1135, 0.0207, -0.0197] };
const TREE = { hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', leftUpperArm: 'upperChest', rightUpperArm: 'upperChest' };
// the legs, for clips that walk (opts.legs): offsets from each bone's parent on Spec (spec.measurements.json's joints)
const LEGS = { leftUpperLeg: [0.0772, -0.0398, -0.0037], leftLowerLeg: [0, -0.3529, -0.0074], leftFoot: [0, -0.4148, -0.0249], leftToes: [0, -0.063, 0.1107],
  rightUpperLeg: [-0.0772, -0.0398, -0.0037], rightLowerLeg: [0, -0.3529, -0.0074], rightFoot: [0, -0.4148, -0.0249], rightToes: [0, -0.063, 0.1107] };
const LEG_TREE = { leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot' };
const quat = (axis, deg) => { const r = (deg * Math.PI) / 360; const s = Math.sin(r); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(r)]; };

/**
 * keys: { bone: [[time, axis, degrees], …] } → .vrma bytes. opts: { legs (add the leg bones), hips: [[time, [x, y, z]], …]
 * (the hips' translation keys) }. Without opts the output is as it always was.
 */
export function vrma(name, keys, opts = {}) {
  const tree = opts.legs ? { ...TREE, ...LEG_TREE } : TREE;
  const rest = opts.legs ? { ...REST, ...LEGS } : REST;
  const bones = Object.keys(tree);
  const g = { asset: { version: '2.0', generator: 'vrmxa-core fixtures' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], animations: [], extensionsUsed: ['VRMC_vrm_animation'] };
  bones.forEach((b) => g.nodes.push({ name: b, translation: rest[b] }));
  bones.forEach((b, i) => { const p = tree[b]; if (p) { const pi = bones.indexOf(p); (g.nodes[pi].children ||= []).push(i); } });
  const w = new BinWriter(g);
  const anim = { name, channels: [], samplers: [] };
  for (const [bone, list] of Object.entries(keys)) {
    const times = new Float32Array(list.map((k) => k[0]));
    const rots = new Float32Array(list.flatMap((k) => quat(k[1], k[2])));
    const input = w.accessor(times, 5126, 'SCALAR', { minmax: true });
    const output = w.accessor(rots, 5126, 'VEC4');
    anim.samplers.push({ input, output, interpolation: 'LINEAR' });
    anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: bones.indexOf(bone), path: 'rotation' } });
  }
  if (opts.hips) {
    const input = w.accessor(new Float32Array(opts.hips.map((k) => k[0])), 5126, 'SCALAR', { minmax: true });
    const output = w.accessor(new Float32Array(opts.hips.flatMap((k) => k[1])), 5126, 'VEC3');
    anim.samplers.push({ input, output, interpolation: 'LINEAR' });
    anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: bones.indexOf('hips'), path: 'translation' } });
  }
  g.animations.push(anim);
  const bin = w.bytes();
  g.buffers = [{ byteLength: bin.length }];
  g.extensions = { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(bones.map((b, i) => [b, { node: i }])) } } };
  return buildGlb(g, bin);
}
