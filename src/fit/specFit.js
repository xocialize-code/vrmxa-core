// Spec-fit (FITTING.md §5; VRMXW §7; PRD FIT-2, FIT-4, FIT-7): a garment's vertices moved from where
// they sit around one body (Spec, or a donor's for §7) to the same place around another, keeping
// their distance from the skin. DOM-free; works on plain arrays, so the bake, the live view, the
// importer and the checks all run the same arithmetic.
//
//   const coords = fitCoordinates(srcCtx, garment);          // §5.1, once per garment (cache it: W4)
//   const r = moveGarment(coords, srcCtx, tgtCtx, opts);       // §5.3–§5.5 → r.pos (target bind space)
//
// garment: { pos: Float32Array (xyz), zones: Float32Array (6 per vertex: torso, armL, armR, legL,
// legR, other — the vertex's skin weights summed by segment), tris: flat vertex indices, normals?,
// targets?: [Float32Array of position deltas] (morph targets, FIT-7) }.
//
// Choices this file makes where FITTING.md 0.2 leaves room, each in SPEC-QUESTIONS.md:
//   #47 sub-sections between stations (body.js);
//   #48 the 3 mm floor never pushes cloth further out than it sat on the source (so Spec → Spec is a no-op);
//   #49 the clean-up order: welds, smoothing, then clearance (smoothing after clearance would undo it),
//       hems smoothed only along the hem;
//   #50 weight on no fitted segment (the head: a hood) follows the bones;
//   #51 skirts: below the hip station a skirt or dress is fitted on the torso alone, its radius never
//       less than at the hip;
//   #55 over a station estimated on the source (its skin cut away), cloth is taken to be outside the
//       unknown skin: no tucked-in ease there, and the full 3 mm;
//   #52 normals take the change of the surface's own normal;
//   #57 clearance by triangle too: skin the garment covered on the source that pokes through a cloth
//       triangle on the target pushes that triangle out (a coarse garment's long edges cut across a curve
//       its vertices clear); never where it poked through on the source already;
//   #56 a point deep inside the profile (under 70 % of its radius: near the axis) keeps its share of the
//       radius rather than its distance from the skin, which is no measure there;
//   #54 where the skin under a vertex runs across the segment's axis (shoulder tops, the crotch), a cut
//       across the axis can't place it well, so the bones' move is blended in by the skin's slope.

import { SUB, sOf, hAt, radiusAt, girthAt, centreAt, estimatedAt, anchorS } from './body.js';
import { nearest, rayHit, rayTriangle, weldGroups, groupNeighbours, boundaryGroups, makeSurface, vertexNormals } from './geom.js';

export const C_MIN = 0.003;          // FITTING.md §5.4: cloth stays at least 3 mm outside the skin
export const SEARCH = 0.015;         // how far from the skin the source distances are looked for (metres)
export const NEAR_SEARCH = 0.008;    // how far inside the skin the clearance looks for cloth near or under its station skin
export const SMOOTH_PASSES = 2;      // §5.5 step 3
export const SLOPE = [0.55, 0.9];   // |skin normal · axis|: below the first, all stations; above the second, all bones (#54)
export const GROWN = 0.0005;       // the skin grew under a vertex: by more than half a millimetre
export const RATIO_WARN = [0.6, 1.6]; // §9: girth ratios beyond this get a warning and `relaxed`
const FITTED_ZONES = [0, 1, 2, 3, 4];
const SEG_OF_ZONE = ['torso', 'armL', 'armR', 'legL', 'legR'];

/** The fit rule an item asks for, with the character's overrides (VRMXW §7; VRMXA §7.5 `rule`). */
export function fitRule(manifestFit = {}, override = null) {
  const cls = ['top', 'bottom', 'skirt', 'dress'].includes(manifestFit?.class) ? manifestFit.class : 'top';
  const ease = override?.ease || manifestFit?.ease || (cls === 'skirt' || cls === 'dress' ? 'relaxed' : 'fitted');
  const hemAnchor = override?.hemAnchor || manifestFit?.hemAnchor || 'body';
  return { class: cls, ease: ease === 'relaxed' ? 'relaxed' : 'fitted', hemAnchor: hemAnchor === 'absolute' ? 'absolute' : 'body' };
}

