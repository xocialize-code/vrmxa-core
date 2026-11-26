// Hair > Design: hair drawn on the head, stroke by stroke, in groups of strands.
// DOM-free (the strand mesh is built here, so tests can run it under Node).
//
// A design is a list of hair groups. Each group has Hair Parameters (shared by its strands), a
// Material (colour and texture parameters) and strands; a strand is the stroke as drawn, a list of
// points in the head bone's own space (so it follows the head, its size and its motions). The
// parameters, their ranges and the mesh are this library's own.
// The design is part of the avatar edits (edits.json `hairDesign`), so a .vrmxa keeps it.

// The strand's cross section, by name (EDITS.md §6), simplest first.
export const CROSS_SECTIONS = ['Flat', 'Diamond', 'Triangle', 'Bottomless Triangle'];

export const HAIR_PARAMS = [
  { key: 'posX', label: 'Position (X)', min: -0.03, max: 0.03, step: 0.001, def: 0 },
  { key: 'posY', label: 'Position (Y)', min: -0.03, max: 0.03, step: 0.001, def: 0 },
  { key: 'width', label: 'Width', min: 0.004, max: 0.06, step: 0.001, def: 0.018 },
  { key: 'thickness', label: 'Thickness', min: 0, max: 0.02, step: 0.0005, def: 0.004 },
  { key: 'tip', label: 'Tip Width', min: 0, max: 1, step: 0.01, def: 0.15 },
  { key: 'twist', label: 'Twist Intensity', min: -1, max: 1, step: 0.01, def: 0 },
  { key: 'twistAt', label: 'Twist Placement', min: 0, max: 1, step: 0.01, def: 0.5 },
  { key: 'smooth', label: 'Smoothness', min: 4, max: 40, step: 1, def: 20 },
  { key: 'lift', label: 'Lift from Head', min: 0, max: 0.02, step: 0.0005, def: 0.003 },
  { key: 'bounce', label: 'Bounce', min: 0, max: 1, step: 0.01, def: 0.35 },
  { key: 'gravity', label: 'Gravity', min: 0, max: 1, step: 0.01, def: 0.3 },
];
export const TEXTURE_PARAMS = [
  { key: 'texWidth', label: 'Width', min: 1, max: 8, step: 0.1, def: 3 },
  { key: 'highlight', label: 'Highlights Position', min: 0, max: 1, step: 0.01, def: 0.3 },
  { key: 'offset', label: 'Offset', min: 0, max: 1, step: 0.01, def: 0 },
];
const ALL = Object.fromEntries([...HAIR_PARAMS, ...TEXTURE_PARAMS].map((p) => [p.key, p]));

export const MAX_GROUPS = 32;
export const MAX_STRANDS = 300;
export const MAX_POINTS = 96;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const paramOf = (group, key) => (finite(group?.params?.[key]) ? group.params[key] : ALL[key].def);

export const newGroup = (n = 1) => ({
  id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
  name: `Freehand Group ${n}`,
  cross: 'Flat',
  color: [0.42, 0.62, 0.92],
  params: {},
  strands: [],
});

export const designEdited = (d) => !!d?.groups?.some((g) => g.strands?.length);

/** A design from a document: known fields only, values clamped, sizes bounded. -> { design, ignored } */
export function cleanDesign(src) {
  const ignored = [];
  const groups = [];
  for (const g of (src?.groups || []).slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== 'object') { ignored.push('group'); continue; }
    const params = {};
    for (const [k, v] of Object.entries(g.params || {})) {
      if (ALL[k] && finite(v)) params[k] = clamp(v, ALL[k].min, ALL[k].max);
      else ignored.push(`params.${k}`);
    }
    const strands = [];
    for (const s of g.strands || []) {
      const pts = (s?.points || []).filter((p) => Array.isArray(p) && p.length === 3 && p.every(finite)).slice(0, MAX_POINTS)
        .map((p) => p.map((v) => clamp(v, -1, 1)));
      if (pts.length >= 2 && strands.length < MAX_STRANDS) strands.push({ points: pts });
    }
    const color = Array.isArray(g.color) && g.color.length === 3 && g.color.every(finite) ? g.color.map((v) => clamp(v, 0, 1)) : [0.42, 0.62, 0.92];
    groups.push({
      id: typeof g.id === 'string' ? g.id.slice(0, 40) : newGroup().id,
      name: typeof g.name === 'string' ? g.name.slice(0, 60) : `Freehand Group ${groups.length + 1}`,
      cross: CROSS_SECTIONS.includes(g.cross) ? g.cross : 'Flat',
      color, params, strands,
    });
  }
  return { design: { groups }, ignored };
}

// ---- geometry -----------------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mulS = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Thin a raw stroke: drop points closer than `minGap` to the last kept one. */
export function thinStroke(points, minGap = 0.002) {
  const out = [];
  for (const p of points) if (!out.length || Math.hypot(...sub(p, out[out.length - 1])) >= minGap) out.push(p);
  return out;
}

