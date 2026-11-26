// The body's weights under a Spec-fitted garment (FITTING.md §5.6; VRMXW W27; SPEC-QUESTIONS #60): in the
// character's model (avatar.vrm, and the live stage), each vertex of a Spec-fitted garment takes the skin
// weights of the body skin under it, bust bones included, so the cloth moves with the body in any pose.
// The item file keeps its own weights; this only changes the merged copy.
//
// For a garment vertex at its fitted place p' on the body (at rest), the nearest point of the body's skin
// gives the weights, by the barycentric blend of that triangle's three vertices' weights, the four largest
// kept. A body made on the Body page is Spec's skin moved vertex for vertex with the same weights, so the
// weights are Spec's skin weights read at the fitted place. It has to be the fitted place, not where the
// garment sat on Spec: Spec-fit moves cloth along the stations (at Bust Size +1 the stations under the
// bust move 3 cm down), and weights read where it used to sit were measured to leave 4.3 % of the skin
// under the sample fitted top showing in the stage's pose; read where it lies, 0 % (PRD §21.4).
//
// Two cases keep the garment's own weights:
//   - a vertex with weight on the item's own bones (any node that isn't one of the body skin's joints:
//     a skirt's or a coat tail's spring chains) keeps all of its weights (§5.6);
//   - cloth far from the skin. Within NEAR of it the body's weights are taken whole; from NEAR to FAR
//     the two are blended by distance; beyond FAR the garment keeps its own (SPEC-QUESTIONS #62: a long
//     coat's hem would otherwise split between the legs it hangs near).
// DOM-free, deterministic.

import { nearest } from './geom.js';

export const NEAR = 0.03; // metres from the skin: the body's weights, whole
export const FAR = 0.08; // beyond this the garment keeps its own weights

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * skin: the body's skin surface at rest (a fitting context's `skin`, Spec's vertices in order); bw: the
 * skin's weights per vertex ({ node, weight }, 4 each: Spec's body.skin); pos: the garment's fitted
 * positions on that body; g: { nodes, weights, n } (itemGeometry: the garment's own weights, node indices
 * of the merged model — Spec's nodes keep their indices there).
 * → { nodes: Int32Array(n·4), weights: Float32Array(n·4), taken, blended, kept (vertex counts), ms }
 */
export function bodyWeights(skin, bw, pos, g, { near = NEAR, far = FAR } = {}) {
  const t0 = now();
  if (!skin || !bw) throw new Error('Spec has no skin weights to give');
  const bodyJoints = new Set(bw.node);
  const n = g.n;
  const nodes = new Int32Array(n * 4), weights = new Float32Array(n * 4);
  const p = [0, 0, 0];
  const hit = { d: 0, q: [0, 0, 0], n: [0, 0, 0], tri: 0, bary: [0, 0, 0] };
  // up to 16 (node, weight) pairs per vertex, summed by node, without allocating
  const an = new Int32Array(16), aw = new Float64Array(16);
  let na = 0;
  const add = (node, w) => {
    for (let k = 0; k < na; k++) if (an[k] === node) { aw[k] += w; return; }
    an[na] = node; aw[na] = w; na++;
  };
  let taken = 0, blended = 0, kept = 0;
  const keep = (i) => {
    for (let k = 0; k < 4; k++) { nodes[i * 4 + k] = g.nodes[i * 4 + k]; weights[i * 4 + k] = g.weights[i * 4 + k]; }
    kept++;
  };
  const radii = [...new Set([Math.min(0.01, near), near, (near + far) / 2, far])];
  for (let i = 0; i < n; i++) {
    let own = false;
    for (let k = 0; k < 4; k++) if (g.weights[i * 4 + k] > 1e-3 && !bodyJoints.has(g.nodes[i * 4 + k])) { own = true; break; }
    if (own) { keep(i); continue; }
    p[0] = pos[i * 3]; p[1] = pos[i * 3 + 1]; p[2] = pos[i * 3 + 2];
    // most cloth is within a centimetre: look there first, then out in steps (a search costs its box's volume)
    let h = null;
    for (const r of radii) if ((h = nearest(skin, p, r, hit))) break;
    if (!h) { keep(i); continue; }
    const d = Math.abs(h.d);
    const a = d <= near ? 1 : (far - d) / (far - near); // the body's share
    na = 0;
    const t = h.tri;
    for (let c = 0; c < 3; c++) {
      const v = skin.tris[t * 3 + c], b = h.bary[c] * a;
      if (!(b > 0)) continue;
      for (let k = 0; k < 4; k++) { const w = bw.weight[v * 4 + k]; if (w > 1e-6) add(bw.node[v * 4 + k], w * b); }
    }
    if (a < 1) for (let k = 0; k < 4; k++) { const w = g.weights[i * 4 + k]; if (w > 1e-6) add(g.nodes[i * 4 + k], w * (1 - a)); }
    // the four largest, ties by node index (deterministic), normalised
    let s = 0;
    for (let k = 0; k < 4; k++) {
      let best = -1;
      for (let j = k; j < na; j++) if (best < 0 || aw[j] > aw[best] || (aw[j] === aw[best] && an[j] < an[best])) best = j;
      if (best < 0) { nodes[i * 4 + k] = k ? nodes[i * 4] : 0; weights[i * 4 + k] = 0; continue; }
      const tn = an[k], tw = aw[k]; an[k] = an[best]; aw[k] = aw[best]; an[best] = tn; aw[best] = tw;
      nodes[i * 4 + k] = an[k]; weights[i * 4 + k] = aw[k]; s += aw[k];
    }
    if (!(s > 1e-6)) { keep(i); continue; }
    for (let k = 0; k < 4; k++) weights[i * 4 + k] /= s;
    if (a < 1) blended++; else taken++;
  }
  return { nodes, weights, taken, blended, kept, ms: now() - t0 };
}

/** Do two weight lists differ (beyond float noise)? For tests and reports. */
export function weightsDiffer(a, b, tol = 1e-6) {
  if (a.nodes.length !== b.nodes.length) return true;
  for (let i = 0; i < a.nodes.length; i++) {
    if (Math.abs(a.weights[i] - b.weights[i]) > tol) return true;
    if (a.weights[i] > tol && a.nodes[i] !== b.nodes[i]) return true;
  }
  return false;
}
