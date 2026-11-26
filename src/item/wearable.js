// A plain model made wearable in four steps: Type, Place, Bind, Movement (PRD ITM-3; VRMXW §14, last row).
//
// The types and their places (WEAR_TYPES), the landmarks Place fits to (`landmarks`, `autoPlace`), and
//   Bind's rule (`bindToBody`): every vertex takes
//   the blended bone weights of the nearest points of the body, inverse to their distance, and for skirts,
//   dresses and coats the lower legs fold into the upper legs and part of the leg weight goes to the hips, so
//   the cloth doesn't tear between the legs.
// It works on glTF data; the body is always Spec's (the item is fitted
//   to Spec); "how closely it follows" sets how many neighbours share the weight and how fast their pull
//   falls off; "clean up stray pulls" drops weights of the far side's arm and leg; the result is cut by the one
//   item writer (extractItemModel), so the model is laid out as every other item. The Movement step adds no new
//   spring chains: a model that has springs keeps them, with their settings editable.

import { parseGlb, readAccessor, bufferViewBytes } from '../glb.js';
import { concat, clone } from '../bytes.js';
import { invert, parents, worldMatrix, transformPoint, IDENTITY } from '../math.js';
import { extractItemModel } from '../item-writer.js';
import { ITEM_TYPES } from '../vocab.js';
import { placeMatrix, cleanPlace, specRig, WIDE } from '../import/onSpec.js';

/** The four steps, in order. */
export const WEAR_STEPS = Object.freeze(['type', 'place', 'bind', 'movement']);

// where each type sits on the body (WEAR_TYPES, `place`)
const PLACES = {
  dress: { top: 'shoulder', bottom: 'knee' }, top: { top: 'shoulder', bottom: 'hips' }, coat: { top: 'shoulder', bottom: 'knee' },
  skirt: { top: 'waist', bottom: 'knee' }, pants: { top: 'waist', bottom: 'ground' }, socks: { top: 'knee', bottom: 'ground' },
  shoes: { top: 'ankle', bottom: 'ground', width: 'feet' }, hat: { at: 'headTop', ref: 'bottom', width: 'head', widthMul: 1.25, sink: 0.05 },
  glasses: { at: 'eyes', ref: 'center', width: 'head', widthMul: 1.05 }, necklace: { at: 'neck', ref: 'center', width: 'neck', widthMul: 1.6 },
  belt: { at: 'waist', ref: 'center', width: 'waist', widthMul: 1.08 }, handR: { at: 'rightHand', ref: 'center' }, handL: { at: 'leftHand', ref: 'center' },
  back: { at: 'back', ref: 'front' }, tail: { at: 'tailBase', ref: 'front' },
};
const SKIRT_LIKE = new Set(['dress', 'coat', 'skirt']);

// ---- reading a plain model ------------------------------------------------------------------------------

/** A plain model's triangles in its own space (each node's transform applied). → [{ mesh, prim, pos, nor, uv, idx, material }] */
function plainPrims(json, bin) {
  const pOf = parents(json.nodes || []);
  const out = [];
  (json.nodes || []).forEach((n, ni) => {
    if (n.mesh === undefined) return;
    const w = worldMatrix(json.nodes, ni, pOf);
    json.meshes[n.mesh].primitives.forEach((p, pi) => {
      if ((p.mode ?? 4) !== 4) return;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const P = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i += 3) P.set(transformPoint(w, [pos[i], pos[i + 1], pos[i + 2]]), i);
      let N = null;
      if (p.attributes.NORMAL !== undefined) {
        const nor = readAccessor(json, bin, p.attributes.NORMAL);
        const r = invert(w) || IDENTITY; // normals by the inverse transpose
        N = new Float32Array(nor.length);
        for (let i = 0; i < nor.length; i += 3) {
          const v = [nor[i], nor[i + 1], nor[i + 2]];
          const x = r[0] * v[0] + r[1] * v[1] + r[2] * v[2], y = r[4] * v[0] + r[5] * v[1] + r[6] * v[2], z = r[8] * v[0] + r[9] * v[1] + r[10] * v[2];
          const l = Math.hypot(x, y, z) || 1;
          N.set([x / l, y / l, z / l], i);
        }
      }
      const uv = p.attributes.TEXCOORD_0 !== undefined ? Float32Array.from(readAccessor(json, bin, p.attributes.TEXCOORD_0)) : null;
      const idx = p.indices !== undefined ? Uint32Array.from(readAccessor(json, bin, p.indices)) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      out.push({ mesh: n.mesh, prim: pi, pos: P, nor: N, uv, idx, material: p.material });
    });
  });
  return out;
}

