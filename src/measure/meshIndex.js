// Deterministic surface tools shared by the skin check (donorParts.js / skinCheck.js) and Match a Donor
// Face (edit/headMatch.js): a bounding-volume hierarchy over triangles for nearest-point and ray
// queries, area-weighted stratified surface sampling, a uniform grid over points, and a few small
// trig-free helpers. DOM-free.
//
// Every value these produce is computed with + − × ÷ and Math.sqrt only, which ECMAScript rounds
// exactly, in a fixed order with index tie-breaks, so a browser and Node give the same bits. No
// Math.sin / cos / exp / pow / hypot / random, no `**`, and every sort carries an index tie-break.
//
// Methods: the hierarchy is a median-split BVH over triangle centroids; the closest point on a
// triangle follows Ericson, Real-Time Collision Detection (2005) §5.1.5; rays use Möller & Trumbore,
// "Fast, minimum storage ray-triangle intersection" (1997); sample positions inside a triangle come
// from the R2 low-discrepancy sequence (the generalised golden ratio in two dimensions, the plastic
// number: Roberts, "The unreasonable effectiveness of quasirandom sequences", 2018), folded into the
// triangle by reflection.

const LEAF = 8;

/**
 * A BVH over triangles. verts: flat xyz (any numeric array); tris: flat vertex indices.
 * Nodes are stored flat: box (6 floats) and either two children or a range of the sorted triangle list.
 */
export class TriangleIndex {
  constructor(verts, tris) {
    this.verts = Float64Array.from(verts);
    this.tris = Int32Array.from(tris);
    const nt = this.tris.length / 3;
    this.count = nt;
    const cx = new Float64Array(nt), cy = new Float64Array(nt), cz = new Float64Array(nt);
    const V = this.verts, T = this.tris;
    for (let t = 0; t < nt; t++) {
      const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
      cx[t] = (V[a] + V[b] + V[c]) / 3; cy[t] = (V[a + 1] + V[b + 1] + V[c + 1]) / 3; cz[t] = (V[a + 2] + V[b + 2] + V[c + 2]) / 3;
    }
    const order = new Int32Array(nt);
    for (let t = 0; t < nt; t++) order[t] = t;
    this.order = order;
    // flat node arrays (grown as needed)
    this.box = [];  // 6 per node
    this.left = []; this.right = []; this.from = []; this.to = [];
    if (nt) this._build(0, nt, [cx, cy, cz]);
  }

  _boxOf(from, to) {
    const V = this.verts, T = this.tris, O = this.order;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = from; k < to; k++) {
      const t = O[k];
      for (let j = 0; j < 3; j++) {
        const v = T[t * 3 + j] * 3, x = V[v], y = V[v + 1], z = V[v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
    }
    return [x0, y0, z0, x1, y1, z1];
  }

  _build(from, to, C) {
    const id = this.left.length;
    const b = this._boxOf(from, to);
    this.box.push(...b);
    this.left.push(-1); this.right.push(-1); this.from.push(from); this.to.push(to);
    if (to - from <= LEAF) return id;
    // split on the longest axis of the centroids' box, at the median (sorted by centroid, then index)
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = from; k < to; k++) {
      const t = this.order[k];
      for (let a = 0; a < 3; a++) { const v = C[a][t]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
    }
    let axis = 0;
    if (hi[1] - lo[1] > hi[axis] - lo[axis]) axis = 1;
    if (hi[2] - lo[2] > hi[axis] - lo[axis]) axis = 2;
    const key = C[axis];
    const part = Array.from(this.order.subarray(from, to));
    part.sort((p, q) => (key[p] - key[q]) || (p - q));
    this.order.set(part, from);
    const mid = (from + to) >> 1;
    this.left[id] = this._build(from, mid, C);
    this.right[id] = this._build(mid, to, C);
    return id;
  }

  /** The triangle's corners → [ax, ay, az, bx, …] (a fresh array). */
  corners(t) {
    const V = this.verts, T = this.tris, a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    return [V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]];
  }

