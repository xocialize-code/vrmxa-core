// "Dress" Spec in generated clothes, so the item writer has something to cut items from. Everything
// is made here from spec.vrm and its published measurements; no other model is used.
//
//   top    — a skinned shell around the torso, 6 mm off the skin at the measured stations, with a
//            ribbon down the back on three bones of its own that swing (VRMC_springBone, one collider)
//   hat    — skinned rigidly to the head (a skinned source cut as a pinned item)
//   sword  — an unskinned mesh under the right hand
//   staff  — an unskinned mesh under the left hand
// The materials are MToon (VRMC_materials_mtoon); the top's has a texture.

import { concat } from '../../src/bytes.js';
import { readAccessor } from '../../src/glb.js';
import { invert, multiply, parents, transformPoint, worldMatrix } from '../../src/math.js';
import { png } from './png.mjs';

const align4 = (n) => (n + 3) & ~3;

class Appender {
  constructor(json, bin) {
    this.json = json;
    this.base = align4(bin.length);
    this.bin = bin;
    this.parts = [];
    this.len = 0;
  }

  view(bytes, target) {
    const off = this.base + this.len;
    this.parts.push(bytes);
    this.len += bytes.length;
    const pad = (4 - (this.len % 4)) % 4;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.len += pad; }
    const bv = { buffer: 0, byteOffset: off, byteLength: bytes.length };
    if (target) bv.target = target;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }

  accessor(typed, componentType, type, { target, minmax = false } = {}) {
    const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const bv = this.view(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), target);
    const a = { bufferView: bv, componentType, count: typed.length / nc, type };
    if (minmax) {
      a.min = []; a.max = [];
      for (let c = 0; c < nc; c++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = c; i < typed.length; i += nc) { lo = Math.min(lo, typed[i]); hi = Math.max(hi, typed[i]); }
        a.min.push(Math.fround(lo)); a.max.push(Math.fround(hi));
      }
    }
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  finish() {
    const pad = new Uint8Array(this.base - this.bin.length);
    const out = concat([this.bin, pad, ...this.parts]);
    this.json.buffers[0].byteLength = out.length;
    return out;
  }
}

function mtoon(name, color, shade, texture) {
  const m = {
    name,
    pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.9 },
    alphaMode: 'OPAQUE',
    doubleSided: true,
    extensions: {
      KHR_materials_unlit: {},
      VRMC_materials_mtoon: {
        specVersion: '1.0', transparentWithZWrite: false, renderQueueOffsetNumber: 0, shadeColorFactor: shade, shadingShiftFactor: -0.05,
        shadingToonyFactor: 0.95, giEqualizationFactor: 0.9, matcapFactor: [0, 0, 0], parametricRimColorFactor: [0, 0, 0], rimLightingMixFactor: 1,
        parametricRimFresnelPowerFactor: 5, parametricRimLiftFactor: 0, outlineWidthMode: 'worldCoordinates', outlineWidthFactor: 0.0012,
        outlineColorFactor: [0.05, 0.05, 0.08], outlineLightingMixFactor: 1, uvAnimationScrollXSpeedFactor: 0, uvAnimationScrollYSpeedFactor: 0, uvAnimationRotationSpeedFactor: 0,
      },
    },
  };
  if (texture !== undefined) {
    m.pbrMetallicRoughness.baseColorTexture = { index: texture, texCoord: 0 };
    m.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: texture, texCoord: 0 };
  }
  return m;
}

function box([x0, y0, z0], [x1, y1, z1]) {
  const P = [], N = [], U = [], I = [];
  const faces = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]], [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]], [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]], [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
  ];
  for (const [n, q] of faces) {
    const b = P.length / 3;
    for (const [k, p] of q.entries()) { P.push(...p); N.push(...n); U.push(k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0); }
    I.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { P, N, U, I };
}

const merge = (...geos) => {
  const out = { P: [], N: [], U: [], I: [] };
  for (const g of geos) {
    const b = out.P.length / 3;
    out.P.push(...g.P); out.N.push(...g.N); out.U.push(...g.U); out.I.push(...g.I.map((i) => i + b));
  }
  return out;
};

