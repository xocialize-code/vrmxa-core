// Face page: what an exported VRoid avatar still lets you change about its face, and how those
// changes are baked back into the body file. DOM-free (runs under Node for tests).
//
// An exported VRM has its face shape baked into the mesh, but it keeps:
//   • 57 `Fcl_*` morph targets on the face mesh (BRW eyebrows, EYE eyes, MTH mouth, HA teeth,
//     ALL whole-face) — Twist prefixes them `Face_Blendshape.`, some names drop an underscore;
//   • its face materials by name (Face_00_SKIN, EyeIris, EyeWhite, FaceBrow, FaceEyeline, FaceMouth);
//   • the head and eye bones (humanoid head / leftEye / rightEye = J_Adj_[LR]_FaceEye).
// So the Face page offers: tints of those materials, head and iris size from bone scale, and the
// morphs that NO expression uses. three-vrm zeroes every expression-bound morph each frame
// (VRMExpressionMorphTargetBind.clearAppliedWeight), so a slider on one of those could never stick.
//
// Saving bakes the edits into body.vrm as RFC 6902 JSON Patch operations on the glTF JSON —
// the edit model gltf-studio (MIT) uses for its documents:
//   /meshes/m/weights            default morph weights
//   /materials/i/pbrMetallicRoughness/baseColorFactor, …/VRMC_materials_mtoon/shadeColorFactor
//   /nodes/n/scale               head / eye bone scale
// The binary chunk is untouched; only the JSON changes.

import { readAccessor } from '../glb.js';
import { HEAD_TUNES, HEAD_DEFAULT, headShapeOf, scanHead, headField, moveHead, movePoint } from './headShape.js';

export const FACE_PARTS = [
  {
    id: 'shape', label: 'Face Shape',
    colors: [{ key: 'skin', label: 'Skin', match: /(^|_)(Face|Body)_\d+_SKIN/i }],
    bones: [], // Head Size is on the Body page
    groups: ['ALL'],
    // the head shape picked (face.headShape) and its fine-tune controls (lib/headShape.js)
    head: true,
    shapes: HEAD_TUNES,
  },
  { id: 'brow', label: 'Eyebrows', colors: [{ key: 'brow', label: 'Eyebrows', match: /FaceBrow/i }], bones: [], groups: ['BRW'] },
  {
    id: 'eyes', label: 'Eyes',
    // Iris colour: "Both Eyes" sets both; "Right Eye" and "Left Eye" name the eyes as you see them,
    // facing the avatar. Stored per side of the avatar: irisL (its left, +X in VRM 1.0), irisR.
    colors: [
      { key: 'iris', label: 'Both Eyes', match: /EyeIris/i, sets: ['irisL', 'irisR'], shows: 'irisL' },
      { key: 'irisL', label: 'Right Eye', avail: 'iris', sets: ['irisL'], shows: 'irisL' },
      { key: 'irisR', label: 'Left Eye', avail: 'iris', sets: ['irisR'], shows: 'irisR' },
      { key: 'eyeWhite', label: 'Eye White', match: /EyeWhite/i },
    ],
    bones: [{ key: 'iris', label: 'Iris Size', humanBones: ['leftEye', 'rightEye'], min: 0.7, max: 1.3 }],
    groups: ['EYE'],
  },
  { id: 'eyeline', label: 'Eyeline', colors: [{ key: 'eyeline', label: 'Eyeline', match: /FaceEyeline/i }], bones: [], groups: [] },
  // Nose and Cheek: an exported model keeps no nose or cheek controls, so these reshape the model's own face mesh around its nose and cheeks (faceLandmarks,
  // deformPositions) and paint the blush into the face skin texture (blushPaint.js).
  {
    id: 'nose', label: 'Nose', colors: [], bones: [], groups: [],
    shapes: [
      { key: 'noseY', label: 'Nose Position', min: -1, max: 1 },
      { key: 'noseSize', label: 'Nose Size', min: -1, max: 1 },
      { key: 'noseWidth', label: 'Nose Width', min: -1, max: 1 },
      { key: 'noseTipY', label: 'Nose Tip Position (Y)', min: -1, max: 1 },
      { key: 'noseTipZ', label: 'Nose Base Prominence (Z)', min: -1, max: 1 },
      { key: 'noseBridge', label: 'Nose Bridge Width', min: -1, max: 1 },
    ],
  },
  { id: 'mouth', label: 'Mouth', colors: [{ key: 'mouth', label: 'Mouth', match: /FaceMouth/i }], bones: [], groups: ['MTH'] },
  { id: 'teeth', label: 'Teeth', colors: [], bones: [], groups: ['HA'] },
  {
    id: 'cheek', label: 'Cheek', bones: [], groups: [],
    // a blush colour over the cheeks
    colors: [{ key: 'cheek', label: 'Blush', avail: 'skin', blush: true }],
    shapes: [
      { key: 'blush', label: 'Blush Strength', min: 0, max: 1, def: 0.6 },
      { key: 'cheekZ', label: 'Cheekbones Position (Z)', min: -1, max: 1 },
      { key: 'cheekFull', label: 'Full / Sunken Cheeks', min: -1, max: 1 },
    ],
  },
  { id: 'expressions', label: 'Expressions', colors: [], bones: [], groups: [] },
];