  /** The unit normal of a triangle by its winding (counter-clockwise front, as glTF), or [0, 0, 0]. */
  normal(t) {
    const p = this.corners(t);
    return faceNormal(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
  }

  /**
   * The closest point of the surface to (x, y, z) no farther than sqrt(max2).
   * → null, or { d2, tri, x, y, z, u, v, w } (u, v, w: barycentrics of the triangle's corners).
   * Ties (equal squared distance) go to the lower triangle number.
   */
  closest(x, y, z, max2 = Infinity) {
    if (!this.count) return null;
    let best = max2, bt = -1, bx = 0, by = 0, bz = 0, bu = 0, bv = 0, bw = 0;
    const out = [0, 0, 0, 0, 0, 0];
    const stack = [0];
    const B = this.box;
    while (stack.length) {
      const n = stack.pop();
      const o = n * 6;
      const dx = x < B[o] ? B[o] - x : x > B[o + 3] ? x - B[o + 3] : 0;
      const dy = y < B[o + 1] ? B[o + 1] - y : y > B[o + 4] ? y - B[o + 4] : 0;
      const dz = z < B[o + 2] ? B[o + 2] - z : z > B[o + 5] ? z - B[o + 5] : 0;
      if (dx * dx + dy * dy + dz * dz > best) continue;
      const l = this.left[n];
      if (l < 0) {
        for (let k = this.from[n]; k < this.to[n]; k++) {
          const t = this.order[k];
          const c = this.corners(t);
          const d2 = closestOnTriangle(x, y, z, c, out);
          if (d2 < best || (d2 === best && bt >= 0 && t < bt)) {
            best = d2; bt = t; bx = out[0]; by = out[1]; bz = out[2]; bu = out[3]; bv = out[4]; bw = out[5];
          }
        }
        continue;
      }
      // visit the nearer child first (pushed last); the order changes only speed, not the answer
      const r = this.right[n];
      const dl = boxDist2(B, l * 6, x, y, z), dr = boxDist2(B, r * 6, x, y, z);
      if (dl <= dr) { stack.push(r, l); } else { stack.push(l, r); }
    }
    if (bt < 0) return null;
    return { d2: best, tri: bt, x: bx, y: by, z: bz, u: bu, v: bv, w: bw };
  }

  /**
   * The first hit of the ray o + t·dir for t in (tMin, tMax], both faces. → null or { t, tri }.
   * Ties go to the lower triangle number. `skip(tri)` (optional) leaves triangles out.
   */
  ray(ox, oy, oz, dx, dy, dz, tMin, tMax, skip = null) {
    if (!this.count) return null;
    let best = tMax, bt = -1;
    const B = this.box, V = this.verts, T = this.tris;
    const stack = [0];
    while (stack.length) {
      const n = stack.pop();
      if (!rayBox(B, n * 6, ox, oy, oz, dx, dy, dz, tMin, best)) continue;
      const l = this.left[n];
      if (l >= 0) { stack.push(this.right[n], l); continue; }
      for (let k = this.from[n]; k < this.to[n]; k++) {
        const t = this.order[k];
        if (skip && skip(t)) continue;
        const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
        const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
        const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det > -1e-18 && det < 1e-18) continue;
        const inv = 1 / det;
        const tx = ox - V[a], ty = oy - V[a + 1], tz = oz - V[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d <= tMin) continue;
        if (d < best || (d === best && bt >= 0 && t < bt)) { best = d; bt = t; }
      }
    }
    return bt < 0 ? null : { t: best, tri: bt };
  }
}

function boxDist2(B, o, x, y, z) {
  const dx = x < B[o] ? B[o] - x : x > B[o + 3] ? x - B[o + 3] : 0;
  const dy = y < B[o + 1] ? B[o + 1] - y : y > B[o + 4] ? y - B[o + 4] : 0;
  const dz = z < B[o + 2] ? B[o + 2] - z : z > B[o + 5] ? z - B[o + 5] : 0;
  return dx * dx + dy * dy + dz * dz;
}

// slab test: does the ray meet the box for some t in [tMin, tMax]?
function rayBox(B, o, ox, oy, oz, dx, dy, dz, tMin, tMax) {
  let t0 = tMin, t1 = tMax;
  const O = [ox, oy, oz], D = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    const lo = B[o + a], hi = B[o + 3 + a];
    if (D[a] === 0) { if (O[a] < lo || O[a] > hi) return false; continue; }
    let ta = (lo - O[a]) / D[a], tb = (hi - O[a]) / D[a];
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/** Unit normal of the triangle (a, b, c), counter-clockwise front; [0, 0, 0] when degenerate. */
export function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

/** The area of triangle (a, b, c). */
export function triangleArea(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
}

// the closest point on triangle c = [a, b, c corners] to p (Ericson 2005, §5.1.5)
// → squared distance; out = [x, y, z, u, v, w]
function closestOnTriangle(px, py, pz, c, out) {
  const ax = c[0], ay = c[1], az = c[2], bx = c[3], by = c[4], bz = c[5], cx = c[6], cy = c[7], cz = c[8];
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v, w;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; } else {
              const den = va + vb + vc;
              if (den === 0) { u = 1; v = 0; w = 0; } else { v = vb / den; w = vc / den; u = 1 - v - w; }
            }
          }
        }
      }
    }
  }
  const x = u * ax + v * bx + w * cx, y = u * ay + v * by + w * cy, z = u * az + v * bz + w * cz;
  out[0] = x; out[1] = y; out[2] = z; out[3] = u; out[4] = v; out[5] = w;
  const ex = px - x, ey = py - y, ez = pz - z;
  return ex * ex + ey * ey + ez * ez;
}

// R2 sequence constants: 1/g and 1/g², g the plastic number (the real root of x³ = x + 1)
const R2A = 0.7548776662466927, R2B = 0.5698402909980532;
const frac = (x) => x - Math.floor(x);

