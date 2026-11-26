// A VRM 0.x avatar converted to VRM 1.0 on the way in (PRD IMP-11, CHR-7; VRMXW §14).
//
// It follows UniVRM's migration (vrm-c/UniVRM Packages/VRM10/Runtime/Migration, MIT) and the VRM 0.x and 1.0
//   specifications: the 180° turn about Y applied to geometry, nodes and inverse bind matrices together (0.x faces −Z,
//   1.0 faces +Z); MToon from `materialProperties`; springs from `secondaryAnimation` (chains expanded from
//   their roots, a 7 cm tail added, a node in one spring only); meta, humanoid (with the thumb's renaming),
//   expressions, look-at and first-person moved to VRMC_vrm.
// It works on a copy (the source's bytes are never changed); every accessor is read through
//   glb.js's bounds checks; a 0.x material is matched to its `materialProperties` entry by name before index
//   (UniVRM matches by name); conversion notes are returned instead of logged.

import { buildGlb, checkAccessor, parseGlb } from '../glb.js';
import { clone } from '../bytes.js';

const FLIP = [-1, 1, -1, 1]; // R = diag(−1, 1, −1): the turn, per row and column of a 4×4

/** True for a VRM 0.x glTF (the `VRM` extension and no `VRMC_vrm`). */
export function isVrm0(json) {
  return !!json?.extensions?.VRM && !json?.extensions?.VRMC_vrm;
}

const accessorProblem = (json, bin, ai) => {
  try { checkAccessor(json, bin, ai); return null; } catch (e) { return e.message; }
};

function conjugate(m) {
  const o = m.slice();
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] *= FLIP[r] * FLIP[c];
  return o;
}

function flipNodes(json) {
  for (const n of json.nodes || []) {
    if (Array.isArray(n.translation)) n.translation = [-n.translation[0], n.translation[1], -n.translation[2]];
    if (Array.isArray(n.rotation)) n.rotation = [-n.rotation[0], n.rotation[1], -n.rotation[2], n.rotation[3]];
    if (Array.isArray(n.matrix) && n.matrix.length === 16) n.matrix = conjugate(n.matrix);
  }
}

// negate components `comps` of a float accessor in place (dense and sparse), once per byte range
function flipAccessor(json, bin, ai, comps, seen, notes) {
  if (seen.has(`a${ai}`)) return;
  seen.add(`a${ai}`);
  const a = json.accessors?.[ai];
  if (!a) return;
  const problem = accessorProblem(json, bin, ai);
  if (problem) { notes.push(`accessor ${ai} was not turned: ${problem}`); return; }
  if (a.componentType !== 5126) { notes.push(`accessor ${ai} is not float and was not turned`); return; }
  const nc = a.type === 'VEC3' ? 3 : a.type === 'VEC4' ? 4 : 0;
  if (!nc) { notes.push(`accessor ${ai} (${a.type}) was not turned`); return; }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (a.bufferView !== undefined) {
    const bv = json.bufferViews[a.bufferView];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const key = `v${a.bufferView}:${start}`;
    if (!seen.has(key)) {
      seen.add(key);
      const stride = bv.byteStride || nc * 4;
      for (let i = 0; i < a.count; i++) for (const c of comps) {
        const o = start + i * stride + c * 4;
        dv.setFloat32(o, -dv.getFloat32(o, true), true);
      }
    }
  }
  if (a.sparse) {
    const vbv = json.bufferViews[a.sparse.values.bufferView];
    const vs = (vbv.byteOffset || 0) + (a.sparse.values.byteOffset || 0);
    const key = `s${a.sparse.values.bufferView}:${vs}`;
    if (!seen.has(key)) {
      seen.add(key);
      for (let i = 0; i < a.sparse.count; i++) for (const c of comps) {
        const o = vs + (i * nc + c) * 4;
        dv.setFloat32(o, -dv.getFloat32(o, true), true);
      }
    }
  }
  if (Array.isArray(a.min) && Array.isArray(a.max)) for (const c of comps) { const lo = a.min[c], hi = a.max[c]; a.min[c] = -hi; a.max[c] = -lo; }
}

