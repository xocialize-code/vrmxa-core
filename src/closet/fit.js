// Fitting worn items to the character's body, until Spec-fit exists (PRD FIT-3, FIT-4, FIT-6, CLO-7,
// CLO-11; CLOSET.md §4; VRMXW §7, §8; VRMXA §5.2, §7.5). DOM-free: browsers and Node.
//
// Every item is fitted to Spec (VRMXW §5.3: its humanoid joints are bound where Spec binds them), so
// an item merged into Spec before the body is baked follows the body exactly as the body's own skin
// does: each vertex rides the bones it is weighted to, with their new positions and the body's
// widths (EDITS.md §4). That is the `bones` method of VRMXW §7. The `head` method (hair) is the same
// rule with every weight on the head; `pin` makes the item's mesh a child of one bone, which carries
// it. So the fit happens in the bake (`bakeAvatar` with `items`), and in the live view by loading
// the same merged model and moving its bones (`createLiveEdits`). What this module adds is what comes
// before the merge, in the item's own space (Spec's):
//
//   1. the item's state (VRMXW §8): the meshes it shows, its morph targets, and for a pinned item the
//      bone it follows and its placement under that bone;
//   2. the character's fine-tuning (VRMXA §7.5, `fitting.adjust`): Loose / Tight, Size and the three
//      small moves, applied after the automatic fit, as the edit document's `items` did (EDITS.md §5);
//   3. the shoes' lift (VRMXW §7.1), which raises the whole figure;
//   4. the layer order (FITTING.md §5.5): inner items are merged first.
//
// An item that asks for `spec-fit` is fitted by `bones` and says so (CLOSET.md §4; `fitting.method`).
// What is not done here: Spec-fit's steps 2 to 5 (clearance between layers, ease kept, hems; PRD FIT-2,
// FIT-5), morph targets carried through a reshaping fit (FIT-7; nothing reshapes yet), and the stored
// fitted shape (CLO-8). `fitting.auto` and `fitting.rule` are kept and reported, and have no effect on
// the bones method (they steer Spec-fit).
//
// The fine-tuning controls: five, with p' = centre + (p + normal · loose − centre) · size +
// (−right, up, forward). The centre is the middle of the item's meshes as worn (after its state is applied), in the model's
// space, and each mesh is moved in that space even when it hangs under a bone, so a pinned sword moves
// as a skinned top does. On a Spec-fitted item the anchor is the merge by humanoid role
// (`mergeItemModel`) followed by the body bake: no donor scale (items are on Spec), no footwear span
// correction (the body bake moves the feet).

import { parseGlb, readAccessor } from '../glb.js';
import { invert, worldMatrix, parents } from '../math.js';
import { clone, isPlainObject } from '../bytes.js';
import { showToNodes } from '../show.js';

/** The fine-tuning controls (VRMXA §7.5 `adjust`; ranges from EDITS.md §5). */
export const FIT_CONTROLS = Object.freeze([
  { key: 'loose', label: 'Loose / Tight', min: -0.005, max: 0.02, step: 0.0005, def: 0, unit: 'mm', show: 1000 },
  { key: 'size', label: 'Size', min: 0.9, max: 1.15, step: 0.005, def: 1, unit: '×', show: 1 },
  { key: 'up', label: 'Up / Down', min: -0.03, max: 0.03, step: 0.001, def: 0, unit: 'mm', show: 1000 },
  { key: 'forward', label: 'Forward / Back', min: -0.03, max: 0.03, step: 0.001, def: 0, unit: 'mm', show: 1000 },
  { key: 'right', label: 'Left / Right', min: -0.03, max: 0.03, step: 0.001, def: 0, unit: 'mm', show: 1000 },
]);
const BY_KEY = Object.fromEntries(FIT_CONTROLS.map((c) => [c.key, c]));
export const EASES = Object.freeze(['fitted', 'relaxed']);
export const HEM_ANCHORS = Object.freeze(['body', 'absolute']);
export const FIT_METHODS = Object.freeze(['spec-fit', 'bones', 'head', 'pin']);
/** The slots Spec-fit fits (VRMXW §7; FITTING.md §1): tops, bottoms, one-pieces and coats. */
export const SPEC_FIT_SLOTS = Object.freeze(['tops', 'bottoms', 'onepiece', 'outer']);

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A control's value in an `adjust` block (its default when unset), clamped to its range. */
export const adjustValue = (adjust, key) => (finite(adjust?.[key]) ? clamp(adjust[key], BY_KEY[key].min, BY_KEY[key].max) : BY_KEY[key].def);