// a point's coordinates on one zone of a body: { s, th, e, ax, r }
function coordOn(seg, p, floorS) {
  const ax = seg.axis;
  const h = ax.kind === 'y' ? p[1] : ax.tOf(p);
  const s = sOf(seg, h);
  const fr = ax.at(h);
  const d = [p[0] - fr.o[0], p[1] - fr.o[1], p[2] - fr.o[2]];
  const c = centreAt(seg, floorS != null && s < floorS ? floorS : s);
  const a = d[0] * fr.u[0] + d[1] * fr.u[1] + d[2] * fr.u[2] - c[0];
  const b = d[0] * fr.v[0] + d[1] * fr.v[1] + d[2] * fr.v[2] - c[1];
  const axial = d[0] * fr.n[0] + d[1] * fr.n[1] + d[2] * fr.n[2];
  const r = Math.hypot(a, b);
  const th = Math.atan2(b, a);
  const e = r - radiusAt(seg, s, th, floorS);
  return { s, th, e, ax: axial, h };
}

/** The zones of a vertex, adjusted for the class: below the hip, a skirt or dress is the torso's (SPEC-QUESTIONS #51). */
function zonesFor(zones, i, cls, p, src) {
  const w = Array.from(zones.subarray(i * 6, i * 6 + 6));
  if ((cls === 'skirt' || cls === 'dress') && src.segments.torso) {
    const hipS = anchorS(src.segments.torso, 'hip');
    const hipH = src.segments.torso.slices[hipS * SUB]?.h ?? -Infinity;
    if (p[1] < hipH) { w[0] += w[3] + w[4]; w[3] = 0; w[4] = 0; }
  }
  return w;
}

/**
 * Fit coordinates of a garment on a body (FITTING.md §5.1), and each vertex's signed distance from
 * that body's skin (for the clearance floor, SPEC-QUESTIONS #48). Computed, never stored in the item
 * (VRMXW W4). → { n, w (6 per vertex), c (Float64Array, 5 zones × 4 per vertex: s, θ, e, axial),
 *   d (Float32Array, signed distance, NaN when farther than SEARCH), rule, hipS, est (Uint8Array) }
 */
export function fitCoordinates(src, garment, rule = fitRule()) {
  if (src.refused) throw new Error(src.refused);
  const { pos, zones } = garment;
  const n = pos.length / 3;
  const w = new Float32Array(n * 6);
  const c = new Float64Array(n * 20);
  const d = new Float32Array(n);
  const est = new Uint8Array(n);
  const cond = new Float32Array(n * 5).fill(1);
  const hipS = src.segments.torso ? anchorS(src.segments.torso, 'hip') : null;
  const floorS = rule.class === 'skirt' || rule.class === 'dress' ? hipS : null;
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    p[0] = pos[i * 3]; p[1] = pos[i * 3 + 1]; p[2] = pos[i * 3 + 2];
    const zw = zonesFor(zones, i, rule.class, p, src);
    for (let z = 0; z < 6; z++) w[i * 6 + z] = zw[z];
    for (const z of FITTED_ZONES) {
      if (zw[z] <= 1e-6) continue;
      const seg = src.segments[SEG_OF_ZONE[z]];
      if (!seg) { w[i * 6 + 5] += w[i * 6 + z]; w[i * 6 + z] = 0; continue; } // no skin there: by the bones
      const q = coordOn(seg, p, z === 0 ? floorS : null);
      c.set([q.s, q.th, q.e, q.ax], i * 20 + z * 4);
      if (estimatedAt(seg, q.s)) est[i] = 1;
    }
    const nr = nearest(src.skin, p, SEARCH);
    d[i] = nr ? nr.d : NaN;
    if (nr) {
      // the skin's slope against each zone's axis (SPEC-QUESTIONS #54)
      for (const z of FITTED_ZONES) {
        if (zw[z] <= 1e-6) continue;
        const seg = src.segments[SEG_OF_ZONE[z]];
        if (!seg) continue;
        const ax = seg.axis.kind === 'y' ? [0, 1, 0] : seg.axis.at(seg.axis.tOf(p)).n;
        const a = Math.abs(nr.n[0] * ax[0] + nr.n[1] * ax[1] + nr.n[2] * ax[2]);
        const t = Math.min(1, Math.max(0, (a - SLOPE[0]) / (SLOPE[1] - SLOPE[0])));
        cond[i * 5 + z] = 1 - t * t * (3 - 2 * t);
      }
    }
  }
  // the garment's own topology, which no body changes: welds, neighbours, hems, normals (cached with the coordinates)
  const wg = weldGroups(pos);
  const topo = { wg, nb: groupNeighbours(garment.tris, wg.group, wg.count), hem: boundaryGroups(garment.tris, wg.group, wg.count), before: vertexNormals(pos, garment.tris) };
  return { n, w, c, d, est, cond, rule, hipS, floorS, topo };
}

