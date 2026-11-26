// Face > Face Shape: the head as a shape you pick and then fine-tune, starting from a blank egg.
// DOM-free (runs under Node for tests).
//
// How it works. Every head is described the same way: a radius map, the distance from the head's
// centre to its skin in each direction (a grid of latitude × longitude in the head's own frame:
// x across, y up, z forward). Three kinds of map:
//   • the base figure's own head (Spec): scanned from its face and body skin by casting a ray from
//     the centre in every grid direction (scanHead);
//   • the blank canvas: a smooth egg, fitted to that head's overall size (fitEgg) — no nose, no
//     cheekbones, no jaw line;
//   • the preset shapes (Round, Oval, Heart, Square): the egg with other proportions, laid onto the
//     scanned head as a ratio, so the face's own features stay (the nose stays a nose).
// The head shown is lerp(egg, picked shape, Canvas amount), times the fine-tune controls. Each skin
// point then moves along its direction from the centre by (that radius ÷ the scanned radius), with
// the neck held where it meets the body. The Nose and Cheek controls (face.js deformPositions) run
// after, on the reshaped face, around landmarks moved the same way — so they fine-tune whatever head
// was picked. All sizes and amounts here are this library's own (estimated).

export const HEAD_SHAPES = [
  { id: 'spec', label: 'Spec' },
  { id: 'egg', label: 'Egg (blank)' },
  { id: 'round', label: 'Round' },
  { id: 'oval', label: 'Oval' },
  { id: 'heart', label: 'Heart' },
  { id: 'square', label: 'Square' },
];
export const HEAD_DEFAULT = 'spec';
export const HEAD_SHAPE_IDS = HEAD_SHAPES.map((s) => s.id);

// the fine-tune controls, shown on Face Shape (stored with the other face shapes): a one-way slider
// (0 … 1) for a proportion or size the head leans toward, a two-way slider (−1 … 1) for a pair of
// opposite directions (EDITS.md §3.5).
export const HEAD_TUNES = [
  { key: 'canvas', label: 'Blank Egg → Head Shape', min: 0, max: 1, def: 1 },
  { key: 'headFemale', label: 'Head Shape (Female)', min: 0, max: 1 },
  { key: 'headMale', label: 'Head Shape (Male)', min: 0, max: 1 },
  { key: 'faceRound', label: 'Round Face', min: 0, max: 1 },
  { key: 'headWidth', label: 'Head Width', min: -1, max: 1 },
  { key: 'headHeight', label: 'Head Height', min: -1, max: 1 },
  { key: 'headDepth', label: 'Head Depth', min: -1, max: 1 },
  { key: 'forehead', label: 'Forehead', min: -1, max: 1 },
  { key: 'cheekbone', label: 'Cheekbone Width', min: -1, max: 1 },
  { key: 'jawSize', label: 'Jaw Size', min: 0, max: 1 },
  { key: 'chinSlim', label: 'Chin Slim', min: 0, max: 1 },
  { key: 'chinLength', label: 'Chin Tip Up / Down', min: -1, max: 1 },
];
const TUNE = Object.fromEntries(HEAD_TUNES.map((t) => [t.key, t]));

// how far each control goes at its end (fractions of the radius; this library's own, estimated)
export const HEAD_AMOUNTS = {
  headWidth: 0.08, headHeight: 0.06, headDepth: 0.08, forehead: 0.05, cheekbone: 0.05,
  jawSize: 0.07, chinSlim: 0.15, chinLength: 0.07,
};

// the presets: the fitted egg's proportions changed (multipliers; taper / square set outright)
export const HEAD_PRESETS = {
  round: { ax: 1.05, azF: 1.02, azB: 1.02, ayUp: 0.98, ayDown: 0.92, taperMul: 0.55 },
  oval: { ax: 0.95, ayUp: 1.04, ayDown: 1.08 },
  heart: { ax: 1.04, ayDown: 1.03, taperAdd: 0.15 },
  square: { ax: 1.03, ayDown: 0.96, taperMul: 0.5, square: 2.4 },
  // what the one-way Head Shape (Female) / (Male) and Round Face sliders lean toward, at 1
  // (this library's own proportions)
  female: { ax: 0.97, azF: 0.98, azB: 0.99, ayDown: 0.95, taperAdd: 0.08 },
  male: { ax: 1.05, ayUp: 1.02, ayDown: 1.05, azF: 1.02, taperMul: 0.6, square: 2.3 },
};

