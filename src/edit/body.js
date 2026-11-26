// Body page: body controls (Height, Physique, Slender, Head, Neck, Shoulders, Arms, Hands, Bust,
// Waist, Legs, Feet) on a VRM, through its humanoid bones. DOM-free.
//
// A VRM has its body shape baked into the mesh, so these reshape it through its bones. Per node:
//   hier   extra scale on the node; everything under it follows (whole body, head, hands, feet, bust)
//   trans  stretches the node's offset from its parent (bone lengths), in the parent's frame
//   skin   scales only the skin the bone carries, in its own frame (widths, thickness)
//   offset moves the node (bust height / spacing)
// After reshaping, the body is moved so its lowest point stays on the ground.
// Live, the viewer sets node position / scale and folds `skin` into each skeleton's inverse bind
// matrices (three/live.js), so worn clothes and hair follow. Saving (bakeBody) writes a clean rig:
// the vertices are moved by the same transforms, the bones keep scale 1 and get new positions and
// inverse bind matrices, so the file needs nothing special to show the new shape.
// The amounts at ±1 are this library's own (estimated), as EDITS.md §4 lists them.

import { readAccessor } from '../glb.js';

const S = (key, label) => ({ key, label, min: -1, max: 1 });
export const BODY_PARTS = [
  {
    id: 'overall', label: 'Overall',
    sliders: [S('height', 'Height'), S('physique', 'Female / Male Physique'), S('slender', 'Slender'),
      S('headSize', 'Head Size'), S('headWidth', 'Head Narrow / Wide')],
  },
  {
    id: 'upper', label: 'Upper Body',
    sliders: [S('neckLength', 'Neck Length'), S('neckWidth', 'Neck Width'), S('shoulderWidth', 'Shoulder Width'),
      S('armLength', 'Arm Length'), S('handSize', 'Hand Size'), S('bustSize', 'Bust Size'),
      S('bustY', 'Bust Up / Down'), S('bustOpen', 'Bust Open / Close')],
  },
  {
    id: 'lower', label: 'Lower Body',
    sliders: [S('waistLength', 'Waist Length'), S('waistSize', 'Waist Size'), S('legLength', 'Leg Length'),
      S('footSize', 'Foot Size')],
  },
  { id: 'skin', label: 'Skin', sliders: [] },
];
export const BODY_SLIDERS = Object.fromEntries(BODY_PARTS.flatMap((p) => p.sliders.map((s) => [s.key, s])));

// How far each control goes at ±1 (this library's own amounts; estimated)
export const AMOUNTS = {
  height: 0.12, physiqueHips: 0.06, physiqueChest: 0.08, physiqueShoulder: 0.08, physiqueBust: 0.6,
  slender: 0.14, headSize: 0.15, headWidth: 0.12, neckLength: 0.4, neckWidth: 0.25, shoulderWidth: 0.15,
  armLength: 0.12, handSize: 0.2, bustSize: 0.6, bustMin: 0.2, bustY: 0.012, bustOpen: 0.01,
  waistLength: 0.25, waistSize: 0.18, legLength: 0.12, footSize: 0.18,
};


export const bodyEdited =(body) => Object.entries(body || {}).some(([k, v]) => BODY_SLIDERS[k] && Math.abs(v) > 1e-4);

// ---- the rig as the file has it --------------------------------------------------------------

/** What the reshaping needs from a glTF: node names, parents, rest TRS, humanoid bones. */
export function bodyRig(json) {
  const nodes = json.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => { parent[c] = i; }));
  const locals = nodes.map((n) => ({
    t: n.translation ? [...n.translation] : [0, 0, 0],
    r: n.rotation ? [...n.rotation] : [0, 0, 0, 1],
    s: n.scale ? [...n.scale] : [1, 1, 1],
    m: n.matrix || null,
  }));
  const bones = {};
  const hb = json.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (hb) for (const [k, v] of Object.entries(hb)) bones[k] = v.node;
  for (const b of json.extensions?.VRM?.humanoid?.humanBones || []) bones[b.bone] = b.node;
  const rig = { names: nodes.map((n) => n.name || ''), parent, locals, bones };
  rig.rest = composeWorld(rig, null);
  // the node that carries everything: the top ancestor of the hips ("Root" in VRoid's exported files)
  let top = bones.hips ?? -1;
  while (top >= 0 && parent[top] >= 0) top = parent[top];
  rig.top = top;
  return rig;
}

