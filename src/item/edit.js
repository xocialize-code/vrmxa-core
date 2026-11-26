// Editing an item (PRD ITM-1 to ITM-12; VRMXW §3 to §13). Every function takes an item ({ manifest, entries },
// as readItem or createItem gives it) and returns a new one; the one passed in is not changed, so an app keeps
// it for undo. The model is changed only by the one writer's own data edits (splitting parts into meshes,
// re-pinning, spring settings), never by three.js's exporter, so MToon and springs stay as authored (ITM-2).
// Saving is `saveItem`: the next revision (ITM-10), written and checked (ITM-12).

import { clone, newUuid, nowIso, isPlainObject } from '../bytes.js';
import { parseGlb, buildGlb } from '../glb.js';
import { sha256, sha12 } from '../hash.js';
import { invert, multiply, parents, worldMatrix } from '../math.js';
import { checkItem, checkModel } from '../checker.js';
import { writeItem, touchItem, duplicateItem } from '../vrmxw.js';
import { ITEM_TYPES, resolveItemType, TAG_RE, META_ENUMS, META_BOOLEANS, META_STRINGS, HUMAN_BONE_SET, ANIMATION_SLOTS } from '../vocab.js';
import { decompose } from '../closet/fit.js';
import { showToNodes, uniqueNodeNames } from '../show.js';

export class ItemEditError extends Error {
  constructor(code, message) { super(message); this.name = 'ItemEditError'; this.code = code; }
}
const fail = (code, message) => { throw new ItemEditError(code, message); };

const nodesOf = (item) => parseGlb(item.entries.get(item.manifest.model?.file || 'model.glb')).json.nodes || [];
// a `show` list as the item stores it: mesh node names, sorted by node (VRMXW §8, SPEC-QUESTIONS #44)
const namesOf = (nodes, indices) => [...new Set(indices)].sort((a, b) => a - b).map((i) => nodes[i]?.name || String(i));

const copy = (item) => ({ kind: 'vrmxw', manifest: clone(item.manifest), entries: new Map(item.entries), problems: [] });
const modelOf = (item) => item.entries.get(item.manifest.model?.file || 'model.glb');
const withModel = (item, json, bin) => { item.entries.set(item.manifest.model?.file || 'model.glb', buildGlb(json, bin)); return item; };

// ---- reading -------------------------------------------------------------------------------------------

/** The item's meshes, for the Parts tree and the state editor: [{ node, name, prims, triangles, morphs, skinned, springs }]. */
export function itemMeshes(item) {
  const { json } = parseGlb(modelOf(item));
  const springJoints = new Set((json.extensions?.VRMC_springBone?.springs || []).flatMap((s) => (s.joints || []).map((j) => j.node)));
  return (json.nodes || []).flatMap((n, i) => {
    if (n.mesh === undefined) return [];
    const m = json.meshes[n.mesh];
    const triangles = m.primitives.reduce((t, p) => t + (p.indices !== undefined ? json.accessors[p.indices].count / 3 : json.accessors[p.attributes.POSITION].count / 3), 0);
    const skin = n.skin !== undefined ? json.skins[n.skin] : null;
    return [{
      node: i, name: n.name || m.name || `Mesh ${i}`, prims: m.primitives.length, triangles: Math.round(triangles),
      materials: m.primitives.map((p) => json.materials?.[p.material]?.name || null),
      morphs: Array.isArray(m.extras?.targetNames) ? [...m.extras.targetNames] : [], skinned: !!skin,
      springs: skin ? skin.joints.some((j) => springJoints.has(j)) : false,
    }];
  });
}

/** The item's spring chains with their settings (Movement): [{ index, name, joints, stiffness, gravityPower, dragForce }]. */
export function itemSprings(item) {
  const { json } = parseGlb(modelOf(item));
  return (json.extensions?.VRMC_springBone?.springs || []).map((s, index) => {
    const j = (s.joints || [])[0] || {};
    return { index, name: s.name || `Chain ${index + 1}`, joints: (s.joints || []).length, stiffness: j.stiffness ?? 1, gravityPower: j.gravityPower ?? 0, dragForce: j.dragForce ?? 0.5 };
  });
}