/** The stroke smoothed (Catmull-Rom) and resampled to `n` points evenly along its length. */
export function smoothStroke(points, n) {
  if (points.length < 2) return points.slice();
  // dense Catmull-Rom
  const dense = [];
  const P = (i) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 0; s < 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      dense.push([0, 1, 2].map((c) => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  dense.push(points[points.length - 1]);
  const len = [0];
  for (let i = 1; i < dense.length; i++) len.push(len[i - 1] + Math.hypot(...sub(dense[i], dense[i - 1])));
  const total = len[len.length - 1] || 1;
  const out = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (j < dense.length - 1 && len[j] < target) j++;
    const a = dense[j - 1], b = dense[j];
    const seg = len[j] - len[j - 1] || 1;
    const t = Math.max(0, Math.min(1, (target - len[j - 1]) / seg));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

// cross-section outlines in (across, out) units, a closed loop (or open for Flat)
function outline(kind) {
  switch (kind) {
    case 'Diamond': return { pts: [[-0.5, 0], [0, 0.5], [0.5, 0], [0, -0.5]], closed: true };
    case 'Triangle': return { pts: [[-0.5, -0.3], [0, 0.6], [0.5, -0.3]], closed: true };
    // a triangle with no bottom face: the two upper sides only
    case 'Bottomless Triangle': return { pts: [[-0.5, -0.3], [0, 0.6], [0.5, -0.3]], closed: false };
    default: return { pts: [[-0.5, 0], [0.5, 0]], closed: false };
  }
}

/**
 * The mesh of one strand. path: the strand's points (head space, already smoothed); centre: the
 * head's middle (for the "outward" direction); group: the group (params, cross section).
 * -> { positions, normals, uvs, indices } (plain arrays)
 */
export function strandMesh(path, centre, group) {
  const n = path.length;
  const width = paramOf(group, 'width'), thick = paramOf(group, 'thickness'), tip = paramOf(group, 'tip');
  const twist = paramOf(group, 'twist'), twistAt = paramOf(group, 'twistAt'), lift = paramOf(group, 'lift');
  const shift = [paramOf(group, 'posX'), paramOf(group, 'posY'), 0];
  const { pts: sec, closed } = outline(group.cross);
  const ring = sec.length;
  const positions = [], normals = [], uvs = [], indices = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const T = norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)]));
    let out = sub(path[i], centre);
    out = norm(sub(out, mulS(T, dot(out, T)))); // outward, square to the strand
    const across = norm(cross(T, out));
    // twist about the strand, strongest past the placement point
    const ang = twist * Math.PI * Math.max(0, (t - twistAt) / Math.max(1e-3, 1 - twistAt)) * 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    const A = add(mulS(across, c), mulS(out, s)), O = add(mulS(out, c), mulS(across, -s));
    const w = width * (1 - (1 - tip) * Math.pow(t, 1.3));
    const th = thick * (1 - (1 - tip) * Math.pow(t, 1.3));
    const base = add(add(path[i], shift), mulS(out, lift));
    for (let k = 0; k < ring; k++) {
      const [u, v] = sec[k];
      positions.push(...add(base, add(mulS(A, u * w), mulS(O, v * th + (closed ? 0 : 0)))));
      normals.push(...norm(ring === 2 ? O : add(mulS(A, u), mulS(O, v))));
      uvs.push(ring === 2 ? k : k / ring, t);
    }
  }
  const segs = closed ? ring : ring - 1;
  for (let i = 0; i < n - 1; i++)
    for (let k = 0; k < segs; k++) {
      const a = i * ring + k, b = i * ring + ((k + 1) % ring), c2 = a + ring, d = b + ring;
      indices.push(a, c2, b, b, c2, d);
    }
  return { positions, normals, uvs, indices };
}

/**
 * Every group's strands as one mesh each, in head space: [{ group, positions, normals, uvs, indices }].
 * centre: the head's middle in head space (the "outward" direction). Groups without strands are left out.
 */
export function hairDesignMesh(design, centre, paths = null) {
  const out = [];
  (design?.groups || []).forEach((group, gi) => {
    if (!group.strands?.length) return;
    const n = Math.round(paramOf(group, 'smooth'));
    const parts = group.strands.map((s, si) => strandMesh(paths?.[gi]?.[si] || smoothStroke(s.points, n), centre, group));
    const positions = [], normals = [], uvs = [], indices = [];
    for (const p of parts) {
      const v = positions.length / 3;
      positions.push(...p.positions); normals.push(...p.normals); uvs.push(...p.uvs);
      for (const i of p.indices) indices.push(i + v);
    }
    out.push({ group, positions, normals, uvs, indices });
  });
  return out;
}