function flipGeometry(json, bin, notes) {
  const seen = new Set();
  const XZ = [0, 2];
  for (const mesh of json.meshes || []) for (const p of mesh.primitives || []) {
    for (const name of ['POSITION', 'NORMAL', 'TANGENT']) if (p.attributes?.[name] !== undefined) flipAccessor(json, bin, p.attributes[name], XZ, seen, notes);
    for (const t of p.targets || []) for (const name of ['POSITION', 'NORMAL', 'TANGENT']) if (t[name] !== undefined) flipAccessor(json, bin, t[name], XZ, seen, notes);
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (const skin of json.skins || []) {
    const ai = skin.inverseBindMatrices;
    if (ai === undefined || seen.has(`ibm${ai}`)) continue;
    seen.add(`ibm${ai}`);
    const problem = accessorProblem(json, bin, ai);
    if (problem) { notes.push(`inverse bind matrices ${ai} were not turned: ${problem}`); continue; }
    const a = json.accessors[ai];
    const bv = json.bufferViews[a.bufferView];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride || 64;
    for (let i = 0; i < a.count; i++) for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      if (FLIP[r] * FLIP[c] === 1) continue;
      const o = start + i * stride + (c * 4 + r) * 4;
      dv.setFloat32(o, -dv.getFloat32(o, true), true);
    }
  }
  flipNodes(json);
}

/**
 * Turn a model 180° about Y on copies of its JSON and binary: geometry, morph offsets, nodes and inverse
 * bind matrices together, so skinning is unchanged. Its own inverse. → { json, bin, notes }
 */
export function turnAround(json0, bin0) {
  const json = clone(json0);
  const bin = bin0.slice();
  const notes = [];
  flipGeometry(json, bin, notes);
  return { json, bin, notes };
}

// ---- MToon (VRM.materialProperties → VRMC_materials_mtoon) -------------------------------------------

const vec = (vp, name, def, n = 3) => (Array.isArray(vp[name]) && vp[name].length >= n ? vp[name].slice(0, n).map(Number) : def);