/** True when an `adjust` block moves anything. */
export const adjustEdited = (adjust) => FIT_CONTROLS.some((c) => Math.abs(adjustValue(adjust, c.key) - c.def) > 1e-9);

/**
 * A `fitting` block as a closet stores it (VRMXA §7.5): known keys checked, `adjust` clamped and left
 * without defaults, unknown keys kept (§2 rule 5). → { fitting (or null when empty), problems: [text] }
 */
export function cleanFitting(src) {
  if (src == null) return { fitting: null, problems: [] };
  if (!isPlainObject(src)) return { fitting: null, problems: ['fitting must be an object'] };
  const problems = [];
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'auto') { if (typeof v === 'boolean') out.auto = v; else problems.push('fitting.auto must be true or false'); }
    else if (k === 'method') { if (FIT_METHODS.includes(v)) out.method = v; else problems.push(`fitting.method "${v}" is not one of ${FIT_METHODS.join(', ')}`); }
    else if (k === 'rule') {
      if (!isPlainObject(v)) { problems.push('fitting.rule must be an object'); continue; }
      const r = {};
      for (const [rk, rv] of Object.entries(v)) {
        if (rk === 'ease') { if (EASES.includes(rv)) r.ease = rv; else problems.push(`fitting.rule.ease must be ${EASES.join(' or ')}`); }
        else if (rk === 'hemAnchor') { if (HEM_ANCHORS.includes(rv)) r.hemAnchor = rv; else problems.push(`fitting.rule.hemAnchor must be ${HEM_ANCHORS.join(' or ')}`); }
        else r[rk] = clone(rv);
      }
      if (Object.keys(r).length) out.rule = r;
    } else if (k === 'adjust') {
      if (!isPlainObject(v)) { problems.push('fitting.adjust must be an object'); continue; }
      const a = {};
      for (const [ak, av] of Object.entries(v)) {
        const c = BY_KEY[ak];
        if (!c) { problems.push(`fitting.adjust.${ak} is not one of ${FIT_CONTROLS.map((x) => x.key).join(', ')}`); continue; }
        if (!finite(av)) { problems.push(`fitting.adjust.${ak} must be a number`); continue; }
        const val = clamp(av, c.min, c.max);
        if (Math.abs(val - c.def) > 1e-9) a[ak] = Math.round(val * 1e6) / 1e6;
      }
      if (Object.keys(a).length) out.adjust = a;
    } else out[k] = clone(v); // `fitted` and anything newer: kept as it is
  }
  return { fitting: Object.keys(out).length ? out : null, problems };
}

/**
 * The fitted positions (a new Float32Array): p' = centre + (p + n · loose − centre) · size + move.
 * pos / normals: x, y, z triples; centre: the item's middle in the same space; basis (optional): the
 * 3×3 (column-major) that takes a move in the model's space into this mesh's space, for a mesh under a
 * rotated bone. The model's space is VRM 1.0's: +Y up, +Z forward, +X the character's left, so
 * "right" (toward the viewer's right as the control goes up) is −X.
 */
export function fitPositions(pos, normals, adjust, centre, basis = null) {
  const out = new Float32Array(pos.length);
  const loose = adjustValue(adjust, 'loose'), size = adjustValue(adjust, 'size');
  let move = [-adjustValue(adjust, 'right'), adjustValue(adjust, 'up'), adjustValue(adjust, 'forward')];
  if (basis) move = [0, 1, 2].map((r) => basis[r] * move[0] + basis[3 + r] * move[1] + basis[6 + r] * move[2]);
  for (let i = 0; i < pos.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const p = pos[i + a] + (normals ? normals[i + a] * loose : 0);
      out[i + a] = centre[a] + (p - centre[a]) * size + move[a];
    }
  }
  return out;
}

