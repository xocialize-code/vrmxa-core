// The one item writer (PRD ITM-2; VRMXW §2, §5, §16 item 2).
//
// It cuts an item's model.glb out of a dressed VRM 1.0 by editing the glTF data directly, so the toon
// materials (VRMC_materials_mtoon), spring bones (VRMC_springBone) and morph targets come across
// exactly as authored. three.js's GLTFExporter is never used: it writes MToon as plain unlit
// materials and drops springs.
//
// Primitives are copied as used-vertex subsets, materials and their textures verbatim; weights on helper
// bones move to the nearest humanoid ancestor (VRMXW §5.3 rule 3); the springs whose joints the item
// weights are carried with their colliders. Also:
//   - the skeleton is pruned to the nodes the item needs and re-indexed (§5.3 rule 6), and each skin
//     lists only the joints that carry weight;
//   - textures, images and samplers are copied once each, not once per material;
//   - every vertex attribute is carried (tangents, colours, a second UV set), not only four;
//   - JOINTS_1 / WEIGHTS_1 are folded into one set of at most four influences (§5.3 rule 5);
//   - pinned items (§5.4): the meshes become children of the bone's node, unskinned, placed as on Spec;
//   - no metadata in the model (VRMXW W2): rig, licence and origin go in the item's manifest;
//   - every read is bounds-checked (glb.js).
// The segmentation that guesses which primitives are which item belongs to the importer (PRD §8.1) and
// is not here; the shoe-lift correction (ITM-11) is not built.

import { asBytes, clone } from './bytes.js';
import { BinWriter, buildGlb, bufferViewBytes, parseGlb, readAccessor } from './glb.js';
import { invert, multiply, parents, tidy, worldMatrix } from './math.js';
import { HUMAN_BONES } from './vocab.js';
import { uniqueNodeNames } from './show.js';

const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const isIdentity = (m) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

/** The humanoid map of a VRM 1.0 → { boneOfNode: Map(node → bone), nodeOfBone: { bone: node } }. */
export function humanoidOf(json) {
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (!hb || typeof hb !== 'object') return null;
  const boneOfNode = new Map();
  const nodeOfBone = {};
  for (const [bone, o] of Object.entries(hb)) {
    if (o && Number.isInteger(o.node)) {
      boneOfNode.set(o.node, bone);
      nodeOfBone[bone] = o.node;
    }
  }
  return { boneOfNode, nodeOfBone };
}

/** An item's licence block from the VRM it was taken from (VRMXW §11): VRM's own meta, less what doesn't apply to an item. */
export function metaFromVrm(json) {
  const m = json.extensions?.VRMC_vrm?.meta;
  if (!m || typeof m !== 'object') return null;
  const { name, avatarPermission, thumbnailImage, ...rest } = clone(m);
  return rest;
}

// every {index: textureId} object inside a material 
function textureRefs(obj, found) {
  if (Array.isArray(obj)) {
    for (const v of obj) textureRefs(v, found);
  } else if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (Number.isInteger(obj.index) && keys.every((k) => ['index', 'texCoord', 'scale', 'strength', 'extensions', 'extras'].includes(k))) found.push(obj);
    for (const v of Object.values(obj)) textureRefs(v, found);
  }
}

// extension names used anywhere inside a JSON value
function extensionNames(obj, out) {
  if (Array.isArray(obj)) for (const v of obj) extensionNames(v, out);
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'extensions' && v && typeof v === 'object') for (const name of Object.keys(v)) out.add(name);
      extensionNames(v, out);
    }
  }
  return out;
}

function subsetAttribute(json, bin, ai, used) {
  const acc = json.accessors[ai];
  const nc = NC[acc.type];
  if (!nc) throw new Error(`accessor ${ai}: type ${acc.type} is not a vertex attribute type`);
  const full = readAccessor(json, bin, ai);
  const T = TYPED[acc.componentType];
  const sub = new T(used.length * nc);
  used.forEach((v, i) => sub.set(full.subarray(v * nc, v * nc + nc), i * nc));
  return { data: sub, componentType: acc.componentType, type: acc.type, normalized: acc.normalized };
}