function mtoonFromVrm0(src, mp) {
  if (!mp || mp.shader !== 'VRM/MToon') return src; // VRM_USE_GLTFSHADER or unlit: the glTF material stays
  const tp = mp.textureProperties || {}, fp = mp.floatProperties || {}, vp = mp.vectorProperties || {};
  const base = vec(vp, '_Color', [1, 1, 1, 1], 4);
  const mat = { name: src.name || '', pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.9, baseColorFactor: base } };
  if (Number.isInteger(tp._MainTex)) mat.pbrMetallicRoughness.baseColorTexture = { index: tp._MainTex };
  const blend = fp._BlendMode ?? 0;
  if (blend >= 2) mat.alphaMode = 'BLEND';
  else if (blend === 1) { mat.alphaMode = 'MASK'; mat.alphaCutoff = Number(fp._Cutoff ?? 0.5); }
  mat.doubleSided = (fp._CullMode ?? 2) === 0;
  if (Number.isInteger(tp._BumpMap)) mat.normalTexture = { index: tp._BumpMap, scale: Number(fp._BumpScale ?? 1) };
  let emissive = vec(vp, '_EmissionColor', [0, 0, 0]);
  if (Number.isInteger(tp._EmissionMap)) {
    mat.emissiveTexture = { index: tp._EmissionMap };
    if (emissive.every((c) => c === 0)) emissive = [1, 1, 1];
  }
  mat.emissiveFactor = emissive.map((c) => Math.min(c, 1));
  // a shade colour of black with no shade texture turns cloth black in shadow: darken the base instead
  let shade = vec(vp, '_ShadeColor', [0, 0, 0]);
  if (!Number.isInteger(tp._ShadeTexture) && Math.max(...shade) < 0.05) shade = [+(base[0] * 0.75).toFixed(3), +(base[1] * 0.7).toFixed(3), +Math.min(base[2] * 0.85, 1).toFixed(3)];
  const ow = fp._OutlineWidthMode ?? 0;
  const mt = {
    specVersion: '1.0',
    shadeColorFactor: shade,
    shadingShiftFactor: -0.05, // 0.x's shade shift and toony are not a 1:1 transfer; VRoid 1.0's own values
    shadingToonyFactor: 0.9,
    giEqualizationFactor: 0.9,
    transparentWithZWrite: !!(fp._ZWrite ?? 0) && blend >= 2,
    renderQueueOffsetNumber: 0,
    parametricRimColorFactor: vec(vp, '_RimColor', [0, 0, 0]),
    parametricRimFresnelPowerFactor: Number(fp._RimFresnelPower ?? 5),
    parametricRimLiftFactor: Number(fp._RimLift ?? 0),
    rimLightingMixFactor: Number(fp._RimLightingMix ?? 1),
    outlineWidthMode: ow === 1 ? 'worldCoordinates' : ow === 2 ? 'screenCoordinates' : 'none',
    outlineWidthFactor: Number(fp._OutlineWidth ?? 0) * 0.01, // centimetres to metres
    outlineColorFactor: vec(vp, '_OutlineColor', [0, 0, 0]),
    outlineLightingMixFactor: Number(fp._OutlineLightingMix ?? 1),
  };
  if (Number.isInteger(tp._ShadeTexture)) mt.shadeMultiplyTexture = { index: tp._ShadeTexture };
  if (Number.isInteger(tp._SphereAdd)) { mt.matcapTexture = { index: tp._SphereAdd }; mt.matcapFactor = [1, 1, 1]; }
  if (Number.isInteger(tp._RimTexture)) mt.rimMultiplyTexture = { index: tp._RimTexture };
  mat.extensions = { ...(src.extensions || {}), VRMC_materials_mtoon: mt };
  delete mat.extensions.KHR_materials_unlit; // so the toon material shades
  return mat;
}

// ---- springs (VRM.secondaryAnimation → VRMC_springBone) ---------------------------------------------

// 0.x spring and collider vectors become (−x, y, z) in 1.0 (UniVRM MigrationVector3, with the turn)
const migrateVec3 = (v) => [-(Number(v?.x) || 0), Number(v?.y) || 0, Number(v?.z) || 0];

// 1.0 has no implicit 7 cm end joint: add it as a node so the last real joint can swing
function addTail(nodes, last) {
  const t = nodes[last].translation || [0, 0, 0];
  const len = Math.hypot(t[0], t[1], t[2]) || 1;
  const s = 0.07 / len;
  nodes.push({ name: `${nodes[last].name || 'joint'}_end`, translation: [t[0] * s, t[1] * s, t[2] * s] });
  (nodes[last].children ||= []).push(nodes.length - 1);
  return nodes.length - 1;
}

function expandChain(nodes, root, params, name, groups, center, out, used) {
  const joint = (n) => ({ node: n, hitRadius: params.hitRadius, stiffness: params.stiffness, gravityPower: params.gravityPower, gravityDir: params.gravityDir, dragForce: params.dragForce });
  const recurse = (n, level, spring, depth) => {
    if (depth > 256) return;
    if (used.has(n)) {
      if (spring?.joints.length && spring.joints[spring.joints.length - 1].stiffness !== undefined) spring.joints.push({ node: addTail(nodes, spring.joints[spring.joints.length - 1].node) });
      return;
    }
    if (!spring && level > 0) {
      spring = { name, joints: [], colliderGroups: [...groups] };
      if (center != null) spring.center = center;
      out.push(spring);
    }
    if (spring) { spring.joints.push(joint(n)); used.add(n); }
    const children = (nodes[n]?.children || []).filter((c) => Number.isInteger(c) && c >= 0 && c < nodes.length);
    if (children.length) children.forEach((c, i) => (i === 0 ? recurse(c, level + 1, spring, depth + 1) : recurse(c, 0, null, depth + 1)));
    else if (spring?.joints.length) { const tail = addTail(nodes, n); spring.joints.push({ node: tail }); used.add(tail); }
  };
  recurse(root, 1, null, 0);
}