// ---- the item's model, prepared for this character ---------------------------------------------------

const KEYS_TRS = ['translation', 'rotation', 'scale', 'matrix'];

/** A column-major 4×4 without shear → { translation, rotation (x, y, z, w), scale }. */
export function decompose(m) {
  const sx = Math.hypot(m[0], m[1], m[2]) || 1, sy = Math.hypot(m[4], m[5], m[6]) || 1, sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  // rotation matrix (column-major r) → quaternion
  const [m00, m10, m20, m01, m11, m21, m02, m12, m22] = r;
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  const l = Math.hypot(...q) || 1;
  const t = (v) => Math.round(v * 1e7) / 1e7;
  return { translation: [m[12], m[13], m[14]].map(t), rotation: q.map((v) => t(v / l)), scale: [sx, sy, sz].map(t) };
}

/** The state an item is in: the named one, else its first (default); null when it has none. */
export function stateOf(manifest, name) {
  const states = Array.isArray(manifest?.states) ? manifest.states : [];
  if (!states.length) return null;
  return states.find((s) => s?.name === name) || states[0];
}

/** Every state's tags plus the item's own: what an item adds to the equipped state (VRMXA §8.3). */
export function itemTags(manifest, stateName) {
  const s = stateOf(manifest, stateName);
  return [...new Set([...(manifest?.tags || []), ...(s?.tags || [])])];
}

/**
 * The method an item is fitted by here: its own. `spec-fit` is used for the slots it covers (tops,
 * bottoms, one-pieces, coats) unless the character switched the automatic fit off (VRMXA §7.5
 * `auto`), when the item follows the bones as authored; an item asking `spec-fit` in another slot
 * (shoes, socks: FITTING.md §1 leaves them for later) is fitted by `bones` (CLOSET.md §4).
 */
export function methodFor(manifest, fitting = null) {
  const asked = manifest?.fit?.method || (manifest?.kind === 'pin' ? 'pin' : 'bones');
  if (asked !== 'spec-fit') return asked;
  return SPEC_FIT_SLOTS.includes(manifest?.slot) && fitting?.auto !== false ? 'spec-fit' : 'bones';
}

/** How far worn shoes raise the figure (VRMXW §7.1): `fit.lift` of a `shoes` item, in metres, else 0. */
export function liftOf(manifest) {
  const l = manifest?.slot === 'shoes' ? manifest?.fit?.lift : null;
  return finite(l) && l > 0 && l < 0.5 ? l : 0;
}

// the mesh nodes and their world matrices (in the item model's own space)
function meshNodes(json) {
  const par = parents(json.nodes || []);
  const out = [];
  (json.nodes || []).forEach((n, i) => { if (n.mesh != null) out.push({ i, world: n.skin != null ? null : worldMatrix(json.nodes, i, par) }); });
  return out;
}

const mat3 = (m) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];

/**
 * An item's model prepared for wearing: its state applied, and each mesh node marked with what the
 * fine-tuning needs (`extras.vrmxaFit`: the item's id, the item's middle in that mesh's own space,
 * and the move basis for a mesh under a rotated bone), so the live view can fine-tune what the bake
 * fine-tunes, the same way. With `adjust`, the fine-tuning is applied as well (for avatar.vrm).
 *
 * model: model.glb's bytes; manifest: the item's vrmxw.json; opts: { id, state, adjust }.
 * → { json, bin, humanBones, state (its name or null), method, lift, tags, hidden: [node indices] }
 */