const boxOf = (prims) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of prims) for (let i = 0; i < p.pos.length; i += 3) for (let a = 0; a < 3; a++) { const v = p.pos[i + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v; }
  return { min: mn, max: mx, size: mx.map((v, a) => v - mn[a]), centre: mx.map((v, a) => (v + mn[a]) / 2) };
};

/** What a plain model holds: meshes, triangles, its box, whether it is skinned or a VRM already. */
export function plainModelInfo(glb) {
  const { json, bin } = parseGlb(glb);
  const prims = plainPrims(json, bin);
  return {
    meshes: (json.meshes || []).length, prims: prims.length, triangles: prims.reduce((n, p) => n + p.idx.length / 3, 0),
    box: prims.length ? boxOf(prims) : null, skinned: (json.nodes || []).some((n) => n.skin !== undefined),
    vrm: !!(json.extensions?.VRMC_vrm || json.extensions?.VRM), springs: json.extensions?.VRMC_springBone?.springs?.length || 0,
  };
}

// ---- Spec's body: landmarks and weight samples ----------------------------------------------------------

function bodyOf(spec) {
  if (spec._body) return spec._body;
  const { json, bin, human } = spec;
  const pOf = parents(json.nodes);
  const humanoid = new Set(human.boneOfNode.keys());
  const toHuman = (n) => { for (let c = n, k = 0; c !== undefined && k < 512; c = pOf.get(c), k++) if (humanoid.has(c)) return human.boneOfNode.get(c); return null; };
  const pts = [], wts = [];
  const faceBox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  (json.nodes || []).forEach((n) => {
    if (n.mesh === undefined || n.skin === undefined) return;
    const joints = json.skins[n.skin].joints;
    const isFace = /face/i.test(n.name || json.meshes[n.mesh].name || '');
    for (const p of json.meshes[n.mesh].primitives) {
      const mat = json.materials?.[p.material]?.name || '';
      if (!/SKIN/i.test(mat) && !isFace) continue;
      const pos = readAccessor(json, bin, p.attributes.POSITION);
      const J = readAccessor(json, bin, p.attributes.JOINTS_0), W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
      const used = p.indices !== undefined ? new Set(readAccessor(json, bin, p.indices)) : null;
      for (let v = 0; v < pos.length / 3; v++) {
        if (used && !used.has(v)) continue;
        if (isFace) { for (let a = 0; a < 3; a++) { faceBox.min[a] = Math.min(faceBox.min[a], pos[v * 3 + a]); faceBox.max[a] = Math.max(faceBox.max[a], pos[v * 3 + a]); } continue; }
        const w = new Map();
        for (let k = 0; k < 4; k++) { const x = W[v * 4 + k]; if (x > 0.001) { const b = toHuman(joints[J[v * 4 + k]]); if (b) w.set(b, (w.get(b) || 0) + x); } }
        pts.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        wts.push([...w]);
      }
    }
  });
  spec._body = { pts: Float32Array.from(pts), wts, faceBox };
  return spec._body;
}

function slice(body, y, band = 0.025) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < body.pts.length; i += 3) {
    if (Math.abs(body.pts[i + 1] - y) > band) continue;
    for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], body.pts[i + a]); mx[a] = Math.max(mx[a], body.pts[i + a]); }
  }
  return Number.isFinite(mn[0]) ? { min: mn, max: mx, centre: mx.map((v, a) => (v + mn[a]) / 2) } : null;
}

