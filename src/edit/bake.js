// Writing the edits into a model: Spec + the edit document + the hair piece → a plain VRM 1.0, the
// character's `avatar.vrm` (VRMXA §5.2, EDITS.md "written into the model only in avatar.vrm").
//
// Order: the hair piece is merged and the drawn hair added first, so the body's reshaping carries
// them with the head; then the iris is split per eye (when the eyes differ), the face reshaped
// (§3.6), the body and Iris Size written into the mesh and bones (§4, bakeBody), the textures
// repainted (the blush, §3.7; the hair colour, §3.2) and the colours and default face shapes set
// (§3.1, §3.2). Nothing here is DOM-bound: it runs in a browser and in Node alike.

import { parseGlb, buildGlb, readAccessor, bufferViewBytes } from '../glb.js';
import { invert, worldMatrix, transformPoint, parents } from '../math.js';
import { readEdits, editsChangeLook } from './document.js';
import { bakeBody, bodyEdited } from './body.js';
import { faceLandmarks, faceInfo, reshapeFace, splitIrisBySide, facePatches, applyPatches, irisDiffers, blushOn, SHAPES, appendView } from './face.js';
import { hairDesignMesh, paramOf } from './hairDesign.js';
import { mergeItemModel, HAIR_MARK } from './merge.js';
import { decodePng, encodePng } from './png.js';
import { paintBlush, overlayColour, hairStrandTexture } from './pixels.js';

const FACE_SKIN = /(^|_)Face_\d+_SKIN/i;

/**
 * The head's frame in a model at rest: its node, world matrix, and the head's middle and size in
 * the head bone's own space (from the face skin's bounds) — where drawn hair is placed (EDITS.md §6:
 * strokes are in the head bone's space). → null without a head bone or face skin.
 */
export function headFrame(json, bin) {
  const head = json.extensions?.VRMC_vrm?.humanoid?.humanBones?.head?.node;
  if (head == null) return null;
  const par = parents(json.nodes);
  const world = worldMatrix(json.nodes, head, par);
  const skinMats = new Set((json.materials || []).map((m, i) => (FACE_SKIN.test(m.name || '') ? i : -1)).filter((i) => i >= 0));
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes || []) for (const p of mesh.primitives || []) {
    if (!skinMats.has(p.material) || p.attributes?.POSITION == null) continue;
    const pos = readAccessor(json, bin, p.attributes.POSITION);
    const used = p.indices != null ? new Set(readAccessor(json, bin, p.indices)) : null;
    for (let i = 0; i < pos.length / 3; i++) {
      if (used && !used.has(i)) continue;
      for (let c = 0; c < 3; c++) { const v = pos[i * 3 + c]; if (v < min[c]) min[c] = v; if (v > max[c]) max[c] = v; }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  const inv = invert(world);
  const mid = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const sx = Math.hypot(world[0], world[1], world[2]) || 1;
  return { head, world, centre: transformPoint(inv, mid), radius: Math.max(max[0] - min[0], max[2] - min[2]) / 2 / sx };
}

// append a typed array as an accessor → its index (bin grows; returns the new bin through `state`)
function addAccessor(json, state, typed, componentType, type, target, minmax = false) {
  const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
  let view;
  [state.bin, view] = appendView(json, state.bin, new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), target);
  const a = { bufferView: view, componentType, count: typed.length / nc, type };
  if (minmax) {
    a.min = Array(nc).fill(Infinity); a.max = Array(nc).fill(-Infinity);
    for (let i = 0; i < typed.length; i++) { const c = i % nc; if (typed[i] < a.min[c]) a.min[c] = typed[i]; if (typed[i] > a.max[c]) a.max[c] = typed[i]; }
    a.min = a.min.map(Math.fround); a.max = a.max.map(Math.fround);
  }
  json.accessors.push(a);
  return json.accessors.length - 1;
}

