// The edits on a model shown in three.js, live (PRD APP-6): the same edits bake.js writes into the
// file, applied to the loaded VRM without reloading it. three.js is used as provided (REF-8); this
// only sets bone transforms, inverse bind matrices, morph weights, material colours, position arrays
// and textures, and adds meshes for drawn hair under the head bone.
//
// One object per model. The blush and the hair colour are painted by pixels.js (the bake's own
// arithmetic), so the live view and avatar.vrm get the same pixels; hair materials are found by the mark
// the merge writes (extras.vrmxaHair) as well as by name; drawn hair is placed by the bake's head frame.
//
//   const live = createLiveEdits(vrm, { json, bin });   // the parsed GLB that was loaded
//   live.apply(readEdits(doc).edits);                    // as often as the edits change
//   live.step(dt);                                       // each frame (the drawn hair's sway)

import * as THREE from 'three';
import { bodyRig, bodyShape, groundLift, soleSamples } from '../body.js';
import { FACE_PARTS, faceInfo, faceLandmarks, morphKey, shapesEdited, deformPositions, blushOn, SHAPES } from '../face.js';
import { HEAD_TUNES } from '../headShape.js';
import { headFrame } from '../bake.js';
import { smoothStroke, strandMesh, paramOf } from '../hairDesign.js';
import { paintBlush, overlayColour, hairStrandTexture } from '../pixels.js';
import { HAIR_MARK } from '../merge.js';
import { readAccessor } from '../../glb.js';
import { fitPositions, adjustEdited } from '../../closet/fit.js';

const FACE_SKIN = /(^|_)Face_\d+_SKIN/i;
const BODY_SKIN = /(^|_)Body_\d+_SKIN/i;
const IRIS = /EyeIris/i;
const HAIR_NAME = /hair/i;
const TINT_MATCH = FACE_PARTS.flatMap((p) => p.colors).filter((c) => c.match);
const SHAPE_KEYS = Object.keys(SHAPES).filter((k) => k !== 'blush');
const isOne = (v) => v[0] === 1 && v[1] === 1 && v[2] === 1;
const isZero = (v) => v[0] === 0 && v[1] === 0 && v[2] === 0;
const isWhite = (c) => !c || c.every((v) => Math.abs(v - 1) < 1e-3);
const mats = (o) => (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean);

/** Is this material part of the hair (the hair piece or drawn hair)? */
export const isHairMaterial = (m) => !!m?.userData?.[HAIR_MARK] || HAIR_NAME.test(m?.name || '');

