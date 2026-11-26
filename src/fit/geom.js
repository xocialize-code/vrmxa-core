// Geometry for Spec-fit (FITTING.md §5.5, §8): a uniform grid over triangles, the nearest point on a
// skin with its signed distance, short rays against a garment, welds and neighbours. DOM-free, plain
// typed arrays, no three.js: the browser and Node run the same arithmetic.

/** Vertex normals of a triangle mesh (area-weighted face normals, normalised). → Float32Array */
export function vertexNormals(verts, tris) {
  const n = new Float32Array(verts.length);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2];
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/**
 * A uniform grid over triangles (flat index list), for nearest-point queries and short rays.
 * cell: edge length in metres. → { cell, min, dims, cells: Map(key → Int32Array of triangle numbers) }
 */
export function triangleGrid(verts, tris, cell = 0.015) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!Number.isFinite(x0)) { x0 = y0 = z0 = x1 = y1 = z1 = 0; }
  const min = [x0 - cell, y0 - cell, z0 - cell];
  const dims = [Math.max(1, Math.ceil((x1 + cell - min[0]) / cell)), Math.max(1, Math.ceil((y1 + cell - min[1]) / cell)), Math.max(1, Math.ceil((z1 + cell - min[2]) / cell))];
  const key = (x, y, z) => (x * dims[1] + y) * dims[2] + z;
  const nt = tris.length / 3;
  const span = new Int32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k] * 3, x = verts[v], y = verts[v + 1], z = verts[v + 2];
      if (x < lx) lx = x; if (x > hx) hx = x; if (y < ly) ly = y; if (y > hy) hy = y; if (z < lz) lz = z; if (z > hz) hz = z;
    }
    span[t * 6] = Math.floor((lx - min[0]) / cell); span[t * 6 + 1] = Math.floor((ly - min[1]) / cell); span[t * 6 + 2] = Math.floor((lz - min[2]) / cell);
    span[t * 6 + 3] = Math.floor((hx - min[0]) / cell); span[t * 6 + 4] = Math.floor((hy - min[1]) / cell); span[t * 6 + 5] = Math.floor((hz - min[2]) / cell);
  }
  const total = dims[0] * dims[1] * dims[2];
  if (total <= 4e6) {
    // dense: a count per cell, then one array of triangle numbers (counting sort)
    const start = new Int32Array(total + 1);
    for (let t = 0; t < nt; t++) for (let x = span[t * 6]; x <= span[t * 6 + 3]; x++) for (let y = span[t * 6 + 1]; y <= span[t * 6 + 4]; y++) for (let z = span[t * 6 + 2]; z <= span[t * 6 + 5]; z++) start[key(x, y, z) + 1]++;
    for (let c = 0; c < total; c++) start[c + 1] += start[c];
    const fill = start.slice(0, total);
    const list = new Int32Array(start[total]);
    for (let t = 0; t < nt; t++) for (let x = span[t * 6]; x <= span[t * 6 + 3]; x++) for (let y = span[t * 6 + 1]; y <= span[t * 6 + 4]; y++) for (let z = span[t * 6 + 2]; z <= span[t * 6 + 5]; z++) list[fill[key(x, y, z)]++] = t;
    return { cell, min, dims, key, start, list, stamp: new Int32Array(nt), tick: 0 };
  }
  const lists = new Map();
  for (let t = 0; t < nt; t++) for (let x = span[t * 6]; x <= span[t * 6 + 3]; x++) for (let y = span[t * 6 + 1]; y <= span[t * 6 + 4]; y++) for (let z = span[t * 6 + 2]; z <= span[t * 6 + 5]; z++) {
    const k = key(x, y, z);
    let l = lists.get(k);
    if (!l) lists.set(k, (l = []));
    l.push(t);
  }
  const cells = new Map();
  for (const [k, l] of lists) cells.set(k, Int32Array.from(l));
  return { cell, min, dims, cells, key, stamp: new Int32Array(nt), tick: 0 };
}

// the triangles of one cell: [array, from, to)
function cellRange(grid, k) {
  if (grid.start) return [grid.list, grid.start[k], grid.start[k + 1]];
  const l = grid.cells.get(k);
  return l ? [l, 0, l.length] : null;
}

// the closest point on triangle (a, b, c) to p (Ericson, Real-Time Collision Detection 5.1.5):
// → squared distance; out gets [x, y, z, u, v, w] (barycentrics of a, b, c)
function closestOnTriangle(p, A, B, C, out) {
  const abx = B[0] - A[0], aby = B[1] - A[1], abz = B[2] - A[2];
  const acx = C[0] - A[0], acy = C[1] - A[1], acz = C[2] - A[2];
  const apx = p[0] - A[0], apy = p[1] - A[1], apz = p[2] - A[2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else {
    const bpx = p[0] - B[0], bpy = p[1] - B[1], bpz = p[2] - B[2];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
      else {
        const cpx = p[0] - C[0], cpy = p[1] - C[1], cpz = p[2] - C[2];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; }
            else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; }
          }
        }
      }
    }
  }
  const x = u * A[0] + v * B[0] + w * C[0], y = u * A[1] + v * B[1] + w * C[1], z = u * A[2] + v * B[2] + w * C[2];
  out[0] = x; out[1] = y; out[2] = z; out[3] = u; out[4] = v; out[5] = w;
  return (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
}

