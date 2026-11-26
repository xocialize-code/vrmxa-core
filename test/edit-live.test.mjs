// Phase 2: the live view (three.js) puts the body where the bake writes it (APP-6: what is shown is
// what is saved). Run on Spec's skeleton as three.js objects, without a renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { parseGlb } from '../src/index.js';
import { worldMatrix, parents } from '../src/math.js';
import { createLiveEdits } from '../src/edit/three/live.js';
import { newEdits, setEdits, readEdits, bakeAvatar } from '../src/edit/index.js';
import { specVrm, noSpec } from './helpers.mjs';

// Spec's nodes as three.js objects, as a loader would make them (no meshes: bones only)
function skeletonOf(json) {
  const objs = json.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name || '';
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  const scene = new THREE.Group();
  const par = parents(json.nodes);
  objs.forEach((o, i) => (par.has(i) ? objs[par.get(i)] : scene).add(o));
  scene.updateMatrixWorld(true);
  const bones = json.extensions.VRMC_vrm.humanoid.humanBones;
  return { scene, objs, humanoid: { getRawBoneNode: (b) => objs[bones[b]?.node] ?? null } };
}

test('the live body edits put every humanoid bone where the bake writes it', { skip: noSpec }, () => {
  const spec = specVrm();
  const g = parseGlb(spec);
  const vrm = skeletonOf(g.json);
  const live = createLiveEdits(vrm, g);
  const doc = setEdits(newEdits(), [['body.height', 0.6], ['body.legLength', -0.5], ['body.shoulderWidth', 0.8], ['body.neckLength', 0.4], ['face.bones.iris', 1.2]]);
  live.apply(readEdits(doc).edits);
  vrm.scene.updateMatrixWorld(true);
  const baked = parseGlb(bakeAvatar(spec, doc).bytes).json;
  const par = parents(baked.nodes);
  let worst = 0;
  for (const [role, b] of Object.entries(g.json.extensions.VRMC_vrm.humanoid.humanBones)) {
    const p = new THREE.Vector3().setFromMatrixPosition(vrm.objs[b.node].matrixWorld);
    const m = worldMatrix(baked.nodes, b.node, par);
    const d = Math.hypot(p.x - m[12], p.y - m[13], p.z - m[14]);
    worst = Math.max(worst, d);
    assert.ok(d < 1e-4, `${role}: live ${p.toArray().map((v) => v.toFixed(4))} vs baked ${[m[12], m[13], m[14]].map((v) => v.toFixed(4))}`);
  }
  assert.ok(worst < 1e-4);
  // putting the edits back restores the rest pose
  live.apply(readEdits(newEdits()).edits);
  vrm.scene.updateMatrixWorld(true);
  const hips = g.json.extensions.VRMC_vrm.humanoid.humanBones.head.node;
  const rest = worldMatrix(g.json.nodes, hips);
  const now = new THREE.Vector3().setFromMatrixPosition(vrm.objs[hips].matrixWorld);
  assert.ok(Math.hypot(now.x - rest[12], now.y - rest[13], now.z - rest[14]) < 1e-6);
});

test('the live view offers the face shapes no expression drives, and finds the head frame', { skip: noSpec }, () => {
  const g = parseGlb(specVrm());
  const live = createLiveEdits(skeletonOf(g.json), g);
  assert.ok(live.offeredMorphs.length > 10, `${live.offeredMorphs.length} offered`);
  assert.ok(live.offeredMorphs.every((m) => /^[A-Z]+_/.test(m.key)));
  assert.ok(!live.offeredMorphs.some((m) => m.key === 'MTH_A'), 'the "aa" mouth is driven by an expression, so it is not offered');
  assert.ok(live.frame && live.landmarks?.d > 0.03);
});
