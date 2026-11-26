// Putting a worn item's model into an avatar's glTF: the hair piece chosen in Appearance (VRMXA §6,
// D4; EDITS.md §3.2's `hair` colour applies to it). The item is fitted to Spec (VRMXW §2), so its
// humanoid joints are the avatar's: they map by humanoid role (the item's `rig.humanBones`), then by
// node name; any other bone (a hair chain) is added under the bone it hangs from, with its own rest
// transform. Meshes, materials, textures, skins and the item's spring bones and colliders come along.
//

import { readAccessor } from '../glb.js';

const pad4 = (n) => (n + 3) & ~3;

/** Material extras key that marks where a material came from, so the hair colour finds it. */
export const HAIR_MARK = 'vrmxaHair';

/**
 * Merge an item model into the avatar, in place. json/bin: the avatar (bin is not modified; a new
 * one is returned). item: { json, bin } of the item's model.glb; humanBones: role → item node index
 * (the item manifest's rig.humanBones); mark: written into each new material's extras[HAIR_MARK].
 * → { bin, materials: [indices of the materials added], nodes: [indices of the nodes added] }
 */
export function mergeItemModel(json, bin, item, { humanBones = {}, mark = null } = {}) {
  const I = item.json;
  for (const k of ['nodes', 'meshes', 'materials', 'textures', 'images', 'samplers', 'accessors', 'bufferViews', 'skins']) json[k] = json[k] || [];
  json.extensionsUsed = json.extensionsUsed || [];
  const scene = json.scenes[json.scene || 0];

  // the item's binary chunk goes at the end of the avatar's
  const base = pad4(bin.length);
  const out = new Uint8Array(base + item.bin.length);
  out.set(bin, 0);
  out.set(item.bin, base);
  if (json.buffers?.[0]) json.buffers[0].byteLength = out.length;
  else json.buffers = [{ byteLength: out.length }];

  const off = {
    bv: json.bufferViews.length, acc: json.accessors.length, img: json.images.length, tex: json.textures.length,
    samp: json.samplers.length, mat: json.materials.length, mesh: json.meshes.length, skin: json.skins.length,
  };
  for (const bv of I.bufferViews || []) json.bufferViews.push({ ...bv, buffer: 0, byteOffset: (bv.byteOffset || 0) + base });
  for (const a of I.accessors || []) {
    const c = JSON.parse(JSON.stringify(a));
    if (c.bufferView !== undefined) c.bufferView += off.bv;
    if (c.sparse) { c.sparse.indices.bufferView += off.bv; c.sparse.values.bufferView += off.bv; }
    json.accessors.push(c);
  }
  for (const s of I.samplers || []) json.samplers.push({ ...s });
  for (const im of I.images || []) { const c = { ...im }; if (c.bufferView !== undefined) c.bufferView += off.bv; json.images.push(c); }
  for (const t of I.textures || []) {
    const c = JSON.parse(JSON.stringify(t));
    if (c.sampler !== undefined) c.sampler += off.samp;
    if (c.source !== undefined) c.source += off.img;
    for (const e of Object.values(c.extensions || {})) if (typeof e.source === 'number') e.source += off.img;
    json.textures.push(c);
  }
  const remapTextures = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') {
        if (/Texture$/i.test(k) && typeof v.index === 'number') v.index += off.tex;
        remapTextures(v);
      }
    }
  };
  const materials = [];
  for (const m of I.materials || []) {
    const c = JSON.parse(JSON.stringify(m));
    remapTextures(c);
    if (mark) c.extras = { ...(c.extras || {}), [HAIR_MARK]: mark };
    json.materials.push(c);
    materials.push(json.materials.length - 1);
  }
  for (const m of I.meshes || []) {
    const c = JSON.parse(JSON.stringify(m));
    for (const p of c.primitives || []) {
      for (const k of Object.keys(p.attributes || {})) p.attributes[k] += off.acc;
      if (p.indices !== undefined) p.indices += off.acc;
      if (p.material !== undefined) p.material += off.mat;
      for (const t of p.targets || []) for (const k of Object.keys(t)) t[k] += off.acc;
    }
    json.meshes.push(c);
  }
  for (const e of I.extensionsUsed || []) if (!json.extensionsUsed.includes(e)) json.extensionsUsed.push(e);

  // nodes: humanoid role first, then name, else a new node under its (mapped) parent
  const avatarBones = json.extensions?.VRMC_vrm?.humanoid?.humanBones || {};
  const byRole = new Map();
  for (const [role, i] of Object.entries(humanBones)) if (avatarBones[role]?.node != null) byRole.set(i, avatarBones[role].node);
  const byName = new Map();
  json.nodes.forEach((n, i) => { if (n.name && !byName.has(n.name)) byName.set(n.name, i); });
  const parentOf = new Map();
  (I.nodes || []).forEach((n, i) => (n.children || []).forEach((c) => parentOf.set(c, i)));
  const map = new Map();
  const added = [];
  const ensure = (i) => {
    if (map.has(i)) return map.get(i);
    const n = I.nodes[i];
    let target;
    if (byRole.has(i)) target = byRole.get(i);
    else if (n.mesh === undefined && n.name && byName.has(n.name)) target = byName.get(n.name);
    else {
      const parent = parentOf.has(i) ? ensure(parentOf.get(i)) : null;
      const c = { name: n.name };
      for (const k of ['translation', 'rotation', 'scale', 'matrix']) if (n[k]) c[k] = n[k];
      if (n.extras && typeof n.extras === 'object') c.extras = JSON.parse(JSON.stringify(n.extras));
      target = json.nodes.length;
      json.nodes.push(c);
      added.push(target);
      if (n.name && n.mesh === undefined) byName.set(n.name, target);
      if (parent != null) (json.nodes[parent].children ||= []).push(target);
      else scene.nodes.push(target);
    }
    map.set(i, target);
    return target;
  };
  const jointSet = new Set();
  for (const s of I.skins || []) s.joints.forEach((j) => jointSet.add(j));
  for (const j of jointSet) ensure(j);
  for (const s of I.skins || []) {
    json.skins.push({
      ...(s.name ? { name: s.name } : {}),
      joints: s.joints.map((j) => map.get(j)),
      ...(s.inverseBindMatrices !== undefined ? { inverseBindMatrices: s.inverseBindMatrices + off.acc } : {}),
      ...(s.skeleton !== undefined ? { skeleton: ensure(s.skeleton) } : {}),
    });
  }
  (I.nodes || []).forEach((n, i) => {
    if (n.mesh === undefined) return;
    const t = ensure(i);
    json.nodes[t].mesh = n.mesh + off.mesh;
    if (n.skin !== undefined) {
      json.nodes[t].skin = n.skin + off.skin;
      // a skinned mesh's own transform is ignored by glTF: keep it at rest
      for (const k of ['translation', 'rotation', 'scale', 'matrix']) delete json.nodes[t][k];
    }
  });
  // nodes the item uses only as spring joints or colliders
  const isb = I.extensions?.VRMC_springBone;
  for (const c of isb?.colliders || []) if (Number.isInteger(c.node)) ensure(c.node);
  for (const s of isb?.springs || []) for (const j of s.joints || []) if (Number.isInteger(j.node)) ensure(j.node);

  // spring bones: colliders, groups and springs, re-indexed
  if (isb && (isb.springs?.length || isb.colliders?.length)) {
    json.extensions = json.extensions || {};
    const sb = (json.extensions.VRMC_springBone ||= { specVersion: isb.specVersion || '1.0' });
    sb.colliders ||= []; sb.colliderGroups ||= []; sb.springs ||= [];
    const cOff = sb.colliders.length, gOff = sb.colliderGroups.length;
    for (const c of isb.colliders || []) sb.colliders.push({ ...JSON.parse(JSON.stringify(c)), node: map.get(c.node) });
    for (const g of isb.colliderGroups || []) sb.colliderGroups.push({ ...JSON.parse(JSON.stringify(g)), colliders: (g.colliders || []).map((k) => k + cOff) });
    for (const s of isb.springs || []) {
      const c = JSON.parse(JSON.stringify(s));
      c.joints = (c.joints || []).map((j) => ({ ...j, node: map.get(j.node) }));
      if (c.colliderGroups) c.colliderGroups = c.colliderGroups.map((k) => k + gOff);
      if (Number.isInteger(c.center)) c.center = map.get(c.center) ?? ensure(c.center);
      sb.springs.push(c);
    }
    if (!json.extensionsUsed.includes('VRMC_springBone')) json.extensionsUsed.push('VRMC_springBone');
  }
  return { bin: out, materials, nodes: added };
}

/** A role → node map from an item model alone, when its manifest's rig is not at hand: by node name against the avatar's. */
export function rigByName(itemJson, avatarJson) {
  const names = new Map();
  for (const [role, b] of Object.entries(avatarJson.extensions?.VRMC_vrm?.humanoid?.humanBones || {})) {
    const n = avatarJson.nodes[b.node]?.name;
    if (n) names.set(n, role);
  }
  const out = {};
  (itemJson.nodes || []).forEach((n, i) => { const r = names.get(n.name); if (r && out[r] == null) out[r] = i; });
  return out;
}

/** The item model's vertex count, for a short report. */
export function vertexCount(json, bin) {
  let n = 0;
  for (const m of json.meshes || []) for (const p of m.primitives || []) if (p.attributes?.POSITION != null) n += readAccessor(json, bin, p.attributes.POSITION).length / 3;
  return n;
}
