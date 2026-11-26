// Small quaternion and vector arithmetic for the animation module: plain arrays [x, y, z, w] and
// [x, y, z], so clips can be checked and corrected in Node with no three.js. Right-handed, Y up.

export const qid = () => [0, 0, 0, 1];
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
export function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
/** The rotation angle between two orientations, radians (0..π). */
export const qangle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(qdot(a, b))));
export function qslerp(a, b, t) {
  let [bx, by, bz, bw] = b;
  let c = qdot(a, b);
  if (c < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; c = -c; }
  let k0, k1;
  if (c > 0.9995) { k0 = 1 - t; k1 = t; } else {
    const th = Math.acos(c), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s;
    k1 = Math.sin(t * th) / s;
  }
  return qnorm([a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1]);
}
export function qaxis(axis, angle) {
  const l = Math.hypot(...axis) || 1, s = Math.sin(angle / 2);
  return [(axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s, Math.cos(angle / 2)];
}
export const qyaw = (angle) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
/** From Euler angles in degrees, applied X then Y then Z (three.js 'XYZ' order: q = qx·qy·qz). */
export function qeuler(deg) {
  const r = (d) => ((d || 0) * Math.PI) / 180;
  return qmul(qmul(qaxis([1, 0, 0], r(deg[0])), qaxis([0, 1, 0], r(deg[1]))), qaxis([0, 0, 1], r(deg[2])));
}
/** v rotated by q. */
export function qrot(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
/** The shortest rotation taking direction a onto direction b. */
export function qbetween(a, b) {
  const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
  const u = a.map((v) => v / la), w = b.map((v) => v / lb);
  const d = dot(u, w);
  if (d < -0.999999) {
    let ax = cross([1, 0, 0], u);
    if (Math.hypot(...ax) < 1e-6) ax = cross([0, 1, 0], u);
    return qaxis(ax, Math.PI);
  }
  const c = cross(u, w);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
/** Keep q on the same side of the sphere as ref (so neighbouring keys interpolate the short way). */
export const qnear = (q, ref) => (qdot(q, ref) < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const deg = (r) => (r * 180) / Math.PI;
export const rad = (d) => (d * Math.PI) / 180;
/** Heading of a direction about +Y, degrees: 0 = +Z (VRM 1.0's front), positive towards +X (the character's left). */
export const yawOf = (v) => deg(Math.atan2(v[0], v[2]));
/** An angle in degrees brought into −180..180. */
export const wrapDeg = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
/** Smoothstep 0..1. */
export const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