// move one zone's coordinates onto the target: → [x, y, z]
function placeOn(seg, srcSeg, q, rule, ratioRelaxed, floorS, hemAbs, est = false, shape = null) {
  let s = q.s;
  if (hemAbs && seg.axis.kind === 'y') {
    // hemAnchor "absolute": a fixed distance from the nearest station, not a share of the way to the next
    const k = Math.min(seg.anchors.length - 1, Math.max(0, Math.round(s)));
    const hT = hAt(seg, k) + (hAt(srcSeg, s) - hAt(srcSeg, k));
    s = sOf(seg, hT);
  }
  const h = hAt(seg, s);
  const fr = seg.axis.at(h);
  const c = centreAt(seg, floorS != null && s < floorS ? floorS : s);
  // over an estimated station the source's skin isn't known there: its cloth is taken to be outside it (#55)
  let e = est ? Math.max(q.e, C_MIN) : q.e;
  if (e > 0) {
    let e2 = e;
    if (ratioRelaxed) e2 = e * (girthAt(seg, s, floorS) / (girthAt(srcSeg, q.s, floorS) || 1));
    e = Math.max(e2, Math.min(e, C_MIN)); // never under 3 mm, nor further out than it was (SPEC-QUESTIONS #48)
  }
  // the seam for reshaping controls (girth per station band, length, flare) and for an automatic match: a
  // multiplier on the target's radius and one on the ease, per place, applied here and nowhere else
  const sh = shape ? shape(seg.id, s, q.th) : null;
  const Rt = radiusAt(seg, s, q.th, floorS) * (sh?.radius ?? 1);
  let r = Rt + e * (sh?.ease ?? 1);
  // deep inside the profile (towards the axis: the crotch seam of trousers), the ease is no measure and θ
  // is barely defined: there the point keeps its share of the radius instead, blended in smoothly (#56)
  const Rs = radiusAt(srcSeg, q.s, q.th, floorS);
  const share = Rs > 1e-6 ? (Rs + q.e) / Rs : 1;
  if (share < 0.7) {
    const t = Math.min(1, Math.max(0, (share - 0.3) / 0.4));
    const w = t * t * (3 - 2 * t);
    r = w * r + (1 - w) * Math.max(0, share) * Rt;
  }
  const ct = Math.cos(q.th), st = Math.sin(q.th);
  const a = c[0] + r * ct, b = c[1] + r * st;
  return [fr.o[0] + fr.u[0] * a + fr.v[0] * b + fr.n[0] * q.ax, fr.o[1] + fr.u[1] * a + fr.v[1] * b + fr.n[1] * q.ax, fr.o[2] + fr.u[2] * a + fr.v[2] * b + fr.n[2] * q.ax];
}

/**
 * The zone move alone (§5.3): each vertex to its place around the target, blended by zone weight;
 * weight on no fitted zone follows `bones` (the bones-fitted position, SPEC-QUESTIONS #50).
 * pts: optional other source positions with the same weights (morph targets, FIT-7): they are given
 * coordinates on the fly. → Float64Array (xyz)
 */
