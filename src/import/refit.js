// Fitting again from its source an item that was brought onto Spec by its bones (VRMXW W20, §11
// `origin.fit`; FITTING.md §7; PRD phase 5). Such an item keeps its donor's girth: a male donor's
// trousers show Spec's hips through them. Given the file it came from (checked against
// `origin.sha256`), its vertices are taken back to where they sat on the donor (the bones' move is a
// per-vertex blend of rigid moves, so it can be undone exactly), given their fit coordinates against
// the donor's measured body, and moved onto Spec by Spec-fit. Everything else about the item is kept:
// its meshes, parts, states, weights, springs, tags and licence; only the vertices, their normals and
// morph deltas change, `origin.fit` becomes "spec-fit", and the revision goes up. DOM-free.
//
// Not undone: the importer's place (move, turn, size), which the item doesn't record. An item placed by
// hand in the importer is refitted as if it hadn't been (`placeUnknown` in the result says so).

import { parseGlb, buildGlb } from '../glb.js';
import { invert, multiply, parents } from '../math.js';
import { readItem } from '../vrmxw.js';
import { writeVec3, SPEC_FIT_SLOTS } from '../closet/fit.js';
import { setOrigin, saveItem } from '../item/edit.js';
import { openSource } from './source.js';
import { importRigs, ImportError } from './session.js';
import { specContext, donorContext, itemGeometry, fitCoordinates, moveGarment, fitRule, vertexNormals } from '../fit/index.js';

const apply = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
const applyLin = (m, v) => [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];

/** Can this item be fitted again from its source? → null, or the reason it can't. */
export function refitProblem(manifest) {
  if (manifest?.fit?.method !== 'spec-fit' || !SPEC_FIT_SLOTS.includes(manifest?.slot)) return 'Spec-fit covers tops, bottoms, one-pieces and coats';
  if (manifest?.origin?.fit !== 'bones') return manifest?.origin?.fit === 'spec-fit' ? 'it was brought onto Spec by Spec-fit already' : 'it was not brought in from another body by its bones';
  if (!/^[0-9a-f]{64}$/.test(manifest?.origin?.sha256 || '')) return 'its origin does not name the file it came from (origin.sha256)';
  return null;
}

/**
 * item: a .vrmxw's bytes or a read item; source: the VRM it came from (bytes); spec: spec.vrm's bytes.
 * opts: { fileName, specCtx (Spec's fitting context, if made already) }.
 * → { item (the next revision), bytes, problems, stats, estimated, placeUnknown }; ImportError when it can't.
 */
