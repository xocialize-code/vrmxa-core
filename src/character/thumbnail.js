// A character's thumbnail drawn from its avatar.vrm in plain JavaScript, with no GPU: the same picture in Node (the
// library, the CLI) and in a browser (release plan, blocker 6). Used when a shared copy takes worn pieces off, so the
// copy's thumbnail.png shows the copy and not what was left out (VRMXA §3.3, PRD CHR-10, EXP-2).
//
// It frames the model as the app's stage frames its thumbnails (app/src/stage/framing.js, "bust": the head bone, 0.62 m
// of the model filling 92% of the picture's height, an 18° camera, from the front) on a transparent background, and
// draws each mesh at rest with its morph weights and skin applied: the base colour and its texture, the alpha mode, and
// MToon's lit and shade colours with a key light from the camera's upper right. No outlines, rim light or emission:
// close to the stage's picture, not the same pixels. 2×2 samples a pixel.

import { parseGlb, readAccessor } from '../glb.js';
import { multiply, parents, worldMatrix } from '../math.js';
import { decodePng, encodePng, isPng } from '../edit/png.js';

/** The stage's "bust" framing (app/src/stage/framing.js FRAMINGS.bust, STAGE_FOV). */
export const BUST = Object.freeze({ worldHeight: 0.62, offset: -0.03, height: 0.92, bottom: 0, fov: 18 });

const NORM = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function accessor(json, bin, ai) {
  const out = readAccessor(json, bin, ai);
  const a = json.accessors[ai];
  if (!a.normalized || !NORM[a.componentType]) return out;
  const f = new Float32Array(out.length), d = NORM[a.componentType];
  for (let i = 0; i < out.length; i++) f[i] = Math.max(out[i] / d, -1);
  return f;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The head bone's node and which way the model faces, for VRM 1.0 (+Z) and 0.x (−Z). */
function headOf(json) {
  const v1 = json.extensions?.VRMC_vrm?.humanoid?.humanBones?.head?.node;
  if (Number.isInteger(v1)) return { node: v1, facing: [0, 0, 1] };
  const v0 = (json.extensions?.VRM?.humanoid?.humanBones || []).find((b) => b.bone === 'head')?.node;
  if (Number.isInteger(v0)) return { node: v0, facing: [0, 0, -1] };
  return null;
}

/** The camera for the bust framing: { position, forward, right, up, tanHalf }. */
export function bustCamera(head, facing = [0, 0, 1], f = BUST) {
  const visible = f.worldHeight / f.height;
  const centre = f.bottom + f.height / 2;
  const targetY = head[1] + f.offset - (centre - 0.5) * visible;
  const tanHalf = Math.tan((f.fov * Math.PI) / 360);
  const distance = visible / 2 / tanHalf;
  const target = [head[0], targetY, head[2]];
  const position = [target[0] + facing[0] * distance, target[1] + facing[1] * distance, target[2] + facing[2] * distance];
  const forward = norm(sub(target, position));
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { position, forward, right, up, tanHalf, distance };
}

/** Every mesh node in the default scene, with its world matrix. */
function meshNodes(json) {
  const nodes = json.nodes || [];
  const parentOf = parents(nodes);
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !parentOf.has(i));
  const out = [], seen = new Set();
  const walk = (i) => {
    if (seen.has(i) || !nodes[i]) return;
    seen.add(i);
    if (Number.isInteger(nodes[i].mesh)) out.push(i);
    for (const c of nodes[i].children || []) walk(c);
  };
  roots.forEach(walk);
  const world = new Map();
  const W = (i) => { if (!world.has(i)) world.set(i, worldMatrix(nodes, i, parentOf)); return world.get(i); };
  return { list: out, W };
}

const xform = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const xdir = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];