// a PNG as a new image and texture (with the sampler of `like`, a texture index) → texture index
function addTexture(json, state, png, like, name) {
  let view;
  [state.bin, view] = appendView(json, state.bin, png);
  json.images = json.images || [];
  json.images.push({ ...(name ? { name } : {}), bufferView: view, mimeType: 'image/png' });
  json.textures = json.textures || [];
  const sampler = like != null ? json.textures[like]?.sampler : undefined;
  json.textures.push({ source: json.images.length - 1, ...(sampler != null ? { sampler } : {}) });
  return json.textures.length - 1;
}

/**
 * Drawn hair (EDITS.md §6) as one mesh per group, skinned to the head bone (weight 1), so it follows
 * the head, its size and its motions, and the body bake carries it. Each group gets a toon material
 * with the strand texture in its colour. The strands do not sway in the file: bounce and gravity are
 * shown live only (no spring bones are written for drawn hair yet).
 * → { bin, materials: [indices] }
 */
export function bakeHairDesign(json, bin, design, frame = headFrame(json, bin)) {
  const meshes = frame ? hairDesignMesh(design, frame.centre) : [];
  if (!meshes.length) return { bin, materials: [] };
  const state = { bin };
  for (const k of ['nodes', 'meshes', 'materials', 'skins', 'accessors', 'bufferViews']) json[k] = json[k] || [];
  const scene = json.scenes[json.scene || 0];
  const W = frame.world;
  const ibm = addAccessor(json, state, Float32Array.from(invert(W)), 5126, 'MAT4');
  json.skins.push({ name: 'DrawnHair', joints: [frame.head], inverseBindMatrices: ibm });
  const skin = json.skins.length - 1;
  const materials = [];
  for (const m of meshes) {
    const n = m.positions.length / 3;
    const pos = new Float32Array(m.positions.length), nrm = new Float32Array(m.normals.length);
    for (let i = 0; i < n; i++) {
      const p = transformPoint(W, [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);
      pos.set(p, i * 3);
      const q = [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]];
      const d = [W[0] * q[0] + W[4] * q[1] + W[8] * q[2], W[1] * q[0] + W[5] * q[1] + W[9] * q[2], W[2] * q[0] + W[6] * q[1] + W[10] * q[2]];
      const l = Math.hypot(...d) || 1;
      nrm.set([d[0] / l, d[1] / l, d[2] / l], i * 3);
    }
    const attributes = {
      POSITION: addAccessor(json, state, pos, 5126, 'VEC3', 34962, true),
      NORMAL: addAccessor(json, state, nrm, 5126, 'VEC3', 34962),
      TEXCOORD_0: addAccessor(json, state, Float32Array.from(m.uvs), 5126, 'VEC2', 34962),
      JOINTS_0: addAccessor(json, state, new Uint8Array(n * 4), 5121, 'VEC4', 34962),
      WEIGHTS_0: addAccessor(json, state, Float32Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 5126, 'VEC4', 34962),
    };
    const indices = addAccessor(json, state, n > 65535 ? Uint32Array.from(m.indices) : Uint16Array.from(m.indices), n > 65535 ? 5125 : 5123, 'SCALAR', 34963);
    const c = m.group.color;
    const tex = addTexture(json, state, encodePng(hairStrandTexture({ texWidth: paramOf(m.group, 'texWidth'), highlight: paramOf(m.group, 'highlight'), offset: paramOf(m.group, 'offset') }, c)), null, `DrawnHair ${m.group.name}`);
    json.materials.push({
      name: `DrawnHair ${m.group.name}`,
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: tex }, metallicFactor: 0, roughnessFactor: 1 },
      extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeColorFactor: [0.72, 0.72, 0.72], shadeMultiplyTexture: { index: tex }, shadingToonyFactor: 0.9, shadingShiftFactor: 0 } },
      extras: { [HAIR_MARK]: 'drawn' },
    });
    materials.push(json.materials.length - 1);
    json.meshes.push({ name: `DrawnHair ${m.group.name}`, primitives: [{ attributes, indices, material: json.materials.length - 1 }] });
    json.nodes.push({ name: `DrawnHair ${m.group.name}`, mesh: json.meshes.length - 1, skin });
    scene.nodes.push(json.nodes.length - 1);
  }
  json.extensionsUsed = json.extensionsUsed || [];
  if (!json.extensionsUsed.includes('VRMC_materials_mtoon')) json.extensionsUsed.push('VRMC_materials_mtoon');
  return { bin: state.bin, materials };
}