// the grid: 5° steps, latitude −90 … 90 (37 rows), longitude −180 … 175 (72 columns), 0 = facing forward
export const NLAT = 37, NLON = 72, STEP = 5;
const D2R = Math.PI / 180;

// the head's centre, from the eyes: up 0.34 and back 0.93 eye distances from between the eyes (read
// off Spec: her face and head skin span y 1.337 … 1.578, z −0.133 … 0.089; estimated)
export const CENTRE_UP = 0.34, CENTRE_BACK = 0.93;

const smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const dirOf = (i, j) => {
  const lat = (-90 + i * STEP) * D2R, lon = (-180 + j * STEP) * D2R;
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)]; // head frame
};

/** Grid directions that matter for comparing heads: the head itself, not the neck under it. */
export function headCell(i, j) {
  const lat = -90 + i * STEP, lon = -180 + j * STEP;
  // (below 45° only the chin and jaw at the front: further back, rays from the centre run down the neck)
  return lat >= -45 || (lat >= -65 && Math.abs(lon) <= 35);
}

// ray–triangle (Möller–Trumbore) -> distance along the ray, or -1
function rayTri(o, u, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [u[1] * e2[2] - u[2] * e2[1], u[2] * e2[0] - u[0] * e2[2], u[0] * e2[1] - u[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det, t0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const uu = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (uu < 0 || uu > 1) return -1;
  const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
  const vv = (u[0] * q[0] + u[1] * q[1] + u[2] * q[2]) * inv;
  if (vv < 0 || uu + vv > 1) return -1;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
}

/**
 * Scan a head. lm: the face landmarks (mid, d, fwd); faceTris / bodyTris: lists of triangles
 * [[a, b, c], …] (points in the mesh's bind space) of the face skin and of the body skin near the head.
 * -> { c, f, d, R (Float32Array radius map, metres), yNeck, zNeck, egg (fitted egg parameters) }
 */
export function scanHead(lm, faceTris, bodyTris) {
  const { mid, d } = lm;
  const f = lm.fwd || 1;
  const c = [mid[0], mid[1] + CENTRE_UP * d, mid[2] - f * CENTRE_BACK * d];
  const reach = 2.2 * d;
  const tris = [];
  for (const t of [...faceTris, ...bodyTris]) {
    // only triangles around the head; each with its direction from the centre and angular size
    const m = [0, 1, 2].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
    const v = [m[0] - c[0], m[1] - c[1], m[2] - c[2]];
    const r = Math.hypot(...v);
    if (r > reach || r < 1e-6) continue;
    let ang = 0;
    for (const p of t) ang = Math.max(ang, Math.hypot(p[0] - m[0], p[1] - m[1], p[2] - m[2]));
    tris.push({ t, dir: v.map((x) => x / r), cosMax: Math.cos(Math.min(Math.PI / 2, Math.asin(Math.min(1, ang / r)) + 0.01)) });
  }
  const R = new Float32Array(NLAT * NLON);
  for (let i = 0; i < NLAT; i++)
    for (let j = 0; j < NLON; j++) {
      const h = dirOf(i, j);
      const u = [h[0], h[1], h[2] * f]; // model space (a VRM 0.x file faces −Z)
      let best = -1;
      for (const tr of tris) {
        if (u[0] * tr.dir[0] + u[1] * tr.dir[1] + u[2] * tr.dir[2] < tr.cosMax) continue;
        const s = rayTri(c, u, tr.t[0], tr.t[1], tr.t[2]);
        if (s > best) best = s;
      }
      R[i * NLON + j] = best > 0 ? best : NaN;
    }
  fillHoles(R);
  // where the head meets the neck: the face skin's lowest point, and the front of the neck there
  let yNeck = Infinity;
  for (const t of faceTris) for (const p of t) yNeck = Math.min(yNeck, p[1]);
  let zNeck = -Infinity;
  for (const t of bodyTris) for (const p of t)
    if (p[1] > yNeck - 0.12 * d && p[1] < yNeck + 0.25 * d && Math.abs(p[0] - c[0]) < 0.7 * d) zNeck = Math.max(zNeck, p[2] * f);
  if (!Number.isFinite(zNeck)) zNeck = c[2] * f + 0.3 * d;
  const head = { c, f, d, R, yNeck, zNeck };
  head.egg = fitEgg(R);
  return head;
}

// directions no skin answered (straight down the neck, gaps): the average of their answered neighbours
function fillHoles(R) {
  for (let pass = 0; pass < NLAT + NLON; pass++) {
    let left = 0;
    const next = Float32Array.from(R);
    for (let i = 0; i < NLAT; i++)
      for (let j = 0; j < NLON; j++) {
        if (!Number.isNaN(R[i * NLON + j])) continue;
        let s = 0, n = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = (j + dj + NLON) % NLON;
          if (ii < 0 || ii >= NLAT) continue;
          const v = R[ii * NLON + jj];
          if (!Number.isNaN(v)) { s += v; n++; }
        }
        if (n) next[i * NLON + j] = s / n; else left++;
      }
    R.set(next);
    if (!left) break;
  }
}

/**
 * The egg's radius in a head-frame direction. p: { ax (half width), ayUp, ayDown (top / chin),
 * azF, azB (front / back), taper (narrower toward the chin, 0 … 0.6), square (2 = round, more = boxier
 * lower half) }. A superellipsoid per octant, so it is closed form.
 */
export function eggRadius(p, u) {
  const low = Math.max(0, -u[1]);
  const s = 1 - p.taper * low * low;
  const n = 2 + (p.square - 2) * low;
  const ax = p.ax * s, ay = u[1] >= 0 ? p.ayUp : p.ayDown, az = (u[2] >= 0 ? p.azF : p.azB) * s;
  const sum = Math.abs(u[0] / ax) ** n + Math.abs(u[1] / ay) ** n + Math.abs(u[2] / az) ** n;
  return sum > 0 ? sum ** (-1 / n) : 0;
}

const eggMap = (p) => {
  const out = new Float32Array(NLAT * NLON);
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) out[i * NLON + j] = eggRadius(p, dirOf(i, j));
  return out;
};