export function zoneMove(coords, src, tgt, { bones = null, pts = null, ruleOver = null, grow = null, easeT = null, shape = null } = {}) {
  const rule = ruleOver || coords.rule;
  const n = coords.n;
  const out = new Float64Array(n * 3);
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0, z = 0, ws = 0;
    const relaxed = rule.ease === 'relaxed' || coords.est[i] === 1;
    for (const zn of FITTED_ZONES) {
      const wz = coords.w[i * 6 + zn];
      if (wz <= 1e-6) continue;
      const seg = tgt.segments[SEG_OF_ZONE[zn]], srcSeg = src.segments[SEG_OF_ZONE[zn]];
      if (!seg || !srcSeg) continue;
      let q;
      if (pts) { p[0] = pts[i * 3]; p[1] = pts[i * 3 + 1]; p[2] = pts[i * 3 + 2]; q = coordOn(srcSeg, p, zn === 0 ? coords.floorS : null); }
      else { const o = i * 20 + zn * 4; q = { s: coords.c[o], th: coords.c[o + 1], e: coords.c[o + 2], ax: coords.c[o + 3] }; }
      const fs = zn === 0 ? coords.floorS : null;
      const r = placeOn(seg, srcSeg, q, rule, relaxed, fs, rule.hemAnchor === 'absolute', coords.est[i] === 1 && estimatedAt(srcSeg, q.s), shape);
      // blend in the bones' move where the skin runs across this zone's axis (#54)
      const k = bones && coords.cond ? coords.cond[i * 5 + zn] : 1;
      if (k < 1) for (let a = 0; a < 3; a++) r[a] = k * r[a] + (1 - k) * bones[i * 3 + a];
      x += wz * r[0]; y += wz * r[1]; z += wz * r[2]; ws += wz;
      if (grow) grow[i] += wz * k * (radiusAt(seg, q.s, q.th, fs) - radiusAt(srcSeg, q.s, q.th, fs));
      if (easeT) easeT[i] += wz * q.e;
    }
    let total = 0;
    for (let k = 0; k < 6; k++) total += coords.w[i * 6 + k];
    const wo = total - ws;
    if (wo > 1e-6 && bones) { x += wo * bones[i * 3]; y += wo * bones[i * 3 + 1]; z += wo * bones[i * 3 + 2]; ws += wo; }
    if (grow && ws > 1e-9) grow[i] /= ws;
    if (easeT && ws > 1e-9) easeT[i] /= ws;
    if (ws < 1e-9) { // nothing fitted and no bones given: the caller keeps it where it was
      out[i * 3] = NaN; out[i * 3 + 1] = NaN; out[i * 3 + 2] = NaN;
      continue;
    }
    out[i * 3] = x / ws; out[i * 3 + 1] = y / ws; out[i * 3 + 2] = z / ws;
  }
  return out;
}

/** Girth ratios target / source at each station, and warnings for those beyond §9's 0.6–1.6. */
export function girthRatios(src, tgt) {
  const out = {}, warnings = [];
  for (const id of Object.keys(src.segments)) {
    const a = src.segments[id], b = tgt.segments[id];
    if (!a || !b) continue;
    for (let k = 1; k < a.anchors.length - 1; k++) {
      const ga = a.slices[k * SUB].girth, gb = b.slices[k * SUB].girth;
      if (!(ga > 0 && gb > 0)) continue;
      const r = gb / ga;
      out[a.anchors[k].id] = Math.round(r * 1e4) / 1e4;
      if (r < RATIO_WARN[0] || r > RATIO_WARN[1]) warnings.push(`${a.anchors[k].id}: the body is ${r.toFixed(2)}× Spec's girth there (beyond ${RATIO_WARN.join('–')}): fitted with the relaxed rule`);
    }
  }
  return { ratios: out, warnings };
}

/**
 * Move a garment onto the target (FITTING.md §5.3–§5.5). coords: fitCoordinates on the source;
 * garment: as above (pos, tris, normals, targets); opts: { bones (Float32Array, the bones-fitted
 * positions in target space, for weight on no fitted zone and for vertices that can't be fitted),
 * inner: [{ src: surface, tgt: surface }] (garments beneath, inner first: FIT-4), rule (overrides), shape
 * ((segment, s, θ) → { radius, ease } multipliers: the seam for per-band reshaping controls; none by default),
 * identity (true when the target is the source: nothing moves) }.
 * → { pos: Float32Array, normals, targets, pushed: Uint8Array, stats }
 */