/** Every shape control (nose / cheek), by key. */
export const SHAPES = Object.fromEntries(FACE_PARTS.flatMap((p) => (p.shapes || []).map((s) => [s.key, s])));
const shapeOf = (face, key) => face?.shapes?.[key] ?? SHAPES[key]?.def ?? 0;

/** A blush is on when a non-white blush colour is chosen and its strength is above 0. */
export const blushOn = (face) => {
  const c = face?.colors?.cheek;
  return !!c && c.some((v) => Math.abs(v - 1) > 1e-3) && shapeOf(face, 'blush') > 1e-3;
};
/** The shape edits that move vertices (everything but the blush strength). */
export const shapesEdited = (face) => headShapeOf(face) !== HEAD_DEFAULT
  || Object.entries(face?.shapes || {}).some(([k, v]) => k !== 'blush' && SHAPES[k] && Math.abs(v - (SHAPES[k].def ?? 0)) > 1e-4);

/**
 * A morph target name → { key, group, label }, or null for a non-face morph.
 * "Fcl_EYE_Iris_Hide", "Face_Blendshape.Fcl_EYE_IrisHide" → key "EYE_IrisHide", group "EYE".
 */
export function morphKey(name) {
  const base = String(name).split('.').pop();
  const m = /^Fcl_([A-Z]+)_(.+)$/.exec(base);
  if (!m) return null;
  const rest = m[2].split('_').map((t, i) => (i === 0 || /^[LR]$/.test(t) ? t : t[0].toUpperCase() + t.slice(1)));
  // keep _L / _R side suffixes, join the other words (Iris_Hide → IrisHide)
  const words = [];
  for (const t of rest) {
    if (/^[LR]$/.test(t)) words.push(`_${t}`);
    else words.push(t);
  }
  const tail = words.join('');
  const key = `${m[1]}_${tail}`;
  const plain = tail.replace(/_([LR])$/, ' ($1)').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Z])/g, '$1 $2');
  return { key, group: m[1], label: plain };
}

const colorKeyOf = (matName) => {
  for (const part of FACE_PARTS) for (const c of part.colors) if (c.match?.test(matName || '')) return c.key;
  return null;
};

/**
 * What the file offers for face editing:
 *   morphs: [{ key, group, label, targets: [[meshIndex, targetIndex]], bound }]
 *   colors: { key: [materialIndex] },  bones: { humanBone: nodeIndex }
 */