/** The points on Spec that Place fits to (`landmarks`). */
export function specLandmarks(spec) {
  const s = spec.bind ? spec : specRig(spec);
  const b = bodyOf(s);
  const at = (bone) => s.at(bone);
  const avg = (x, y) => (x && y ? x.map((v, i) => (v + y[i]) / 2) : x || y);
  const shoulder = avg(at('leftUpperArm'), at('rightUpperArm')), knee = avg(at('leftLowerLeg'), at('rightLowerLeg')), feet = avg(at('leftFoot'), at('rightFoot'));
  const hips = at('hips'), spine = at('spine'), neck = at('neck');
  const fb = b.faceBox;
  return {
    centre: [hips[0], 0, hips[2]], shoulder: shoulder[1] + 0.02, hips: hips[1] - 0.03, waist: spine ? spine[1] : hips[1] + 0.08, knee: knee[1],
    ankle: feet[1] + 0.02, ground: 0, feetMid: feet, feetWidth: Math.hypot(...at('leftFoot').map((v, i) => v - at('rightFoot')[i])) + 0.12,
    neck: neck ? [neck[0], neck[1] - 0.04, neck[2] + 0.02] : null, headTop: Number.isFinite(fb.max[1]) ? fb.max[1] : at('head')[1] + 0.2,
    headWidth: Number.isFinite(fb.max[0]) ? fb.max[0] - fb.min[0] : 0.18, headCentre: Number.isFinite(fb.max[0]) ? fb.max.map((v, i) => (v + fb.min[i]) / 2) : at('head'),
    eyes: avg(at('leftEye'), at('rightEye')), faceFront: Number.isFinite(fb.max[2]) ? fb.max[2] : null,
    rightHand: at('rightHand'), leftHand: at('leftHand'), upperChest: at('upperChest') || at('chest'), hipsPos: hips, body: b,
  };
}

/**
 * Step 2, Place: where a plain model of this type goes on Spec, as the importer's place block about the
 * model's own centre ({ move, turn, size }). null when the type has no automatic place (earrings, charms,
 * hair, gloves): those are placed by hand.
 */
export function autoPlace(glb, type, spec) {
  const p = PLACES[type];
  if (!p) return null;
  const { json, bin } = parseGlb(glb);
  const box = boxOf(plainPrims(json, bin));
  const L = specLandmarks(spec);
  const c = box.centre;
  let s = 1, ref, target;
  if (p.top) {
    const top = L[p.top], bottom = L[p.bottom];
    s = (top - bottom) / Math.max(box.size[1], 1e-6);
    if (p.width === 'feet') s = Math.min(s * 3, L.feetWidth / Math.max(box.size[0], 1e-6));
    ref = [c[0], box.max[1], c[2]];
    const sl = slice(L.body, (top + bottom) / 2);
    target = [L.centre[0], p.width === 'feet' ? bottom + box.size[1] * s : top, p.width === 'feet' ? L.feetMid[2] + 0.03 : sl ? sl.centre[2] : L.centre[2]];
    if (p.width === 'feet') target[0] = L.feetMid[0];
  } else {
    if (p.width === 'head') s = (L.headWidth * p.widthMul) / Math.max(box.size[0], 1e-6);
    else if (p.width === 'neck') { const sl = L.neck && slice(L.body, L.neck[1]); s = ((sl ? sl.max[0] - sl.min[0] : 0.11) * p.widthMul) / Math.max(box.size[0], 1e-6); }
    else if (p.width === 'waist') { const sl = slice(L.body, L.waist); s = ((sl ? sl.max[0] - sl.min[0] : 0.28) * p.widthMul) / Math.max(box.size[0], 1e-6); }
    ref = p.ref === 'bottom' ? [c[0], box.min[1], c[2]] : p.ref === 'front' ? [c[0], c[1], box.max[2]] : c.slice();
    if (p.at === 'headTop') target = [L.headCentre[0], L.headTop - (p.sink || 0), L.headCentre[2]];
    else if (p.at === 'eyes') { const e = L.eyes || L.headCentre; target = [e[0], e[1], (L.faceFront ?? e[2] + 0.08) + box.size[2] * s * 0.5]; }
    else if (p.at === 'neck') target = L.neck;
    else if (p.at === 'waist') { const sl = slice(L.body, L.waist); target = [L.centre[0], L.waist, sl ? sl.centre[2] : L.centre[2]]; }
    else if (p.at === 'rightHand' || p.at === 'leftHand') target = L[p.at];
    else if (p.at === 'back') { const sl = L.upperChest && slice(L.body, L.upperChest[1]); target = [L.centre[0], L.upperChest?.[1] ?? L.shoulder, sl ? sl.min[2] : 0]; }
    else if (p.at === 'tailBase') { const sl = slice(L.body, L.hipsPos[1]); target = [L.centre[0], L.hipsPos[1], sl ? sl.min[2] : 0]; }
  }
  if (!target) return null;
  if (!Number.isFinite(s) || s <= 0) s = 1;
  // T(target)·S·T(−ref) written as the place about the centre: move = target − c − s·(ref − c)
  const move = target.map((t, a) => t - c[a] - s * (ref[a] - c[a]));
  return cleanPlace({ move, turn: [0, 0, 0], size: s }, WIDE);
}