export function moveGarment(coords, src, tgt, garment, opts = {}) {
  const t0 = now();
  const n = coords.n;
  const rule = opts.rule ? { ...coords.rule, ...opts.rule } : coords.rule;
  if (opts.identity) {
    return { pos: Float32Array.from(garment.pos), normals: garment.normals ? Float32Array.from(garment.normals) : null, targets: garment.targets ? garment.targets.map((t) => Float32Array.from(t)) : null, pushed: new Uint8Array(n), stats: { ms: now() - t0, identity: true, pushed: 0 } };
  }
  const { ratios, warnings } = girthRatios(src, tgt);
  const wide = Object.values(ratios).some((r) => r < RATIO_WARN[0] || r > RATIO_WARN[1]);
  const useRule = wide ? { ...rule, ease: 'relaxed' } : rule;
  // 1. the zone move
  const grow = new Float64Array(n), easeT = new Float64Array(n);
  const moved = zoneMove(coords, src, tgt, { bones: opts.bones || null, ruleOver: useRule, grow, easeT, shape: opts.shape || null });
  const tMove = now();
  const pos = garment.pos;
  const topo = coords.topo || { wg: weldGroups(pos) };
  // 2. welds: vertices at one place get one displacement (§5.5 step 1)
  const wg = topo.wg;
  const G = wg.count;
  const disp = new Float64Array(G * 3), cnt = new Float64Array(G);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(moved[i * 3])) { // unfitted, no bones: keep
      moved[i * 3] = pos[i * 3]; moved[i * 3 + 1] = pos[i * 3 + 1]; moved[i * 3 + 2] = pos[i * 3 + 2];
    }
    const g = wg.group[i];
    for (let a = 0; a < 3; a++) disp[g * 3 + a] += moved[i * 3 + a] - pos[i * 3 + a];
    cnt[g]++;
  }
  for (let g = 0; g < G; g++) for (let a = 0; a < 3; a++) disp[g * 3 + a] /= cnt[g];
  // 3. smoothing of the displacement, not the positions (§5.5 step 3); hems only along the hem
  const nb = topo.nb || groupNeighbours(garment.tris, wg.group, G);
  const hem = topo.hem || boundaryGroups(garment.tris, wg.group, G);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Float64Array(disp);
    for (let g = 0; g < G; g++) {
      const list = nb[g];
      if (!list.length) continue;
      let sx = 0, sy = 0, sz = 0, k = 0;
      const onHem = hem[g] === 1;
      for (let j = 0; j < list.length; j++) {
        const o = list[j];
        if (onHem && hem[o] !== 1) continue;
        sx += disp[o * 3]; sy += disp[o * 3 + 1]; sz += disp[o * 3 + 2]; k++;
      }
      if (!k) continue;
      next[g * 3] = 0.5 * disp[g * 3] + 0.5 * sx / k;
      next[g * 3 + 1] = 0.5 * disp[g * 3 + 1] + 0.5 * sy / k;
      next[g * 3 + 2] = 0.5 * disp[g * 3 + 2] + 0.5 * sz / k;
    }
    disp.set(next);
  }
  const tSmooth = now();
  // 4. clearance: at least min(3 mm, how far out it sat on the source) outside the target's skin, and
  //    outside what is worn beneath by its ease there (§5.4, §5.5 steps 2 and 4; SPEC-QUESTIONS #48)
  const pushed = new Uint8Array(n);
  const pushedG = new Uint8Array(G);
  let msTri = 0, msGrid = 0, tGrid = 0;
  let pushes = 0;
  const p = [0, 0, 0], ps = [0, 0, 0];
  const NR = { d: 0, q: [0, 0, 0], n: [0, 0, 0], tri: 0, bary: [0, 0, 0] }, NS = { d: 0, q: [0, 0, 0], n: [0, 0, 0], tri: 0, bary: [0, 0, 0] };
  const inner = opts.inner || [];
  for (let g = 0; g < G; g++) {
    const i = wg.first[g];
    const ds = coords.d[i];
    // the floor: tucked-in cloth (inside the source skin) keeps its depth; cloth far out needs nothing
    // where the body grew under it, the full 3 mm; elsewhere no further out than it sat (SPEC-QUESTIONS #48)
    let tau = coords.est[i] ? C_MIN // over an estimated station: the full 3 mm (#55)
      : Number.isFinite(ds) ? (ds >= 0 && grow[i] > GROWN ? C_MIN : Math.min(C_MIN, ds)) : (avgE(coords, i) < 0 ? -Infinity : C_MIN);
    if (tau === -Infinity && !inner.length) continue;
    p[0] = pos[i * 3] + disp[g * 3]; p[1] = pos[i * 3 + 1] + disp[g * 3 + 1]; p[2] = pos[i * 3 + 2] + disp[g * 3 + 2];
    // cloth well outside the station's skin can only need a push if the skin is within the floor: look that far;
    // cloth near or under it, further (it may be inside)
    const far = easeT[i] > C_MIN && !inner.length;
    const nr = nearest(tgt.skin, p, Math.max(0, tau) + (far ? 0.001 : NEAR_SEARCH), NR);
    if (!nr) continue;
    for (const layer of inner) {
      // the inner garment's ease along the skin normal, on the target and on the source
      const eT = rayHit(layer.tgt, nr.q, nr.n, 0.06);
      if (!Number.isFinite(eT)) continue;
      ps[0] = pos[i * 3]; ps[1] = pos[i * 3 + 1]; ps[2] = pos[i * 3 + 2];
      const ns = nearest(src.skin, ps, 0.04, NS);
      if (!ns) continue;
      const eS = rayHit(layer.src, ns.q, ns.n, 0.06);
      if (!Number.isFinite(eS) || ns.d <= eS) continue; // it wasn't outside that garment on the source
      tau = Math.max(tau, eT + Math.min(C_MIN, ns.d - eS));
    }
    if (nr.d >= tau - 1e-7) continue; // (a hair's breadth is float noise, not a push)
    const k = tau - nr.d;
    disp[g * 3] += nr.n[0] * k; disp[g * 3 + 1] += nr.n[1] * k; disp[g * 3 + 2] += nr.n[2] * k;
    pushedG[g] = 1;
    pushes++;
  }
  // 4b. clearance by triangle (#57): skin the garment covered on the source (`covered`, vertex for vertex), or
  //     for a foreign source any skin away from a hem whose triangle sat outside the source's skin, that now has
  //     cloth beneath it and none over it, pushes that triangle's corners out along its normal
  const tTri0 = now();
  if (opts.covered || opts.foreign) {
    const cur = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const g = wg.group[i]; for (let a = 0; a < 3; a++) cur[i * 3 + a] = pos[i * 3 + a] + disp[g * 3 + a]; }
    const cloth = makeSurface(cur, garment.tris, { cell: 0.02 });
    tGrid = now();
    const { verts: sv, normals: sn } = tgt.skin;
    const o = [0, 0, 0], oi = [0, 0, 0], dIn = [0, 0, 0], dOut = [0, 0, 0];
    const want = new Float64Array(G); // the push each group needs, along the skin normal (the largest asked)
    const dir = new Float64Array(G * 3);
    for (let v = 0; v < sv.length / 3; v++) {
      if (opts.covered && !opts.covered[v]) continue;
      o[0] = sv[v * 3]; o[1] = sv[v * 3 + 1]; o[2] = sv[v * 3 + 2];
      dOut[0] = sn[v * 3]; dOut[1] = sn[v * 3 + 1]; dOut[2] = sn[v * 3 + 2];
      dIn[0] = -dOut[0]; dIn[1] = -dOut[1]; dIn[2] = -dOut[2];
      for (let a = 0; a < 3; a++) oi[a] = o[a] + dIn[a] * 0.0002;
      const hit = rayTriangle(cloth, oi, dIn, 0.012);
      if (!hit || Number.isFinite(rayHit(cloth, o, dOut, 0.08))) continue;
      const t = hit.tri;
      const corners = [garment.tris[t * 3], garment.tris[t * 3 + 1], garment.tris[t * 3 + 2]];
      // (a corner with no source skin near it, cut away under clothes, counts as outside it: #55)
      if (!opts.covered && corners.some((i) => hem[wg.group[i]] === 1 || coords.d[i] < 0)) continue;
      const k = hit.t + 0.0002 + Math.min(C_MIN, 0.001);
      for (const i of corners) {
        const g = wg.group[i];
        if (k > want[g]) { want[g] = k; dir[g * 3] = dOut[0]; dir[g * 3 + 1] = dOut[1]; dir[g * 3 + 2] = dOut[2]; }
      }
    }
    for (let g = 0; g < G; g++) {
      if (!want[g]) continue;
      for (let a = 0; a < 3; a++) disp[g * 3 + a] += dir[g * 3 + a] * want[g];
      if (!pushedG[g]) { pushedG[g] = 1; pushes++; }
    }
  }
  const tClear = now();
  msTri = tClear - tTri0; msGrid = tGrid ? tGrid - tTri0 : 0;
  // scatter
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = wg.group[i];
    out[i * 3] = pos[i * 3] + disp[g * 3]; out[i * 3 + 1] = pos[i * 3 + 1] + disp[g * 3 + 1]; out[i * 3 + 2] = pos[i * 3 + 2] + disp[g * 3 + 2];
    pushed[i] = pushedG[g];
  }
  // 5. normals: each takes the change of the surface's own normal there (§5.6; SPEC-QUESTIONS #52)
  let normals = null;
  if (garment.normals) {
    const before = topo.before || vertexNormals(pos, garment.tris), after = vertexNormals(out, garment.tris);
    normals = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      const x = garment.normals[i] + after[i] - before[i], y = garment.normals[i + 1] + after[i + 1] - before[i + 1], z = garment.normals[i + 2] + after[i + 2] - before[i + 2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-6) { normals[i] = garment.normals[i]; normals[i + 1] = garment.normals[i + 1]; normals[i + 2] = garment.normals[i + 2]; continue; }
      normals[i] = x / l; normals[i + 1] = y / l; normals[i + 2] = z / l;
    }
  }
  // 6. morph targets (FIT-7, VRMXW §8.1): each delta moved by the same zone move, with the clean-up's
  //    displacement shared: δ' = Z(p + δ) − Z(p)
  let targets = null;
  if (garment.targets?.length) {
    targets = garment.targets.map((delta) => {
      const changed = [];
      for (let i = 0; i < n; i++) if (delta[i * 3] || delta[i * 3 + 1] || delta[i * 3 + 2]) changed.push(i);
      const res = new Float32Array(n * 3);
      if (!changed.length) return res;
      const pts = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) pts[i] = pos[i] + delta[i];
      const zm = zoneMove(coords, src, tgt, { bones: null, pts, ruleOver: useRule, shape: opts.shape || null });
      for (const i of changed) for (let a = 0; a < 3; a++) {
        const v = zm[i * 3 + a] - moved[i * 3 + a];
        res[i * 3 + a] = Number.isFinite(v) ? v : delta[i * 3 + a];
      }
      return res;
    });
  }
  const t1 = now();
  return {
    pos: out, normals, targets, pushed,
    stats: { ms: t1 - t0, msMove: tMove - t0, msSmooth: tSmooth - tMove, msClear: tClear - tSmooth, msTri, msGrid, msNormals: t1 - tClear, vertices: n, groups: G, pushed: pushes, rule: useRule, ratios, warnings },
  };
}