function springsFromVrm0(json) {
  const sa = json.extensions?.VRM?.secondaryAnimation;
  if (!sa) return null;
  const nodes = json.nodes || [];
  const colliders = [], colliderGroups = [];
  for (const g of sa.colliderGroups || []) {
    const idx = [];
    for (const c of g.colliders || []) {
      if (!c?.offset || c.radius === undefined) continue;
      idx.push(colliders.length);
      colliders.push({ node: g.node, shape: { sphere: { offset: migrateVec3(c.offset), radius: Number(c.radius) } } });
    }
    colliderGroups.push({ colliders: idx });
  }
  const springs = [];
  const used = new Set();
  for (const bg of sa.boneGroups || []) {
    const params = {
      stiffness: Number(bg.stiffiness ?? 1), dragForce: Number(bg.dragForce ?? 0.4), gravityPower: Number(bg.gravityPower ?? 0),
      gravityDir: migrateVec3(bg.gravityDir || { x: 0, y: -1, z: 0 }), hitRadius: Number(bg.hitRadius ?? 0.02),
    };
    const groups = (bg.colliderGroups || []).filter((i) => Number.isInteger(i) && i >= 0 && i < colliderGroups.length);
    const center = Number.isInteger(bg.center) && bg.center >= 0 && bg.center < nodes.length ? bg.center : null;
    for (const root of bg.bones || []) if (Number.isInteger(root) && root >= 0 && root < nodes.length) expandChain(nodes, root, params, bg.comment || 'spring', groups, center, springs, used);
  }
  for (let i = springs.length - 1; i >= 0; i--) if (springs[i].joints.length < 2) springs.splice(i, 1);
  for (const s of springs) if (!s.name && s.joints[0]) s.name = nodes[s.joints[0].node]?.name || 'spring';
  if (!springs.length && !colliders.length) return null;
  return { specVersion: '1.0', colliders, colliderGroups, springs };
}

// ---- meta, humanoid, expressions, look-at, first person ----------------------------------------------

const AVATAR_PERMISSION = { OnlyAuthor: 'onlyAuthor', ExplicitlyLicensedPerson: 'onlySeparatelyLicensedPerson', Everyone: 'everyone' };
// what a 0.x licence name allows, in 1.0 terms (VRM 1.0 meta.md; UniVRM MigrationVrmMeta)
const LICENCE_0X = {
  CC0: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'unnecessary' },
  CC_BY: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_NC: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_SA: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_NC_SA: { allowRedistribution: true, modification: 'allowModificationRedistribution', creditNotation: 'required' },
  CC_BY_ND: { allowRedistribution: true, modification: 'prohibited', creditNotation: 'required' },
  CC_BY_NC_ND: { allowRedistribution: true, modification: 'prohibited', creditNotation: 'required' },
};

/**
 * The terms in a VRoid Hub licence address (`https://hub.vroid.com/license?modification=allow&…`), which VRoid Hub
 * writes into a downloaded 0.x model's `otherLicenseUrl` / `otherPermissionUrl` under `licenseName: "Other"`. It is
 * the maker's licence, machine-readable, in the file itself. → the 1.0 fields it settles, or null when it is not one.
 */
