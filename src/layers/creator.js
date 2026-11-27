// The Eye Creator's side of the library (PRD EYE-14, EYE-18 to EYE-21; VRMXA §6.1): a starter eye design made from a
// base's own eye art, and the few controls the Creator offers (the eye colour, how strong the highlight and the
// overlays are), read from and written to an eyes document. Plain JavaScript, so it runs in both editions.
import { parseGlb } from '../glb.js';
import { encodePng } from '../edit/png.js';
import { sha256, sha12 } from '../hash.js';
import { layerPath } from '../layout.js';
import { materialPicture } from './documents.js';

// the base's eye textures by role, found by the material names VRoid writes into exported files
const EYE_TARGETS = { white: /EyeWhite/, iris: /EyeIris/, highlight: /EyeHighlight/, brow: /FaceBrow/, eyeline: /FaceEyeline/, eyelash: /FaceEyelash/ };

/** Where each eye's iris art sits in a picture: the opaque area of each half. → { left, right } or null */
export function eyesFromArt(pic, threshold = 8) {
  const { width: w, height: h, data } = pic;
  const box = (x0, x1) => {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) if (data[(y * w + x) * 4 + 3] > threshold) {
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (!Number.isFinite(minx)) return null;
    return { center: [Math.round((minx + maxx + 1) / 2), Math.round((miny + maxy + 1) / 2)], radius: [Math.round((maxx - minx + 1) / 2), Math.round((maxy - miny + 1) / 2)] };
  };
  const left = box(w / 2, w), right = box(0, w / 2); // the character's left eye is the right half (§6.1)
  return left && right ? { left, right } : null;
}

// the art's lightness as a grey shading picture, its brightest parts white (so a multiply over a fill keeps the
// fill's colour there), alpha kept; and per band of rows, the colour the art shows at full brightness
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function shadingOf(pic) {
  const { width: w, height: h, data } = pic;
  const ls = [];
  for (let k = 0; k < data.length; k += 4) if (data[k + 3] > 127) ls.push(luma(data[k], data[k + 1], data[k + 2]));
  ls.sort((a, b) => a - b);
  const top = ls.length ? Math.max(1, ls[Math.floor(ls.length * 0.98)]) : 255;
  const out = new Uint8ClampedArray(data.length);
  for (let k = 0; k < data.length; k += 4) {
    const v = Math.min(255, Math.round((luma(data[k], data[k + 1], data[k + 2]) / top) * 255));
    out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = data[k + 3];
  }
  return { width: w, height: h, data: out };
}
function bandColour(pic, shade, y0, y1) {
  const { width: w, data } = pic;
  let r = 0, g = 0, b = 0, s = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4;
    if (data[k + 3] < 128) continue;
    r += data[k]; g += data[k + 1]; b += data[k + 2]; s += shade.data[k];
  }
  if (!s) return [0.5, 0.5, 0.5];
  return [r, g, b].map((v) => Math.round(Math.min(1, v / s) * 1000) / 1000);
}

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgb = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
const r3 = (v) => Math.round(v * 1000) / 1000;

const picture = (w, h, f) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
};

/**
 * A starter eye design from a base's own eye art (VRMXA §6.1, "Tried"): the eye colour as a gradient fill clipped to
 * the iris art's shape, the art's lightness over it as shading (multiply, brightest parts white), and the highlight art as its own layer. Starter
 * states: default, confused (the eye colour inside a black outer ring, the highlight hidden; the specification's
 * `zonedOut`, renamed by the operator, SPEC-QUESTIONS #108) and squint (default at
 * 0.78). The sclera is the base's eye-white art with a colour over it. Layers carry `role` (eyeColour, overlay,
 * highlight, sclera) for the Creator's controls (SPEC-QUESTIONS #110,
 * proposed; readers ignore an unknown key).
 * → { doc, pictures: Map(path → PNG bytes) } to put in a bundle (setEntry each, then setDocument 'eyes')
 */