/** The mean gap between two radius maps over the head (metres). */
export function meanGap(A, B) {
  let s = 0, n = 0;
  for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) if (headCell(i, j)) { s += Math.abs(A[i * NLON + j] - B[i * NLON + j]); n++; }
  return n ? s / n : 0;
}

/** The egg closest to a head (least squares over the head's cells, by coordinate search). */
export function fitEgg(R) {
  const at = (lat, lon) => R[((lat + 90) / STEP) * NLON + ((lon + 180) / STEP) % NLON];
  const p = {
    ax: (at(0, 90) + at(0, -90)) / 2, ayUp: at(90, 0), ayDown: at(-75, 0),
    azF: at(0, 0), azB: at(0, -180), taper: 0.2, square: 2,
  };
  const err = (q) => {
    let s = 0;
    for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++)
      if (headCell(i, j)) { const e = eggRadius(q, dirOf(i, j)) - R[i * NLON + j]; s += e * e; }
    return s;
  };
  let best = err(p);
  const keys = ['ax', 'ayUp', 'ayDown', 'azF', 'azB', 'taper', 'square'];
  let step = 0.08;
  for (let it = 0; it < 60 && step > 0.002; it++) {
    let moved = false;
    for (const k of keys) for (const sgn of [1, -1]) {
      const q = { ...p };
      if (k === 'taper') q.taper = Math.min(0.6, Math.max(0, p.taper + sgn * step));
      else if (k === 'square') q.square = Math.min(4, Math.max(2, p.square + sgn * step * 5));
      else q[k] = p[k] * (1 + sgn * step);
      const e = err(q);
      if (e < best) { best = e; Object.assign(p, q); moved = true; }
    }
    if (!moved) step /= 2;
  }
  return p;
}

/** The egg of a preset shape (from the fitted egg). */
export function presetEgg(egg, id) {
  const m = HEAD_PRESETS[id];
  if (!m) return { ...egg };
  const q = { ...egg };
  for (const k of ['ax', 'ayUp', 'ayDown', 'azF', 'azB']) if (m[k]) q[k] = egg[k] * m[k];
  if (m.taperMul != null) q.taper = egg.taper * m.taperMul;
  if (m.taperAdd) q.taper = Math.min(0.6, egg.taper + m.taperAdd);
  if (m.square != null) q.square = m.square;
  return q;
}

const tuneOf = (face, key) => {
  const v = face?.shapes?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : (TUNE[key].def ?? 0);
};
export const headShapeOf = (face) => (HEAD_SHAPE_IDS.includes(face?.headShape) ? face.headShape : HEAD_DEFAULT);