// ---- small 4x4 helpers (column-major, as glTF) ------------------------------------------------
export function trs(t, r, s) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
export function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
export const scaleM = (s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
export const apply = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];
export function invert(m) {
  // affine inverse via the 3x3 part
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const inv3 = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  // inv3 is row-major [r0c0, r0c1, r0c2, r1c0, ...]
  const o = [inv3[0], inv3[3], inv3[6], 0, inv3[1], inv3[4], inv3[7], 0, inv3[2], inv3[5], inv3[8], 0, 0, 0, 0, 1];
  const t = apply(o, [m[12], m[13], m[14]]);
  o[12] = -t[0]; o[13] = -t[1]; o[14] = -t[2];
  return o;
}

// ---- the shape ---------------------------------------------------------------------------------

const ONE = () => [1, 1, 1];
const mul3 = (a, b) => { a[0] *= b[0]; a[1] *= b[1]; a[2] *= b[2]; };
const mulS = (a, k) => { a[0] *= k; a[1] *= k; a[2] *= k; };

/**
 * Per-node hier / trans / skin / offset for these edits: { body, bones } — the edit document's
 * `body` (EDITS.md §4) and `face.bones` (§3.3: Iris Size scales the eye bones).
 */
export function bodyShape(rig, edits) {
  const n = rig.names.length;
  const sh = { hier: Array.from({ length: n }, ONE), trans: Array.from({ length: n }, ONE),
    skin: Array.from({ length: n }, ONE), offset: Array.from({ length: n }, () => [0, 0, 0]) };
  const body = edits?.body || {};
  const raw = (k) => Math.max(-1, Math.min(1, Number(body[k]) || 0));
  const v = raw;
  const A = AMOUNTS;
  const b = (name) => rig.bones[name];
  const both = (name) => ['left', 'right'].map((s) => b(s + name)).filter((i) => i != null);
  const p = v('physique');
  const hips = b('hips');
  if (hips != null) {
    mulS(sh.hier[hips], 1 + v('height') * A.height);
    mul3(sh.skin[hips], [1 - p * A.physiqueHips, 1, 1]);
  }
  const slim = 1 - v('slender') * A.slender;
  for (const name of ['spine', 'chest', 'upperChest', 'hips']) if (b(name) != null) mul3(sh.skin[b(name)], [slim, 1, slim]);
  for (const name of ['UpperLeg', 'LowerLeg']) for (const i of both(name)) mul3(sh.skin[i], [slim, 1, slim]);
  for (const name of ['UpperArm', 'LowerArm']) for (const i of both(name)) mul3(sh.skin[i], [1, slim, slim]);
  if (b('chest') != null) mul3(sh.skin[b('chest')], [1 + p * A.physiqueChest, 1, 1]);
  const head = b('head');
  if (head != null) {
    const k = 1 + v('headSize') * A.headSize;
    mul3(sh.hier[head], [(1 + v('headWidth') * A.headWidth) * k, k, k]);
    mulS(sh.trans[head], 1 + v('neckLength') * A.neckLength);
  }
  if (b('neck') != null) {
    const w = 1 + v('neckWidth') * A.neckWidth;
    mul3(sh.skin[b('neck')], [w, 1 + v('neckLength') * A.neckLength, w]);
  }
  const sw = (1 + v('shoulderWidth') * A.shoulderWidth) * (1 + p * A.physiqueShoulder);
  for (const i of both('UpperArm')) mul3(sh.trans[i], [sw, 1, 1]);
  for (const i of both('Shoulder')) mul3(sh.skin[i], [sw, 1, 1]);
  const al = 1 + v('armLength') * A.armLength;
  for (const name of ['LowerArm', 'Hand']) for (const i of both(name)) mulS(sh.trans[i], al);
  for (const name of ['UpperArm', 'LowerArm']) for (const i of both(name)) mul3(sh.skin[i], [al, 1, 1]);
  for (const i of both('Hand')) mulS(sh.hier[i], 1 + v('handSize') * A.handSize);
  if (b('chest') != null) mul3(sh.trans[b('chest')], [1, 1 + v('waistLength') * A.waistLength, 1]);
  if (b('spine') != null) {
    const ws = 1 + v('waistSize') * A.waistSize;
    mul3(sh.skin[b('spine')], [ws, 1 + v('waistLength') * A.waistLength, ws]);
  }
  const ll = 1 + v('legLength') * A.legLength;
  for (const name of ['LowerLeg', 'Foot']) for (const i of both(name)) mul3(sh.trans[i], [1, ll, 1]);
  for (const name of ['UpperLeg', 'LowerLeg']) for (const i of both(name)) mul3(sh.skin[i], [1, ll, 1]);
  for (const i of both('Foot')) mulS(sh.hier[i], 1 + v('footSize') * A.footSize);
  // bust: the first "Bust" bone of each chain
  const bk = Math.max(A.bustMin, (1 + v('bustSize') * A.bustSize) * (1 - Math.max(p, 0) * A.physiqueBust));
  for (let i = 0; i < n; i++) {
    const name = rig.names[i].toLowerCase();
    const par = rig.parent[i];
    if (!name.includes('bust') || name.endsWith('_end') || (par >= 0 && rig.names[par].toLowerCase().includes('bust'))) continue;
    mulS(sh.hier[i], bk);
    const side = Math.sign(rig.rest[i][12]) || 1;
    sh.offset[i][0] += side * v('bustOpen') * A.bustOpen;
    sh.offset[i][1] += v('bustY') * A.bustY;
  }
  // Face page: Iris Size scales the eye bones
  const iris = Number(edits?.bones?.iris) || 1;
  for (const e of ['leftEye', 'rightEye']) if (b(e) != null && iris !== 1) mulS(sh.hier[b(e)], iris);
  return sh;
}