/**
 * A surface for nearest-point queries: { verts, normals, tris (flat), grid }. Signed distance is
 * positive outside (on the side the interpolated vertex normal points to).
 */
export function makeSurface(verts, tris, { normals = null, cell = 0.015 } = {}) {
  const flat = tris instanceof Int32Array || tris instanceof Uint32Array ? tris : Int32Array.from(tris.flat ? tris.flat() : tris);
  return { verts, tris: flat, normals: normals || vertexNormals(verts, flat), grid: triangleGrid(verts, flat, cell) };
}

const A3 = [0, 0, 0], B3 = [0, 0, 0], C3 = [0, 0, 0], OUT = [0, 0, 0, 0, 0, 0];

/**
 * The nearest point of a surface to p within `radius` (metres). → null when nothing is that close, else
 * { d (signed: + outside), q: [x, y, z], n: [x, y, z] (interpolated normal at q), tri }
 */
export function nearest(surface, p, radius = 0.015, out = null) {
  const { grid, verts, tris, normals } = surface;
  // only the cells the search sphere's box touches
  const lx = Math.max(0, Math.floor((p[0] - radius - grid.min[0]) / grid.cell)), hx = Math.min(grid.dims[0] - 1, Math.floor((p[0] + radius - grid.min[0]) / grid.cell));
  const ly = Math.max(0, Math.floor((p[1] - radius - grid.min[1]) / grid.cell)), hy = Math.min(grid.dims[1] - 1, Math.floor((p[1] + radius - grid.min[1]) / grid.cell));
  const lz = Math.max(0, Math.floor((p[2] - radius - grid.min[2]) / grid.cell)), hz = Math.min(grid.dims[2] - 1, Math.floor((p[2] + radius - grid.min[2]) / grid.cell));
  let best = radius * radius, bt = -1;
  let q0 = 0, q1 = 0, q2 = 0, b0 = 0, b1 = 0, b2 = 0;
  const stamp = grid.stamp, tick = ++grid.tick;
  for (let x = lx; x <= hx; x++) for (let y = ly; y <= hy; y++) for (let z = lz; z <= hz; z++) {
    const r = cellRange(grid, grid.key(x, y, z));
    if (!r) continue;
    const [list, from, to] = r;
    for (let k = from; k < to; k++) {
      const t = list[k];
      if (stamp[t] === tick) continue;
      stamp[t] = tick;
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, cc = tris[t * 3 + 2] * 3;
      A3[0] = verts[a]; A3[1] = verts[a + 1]; A3[2] = verts[a + 2];
      B3[0] = verts[b]; B3[1] = verts[b + 1]; B3[2] = verts[b + 2];
      C3[0] = verts[cc]; C3[1] = verts[cc + 1]; C3[2] = verts[cc + 2];
      const d2 = closestOnTriangle(p, A3, B3, C3, OUT);
      if (d2 < best) { best = d2; bt = t; q0 = OUT[0]; q1 = OUT[1]; q2 = OUT[2]; b0 = OUT[3]; b1 = OUT[4]; b2 = OUT[5]; }
    }
  }
  if (bt < 0) return null;
  const a = tris[bt * 3] * 3, b = tris[bt * 3 + 1] * 3, cc = tris[bt * 3 + 2] * 3;
  let n0 = b0 * normals[a] + b1 * normals[b] + b2 * normals[cc];
  let n1 = b0 * normals[a + 1] + b1 * normals[b + 1] + b2 * normals[cc + 1];
  let n2 = b0 * normals[a + 2] + b1 * normals[b + 2] + b2 * normals[cc + 2];
  const l = Math.hypot(n0, n1, n2) || 1;
  n0 /= l; n1 /= l; n2 /= l;
  const dist = Math.sqrt(best);
  const sign = (p[0] - q0) * n0 + (p[1] - q1) * n1 + (p[2] - q2) * n2 >= 0 ? 1 : -1;
  const o = out || { d: 0, q: [0, 0, 0], n: [0, 0, 0], tri: 0, bary: [0, 0, 0] };
  o.d = sign * dist; o.q[0] = q0; o.q[1] = q1; o.q[2] = q2; o.n[0] = n0; o.n[1] = n1; o.n[2] = n2; o.tri = bt; o.bary[0] = b0; o.bary[1] = b1; o.bary[2] = b2;
  return o;
}

/**
 * The first hit of the segment o → o + dir · maxT on a triangle grid (Möller–Trumbore, both faces).
 * → the distance along dir, or Infinity.
 */