/** True when the head is changed from the base figure's own (a shape picked, or a control moved). */
export function headEdited(face) {
  if (headShapeOf(face) !== HEAD_DEFAULT) return true;
  return HEAD_TUNES.some((t) => Math.abs(tuneOf(face, t.key) - (t.def ?? 0)) > 1e-4);
}

// a soft window around (lat, lon) in degrees (longitude wraps), mirrored left / right when `both`
const windowAt = (lat, lon, cLat, cLon, sLat, sLon, both) => {
  const g = (cl) => { let dl = Math.abs(lon - cl) % 360; if (dl > 180) dl = 360 - dl; return Math.exp(-(((lat - cLat) / sLat) ** 2 + (dl / sLon) ** 2)); };
  return both ? Math.max(g(cLon), g(-cLon)) : g(cLon);
};

/** The radius map of the head the edits ask for (metres). */
export function targetMap(head, face) {
  const egg = eggMap(head.egg);
  const shape = headShapeOf(face);
  const amt = Math.max(0, Math.min(1, tuneOf(face, 'canvas')));
  const preset = HEAD_PRESETS[shape] ? eggMap(presetEgg(head.egg, shape)) : null;
  const v = Object.fromEntries(HEAD_TUNES.map((t) => [t.key, tuneOf(face, t.key)]));
  // the one-way Head Shape (Female) / (Male) and Round Face: lean toward those proportions
  const lean = [['headFemale', 'female'], ['headMale', 'male'], ['faceRound', 'round']]
    .filter(([key]) => v[key] > 1e-4).map(([key, id]) => [v[key], eggMap(presetEgg(head.egg, id))]);
  const A = HEAD_AMOUNTS;
  const out = new Float32Array(NLAT * NLON);
  for (let i = 0; i < NLAT; i++)
    for (let j = 0; j < NLON; j++) {
      const k = i * NLON + j;
      const lat = -90 + i * STEP, lon = -180 + j * STEP;
      const u = dirOf(i, j);
      const own = head.R[k];
      const shaped = shape === 'egg' ? egg[k] : preset ? own * (preset[k] / egg[k]) : own;
      let r = egg[k] + (shaped - egg[k]) * amt;
      for (const [w, m] of lean) r *= (m[k] / egg[k]) ** w;
      // proportions: the radius of the head scaled along an axis, in this direction
      let sx = 1 + A.headWidth * v.headWidth, sy = 1 + A.headHeight * v.headHeight, sz = 1 + A.headDepth * v.headDepth;
      // Chin Slim narrows the lower front of the face
      sx *= 1 - A.chinSlim * v.chinSlim * smooth((-lat - 25) / 30) * smooth((70 - Math.abs(lon)) / 30);
      // Forehead raises or lowers the upper front of the head
      sy *= 1 + A.forehead * v.forehead * windowAt(lat, lon, 40, 0, 25, 50, false);
      r *= Math.hypot(u[0] * sx, u[1] * sy, u[2] * sz);
      r *= 1 + A.cheekbone * v.cheekbone * windowAt(lat, lon, -12, 62, 14, 22, true);
      r *= 1 + A.jawSize * v.jawSize * windowAt(lat, lon, -45, 52, 16, 26, true);
      r *= 1 + A.chinLength * v.chinLength * windowAt(lat, lon, -68, 0, 14, 22, false);
      // under the head the rays run down the neck: there the change fades out (all of it above 45°
      // down, and at the front down under the chin), so the jaw and neck don't fold
      const h = Math.max(smooth((lat + 65) / 20), smooth((lat + 85) / 15) * smooth((45 - Math.abs(lon)) / 20));
      out[k] = own + (r - own) * h;
    }
  return out;
}

/**
 * Everything needed to move points for these edits (cached on the head per edit state):
 * -> null when the head isn't changed; else { K (ratio map), head, key }
 */
export function headField(head, face) {
  if (!head || !headEdited(face)) return null;
  const key = JSON.stringify([headShapeOf(face), ...HEAD_TUNES.map((t) => tuneOf(face, t.key))]);
  if (head._field?.key === key) return head._field;
  const T = targetMap(head, face);
  const K = new Float32Array(T.length);
  for (let k = 0; k < T.length; k++) K[k] = head.R[k] > 1e-6 ? T[k] / head.R[k] : 1;
  const field = { K, T, head, key };
  Object.defineProperty(head, '_field', { value: field, writable: true, configurable: true, enumerable: false });
  return field;
}