export function vroidHubLicence(address) {
  let u;
  try { u = new URL(String(address || '')); } catch { return null; }
  if (u.hostname !== 'hub.vroid.com' || u.pathname.replace(/\/$/, '') !== '/license') return null;
  const q = (k) => u.searchParams.get(k);
  const out = {};
  if (q('modification')) out.modification = q('modification') === 'allow' ? (q('redistribution') === 'allow' ? 'allowModificationRedistribution' : 'allowModification') : 'prohibited';
  if (q('redistribution')) out.allowRedistribution = q('redistribution') === 'allow';
  if (q('credit')) out.creditNotation = q('credit') === 'unnecessary' ? 'unnecessary' : 'required';
  if (q('corporate_commercial_use') === 'allow') out.commercialUsage = 'corporation';
  else if (q('personal_commercial_use') === 'profit') out.commercialUsage = 'personalProfit';
  else if (q('personal_commercial_use') || q('corporate_commercial_use')) out.commercialUsage = 'personalNonProfit';
  if (q('allowed_to_use_user')) out.avatarPermission = q('allowed_to_use_user') === 'everyone' ? 'everyone' : 'onlyAuthor';
  if (q('sexual_expression')) out.allowExcessivelySexualUsage = q('sexual_expression') === 'allow';
  if (q('violent_expression')) out.allowExcessivelyViolentUsage = q('violent_expression') === 'allow';
  return Object.keys(out).length ? out : null;
}

const COMMERCIAL_RANK = { corporation: 0, personalProfit: 1, personalNonProfit: 2 };
const PERMISSION_RANK = { everyone: 0, onlySeparatelyLicensedPerson: 1, onlyAuthor: 2 };

/** A 0.x `meta` in 1.0's terms. Conservative where 0.x says nothing (no redistribution, no changes). */
export function metaFromVrm0(m0 = {}, json = {}, fallbackName = '') {
  const meta = {
    name: m0.title || fallbackName || 'Converted',
    version: m0.version || '',
    authors: [m0.author || 'unknown'],
    licenseUrl: 'https://vrm.dev/licenses/1.0/',
    avatarPermission: AVATAR_PERMISSION[m0.allowedUserName] || 'onlyAuthor',
    allowExcessivelyViolentUsage: m0.violentUssageName === 'Allow',
    allowExcessivelySexualUsage: m0.sexualUssageName === 'Allow',
    commercialUsage: m0.commercialUssageName === 'Allow' ? 'personalProfit' : 'personalNonProfit',
    allowRedistribution: false,
    modification: 'prohibited',
  };
  const lic = LICENCE_0X[m0.licenseName];
  if (lic) {
    Object.assign(meta, lic);
    if (/_NC/.test(m0.licenseName)) meta.commercialUsage = 'personalNonProfit';
  }
  // "Other" with a VRoid Hub licence address: the address is the licence. The fields 0.x also states (who may use it,
  // commercial use, the two expression flags) keep the stricter of the two; the rest come from the address alone.
  const hubAddress = !lic && [m0.otherLicenseUrl, m0.otherPermissionUrl].find((a) => vroidHubLicence(a));
  const hub = hubAddress ? vroidHubLicence(hubAddress) : null;
  if (hub) {
    for (const k of ['modification', 'allowRedistribution', 'creditNotation']) if (hub[k] !== undefined) meta[k] = hub[k];
    if (hub.commercialUsage && COMMERCIAL_RANK[hub.commercialUsage] < COMMERCIAL_RANK[meta.commercialUsage] && m0.commercialUssageName === 'Allow') meta.commercialUsage = hub.commercialUsage;
    if (hub.commercialUsage && COMMERCIAL_RANK[hub.commercialUsage] > COMMERCIAL_RANK[meta.commercialUsage]) meta.commercialUsage = hub.commercialUsage;
    if (hub.avatarPermission && PERMISSION_RANK[hub.avatarPermission] > PERMISSION_RANK[meta.avatarPermission]) meta.avatarPermission = hub.avatarPermission;
    for (const k of ['allowExcessivelySexualUsage', 'allowExcessivelyViolentUsage']) if (hub[k] === false) meta[k] = false;
  }
  if (m0.licenseName) meta.copyrightInformation = hub ? `VRM0 license: ${m0.licenseName} (VRoid Hub terms: ${hubAddress})` : `VRM0 license: ${m0.licenseName}`;
  if (m0.contactInformation) meta.contactInformation = String(m0.contactInformation);
  if (m0.reference) meta.references = [String(m0.reference)];
  if (m0.otherLicenseUrl || m0.otherPermissionUrl) meta.otherLicenseUrl = m0.otherLicenseUrl || m0.otherPermissionUrl;
  if (Number.isInteger(m0.texture) && m0.texture >= 0) {
    const src = json.textures?.[m0.texture]?.source;
    if (src !== undefined) meta.thumbnailImage = src;
  }
  return meta;
}