export async function refitFromSource(item, source, spec, { fileName = 'source.vrm', specCtx = null } = {}) {
  const it = item instanceof Uint8Array ? await readItem(item, { spec }) : item;
  const m = it.manifest;
  const why = refitProblem(m);
  if (why) throw new ImportError('refit.not-applicable', `"${m.name}" can't be fitted again from its source: ${why}`);
  const src = await openSource(source, { fileName });
  if (src.sha256 !== m.origin.sha256) throw new ImportError('refit.wrong-source', `${fileName} is not the file "${m.name}" came from (its SHA-256 is ${src.sha256.slice(0, 12)}…, the item names ${m.origin.sha256.slice(0, 12)}…)`);
  const rigs = importRigs(src, spec);
  const sCtx = specCtx || specContext({ json: rigs.spec.json, bin: rigs.spec.bin });
  const donor = donorContext(src.json, src.bin, sCtx);
  if (donor.refused) throw new ImportError('refit.no-body', `the source's body can't be fitted to: ${donor.refused}`);
  const file = m.model?.file || 'model.glb';
  const model = parseGlb(it.entries.get(file));
  const json = JSON.parse(JSON.stringify(model.json));
  let bin = model.bin.slice();
  const rig = m.rig?.humanBones || {};
  const g = itemGeometry(json, bin, null, { rig, all: true });
  if (!g) throw new ImportError('refit.no-mesh', `"${m.name}" has no skinned meshes to fit`);
  // each joint's bones move, Spec bind · donor rest⁻¹, by its nearest humanoid ancestor (moveOntoSpec's rule)
  const boneOfNode = new Map(Object.entries(rig).map(([b, n]) => [n, b]));
  const par = parents(json.nodes || []);
  const moveOf = new Map();
  const moveFor = (node) => {
    if (moveOf.has(node)) return moveOf.get(node);
    let bone = null;
    for (let n = node; n != null; n = par.get(n)) if (boneOfNode.has(n)) { bone = boneOfNode.get(n); break; }
    const S = bone && rigs.spec.bind.get(bone), D = bone && rigs.donor.world.get(bone);
    const M = S && D ? multiply(S, invert(D)) : null;
    moveOf.set(node, M);
    return M;
  };
  // back to the donor: v_donor = (Σ w · Mⱼ)⁻¹ v_spec, per vertex
  const n = g.n;
  const donorPos = new Float32Array(n * 3);
  const donorNrm = g.normals ? new Float32Array(n * 3) : null;
  const backs = new Array(n);
  for (let i = 0; i < n; i++) {
    const B = new Array(16).fill(0);
    let ws = 0;
    for (let k = 0; k < 4; k++) {
      const w = g.weights[i * 4 + k];
      if (!(w > 1e-6)) continue;
      const M = moveFor(g.nodes[i * 4 + k]);
      if (!M) continue;
      for (let q = 0; q < 16; q++) B[q] += w * M[q];
      ws += w;
    }
    const back = ws > 1e-6 ? invert(B.map((x) => x / ws)) : null;
    backs[i] = back;
    const v = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
    const d = back ? apply(back, v) : v;
    donorPos.set(d, i * 3);
    if (donorNrm) {
      const fwd = ws > 1e-6 ? B.map((x) => x / ws) : null;
      const nv = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
      const q = fwd ? applyLin([fwd[0], fwd[4], fwd[8], 0, fwd[1], fwd[5], fwd[9], 0, fwd[2], fwd[6], fwd[10], 0, 0, 0, 0, 1], nv) : nv; // Bᵀ n
      const l = Math.hypot(q[0], q[1], q[2]) || 1;
      donorNrm.set([q[0] / l, q[1] / l, q[2] / l], i * 3);
    }
  }
  const targetsDonor = g.targets.map((d) => {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      if (!d[i * 3] && !d[i * 3 + 1] && !d[i * 3 + 2]) continue;
      const q = backs[i] ? applyLin(backs[i], [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]]) : [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]];
      out.set(q, i * 3);
    }
    return out;
  });
  const garment = { pos: donorPos, zones: g.zones, tris: g.tris, normals: donorNrm || vertexNormals(donorPos, g.tris), targets: targetsDonor };
  const coords = fitCoordinates(donor, garment, fitRule(m.fit));
  const r = moveGarment(coords, donor, sCtx, garment, { bones: g.pos, foreign: true });
  for (const p of g.parts) {
    bin = writeVec3(json, bin, p.acc, r.pos.slice(p.offset * 3, (p.offset + p.n) * 3));
    if (r.normals && p.normalAcc != null) bin = writeVec3(json, bin, p.normalAcc, r.normals.slice(p.offset * 3, (p.offset + p.n) * 3));
  }
  if (r.targets) g.targetAccs.forEach((ta, k) => { bin = writeVec3(json, bin, ta.acc, r.targets[k].slice(ta.part.offset * 3, (ta.part.offset + ta.part.n) * 3)); });
  if (json.buffers?.[0]) json.buffers[0].byteLength = bin.length;
  let next = { ...it, manifest: JSON.parse(JSON.stringify(m)), entries: new Map(it.entries) };
  next.entries.set(file, buildGlb(json, bin));
  next = setOrigin(next, { fit: 'spec-fit' });
  const saved = await saveItem(next, { spec });
  return { ...saved, stats: r.stats, estimated: donor.estimated, placeUnknown: true };
}
