// Garments for the Spec-fit tests, made from Spec's own skin so nothing third-party is needed: a part of
// the body skin pushed out along its normals, skinned as the skin is, with the bust bones folded into
// their humanoid ancestor as an item's writer folds them (VRMXW §5.3 rule 3). And bodies to dress: Spec
// with Body page edits (vertex for vertex Spec's), and a "foreign" body (an edited Spec with skin cut
// away and nothing shared with Spec's vertex order).

import { parseGlb } from '../src/glb.js';
import { parents } from '../src/math.js';
import { humanBones } from '../src/measure/bodyMeasure.js';
import { readSkin, measuredContext, zoneOfBone, ZONES } from '../src/fit/body.js';
import { shapedSkinning, shapeBody, specContext } from '../src/fit/worn.js';
import { vertexNormals } from '../src/fit/geom.js';

export function specParts(specBytes) {
  const parsed = parseGlb(specBytes);
  const spec = specContext(parsed);
  const hb = humanBones(parsed.json);
  const boneOfNode = new Map(Object.entries(hb).map(([b, n]) => [n, b]));
  const par = parents(parsed.json.nodes);
  const humanNode = (node) => { for (let n = node; n != null; n = par.get(n)) if (boneOfNode.has(n)) return n; return node; };
  return { parsed, spec, hb, boneOfNode, humanNode };
}

/**
 * A garment from Spec's skin. opts: { labels: [segment labels], y: [lo, hi], offset (metres along the
 * normal), flare (metres per metre below `flareFrom`, outward from the torso axis: a skirt), subdivide }
 * → { pos, zones, tris, normals, nodes, weights, n }
 */
export function garmentFromSkin(parts, { labels, y = [-1, 9], offset = 0.006, flare = 0, flareFrom = 0, x = null, targets = false } = {}) {
  const { spec, boneOfNode, humanNode } = parts;
  const body = spec.body;
  const keep = body.tris.filter((t) => t.every((i) => labels.includes(body.label[i]) && body.verts[i * 3 + 1] >= y[0] && body.verts[i * 3 + 1] <= y[1] && (!x || (body.verts[i * 3] >= x[0] && body.verts[i * 3] <= x[1]))));
  const map = new Map();
  const src = [];
  for (const t of keep) for (const i of t) if (!map.has(i)) { map.set(i, src.length); src.push(i); }
  const n = src.length;
  const pos = new Float32Array(n * 3), zones = new Float32Array(n * 6), nodes = new Int32Array(n * 4), weights = new Float32Array(n * 4);
  const N = spec.skin.normals;
  src.forEach((i, k) => {
    const v = [body.verts[i * 3], body.verts[i * 3 + 1], body.verts[i * 3 + 2]];
    const nn = [N[i * 3], N[i * 3 + 1], N[i * 3 + 2]];
    let off = offset;
    for (let a = 0; a < 3; a++) pos[k * 3 + a] = v[a] + nn[a] * off;
    if (flare && v[1] < flareFrom) {
      const d = [v[0], 0, v[2] - 0.0]; const l = Math.hypot(d[0], d[2]) || 1;
      const out = (flareFrom - v[1]) * flare;
      pos[k * 3] += (d[0] / l) * out; pos[k * 3 + 2] += (d[2] / l) * out;
    }
    for (let j = 0; j < 4; j++) {
      const node = humanNode(body.skin.node[i * 4 + j]); // the bust bones folded into the chest (W21)
      nodes[k * 4 + j] = node;
      weights[k * 4 + j] = body.skin.weight[i * 4 + j];
      const b = boneOfNode.get(node);
      if (weights[k * 4 + j] > 1e-6) zones[k * 6 + ZONES.indexOf(b ? zoneOfBone(b) : 'other')] += weights[k * 4 + j];
    }
  });
  const tris = Int32Array.from(keep.flatMap((t) => t.map((i) => map.get(i))));
  const normals = vertexNormals(pos, tris);
  const g = { pos, zones, tris, normals, nodes, weights, n };
  if (targets) {
    // a morph target: the front panel pushed 1 cm forward (a zip opened)
    const d = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) if (pos[k * 3 + 2] > 0.05 && pos[k * 3 + 1] > 1.0) d[k * 3 + 2] = 0.01;
    g.targets = [d];
  }
  return g;
}