// pixels of a texture's image (ImageBitmap, image or canvas) → ImageData, or null when it can't be read
function pixelsOf(img) {
  const w = img?.width, h = img?.height;
  if (img?.data && w && h) return { width: w, height: h, data: new Uint8ClampedArray(img.data) }; // a DataTexture's own pixels
  if (!w || !h || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// a texture like `orig` showing these pixels (reusing `tex` when given)
function textureFrom(orig, imageData, tex) {
  if (orig.isDataTexture) {
    const data = new Uint8Array(imageData.data.buffer.slice(0));
    if (tex) { tex.image.data = data; tex.needsUpdate = true; return tex; }
    const t = new THREE.DataTexture(data, imageData.width, imageData.height, orig.format);
    t.colorSpace = orig.colorSpace; t.wrapS = orig.wrapS; t.wrapT = orig.wrapT; t.flipY = orig.flipY;
    t.needsUpdate = true;
    return t;
  }
  let canvas = tex?.image;
  if (!tex) {
    canvas = document.createElement('canvas');
    tex = orig.clone();
    tex.source = new THREE.Source(canvas);
  }
  canvas.width = imageData.width; canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData instanceof ImageData ? imageData : new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
  tex.needsUpdate = true;
  return tex;
}

/**
 * The live edits for one loaded model. vrm: three-vrm's VRM; data: { json, bin } of the GLB it was
 * loaded from (bind-space facts are read from the file, as the bake reads them).
 */
export function createLiveEdits(vrm, data) {
  const { json, bin } = data;
  const rig = bodyRig(json);
  const soles = soleSamples(json, bin);
  let lm = null;
  try { lm = faceLandmarks(json, bin); } catch { lm = null; }
  const frame = headFrame(json, bin);
  const info = faceInfo(json);
  const offered = new Set(info.morphs.filter((m) => !m.bound).map((m) => m.key));
  const keys = {};
  const fitOrig = new WeakMap(); // geometry → its positions as merged, before the fine-tuning
  const specBase = new WeakMap(); // geometry → its positions as Spec-fit placed them (FITTING.md §5), when it did
  const specOrig = new WeakMap(); // geometry → { normal, morphs } as merged, to go back to
  const usedOf = new Map(); // "mesh/prim" → the file's vertex of each geometry vertex (three-vrm drops unused ones, in order)
  let lastAdjusts = {};
  // a mesh's primitive in the file and the file's vertex of each of its geometry's vertices: three-vrm drops
  // the vertices a primitive doesn't use, keeping the rest in the file's order
  function fileVertices(o) {
    const [mi, pi] = String(o.userData.piece || '').split('/').map(Number);
    const prim = json.meshes?.[mi]?.primitives?.[pi];
    if (!prim) return null;
    let used = usedOf.get(o.userData.piece);
    if (!used) {
      const n = o.geometry.attributes.position.count;
      let list = null;
      if (prim.indices != null) {
        const idx = readAccessor(json, bin, prim.indices);
        const seen = new Uint8Array(json.accessors[prim.attributes.POSITION].count);
        for (let i = 0; i < idx.length; i++) seen[idx[i]] = 1;
        list = [];
        for (let i = 0; i < seen.length; i++) if (seen[i]) list.push(i);
        if (list.length !== n) list = null; // not reduced after all
      }
      used = list ? Int32Array.from(list) : Int32Array.from({ length: n }, (_, i) => i);
      usedOf.set(o.userData.piece, used);
    }
    return { prim, accessor: prim.attributes.POSITION, used };
  }
  const scene = vrm.scene;

  // ---- body (EDITS.md §4) and Iris Size (§3.3) ------------------------------------------------
  const byName = new Map();
  scene.traverse((o) => { if (o.name && !byName.has(o.name)) byName.set(o.name, o); });
  const nodes = rig.names.map((n) => byName.get(n) || null);
  const index = new Map(rig.names.map((n, i) => [n, i]));
  const rest = new Map();
  const origInverses = new WeakMap();
  const scaleMat = new THREE.Matrix4();

  let skinScale = null; // the body's skin widths last applied (sh.skin), for skeletons made later
  // fold the skin widths into one skeleton's inverse bind matrices, by bone name, from its unscaled ones
  function scaleSkeleton(sk) {
    if (!origInverses.has(sk)) origInverses.set(sk, sk.boneInverses.map((m) => m.clone()));
    const orig = origInverses.get(sk);
    sk.bones.forEach((bone, i) => {
      const idx = index.get(bone.name);
      const s = idx != null && skinScale ? skinScale[idx] : [1, 1, 1];
      sk.boneInverses[i].copy(orig[i]);
      if (!isOne(s)) sk.boneInverses[i].premultiply(scaleMat.makeScale(s[0], s[1], s[2]));
    });
  }

  function applyBody(body, bones, extraLift = 0) {
    const key = JSON.stringify([body, bones.iris ?? 1, extraLift]);
    if (keys.body === key) return;
    keys.body = key;
    const sh = bodyShape(rig, { body, bones });
    skinScale = sh.skin;
    const lift = groundLift(json, bin, rig, sh, soles) + extraLift; // + worn shoes (VRMXW §7.1)
    rig.names.forEach((_, i) => {
      const o = nodes[i];
      if (!o) return;
      const plain = isOne(sh.hier[i]) && isOne(sh.trans[i]) && isZero(sh.offset[i]) && i !== rig.top;
      if (plain && !rest.has(o)) return; // never touched: leave it to the animation
      if (!rest.has(o)) rest.set(o, { p: o.position.clone(), s: o.scale.clone() });
      const r = rest.get(o);
      o.scale.set(r.s.x * sh.hier[i][0], r.s.y * sh.hier[i][1], r.s.z * sh.hier[i][2]);
      if (i === rig.bones.hips) return; // three-vrm sets the hips' position every frame; only its scale is ours
      o.position.set(r.p.x * sh.trans[i][0] + sh.offset[i][0], r.p.y * sh.trans[i][1] + sh.offset[i][1], r.p.z * sh.trans[i][2] + sh.offset[i][2]);
      if (i === rig.top) o.position.y += lift;
    });
    // skin widths: folded into every skeleton's inverse bind matrices, by bone name
    const seen = new Set();
    scene.traverse((o) => {
      if (!o.isSkinnedMesh || !o.skeleton || seen.has(o.skeleton)) return;
      seen.add(o.skeleton);
      scaleSkeleton(o.skeleton);
    });
    scene.updateMatrixWorld(true);
    try { vrm.springBoneManager?.setInitState?.(); } catch { /* no springs */ }
  }

  // ---- the body's weights under a Spec-fitted garment (FITTING.md §5.6, SPEC-QUESTIONS #60) -------------
  // A garment mesh is bound to a skeleton holding its own bones and every skinning bone of the file (made
  // once per skeleton it had), and its skinIndex / skinWeight take the weights Spec-fit gave (the file's
  // vertex order, `used` mapping the geometry's vertices). Taken away again when the fit is.
  const nodeObj = new Map(); // file node → the object three.js made for it (the stage tags userData.node)
  scene.traverse((o) => { if (Number.isInteger(o.userData?.node) && !nodeObj.has(o.userData.node)) nodeObj.set(o.userData.node, o); });
  const objOf = (n) => nodeObj.get(n) || byName.get(json.nodes?.[n]?.name) || null;
  const bindOf = new Map(); // file node → its inverse bind matrix, from the first skin listing it (as Spec-fit reads it)
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices == null) continue;
    const m = readAccessor(json, bin, skin.inverseBindMatrices);
    skin.joints.forEach((n, j) => { if (!bindOf.has(n)) bindOf.set(n, new THREE.Matrix4().fromArray(m, j * 16)); });
  }
  const wide = new Map(); // a skeleton → { skeleton (its bones and every skinning bone), slot: object → index }
  const skinOwn = new WeakMap(); // mesh → { skeleton, bindMatrix, skinIndex, skinWeight } as loaded
  function wideSkeleton(sk) {
    let w = wide.get(sk);
    if (w) return w;
    const bones = [...sk.bones], inv = (origInverses.get(sk) || sk.boneInverses).map((m) => m.clone());
    const slot = new Map(bones.map((b, i) => [b, i]));
    for (const [n, m] of bindOf) {
      const b = objOf(n);
      if (!b || slot.has(b)) continue;
      slot.set(b, bones.length); bones.push(b); inv.push(m.clone());
    }
    const skeleton = new THREE.Skeleton(bones, inv);
    origInverses.set(skeleton, inv.map((m) => m.clone()));
    scaleSkeleton(skeleton);
    w = { skeleton, slot };
    wide.set(sk, w);
    return w;
  }
  function bodyWeightsOn(o, skin, used) {
    const g = o.geometry;
    if (!skinOwn.has(o)) skinOwn.set(o, { skeleton: o.skeleton, bindMatrix: o.bindMatrix.clone(), skinIndex: g.attributes.skinIndex, skinWeight: g.attributes.skinWeight });
    const own = skinOwn.get(o);
    const w = wideSkeleton(own.skeleton);
    const n = used.length;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) {
      const f = used[k] * 4 + c, wt = skin.weights[f];
      if (!(wt > 0)) continue;
      const slot = w.slot.get(objOf(skin.nodes[f]));
      if (slot == null) continue; // a bone three.js didn't make: drop its share
      si[k * 4 + c] = slot; sw[k * 4 + c] = wt;
    }
    // renormalise any vertex that lost a share
    for (let k = 0; k < n; k++) { const t = sw[k * 4] + sw[k * 4 + 1] + sw[k * 4 + 2] + sw[k * 4 + 3]; if (t > 0 && Math.abs(t - 1) > 1e-6) for (let c = 0; c < 4; c++) sw[k * 4 + c] /= t; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    if (o.skeleton !== w.skeleton) o.bind(w.skeleton, own.bindMatrix);
  }
  function ownWeights(o) {
    const own = skinOwn.get(o);
    if (!own) return;
    o.geometry.setAttribute('skinIndex', own.skinIndex);
    o.geometry.setAttribute('skinWeight', own.skinWeight);
    o.bind(own.skeleton, own.bindMatrix);
    skinOwn.delete(o);
  }

  // ---- face: morphs, colours, iris per eye (EDITS.md §3.1–3.3) ----------------------------------
  const faceOrig = new WeakMap(); // material -> { color, shade }
  const remember = (m) => { if (!faceOrig.has(m)) faceOrig.set(m, { color: m.color?.clone() ?? null, shade: m.shadeColorFactor?.clone() ?? null }); return faceOrig.get(m); };
  const morphOrig = new WeakMap();

  function splitIris(mesh, mat) {
    if (mesh.userData.vrmxaIrisSplit) return;
    mesh.userData.vrmxaIrisSplit = true;
    const g = mesh.geometry, pos = g.attributes.position, idx = g.index;
    if (!idx || !pos) return;
    const left = [], right = [];
    for (let t = 0; t + 2 < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
      ((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 > 0 ? left : right).push(a, b, c);
    }
    if (!left.length || !right.length) return;
    const orig = remember(mat);
    const copy = mat.clone();
    faceOrig.set(copy, { color: orig.color?.clone() ?? null, shade: orig.shade?.clone() ?? null });
    copy.userData = { ...mat.userData, vrmxaIrisSide: 'L' };
    mat.userData.vrmxaIrisSide = 'R';
    g.setIndex([...right, ...left]);
    g.clearGroups();
    g.addGroup(0, right.length, 0);
    g.addGroup(right.length, left.length, 1);
    mesh.material = [mat, copy];
  }

  function applyFaceColours(face) {
    const key = JSON.stringify([face.morphs, face.colors]);
    if (keys.faceColours === key) return;
    keys.faceColours = key;
    const colors = face.colors;
    scene.traverse((o) => {
      if (o.morphTargetDictionary && o.morphTargetInfluences) {
        if (!morphOrig.has(o)) morphOrig.set(o, {});
        const orig = morphOrig.get(o);
        for (const [name, i] of Object.entries(o.morphTargetDictionary)) {
          const k = morphKey(name);
          if (!k || !offered.has(k.key)) continue;
          if (!(i in orig)) orig[i] = o.morphTargetInfluences[i] || 0;
          const w = face.morphs[k.key];
          o.morphTargetInfluences[i] = w == null ? orig[i] : w;
        }
      }
      if (!o.isMesh) return;
      const first = mats(o)[0];
      if (first && IRIS.test(first.name || '') && !Array.isArray(o.material) && (colors.irisL || colors.irisR)) splitIris(o, first);
      for (const m of mats(o)) {
        const c = TINT_MATCH.find((t) => t.match.test(m.name || ''));
        if (!c) continue;
        const ud = remember(m);
        let tint = colors[c.key];
        if (c.key === 'iris') {
          const side = m.userData.vrmxaIrisSide;
          tint = side === 'L' ? colors.irisL : side === 'R' ? colors.irisR : (colors.irisL ?? colors.irisR);
        }
        const t = tint ? new THREE.Color(tint[0], tint[1], tint[2]) : new THREE.Color(1, 1, 1);
        if (ud.color && m.color) m.color.copy(ud.color).multiply(t);
        if (ud.shade && m.shadeColorFactor) m.shadeColorFactor.copy(ud.shade).multiply(t);
      }
    });
  }

  // ---- face and head shapes (EDITS.md §3.4–3.6) --------------------------------------------------
  const origPos = new WeakMap();
  function positionAttrs(withBody) {
    const parents = new Set(), attrs = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      if (mats(o).some((m) => FACE_SKIN.test(m.name || ''))) parents.add(o.parent);
      else if (withBody && mats(o).some((m) => BODY_SKIN.test(m.name || '')) && o.geometry?.attributes?.position) attrs.add(o.geometry.attributes.position);
    });
    for (const p of parents) p?.traverse((o) => { if (o.isMesh && !o.userData.vrmxaDrawnHair && o.geometry?.attributes?.position) attrs.add(o.geometry.attributes.position); });
    return [...attrs];
  }
  function applyShapes(face) {
    if (!lm) return;
    const key = JSON.stringify([face.headShape, ...SHAPE_KEYS.map((k) => face.shapes[k] ?? null)]);
    if (keys.shapes === key) return;
    keys.shapes = key;
    const edited = shapesEdited(face);
    for (const attr of positionAttrs(!!lm.head)) {
      if (!origPos.has(attr)) { if (!edited) continue; origPos.set(attr, Float32Array.from(attr.array)); }
      const orig = origPos.get(attr);
      attr.array.set(edited ? deformPositions(orig, lm, face) : orig);
      attr.needsUpdate = true;
    }
    scene.traverse((o) => { if (o.isMesh && o.geometry?.boundingSphere) o.geometry.boundingSphere = null; });
  }

  // ---- the blush (EDITS.md §3.7) ----------------------------------------------------------------
  const blushState = new WeakMap(); // material -> { map, shade, pixels, tex }
  // does a material's MToon shade multiply use the same picture as its base colour in the file? three-vrm loads the
  // two as separate textures (separate images), so it can't be told from the objects (VRMXA §6.0 "Writing into avatar.vrm")
  const fileMat = new Map((json.materials || []).map((m) => [m.name, m]));
  const sharesShade = (m) => {
    if (m.shadeMultiplyTexture && m.shadeMultiplyTexture === m.map) return true;
    const f = fileMat.get(m.name) || fileMat.get((m.name || '').replace(/ \((Outline|left eye)\)$/, ''));
    const b = f?.pbrMetallicRoughness?.baseColorTexture?.index, sh = f?.extensions?.VRMC_materials_mtoon?.shadeMultiplyTexture?.index;
    return b != null && sh != null && (b === sh || json.textures?.[b]?.source === json.textures?.[sh]?.source);
  };
  const texState = new WeakMap(); // material -> { map, shade, visible, tex }, for textures()
  // finished textures from the layered editors, by material name (textures() below); the face skin's is the blush's base
  const layerPics = new Map();
  let layerVersion = 0, lastFace = null;
  function applyBlush(face) {
    lastFace = face;
    const on = !!lm && blushOn(face);
    const strength = face?.shapes?.blush ?? SHAPES.blush.def;
    const key = `${layerVersion}|${on ? JSON.stringify([face.colors.cheek, strength]) : ''}`;
    if (keys.blush === key) return;
    keys.blush = key;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of mats(o)) {
        if (!FACE_SKIN.test(m.name || '')) continue;
        if (!blushState.has(m)) blushState.set(m, { map: m.map || null, shade: m.shadeMultiplyTexture || null, pixels: undefined, tex: null });
        const st = blushState.get(m);
        const sameShade = !!st.shade && sharesShade(m);
        const over = layerPics.get(m.name) || null;
        if ((!on && !over) || !st.map) { m.map = st.map; if (sameShade) m.shadeMultiplyTexture = st.shade; continue; }
        if (!over && st.pixels === undefined) st.pixels = st.map.image ? pixelsOf(st.map.image) : null;
        const basePixels = over || st.pixels;
        if (!basePixels) continue;
        const img = { width: basePixels.width, height: basePixels.height, data: new Uint8ClampedArray(basePixels.data) };
        if (on) paintBlush(img, lm.cheekUV, face.colors.cheek, strength);
        st.tex = textureFrom(st.map, img, st.tex);
        m.map = st.tex;
        if (sameShade) m.shadeMultiplyTexture = st.tex;
      }
    });
  }

  // ---- hair colour and glow (EDITS.md §3.2) -------------------------------------------------------
  const hairState = new WeakMap(); // material -> { map, shade, emissive, emissiveMap, tex: Map(orig -> tex), pixels: Map }
  function applyHairColour(face) {
    const colour = isWhite(face.colors.hair) ? null : face.colors.hair;
    const glow = face.colors.hairEmission?.some((v) => v > 1e-3) ? face.colors.hairEmission : null;
    const key = JSON.stringify([colour, glow, keys.hairDesign ?? '']);
    if (keys.hairColour === key) return;
    keys.hairColour = key;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of mats(o)) {
        if (!isHairMaterial(m)) continue;
        if (!hairState.has(m)) hairState.set(m, { map: m.map || null, shade: m.shadeMultiplyTexture || null, emissive: m.emissive?.clone() ?? null, emissiveMap: m.emissiveMap || null, tex: new Map(), pixels: new Map() });
        const st = hairState.get(m);
        const paint = (orig) => {
          if (!orig?.image) return orig;
          if (!colour) return orig;
          if (!st.pixels.has(orig)) st.pixels.set(orig, pixelsOf(orig.image));
          const px = st.pixels.get(orig);
          if (!px) return orig;
          const tex = textureFrom(orig, overlayColour({ width: px.width, height: px.height, data: px.data }, colour), st.tex.get(orig));
          st.tex.set(orig, tex);
          return tex;
        };
        if (st.map) m.map = paint(st.map);
        if (st.shade) m.shadeMultiplyTexture = st.shade === st.map ? m.map : paint(st.shade);
        if (m.emissive && st.emissive) {
          const wantMap = glow ? null : st.emissiveMap;
          if ((m.emissiveMap || null) !== wantMap) { m.emissiveMap = wantMap; m.needsUpdate = true; }
          if (glow) m.emissive.setRGB(glow[0], glow[1], glow[2]); else m.emissive.copy(st.emissive);
        }
      }
    });
  }

  // ---- drawn hair (EDITS.md §6): meshes under the head bone, with a simple sway ------------------
  const headBone = vrm.humanoid?.getRawBoneNode?.('head') || null;
  let hairRoot = null;
  let groups = [];
  const centre = frame?.centre || [0, 0.08, 0.01];
  const radius = frame?.radius || 0.085;
  function clearDrawn() {
    for (const g of groups) { g.mesh.geometry.dispose(); g.mesh.material.map?.dispose(); g.mesh.material.dispose(); hairRoot?.remove(g.mesh); }
    groups = [];
  }
  function writeMesh(entry, paths, fresh) {
    const parts = paths.map((p) => strandMesh(p, centre, entry.group));
    const nPos = parts.reduce((a, p) => a + p.positions.length, 0);
    const geo = entry.mesh.geometry;
    if (fresh || !geo.attributes.position || geo.attributes.position.array.length !== nPos) {
      const pos = new Float32Array(nPos), nrm = new Float32Array(nPos), uv = new Float32Array((nPos / 3) * 2);
      const idx = [];
      let v = 0, o = 0, u = 0;
      for (const p of parts) {
        pos.set(p.positions, o); nrm.set(p.normals, o); uv.set(p.uvs, u);
        for (const i of p.indices) idx.push(i + v);
        o += p.positions.length; u += p.uvs.length; v += p.positions.length / 3;
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(idx);
      return;
    }
    let o = 0;
    for (const p of parts) { geo.attributes.position.array.set(p.positions, o); geo.attributes.normal.array.set(p.normals, o); o += p.positions.length; }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
  }
  function applyDrawnHair(design) {
    const key = JSON.stringify(design || {});
    if (keys.hairDesign === key) return;
    keys.hairDesign = key;
    if (!headBone) return;
    if (!hairRoot) { hairRoot = new THREE.Group(); hairRoot.name = 'DrawnHair'; headBone.add(hairRoot); }
    clearDrawn();
    for (const group of design?.groups || []) {
      if (!group.strands?.length) continue;
      const n = Math.round(paramOf(group, 'smooth'));
      const strands = group.strands.map((s) => {
        const restPts = smoothStroke(s.points, n);
        const minR = restPts.map((p) => Math.min(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2])) * 0.98);
        return { rest: restPts, n, minR, x: null, px: null };
      });
      const px = hairStrandTexture({ texWidth: paramOf(group, 'texWidth'), highlight: paramOf(group, 'highlight'), offset: paramOf(group, 'offset') }, group.color);
      const map = new THREE.DataTexture(px.data, px.width, px.height, THREE.RGBAFormat);
      map.colorSpace = THREE.SRGBColorSpace;
      map.wrapS = THREE.RepeatWrapping;
      map.needsUpdate = true;
      const mat = new THREE.MeshToonMaterial({ color: 0xffffff, map, side: THREE.DoubleSide });
      mat.name = `DrawnHair ${group.name}`;
      mat.userData[HAIR_MARK] = 'drawn';
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.name = `DrawnHair ${group.name}`;
      mesh.userData.vrmxaDrawnHair = true;
      mesh.frustumCulled = false;
      hairRoot.add(mesh);
      const entry = { mesh, group, strands };
      groups.push(entry);
      writeMesh(entry, strands.map((s) => s.rest), true);
    }
    keys.hairColour = null; // the new materials take the hair colour too
  }
  const tmp = new THREE.Vector3();
  function step(dt) {
    if (!hairRoot || !groups.length || dt <= 0) return;
    const h = Math.min(dt, 1 / 30);
    headBone.updateWorldMatrix(true, false);
    const M = headBone.matrixWorld, inv = M.clone().invert();
    const s = headBone.getWorldScale(tmp).x || 1;
    const C = new THREE.Vector3(...centre).applyMatrix4(M);
    for (const entry of groups) {
      const bounce = paramOf(entry.group, 'bounce'), grav = paramOf(entry.group, 'gravity');
      if (bounce <= 0.001) continue;
      const pull = 1 - bounce * 0.9;
      const paths = [];
      for (const st of entry.strands) {
        const restW = st.rest.map((p) => new THREE.Vector3(...p).applyMatrix4(M));
        if (!st.x) { st.x = restW.map((v) => v.clone()); st.px = restW.map((v) => v.clone()); }
        st.x[0].copy(restW[0]);
        for (let i = 1; i < st.n; i++) {
          const x = st.x[i], p = st.px[i];
          const vel = x.clone().sub(p).multiplyScalar(0.92);
          p.copy(x);
          x.add(vel);
          x.y -= grav * 9.8 * h * h;
          x.lerp(restW[i], pull * (1 - 0.6 * (i / st.n)) * 0.5);
          const seg = restW[i].distanceTo(restW[i - 1]);
          const d = x.clone().sub(st.x[i - 1]);
          const l = d.length() || 1;
          x.copy(st.x[i - 1]).addScaledVector(d, seg / l);
          const r = st.minR[i] * s;
          const fromC = x.clone().sub(C);
          if (fromC.length() < r) x.copy(C).addScaledVector(fromC.normalize(), r);
        }
        paths.push(st.x.map((v) => { const l = v.clone().applyMatrix4(inv); return [l.x, l.y, l.z]; }));
      }
      writeMesh(entry, paths, false);
    }
  }

  return {
    landmarks: lm,
    frame,
    /** The morphs the Face page may offer: those no expression drives (EDITS.md §3.1). */
    offeredMorphs: info.morphs.filter((m) => !m.bound).map(({ key, group, label }) => ({ key, group, label })),
    headTunes: HEAD_TUNES,
    /** Apply edits (readEdits(doc).edits). Only what changed since the last call is redone. */
    apply(edits, { lift = 0 } = {}) {
      const face = edits.face;
      applyBody(edits.body, face.bones, Number.isFinite(lift) ? lift : 0);
      applyShapes(face);
      applyFaceColours(face);
      applyBlush(face);
      applyDrawnHair(edits.hairDesign);
      applyHairColour(face);
    },
    step,
    /**
     * Finished textures from the layered editors, live (VRMXA §6.0, §6.1 "Showing a state"): { [material name]:
     * { width, height, data } } replaces each material's base colour picture, and its MToon shade multiply where it
     * used the same one; `hide` lists materials not drawn (an eye state's hidden targets). A material left out goes
     * back to its own texture. The face skin's picture is the base the blush is painted on. Calling it again with
     * changed pixels updates the same textures, so a painted stroke can be shown as it is drawn.
     */
    textures(pictures = {}, { hide = [] } = {}) {
      layerPics.clear();
      for (const [k, v] of Object.entries(pictures || {})) if (v) layerPics.set(k, v);
      layerVersion++;
      const hidden = new Set(hide);
      scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of mats(o)) {
          if (!texState.has(m)) texState.set(m, { map: m.map || null, shade: m.shadeMultiplyTexture || null, visible: m.visible, tex: null });
          const st = texState.get(m);
          m.visible = hidden.has(m.name) ? false : st.visible;
          if (FACE_SKIN.test(m.name || '')) continue; // drawn with the blush, below
          const sameShade = !!st.shade && sharesShade(m);
          const pic = layerPics.get(m.name);
          if (!pic || !st.map) { m.map = st.map; if (sameShade) m.shadeMultiplyTexture = st.shade; continue; }
          st.tex = textureFrom(st.map, pic, st.tex);
          m.map = st.tex;
          if (sameShade) m.shadeMultiplyTexture = st.tex;
        }
      });
      applyBlush(lastFace);
    },
    /**
     * The character's fine-tuning of worn items (VRMXA §7.5 `adjust`), live: { itemId: adjust }. The
     * meshes are found by the mark prepareItemModel leaves on them (extras.vrmxaFit), and moved by
     * the same formula the bake writes into avatar.vrm (closet/fit.js). An item left out goes back
     * to its own shape.
     */
    fit(adjusts = {}) {
      const key = JSON.stringify(adjusts);
      if (keys.fit === key) return;
      keys.fit = key;
      lastAdjusts = adjusts;
      scene.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        let f = null;
        for (let p = o; p && !f; p = p.parent) f = p.userData?.vrmxaFit || null;
        if (!f) return;
        const attr = o.geometry.attributes.position;
        if (!fitOrig.has(o.geometry)) fitOrig.set(o.geometry, attr.array.slice());
        const orig = specBase.get(o.geometry) || fitOrig.get(o.geometry);
        const adjust = adjusts[f.item];
        const next = adjust && adjustEdited(adjust) ? fitPositions(orig, o.geometry.attributes.normal?.array || null, adjust, f.centre, f.basis || null) : orig;
        attr.array.set(next);
        attr.needsUpdate = true;
        o.geometry.computeBoundingSphere();
      });
    },
    /**
     * Spec-fit's result (fit/worn.js fitWorn, `accessors`: POSITION accessor → { pos, normals, targets }, in
     * Spec's bind space), shown: each Spec-fitted item's vertices, normals and morph deltas take the fitted
     * values, so the skeleton puts them where the fit does on this body. The fine-tuning is applied on top,
     * as in avatar.vrm. null (or an item missing from it) puts the merged shape back.
     */
    specFit(accessors = null) {
      scene.traverse((o) => {
        if (!o.isMesh || !o.geometry?.attributes?.position || !o.userData.piece) return;
        let f = null;
        for (let p = o; p && !f; p = p.parent) f = p.userData?.vrmxaFit || null;
        if (!f) return;
        const [mi, pi] = o.userData.piece.split('/').map(Number);
        const prim = json.meshes?.[mi]?.primitives?.[pi];
        if (!prim) return;
        const g = o.geometry;
        const e = accessors?.get?.(prim.attributes.POSITION) || null;
        if (!specOrig.has(g)) specOrig.set(g, { normal: g.attributes.normal?.array.slice() || null, morphs: (g.morphAttributes?.position || []).map((a) => a.array.slice()) });
        if (!fitOrig.has(g)) fitOrig.set(g, g.attributes.position.array.slice());
        const orig = specOrig.get(g);
        if (!e) {
          specBase.delete(g);
          if (orig.normal) { g.attributes.normal.array.set(orig.normal); g.attributes.normal.needsUpdate = true; }
          (g.morphAttributes?.position || []).forEach((a, k) => { a.array.set(orig.morphs[k]); a.needsUpdate = true; });
          ownWeights(o);
          return;
        }
        const used = fileVertices(o).used;
        if (o.isSkinnedMesh && e.skin) bodyWeightsOn(o, e.skin, used); else ownWeights(o);
        const take = (src) => { const out = new Float32Array(used.length * 3); for (let k = 0; k < used.length; k++) { out[k * 3] = src[used[k] * 3]; out[k * 3 + 1] = src[used[k] * 3 + 1]; out[k * 3 + 2] = src[used[k] * 3 + 2]; } return out; };
        specBase.set(g, take(e.pos));
        if (e.normals && g.attributes.normal) { g.attributes.normal.array.set(take(e.normals)); g.attributes.normal.needsUpdate = true; }
        (prim.targets || []).forEach((t, k) => {
          const d = e.targets?.get?.(t.POSITION);
          const a = g.morphAttributes?.position?.[k];
          if (d && a) { a.array.set(take(d)); a.needsUpdate = true; }
        });
      });
      keys.fit = null;
      this.fit(lastAdjusts);
    },
    /** A mesh's primitive in the loaded file, its POSITION accessor, and the file's vertex of each geometry vertex. */
    fileVertices,
    /** Head space → for drawing strokes: a world point → [x, y, z] in the head bone's space. */
    toHead(p) { if (!headBone) return null; headBone.updateWorldMatrix(true, false); const l = headBone.worldToLocal(p.clone()); return [l.x, l.y, l.z]; },
    dispose() { clearDrawn(); hairRoot?.removeFromParent(); hairRoot = null; for (const w of wide.values()) w.skeleton.dispose(); wide.clear(); },
  };
}