/** The tags an item can carry, everything it carries in any state. */
export const allTags = (m) => [...new Set([...(m.tags || []), ...(m.states || []).flatMap((s) => s.tags || [])])];

// ---- how it is worn (ITM-4) -------------------------------------------------------------------------------

export function setName(item, name) {
  const n = String(name || '').trim();
  if (!n) fail('item.name', 'an item needs a name');
  const it = copy(item);
  it.manifest.name = n.slice(0, 120);
  return it;
}

/**
 * Change what it is and how it is worn: type (and with it the slot and fit rule of VRMXW §6), layer, the fit
 * rule's keys (method, class, ease, hemAnchor; lift for shoes), the bone a pinned item follows. A worn item
 * can't become pinned here or the other way round: that is the model's own build (the four steps).
 */
export function setWear(item, { type, slot, layer, fit, attach } = {}) {
  const it = copy(item);
  const m = it.manifest;
  if (type !== undefined && type !== m.type) {
    const t = resolveItemType(type, slot ?? m.slot, m.kind);
    if (!t) fail('item.type', `"${type}" is not an item type (VRMXW §6)`);
    if (!t.vendor && t.kind !== m.kind) fail('item.kind', `a ${type} is ${t.kind === 'pin' ? 'pinned to a bone' : 'worn on the body'}, and this item is ${m.kind === 'pin' ? 'pinned' : 'worn'}: make it again from its model to change that`);
    m.type = type;
    m.slot = slot ?? t.slot;
    if (!t.vendor) m.fit = clone(t.fit);
    if (type !== 'shoes') delete m.fit.lift;
  } else if (slot !== undefined) m.slot = slot;
  if (layer !== undefined) { if (!Number.isInteger(layer) || layer < 0 || layer > 9) fail('item.layer', 'the layer is a whole number from 0 to 9'); m.layer = layer; }
  if (fit !== undefined) {
    const f = { ...m.fit, ...fit };
    if (f.method !== 'spec-fit') { delete f.class; delete f.ease; delete f.hemAnchor; }
    if (m.slot !== 'shoes') delete f.lift;
    else if (f.lift !== undefined && !(Number.isFinite(f.lift) && f.lift >= 0 && f.lift < 0.3)) fail('item.lift', 'the lift is metres, from 0 to 0.3');
    m.fit = f;
  }
  if (attach !== undefined && m.kind === 'pin' && attach !== m.attach?.bone) return repin(it, attach);
  return it;
}

/** Move a pinned item's nodes under another humanoid bone, keeping where they sit on Spec (VRMXW §5.4 rule 1). */
export function repin(item, bone) {
  const it = copy(item);
  const m = it.manifest;
  if (m.kind !== 'pin') fail('item.kind', 'only a pinned item follows one bone');
  if (!HUMAN_BONE_SET.has(bone)) fail('item.bone', `"${bone}" is not a humanoid bone`);
  const to = m.rig.humanBones[bone];
  if (to === undefined) fail('item.bone', `the item's model has no ${bone} bone: it carries only ${Object.keys(m.rig.humanBones).join(', ')}`);
  const from = m.rig.humanBones[m.attach?.bone];
  const p = parseGlb(modelOf(it));
  const json = clone(p.json);
  const pOf = parents(json.nodes);
  const moving = (json.nodes[from]?.children || []).filter((c) => !Object.values(m.rig.humanBones).includes(c));
  const toInv = invert(worldMatrix(json.nodes, to, pOf));
  for (const c of moving) {
    const w = worldMatrix(json.nodes, c, pOf);
    const d = decompose(multiply(toInv, w));
    delete json.nodes[c].matrix;
    Object.assign(json.nodes[c], { translation: d.translation, rotation: d.rotation, scale: d.scale });
  }
  json.nodes[from].children = (json.nodes[from].children || []).filter((c) => !moving.includes(c));
  if (!json.nodes[from].children.length) delete json.nodes[from].children;
  json.nodes[to].children = [...(json.nodes[to].children || []), ...moving];
  m.attach = { bone };
  return withModel(it, json, p.bin);
}