function avgE(coords, i) {
  let e = 0, w = 0;
  for (const z of FITTED_ZONES) { const wz = coords.w[i * 6 + z]; if (wz > 1e-6) { e += wz * coords.c[i * 20 + z * 4 + 2]; w += wz; } }
  return w ? e / w : 0;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---- the checks (FITTING.md §8) ----------------------------------------------------------------------

/**
 * Which skin vertices the garments cover: along the vertex's normal, cloth within `out` metres
 * outside it. garments: surfaces (makeSurface) in the body's space. → Uint8Array (1 = covered)
 */
export function skinCover(ctx, garments, { out = 0.06 } = {}) {
  const { verts, normals } = ctx.skin;
  const nv = verts.length / 3;
  const mask = new Uint8Array(nv);
  const o = [0, 0, 0], d = [0, 0, 0];
  for (let i = 0; i < nv; i++) {
    o[0] = verts[i * 3]; o[1] = verts[i * 3 + 1]; o[2] = verts[i * 3 + 2];
    d[0] = normals[i * 3]; d[1] = normals[i * 3 + 1]; d[2] = normals[i * 3 + 2];
    for (const g of garments) if (Number.isFinite(rayHit(g, o, d, out))) { mask[i] = 1; break; }
  }
  return mask;
}

/**
 * Skin through cloth (§8): covered skin vertices that end up outside the garment, the cloth passing
 * beneath them. With `covered` (the mask skinCover gave on the source, for a body made from it vertex
 * for vertex: Body page edits) those are the vertices counted; without it (a foreign body), a vertex
 * counts when cloth is within 6 cm outside it or `inward` inside it. A counted vertex is through when
 * no cloth is over it (within `out`: more than the 6 cm of covering, since a relaxed skirt moves out)
 * and cloth is between `tol` (0.05 mm) and `inward` beneath it. One with no cloth either side was uncovered: a hem moved
 * past it (hems follow the stations), not skin through cloth; it is reported apart.
 * → { covered, through, share, uncovered, uncoveredShare, worst: [vertex indices, up to 20] }
 */
export function skinThrough(ctx, garments, { covered = null, out = 0.08, inward = 0.012, tol = 0.00005 } = {}) {
  const { verts, normals } = ctx.skin;
  let nCov = 0, through = 0, uncovered = 0;
  const worst = [];
  const o = [0, 0, 0], oi = [0, 0, 0], dIn = [0, 0, 0], dOut = [0, 0, 0];
  const nv = verts.length / 3;
  const hitFrom = (from, dir, max) => { for (const g of garments) if (Number.isFinite(rayHit(g, from, dir, max))) return true; return false; };
  const hit = (dir, max) => hitFrom(o, dir, max);
  for (let i = 0; i < nv; i++) {
    if (covered && !covered[i]) continue;
    o[0] = verts[i * 3]; o[1] = verts[i * 3 + 1]; o[2] = verts[i * 3 + 2];
    dOut[0] = normals[i * 3]; dOut[1] = normals[i * 3 + 1]; dOut[2] = normals[i * 3 + 2];
    dIn[0] = -dOut[0]; dIn[1] = -dOut[1]; dIn[2] = -dOut[2];
    // cloth counts as beneath deeper than `tol` (0.05 mm: closer is float noise; 0.4 mm already shows on the stage)
    for (let a = 0; a < 3; a++) oi[a] = o[a] + dIn[a] * tol;
    const inH = hitFrom(oi, dIn, inward);
    if (!covered && !inH && !hit(dOut, 0.06)) continue;
    nCov++;
    if (hit(dOut, out)) continue;
    if (inH) { through++; if (worst.length < 20) worst.push(i); }
    else if (covered) uncovered++;
  }
  return { covered: nCov, through, share: nCov ? through / nCov : 0, uncovered, uncoveredShare: nCov ? uncovered / nCov : 0, worst };
}

/**
 * Ease kept (§8, `fitted`): the RMS of e' − e over the vertices no clearance push moved, e' being the
 * fitted vertex's ease measured on the target. → { rms (metres), count }
 */
export function easeKept(coords, src, tgt, fittedPos, pushed) {
  let sum = 0, k = 0;
  const p = [0, 0, 0];
  for (let i = 0; i < coords.n; i++) {
    if (pushed[i]) continue;
    for (const z of FITTED_ZONES) {
      if (coords.w[i * 6 + z] < 0.999) continue; // single-zone vertices: a blend has no one ease
      const seg = tgt.segments[SEG_OF_ZONE[z]];
      if (!seg) continue;
      const e0 = coords.c[i * 20 + z * 4 + 2];
      if (e0 < C_MIN) continue; // the floor may have moved it
      p[0] = fittedPos[i * 3]; p[1] = fittedPos[i * 3 + 1]; p[2] = fittedPos[i * 3 + 2];
      const q = coordOn(seg, p, z === 0 ? coords.floorS : null);
      const want = coords.rule.ease === 'relaxed' || coords.est[i] ? null : e0;
      if (want == null) continue;
      sum += (q.e - want) ** 2; k++;
    }
  }
  return { rms: k ? Math.sqrt(sum / k) : 0, count: k };
}

/**
 * Hems (§8): each hem vertex's station parameter s on the target against the source's, and the same
 * difference as a distance along the segment (metres): where two stations nearly meet (a wrist station
 * 5 mm from the hand joint), a fraction of a millimetre is a large Δs. → { max, mean (|Δs|), maxM,
 * meanM (metres), count, at }
 */
export function hemsKept(coords, tgt, garment, fittedPos) {
  const wg = coords.topo?.wg || weldGroups(garment.pos);
  const hem = coords.topo?.hem || boundaryGroups(garment.tris, wg.group, wg.count);
  let max = 0, sum = 0, k = 0, at = null, maxMm = 0, sumMm = 0;
  const p = [0, 0, 0];
  for (let i = 0; i < coords.n; i++) {
    if (hem[wg.group[i]] !== 1) continue;
    for (const z of FITTED_ZONES) {
      if (coords.w[i * 6 + z] < 0.999) continue;
      const seg = tgt.segments[SEG_OF_ZONE[z]];
      if (!seg) continue;
      p[0] = fittedPos[i * 3]; p[1] = fittedPos[i * 3 + 1]; p[2] = fittedPos[i * 3 + 2];
      const q = coordOn(seg, p, z === 0 ? coords.floorS : null);
      const s0 = coords.c[i * 20 + z * 4];
      const ds = Math.abs(q.s - s0);
      // the same along the axis, in metres (arms: t × the arm's length)
      const scale = seg.axis.kind === 'arm' ? seg.axis.total : 1;
      const dm = Math.abs(hAt(seg, q.s) - hAt(seg, s0)) * scale;
      if (ds > max) max = ds;
      if (dm > maxMm) { maxMm = dm; at = { vertex: i, zone: SEG_OF_ZONE[z], s: s0, sT: q.s }; }
      sum += ds; sumMm += dm; k++;
    }
  }
  return { max, mean: k ? sum / k : 0, maxM: maxMm, meanM: k ? sumMm / k : 0, count: k, at };
}

/** The ease of each vertex on its body (for the heat map), metres; NaN where it has no fitted zone. */
export function easeOf(coords) {
  const out = new Float32Array(coords.n);
  for (let i = 0; i < coords.n; i++) {
    let e = 0, w = 0;
    for (const z of FITTED_ZONES) { const wz = coords.w[i * 6 + z]; if (wz > 1e-6) { e += wz * coords.c[i * 20 + z * 4 + 2]; w += wz; } }
    out[i] = w > 1e-6 ? e / w : NaN;
  }
  return out;
}

export { makeSurface };