export function rayHit(surface, o, dir, maxT) {
  const h = rayTriangle(surface, o, dir, maxT);
  return h ? h.t : Infinity;
}

/** The first hit of a short ray, with its triangle. → { t, tri } or null */
export function rayTriangle(surface, o, dir, maxT) {
  const { grid, verts, tris } = surface;
  const lo = [0, 1, 2].map((a) => Math.floor((Math.min(o[a], o[a] + dir[a] * maxT) - grid.min[a]) / grid.cell));
  const hi = [0, 1, 2].map((a) => Math.floor((Math.max(o[a], o[a] + dir[a] * maxT) - grid.min[a]) / grid.cell));
  let best = maxT, bt = -1;
  let hit = false;
  const stamp = grid.stamp, tick = ++grid.tick;
  for (let x = Math.max(0, lo[0]); x <= Math.min(grid.dims[0] - 1, hi[0]); x++)
    for (let y = Math.max(0, lo[1]); y <= Math.min(grid.dims[1] - 1, hi[1]); y++)
      for (let z = Math.max(0, lo[2]); z <= Math.min(grid.dims[2] - 1, hi[2]); z++) {
        const range = cellRange(grid, grid.key(x, y, z));
        if (!range) continue;
        const [list, from, to] = range;
        for (let k = from; k < to; k++) {
          const t = list[k];
          if (stamp[t] === tick) continue;
          stamp[t] = tick;
          const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
          const e1x = verts[b] - verts[a], e1y = verts[b + 1] - verts[a + 1], e1z = verts[b + 2] - verts[a + 2];
          const e2x = verts[c] - verts[a], e2y = verts[c + 1] - verts[a + 1], e2z = verts[c + 2] - verts[a + 2];
          const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-14) continue;
          const inv = 1 / det;
          const tx = o[0] - verts[a], ty = o[1] - verts[a + 1], tz = o[2] - verts[a + 2];
          const u = (tx * px + ty * py + tz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
          const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (d > 1e-7 && d < best) { best = d; hit = true; bt = t; }
        }
      }
  return hit ? { t: best, tri: bt } : null;
}

/**
 * Weld groups: vertices at the same position (to `tol` metres) share a group. → { group: Int32Array
 * (vertex → group), count, first: Int32Array (group → one vertex) }
 */
export function weldGroups(pos, tol = 1e-6) {
  const n = pos.length / 3;
  const group = new Int32Array(n);
  const map = new Map(); // (x, y) cell → [z cell, group, …]
  const first = [];
  const q = 1 / tol;
  for (let i = 0; i < n; i++) {
    const kx = Math.round(pos[i * 3] * q), ky = Math.round(pos[i * 3 + 1] * q), kz = Math.round(pos[i * 3 + 2] * q);
    const key = kx * 8388608 + ky; // |ky| < 2^22 µm: within ±4 m
    let list = map.get(key);
    let g = -1;
    if (list) { for (let j = 0; j < list.length; j += 2) if (list[j] === kz) { g = list[j + 1]; break; } }
    else map.set(key, (list = []));
    if (g < 0) { g = first.length; first.push(i); list.push(kz, g); }
    group[i] = g;
  }
  return { group, count: first.length, first: Int32Array.from(first) };
}

/** Neighbours of each weld group from triangles (flat vertex indices), as compact lists. → Array of Int32Array */
export function groupNeighbours(tris, group, count) {
  const deg = new Int32Array(count);
  const edges = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const g = [group[tris[t]], group[tris[t + 1]], group[tris[t + 2]]];
    for (let k = 0; k < 3; k++) { const a = g[k], b = g[(k + 1) % 3]; if (a !== b) { edges.push(a, b); deg[a]++; deg[b]++; } }
  }
  const out = Array.from({ length: count }, (_, i) => new Int32Array(deg[i]));
  const fill = new Int32Array(count);
  for (let e = 0; e < edges.length; e += 2) { const a = edges[e], b = edges[e + 1]; out[a][fill[a]++] = b; out[b][fill[b]++] = a; }
  return out; // an edge shared by two triangles is listed twice, alike for every interior neighbour
}

/** Boundary (hem) groups: groups on an edge used by one triangle only. → Uint8Array (1 = on a hem) */
export function boundaryGroups(tris, group, count = null) {
  const G = count ?? (Math.max(0, ...group) + 1);
  const seen = new Map();
  for (let t = 0; t + 2 < tris.length; t += 3) {
    const g = [group[tris[t]], group[tris[t + 1]], group[tris[t + 2]]];
    for (let k = 0; k < 3; k++) {
      const a = g[k], b = g[(k + 1) % 3];
      if (a === b) continue;
      const key = a < b ? a * G + b : b * G + a;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  }
  const out = new Uint8Array(G);
  for (const [k, c] of seen) if (c === 1) { out[Math.floor(k / G)] = 1; out[k % G] = 1; }
  return out;
}