export async function starterEyes(baseGlb, { name = 'Starter' } = {}) {
  const { json } = parseGlb(baseGlb);
  const targets = {};
  const art = {};
  for (const [role, re] of Object.entries(EYE_TARGETS)) {
    const m = (json.materials || []).find((x) => re.test(x.name || ''));
    if (!m) continue;
    const p = materialPicture(baseGlb, m.name);
    if (!p) continue;
    art[role] = p;
    targets[role] = { material: m.name, ...(p.width !== art.iris?.width || p.height !== art.iris?.height ? { size: [p.width, p.height] } : {}) };
  }
  if (!art.iris) throw new Error('the base has no iris texture to start from');
  const size = [art.iris.width, art.iris.height];
  for (const t of Object.values(targets)) if (t.size && t.size[0] === size[0] && t.size[1] === size[1]) delete t.size;
  const eyes = eyesFromArt(art.iris);
  if (!eyes) throw new Error('no iris art found in each half of the iris texture');
  const pictures = new Map();
  const store = async (pic) => { const png = encodePng(pic); const path = layerPath(sha12(await sha256(png))); pictures.set(path, png); return path; };
  // the iris art: its alpha is the mask of the fill, and its lightness the shading over it
  const irisPath = await store(art.iris);
  const shade = shadingOf(art.iris);
  const shadePath = await store(shade);
  const [w, h] = size;
  const inRing = (x, y) => [eyes.left, eyes.right].some((e) => { const d = ((x + 0.5 - e.center[0]) / e.radius[0]) ** 2 + ((y + 0.5 - e.center[1]) / e.radius[1]) ** 2; return d < 1 && d > 0.72; });
  const ringPath = await store(picture(w, h, (x, y) => (inRing(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0])));
  const highlightPath = art.highlight ? await store(art.highlight) : null;
  // the sclera: the base's eye-white art, and over it a colour that multiplies it in linear light (white: unchanged), so
  // the art's shading stays when the colour changes
  const whitePath = art.white ? await store(art.white) : null;
  const sclera = whitePath ? [
    { id: 'white-art', name: 'Eye white', target: 'white', kind: 'image', image: whitePath },
    { id: 'sclera', name: 'Sclera colour', target: 'white', kind: 'adjust', multiply: [1, 1, 1], role: 'sclera' },
  ] : [];
  const top = eyes.left.center[1] - eyes.left.radius[1], bottom = eyes.left.center[1] + eyes.left.radius[1];
  const third = Math.round((bottom - top) / 3);
  const colour = { type: 'linear', stops: [{ at: 0, color: bandColour(art.iris, shade, top, top + third) }, { at: 1, color: bandColour(art.iris, shade, bottom - third, bottom) }] };
  const fill = { id: 'eye-colour', name: 'Eye colour', target: 'iris', kind: 'fill', fill: 'eyeColour', mask: irisPath, role: 'eyeColour' };
  const highlight = highlightPath ? [{ id: 'highlight', name: 'Highlight', target: 'highlight', kind: 'image', image: highlightPath, role: 'highlight' }] : [];
  const doc = {
    format: 'vrmxa-eyes', version: 1, name, size, targets, eyes,
    fills: { eyeColour: colour },
    states: [
      { name: 'default', layers: [...sclera, fill, { id: 'shading', name: 'Shading', target: 'iris', kind: 'image', image: shadePath, blend: 'multiply', role: 'overlay' }, ...highlight] },
      { name: 'confused', layers: [fill, { id: 'ring', name: 'Outer ring', target: 'iris', kind: 'image', image: ringPath }], hide: ['highlight'] },
      { name: 'squint', from: 'default', scale: 0.78 },
    ],
  };
  return { doc, pictures };
}

// ---- the Creator's controls (EYE-18, EYE-21) ------------------------------------------------------------