/** A primitive's vertices in world space at rest: { pos: Float32Array, nrm: Float32Array|null, uv, idx }. */
function worldPrimitive(json, bin, node, nodeIndex, prim, W) {
  const A = prim.attributes || {};
  if (!Number.isInteger(A.POSITION)) return null;
  const pos = Float32Array.from(accessor(json, bin, A.POSITION));
  const nrm = Number.isInteger(A.NORMAL) ? Float32Array.from(accessor(json, bin, A.NORMAL)) : null;
  const n = pos.length / 3;
  // morph targets at the node's (or mesh's) default weights
  const weights = node.weights || json.meshes[node.mesh].weights || [];
  (prim.targets || []).forEach((t, k) => {
    const w = weights[k] || 0;
    if (!w) return;
    if (Number.isInteger(t.POSITION)) { const d = accessor(json, bin, t.POSITION); for (let i = 0; i < pos.length; i++) pos[i] += w * d[i]; }
    if (nrm && Number.isInteger(t.NORMAL)) { const d = accessor(json, bin, t.NORMAL); for (let i = 0; i < nrm.length; i++) nrm[i] += w * d[i]; }
  });
  const outP = new Float32Array(n * 3), outN = nrm ? new Float32Array(n * 3) : null;
  const skin = Number.isInteger(node.skin) ? json.skins?.[node.skin] : null;
  if (skin && Number.isInteger(A.JOINTS_0) && Number.isInteger(A.WEIGHTS_0)) {
    const ibm = Number.isInteger(skin.inverseBindMatrices) ? accessor(json, bin, skin.inverseBindMatrices) : null;
    const mats = skin.joints.map((j, k) => multiply(W(j), ibm ? Array.from(ibm.subarray(k * 16, k * 16 + 16)) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    const J = accessor(json, bin, A.JOINTS_0), Wt = accessor(json, bin, A.WEIGHTS_0);
    for (let i = 0; i < n; i++) {
      let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0, sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = Wt[i * 4 + k];
        if (!w) continue;
        const m = mats[J[i * 4 + k]];
        if (!m) continue;
        const p = xform(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        px += w * p[0]; py += w * p[1]; pz += w * p[2]; sum += w;
        if (nrm) { const d = xdir(m, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]); nx += w * d[0]; ny += w * d[1]; nz += w * d[2]; }
      }
      if (sum > 0) { outP[i * 3] = px / sum; outP[i * 3 + 1] = py / sum; outP[i * 3 + 2] = pz / sum; }
      else { const p = xform(W(nodeIndex), pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); outP.set(p, i * 3); }
      if (outN) { const d = norm([nx, ny, nz]); outN.set(d, i * 3); }
    }
  } else {
    const m = W(nodeIndex);
    for (let i = 0; i < n; i++) {
      outP.set(xform(m, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]), i * 3);
      if (outN) outN.set(norm(xdir(m, nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2])), i * 3);
    }
  }
  const uv = Number.isInteger(A.TEXCOORD_0) ? accessor(json, bin, A.TEXCOORD_0) : null;
  let idx;
  if (Number.isInteger(prim.indices)) idx = accessor(json, bin, prim.indices);
  else { idx = new Uint32Array(n); for (let i = 0; i < n; i++) idx[i] = i; }
  return { pos: outP, nrm: outN, uv, idx };
}

/** A material's look: base colour and texture, alpha mode, MToon's shade colour and shading. */
function lookOf(json, bin, mi, images) {
  const m = json.materials?.[mi] || {};
  const pbr = m.pbrMetallicRoughness || {};
  const mt = m.extensions?.VRMC_materials_mtoon || null;
  const tex = (info) => {
    const src = Number.isInteger(info?.index) ? json.textures?.[info.index]?.source : undefined;
    if (!Number.isInteger(src)) return null;
    if (!images.has(src)) {
      // decoded on first use, so a texture only off-screen meshes use is never read; PNG only (a JPEG draws untextured)
      images.set(src, () => {
        const img = json.images?.[src];
        if (!img || !Number.isInteger(img.bufferView)) return null;
        const bv = json.bufferViews[img.bufferView];
        const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
        if (!isPng(bytes)) return null;
        try { return decodePng(bytes); } catch { return null; }
      });
    }
    return src;
  };
  return {
    base: pbr.baseColorFactor || [1, 1, 1, 1],
    baseTex: tex(pbr.baseColorTexture),
    shade: mt?.shadeColorFactor || null,
    shadeTex: mt ? tex(mt.shadeMultiplyTexture) : null,
    shift: mt?.shadingShiftFactor ?? 0,
    toony: mt?.shadingToonyFactor ?? 0.9,
    unlit: !!m.extensions?.KHR_materials_unlit,
    mode: m.alphaMode || 'OPAQUE',
    cutoff: m.alphaCutoff ?? 0.5,
    doubleSided: !!m.doubleSided,
    queue: mt?.renderQueueOffsetNumber ?? 0,
    zWrite: m.alphaMode !== 'BLEND' || !!mt?.transparentWithZWrite,
  };
}

