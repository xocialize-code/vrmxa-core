// The smallest VRM 1.0 the checker accepts: the 15 required humanoid bones, one triangle, a licence.
// The hostile fixtures carry it instead of an 11 MB avatar; they test the container, not the model.
import { BinWriter, buildGlb } from '../../src/glb.js';

const BONES = [['hips', null, [0, 0.9, 0]], ['spine', 'hips', [0, 0.1, 0]], ['head', 'spine', [0, 0.5, 0]],
  ['leftUpperLeg', 'hips', [0.08, -0.05, 0]], ['leftLowerLeg', 'leftUpperLeg', [0, -0.4, 0]], ['leftFoot', 'leftLowerLeg', [0, -0.4, 0]],
  ['rightUpperLeg', 'hips', [-0.08, -0.05, 0]], ['rightLowerLeg', 'rightUpperLeg', [0, -0.4, 0]], ['rightFoot', 'rightLowerLeg', [0, -0.4, 0]],
  ['leftUpperArm', 'spine', [0.15, 0.35, 0]], ['leftLowerArm', 'leftUpperArm', [0.25, 0, 0]], ['leftHand', 'leftLowerArm', [0.22, 0, 0]],
  ['rightUpperArm', 'spine', [-0.15, 0.35, 0]], ['rightLowerArm', 'rightUpperArm', [-0.25, 0, 0]], ['rightHand', 'rightLowerArm', [-0.22, 0, 0]]];

export function miniVrm(name = 'Mini') {
  const g = { asset: { version: '2.0', generator: 'vrmxa-core fixtures' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [] };
  BONES.forEach(([b, , t]) => g.nodes.push({ name: b, translation: t }));
  BONES.forEach(([, p], i) => { if (p) { const pi = BONES.findIndex((x) => x[0] === p); (g.nodes[pi].children ||= []).push(i); } });
  const w = new BinWriter(g);
  const pos = w.accessor(new Float32Array([0, 1.6, 0, 0.1, 1.4, 0, -0.1, 1.4, 0]), 5126, 'VEC3', { target: 34962, minmax: true });
  g.meshes.push({ name: 'Mini', primitives: [{ attributes: { POSITION: pos }, mode: 4 }] });
  g.nodes.push({ name: 'Mini', mesh: 0 });
  g.scenes[0].nodes.push(g.nodes.length - 1);
  const bin = w.bytes();
  g.buffers = [{ byteLength: bin.length }];
  g.extensionsUsed = ['VRMC_vrm'];
  g.extensions = { VRMC_vrm: { specVersion: '1.0', meta: { name, authors: ['Xocialize LLC'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation', allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'unnecessary' },
    humanoid: { humanBones: Object.fromEntries(BONES.map(([b], i) => [b, { node: i }])) } } };
  return buildGlb(g, bin);
}