/**
 * Area-weighted stratified samples of a set of triangles, in a fixed order: triangle t
 * takes floor(A_t·density + carry) samples and the fractional rest carries to the next triangle, so the
 * total is exact and the order defined; the k-th sample overall sits at the k-th point of the R2
 * sequence, folded into its triangle. verts: flat xyz; tris: flat indices.
 * → { x, y, z, nx, ny, nz (Float64Array), tri (Int32Array: triangle number), count }
 */
export function sampleSurface(verts, tris, density) {
  const nt = tris.length / 3;
  const counts = new Int32Array(nt);
  let carry = 0, total = 0;
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const want = triangleArea(verts[a], verts[a + 1], verts[a + 2], verts[b], verts[b + 1], verts[b + 2], verts[c], verts[c + 1], verts[c + 2]) * density + carry;
    const n = Math.floor(want);
    carry = want - n;
    counts[t] = n; total += n;
  }
  const out = {
    x: new Float64Array(total), y: new Float64Array(total), z: new Float64Array(total),
    nx: new Float64Array(total), ny: new Float64Array(total), nz: new Float64Array(total), tri: new Int32Array(total), count: total,
  };
  let k = 0;
  for (let t = 0; t < nt; t++) {
    if (!counts[t]) continue;
    const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const ux = verts[b] - ax, uy = verts[b + 1] - ay, uz = verts[b + 2] - az;
    const vx = verts[c] - ax, vy = verts[c + 1] - ay, vz = verts[c + 2] - az;
    const n = faceNormal(ax, ay, az, verts[b], verts[b + 1], verts[b + 2], verts[c], verts[c + 1], verts[c + 2]);
    for (let j = 0; j < counts[t]; j++, k++) {
      let s = frac(0.5 + (k + 1) * R2A), r = frac(0.5 + (k + 1) * R2B);
      if (s + r > 1) { s = 1 - s; r = 1 - r; }
      out.x[k] = ax + s * ux + r * vx; out.y[k] = ay + s * uy + r * vy; out.z[k] = az + s * uz + r * vz;
      out.nx[k] = n[0]; out.ny[k] = n[1]; out.nz[k] = n[2]; out.tri[k] = t;
    }
  }
  return out;
}

/**
 * A uniform grid over points for fixed-radius queries (the skin check's coverage test).
 * → { near(x, y, z, r, visit(i, d2)) } visiting points in grid order (x, then y, then z cell; points
 * inside a cell in index order).
 */
export function pointGrid(xs, ys, zs, cell) {
  const n = xs.length;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  for (let i = 0; i < n; i++) { if (xs[i] < x0) x0 = xs[i]; if (ys[i] < y0) y0 = ys[i]; if (zs[i] < z0) z0 = zs[i]; }
  if (!n) { x0 = y0 = z0 = 0; }
  const keyOf = (i, j, k) => `${i},${j},${k}`;
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const key = keyOf(Math.floor((xs[i] - x0) / cell), Math.floor((ys[i] - y0) / cell), Math.floor((zs[i] - z0) / cell));
    let l = cells.get(key);
    if (!l) cells.set(key, (l = []));
    l.push(i);
  }
  return {
    near(x, y, z, r, visit) {
      const r2 = r * r;
      const i0 = Math.floor((x - r - x0) / cell), i1 = Math.floor((x + r - x0) / cell);
      const j0 = Math.floor((y - r - y0) / cell), j1 = Math.floor((y + r - y0) / cell);
      const k0 = Math.floor((z - r - z0) / cell), k1 = Math.floor((z + r - z0) / cell);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
        const l = cells.get(keyOf(i, j, k));
        if (!l) continue;
        for (const p of l) {
          const dx = xs[p] - x, dy = ys[p] - y, dz = zs[p] - z, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= r2) visit(p, d2);
        }
      }
    },
  };
}

const PI = 3.141592653589793;

/**
 * sin and cos of an angle in degrees, by a fixed Taylor series on [0°, 45°] and the usual symmetries:
 * + − × ÷ only, so every engine gives the same bits (ECMAScript leaves Math.sin / Math.cos
 * implementation-approximated). → [sin, cos]
 */
export function sinCosDeg(deg) {
  let a = deg - 360 * Math.floor(deg / 360); // [0, 360)
  let ss = 1, sc = 1; // signs
  if (a >= 180) { a -= 180; ss = -1; sc = -1; }
  if (a > 90) { a = 180 - a; sc = -sc; }
  // now a in [0, 90]
  let swap = false;
  if (a > 45) { a = 90 - a; swap = true; }
  const x = (a * PI) / 180, x2 = x * x;
  let s = 0, c = 0, ts = x, tc = 1;
  for (let k = 1; k <= 12; k++) {
    s += ts; c += tc;
    ts = (-ts * x2) / ((2 * k) * (2 * k + 1));
    tc = (-tc * x2) / ((2 * k - 1) * (2 * k));
  }
  const sin = swap ? c : s, cos = swap ? s : c;
  return [ss * sin, sc * cos];
}

/** Solve the symmetric positive definite system A x = b (n × n, row-major) by Cholesky, fixed order. → x or null */
export function choleskySolve(A, b, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (!(s > 0)) return null; L[i * n + i] = Math.sqrt(s); } else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
  return x;
}