export function faceInfo(json) {
  const bound = new Set(); // "mesh:index" of every morph any expression binds
  const nodeMesh = (n) => json.nodes?.[n]?.mesh;
  const exprs1 = json.extensions?.VRMC_vrm?.expressions;
  for (const group of [exprs1?.preset, exprs1?.custom]) {
    for (const e of Object.values(group || {}))
      for (const b of e.morphTargetBinds || []) {
        const m = nodeMesh(b.node);
        if (m != null) bound.add(`${m}:${b.index}`);
      }
  }
  for (const g of json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups || [])
    for (const b of g.binds || []) bound.add(`${b.mesh}:${b.index}`);

  const byKey = new Map();
  (json.meshes || []).forEach((mesh, mi) => {
    const names = mesh.extras?.targetNames || mesh.primitives?.[0]?.extras?.targetNames || [];
    names.forEach((n, ti) => {
      const k = morphKey(n);
      if (!k) return;
      if (!byKey.has(k.key)) byKey.set(k.key, { ...k, targets: [], bound: false });
      const e = byKey.get(k.key);
      e.targets.push([mi, ti]);
      if (bound.has(`${mi}:${ti}`)) e.bound = true;
    });
  });

  const colors = {};
  (json.materials || []).forEach((m, i) => {
    const k = colorKeyOf(m.name);
    if (k) (colors[k] ||= []).push(i);
  });

  const bones = {};
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (hb) for (const [k, v] of Object.entries(hb)) bones[k] = v.node;
  for (const b of json.extensions?.VRM?.humanoid?.humanBones || []) bones[b.bone] = b.node;

  return { morphs: [...byKey.values()], colors, bones };
}