export function prepareItemModel(model, manifest, { id = manifest?.id, state = null, adjust = null, fitting = null } = {}) {
  const parsed = parseGlb(model);
  const json = clone(parsed.json);
  let bin = parsed.bin.slice();
  const rig = manifest?.rig?.humanBones || {};
  const st = stateOf(manifest, state);
  const states = Array.isArray(manifest?.states) ? manifest.states : [];
  const hidden = [];

  // 1. the state's meshes (VRMXW §8 `show`): a mesh listed in some state is shown only in the states that list it
  // (by node name since SPEC-QUESTIONS #44; an older item's node indices still work)
  const listed = new Set(states.flatMap((s) => showToNodes(json.nodes, s?.show)));
  if (listed.size) {
    const shown = new Set(showToNodes(json.nodes, st?.show));
    for (const n of listed) {
      if (shown.has(n) || !json.nodes?.[n] || json.nodes[n].mesh == null) continue;
      hidden.push(n);
    }
    // a spring chain that belongs to a hidden mesh goes with it (VRMXW §8.1): its joints are used by
    // hidden skins and by no shown one
    const skinJoints = (nodes) => new Set(nodes.flatMap((n) => (json.nodes[n]?.skin != null ? json.skins[json.nodes[n].skin]?.joints || [] : [])));
    const shownNodes = (json.nodes || []).map((x, i) => i).filter((i) => json.nodes[i].mesh != null && !hidden.includes(i));
    const used = skinJoints(shownNodes), gone = skinJoints(hidden);
    const sb = json.extensions?.VRMC_springBone;
    if (sb?.springs) sb.springs = sb.springs.filter((s) => !(s.joints || []).every((j) => gone.has(j.node) && !used.has(j.node)));
    for (const n of hidden) { delete json.nodes[n].mesh; delete json.nodes[n].skin; }
  }

  // 2. morph targets (VRMXW §8 `morphs`): by name; a target the state doesn't name is at 0
  if (states.some((s) => isPlainObject(s?.morphs))) {
    const want = isPlainObject(st?.morphs) ? st.morphs : {};
    for (const mesh of json.meshes || []) {
      const names = mesh.extras?.targetNames || [];
      const count = mesh.primitives?.[0]?.targets?.length || 0;
      if (!count) continue;
      mesh.weights = Array.from({ length: count }, (_, k) => (finite(want[names[k]]) ? clamp(want[names[k]], 0, 1) : 0));
    }
  }

  // 3. a pinned item's bone and placement in this state (VRMXW §8 `bone`, `matrix`)
  if (manifest?.kind === 'pin' && st && (st.bone || st.matrix)) {
    const attachNode = rig[manifest.attach?.bone];
    const targetNode = rig[st.bone || manifest.attach?.bone];
    if (attachNode == null || targetNode == null) throw new Error(`"${manifest.name}": state "${st.name}" names the bone ${st.bone}, which the item's rig doesn't have (VRMXW §4 rig.humanBones)`);
    const humanoid = new Set(Object.values(rig));
    const roots = (json.nodes[attachNode].children || []).filter((c) => !humanoid.has(c));
    if (targetNode !== attachNode) {
      json.nodes[attachNode].children = json.nodes[attachNode].children.filter((c) => !roots.includes(c));
      if (!json.nodes[attachNode].children.length) delete json.nodes[attachNode].children;
      (json.nodes[targetNode].children ||= []).push(...roots);
    }
    if (Array.isArray(st.matrix) && st.matrix.length === 16) {
      const trs = decompose(st.matrix);
      for (const r of roots) { for (const k of KEYS_TRS) delete json.nodes[r][k]; Object.assign(json.nodes[r], trs); }
    }
  }

  // 4. the fine-tuning's frame: the middle of the shown meshes in the model's space
  const meshes = meshNodes(json);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const posOf = new Map();
  for (const { i, world } of meshes) {
    for (const p of json.meshes[json.nodes[i].mesh].primitives || []) {
      if (p.attributes?.POSITION == null) continue;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      posOf.set(p.attributes.POSITION, pos);
      for (let v = 0; v < pos.length; v += 3) {
        const q = world ? [world[0] * pos[v] + world[4] * pos[v + 1] + world[8] * pos[v + 2] + world[12], world[1] * pos[v] + world[5] * pos[v + 1] + world[9] * pos[v + 2] + world[13], world[2] * pos[v] + world[6] * pos[v + 1] + world[10] * pos[v + 2] + world[14]] : [pos[v], pos[v + 1], pos[v + 2]];
        for (let a = 0; a < 3; a++) { if (q[a] < lo[a]) lo[a] = q[a]; if (q[a] > hi[a]) hi[a] = q[a]; }
      }
    }
  }
  const centre = Number.isFinite(lo[0]) ? lo.map((v, a) => (v + hi[a]) / 2) : [0, 0, 0];
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  for (const { i, world } of meshes) {
    let local = centre, basis = null;
    if (world) {
      const inv = invert(world);
      local = [inv[0] * centre[0] + inv[4] * centre[1] + inv[8] * centre[2] + inv[12], inv[1] * centre[0] + inv[5] * centre[1] + inv[9] * centre[2] + inv[13], inv[2] * centre[0] + inv[6] * centre[1] + inv[10] * centre[2] + inv[14]];
      const b = mat3(inv);
      const isIdentity = b.every((v, k) => Math.abs(v - [1, 0, 0, 0, 1, 0, 0, 0, 1][k]) < 1e-6);
      basis = isIdentity ? null : b.map(r6);
    }
    json.nodes[i].extras = { ...(json.nodes[i].extras || {}), vrmxaFit: { item: id, centre: local.map(r6), ...(basis ? { basis } : {}) } };
  }

  // 5. the fine-tuning itself, written into the model (each POSITION list once)
  if (adjust && adjustEdited(adjust)) {
    const done = new Set();
    for (const { i } of meshes) {
      const f = json.nodes[i].extras.vrmxaFit;
      for (const p of json.meshes[json.nodes[i].mesh].primitives || []) {
        const ai = p.attributes?.POSITION;
        if (ai == null || done.has(ai)) continue;
        done.add(ai);
        const pos = posOf.get(ai) || readAccessor(json, bin, ai);
        const nrm = p.attributes.NORMAL != null ? readAccessor(json, bin, p.attributes.NORMAL) : null;
        const np = fitPositions(pos, nrm, adjust, f.centre, f.basis || null);
        bin = writeVec3(json, bin, ai, np);
        // morph deltas scale with the size; the other controls move every point alike
        const size = adjustValue(adjust, 'size');
        if (Math.abs(size - 1) > 1e-9) for (const t of p.targets || []) {
          if (t.POSITION == null || done.has(`t${t.POSITION}`)) continue;
          done.add(`t${t.POSITION}`);
          const d = readAccessor(json, bin, t.POSITION);
          bin = writeVec3(json, bin, t.POSITION, Float32Array.from(d, (x) => x * size));
        }
      }
    }
  }
  if (json.buffers?.[0]) json.buffers[0].byteLength = bin.length;
  return { json, bin, humanBones: clone(rig), state: st?.name ?? null, method: methodFor(manifest, fitting), lift: liftOf(manifest), tags: itemTags(manifest, st?.name), hidden };
}

