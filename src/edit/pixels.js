// Pixel arithmetic for the textures the edits repaint: the blush on the face skin (EDITS.md §3.7)
// and the hair colour (§3.2, role `hair`). Plain JavaScript over RGBA arrays, so the live view (which
// runs it on a canvas's ImageData) and the file (which runs it on the decoded PNG) get the same
// pixels (PRD REF-10). The formulas below are the ones EDITS.md states, written out.

/** Overlay of one channel (base a, blend b, both 0 … 1), as W3C Compositing and Blending Level 1 defines it. */
export const overlay = (a, b) => (a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b));

/** The blush's own layer is a neutral grey (EDITS.md §3.7), so its colour is overlay(0.5, colour). */
export const CHEEK_BASE = 0.5;
/** The ellipse's radii are this share of the UV spread of the skin near the cheek (EDITS.md §3.7). */
export const BLUSH_SPREAD = 0.7;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The blush layer's colour, 0 … 255 per channel. */
export const blushRgb = (colour) => colour.map((v) => Math.round(overlay(CHEEK_BASE, clamp01(v)) * 255));

/**
 * The blush's opacity at a distance t from the centre (0 at the centre, 1 at the edge): the strength
 * at the centre, 0.6 × that halfway out and 0 at the edge (EDITS.md §3.7), linear in between.
 */
export function blushAlpha(t, strength) {
  if (t >= 1) return 0;
  return t <= 0.5 ? strength * (1 - 0.8 * t) : strength * 0.6 * (1 - (t - 0.5) / 0.5);
}

/**
 * Paint the blush onto an RGBA image in place. cheeks: [{ u, v, ru, rv }] (the cheek UVs,
 * faceLandmarks().cheekUV); colour [r, g, b] 0 … 1; strength 0 … 1. UV v runs down the image, as glTF's does.
 */
export function paintBlush(img, cheeks, colour, strength) {
  const { width: w, height: h, data } = img;
  const [r, g, b] = blushRgb(colour);
  const s = clamp01(strength);
  if (s <= 0) return img;
  for (const c of cheeks || []) {
    const cx = c.u * w, cy = c.v * h;
    const rx = Math.max(1, c.ru * BLUSH_SPREAD * w), ry = Math.max(1, c.rv * BLUSH_SPREAD * h);
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        // the pixel's centre, in units of the ellipse
        const t = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
        const a = blushAlpha(t, s);
        if (a <= 0) continue;
        const i = (y * w + x) * 4;
        // source-over onto the skin; the skin's own alpha is kept
        data[i] = Math.round(data[i] + (r - data[i]) * a);
        data[i + 1] = Math.round(data[i + 1] + (g - data[i + 1]) * a);
        data[i + 2] = Math.round(data[i + 2] + (b - data[i + 2]) * a);
      }
  }
  return img;
}

/**
 * Colour hair (EDITS.md §3.2, role `hair`): each pixel becomes overlay(texture, colour), with the
 * texture's own alpha kept. → a new image.
 */
export function overlayColour(img, colour) {
  const { width, height, data } = img;
  const out = new Uint8ClampedArray(data.length);
  const c = colour.map(clamp01);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = Math.round(overlay(data[i] / 255, c[0]) * 255);
    out[i + 1] = Math.round(overlay(data[i + 1] / 255, c[1]) * 255);
    out[i + 2] = Math.round(overlay(data[i + 2] / 255, c[2]) * 255);
    out[i + 3] = data[i + 3];
  }
  return { width, height, data: out };
}

/**
 * The drawn hair's texture (EDITS.md §6's three texture settings): the group's colour with darker
 * strand lines across its width (`texWidth` × 4 of them, shifted by `offset`), a soft highlight band
 * along its length at `highlight` (0 = root, 1 = tip) and a darker root. 64 × 256, RGBA. The colour
 * is in the texture, as in a VRoid hair texture, so the hair colour (§3.2, Overlay) tints drawn hair
 * as it tints a hair piece.
 */
export function hairStrandTexture({ texWidth = 3, highlight = 0.3, offset = 0 } = {}, colour = [1, 1, 1], w = 64, h = 256) {
  const data = new Uint8ClampedArray(w * h * 4);
  const lines = Math.max(1, Math.round(texWidth * 4));
  const gap = w / lines;
  const shift = offset * gap;
  for (let y = 0; y < h; y++) {
    const along = (y + 0.5) / h;
    const hl = Math.max(0, 1 - Math.abs(along - highlight) / 0.08) * 0.85;
    const root = along < 0.23 ? 0.59 + 0.41 * (along / 0.23) : 1;
    for (let x = 0; x < w; x++) {
      const d = ((x + 0.5 - shift) % gap + gap) % gap;
      const line = Math.min(d, gap - d) < 1 ? 0.78 : 1;
      const shade = line * root;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(Math.min(1, clamp01(colour[c]) * shade + hl) * 255);
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