// ---- JSON Patch (RFC 6902, the subset we emit: add / replace) --------------------------------
const esc = (s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1');
export const pointer = (...parts) => '/' + parts.map(esc).join('/');

function walk(json, path) {
  const keys = path.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  const last = keys.pop();
  let at = json;
  for (const k of keys) {
    if (at[k] === undefined) throw new Error(`JSON Patch: no ${k} on the way to ${path}`);
    at = at[k];
  }
  return [at, last];
}

/** Apply add / replace operations in place (the caller owns `json`). */
export function applyPatches(json, ops) {
  for (const op of ops) {
    const [parent, key] = walk(json, op.path);
    if (op.op === 'replace' && !(key in parent)) throw new Error(`JSON Patch replace: ${op.path} doesn't exist`);
    if (op.op !== 'add' && op.op !== 'replace') throw new Error(`JSON Patch: unsupported op ${op.op}`);
    parent[key] = op.value;
  }
  return json;
}

// ---- Nose / cheek: landmarks on the face mesh, and the reshaping ----------------------------------

function invert4(m) {
  const a = m, inv = new Array(16);
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  if (Math.abs(det) < 1e-12) return null;
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  return inv.map((v) => v / det);
}

// world position of a node in the rest pose (TRS chain; matrices taken as given)
function nodeWorld(json, n) {
  const parent = new Map();
  (json.nodes || []).forEach((nd, i) => (nd.children || []).forEach((c) => parent.set(c, i)));
  let p = [0, 0, 0];
  for (let i = n; i != null; i = parent.get(i)) {
    const nd = json.nodes[i];
    if (nd.matrix) { const m = nd.matrix; p = [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; continue; }
    const s = nd.scale || [1, 1, 1];
    let [x, y, z] = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
    const q = nd.rotation || [0, 0, 0, 1];
    // rotate by quaternion
    const ix = q[3] * x + q[1] * z - q[2] * y, iy = q[3] * y + q[2] * x - q[0] * z, iz = q[3] * z + q[0] * y - q[1] * x, iw = -q[0] * x - q[1] * y - q[2] * z;
    x = ix * q[3] + iw * -q[0] + iy * -q[2] - iz * -q[1];
    y = iy * q[3] + iw * -q[1] + iz * -q[0] - ix * -q[2];
    z = iz * q[3] + iw * -q[2] + ix * -q[1] - iy * -q[0];
    const t = nd.translation || [0, 0, 0];
    p = [x + t[0], y + t[1], z + t[2]];
  }
  return p;
}

const FACE_SKIN = /(^|_)Face_\d+_SKIN/i;
const BODY_SKIN = /(^|_)Body_\d+_SKIN/i;

/**
 * Where the nose and cheeks are on this model, in the face mesh's own (bind) space.
 * -> null when the file has no face skin or eyes; otherwise
 *   { meshes: [mesh indices to reshape], eyeL, eyeR, mid, d (eye distance), noseTip, cheeks: [L, R],
 *     cheekUV: [{u, v, ru, rv}, …], skinImages: [image indices of the face skin texture] }
 */
export function faceLandmarks(json, bin, parts = null) {
  // parts: { skinMats, bodyMats, irisMats } (Sets of material indices) for an avatar not named the VRoid
  // way: its face parts as the person marked them (lib/donorParts.js)
  const skinMats = parts?.skinMats || new Set((json.materials || []).map((m, i) => (FACE_SKIN.test(m.name || '') ? i : -1)).filter((i) => i >= 0));
  if (!skinMats.size) return null;
  const meshes = [];
  const skinPrims = [];
  (json.meshes || []).forEach((mesh, mi) => mesh.primitives.forEach((p) => {
    if (skinMats.has(p.material)) { if (!meshes.includes(mi)) meshes.push(mi); skinPrims.push(p); }
  }));
  if (!skinPrims.length) return null;
  const info = faceInfo(json);
  // vertices of some primitives (only those their indices use: VRoid's face primitives share one
  // POSITION accessor) -> [[x, y, z, u, v]]
  const vertsOf = (prims) => {
    const out = [];
    for (const p of prims) {
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const uv = p.attributes.TEXCOORD_0 != null ? readAccessor(json, bin, p.attributes.TEXCOORD_0) : null;
      const used = p.indices != null ? new Set(readAccessor(json, bin, p.indices)) : pos.map((_, i) => i).filter((i) => i < pos.length / 3);
      for (const i of used) out.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0]);
    }
    return out;
  };
  // the eyes: the centre of each side's iris (the eye bones sit deep in the head, nearer the middle)
  const irisMats = parts?.irisMats || new Set(info.colors.iris || []);
  const irisV = vertsOf((json.meshes || []).flatMap((m, mi) => (parts || meshes.includes(mi) ? m.primitives : [])).filter((p) => irisMats.has(p.material)));
  const centre = (vs) => (vs.length ? [0, 1, 2].map((c) => vs.reduce((s, v) => s + v[c], 0) / vs.length) : null);
  let eyeL = centre(irisV.filter((v) => v[0] > 0)), eyeR = centre(irisV.filter((v) => v[0] < 0));
  if (!eyeL || !eyeR) {
    // no iris on the face mesh: the eye bones, from the inverse bind matrices of the face skin
    // when they're its joints, else from the rest-pose node chain
    const eyeNodes = [info.bones.leftEye, info.bones.rightEye];
    if (eyeNodes.some((n) => n == null)) return null;
    const eyePos = (node) => {
      const holder = (json.nodes || []).find((n) => meshes.includes(n.mesh) && n.skin != null);
      const skin = holder ? json.skins[holder.skin] : null;
      const ji = skin ? skin.joints.indexOf(node) : -1;
      if (ji >= 0 && skin.inverseBindMatrices != null) {
        const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
        const inv = invert4([...ibm.slice(ji * 16, ji * 16 + 16)]);
        if (inv) return [inv[12], inv[13], inv[14]];
      }
      return nodeWorld(json, node);
    };
    eyeL = eyePos(eyeNodes[0]); eyeR = eyePos(eyeNodes[1]);
  }
  const d = Math.hypot(eyeL[0] - eyeR[0], eyeL[1] - eyeR[1], eyeL[2] - eyeR[2]);
  if (!(d > 1e-4)) return null;
  const mid = [(eyeL[0] + eyeR[0]) / 2, (eyeL[1] + eyeR[1]) / 2, (eyeL[2] + eyeR[2]) / 2];

  const verts = vertsOf(skinPrims);
  // VRM 1.0 faces +Z; a VRM 0.x file still faces -Z
  const fwd = json.extensions?.VRMC_vrm ? 1 : -1;
  const front = (cx, cy, rx, ry) => {
    let best = null;
    for (const v of verts) if (Math.abs(v[0] - cx) <= rx && Math.abs(v[1] - cy) <= ry && (!best || v[2] * fwd > best[2] * fwd)) best = v;
    return best;
  };
  // nose tip: the most forward face-skin point on the midline below the eyes (VRM 1.0 faces +Z)
  const tipV = front(mid[0], mid[1] - 0.525 * d, 0.1 * d, 0.325 * d);
  if (!tipV) return null;
  const noseTip = tipV.slice(0, 3);
  // cheeks: the face surface below and a little outside each eye
  const cheeks = [], cheekUV = [];
  for (const s of [1, -1]) {
    const c = front(mid[0] + s * 0.6 * d, mid[1] - 0.45 * d, 0.1 * d, 0.1 * d);
    if (!c) return null;
    cheeks.push(c.slice(0, 3));
    // blush ellipse in texture space: the UV spread of the skin within 0.35 d of the cheek point
    let ru = 0, rv = 0;
    for (const v of verts) {
      if (Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]) > 0.35 * d) continue;
      ru = Math.max(ru, Math.abs(v[3] - c[3]));
      rv = Math.max(rv, Math.abs(v[4] - c[4]));
    }
    cheekUV.push({ u: c[3], v: c[4], ru: ru || 0.03, rv: rv || 0.03 });
  }
  // the head as a whole (Face Shape): scanned from the face skin and the body skin around the head
  // (VRoid puts the back of the head in the body mesh)
  const trisOf = (prims) => {
    const out = [];
    for (const p of prims) {
      if (p.indices == null) continue;
      const pos = readAccessor(json, bin, p.attributes.POSITION), idx = readAccessor(json, bin, p.indices);
      const at = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      for (let t = 0; t + 2 < idx.length; t += 3) out.push([at(idx[t]), at(idx[t + 1]), at(idx[t + 2])]);
    }
    return out;
  };
  const bodyMats = parts?.bodyMats || new Set((json.materials || []).map((m, i) => (BODY_SKIN.test(m.name || '') ? i : -1)).filter((i) => i >= 0));
  const bodyPrims = [], headMeshes = [];
  (json.meshes || []).forEach((mesh, mi) => mesh.primitives.forEach((p) => {
    // (a donor's parts may share one mesh with its face: there each part is its own primitive)
    if (bodyMats.has(p.material) && (parts || !meshes.includes(mi))) { bodyPrims.push(p); if (!headMeshes.includes(mi)) headMeshes.push(mi); }
  }));
  let head = null;
  try {
    const lmFrame = { mid, d, fwd };
    const reach = 2.4 * d, cy = mid[1] + 0.34 * d;
    const near = (t) => t.every((p) => Math.abs(p[1] - cy) < reach && Math.abs(p[0] - mid[0]) < reach);
    head = scanHead(lmFrame, trisOf(skinPrims), trisOf(bodyPrims).filter(near));
  } catch { head = null; }
  const skinImages = [...new Set([...skinMats].flatMap((mi) => {
    const m = json.materials[mi];
    const tex = [m.pbrMetallicRoughness?.baseColorTexture?.index, m.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture?.index];
    return tex.filter((t) => t != null).map((t) => json.textures?.[t]?.source).filter((s) => s != null);
  }))];
  return { meshes, headMeshes, fwd, eyeL, eyeR, mid, d, noseTip, cheeks, cheekUV, skinImages, head };
}

const smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
// smooth weight inside an ellipsoid around c, with its own reach up and down (1 at c, 0 at the edge)
const ellipse = (x, y, z, c, rx, up, down, rz) => {
  const dy = y - c[1];
  return smooth(1 - Math.hypot((x - c[0]) / rx, dy / (dy >= 0 ? up : down), (z - c[2]) / rz));
};

/**
 * Reshape face vertices (x, y, z triples, the face mesh's bind space) for the nose and cheek
 * controls. Every point moves by a smooth falloff around its landmark, so the same function moves
 * the skin and whatever else on the face mesh lies there. The regions stop short of the mouth and
 * the lower eyelids. Sizes are fractions of the eye distance d (iris centre to iris centre), so they
 * scale with the head; all of them are this library's own (estimated). -> a new Float32Array.
 */
export function deformPositions(pos, lm, face) {
  const out = new Float32Array(pos);
  if (!lm) return out;
  // first the head as a whole (Face Shape: the picked head shape and its controls) …
  const field = lm.head ? headField(lm.head, face) : null;
  if (field) {
    moveHead(field, out);
    // … then the nose and cheeks fine-tune that head, around their landmarks moved with it
    const mv = (p) => movePoint(field, p, 1);
    lm = { ...lm, noseTip: mv(lm.noseTip), mid: mv(lm.mid), cheeks: lm.cheeks.map(mv) };
  }
  const s = (k) => shapeOf(face, k);
  const { d, noseTip: t, mid, cheeks } = lm;
  const f = lm.fwd || 1;
  const ny = s('noseY'), nsz = s('noseSize'), nw = s('noseWidth'), nty = s('noseTipY'), ntz = s('noseTipZ'), nb = s('noseBridge');
  const cz = s('cheekZ'), cf = s('cheekFull');
  if (![ny, nsz, nw, nty, ntz, nb, cz, cf].some((v) => Math.abs(v) > 1e-4)) return out;
  const pivot = [t[0], t[1] + 0.1 * d, t[2] - f * 0.15 * d];
  const bridgeY = (mid[1] + t[1]) / 2, bridgeH = Math.abs(mid[1] - t[1]) / 2;
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i], y = out[i + 1], z = out[i + 2];
    let dx = 0, dy = 0, dz = 0;
    // the whole nose: up to the eyes, stopping above the upper lip
    const wn = ellipse(x, y, z, t, 0.18 * d, 0.45 * d, 0.08 * d, 0.3 * d);
    if (wn > 0) {
      dy += ny * 0.06 * d * wn;
      dx += (x - pivot[0]) * nsz * 0.35 * wn; dy += (y - pivot[1]) * nsz * 0.35 * wn; dz += (z - pivot[2]) * nsz * 0.35 * wn;
      dx += (x - t[0]) * nw * 0.5 * wn;
    }
    // the tip
    const wt = ellipse(x, y, z, t, 0.12 * d, 0.2 * d, 0.08 * d, 0.2 * d);
    if (wt > 0) { dy += nty * 0.04 * d * wt; dz += f * ntz * 0.06 * d * wt; }
    // the bridge: between the eyes and the tip, near the middle, on the front of the face
    if (Math.abs(nb) > 1e-4) {
      const wb = smooth(1 - Math.abs(y - bridgeY) / (bridgeH + 1e-6)) * smooth(1 - Math.abs(x - mid[0]) / (0.15 * d))
        * ((z - t[2]) * f > -0.3 * d ? 1 : 0);
      dx += (x - mid[0]) * nb * 0.5 * wb;
    }
    // cheeks
    for (let k = 0; k < cheeks.length; k++) {
      const c = cheeks[k];
      const side = c[0] >= mid[0] ? 1 : -1;
      // cheekbones: forward / back, stopping below the lower eyelid
      const wc = ellipse(x, y, z, c, 0.35 * d, 0.18 * d, 0.4 * d, 0.4 * d);
      if (wc > 0) dz += f * cz * 0.05 * d * wc;
      // the lower cheek: out (full) or in (sunken), clear of the mouth corners
      const lc = [c[0] + side * 0.15 * d, c[1] - 0.35 * d, c[2]];
      const wl = ellipse(x, y, z, lc, 0.4 * d, 0.4 * d, 0.4 * d, 0.5 * d);
      if (wl > 0) { dx += side * cf * 0.05 * d * wl; dz += f * cf * 0.02 * d * wl; }
    }
    out[i] = x + dx; out[i + 1] = y + dy; out[i + 2] = z + dz;
  }
  return out;
}