function cylinder(r, y0, y1, n = 24) {
  const P = [], N = [], U = [], I = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI, c = Math.cos(a), s = Math.sin(a);
    P.push(r * c, y0, r * s, r * c, y1, r * s); N.push(c, 0, s, c, 0, s); U.push(k / n, 0, k / n, 1);
    if (k < n) I.push(2 * k, 2 * k + 1, 2 * k + 3, 2 * k, 2 * k + 3, 2 * k + 2);
  }
  // a lid
  const top = P.length / 3;
  P.push(0, y1, 0); N.push(0, 1, 0); U.push(0.5, 0.5);
  for (let k = 0; k < n; k++) I.push(top, 2 * k + 3, 2 * k + 1);
  return { P, N, U, I };
}

function disc(r, y, n = 24) {
  const P = [0, y, 0], N = [0, 1, 0], U = [0.5, 0.5], I = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    P.push(r * Math.cos(a), y, r * Math.sin(a)); N.push(0, 1, 0); U.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    if (k < n) I.push(0, k + 2, k + 1);
  }
  return { P, N, U, I };
}

/**
 * Dress Spec. json is changed in place; returns { json, bin, parts } where parts gives each item's
 * primitives ([[mesh, primitive]]).
 */
export function dressSpec(json, bin, measurements) {
  const A = new Appender(json, bin);
  const hb = json.extensions.VRMC_vrm.humanoid.humanBones;
  const node = (b) => hb[b].node;
  const pOf = parents(json.nodes);
  const bodySkinIndex = json.nodes.find((n) => n.name === 'Body').skin;
  const bodySkin = json.skins[bodySkinIndex];
  const bodyIbm = readAccessor(json, bin, bodySkin.inverseBindMatrices);
  const ibmOf = (n) => {
    const s = bodySkin.joints.indexOf(n);
    if (s < 0) throw new Error(`node ${n} is not a body joint`);
    return [...bodyIbm.subarray(s * 16, s * 16 + 16)];
  };
  const J = measurements.joints;
  json.textures ||= []; json.images ||= []; json.samplers ||= [];

  // ---- the top's texture and materials
  const tex = png(64, 64, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [70, 110, 170, 255] : [90, 135, 200, 255]));
  json.images.push({ name: 'FixtureTop', bufferView: A.view(tex), mimeType: 'image/png' });
  json.samplers.push({ magFilter: 9729, minFilter: 9729, wrapS: 10497, wrapT: 10497 });
  json.textures.push({ sampler: json.samplers.length - 1, source: json.images.length - 1 });
  const matTop = json.materials.push(mtoon('Fixture_Top_00_CLOTH', [1, 1, 1], [0.55, 0.62, 0.8], json.textures.length - 1)) - 1;
  const matRibbon = json.materials.push(mtoon('Fixture_Ribbon_00_CLOTH', [0.85, 0.2, 0.3], [0.5, 0.1, 0.18])) - 1;
  const matHat = json.materials.push(mtoon('Fixture_Hat_00_ACC', [0.25, 0.2, 0.15], [0.15, 0.12, 0.1])) - 1;
  const matMetal = json.materials.push(mtoon('Fixture_Metal_00_ACC', [0.75, 0.78, 0.82], [0.45, 0.48, 0.55])) - 1;
  const matWood = json.materials.push(mtoon('Fixture_Wood_00_ACC', [0.55, 0.38, 0.2], [0.35, 0.22, 0.12])) - 1;

  // ---- the ribbon's own bones, under upperChest
  const ucWorld = worldMatrix(json.nodes, node('upperChest'), pOf);
  const ribbonWorld = [[0, 1.2, -0.115], [0, 1.1, -0.125], [0, 1.0, -0.13]];
  const ribbonNodes = [];
  ribbonWorld.forEach((p, k) => {
    const parent = k === 0 ? node('upperChest') : ribbonNodes[k - 1];
    const parentWorld = k === 0 ? ucWorld : worldMatrix(json.nodes, parent, parents(json.nodes));
    const t = transformPoint(invert(parentWorld), p);
    json.nodes.push({ name: `J_Sec_Ribbon_${k + 1}`, translation: t.map((v) => Math.fround(v)) });
    const ni = json.nodes.length - 1;
    (json.nodes[parent].children ||= []).push(ni);
    ribbonNodes.push(ni);
  });
  const topJoints = [node('hips'), node('spine'), node('chest'), node('upperChest'), ...ribbonNodes];
  const topIbm = new Float32Array(topJoints.length * 16);
  topJoints.forEach((n, i) => topIbm.set(i < 4 ? ibmOf(n) : invert(worldMatrix(json.nodes, n, parents(json.nodes))), i * 16));
  json.skins.push({ name: 'FixtureTop', joints: topJoints, inverseBindMatrices: A.accessor(topIbm, 5126, 'MAT4') });
  const topSkin = json.skins.length - 1;

  // ---- the shell: rings at the torso stations, 6 mm off the skin
  const st = (id) => measurements.stations.find((s) => s.id === id);
  const rings = ['highHip', 'waist', 'underbust', 'bust'].map(st);
  rings.push({ ...st('bust'), at: 1.245, center: [0, 1.245, st('bust').center[2]], profile: st('bust').profile.map((r) => r * 0.82) });
  const boneY = [['hips', J.hips[1]], ['spine', J.spine[1]], ['chest', J.chest[1]], ['upperChest', J.upperChest[1]]];
  const weightsAt = (y) => {
    if (y <= boneY[0][1]) return [[0, 1]];
    for (let k = 0; k < boneY.length - 1; k++) {
      const [, a] = boneY[k], [, b] = boneY[k + 1];
      if (y <= b) { const t = (y - a) / (b - a); return [[k, 1 - t], [k + 1, t]]; }
    }
    return [[3, 1]];
  };
  const shell = { P: [], N: [], U: [], I: [], J: [], W: [] };
  const n = 32;
  rings.forEach((r, ri) => {
    for (let k = 0; k <= n; k++) {
      const a = ((k % n) / n) * 2 * Math.PI;
      const rad = r.profile[k % n] + 0.006;
      shell.P.push(r.center[0] + rad * Math.cos(a), r.at, r.center[2] + rad * Math.sin(a));
      shell.N.push(Math.cos(a), 0, Math.sin(a));
      shell.U.push(k / n, ri / (rings.length - 1));
      const w = weightsAt(r.at);
      shell.J.push(w[0][0], w[1]?.[0] ?? 0, 0, 0);
      shell.W.push(w[0][1], w[1]?.[1] ?? 0, 0, 0);
      if (ri < rings.length - 1 && k < n) {
        const a0 = ri * (n + 1) + k, b0 = (ri + 1) * (n + 1) + k;
        shell.I.push(a0, b0, b0 + 1, a0, b0 + 1, a0 + 1);
      }
    }
  });
  // the ribbon strip: rows at each ribbon bone and one below, weighted to slots 4, 5, 6
  const strip = { P: [], N: [], U: [], I: [], J: [], W: [] };
  const rows = [...ribbonWorld, [0, 0.9, -0.132]];
  rows.forEach((p, k) => {
    for (const x of [-0.022, 0.022]) {
      strip.P.push(x, p[1], p[2] - 0.004); strip.N.push(0, 0, -1); strip.U.push(x > 0 ? 1 : 0, k / 3);
      strip.J.push(4 + Math.min(k, 2), 0, 0, 0); strip.W.push(1, 0, 0, 0);
    }
    if (k < rows.length - 1) { const b = k * 2; strip.I.push(b, b + 2, b + 3, b, b + 3, b + 1); }
  });
  const prim = (g, material, skinned) => {
    const attributes = {
      POSITION: A.accessor(new Float32Array(g.P), 5126, 'VEC3', { target: 34962, minmax: true }),
      NORMAL: A.accessor(new Float32Array(g.N), 5126, 'VEC3', { target: 34962 }),
      TEXCOORD_0: A.accessor(new Float32Array(g.U), 5126, 'VEC2', { target: 34962 }),
    };
    if (skinned) {
      attributes.JOINTS_0 = A.accessor(new Uint16Array(g.J), 5123, 'VEC4', { target: 34962 });
      attributes.WEIGHTS_0 = A.accessor(new Float32Array(g.W), 5126, 'VEC4', { target: 34962 });
    }
    return { attributes, indices: A.accessor(new Uint16Array(g.I), 5123, 'SCALAR', { target: 34963 }), material, mode: 4 };
  };
  json.meshes.push({ name: 'FixtureTop', primitives: [prim(shell, matTop, true), prim(strip, matRibbon, true)] });
  const topMesh = json.meshes.length - 1;
  json.nodes.push({ name: 'FixtureTop', mesh: topMesh, skin: topSkin });
  json.scenes[0].nodes.push(json.nodes.length - 1);

  // ---- the ribbon's spring, with a collider on the spine
  const sb = json.extensions.VRMC_springBone;
  sb.colliders ||= [];
  sb.colliderGroups ||= [];
  sb.colliders.push({ node: node('spine'), shape: { sphere: { offset: [0, 0.02, -0.02], radius: 0.09 } } });
  sb.colliderGroups.push({ name: 'FixtureBack', colliders: [sb.colliders.length - 1] });
  sb.springs.push({ name: 'FixtureRibbon', joints: ribbonNodes.map((nd) => ({ node: nd, hitRadius: 0.01, stiffness: 0.8, gravityPower: 0.3, gravityDir: [0, -1, 0], dragForce: 0.4 })), colliderGroups: [sb.colliderGroups.length - 1] });

  // ---- the hat: skinned rigidly to the head
  const headTop = measurements.lengths.stature;
  const hat = merge(cylinder(0.105, headTop - 0.07, headTop + 0.06), disc(0.17, headTop - 0.07));
  hat.J = []; hat.W = [];
  for (let i = 0; i < hat.P.length / 3; i++) { hat.J.push(0, 0, 0, 0); hat.W.push(1, 0, 0, 0); }
  const hz = J.head[2];
  for (let i = 0; i < hat.P.length; i += 3) hat.P[i + 2] += hz;
  json.skins.push({ name: 'FixtureHat', joints: [node('head')], inverseBindMatrices: A.accessor(new Float32Array(ibmOf(node('head'))), 5126, 'MAT4') });
  json.meshes.push({ name: 'FixtureHat', primitives: [prim(hat, matHat, true)] });
  json.nodes.push({ name: 'FixtureHat', mesh: json.meshes.length - 1, skin: json.skins.length - 1 });
  json.scenes[0].nodes.push(json.nodes.length - 1);
  const hatMesh = json.meshes.length - 1;

  // ---- the sword and the staff: unskinned, under the hands
  const sword = merge(box([-0.012, -0.02, -0.004], [0.012, 0.02, 0.62]), box([-0.06, -0.012, -0.03], [0.06, 0.012, -0.004]), box([-0.014, -0.014, -0.16], [0.014, 0.014, -0.03]));
  json.meshes.push({ name: 'FixtureSword', primitives: [prim(sword, matMetal, false)] });
  json.nodes.push({ name: 'FixtureSword', mesh: json.meshes.length - 1, translation: [-0.06, -0.02, 0.02] });
  (json.nodes[node('rightHand')].children ||= []).push(json.nodes.length - 1);
  const swordMesh = json.meshes.length - 1;
  const staff = merge(box([-0.012, -0.7, -0.012], [0.012, 0.7, 0.012]), box([-0.03, 0.7, -0.03], [0.03, 0.76, 0.03]));
  json.meshes.push({ name: 'FixtureStaff', primitives: [prim(staff, matWood, false)] });
  json.nodes.push({ name: 'FixtureStaff', mesh: json.meshes.length - 1, translation: [0.06, -0.02, 0.02] });
  (json.nodes[node('leftHand')].children ||= []).push(json.nodes.length - 1);
  const staffMesh = json.meshes.length - 1;

  return {
    json, bin: A.finish(),
    parts: { top: [[topMesh, 0], [topMesh, 1]], hat: [[hatMesh, 0]], sword: [[swordMesh, 0]], staff: [[staffMesh, 0]] },
  };
}

/** A copy of a VRM with its own name and authors (the character's details live in the VRM, §5.3). */
export function renameVrm(json, name, authors) {
  const j = JSON.parse(JSON.stringify(json));
  Object.assign(j.extensions.VRMC_vrm.meta, { name, authors });
  return j;
}

export { multiply };
