// The one flattener (PRD REF-10; VRMXA §6.0, D37). It turns the layers of the eye, mouth and skin
// documents into finished textures, with its own arithmetic in plain JavaScript, so the same layers give
// the same bytes in Node, Chrome and WebKit (trial T-4). A browser's canvas is for previews only.
//
// Compositing is the W3C Compositing and Blending rules a canvas uses, on premultiplied values, in
// floating point, rounded to 8 bits once at the end. It runs layer by layer over the whole picture; each
// pixel sees the same operations in the same order as it would pixel by pixel.
//
// Pictures are { width, height, data: Uint8ClampedArray RGBA, straight alpha }. A layer refers to a
// picture by path; `load(path)` returns it (see `pictureLoader`), or a picture may be given inline.

// ---- colour, for the adjust layer ----------------------------------------------------------------------
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
const fLab = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) / (24389 / 27));
const WN = [0.95047, 1, 1.08883];

/** sRGB 0…1 → CIE Lab (D65). */
export function toLab(r, g, b) {
  r = lin(r); g = lin(g); b = lin(b);
  const fx = fLab((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WN[0]);
  const fy = fLab(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
  const fz = fLab((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WN[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE Lab → sRGB 0…1, each channel clipped to 0…1. */
export function fromLab(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = fInv(fx) * WN[0], Y = fInv(fy), Z = fInv(fz) * WN[2];
  const c = [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
  return c.map((v) => srgb(Math.min(1, Math.max(0, v))));
}

/**
 * An adjust layer's colour change (VRMXA §6.0): `tone` {from, to} moves every colour by the Lab difference
 * between the two; `brightness` adds to Lab lightness; `saturation` scales Lab chroma; `multiply` multiplies
 * in linear light, as a material's colour factor does. → (r, g, b) => [r, g, b], all sRGB 0…1.
 */
export function adjuster(a) {
  const tone = a.tone ? (() => { const f = toLab(...a.tone.from), t = toLab(...a.tone.to); return [t[0] - f[0], t[1] - f[1], t[2] - f[2]]; })() : null;
  const bright = a.brightness || 0, sat = a.saturation ?? 1, mul = a.multiply || null;
  return (r, g, b) => {
    if (mul) { r = srgb(lin(r) * mul[0]); g = srgb(lin(g) * mul[1]); b = srgb(lin(b) * mul[2]); }
    if (!tone && !bright && sat === 1) return [r, g, b];
    let [L, A, B] = toLab(r, g, b);
    if (tone) { L += tone[0]; A += tone[1]; B += tone[2]; }
    L += bright; A *= sat; B *= sat;
    return fromLab(L, A, B);
  };
}

// ---- where the eyes sit, and the bands on a skin texture -----------------------------------------------

/**
 * Each eye of a target as { side, cx, cy, rx, ry }. `eyes` is the target's own or the document's
 * (VRMXA §6.1); without one, the character's left eye is the right half of the texture and the right eye
 * the left half, each centred in its half.
 */
export function eyesOf(size, eyes) {
  const [w, h] = size;
  return ['right', 'left'].map((side) => {
    const e = eyes?.[side];
    if (e) return { side, cx: e.center[0], cy: e.center[1], rx: e.radius[0], ry: e.radius[1] };
    return { side, cx: side === 'left' ? w * 0.75 : w * 0.25, cy: h / 2, rx: w / 4, ry: h / 2 };
  });
}

/** The four bands of a skin texture, bottom first (VRMXA §6.2, "Order on a shared texture"). */
export const BANDS = ['skin', 'adjust', 'on', 'worn'];

/** A layer's band: as given, else `adjust` for an adjust layer and `on` for any other. */
export const bandOf = (l) => (BANDS.includes(l.band) ? l.band : l.kind === 'adjust' ? 'adjust' : 'on');

/** Order layers by band, keeping their order within a band. */
export const inBands = (layers) => BANDS.flatMap((b) => layers.filter((l) => bandOf(l) === b));

/** Does a layer apply to a target? */
export const appliesTo = (l, name) => l.target === name || !!l.images?.[name] || (l.targets || []).includes(name);

// ---- the flattener -------------------------------------------------------------------------------------
const lerpStops = (stops, t) => {
  if (t <= stops[0].at) return stops[0].c;
  for (let i = 1; i < stops.length; i++) if (t <= stops[i].at) {
    const a = stops[i - 1], b = stops[i], f = (t - a.at) / (b.at - a.at || 1);
    return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f];
  }
  return stops[stops.length - 1].c;
};

const sizeProblem = (p, w, h, what) => {
  if (p && (p.width !== w || p.height !== h)) throw new Error(`${what} is ${p.width}×${p.height}, not the target's ${w}×${h}`);
};

/**
 * Flatten one target.
 *   target: { size: [w, h], eyes? }   the target, with `eyes` already resolved from the document if it has one
 *   layers: the layers, bottom first; those that don't apply to `name` or are hidden are skipped
 *   opts:   { name, fills, load(path) → picture, base: picture under the layers (a skin texture's own art) }
 * → picture
 */
export function flattenTarget(target, layers, opts = {}) {
  const { name, fills = {}, load, base = null } = opts;
  const [w, h] = target.size;
  const N = w * h;
  const pic = (ref, what) => {
    if (ref == null) return null;
    const p = typeof ref === 'string' ? load(ref) : ref;
    sizeProblem(p, w, h, what);
    return p;
  };
  const eyes = eyesOf(target.size, target.eyes);
  const eyeAt = (x) => eyes.find((e) => (e.cx < w / 2) === (x < w / 2));
  const bd = new Float64Array(N * 4); // the backdrop, premultiplied
  if (base) {
    sizeProblem(base, w, h, 'the base picture');
    const s = base.data;
    for (let k = 0; k < N * 4; k += 4) { const a = s[k + 3] / 255; bd[k] = s[k] / 255 * a; bd[k + 1] = s[k + 1] / 255 * a; bd[k + 2] = s[k + 2] / 255 * a; bd[k + 3] = a; }
  }
  for (const l of layers) {
    if (l.visible === false || (name != null && !appliesTo(l, name))) continue;
    const op = l.opacity ?? 1, blend = l.blend || 'normal';
    let x0 = 0, x1 = w;
    if (l.eye && l.eye !== 'both') { const e = eyes.find((s) => s.side === l.eye); [x0, x1] = e.cx < w / 2 ? [0, w / 2] : [w / 2, w]; }
    const mask = pic(l.masks?.[name] ?? l.mask, `layer ${l.id}'s mask`)?.data || null;
    if (l.kind === 'adjust') {
      const f = adjuster(l);
      for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) {
        const k = (y * w + x) * 4;
        const ba = bd[k + 3]; if (ba <= 0) continue;
        const m = (mask ? mask[k + 3] / 255 : 1) * op; if (m <= 0) continue;
        const r = bd[k] / ba, g = bd[k + 1] / ba, b = bd[k + 2] / ba;
        const [r2, g2, b2] = f(r, g, b);
        bd[k] = (r + (r2 - r) * m) * ba; bd[k + 1] = (g + (g2 - g) * m) * ba; bd[k + 2] = (b + (b2 - b) * m) * ba;
      }
      continue;
    }
    let img = null, fill = null;
    if (l.kind === 'fill') {
      const f = typeof l.fill === 'string' ? fills[l.fill] : l.fill;
      if (!f) throw new Error(`layer ${l.id} names a fill that isn't there: ${l.fill}`);
      fill = { type: f.type, color: f.color?.map((v) => Math.round(v * 255) / 255), stops: f.stops?.map((s) => ({ at: s.at, c: s.color.map((v) => Math.round(v * 255) / 255) })) };
    } else img = pic(l.images?.[name] ?? l.image, `layer ${l.id}'s picture`)?.data;
    if (!img && !fill) continue;
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) {
      const k = (y * w + x) * 4;
      let sr, sg, sb, sa;
      if (img) {
        sa = img[k + 3] / 255; if (sa === 0) continue;
        sr = img[k] / 255 * sa; sg = img[k + 1] / 255 * sa; sb = img[k + 2] / 255 * sa;
        if (mask) { const m = mask[k + 3] / 255; sr *= m; sg *= m; sb *= m; sa *= m; if (sa === 0) continue; }
      } else {
        let c;
        if (fill.type === 'solid') c = fill.color;
        else {
          const e = eyeAt(x);
          const tt = fill.type === 'linear' ? (y + 0.5 - (e.cy - e.ry)) / (2 * e.ry) : Math.hypot((x + 0.5 - e.cx) / e.rx, (y + 0.5 - e.cy) / e.ry);
          c = lerpStops(fill.stops, tt < 0 ? 0 : tt > 1 ? 1 : tt);
        }
        sa = mask ? mask[k + 3] / 255 : 1; if (sa === 0) continue;
        sr = c[0] * sa; sg = c[1] * sa; sb = c[2] * sa;
      }
      sr *= op; sg *= op; sb *= op; sa *= op;
      let br = bd[k], bg = bd[k + 1], bb = bd[k + 2];
      const ba = bd[k + 3];
      const ia = 1 - sa, ib = 1 - ba;
      switch (blend) {
        case 'multiply': br = sr * ib + br * ia + sr * br; bg = sg * ib + bg * ia + sg * bg; bb = sb * ib + bb * ia + sb * bb; break;
        case 'screen': br = sr + br - sr * br; bg = sg + bg - sg * bg; bb = sb + bb - sb * bb; break;
        case 'overlay': {
          const sab = sa * ba;
          br = sr * ib + br * ia + (2 * br <= ba ? 2 * sr * br : sab - 2 * (ba - br) * (sa - sr));
          bg = sg * ib + bg * ia + (2 * bg <= ba ? 2 * sg * bg : sab - 2 * (ba - bg) * (sa - sg));
          bb = sb * ib + bb * ia + (2 * bb <= ba ? 2 * sb * bb : sab - 2 * (ba - bb) * (sa - sb));
          break;
        }
        case 'normal': br = sr + br * ia; bg = sg + bg * ia; bb = sb + bb * ia; break;
        default: throw new Error(`layer ${l.id}: blend must be normal, multiply, screen or overlay, not ${blend}`);
      }
      bd[k] = br; bd[k + 1] = bg; bd[k + 2] = bb; bd[k + 3] = sa + ba * ia;
    }
  }
  const out = new Uint8ClampedArray(N * 4);
  for (let k = 0; k < N * 4; k += 4) {
    const ba = bd[k + 3]; if (ba <= 0) continue;
    const a8 = Math.round(ba * 255); if (a8 === 0) continue;
    out[k] = Math.round(bd[k] / ba * 255); out[k + 1] = Math.round(bd[k + 1] / ba * 255); out[k + 2] = Math.round(bd[k + 2] / ba * 255); out[k + 3] = a8;
  }
  return { width: w, height: h, data: out };
}

/**
 * A finished eye texture scaled about each eye's centre (a state made `from` another, VRMXA §6.1), with the
 * flattener's own bilinear filter on premultiplied values. Outside the picture is transparent.
 */
export function scaleAboutEyes(src, eyes, scale) {
  const { width: w, height: h, data: s } = src;
  const out = new Uint8ClampedArray(w * h * 4);
  const pm = new Float32Array(w * h * 4);
  for (let k = 0; k < s.length; k += 4) {
    const a = s[k + 3] / 255;
    for (let c = 0; c < 3; c++) pm[k + c] = s[k + c] / 255 * a;
    pm[k + 3] = a;
  }
  for (const e of eyesOf([w, h], eyes)) {
    const [x0, x1] = e.cx < w / 2 ? [0, w / 2] : [w / 2, w];
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5 - e.cy) / scale + e.cy - 0.5, yA = Math.floor(fy), ty = fy - yA;
      if (yA < -1 || yA >= h) continue;
      for (let x = x0; x < x1; x++) {
        const fx = (x + 0.5 - e.cx) / scale + e.cx - 0.5, xA = Math.floor(fx), tx = fx - xA;
        if (xA < -1 || xA >= w) continue;
        const k = (y * w + x) * 4;
        const acc = [0, 0, 0, 0];
        for (const [xx, yy, wt] of [[xA, yA, (1 - tx) * (1 - ty)], [xA + 1, yA, tx * (1 - ty)], [xA, yA + 1, (1 - tx) * ty], [xA + 1, yA + 1, tx * ty]]) {
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || wt === 0) continue;
          const j = (yy * w + xx) * 4;
          acc[0] += pm[j] * wt; acc[1] += pm[j + 1] * wt; acc[2] += pm[j + 2] * wt; acc[3] += pm[j + 3] * wt;
        }
        if (acc[3] <= 0) continue;
        const a8 = Math.round(acc[3] * 255);
        if (a8 === 0) continue;
        for (let c = 0; c < 3; c++) out[k + c] = Math.round(acc[c] / acc[3] * 255);
        out[k + 3] = a8;
      }
    }
  }
  return { width: w, height: h, data: out };
}