// ---- states (ITM-5; VRMXW §8) -------------------------------------------------------------------------------

function cleanState(item, s, others) {
  const m = item.manifest;
  const name = String(s.name || '').trim();
  if (!name) fail('state.name', 'a state needs a name');
  if (others.some((o) => o.name === name)) fail('state.name', `there is already a state called "${name}"`);
  const out = { name };
  out.tags = [...new Set(s.tags || [])];
  for (const t of out.tags) if (!TAG_RE.test(t)) fail('state.tag', `"${t}" is not a tag: namespace:value, each part a-z, 0-9, dot, dash or underscore`);
  if (s.bone !== undefined && s.bone !== null) {
    if (m.kind !== 'pin') fail('state.bone', 'only a pinned item follows a bone in a state');
    if (m.rig.humanBones[s.bone] === undefined) fail('state.bone', `the item's model has no ${s.bone} bone (it carries ${Object.keys(m.rig.humanBones).join(', ')})`);
    out.bone = s.bone;
  }
  if (s.matrix !== undefined && s.matrix !== null) {
    if (m.kind !== 'pin') fail('state.matrix', 'only a pinned item is placed in a state');
    if (!Array.isArray(s.matrix) || s.matrix.length !== 16 || !s.matrix.every(Number.isFinite)) fail('state.matrix', 'a placement is 16 numbers, column-major');
    out.matrix = s.matrix.map((v) => Math.round(v * 1e6) / 1e6);
  }
  const meshes = itemMeshes(item);
  if (s.show !== undefined && s.show !== null) {
    // meshes by node name; a node index is accepted from a caller and stored as the node's name
    const nodes = nodesOf(item);
    const idx = [];
    for (const n of s.show) {
      const i = showToNodes(nodes, [n])[0];
      if (i === undefined) fail('state.show', `${typeof n === 'string' ? `"${n}"` : `node ${n}`} is not one of the item's meshes`);
      idx.push(i);
    }
    out.show = namesOf(nodes, idx);
  }
  if (s.morphs && Object.keys(s.morphs).length) {
    const names = new Set(meshes.flatMap((x) => x.morphs));
    out.morphs = {};
    for (const [k, v] of Object.entries(s.morphs)) {
      if (!names.has(k)) fail('state.morph', `"${k}" is not a morph target of the item`);
      if (!(Number.isFinite(v) && v >= 0 && v <= 1)) fail('state.morph', `${k}: a weight from 0 to 1`);
      if (v > 0) out.morphs[k] = Math.round(v * 1000) / 1000;
    }
    if (!Object.keys(out.morphs).length) delete out.morphs;
  }
  return out;
}

/** Add a state at the end (the first is the default). */
export function addState(item, state) {
  const it = copy(item);
  const states = it.manifest.states || [];
  it.manifest.states = [...states, cleanState(it, state, states)];
  return it;
}