// which fill is the eye colour, and which layers are the highlight and the overlays: by `role` where a design marks
// them (SPEC-QUESTIONS #110); otherwise the first shared fill a layer uses, the layers on the highlight target, and
// the image layers above a fill on the iris
function roles(doc) {
  const layers = (doc.states || []).flatMap((s) => (s.layers || []).map((l) => ({ state: s.name, l })));
  const marked = layers.some(({ l }) => l.role);
  const fillName = Object.keys(doc.fills || {}).find((f) => layers.some(({ l }) => l.role === 'eyeColour' && l.fill === f))
    ?? layers.find(({ l }) => l.kind === 'fill' && typeof l.fill === 'string')?.l.fill ?? null;
  const pick = (role, guess) => layers.filter(({ l }) => (marked ? l.role === role : guess(l))).map(({ state, l }) => ({ state, id: l.id }));
  return {
    fill: fillName,
    highlight: pick('highlight', (l) => l.target === 'highlight'),
    overlay: pick('overlay', (l) => l.kind === 'image' && l.target === 'iris' && (l.blend || 'normal') !== 'normal'),
    sclera: pick('sclera', (l) => l.kind === 'adjust' && l.target === 'white' && Array.isArray(l.multiply)),
  };
}

const layerOf = (doc, { state, id }) => doc.states.find((s) => s.name === state)?.layers?.find((l) => l.id === id);

/**
 * What the Creator can change in a design, and how it stands now.
 * → { colour: { fill, type, stops: [{ at, color }] } | null, highlight: { strength, count } | null, overlay: { strength, count } | null,
 *     sclera: { color: [r, g, b] (sRGB, as shown over white art) } | null }
 */
export function creatorControls(doc) {
  const r = roles(doc);
  const f = r.fill ? doc.fills[r.fill] : null;
  const strength = (refs) => (refs.length ? { strength: layerOf(doc, refs[0])?.opacity ?? 1, count: refs.length } : null);
  return {
    colour: f ? { fill: r.fill, type: f.type, ...(f.type === 'solid' ? { stops: [{ at: 0, color: f.color }] } : { stops: f.stops.map((s) => ({ at: s.at, color: [...s.color] })) }) } : null,
    highlight: strength(r.highlight),
    overlay: strength(r.overlay),
    sclera: r.sclera.length ? { color: (layerOf(doc, r.sclera[0])?.multiply || [1, 1, 1]).map((v) => r3(srgb(Math.min(1, Math.max(0, v))))) } : null,
  };
}

const okColour = (c) => Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);

/**
 * Apply the Creator's controls to a design, changing nothing else (EYE-18). changes:
 *   colour: [r, g, b] (a solid eye colour) or { top: [r,g,b], bottom: [r,g,b] } (a gradient, top to bottom)
 *   highlight, overlay: 0 to 1, the opacity of every layer of that role
 *   sclera: [r, g, b], the colour the eye white shows where its art is white (stored as a linear multiply)
 * → a new document
 */
export function applyCreator(doc, changes = {}) {
  const next = JSON.parse(JSON.stringify(doc));
  const r = roles(next);
  if (changes.colour !== undefined) {
    if (!r.fill) throw new Error('this design has no eye colour fill to change');
    const c = changes.colour;
    if (okColour(c)) next.fills[r.fill] = { type: 'solid', color: c.map((v) => Math.round(v * 1000) / 1000) };
    else if (okColour(c?.top) && okColour(c?.bottom)) next.fills[r.fill] = { type: 'linear', stops: [{ at: 0, color: c.top.map((v) => Math.round(v * 1000) / 1000) }, { at: 1, color: c.bottom.map((v) => Math.round(v * 1000) / 1000) }] };
    else throw new Error('an eye colour is [r, g, b] or { top: [r, g, b], bottom: [r, g, b] }, each 0 to 1');
  }
  if (changes.sclera !== undefined) {
    if (!okColour(changes.sclera)) throw new Error('a sclera colour is [r, g, b], each 0 to 1');
    if (!r.sclera.length) throw new Error('this design has no sclera colour layer');
    for (const ref of r.sclera) layerOf(next, ref).multiply = changes.sclera.map((v) => Math.round(lin(v) * 1e6) / 1e6);
  }
  for (const role of ['highlight', 'overlay']) {
    if (changes[role] === undefined) continue;
    const v = changes[role];
    if (!(Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error(`${role} strength is 0 to 1`);
    if (!r[role].length) throw new Error(`this design has no ${role} layers`);
    for (const ref of r[role]) { const l = layerOf(next, ref); if (v === 1) delete l.opacity; else l.opacity = Math.round(v * 1000) / 1000; }
  }
  return next;
}