const mul3 = (a, t) => [a[0] * t[0], a[1] * t[1], a[2] * t[2]];
const round = (v) => Math.round(v * 1e6) / 1e6;

const isWhite = (t) => !t || t.every((v) => Math.abs(v - 1) < 1e-3);
const sameTint = (a, b) => (isWhite(a) && isWhite(b)) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 1e-3));
/** True when the two eyes are to get different iris colours (so the iris must be split per side). */
export const irisDiffers = (face) => !sameTint(face?.colors?.irisL, face?.colors?.irisR);

/**
 * Split every iris primitive into the avatar's right-side triangles (kept, original material) and
 * its left-side ones (+X in VRM 1.0; a new primitive with a copy of the material), so each eye can
 * take its own colour. New index data is appended to the
 * binary chunk; nothing existing moves. Expression material binds on the iris are copied to the
 * new material too. -> { bin, leftMats: Set(material index) }
 */
export function splitIrisBySide(json, bin, irisMats) {
  const extra = [];
  let size = bin.length;
  const pad = () => { const p = (4 - (size % 4)) % 4; if (p) { extra.push(new Uint8Array(p)); size += p; } };
  const addIndices = (arr) => {
    pad();
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: u8.length, target: 34963 });
    extra.push(u8);
    size += u8.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: arr.length, type: 'SCALAR' });
    return json.accessors.length - 1;
  };
  const leftOf = new Map(); // original material -> its left-eye copy
  const leftMats = new Set();
  for (const mesh of json.meshes || []) {
    const added = [];
    for (const prim of mesh.primitives) {
      if (!irisMats.includes(prim.material) || prim.indices == null || prim.attributes?.POSITION == null) continue;
      const idx = readAccessor(json, bin, prim.indices);
      const pos = readAccessor(json, bin, prim.attributes.POSITION);
      const left = [], right = [];
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const x = (pos[idx[t] * 3] + pos[idx[t + 1] * 3] + pos[idx[t + 2] * 3]) / 3;
        (x > 0 ? left : right).push(idx[t], idx[t + 1], idx[t + 2]);
      }
      if (!left.length || !right.length) continue; // only one eye in this primitive
      if (!leftOf.has(prim.material)) {
        const copy = JSON.parse(JSON.stringify(json.materials[prim.material]));
        copy.name = `${copy.name || 'EyeIris'} (left eye)`;
        json.materials.push(copy);
        leftOf.set(prim.material, json.materials.length - 1);
        leftMats.add(json.materials.length - 1);
      }
      prim.indices = addIndices(new Uint32Array(right));
      added.push({ ...JSON.parse(JSON.stringify(prim)), indices: addIndices(new Uint32Array(left)), material: leftOf.get(prim.material) });
    }
    mesh.primitives.push(...added);
  }
  // expressions that tint the iris material tint its left-eye copy the same way
  const exprs = json.extensions?.VRMC_vrm?.expressions;
  for (const group of [exprs?.preset, exprs?.custom])
    for (const e of Object.values(group || {}))
      for (const list of ['materialColorBinds', 'textureTransformBinds']) {
        const binds = e[list];
        if (!binds) continue;
        for (const b of [...binds]) if (leftOf.has(b.material)) binds.push({ ...b, material: leftOf.get(b.material) });
      }
  if (!extra.length) return { bin, leftMats };
  const out = new Uint8Array(size);
  out.set(bin, 0);
  let p = bin.length;
  for (const e of extra) { out.set(e, p); p += e.length; }
  if (json.buffers?.[0]) json.buffers[0].byteLength = size;
  return { bin: out, leftMats };
}