// ---- step 3, Bind ---------------------------------------------------------------------------------------

function grid(pts, cell) {
  const g = new Map();
  for (let i = 0; i < pts.length / 3; i++) {
    const key = `${Math.floor(pts[i * 3] / cell)},${Math.floor(pts[i * 3 + 1] / cell)},${Math.floor(pts[i * 3 + 2] / cell)}`;
    let a = g.get(key);
    if (!a) g.set(key, (a = []));
    a.push(i);
  }
  return g;
}

function nearestK(g, pts, cell, p, k) {
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
  let best = [];
  for (let r = 0; r <= 16; r++) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
      const a = g.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!a) continue;
      for (const j of a) { const ex = p[0] - pts[j * 3], ey = p[1] - pts[j * 3 + 1], ez = p[2] - pts[j * 3 + 2]; best.push([j, ex * ex + ey * ey + ez * ez]); }
    }
    if (best.length >= k) {
      best.sort((a, b) => a[1] - b[1]);
      best = best.slice(0, k);
      if (Math.sqrt(best[k - 1][1]) <= r * cell) break;
    }
  }
  return best.slice(0, k);
}

const LOWER = { leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg', leftFoot: 'leftUpperLeg', rightFoot: 'rightUpperLeg', leftToes: 'leftUpperLeg', rightToes: 'rightUpperLeg' };
const sideOf = (bone) => (/^left/.test(bone) ? 1 : /^right/.test(bone) ? -1 : 0); // +X is the character's left

/**
 * The weights a point takes from Spec's body (`bindToBody`).
 *   follow (0..1): how closely it follows; lower shares the weight among more of the body, so cloth hangs freer
 *   clean: drop the far side's limbs (a sleeve tugged by the other arm)
 *   skirt: fold the lower legs into the upper and `legBlend` of the legs into the hips
 */
function weightsAt(body, g, cell, p, { follow, clean, skirt, legBlend }) {
  const k = Math.round(4 + (1 - follow) * 20);
  const power = 1 + follow * 2;
  const acc = new Map();
  for (const [j, d2] of nearestK(g, body.pts, cell, p, k)) {
    const w0 = 1 / (Math.pow(d2, power / 2) + 1e-9);
    for (const [b, w] of body.wts[j]) acc.set(b, (acc.get(b) || 0) + w * w0);
  }
  if (skirt) {
    for (const [b, w] of [...acc]) if (LOWER[b]) { acc.delete(b); acc.set(LOWER[b], (acc.get(LOWER[b]) || 0) + w); }
    for (const [b, w] of [...acc]) if (b === 'leftUpperLeg' || b === 'rightUpperLeg') { acc.set(b, w * (1 - legBlend)); acc.set('hips', (acc.get('hips') || 0) + w * legBlend); }
  }
  if (clean && Math.abs(p[0]) > 0.02) {
    const side = Math.sign(p[0]);
    for (const b of [...acc.keys()]) if (sideOf(b) === -side) acc.delete(b);
  }
  const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((s, x) => s + x[1], 0) || 1;
  return top.length ? top.map(([b, w]) => [b, w / sum]) : [['hips', 1]];
}

const align4 = (n) => (n + 3) & ~3;

/**
 * Steps 2 and 3 together: a plain model placed on Spec and bound, as an item's model cut by the one item writer.
 *   opts: { type, kind ('worn' | 'pin'), attach (pin), place, follow (0.7), clean (true), legBlend (0.6), name }
 * → { glb, rig, bones: [{ bone, share }] (worn: how much of the weight each bone takes), place, springs }
 */
export function bindToSpec(glb, spec, opts = {}) {
  const s = spec.bind ? spec : specRig(spec);
  const type = opts.type || 'charm';
  const kind = opts.kind || ITEM_TYPES[type]?.kind || 'worn';
  const place = cleanPlace(opts.place, WIDE);
  const plain = parseGlb(glb);
  const prims = plainPrims(plain.json, plain.bin);
  if (!prims.length) throw new Error('the model has no triangles to wear');
  const box = boxOf(prims);
  const P = placeMatrix(place, box.centre, WIDE);
  for (const p of prims) {
    for (let i = 0; i < p.pos.length; i += 3) p.pos.set(transformPoint(P, [p.pos[i], p.pos[i + 1], p.pos[i + 2]]), i);
    if (p.nor) for (let i = 0; i < p.nor.length; i += 3) {
      const v = [P[0] * p.nor[i] + P[4] * p.nor[i + 1] + P[8] * p.nor[i + 2], P[1] * p.nor[i] + P[5] * p.nor[i + 1] + P[9] * p.nor[i + 2], P[2] * p.nor[i] + P[6] * p.nor[i + 1] + P[10] * p.nor[i + 2]];
      const l = Math.hypot(...v) || 1;
      p.nor.set(v.map((x) => x / l), i);
    }
  }
  // Spec with the model added, so the one item writer cuts the item exactly as it cuts any other
  const json = clone(s.json);
  const parts = [];
  let off = align4(s.bin.length);
  const pad0 = off - s.bin.length;
  const view = (bytes, target) => {
    const bv = { buffer: 0, byteOffset: off, byteLength: bytes.length };
    if (target) bv.target = target;
    json.bufferViews.push(bv);
    parts.push(bytes);
    const pad = align4(bytes.length) - bytes.length;
    if (pad) parts.push(new Uint8Array(pad));
    off += align4(bytes.length);
    return json.bufferViews.length - 1;
  };
  const acc = (typed, componentType, type2, minmax = false) => {
    const nc = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type2];
    const a = { bufferView: view(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)), componentType, count: typed.length / nc, type: type2 };
    if (minmax) {
      a.min = [0, 1, 2].map((c) => { let m = Infinity; for (let i = c; i < typed.length; i += 3) m = Math.min(m, typed[i]); return Math.fround(m); });
      a.max = [0, 1, 2].map((c) => { let m = -Infinity; for (let i = c; i < typed.length; i += 3) m = Math.max(m, typed[i]); return Math.fround(m); });
    }
    json.accessors.push(a);
    return json.accessors.length - 1;
  };
  // materials, textures, images and samplers of the plain model, carried over as they are
  const base = { materials: (json.materials ||= []).length, textures: (json.textures ||= []).length, images: (json.images ||= []).length, samplers: (json.samplers ||= []).length };
  for (const im of plain.json.images || []) {
    if (im.bufferView === undefined) throw new Error('the model refers to a picture outside the file; a model must be self-contained');
    json.images.push({ ...(im.name ? { name: im.name } : {}), mimeType: im.mimeType || 'image/png', bufferView: view(bufferViewBytes(plain.json, plain.bin, im.bufferView)) });
  }
  for (const sm of plain.json.samplers || []) json.samplers.push(clone(sm));
  for (const t of plain.json.textures || []) json.textures.push({ ...(t.sampler !== undefined ? { sampler: t.sampler + base.samplers } : {}), ...(t.source !== undefined ? { source: t.source + base.images } : {}) });
  const shift = (obj) => {
    if (Array.isArray(obj)) obj.forEach(shift);
    else if (obj && typeof obj === 'object') { if (Number.isInteger(obj.index) && ('texCoord' in obj || Object.keys(obj).every((k) => ['index', 'texCoord', 'scale', 'strength', 'extensions', 'extras'].includes(k)))) obj.index += base.textures; for (const v of Object.values(obj)) shift(v); }
  };
  for (const m of plain.json.materials || []) { const c = clone(m); shift(c); json.materials.push(c); }
  if (!(plain.json.materials || []).length) json.materials.push({ name: 'Item', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.9 } });
  for (const e of plain.json.extensionsUsed || []) if (!(json.extensionsUsed ||= []).includes(e)) json.extensionsUsed.push(e);
  // the mesh: skinned to Spec's humanoid bones by the body's weights (worn), or under one bone (pin)
  const body = bodyOf(s);
  const cell = 0.04;
  const g = grid(body.pts, cell);
  const settings = { follow: Math.min(1, Math.max(0, opts.follow ?? 0.7)), clean: opts.clean !== false, skirt: SKIRT_LIKE.has(type), legBlend: opts.legBlend ?? 0.6 };
  const boneList = [], boneIx = new Map();
  const bi = (b) => { if (!boneIx.has(b)) { boneIx.set(b, boneList.length); boneList.push(b); } return boneIx.get(b); };
  const share = new Map();
  const primsOut = prims.map((p) => {
    const attributes = { POSITION: acc(p.pos, 5126, 'VEC3', true) };
    if (p.nor) attributes.NORMAL = acc(p.nor, 5126, 'VEC3');
    if (p.uv) attributes.TEXCOORD_0 = acc(p.uv, 5126, 'VEC2');
    if (kind === 'worn') {
      const n = p.pos.length / 3;
      const J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const w = weightsAt(body, g, cell, [p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]], settings);
        w.forEach(([b, x], k) => { J[i * 4 + k] = bi(b); W[i * 4 + k] = x; share.set(b, (share.get(b) || 0) + x); });
      }
      attributes.JOINTS_0 = acc(J, 5123, 'VEC4');
      attributes.WEIGHTS_0 = acc(W, 5126, 'VEC4');
    }
    const max = p.idx.reduce((m, v) => Math.max(m, v), 0);
    const out = { attributes, indices: acc(max < 65536 ? Uint16Array.from(p.idx) : p.idx, max < 65536 ? 5123 : 5125, 'SCALAR'), mode: 4 };
    out.material = p.material !== undefined ? p.material + base.materials : base.materials;
    return out;
  });
  json.meshes.push({ name: opts.name || 'Item', primitives: primsOut });
  const meshIndex = json.meshes.length - 1;
  const node = { name: opts.name || 'Item', mesh: meshIndex };
  if (kind === 'worn') {
    const ibm = new Float32Array(boneList.length * 16);
    boneList.forEach((b, k) => ibm.set(s.ibm.get(b), k * 16));
    json.skins.push({ joints: boneList.map((b) => s.human.nodeOfBone[b]), inverseBindMatrices: acc(ibm, 5126, 'MAT4') });
    node.skin = json.skins.length - 1;
    json.nodes.push(node);
    json.scenes[json.scene || 0].nodes.push(json.nodes.length - 1);
  } else {
    const bone = opts.attach || ITEM_TYPES[type]?.bone || 'hips';
    const bn = s.human.nodeOfBone[bone];
    if (bn === undefined) throw new Error(`Spec has no bone "${bone}"`);
    node.matrix = invert(worldMatrix(s.json.nodes, bn, parents(s.json.nodes)));
    json.nodes.push(node);
    (json.nodes[bn].children ||= []).push(json.nodes.length - 1);
  }
  const bin = concat([s.bin, new Uint8Array(pad0), ...parts]);
  json.buffers = [{ byteLength: bin.length }];
  const cut = extractItemModel({ json, bin }, { prims: primsOut.map((_, i) => [meshIndex, i]), kind, attach: kind === 'pin' ? (opts.attach || ITEM_TYPES[type]?.bone || 'hips') : undefined, name: (opts.name || 'Item').replace(/[^\w-]+/g, '_') });
  const total = [...share.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    glb: cut.glb, rig: cut.rig, place, springs: cut.springs,
    bones: [...share].sort((a, b) => b[1] - a[1]).map(([bone, w]) => ({ bone, share: Math.round((w / total) * 1000) / 1000 })),
  };
}