/** Subdivide every triangle into four (shared midpoints): a denser garment for the speed check. */
export function subdivide(g) {
  const pos = Array.from(g.pos), zones = Array.from(g.zones), nodes = Array.from(g.nodes), weights = Array.from(g.weights);
  const mid = new Map();
  const tris = [];
  const m = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (mid.has(key)) return mid.get(key);
    const k = pos.length / 3;
    for (let c = 0; c < 3; c++) pos.push((pos[a * 3 + c] + pos[b * 3 + c]) / 2);
    for (let c = 0; c < 6; c++) zones.push((zones[a * 6 + c] + zones[b * 6 + c]) / 2);
    for (let c = 0; c < 4; c++) { nodes.push(nodes[a * 4 + c]); weights.push(weights[a * 4 + c]); }
    mid.set(key, k);
    return k;
  };
  for (let t = 0; t < g.tris.length; t += 3) {
    const [a, b, c] = [g.tris[t], g.tris[t + 1], g.tris[t + 2]];
    const ab = m(a, b), bc = m(b, c), ca = m(c, a);
    tris.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const P = Float32Array.from(pos), T = Int32Array.from(tris);
  return { pos: P, zones: Float32Array.from(zones), nodes: Int32Array.from(nodes), weights: Float32Array.from(weights), tris: T, normals: vertexNormals(P, T), n: P.length / 3 };
}

/** Spec with Body page edits: its context and the shaped skinning, for the bones baseline. */
export function editedBody(parts, body, bones = {}) {
  const { parsed, spec, hb } = parts;
  const sk = shapedSkinning(parsed.json, parsed.bin, { body, bones });
  sk.humanBones = hb;
  const shaped = shapeBody(spec.body, sk);
  return { sk, ctx: sk.identity ? spec : measuredContext(shaped, { ref: spec }) };
}

/** A garment's positions by the bones (linear blend skinning with the shaped skeleton): the fallback, for comparison. */
export function bonesFit(g, sk) {
  const out = new Float32Array(g.n * 3);
  for (let i = 0; i < g.n; i++) {
    let x = 0, y = 0, z = 0, ws = 0;
    for (let k = 0; k < 4; k++) {
      const w = g.weights[i * 4 + k];
      if (!(w > 1e-6)) continue;
      const K = sk.Kof(g.nodes[i * 4 + k]);
      const v = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
      x += w * (K[0] * v[0] + K[4] * v[1] + K[8] * v[2] + K[12]);
      y += w * (K[1] * v[0] + K[5] * v[1] + K[9] * v[2] + K[13]);
      z += w * (K[2] * v[0] + K[6] * v[1] + K[10] * v[2] + K[14]);
      ws += w;
    }
    out[i * 3] = x / ws; out[i * 3 + 1] = y / ws; out[i * 3 + 2] = z / ws;
  }
  return out;
}

/**
 * A foreign body: Spec with edits written in, its vertices shuffled (no correspondence with Spec's) and,
 * optionally, the skin between two heights on the arms cut away (as an export deletes hidden polygons).
 * → { ctx, body }
 */
export function foreignBody(parts, body, { cutArms = false, aPose = false } = {}) {
  const { spec } = parts;
  const ed = editedBody(parts, body);
  const b = ed.ctx.body;
  const n = b.verts.length / 3;
  const order = Array.from({ length: n }, (_, i) => i).reverse(); // a different vertex order
  const inv = new Int32Array(n);
  order.forEach((o, k) => { inv[o] = k; });
  const verts = new Float32Array(n * 3);
  order.forEach((o, k) => { for (let a = 0; a < 3; a++) verts[k * 3 + a] = b.verts[o * 3 + a]; });
  const label = order.map((o) => b.label[o]);
  let tris = b.tris.map((t) => t.map((i) => inv[i]));
  const joints = JSON.parse(JSON.stringify(b.joints));
  if (cutArms) {
    // the upper arms' skin removed between the shoulder and the elbow (sleeves hid it)
    tris = tris.filter((t) => !t.every((i) => /^arm/.test(label[i]) && Math.abs(verts[i * 3]) > joints.leftUpperArm[0] + 0.03 && Math.abs(verts[i * 3]) < joints.leftLowerArm[0] - 0.01));
  }
  if (aPose) {
    // the arms brought down 45° about the shoulders (not a T-pose: FITTING.md §9)
    for (const side of ['left', 'right']) {
      const s = joints[`${side}UpperArm`];
      const c = Math.cos(Math.PI / 4), sn = Math.sin(Math.PI / 4) * (side === 'left' ? -1 : 1);
      const turn = (p) => { const dx = p[0] - s[0], dy = p[1] - s[1]; return [s[0] + dx * c - dy * sn, s[1] + dx * sn + dy * c, p[2]]; };
      for (let i = 0; i < n; i++) if (label[i] === (side === 'left' ? 'armL' : 'armR')) { const q = turn([verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]]); verts.set(q, i * 3); }
      for (const j of [`${side}LowerArm`, `${side}Hand`]) joints[j] = turn(joints[j]);
    }
  }
  const fb = { verts, label, tris, joints, fwd: 1 };
  return { ctx: measuredContext(fb, { ref: spec }), body: fb };
}