const isWhite = (c) => !c || c.every((v) => Math.abs(v - 1) < 1e-3);
const isBlack = (c) => !c || c.every((v) => v < 1e-3);

// repaint the textures a material uses (base colour and MToon's shade multiply), each into a new
// image of its own, so a texture shared with other materials is left as it was
function repaint(json, state, matIndex, paint, cache) {
  const mat = json.materials[matIndex];
  const slots = [mat.pbrMetallicRoughness?.baseColorTexture, mat.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture].filter(Boolean);
  for (const slot of slots) {
    const t = slot.index;
    if (!cache.has(t)) {
      const img = json.images?.[json.textures?.[t]?.source];
      if (!img || img.bufferView == null || (img.mimeType && img.mimeType !== 'image/png')) { cache.set(t, t); continue; }
      let decoded;
      try { decoded = decodePng(bufferViewBytes(json, state.bin, img.bufferView)); } catch { cache.set(t, t); continue; }
      cache.set(t, addTexture(json, state, encodePng(paint(decoded)), t, img.name ? `${img.name} (edited)` : null));
    }
    slot.index = cache.get(t);
  }
}

/**
 * Spec (bytes) + an edit document + a hair piece → { bytes (a VRM 1.0), ignored, refused, hairMaterials }.
 * opts.hair: { model (model.glb bytes), humanBones (the item manifest's rig.humanBones) } or null.
 * opts.meta: fields of VRMC_vrm.meta to set (the character's own name, authors …; VRMXA §5.3). opts.metaMode 'replace'
 *   makes them the whole meta (Spec's thumbnail picture kept); 'merge' (default) sets them over Spec's.
 * opts.items: worn items prepared by closet/fit.js prepareItemModel ({ json, bin, humanBones }), inner first.
 * opts.lift: how far worn shoes raise the figure, in metres (VRMXW §7.1).
 * opts.pieces: the licence records of the hair piece and worn items, written to the glTF's extras.vrmxaPieces.
 * opts.bodyOnly: skip the hair, the items and the textures (for measuring the edited body, FITTING.md §4).
 * opts.fit(json, bin, { body, bones, lift }) → { bin, report }: called once the items are merged and before the
 *   body is written in, so Spec-fit (fit/index.js fitMerged) can give the Spec-fitted items their place on this
 *   body in Spec's bind space; the body bake then carries them there. Its report is returned as `fit`.
 */