/**
 * Cut an item's model out of a dressed VRM 1.0.
 *   source: the VRM's bytes, or { json, bin } already parsed
 *   opts.prims:  [[meshIndex, primitiveIndex], …] the primitives that make the item
 *   opts.kind:   'worn' (skinned, VRMXW §5.3) or 'pin' (rigid under one bone, §5.4)
 *   opts.attach: for 'pin', the humanoid bone it follows
 *   opts.bones:  more humanoid bones the model must carry (the bones its states name)
 *   opts.bodyBones: source nodes that are the donor body's own secondary bones (a spring joint the body skin leans
 *                on, such as VRoid's bust): folded into their humanoid ancestor like any helper bone, never carried as
 *                the item's own chain (VRMXW §5.3 rule 3; SPEC-QUESTIONS #41). VRoid's J_Sec_*_Bust bones always are.
 *   opts.name:   a name for the meshes
 *   opts.generator: written in asset.generator
 * → { glb, rig: { humanBones }, springs, colliders, nodes, meshes }
 */
export function extractItemModel(source, opts = {}) {
  const { json, bin } = source instanceof Uint8Array || ArrayBuffer.isView(source) || source instanceof ArrayBuffer ? parseGlb(asBytes(source)) : source;
  const kind = opts.kind || 'worn';
  if (kind !== 'worn' && kind !== 'pin') throw new Error(`kind must be "worn" or "pin", not "${kind}"`);
  const human = humanoidOf(json);
  if (!human) throw new Error('the source is not a VRM 1.0 (no VRMC_vrm humanoid); convert a VRM 0.x first');
  const prims = opts.prims || [];
  if (!prims.length) throw new Error('no primitives were given for the item');
  for (const [mi, pi] of prims) if (!json.meshes?.[mi]?.primitives?.[pi]) throw new Error(`primitive ${mi}/${pi} does not exist`);
  if (kind === 'pin' && human.nodeOfBone[opts.attach] === undefined) throw new Error(`the source has no humanoid bone "${opts.attach}" to pin to`);
  const extraBones = (opts.bones || []).filter((b) => b !== opts.attach);
  for (const b of extraBones) if (human.nodeOfBone[b] === undefined) throw new Error(`the source has no humanoid bone "${b}"`);
  const thresh = opts.weightThreshold ?? 0.05;
  const label = opts.name || 'item';
  const nodes = json.nodes || [];
  const parentOf = parents(nodes);
  const humanoidNodes = new Set(human.boneOfNode.keys());
  const nearestHumanoid = (node) => {
    for (let c = node, hops = 0; c !== undefined && hops < 256; c = parentOf.get(c), hops++) if (humanoidNodes.has(c)) return c;
    return null;
  };

  // primitives grouped by source mesh, in the order given
  const byMesh = new Map();
  for (const [mi, pi] of prims) {
    if (!byMesh.has(mi)) byMesh.set(mi, []);
    if (!byMesh.get(mi).includes(pi)) byMesh.get(mi).push(pi);
  }
  const holderOf = (mi) => nodes.findIndex((n) => n.mesh === mi);

  // the source nodes this item's vertices weight (above the threshold): decides which springs come along
  const weighted = new Set();
  const accCache = new Map();
  const read = (ai) => {
    if (!accCache.has(ai)) accCache.set(ai, readAccessor(json, bin, ai));
    return accCache.get(ai);
  };
  const usedVerts = (p) => {
    if (p.indices === undefined) return Array.from({ length: json.accessors[p.attributes.POSITION].count }, (_, i) => i);
    return [...new Set(read(p.indices))].sort((a, b) => a - b);
  };
  for (const [mi, pis] of byMesh) {
    const h = holderOf(mi);
    if (h < 0) throw new Error(`mesh ${mi} is not used by any node`);
    const skinI = nodes[h].skin;
    if (kind === 'worn' && skinI === undefined) throw new Error(`mesh ${mi} has no skin: every mesh of a worn item must be skinned (VRMXW §5.3)`);
    if (skinI === undefined) continue;
    const joints = json.skins[skinI].joints;
    for (const pi of pis) {
      const p = json.meshes[mi].primitives[pi];
      for (const set of ['0', '1']) {
        if (p.attributes[`JOINTS_${set}`] === undefined) continue;
        const J = read(p.attributes[`JOINTS_${set}`]);
        const W = read(p.attributes[`WEIGHTS_${set}`]);
        for (const v of usedVerts(p)) for (let k = 0; k < 4; k++) if (W[v * 4 + k] > thresh && J[v * 4 + k] < joints.length) weighted.add(joints[J[v * 4 + k]]);
      }
    }
  }

  // the donor body's own secondary bones: folded into the humanoid ancestor, never the item's own chain (#41)
  const body = new Set(opts.bodyBones || []);
  nodes.forEach((n, i) => { if (/^J_Sec_.*Bust/i.test(n?.name || '')) body.add(i); });
  // springs whose joints the item weights, with their colliders (worn items only), less the body's own
  const sbSrc = json.extensions?.VRMC_springBone;
  const springs = kind === 'worn' && Array.isArray(sbSrc?.springs)
    ? sbSrc.springs.filter((s) => (s.joints || []).some((j) => weighted.has(j.node)) && !(s.joints || []).some((j) => body.has(j.node)))
    : [];
  const springJoints = new Set(springs.flatMap((s) => (s.joints || []).map((j) => j.node)));
  const usedGroups = [...new Set(springs.flatMap((s) => s.colliderGroups || []))].sort((a, b) => a - b);
  const usedColliders = [...new Set(usedGroups.flatMap((gi) => sbSrc.colliderGroups[gi]?.colliders || []))].sort((a, b) => a - b);

  const g = { asset: { version: '2.0', generator: opts.generator || 'VRMXA reference library (vrmxa-core)' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], skins: [], materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [], buffers: [] };
  const w = new BinWriter(g);
  const extUsed = new Set();

  // ---- materials, textures, images, samplers: each copied once
  const texMap = new Map(), imgMap = new Map(), sampMap = new Map(), matMap = new Map();
  const addImage = (ii) => {
    if (imgMap.has(ii)) return imgMap.get(ii);
    const img = json.images[ii];
    if (img.bufferView === undefined) throw new Error(`image ${ii} is outside the file; a model must be self-contained`);
    const out = { bufferView: w.view(bufferViewBytes(json, bin, img.bufferView)), mimeType: img.mimeType || 'image/png' };
    if (img.name) out.name = img.name;
    g.images.push(out);
    imgMap.set(ii, g.images.length - 1);
    return g.images.length - 1;
  };
  const addSampler = (si) => {
    if (sampMap.has(si)) return sampMap.get(si);
    g.samplers.push(clone(json.samplers[si]));
    sampMap.set(si, g.samplers.length - 1);
    return g.samplers.length - 1;
  };
  const addTexture = (ti) => {
    if (texMap.has(ti)) return texMap.get(ti);
    const t = json.textures[ti];
    const out = {};
    if (t.sampler !== undefined) out.sampler = addSampler(t.sampler);
    if (t.source !== undefined) out.source = addImage(t.source);
    if (t.name) out.name = t.name;
    if (t.extensions) throw new Error(`texture ${ti} uses an extension (${Object.keys(t.extensions).join(', ')}) an item may not carry`);
    g.textures.push(out);
    texMap.set(ti, g.textures.length - 1);
    return g.textures.length - 1;
  };
  const addMaterial = (mi) => {
    if (matMap.has(mi)) return matMap.get(mi);
    const mat = clone(json.materials[mi]);
    const refs = [];
    textureRefs(mat, refs);
    for (const ref of refs) ref.index = addTexture(ref.index);
    for (const e of extensionNames({ extensions: mat.extensions, all: mat }, new Set())) extUsed.add(e);
    g.materials.push(mat);
    matMap.set(mi, g.materials.length - 1);
    return g.materials.length - 1;
  };

  // ---- meshes
  const meshOut = []; // { srcMesh, holder, skinSrc, joints: [srcNode…], ibm: Float32Array, prims }
  for (const [mi, pis] of byMesh) {
    const srcMesh = json.meshes[mi];
    const h = holderOf(mi);
    const skinI = nodes[h].skin;
    const skinJoints = skinI !== undefined ? json.skins[skinI].joints : null;
    const keepSkin = kind === 'worn';
    // donor slot → slot it skins to: humanoid bones and carried spring joints stay; any other bone's
    // weight moves to its nearest humanoid ancestor (VRMXW §5.3 rule 3)
    const redirect = keepSkin
      ? skinJoints.map((node, slot) => {
        if (humanoidNodes.has(node) || springJoints.has(node)) return slot;
        const anc = nearestHumanoid(node);
        const s = anc === null ? -1 : skinJoints.indexOf(anc);
        return s; // -1: no humanoid ancestor in the skin; refused below only if a vertex leans on it
      })
      : null;
    // where weight on a joint with no humanoid ancestor goes: a skin often lists the armature's root, unweighted
    const fallbackSlot = keepSkin ? skinJoints.indexOf(human.nodeOfBone.hips) : -1;
    const outPrims = [];
    const usedSlots = new Set();
    for (const pi of pis) {
      const p = srcMesh.primitives[pi];
      if ((p.mode ?? 4) !== 4) throw new Error(`primitive ${mi}/${pi} is not made of triangles`);
      const used = usedVerts(p);
      const remap = new Map(used.map((v, i) => [v, i]));
      const attrs = {};
      for (const [name, ai] of Object.entries(p.attributes)) {
        if (/^(JOINTS|WEIGHTS)_\d+$/.test(name)) continue;
        attrs[name] = subsetAttribute(json, bin, ai, used);
      }
      let joints = null, weights = null;
      if (keepSkin) {
        if (p.attributes.JOINTS_0 === undefined) throw new Error(`primitive ${mi}/${pi} of a worn item has no skin weights`);
        const sets = ['0', '1'].filter((s) => p.attributes[`JOINTS_${s}`] !== undefined);
        const Js = sets.map((s) => read(p.attributes[`JOINTS_${s}`]));
        const Ws = sets.map((s) => read(p.attributes[`WEIGHTS_${s}`]));
        joints = new Uint16Array(used.length * 4);
        weights = new Float32Array(used.length * 4);
        used.forEach((v, i) => {
          const agg = new Map();
          for (let s = 0; s < Js.length; s++)
            for (let k = 0; k < 4; k++) {
              const wt = Ws[s][v * 4 + k];
              if (!(wt > 0)) continue;
              const slot = Js[s][v * 4 + k];
              if (slot >= redirect.length) continue;
              const to = redirect[slot];
              if (to < 0) {
                if (wt > 0.5) throw new Error(`mesh ${mi}: joint node ${skinJoints[slot]} carries weight but has no humanoid ancestor in the skin`);
                continue; // a trace of weight on the armature's root: dropped, the rest renormalised
              }
              agg.set(to, (agg.get(to) || 0) + wt);
            }
          let pairs = [...agg.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
          if (!pairs.length) {
            const to = redirect.find((x) => x >= 0) ?? fallbackSlot;
            if (to === undefined || to < 0) throw new Error(`mesh ${mi}: a vertex has no weight on any humanoid bone`);
            pairs = [[to, 1]];
          }
          const tot = pairs.reduce((acc, [, x]) => acc + x, 0) || 1;
          pairs.forEach(([slot, x], k) => {
            joints[i * 4 + k] = slot;
            weights[i * 4 + k] = x / tot;
            usedSlots.add(slot);
          });
        });
      }
      let indices = null;
      if (p.indices !== undefined) {
        const idx = read(p.indices);
        indices = used.length < 65536 ? new Uint16Array(idx.length) : new Uint32Array(idx.length);
        for (let i = 0; i < idx.length; i++) indices[i] = remap.get(idx[i]);
      }
      const targets = (p.targets || []).map((t) => Object.fromEntries(Object.entries(t).map(([name, ai]) => [name, subsetAttribute(json, bin, ai, used)])));
      outPrims.push({ attrs, joints, weights, indices, targets, material: p.material, extras: p.extras, used: used.length });
    }
    meshOut.push({ srcMesh, mi, holder: h, skinI, skinJoints, usedSlots, prims: outPrims });
  }

  // ---- which source nodes the model keeps: skin joints that carry weight, spring joints, collider
  // nodes, the pin bone and any extra bones, and every ancestor of those
  const keep = new Set();
  const keepWithAncestors = (n) => {
    for (let c = n, hops = 0; c !== undefined && hops < 256 && !keep.has(c); c = parentOf.get(c), hops++) keep.add(c);
  };
  for (const m of meshOut) if (kind === 'worn') for (const s of m.usedSlots) keepWithAncestors(m.skinJoints[s]);
  for (const n of springJoints) keepWithAncestors(n);
  for (const ci of usedColliders) keepWithAncestors(sbSrc.colliders[ci].node);
  if (kind === 'pin') keepWithAncestors(human.nodeOfBone[opts.attach]);
  for (const b of extraBones) keepWithAncestors(human.nodeOfBone[b]);
  const kept = [...keep].sort((a, b) => a - b);
  const nodeMap = new Map(kept.map((n, i) => [n, i]));
  for (const n of kept) {
    const src = nodes[n];
    const out = {};
    for (const k of ['name', 'translation', 'rotation', 'scale', 'matrix']) if (src[k] !== undefined) out[k] = clone(src[k]);
    const ch = (src.children || []).filter((c) => nodeMap.has(c)).map((c) => nodeMap.get(c));
    if (ch.length) out.children = ch;
    g.nodes.push(out);
  }
  for (const n of kept) if (!nodeMap.has(parentOf.get(n))) g.scenes[0].nodes.push(nodeMap.get(n));

  // ---- write meshes, skins and their nodes
  const meshNodes = [];
  for (const m of meshOut) {
    let slotMap = null;
    let skinOut;
    if (kind === 'worn') {
      const slots = [...m.usedSlots].sort((a, b) => a - b);
      slotMap = new Map(slots.map((s, i) => [s, i]));
      const ibmSrc = json.skins[m.skinI].inverseBindMatrices !== undefined ? readAccessor(json, bin, json.skins[m.skinI].inverseBindMatrices) : null;
      const ibm = new Float32Array(slots.length * 16);
      slots.forEach((s, i) => ibm.set(ibmSrc ? ibmSrc.subarray(s * 16, s * 16 + 16) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], i * 16));
      skinOut = { inverseBindMatrices: w.accessor(ibm, 5126, 'MAT4', { count: slots.length }), joints: slots.map((s) => nodeMap.get(m.skinJoints[s])) };
      const skel = json.skins[m.skinI].skeleton;
      if (skel !== undefined && nodeMap.has(skel)) skinOut.skeleton = nodeMap.get(skel);
    }
    const primsOut = m.prims.map((p) => {
      const attributes = {};
      for (const [name, a] of Object.entries(p.attrs)) {
        const acc = w.accessor(a.data, a.componentType, a.type, { target: 34962, minmax: name === 'POSITION' });
        if (a.normalized) g.accessors[acc].normalized = true;
        attributes[name] = acc;
      }
      if (p.joints) {
        for (let i = 0; i < p.joints.length; i++) p.joints[i] = p.weights[i] > 0 ? slotMap.get(p.joints[i]) : 0;
        attributes.JOINTS_0 = w.accessor(p.joints, 5123, 'VEC4', { target: 34962 });
        attributes.WEIGHTS_0 = w.accessor(p.weights, 5126, 'VEC4', { target: 34962 });
      }
      const out = { attributes };
      if (p.indices) out.indices = w.accessor(p.indices, p.indices instanceof Uint16Array ? 5123 : 5125, 'SCALAR', { target: 34963 });
      if (p.material !== undefined) out.material = addMaterial(p.material);
      out.mode = 4;
      if (p.targets.length) out.targets = p.targets.map((t) => Object.fromEntries(Object.entries(t).map(([name, a]) => [name, w.accessor(a.data, a.componentType, a.type, { minmax: name === 'POSITION' })])));
      if (p.extras) out.extras = clone(p.extras);
      return out;
    });
    const mesh = { name: `${label}_${m.srcMesh.name || m.mi}`, primitives: primsOut };
    if (m.srcMesh.weights) mesh.weights = clone(m.srcMesh.weights);
    const targetNames = m.srcMesh.extras?.targetNames;
    if (Array.isArray(targetNames) && primsOut.some((p) => p.targets)) mesh.extras = { targetNames: clone(targetNames) };
    g.meshes.push(mesh);
    const node = { name: mesh.name, mesh: g.meshes.length - 1 };
    if (kind === 'worn') {
      g.skins.push(skinOut);
      node.skin = g.skins.length - 1;
      g.nodes.push(node);
      g.scenes[0].nodes.push(g.nodes.length - 1);
    } else {
      // pinned: a child of the bone's node, placed where it sits on Spec. A skinned source mesh is in
      // bind space (its world at rest is the identity); an unskinned one is where its node puts it.
      const boneSrc = human.nodeOfBone[opts.attach];
      const meshWorld = m.skinI !== undefined ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : worldMatrix(nodes, m.holder, parentOf);
      const boneInv = invert(worldMatrix(nodes, boneSrc, parentOf));
      if (!boneInv) throw new Error(`the bone "${opts.attach}" has a singular rest transform`);
      const local = tidy(multiply(boneInv, meshWorld));
      if (!isIdentity(local)) node.matrix = local;
      g.nodes.push(node);
      const parent = g.nodes[nodeMap.get(boneSrc)];
      parent.children = [...(parent.children || []), g.nodes.length - 1];
    }
    meshNodes.push({ node: g.nodes.length - 1, name: mesh.name });
  }

  // ---- springs and colliders, re-indexed
  if (springs.length) {
    const gmap = new Map(usedGroups.map((gi, i) => [gi, i]));
    const cmap = new Map(usedColliders.map((ci, i) => [ci, i]));
    const colliders = usedColliders.map((ci) => ({ ...clone(sbSrc.colliders[ci]), node: nodeMap.get(sbSrc.colliders[ci].node) }));
    const colliderGroups = usedGroups.map((gi) => ({ ...clone(sbSrc.colliderGroups[gi]), colliders: (sbSrc.colliderGroups[gi].colliders || []).map((c) => cmap.get(c)) }));
    const springsOut = springs.map((s) => {
      const o = clone(s);
      o.joints = (s.joints || []).map((j) => ({ ...clone(j), node: nodeMap.get(j.node) }));
      if (s.colliderGroups) o.colliderGroups = s.colliderGroups.map((gi) => gmap.get(gi));
      if (s.center !== undefined) {
        if (nodeMap.has(s.center)) o.center = nodeMap.get(s.center);
        else delete o.center;
      }
      return o;
    });
    const ext = { specVersion: sbSrc.specVersion || '1.0' };
    if (colliders.length) ext.colliders = colliders;
    if (colliderGroups.length) ext.colliderGroups = colliderGroups;
    ext.springs = springsOut;
    g.extensions = { VRMC_springBone: ext };
    extUsed.add('VRMC_springBone');
    for (const e of extensionNames(ext, new Set())) extUsed.add(e);
  }

  // ---- tidy up and assemble: node names unique, so a state's `show` can name meshes (VRMXW §8, #44)
  uniqueNodeNames(g.nodes);
  for (const m of meshNodes) m.name = g.nodes[m.node].name;
  for (const k of ['skins', 'materials', 'textures', 'images', 'samplers']) if (!g[k].length) delete g[k];
  if (extUsed.size) g.extensionsUsed = [...extUsed].sort();
  const binOut = w.bytes();
  g.buffers = [{ byteLength: binOut.length }];
  const rig = { humanBones: {} };
  for (const b of HUMAN_BONES) {
    const n = human.nodeOfBone[b];
    if (n !== undefined && nodeMap.has(n)) rig.humanBones[b] = nodeMap.get(n);
  }
  return {
    glb: buildGlb(g, binOut),
    rig,
    springs: springs.length,
    colliders: usedColliders.length,
    nodes: g.nodes.length,
    meshes: meshNodes,
  };
}