/**
 * The four steps' result as an item (ITM-3): the bound model with its type, slot and fit rule, the licence
 * block and origin. → the item ({ manifest, entries }), not yet written (saveItem writes and checks it).
 *   opts: as bindToSpec, plus { name, meta (required), origin, listing, tags, source (the file it came from) }
 */
export async function makeWearable(glb, spec, opts = {}) {
  const { createItem } = await import('../vrmxw.js');
  const b = bindToSpec(glb, spec, opts);
  const type = opts.type || 'charm';
  const t = ITEM_TYPES[type];
  return {
    item: await createItem({
      model: b.glb, name: opts.name || 'Item', type, kind: opts.kind || t?.kind, attach: (opts.kind || t?.kind) === 'pin' ? (opts.attach || t?.bone) : undefined,
      rig: b.rig, meta: opts.meta, tags: opts.tags || [], listing: opts.listing || null,
      origin: { made: 'imported', ...(opts.source ? { source: opts.source } : {}), ...(opts.origin || {}), fit: 'four-steps', place: b.place, follow: opts.follow ?? 0.7 },
    }),
    bones: b.bones, place: b.place,
  };
}

/** Spec's skeleton read once, for the four steps (the same object specRig gives). */
export function wearSpec(specBytes) { return specRig(specBytes); }