/**
 * The face edits as JSON Patch operations on this glTF JSON (nothing is changed here).
 * leftIris: the left-eye iris materials made by splitIrisBySide, when the eyes differ.
 */
export function facePatches(json, face, leftIris = null) {
  const info = faceInfo(json);
  const ops = [];

  // morphs → default weights per mesh
  const weights = new Map(); // mesh -> array
  for (const m of info.morphs) {
    const w = face.morphs?.[m.key];
    if (w == null || m.bound) continue;
    for (const [mi, ti] of m.targets) {
      const mesh = json.meshes[mi];
      const n = mesh.primitives?.[0]?.targets?.length || (mesh.extras?.targetNames || []).length;
      if (!weights.has(mi)) weights.set(mi, (mesh.weights ? [...mesh.weights] : new Array(n).fill(0)));
      weights.get(mi)[ti] = round(Math.max(0, Math.min(1, w)));
    }
  }
  for (const [mi, w] of weights)
    ops.push({ op: json.meshes[mi].weights ? 'replace' : 'add', path: pointer('meshes', mi, 'weights'), value: w });

  // colours → base colour and MToon shade colour, multiplied by the tint
  const c = face.colors || {};
  const tintFor = (key, i) => {
    if (key !== 'iris') return c[key];
    if (leftIris?.has(i)) return c.irisL;
    return leftIris ? c.irisR : (c.irisL ?? c.irisR);
  };
  for (const [key, mats] of Object.entries(info.colors)) {
    for (const i of mats) {
      const tint = tintFor(key, i);
      if (isWhite(tint)) continue;
      const mat = json.materials[i];
      const pbr = mat.pbrMetallicRoughness;
      const base = pbr?.baseColorFactor || [1, 1, 1, 1];
      if (pbr) ops.push({ op: pbr.baseColorFactor ? 'replace' : 'add', path: pointer('materials', i, 'pbrMetallicRoughness', 'baseColorFactor'), value: [...mul3(base, tint).map(round), base[3] ?? 1] });
      const mt = mat.extensions?.VRMC_materials_mtoon;
      if (mt?.shadeColorFactor) ops.push({ op: 'replace', path: pointer('materials', i, 'extensions', 'VRMC_materials_mtoon', 'shadeColorFactor'), value: mul3(mt.shadeColorFactor, tint).map(round) });
    }
  }

  // bone sizes (Iris Size) are written with the body (bakeBody): the vertices move, bones keep scale 1
  return ops;
}

