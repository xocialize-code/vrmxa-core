// Flattening a whole editor document (VRMXA §6.1 eyes, §6.3 skin) with the one flattener.
import { decodePng } from '../edit/png.js';
import { parseGlb } from '../glb.js';
import { flattenTarget, scaleAboutEyes, inBands } from './flatten.js';

/** Targets a state made `from` another scales; the others stay as in the state it is made from (§6.1). */
export const SCALED_TARGETS = ['iris', 'highlight'];

/**
 * A picture loader over a bundle's entries (or any Map of path → bytes), decoding each PNG once.
 * → (path) => picture
 */
export function pictureLoader(entries) {
  const cache = new Map();
  return (path) => {
    if (cache.has(path)) return cache.get(path);
    const bytes = entries.get(path);
    if (!bytes) throw new Error(`picture not in the bundle: ${path}`);
    const p = decodePng(bytes);
    cache.set(path, p);
    return p;
  };
}

/**
 * The picture a material's base colour uses in a VRM (the base's own art, under skin layers).
 * → picture, or null when the material has no embedded PNG
 */
export function materialPicture(glbBytes, materialName) {
  const { json, bin } = parseGlb(glbBytes);
  const mat = (json.materials || []).find((m) => m.name === materialName);
  if (!mat) throw new Error(`no material ${materialName} in the model`);
  const img = json.images?.[json.textures?.[mat.pbrMetallicRoughness?.baseColorTexture?.index]?.source];
  if (!img || img.bufferView == null || (img.mimeType && img.mimeType !== 'image/png')) return null;
  const v = json.bufferViews[img.bufferView];
  return decodePng(bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
}

/** An eyes document's target with its size and eyes resolved (a target's own, else the document's). */
export function eyeTarget(doc, name) {
  const t = doc.targets?.[name];
  if (!t) throw new Error(`the eyes document has no target ${name}`);
  return { size: t.size || doc.size, eyes: t.eyes || doc.eyes };
}

/**
 * Flatten the states of an eyes document.
 * → { [state]: { [target]: picture } }, holding only the targets the state's layers touch, or, for a state
 *   made `from` another, the scaled iris and highlight. A target a state leaves out is as in `default`
 *   (§6.1 `baked`); `hide` is the app's to apply when it shows the state.
 */
export function flattenEyes(doc, load, { states: only } = {}) {
  const byName = new Map((doc.states || []).map((s) => [s.name, s]));
  const done = new Map();
  const flattenState = (s, seen = new Set()) => {
    if (done.has(s.name)) return done.get(s.name);
    if (seen.has(s.name)) throw new Error(`eye state ${s.name} is made from itself`);
    seen.add(s.name);
    const out = {};
    if (s.from) {
      const src = byName.get(s.from);
      if (!src) throw new Error(`eye state ${s.name} is made from ${s.from}, which isn't there`);
      const from = flattenState(src, seen);
      for (const t of SCALED_TARGETS) if (from[t]) out[t] = scaleAboutEyes(from[t], eyeTarget(doc, t).eyes, s.scale ?? 1);
    } else {
      const names = [...new Set((s.layers || []).flatMap((l) => [l.target, ...(l.targets || []), ...Object.keys(l.images || {})]).filter(Boolean))];
      for (const t of names) out[t] = flattenTarget(eyeTarget(doc, t), s.layers, { name: t, fills: doc.fills, load });
    }
    done.set(s.name, out);
    return out;
  };
  const wanted = only ? only.map((n) => byName.get(n) ?? (() => { throw new Error(`no eye state ${n}`); })()) : doc.states || [];
  return Object.fromEntries(wanted.map((s) => [s.name, flattenState(s)]));
}

/**
 * Flatten a skin document (§6.3) over each skin texture's own art.
 *   bases: { skinFace: picture, skinBody: picture }, the base's textures, which are band 1
 *   extra: { [target]: [layers] } more layers for a target, such as a shown mouth state's lips layers
 * → { [target]: picture } for every target the document names
 */
export function flattenSkin(doc, load, bases = {}, extra = {}) {
  const out = {};
  for (const [name, t] of Object.entries(doc.targets || {})) {
    const layers = inBands([...(doc.layers || []), ...(extra[name] || [])]);
    out[name] = flattenTarget({ size: t.size }, layers, { name, load, base: bases[name] || null });
  }
  return out;
}