function sampler(images) {
  const decoded = new Map();
  return (src, u, v) => {
    if (src === null || src === undefined) return null;
    if (!decoded.has(src)) decoded.set(src, images.get(src)?.() ?? null);
    const img = decoded.get(src);
    if (!img) return null;
    const { width: w, height: h, data } = img;
    // repeat wrapping, bilinear
    let x = (u - Math.floor(u)) * w - 0.5, y = (v - Math.floor(v)) * h - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (xx, yy) => (((yy % h) + h) % h * w + (((xx % w) + w) % w)) * 4;
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    const out = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) out[k] = ((data[a + k] * (1 - fx) + data[b + k] * fx) * (1 - fy) + (data[c + k] * (1 - fx) + data[d + k] * fx) * fy) / 255;
    return out;
  };
}

/**
 * Draws the thumbnail of a VRM (avatar.vrm): PNG bytes, size × size, or null when the model has no head bone (nothing
 * to frame the bust on) or nothing is in view. opts: { size = 512 }.
 */
export function drawThumbnail(vrmBytes, { size = 512 } = {}) {
  const { json, bin } = parseGlb(vrmBytes);
  const head = headOf(json);
  if (!head) return null;
  const { list, W } = meshNodes(json);
  const hm = W(head.node);
  const cam = bustCamera([hm[12], hm[13], hm[14]], head.facing);
  const SS = 2, S = size * SS;
  const color = new Float32Array(S * S * 4);   // premultiplied
  const depth = new Float32Array(S * S).fill(Infinity);
  const light = norm([cam.right[0] * 0.45 + cam.up[0] * 0.55 - cam.forward[0], cam.right[1] * 0.45 + cam.up[1] * 0.55 - cam.forward[1], cam.right[2] * 0.45 + cam.up[2] * 0.55 - cam.forward[2]]);
  const images = new Map();
  const sample = sampler(images);
  const near = cam.distance / 200;

  // every primitive, then the opaque and alpha-tested ones before the blended ones (by MToon's render queue offset)
  const draws = [];
  let order = 0;
  for (const ni of list) {
    const node = json.nodes[ni];
    for (const prim of json.meshes[node.mesh]?.primitives || []) {
      if ((prim.mode ?? 4) !== 4) continue;
      draws.push({ ni, node, prim, look: lookOf(json, bin, prim.material, images), order: order++ });
    }
  }
  draws.sort((a, b) => (a.look.mode === 'BLEND') - (b.look.mode === 'BLEND') || (a.look.mode === 'BLEND' ? a.look.queue - b.look.queue : 0) || a.order - b.order);

  let drawn = 0;
  for (const d of draws) {
    const g = worldPrimitive(json, bin, d.node, d.ni, d.prim, W);
    if (!g) continue;
    const L = d.look, n = g.pos.length / 3;
    // project every vertex: screen x, y (pixels) and depth along the view
    const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = [g.pos[i * 3] - cam.position[0], g.pos[i * 3 + 1] - cam.position[1], g.pos[i * 3 + 2] - cam.position[2]];
      const z = dot(r, cam.forward);
      sz[i] = z;
      sx[i] = (dot(r, cam.right) / (z * cam.tanHalf) * 0.5 + 0.5) * S;
      sy[i] = (0.5 - dot(r, cam.up) / (z * cam.tanHalf) * 0.5) * S;
    }
    const blend = L.mode === 'BLEND', bias = L.mode === 'OPAQUE' ? 0 : 0.0005;
    for (let t = 0; t + 2 < g.idx.length; t += 3) {
      const i0 = g.idx[t], i1 = g.idx[t + 1], i2 = g.idx[t + 2];
      if (sz[i0] < near || sz[i1] < near || sz[i2] < near) continue;
      const x0 = sx[i0], y0 = sy[i0], x1 = sx[i1], y1 = sy[i1], x2 = sx[i2], y2 = sy[i2];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (!area) continue;
      // counter-clockwise in the model is clockwise on a y-down screen: area < 0 faces the camera
      const back = area > 0;
      if (back && !L.doubleSided) continue;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(S - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(S - 1, Math.ceil(Math.max(y0, y1, y2)));
      if (minX > maxX || minY > maxY) continue;
      const iz0 = 1 / sz[i0], iz1 = 1 / sz[i1], iz2 = 1 / sz[i2];
      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          let b0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          let b1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const b2 = 1 - b0 - b1;
          if (b0 < 0 || b1 < 0 || b2 < 0) continue;
          const izz = b0 * iz0 + b1 * iz1 + b2 * iz2, z = 1 / izz;
          const pi = py * S + px;
          if (z >= depth[pi] + bias) continue;
          // perspective-correct weights
          const w0 = b0 * iz0 * z, w1 = b1 * iz1 * z, w2 = b2 * iz2 * z;
          let u = 0, v = 0;
          if (g.uv) { u = w0 * g.uv[i0 * 2] + w1 * g.uv[i1 * 2] + w2 * g.uv[i2 * 2]; v = w0 * g.uv[i0 * 2 + 1] + w1 * g.uv[i1 * 2 + 1] + w2 * g.uv[i2 * 2 + 1]; }
          const tx = L.baseTex !== null ? sample(L.baseTex, u, v) : null;
          let a = L.base[3] * (tx ? tx[3] : 1);
          if (L.mode === 'MASK') { if (a < L.cutoff) continue; a = 1; } else if (!blend) a = 1;
          if (a <= 0.002) continue;
          let r = L.base[0] * (tx ? tx[0] : 1), gg = L.base[1] * (tx ? tx[1] : 1), bb = L.base[2] * (tx ? tx[2] : 1);
          if (!L.unlit && g.nrm) {
            let nn = norm([w0 * g.nrm[i0 * 3] + w1 * g.nrm[i1 * 3] + w2 * g.nrm[i2 * 3], w0 * g.nrm[i0 * 3 + 1] + w1 * g.nrm[i1 * 3 + 1] + w2 * g.nrm[i2 * 3 + 1], w0 * g.nrm[i0 * 3 + 2] + w1 * g.nrm[i1 * 3 + 2] + w2 * g.nrm[i2 * 3 + 2]]);
            if (back) nn = [-nn[0], -nn[1], -nn[2]];
            const ndl = dot(nn, light);
            if (L.shade) {
              // MToon: the lit colour where the light falls, the shade colour (× its texture) beyond the toon edge
              const s = clamp01((ndl + L.shift - (-1 + L.toony)) / Math.max((1 - L.toony) - (-1 + L.toony), 1e-4));
              const st = L.shadeTex !== null ? sample(L.shadeTex, u, v) : tx;
              const sr = L.shade[0] * (st ? st[0] : 1), sg = L.shade[1] * (st ? st[1] : 1), sb = L.shade[2] * (st ? st[2] : 1);
              r = sr + (r - sr) * s; gg = sg + (gg - sg) * s; bb = sb + (bb - sb) * s;
            } else {
              const k = 0.62 + 0.38 * clamp01(ndl);
              r *= k; gg *= k; bb *= k;
            }
          }
          const o = pi * 4;
          if (blend) {
            const keep = 1 - a;
            color[o] = r * a + color[o] * keep; color[o + 1] = gg * a + color[o + 1] * keep; color[o + 2] = bb * a + color[o + 2] * keep; color[o + 3] = a + color[o + 3] * keep;
          } else { color[o] = r; color[o + 1] = gg; color[o + 2] = bb; color[o + 3] = 1; }
          if (L.zWrite) depth[pi] = z;
          drawn++;
        }
      }
    }
  }
  if (!drawn) return null;
  // 2×2 samples to a pixel, back from premultiplied
  const out = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const o = ((y * SS + j) * S + x * SS + i) * 4; r += color[o]; g += color[o + 1]; b += color[o + 2]; a += color[o + 3]; }
    const o = (y * size + x) * 4;
    if (a > 0) { out[o] = Math.round((r / a) * 255); out[o + 1] = Math.round((g / a) * 255); out[o + 2] = Math.round((b / a) * 255); out[o + 3] = Math.round((a / (SS * SS)) * 255); }
  }
  return encodePng({ width: size, height: size, data: out });
}