/** Change a state (by name): any of name, tags, bone, matrix, show, morphs; null removes a key. */
export function updateState(item, name, patch) {
  const it = copy(item);
  const states = it.manifest.states || [];
  const i = states.findIndex((s) => s.name === name);
  if (i < 0) fail('state.none', `there is no state "${name}"`);
  const merged = { ...states[i], ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete merged[k];
  states[i] = cleanState(it, merged, states.filter((_, j) => j !== i));
  it.manifest.states = states;
  return it;
}

export function removeState(item, name) {
  const it = copy(item);
  const states = it.manifest.states || [];
  if (!states.some((s) => s.name === name)) fail('state.none', `there is no state "${name}"`);
  it.manifest.states = states.filter((s) => s.name !== name);
  return it;
}

/** Make a state the default (first) or move it: `to` is its new index. */
export function moveState(item, name, to) {
  const it = copy(item);
  const states = it.manifest.states || [];
  const i = states.findIndex((s) => s.name === name);
  if (i < 0) fail('state.none', `there is no state "${name}"`);
  const [s] = states.splice(i, 1);
  states.splice(Math.max(0, Math.min(states.length, to)), 0, s);
  it.manifest.states = states;
  return it;
}

/**
 * Which parts a state shows, by VRMXW §8's rule: a mesh listed in some state's `show` is shown only in the states
 * that list it; a mesh listed in none is shown in every state. → Set of mesh nodes.
 */
export function partsShown(item, name) {
  const states = item.manifest.states || [];
  const st = states.find((s) => s.name === name);
  if (!st) fail('state.none', `there is no state "${name}"`);
  const meshes = itemMeshes(item).map((m) => m.node);
  const nodes = nodesOf(item);
  const listed = new Set(states.flatMap((s) => showToNodes(nodes, s.show)));
  const mine = new Set(showToNodes(nodes, st.show));
  return new Set(meshes.filter((n) => !listed.has(n) || mine.has(n)));
}

/**
 * Show or hide one part in one state (ITM-5), rewriting every state's `show` so the rule of VRMXW §8 gives exactly
 * that: what each state showed before stays as it was, a part shown in every state is listed in none. Refused when
 * the part would be shown in no state at all, which the rule can't say (it would be shown in all of them): the only
 * state can't hide a part; add the state that shows it first, or split it out and leave it out.
 */
export function setPartShown(item, name, node, shown) {
  const states = item.manifest.states || [];
  if (!states.some((s) => s.name === name)) fail('state.none', `there is no state "${name}"`);
  const meshes = itemMeshes(item).map((m) => m.node);
  if (!meshes.includes(node)) fail('state.show', `node ${node} is not one of the item's meshes`);
  const visible = new Map(states.map((s) => [s.name, partsShown(item, s.name)]));
  if (shown) visible.get(name).add(node); else visible.get(name).delete(node);
  for (const m of meshes) {
    if (![...visible.values()].some((v) => v.has(m))) {
      fail('state.show-none', states.length === 1
        ? 'with only one state, a part can\'t be hidden: a part shown in no state is shown in all of them (VRMXW §8). Add the state that shows it first.'
        : 'that part would be shown in no state, and a part shown in no state is shown in all of them (VRMXW §8). Show it in another state first.');
    }
  }
  const everywhere = new Set(meshes.filter((m) => [...visible.values()].every((v) => v.has(m))));
  const someListed = meshes.some((m) => !everywhere.has(m));
  const it = copy(item);
  const nodes = nodesOf(item);
  it.manifest.states = it.manifest.states.map((s) => {
    const o = { ...s };
    if (someListed) o.show = namesOf(nodes, [...visible.get(s.name)].filter((m) => !everywhere.has(m)));
    else delete o.show;
    return o;
  });
  return it;
}

/** A pinned item's placement under a bone as a state's matrix: from move (m), turn (degrees, XYZ) and size. */
export function stateMatrix({ move = [0, 0, 0], turn = [0, 0, 0], size = 1 } = {}) {
  const [x, y, z] = turn.map((d) => (d * Math.PI) / 360);
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  const q = [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
  const [qx, qy, qz, qw] = q;
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * size, 2 * (xy + wz) * size, 2 * (xz - wy) * size, 0,
    2 * (xy - wz) * size, (1 - 2 * (xx + zz)) * size, 2 * (yz + wx) * size, 0,
    2 * (xz + wy) * size, 2 * (yz - wx) * size, (1 - 2 * (xx + yy)) * size, 0,
    move[0], move[1], move[2], 1,
  ].map((v) => Math.round(v * 1e6) / 1e6);
}

/**
 * Split primitives of a mesh out into a mesh of their own (ITM-5: "split out the parts that change"), so a state
 * can show or hide them. The new mesh keeps the skin; states that showed the old mesh show both.
 * → { item, node (the new mesh's node) }
 */
export function splitMesh(item, node, primIndices, { name } = {}) {
  const it = copy(item);
  const p = parseGlb(modelOf(it));
  const json = clone(p.json);
  const n = json.nodes[node];
  if (!n || n.mesh === undefined) fail('mesh.none', `node ${node} is not a mesh`);
  const mesh = json.meshes[n.mesh];
  const take = [...new Set(primIndices)].filter((i) => mesh.primitives[i]);
  if (!take.length || take.length === mesh.primitives.length) fail('mesh.split', 'choose some of the mesh\'s parts, not none or all of them');
  const moved = take.map((i) => mesh.primitives[i]);
  mesh.primitives = mesh.primitives.filter((_, i) => !take.includes(i));
  const newMesh = { name: name || `${mesh.name || 'Part'} (part)`, primitives: moved };
  if (mesh.extras?.targetNames) newMesh.extras = { targetNames: [...mesh.extras.targetNames] };
  if (mesh.weights) newMesh.weights = [...mesh.weights];
  json.meshes.push(newMesh);
  const newNode = { name: newMesh.name, mesh: json.meshes.length - 1 };
  if (n.skin !== undefined) newNode.skin = n.skin;
  for (const k of ['translation', 'rotation', 'scale', 'matrix']) if (n[k] !== undefined) newNode[k] = clone(n[k]);
  json.nodes.push(newNode);
  const ni = json.nodes.length - 1;
  const parent = parents(json.nodes).get(node);
  if (parent === undefined) json.scenes[json.scene || 0].nodes.push(ni);
  else json.nodes[parent].children.push(ni);
  uniqueNodeNames(json.nodes); // the new part's name is unique, so a state can name it
  const oldName = json.nodes[node].name;
  for (const s of it.manifest.states || []) {
    if (!Array.isArray(s.show)) continue;
    const idx = showToNodes(p.json.nodes, s.show);
    if (idx.includes(node) || s.show.includes(oldName)) s.show = namesOf(json.nodes, [...idx, ni]);
  }
  withModel(it, json, p.bin);
  return { item: it, node: ni };
}

/** Rename one of the item's meshes (the Parts tree). */
export function renameMesh(item, node, name) {
  const it = copy(item);
  const p = parseGlb(modelOf(it));
  const json = clone(p.json);
  if (!json.nodes[node] || json.nodes[node].mesh === undefined) fail('mesh.none', `node ${node} is not a mesh`);
  const before = json.nodes[node].name;
  const want = String(name).trim().slice(0, 80) || before;
  if (json.nodes.some((n, i) => i !== node && n.name === want)) fail('mesh.name', `another part is already called "${want}": names are unique within an item, so a state can name a part`);
  json.nodes[node].name = want;
  for (const s of it.manifest.states || []) if (Array.isArray(s.show)) s.show = s.show.map((x) => (x === before || x === node ? want : x));
  return withModel(it, json, p.bin);
}

// ---- movement (ITM-3, step 4) -------------------------------------------------------------------------------

/** Change a spring chain's settings: stiffness, gravityPower, dragForce, on every joint of the chain. */
export function setSpring(item, index, { stiffness, gravityPower, dragForce } = {}) {
  const it = copy(item);
  const p = parseGlb(modelOf(it));
  const json = clone(p.json);
  const s = json.extensions?.VRMC_springBone?.springs?.[index];
  if (!s) fail('spring.none', `there is no spring chain ${index}`);
  for (const j of s.joints || []) {
    if (j.stiffness === undefined && j === s.joints[s.joints.length - 1] && s.joints.length > 1) continue; // a tail
    if (stiffness !== undefined) j.stiffness = Math.min(4, Math.max(0, stiffness));
    if (gravityPower !== undefined) j.gravityPower = Math.min(2, Math.max(0, gravityPower));
    if (dragForce !== undefined) j.dragForce = Math.min(1, Math.max(0, dragForce));
  }
  return withModel(it, json, p.bin);
}

// ---- tags, licence and origin (ITM-7 to ITM-9) ------------------------------------------------------------

export function setTags(item, tags) {
  const t = [...new Set((tags || []).map((x) => String(x).trim()).filter(Boolean))];
  for (const x of t) if (!TAG_RE.test(x)) fail('item.tag', `"${x}" is not a tag: namespace:value, each part a-z, 0-9, dot, dash or underscore`);
  const it = copy(item);
  it.manifest.tags = t;
  return it;
}

/**
 * Set the licence block (ITM-8; VRMXW §11): VRM 1.0's own field names and values. authors and licenseUrl are
 * required. The item's revision is not its maker's `version`.
 */
export function setMeta(item, patch) {
  const it = copy(item);
  const meta = { ...(it.manifest.meta || {}), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null || v === '') delete meta[k];
  if (!Array.isArray(meta.authors) || !meta.authors.map(String).filter((a) => a.trim()).length) fail('meta.authors', 'the licence names who made the item (authors)');
  meta.authors = meta.authors.map((a) => String(a).trim()).filter(Boolean);
  if (!meta.licenseUrl || !/^https?:\/\/\S+$/.test(meta.licenseUrl)) fail('meta.licenseUrl', 'the licence needs its address (licenseUrl), such as https://vrm.dev/licenses/1.0/');
  for (const [k, vals] of Object.entries(META_ENUMS)) if (meta[k] !== undefined && !vals.includes(meta[k])) fail('meta.value', `${k} must be one of ${vals.join(', ')}`);
  for (const k of META_BOOLEANS) if (meta[k] !== undefined && typeof meta[k] !== 'boolean') fail('meta.value', `${k} must be true or false`);
  for (const k of META_STRINGS) if (meta[k] !== undefined && typeof meta[k] !== 'string') fail('meta.value', `${k} must be text`);
  if (meta.references !== undefined && !(Array.isArray(meta.references) && meta.references.every((r) => typeof r === 'string'))) fail('meta.value', 'references must be a list of text');
  delete meta.name; delete meta.avatarPermission; delete meta.thumbnailImage; // not an item's (VRMXW §11)
  it.manifest.meta = meta;
  return it;
}

/** Where it was obtained (ITM-9): { url, marketplace, id } or null. No price. */
export function setListing(item, listing) {
  const it = copy(item);
  if (listing === null) { it.manifest.listing = null; return it; }
  const l = {};
  for (const k of ['url', 'marketplace', 'id']) {
    const v = listing?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') fail('listing.value', `${k} must be text`);
    if (k === 'url' && !/^https?:\/\/\S+$/.test(v)) fail('listing.url', 'the listing\'s address must start with http:// or https://');
    l[k] = v.trim();
  }
  it.manifest.listing = Object.keys(l).length ? l : null;
  return it;
}

/** How it was made (VRMXW §4 `origin`): made (authored | extracted | generated | imported), source, and anything else kept. */
export function setOrigin(item, patch) {
  const it = copy(item);
  const o = { ...(it.manifest.origin || {}), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete o[k];
  if (o.made !== undefined && !['authored', 'extracted', 'generated', 'imported'].includes(o.made)) fail('origin.made', 'made is authored, extracted, generated or imported');
  it.manifest.origin = Object.keys(o).length ? o : null;
  return it;
}

// ---- animations (ITM-6; VRMXW §9) --------------------------------------------------------------------------

/** Add a clip (.vrma bytes) the item brings. → { item, sha256 } */
export async function addClip(item, bytes, { name = null, loops = null, duration = null, source = null, licence = null } = {}) {
  const problems = checkModel(bytes, { kind: 'clip' }).problems.filter((p) => p.severity === 'error');
  if (problems.length) fail('clip.invalid', `the clip can't be used: ${problems[0].message}`);
  const it = copy(item);
  const h = await sha256(bytes);
  const file = `animations/${sha12(h)}.vrma`;
  const a = it.manifest.animations || { clips: [], sets: [] };
  if (!a.clips.some((c) => c.sha256 === h)) {
    a.clips.push({ sha256: h, file, name, duration, loops, rootMotion: null, speed: null, tracks: ['humanoid'], source, licence });
    it.entries.set(file, bytes);
  }
  it.manifest.animations = a;
  return { item: it, sha256: h };
}

/** Remove a clip, and it from every set; a set left empty goes too. */
export function removeClip(item, sha) {
  const it = copy(item);
  const a = it.manifest.animations;
  const c = a?.clips.find((x) => x.sha256 === sha);
  if (!c) fail('clip.none', 'the item has no such clip');
  a.clips = a.clips.filter((x) => x !== c);
  it.entries.delete(c.file);
  for (const s of a.sets) for (const k of Object.keys(s.slots || {})) { s.slots[k] = s.slots[k].filter((e) => e.clip !== sha); if (!s.slots[k].length) delete s.slots[k]; }
  a.sets = a.sets.filter((s) => Object.keys(s.slots || {}).length);
  it.manifest.animations = a.clips.length || a.sets.length ? a : null;
  return it;
}

/**
 * Set the item's animation sets (ITM-6): [{ name, priority, requires: [tags], slots: { slot: [{ clip: sha }] } }].
 * Every set requires at least one of the item's own tags (VRMXW §9), every clip is one the item carries.
 */
export function setSets(item, sets) {
  const it = copy(item);
  const tags = new Set(allTags(it.manifest));
  const clips = new Set((it.manifest.animations?.clips || []).map((c) => c.sha256));
  const out = (sets || []).map((s) => {
    if (!String(s.name || '').trim()) fail('set.name', 'a set needs a name');
    const requires = [...new Set(s.requires || [])];
    if (!requires.some((t) => tags.has(t))) fail('set.requires', `the set "${s.name}" must require one of the item's own tags (${[...tags].join(', ') || 'it has none yet'})`);
    const slots = {};
    for (const [slot, list] of Object.entries(s.slots || {})) {
      if (!ANIMATION_SLOTS.includes(slot) && !/^x-[a-z0-9-]+\./.test(slot)) fail('set.slot', `"${slot}" is not an animation slot (VRMXA §8.2)`);
      slots[slot] = list.map((e) => { if (!clips.has(e.clip)) fail('set.clip', `a clip in "${s.name}" is not one the item carries`); return { ...e }; });
    }
    return { name: s.name.trim(), priority: Number.isInteger(s.priority) ? s.priority : 0, requires, slots };
  });
  const a = it.manifest.animations || { clips: [], sets: [] };
  a.sets = out;
  it.manifest.animations = a.clips.length || a.sets.length ? a : null;
  return it;
}

// ---- saving (ITM-10, ITM-12) --------------------------------------------------------------------------------

/**
 * Save an edited item: its next revision (the same `id`, VRMXW §3), written repeatably and checked. Refused
 * (ItemEditError with `problems`) when the checker finds an error, so an invalid item is never written.
 * → { item, bytes, problems }
 */
export async function saveItem(item, { spec, bump = true } = {}) {
  const it = copy(item);
  if (bump) touchItem(it);
  const bytes = await writeItem(it);
  const problems = await checkItem(bytes, { spec });
  if (problems.some((p) => p.severity === 'error')) {
    const e = new ItemEditError('item.invalid', `the item would not be valid: ${problems.filter((p) => p.severity === 'error').slice(0, 3).map((p) => `${p.where ? `${p.where}: ` : ''}${p.message}`).join('; ')}`);
    e.problems = problems;
    throw e;
  }
  return { item: it, bytes, problems };
}

/** "Duplicate as a new item" (ITM-10): a new id, revision 1, the name marked as a copy. */
export function duplicateAsNew(item, { name } = {}) {
  const d = duplicateItem(item, { id: newUuid(), created: nowIso() });
  d.manifest.name = name || `${item.manifest.name} (copy)`;
  return d;
}

/** True when two items differ in what a save would write (for "unsaved changes"). */
export function itemChanged(a, b) {
  if (JSON.stringify({ ...a.manifest, files: null }) !== JSON.stringify({ ...b.manifest, files: null })) return true;
  if (a.entries.size !== b.entries.size) return true;
  for (const [k, v] of a.entries) if (b.entries.get(k) !== v) return true;
  return false;
}

export { ITEM_TYPES, isPlainObject };
