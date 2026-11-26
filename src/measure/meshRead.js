// A model's triangles as the skin check and the head match read them: every triangle primitive in the
// rest pose, facing +Z, with each vertex's weights summed onto humanoid bones. DOM-free.
//
// The frame is the library's usual one (bodyMeasure.js): skinned meshes are read in their bind space
// (glTF ignores a skinned mesh node's own transform; the joints are inverse(inverse bind matrix)), an
// unskinned mesh through its node's world matrix, and a VRM 0.x model, which faces −Z, is turned round
// (x, z → −x, −z). A helper bone's weight (hair, skirt, bust, twist …) counts for its nearest humanoid
// ancestor (its effective humanoid weight); an unskinned mesh hangs 100 % on the humanoid
// bone above its node.

import { readAccessor } from '../glb.js';
import { invert, parents, worldMatrix, transformPoint } from '../math.js';

// the humanoid bone map of a VRM 1.0 or 0.x file (as bodyMeasure.js reads it; kept here so this module
// has no import cycle with bodyMeasure → donorParts → skinCheck)
export function humanBones(json) {
  const out = {};
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (hb) for (const [k, v] of Object.entries(hb)) out[k] = v.node;
  for (const b of json.extensions?.VRM?.humanoid?.humanBones || []) if (out[b.bone] == null) out[b.bone] = b.node;
  return out;
}

/** The humanoid joints of a model in the +Z-facing bind frame: { bone: [x, y, z] }. */
export function humanJoints(json, bin) {
  const fwd = json.extensions?.VRMC_vrm ? 1 : -1;
  const bones = humanBones(json);
  const boneOfNode = new Map(Object.entries(bones).map(([k, n]) => [n, k]));
  const out = {};
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices == null) continue;
    const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((node, j) => {
      const bone = boneOfNode.get(node);
      if (!bone || out[bone]) return;
      const inv = invert(Array.from(ibm.slice(j * 16, j * 16 + 16)));
      if (inv) out[bone] = [inv[12] * fwd, inv[13], inv[14] * fwd];
    });
  }
  // bones no skin uses: from the rest-pose node chain
  const par = parents(json.nodes || []);
  for (const [bone, node] of Object.entries(bones)) {
    if (out[bone] || node == null || !json.nodes?.[node]) continue;
    const m = worldMatrix(json.nodes, node, par);
    out[bone] = [m[12] * fwd, m[13], m[14] * fwd];
  }
  return out;
}

/**
 * Every triangle primitive of the model. → { fwd, joints, prims: [{ mesh, primitive, material, name
 * (material name), meshName, nodeName, verts (Float64Array xyz, +Z facing), tris (Int32Array),
 * bone (Int16Array, 4 per vertex: index into `boneNames`, −1 none), weight (Float64Array, 4 per vertex) }],
 * boneNames }
 */
export function readPrims(json, bin) {
  const fwd = json.extensions?.VRMC_vrm ? 1 : -1;
  const bones = humanBones(json);
  const boneNames = Object.keys(bones).sort();
  const boneIndex = new Map(boneNames.map((b, i) => [b, i]));
  const humanNode = new Map(Object.entries(bones).map(([k, n]) => [n, boneIndex.get(k)]));
  const par = parents(json.nodes || []);
  const humanOf = (node) => {
    const seen = new Set();
    for (let n = node; n != null && !seen.has(n); n = par.get(n)) { seen.add(n); if (humanNode.has(n)) return humanNode.get(n); }
    return -1;
  };
  const prims = [];
  const holders = new Map(); // mesh → first node using it
  (json.nodes || []).forEach((n, i) => { if (n.mesh != null && !holders.has(n.mesh)) holders.set(n.mesh, i); });
  (json.meshes || []).forEach((mesh, mi) => {
    const nodeIdx = holders.get(mi);
    if (nodeIdx == null) return;
    const node = json.nodes[nodeIdx];
    const skin = node.skin != null ? json.skins?.[node.skin] : null;
    const world = skin ? null : worldMatrix(json.nodes, nodeIdx, par);
    const jointBone = skin ? skin.joints.map((j) => humanOf(j)) : null;
    const nodeBone = skin ? -1 : humanOf(nodeIdx);
    (mesh.primitives || []).forEach((p, pi) => {
      if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION == null) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const nv = pos.length / 3;
      const verts = new Float64Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        let q = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
        if (world) q = transformPoint(world, q);
        verts[i * 3] = q[0] * fwd; verts[i * 3 + 1] = q[1]; verts[i * 3 + 2] = q[2] * fwd;
      }
      let tris;
      if (p.indices != null) tris = Int32Array.from(readAccessor(json, bin, p.indices));
      else { tris = new Int32Array(nv - (nv % 3)); for (let i = 0; i < tris.length; i++) tris[i] = i; }
      if (tris.length % 3) tris = tris.subarray(0, tris.length - (tris.length % 3));
      const bone = new Int16Array(nv * 4).fill(-1), weight = new Float64Array(nv * 4);
      if (skin && p.attributes.JOINTS_0 != null && p.attributes.WEIGHTS_0 != null) {
        const jn = readAccessor(json, bin, p.attributes.JOINTS_0), wt = readAccessor(json, bin, p.attributes.WEIGHTS_0);
        const wNorm = json.accessors[p.attributes.WEIGHTS_0];
        const scale = wNorm.normalized ? (wNorm.componentType === 5121 ? 1 / 255 : wNorm.componentType === 5123 ? 1 / 65535 : 1) : 1;
        for (let i = 0; i < nv; i++) {
          // merge the four slots onto humanoid bones, in slot order
          let used = 0;
          for (let k = 0; k < 4; k++) {
            const w = wt[i * 4 + k] * scale;
            if (!(w > 0)) continue;
            const b = jointBone[jn[i * 4 + k]] ?? -1;
            if (b < 0) continue;
            let s = 0;
            while (s < used && bone[i * 4 + s] !== b) s++;
            if (s === used) { bone[i * 4 + s] = b; used++; }
            weight[i * 4 + s] += w;
          }
        }
      } else if (nodeBone >= 0) {
        for (let i = 0; i < nv; i++) { bone[i * 4] = nodeBone; weight[i * 4] = 1; }
      }
      prims.push({
        mesh: mi, primitive: pi, material: p.material ?? -1, name: json.materials?.[p.material]?.name || '',
        meshName: mesh.name || '', nodeName: node.name || '', verts, tris, bone, weight,
      });
    });
  });
  return { fwd, joints: humanJoints(json, bin), prims, boneNames };
}

/** How much of each vertex hangs on the given humanoid bones (a Set of names). → Float64Array */
export function weightOn(prim, boneNames, set) {
  const nv = prim.verts.length / 3;
  const out = new Float64Array(nv);
  const want = boneNames.map((b) => set.has(b));
  for (let i = 0; i < nv; i++) {
    let s = 0, all = 0;
    for (let k = 0; k < 4; k++) { const b = prim.bone[i * 4 + k]; if (b < 0) continue; all += prim.weight[i * 4 + k]; if (want[b]) s += prim.weight[i * 4 + k]; }
    out[i] = all > 0 ? s / all : 0;
  }
  return out;
}