// append data to the binary chunk (4-byte aligned) as a new bufferView -> [bin, bufferView index]
export function appendView(json, bin, bytes, target) {
  const pad = (4 - (bin.length % 4)) % 4;
  const out = new Uint8Array(bin.length + pad + bytes.length);
  out.set(bin, 0);
  out.set(bytes, bin.length + pad);
  json.bufferViews.push({ buffer: 0, byteOffset: bin.length + pad, byteLength: bytes.length, ...(target ? { target } : {}) });
  if (json.buffers?.[0]) json.buffers[0].byteLength = out.length;
  return [out, json.bufferViews.length - 1];
}

/**
 * Write the nose / cheek reshaping into the face mesh: each POSITION accessor its primitives use is
 * read, deformed and appended as a new accessor (with its min / max), and the primitives point at
 * it. Morph targets are deltas, so they still apply on top. -> new bin (bin itself when unchanged)
 */
export function reshapeFace(json, bin, face, lm = faceLandmarks(json, bin)) {
  if (!lm || !shapesEdited(face)) return bin;
  const done = new Map(); // old accessor -> new
  // the body mesh too when the head changes (it holds the back of the head)
  const meshList = lm.head && headField(lm.head, face) ? [...lm.meshes, ...(lm.headMeshes || [])] : lm.meshes;
  for (const mi of meshList)
    for (const p of json.meshes[mi].primitives) {
      const a = p.attributes.POSITION;
      if (a == null) continue;
      if (!done.has(a)) {
        const pos = deformPositions(readAccessor(json, bin, a), lm, face);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i++) { const c = i % 3; if (pos[i] < min[c]) min[c] = pos[i]; if (pos[i] > max[c]) max[c] = pos[i]; }
        let view;
        [bin, view] = appendView(json, bin, new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength), 34962);
        json.accessors.push({ bufferView: view, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
        done.set(a, json.accessors.length - 1);
      }
      p.attributes.POSITION = done.get(a);
    }
  return bin;
}