/** The ratio map at a head-frame direction (bilinear; longitude wraps). */
export function sampleMap(M, u) {
  const lat = Math.asin(Math.max(-1, Math.min(1, u[1]))) / D2R;
  const lon = Math.atan2(u[0], u[2]) / D2R;
  const fi = Math.max(0, Math.min(NLAT - 1, (lat + 90) / STEP));
  const fj = ((lon + 180) / STEP + NLON) % NLON;
  const i0 = Math.min(NLAT - 2, Math.floor(fi)), j0 = Math.floor(fj) % NLON, j1 = (j0 + 1) % NLON;
  const ti = fi - i0, tj = fj - Math.floor(fj);
  const a = M[i0 * NLON + j0] * (1 - tj) + M[i0 * NLON + j1] * tj;
  const b = M[(i0 + 1) * NLON + j0] * (1 - tj) + M[(i0 + 1) * NLON + j1] * tj;
  return a * (1 - ti) + b * ti;
}

/**
 * How much of the head change a point takes (0 … 1): all of it on the head, none on the neck below
 * the face skin's lowest point (unless it's in front of the neck: the chin), none past 2.2 eye
 * distances from the centre (the shoulders and chest).
 */
export function headWeight(head, x, y, z) {
  const { c, d, f } = head;
  const r = Math.hypot(x - c[0], y - c[1], z - c[2]);
  const gate = smooth((2.2 * d - r) / (0.4 * d));
  if (gate <= 0) return 0;
  const up = smooth((y - head.yNeck) / (0.35 * d));
  // (in front of the neck: under the chin, which hangs below the face skin's lowest point at the back)
  const front = smooth((z * f - head.zNeck) / (0.25 * d)) * smooth((y - head.yNeck + 0.15 * d) / (0.15 * d));
  return gate * Math.max(up, front);
}

/** Move one point (model space) for the field -> [x, y, z]. weight: headWeight unless given. */
export function movePoint(field, p, weight) {
  const { head, K } = field;
  const { c, f } = head;
  const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const r = Math.hypot(v[0], v[1], v[2]);
  if (r < 1e-9) return p.slice();
  const w = weight ?? headWeight(head, p[0], p[1], p[2]);
  if (w <= 0) return p.slice();
  const k = 1 + (sampleMap(K, [v[0] / r, v[1] / r, (v[2] * f) / r]) - 1) * w;
  return [c[0] + v[0] * k, c[1] + v[1] * k, c[2] + v[2] * k];
}

/** Move every point of a positions array in place. */
export function moveHead(field, out) {
  const { head } = field;
  const { c, d } = head;
  const reach2 = (2.2 * d) ** 2;
  for (let i = 0; i < out.length; i += 3) {
    const dx = out[i] - c[0], dy = out[i + 1] - c[1], dz = out[i + 2] - c[2];
    if (dx * dx + dy * dy + dz * dz >= reach2) continue;
    const q = movePoint(field, [out[i], out[i + 1], out[i + 2]]);
    out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
  }
  return out;
}

/**
 * The head canvas as a mesh (for showing it): the target surface on the grid, down to the chin.
 * -> { positions, indices } in model space
 */
export function canvasMesh(head, face, latMin = -75) {
  const T = (headField(head, face)?.T) || targetMap(head, { ...face, headShape: 'spec', shapes: {} });
  const { c, f } = head;
  const i0 = (latMin + 90) / STEP;
  const positions = [], indices = [];
  for (let i = i0; i < NLAT; i++)
    for (let j = 0; j < NLON; j++) {
      const u = dirOf(i, j), r = T[i * NLON + j];
      positions.push(c[0] + u[0] * r, c[1] + u[1] * r, c[2] + u[2] * f * r);
    }
  const rows = NLAT - i0;
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < NLON; j++) {
      const a = i * NLON + j, b = i * NLON + ((j + 1) % NLON), c2 = a + NLON, d2 = b + NLON;
      // only the head itself (not the rays running down the neck)
      const j1 = (j + 1) % NLON;
      if (![[i, j], [i, j1], [i + 1, j], [i + 1, j1]].every(([ii, jj]) => headCell(ii + i0, jj))) continue;
      indices.push(a, b, c2, b, d2, c2);
    }
  return { positions, indices };
}

/** How far the head asked for is from the base figure's own head, on average (millimetres). */
export function gapToBase(head, face) {
  const field = headField(head, face);
  return field ? meanGap(field.T, head.R) * 1000 : 0;
}