export function bakeAvatar(specBytes, doc, { hair = null, items = [], lift = 0, pieces = null, meta = null, metaMode = 'merge', bodyOnly = false, fit = null } = {}) {
  const parsed = parseGlb(specBytes);
  const json = JSON.parse(JSON.stringify(parsed.json));
  const state = { bin: parsed.bin.slice() };
  const { edits, ignored, refused } = readEdits(doc);
  const face = edits.face;
  // landmarks and the head's frame on the base itself, before anything is added
  const lm = faceLandmarks(json, state.bin);
  const frame = headFrame(json, state.bin);
  const hairMaterials = [];
  if (!bodyOnly && hair?.model) {
    const item = parseGlb(hair.model);
    const r = mergeItemModel(json, state.bin, { json: JSON.parse(JSON.stringify(item.json)), bin: item.bin }, { humanBones: hair.humanBones || {}, mark: 'piece' });
    state.bin = r.bin;
    hairMaterials.push(...r.materials);
  }
  // worn items, prepared for this character (closet/fit.js prepareItemModel), inner layers first:
  // merged into Spec before the body is baked, so they follow its bones as its own skin does (the
  // `bones` method, VRMXW §7; CLOSET.md §4)
  if (!bodyOnly) for (const it of items) {
    const r = mergeItemModel(json, state.bin, { json: it.json, bin: it.bin }, { humanBones: it.humanBones || {} });
    state.bin = r.bin;
  }
  const raise = !bodyOnly && Number.isFinite(lift) && lift > 0 ? lift : 0;
  let fitReport = null;
  if (!bodyOnly && fit && items.length) {
    const r = fit(json, state.bin, { body: edits.body, bones: face.bones, lift: raise });
    state.bin = r.bin;
    fitReport = r.report ?? null;
  }
  if (!bodyOnly) {
    const r = bakeHairDesign(json, state.bin, edits.hairDesign, frame);
    state.bin = r.bin;
    hairMaterials.push(...r.materials);
  }
  let leftIris = null;
  if (!bodyOnly && irisDiffers(face)) {
    const r = splitIrisBySide(json, state.bin, faceInfo(json).colors.iris || []);
    state.bin = r.bin;
    leftIris = r.leftMats;
  }
  state.bin = reshapeFace(json, state.bin, face, lm);
  if (bodyEdited(edits.body) || Math.abs((face.bones.iris ?? 1) - 1) > 1e-4 || raise) {
    if (state.bin.byteOffset !== 0 || state.bin.byteLength !== state.bin.buffer.byteLength) state.bin = state.bin.slice();
    state.bin = bakeBody(json, state.bin, { body: edits.body, bones: face.bones, lift: raise }, (b, bytes) => appendView(json, b, bytes));
  }
  if (!bodyOnly) {
    const cache = new Map();
    if (lm && blushOn(face)) {
      const strength = face.shapes.blush ?? SHAPES.blush.def;
      (json.materials || []).forEach((m, i) => {
        if (FACE_SKIN.test(m.name || '')) repaint(json, state, i, (img) => paintBlush(img, lm.cheekUV, face.colors.cheek, strength), cache);
      });
    }
    const hc = face.colors.hair;
    if (!isWhite(hc)) {
      const hairCache = new Map();
      for (const i of hairMaterials) repaint(json, state, i, (img) => overlayColour(img, hc), hairCache);
    }
    const glow = face.colors.hairEmission;
    if (!isBlack(glow)) for (const i of hairMaterials) {
      const m = json.materials[i];
      m.emissiveFactor = glow.map((v) => Math.round(v * 1e6) / 1e6);
      delete m.emissiveTexture; // an exported file's emission texture is often black and would cancel it (EDITS.md §3.2)
    }
    applyPatches(json, facePatches(json, face, leftIris));
  }
  const vm = json.extensions?.VRMC_vrm?.meta;
  if (vm && meta && metaMode === 'replace') {
    // the character's own details, whole (VRMXA §5.3): nothing of Spec's is left behind but its thumbnail picture
    const thumb = vm.thumbnailImage;
    for (const k of Object.keys(vm)) delete vm[k];
    for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== null) vm[k] = JSON.parse(JSON.stringify(v));
    if (vm.thumbnailImage === undefined && thumb !== undefined) vm.thumbnailImage = thumb;
  } else if (vm && meta) for (const [k, v] of Object.entries(meta)) if (v !== undefined) vm[k] = v;
  // the licences of the pieces merged in travel with the model, never dropped (VRMXA §5.2; CLOSET.md
  // §4 item 9): VRM's meta is the character's own, so each piece's licence block goes here
  if (!bodyOnly && Array.isArray(pieces) && pieces.length) json.extras = { ...(json.extras || {}), vrmxaPieces: JSON.parse(JSON.stringify(pieces)) };
  if (json.buffers?.[0]) json.buffers[0].byteLength = state.bin.length;
  return { bytes: buildGlb(json, state.bin), ignored, refused, hairMaterials, fit: fitReport, changed: editsChangeLook(edits) || !!hair?.model || items.length > 0 };
}