// write x, y, z floats into a VEC3 float accessor: in place when it has its own tight view, else as a
// new view and accessor (the old one stays for whoever else uses it) → bin
export function writeVec3(json, bin, ai, values) {
  const a = json.accessors[ai];
  const bv = a.bufferView != null ? json.bufferViews[a.bufferView] : null;
  const shared = (json.accessors || []).some((o, k) => k !== ai && o.bufferView === a.bufferView);
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i++) { const c = i % 3; if (values[i] < min[c]) min[c] = values[i]; if (values[i] > max[c]) max[c] = values[i]; }
  min = min.map(Math.fround); max = max.map(Math.fround);
  if (bv && a.componentType === 5126 && !a.sparse && !shared) {
    const stride = bv.byteStride || 12;
    const dv = new DataView(bin.buffer, bin.byteOffset);
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < 3; c++) dv.setFloat32(start + i * stride + c * 4, values[i * 3 + c], true);
    if (a.min) a.min = min;
    if (a.max) a.max = max;
    return bin;
  }
  const pad = (4 - (bin.length % 4)) % 4;
  const bytes = new Uint8Array(Float32Array.from(values).buffer);
  const out = new Uint8Array(bin.length + pad + bytes.length);
  out.set(bin, 0);
  out.set(bytes, bin.length + pad);
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad, byteLength: bytes.length, target: 34962 });
  a.bufferView = json.bufferViews.length - 1;
  delete a.byteOffset;
  delete a.sparse;
  a.componentType = 5126;
  a.min = min; a.max = max;
  return out;
}