// 0.x Thumb Proximal / Intermediate / Distal are 1.0 Thumb Metacarpal / Proximal / Distal
const THUMB = { leftThumbProximal: 'leftThumbMetacarpal', leftThumbIntermediate: 'leftThumbProximal', rightThumbProximal: 'rightThumbMetacarpal', rightThumbIntermediate: 'rightThumbProximal' };

function humanoidFromVrm0(vrm0, notes) {
  const humanBones = {};
  for (const hb of vrm0.humanoid?.humanBones || []) {
    const bone = THUMB[hb.bone] || hb.bone;
    if (!bone || bone === 'unknown' || !Number.isInteger(hb.node)) continue;
    if (humanBones[bone]) { notes.push(`humanoid: ${bone} was listed twice; the first was kept`); continue; }
    humanBones[bone] = { node: hb.node };
  }
  if (humanBones.upperChest && !humanBones.chest) {
    humanBones.chest = humanBones.upperChest;
    delete humanBones.upperChest;
    notes.push('humanoid: an upper chest with no chest was used as the chest');
  }
  return { humanBones };
}

const PRESET = { a: 'aa', i: 'ih', u: 'ou', e: 'ee', o: 'oh', blink: 'blink', blink_l: 'blinkLeft', blink_r: 'blinkRight', joy: 'happy', angry: 'angry', sorrow: 'sad', fun: 'relaxed', lookup: 'lookUp', lookdown: 'lookDown', lookleft: 'lookLeft', lookright: 'lookRight', neutral: 'neutral' };
const NAMED = { surprised: 'surprised' };

const nodeOfMesh = (json) => {
  const map = new Map();
  (json.nodes || []).forEach((n, i) => { if (n.mesh !== undefined && !map.has(n.mesh)) map.set(n.mesh, i); });
  return map;
};

function expressionsFromVrm0(vrm0, json, notes) {
  const groups = vrm0.blendShapeMaster?.blendShapeGroups || [];
  if (!groups.length) return null;
  const m2n = nodeOfMesh(json);
  const preset = {}, custom = {};
  for (const g of groups) {
    const p = PRESET[(g.presetName || '').toLowerCase()] || NAMED[(g.name || '').toLowerCase()];
    const e = { isBinary: !!g.isBinary };
    const binds = [];
    for (const b of g.binds || []) {
      const node = m2n.get(b.mesh);
      if (node !== undefined && Number.isInteger(b.index)) binds.push({ node, index: b.index, weight: Number(b.weight ?? 100) / 100 });
    }
    if (binds.length) e.morphTargetBinds = binds;
    if (g.materialValues?.length) notes.push(`expression ${p || g.name}: ${g.materialValues.length} material changes were not carried over`);
    if (!binds.length && !p) continue;
    if (p) preset[p] = e; else if (g.name) custom[g.name] = e;
  }
  const out = {};
  if (Object.keys(preset).length) out.preset = preset;
  if (Object.keys(custom).length) out.custom = custom;
  return Object.keys(out).length ? out : null;
}

function lookAtFromVrm0(vrm0) {
  const fp = vrm0.firstPerson;
  if (!fp) return null;
  const bone = (fp.lookAtTypeName || 'Bone') === 'Bone';
  const off = fp.firstPersonBoneOffset || {};
  const range = (d, out) => ({ inputMaxValue: Number(d?.xRange ?? 90), outputScale: Number(d?.yRange ?? out) });
  const o = bone ? 10 : 1;
  return {
    type: bone ? 'bone' : 'expression',
    offsetFromHeadBone: [-(off.x ?? 0), off.y ?? 0.06, off.z ?? 0],
    rangeMapHorizontalInner: range(fp.lookAtHorizontalInner, o), rangeMapHorizontalOuter: range(fp.lookAtHorizontalOuter, o),
    rangeMapVerticalDown: range(fp.lookAtVerticalDown, o), rangeMapVerticalUp: range(fp.lookAtVerticalUp, o),
  };
}