/** The shaped local TRS of node i (as the viewer sets it). */
export function shapedLocal(rig, sh, i) {
  const L = rig.locals[i];
  if (!sh) return L;
  return {
    t: [L.t[0] * sh.trans[i][0] + sh.offset[i][0], L.t[1] * sh.trans[i][1] + sh.offset[i][1], L.t[2] * sh.trans[i][2] + sh.offset[i][2]],
    r: L.r,
    s: [L.s[0] * sh.hier[i][0], L.s[1] * sh.hier[i][1], L.s[2] * sh.hier[i][2]],
    m: L.m,
  };
}

/** World matrices of every node in the rest pose, shaped (sh) or as the file has them (null). lift: added to the top node's y. */
export function composeWorld(rig, sh, lift = 0) {
  const n = rig.names.length;
  const out = new Array(n);
  const done = (i) => {
    if (out[i]) return out[i];
    const L = shapedLocal(rig, sh, i);
    let local = L.m ? [...L.m] : trs(L.t, L.r, L.s);
    if (i === rig.top && lift) local = [...local.slice(0, 13), local[13] + lift, local[14], local[15]];
    out[i] = rig.parent[i] >= 0 ? mul(done(rig.parent[i]), local) : local;
    return out[i];
  };
  for (let i = 0; i < n; i++) done(i);
  return out;
}

const isWeight = (w) => w > 1e-6;

/**
 * The skinning transform of each joint of a skin, shaped: world' · skin scale · inverse bind.
 * A vertex moves to Σ weight · K · v (skinning with the shape applied).
 */
function jointTransforms(json, bin, skinIndex, world, sh) {
  const skin = json.skins[skinIndex];
  const ibm = skin.inverseBindMatrices != null ? readAccessor(json, bin, skin.inverseBindMatrices) : null;
  return skin.joints.map((node, j) => {
    const inv = ibm ? Array.from(ibm.slice(j * 16, j * 16 + 16)) : scaleM([1, 1, 1]);
    return mul(mul(world[node], scaleM(sh.skin[node])), inv);
  });
}

function blend(Ks, joints, weights, v, out) {
  let x = 0, y = 0, z = 0, ws = 0;
  for (let k = 0; k < 4; k++) {
    const w = weights[k];
    if (!isWeight(w)) continue;
    const p = apply(Ks[joints[k]], v);
    x += w * p[0]; y += w * p[1]; z += w * p[2]; ws += w;
  }
  if (ws < 1e-6) { out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; return; }
  out[0] = x / ws; out[1] = y / ws; out[2] = z / ws;
}

// skinned primitives: [{ prim, skinIndex }]
function skinnedPrims(json) {
  const out = [];
  (json.nodes || []).forEach((node) => {
    if (node.mesh == null || node.skin == null) return;
    for (const prim of json.meshes[node.mesh].primitives) out.push({ prim, skinIndex: node.skin, mesh: node.mesh });
  });
  return out;
}

const BODY_SKIN = /(^|_)Body_\d+_SKIN/i;

/**
 * The lowest points of the body (where it stands), for keeping the feet on the ground:
 * [{ v, joints (node indices), weights, skinIndex }], at most `max`, plus their lowest y.
 */
export function soleSamples(json, bin, max = 300) {
  const cand = [];
  for (const { prim, skinIndex } of skinnedPrims(json)) {
    if (!BODY_SKIN.test(json.materials?.[prim.material]?.name || '')) continue;
    const a = prim.attributes;
    if (a.POSITION == null || a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
    const pos = readAccessor(json, bin, a.POSITION), jn = readAccessor(json, bin, a.JOINTS_0), wt = readAccessor(json, bin, a.WEIGHTS_0);
    const used = prim.indices != null ? new Set(readAccessor(json, bin, prim.indices)) : null;
    const nrm = json.accessors[a.WEIGHTS_0].normalized ? (json.accessors[a.WEIGHTS_0].componentType === 5121 ? 255 : 65535) : 1;
    for (let i = 0; i < pos.length / 3; i++) {
      if (used && !used.has(i)) continue;
      cand.push({ v: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], joints: [...jn.slice(i * 4, i * 4 + 4)],
        weights: [...wt.slice(i * 4, i * 4 + 4)].map((w) => w / nrm), skinIndex });
    }
  }
  cand.sort((a, b) => a.v[1] - b.v[1]);
  const samples = cand.slice(0, max);
  return { samples, minY: samples.length ? samples[0].v[1] : 0 };
}

/** How much to lift the shaped body so its lowest sample stays where it was. */
export function groundLift(json, bin, rig, sh, soles) {
  if (!soles?.samples.length) return 0;
  const world = composeWorld(rig, sh);
  const Kby = new Map();
  let lo = Infinity;
  const out = [0, 0, 0];
  for (const s of soles.samples) {
    if (!Kby.has(s.skinIndex)) Kby.set(s.skinIndex, jointTransforms(json, bin, s.skinIndex, world, sh));
    blend(Kby.get(s.skinIndex), s.joints, s.weights, s.v, out);
    lo = Math.min(lo, out[1]);
  }
  return soles.minY - lo;
}

// ---- writing it into the file -------------------------------------------------------------------

// write a float accessor's values back where they are (dense or strided); a sparse one becomes a
// new dense accessor (appended) -> new bin
function writeFloats(json, bin, ai, arr, append) {
  const a = json.accessors[ai];
  const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  if (a.componentType === 5126 && a.bufferView != null && !a.sparse) {
    const bv = json.bufferViews[a.bufferView];
    const stride = bv.byteStride || nc * 4;
    const dv = new DataView(bin.buffer, bin.byteOffset);
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) dv.setFloat32(start + i * stride + c * 4, arr[i * nc + c], true);
    return { bin, ai };
  }
  const f = Float32Array.from(arr);
  const [nb, view] = append(bin, new Uint8Array(f.buffer));
  json.accessors.push({ bufferView: view, componentType: 5126, count: a.count, type: a.type });
  return { bin: nb, ai: json.accessors.length - 1 };
}

function setMinMax(json, ai, arr) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i++) { const c = i % 3; if (arr[i] < min[c]) min[c] = arr[i]; if (arr[i] > max[c]) max[c] = arr[i]; }
  json.accessors[ai].min = min; json.accessors[ai].max = max;
}

/**
 * Write the body edits into the glTF (json changed in place; bin is the caller's own copy, written
 * in place where it can be). Vertices, normals and morph deltas move by the shaped skinning
 * transforms; bones get scale 1, new positions and new inverse bind matrices; spring colliders and
 * the look-at offset follow their bones' size. -> new bin (bin itself when nothing to do).
 * append(bin, bytes) -> [bin, bufferView index] adds data at the end.
 */