const FP_FLAG = { Auto: 'auto', Both: 'both', ThirdPersonOnly: 'thirdPersonOnly', FirstPersonOnly: 'firstPersonOnly' };
function firstPersonFromVrm0(vrm0, json) {
  const m2n = nodeOfMesh(json);
  const meshAnnotations = [];
  for (const a of vrm0.firstPerson?.meshAnnotations || []) {
    const node = m2n.get(a.mesh);
    if (node !== undefined) meshAnnotations.push({ node, type: FP_FLAG[a.firstPersonFlag] || 'auto' });
  }
  return meshAnnotations.length ? { meshAnnotations } : null;
}

/**
 * Convert a parsed VRM 0.x. Works on copies: the `json` and `bin` given are not changed.
 * → { json, bin, notes: [text], mtoon (materials converted), springs } or null when it is not a 0.x VRM.
 */
export function convertVrm0(json0, bin0, { name = '' } = {}) {
  if (!isVrm0(json0)) return null;
  const json = clone(json0);
  const bin = bin0.slice();
  const notes = [];
  const vrm0 = json.extensions.VRM;
  // 1. geometry, nodes and bind matrices turned to face +Z, before the spring tails are added
  flipGeometry(json, bin, notes);
  // 2. MToon, matched by name, then by index
  const props = Array.isArray(vrm0.materialProperties) ? vrm0.materialProperties : [];
  const byName = new Map(props.filter((p) => p?.name).map((p) => [p.name, p]));
  let mtoon = 0;
  (json.materials || []).forEach((m, i) => {
    const out = mtoonFromVrm0(m, byName.get(m.name) || props[i]);
    if (out.extensions?.VRMC_materials_mtoon) mtoon++;
    json.materials[i] = out;
  });
  // 3. springs (adds tail nodes)
  const sb = springsFromVrm0(json);
  if (sb) json.extensions.VRMC_springBone = sb;
  // 4. the VRMC_vrm core
  const vrmc = { specVersion: '1.0', meta: metaFromVrm0(vrm0.meta || {}, json, name), humanoid: humanoidFromVrm0(vrm0, notes) };
  const expressions = expressionsFromVrm0(vrm0, json, notes);
  if (expressions) vrmc.expressions = expressions;
  const lookAt = lookAtFromVrm0(vrm0);
  if (lookAt) vrmc.lookAt = lookAt;
  const firstPerson = firstPersonFromVrm0(vrm0, json);
  if (firstPerson) vrmc.firstPerson = firstPerson;
  json.extensions.VRMC_vrm = vrmc;
  delete json.extensions.VRM;
  const used = new Set((json.extensionsUsed || []).filter((e) => e !== 'VRM'));
  used.add('VRMC_vrm');
  if (mtoon) used.add('VRMC_materials_mtoon');
  if (sb) used.add('VRMC_springBone');
  if (!(json.materials || []).some((m) => m.extensions?.KHR_materials_unlit)) used.delete('KHR_materials_unlit');
  json.extensionsUsed = [...used];
  if (json.extensionsRequired) json.extensionsRequired = json.extensionsRequired.filter((e) => e !== 'VRM');
  return { json, bin, notes, mtoon, springs: sb?.springs.length || 0 };
}

/** Bytes of a 0.x VRM → { glb, notes, … } as a VRM 1.0, or null when it is not a 0.x VRM. The input is not changed. */
export function convertVrm0Bytes(bytes, opts = {}) {
  const { json, bin } = parseGlb(bytes);
  const r = convertVrm0(json, bin, opts);
  return r ? { ...r, glb: buildGlb(r.json, r.bin) } : null;
}