export function bakeBody(json, bin, edits, append) {
  const rig = bodyRig(json);
  const sh = bodyShape(rig, edits);
  const moved = (i) => sh.hier[i].some((x) => x !== 1) || sh.trans[i].some((x) => x !== 1) || sh.skin[i].some((x) => x !== 1) || sh.offset[i].some((x) => x !== 0);
  const extra = Number.isFinite(edits?.lift) ? edits.lift : 0; // worn shoes raise the figure (VRMXW §7.1)
  if (!rig.names.some((_, i) => moved(i)) && !extra) return bin;
  const lift = groundLift(json, bin, rig, sh, soleSamples(json, bin)) + extra;
  const world = composeWorld(rig, sh, lift);

  // vertices (several primitives may share one vertex list; each list and each morph delta once)
  const doneAcc = new Set();
  const doneT = new Set();
  for (const { prim, skinIndex } of skinnedPrims(json)) {
    const a = prim.attributes;
    if (a.POSITION == null || a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
    const firstTime = !doneAcc.has(a.POSITION);
    doneAcc.add(a.POSITION);
    const Ks = jointTransforms(json, bin, skinIndex, world, sh);
    const lin = Ks.map((K) => [K[0], K[1], K[2], K[4], K[5], K[6], K[8], K[9], K[10]]);
    const nrmT = lin.map((m) => { // inverse transpose of the 3x3 (for normals)
      const inv = invert([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1]);
      return inv ? [inv[0], inv[4], inv[8], inv[1], inv[5], inv[9], inv[2], inv[6], inv[10]] : m;
    });
    const pos = readAccessor(json, bin, a.POSITION);
    const jn = readAccessor(json, bin, a.JOINTS_0), wt0 = readAccessor(json, bin, a.WEIGHTS_0);
    const wa = json.accessors[a.WEIGHTS_0];
    const norm = wa.normalized ? (wa.componentType === 5121 ? 255 : 65535) : 1;
    const count = pos.length / 3;
    const lb = (mats, i, v) => { // blend 3x3 matrices of vertex i applied to v
      let x = 0, y = 0, z = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = wt0[i * 4 + k] / norm;
        if (!isWeight(w)) continue;
        const m = mats[jn[i * 4 + k]];
        x += w * (m[0] * v[0] + m[3] * v[1] + m[6] * v[2]);
        y += w * (m[1] * v[0] + m[4] * v[1] + m[7] * v[2]);
        z += w * (m[2] * v[0] + m[5] * v[1] + m[8] * v[2]);
        ws += w;
      }
      return ws < 1e-6 ? v : [x / ws, y / ws, z / ws];
    };
    let r;
    if (firstTime) {
      const np = new Float32Array(pos.length);
      const o = [0, 0, 0];
      for (let i = 0; i < count; i++) {
        blend(Ks, jn.slice(i * 4, i * 4 + 4), [0, 1, 2, 3].map((k) => wt0[i * 4 + k] / norm), [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], o);
        np[i * 3] = o[0]; np[i * 3 + 1] = o[1]; np[i * 3 + 2] = o[2];
      }
      r = writeFloats(json, bin, a.POSITION, np, append);
      bin = r.bin;
      setMinMax(json, r.ai, np);
      const repoint = (attr, from, to) => { if (from === to) return; for (const { prim: p2 } of skinnedPrims(json)) if (p2.attributes[attr] === from) p2.attributes[attr] = to; };
      const oldPos = a.POSITION;
      repoint('POSITION', oldPos, r.ai);
      doneAcc.add(r.ai);
      if (a.NORMAL != null && !doneAcc.has(`n${a.NORMAL}`)) {
        doneAcc.add(`n${a.NORMAL}`);
        const nr = readAccessor(json, bin, a.NORMAL);
        const nn = new Float32Array(nr.length);
        for (let i = 0; i < count; i++) {
          const q = lb(nrmT, i, [nr[i * 3], nr[i * 3 + 1], nr[i * 3 + 2]]);
          const l = Math.hypot(q[0], q[1], q[2]) || 1;
          nn[i * 3] = q[0] / l; nn[i * 3 + 1] = q[1] / l; nn[i * 3 + 2] = q[2] / l;
        }
        r = writeFloats(json, bin, a.NORMAL, nn, append);
        bin = r.bin;
        doneAcc.add(`n${r.ai}`);
        repoint('NORMAL', a.NORMAL, r.ai);
      }
    }
    // morph target deltas follow the local size change
    for (const t of prim.targets || []) {
      for (const attr of ['POSITION', 'NORMAL']) {
        const ti = t[attr];
        if (ti == null || doneT.has(ti)) continue;
        doneT.add(ti);
        const d = readAccessor(json, bin, ti);
        const nd = new Float32Array(d.length);
        for (let i = 0; i < count; i++) {
          const dv = [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]];
          if (!dv[0] && !dv[1] && !dv[2]) continue;
          const q = lb(attr === 'POSITION' ? lin : nrmT, i, dv);
          nd[i * 3] = q[0]; nd[i * 3 + 1] = q[1]; nd[i * 3 + 2] = q[2];
        }
        r = writeFloats(json, bin, ti, nd, append);
        bin = r.bin;
        doneT.add(r.ai);
        if (attr === 'POSITION') setMinMax(json, r.ai, nd);
        if (r.ai !== ti) for (const { prim: p2 } of skinnedPrims(json)) for (const t2 of p2.targets || []) if (t2[attr] === ti) t2[attr] = r.ai;
      }
    }
  }

  // bones: keep each node's world rotation, take its shaped world position, scale 1
  const rot3 = (m) => { // the rotation part of a (scaled) matrix
    const cols = [0, 4, 8].map((c) => { const l = Math.hypot(m[c], m[c + 1], m[c + 2]) || 1; return [m[c] / l, m[c + 1] / l, m[c + 2] / l]; });
    return cols;
  };
  const restRot = rig.rest.map(rot3);
  const N = world.map((m, i) => {
    const c = restRot[i];
    return [...c[0], 0, ...c[1], 0, ...c[2], 0, m[12], m[13], m[14], 1];
  });
  // how much bigger each node's own frame became (for colliders, look-at)
  const size = world.map((m, i) => [0, 4, 8].map((c) => Math.hypot(m[c], m[c + 1], m[c + 2]) / (Math.hypot(rig.rest[i][c], rig.rest[i][c + 1], rig.rest[i][c + 2]) || 1)));
  json.nodes.forEach((node, i) => {
    if (node.matrix) return;
    const par = rig.parent[i];
    const local = par >= 0 ? mul(invert(N[par]), N[i]) : N[i];
    node.translation = [local[12], local[13], local[14]];
    if (node.scale) node.scale = [1, 1, 1];
  });
  // inverse bind matrices
  const doneSkin = new Set();
  json.skins?.forEach((skin, si) => {
    if (skin.inverseBindMatrices == null || doneSkin.has(skin.inverseBindMatrices)) return;
    doneSkin.add(skin.inverseBindMatrices);
    const arr = new Float32Array(skin.joints.length * 16);
    skin.joints.forEach((node, j) => arr.set(invert(N[node]), j * 16));
    const r = writeFloats(json, bin, skin.inverseBindMatrices, arr, append);
    bin = r.bin;
    if (r.ai !== skin.inverseBindMatrices) json.skins.forEach((s2) => { if (s2.inverseBindMatrices === skin.inverseBindMatrices) s2.inverseBindMatrices = r.ai; });
  });
  // spring colliders and joints, look-at offset: in their node's frame, which no longer scales
  const sb = json.extensions?.VRMC_springBone;
  for (const c of sb?.colliders || []) {
    const k = size[c.node] || [1, 1, 1];
    const mean = (k[0] + k[1] + k[2]) / 3;
    for (const shp of Object.values(c.shape || {})) {
      if (shp.offset) shp.offset = shp.offset.map((x, a) => x * k[a]);
      if (shp.tail) shp.tail = shp.tail.map((x, a) => x * k[a]);
      if (shp.radius != null) shp.radius *= mean;
    }
  }
  for (const s of sb?.springs || []) for (const j of s.joints || []) {
    if (j.hitRadius == null) continue;
    const k = size[j.node] || [1, 1, 1];
    j.hitRadius *= (k[0] + k[1] + k[2]) / 3;
  }
  const la = json.extensions?.VRMC_vrm?.lookAt;
  if (la?.offsetFromHeadBone && rig.bones.head != null) la.offsetFromHeadBone = la.offsetFromHeadBone.map((x, a) => x * size[rig.bones.head][a]);
  return bin;
}
