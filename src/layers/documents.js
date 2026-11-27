// Flattening a whole editor document (VRMXA §6.1 eyes, §6.3 skin) with the one flattener.
import { decodePng, encodePng } from '../edit/png.js';
import { sha256, sha12 } from '../hash.js';
import { bakedPath } from '../layout.js';
import { setEntry, setDocument } from '../vrmxa.js';
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

/** The kinds of look an eye state may be (VRMXA §6.1, D39), besides `x-<vendor>.<name>`. */
export const EYE_STATE_KINDS = ['standard', 'confused', 'angry', 'surprised', 'love', 'admiration'];

/**
 * An eye state's kind (D39): its `kind`; `standard` for `default`; `confused` for a `zonedOut` that names none (its
 * name before D39); else null.
 */
export function stateKind(state) {
  if (!state) return null;
  if (typeof state.kind === 'string' && state.kind) return state.kind;
  if (state.name === 'default') return 'standard';
  if (state.name === 'zonedOut') return 'confused';
  return null;
}

/** The state an app asks for, by name or by kind (`{ name }` or `{ kind }`): the first that matches, or null. */
export function findEyeState(doc, { name, kind } = {}) {
  const states = doc?.states || [];
  if (name != null) return states.find((s) => s.name === name) || null;
  if (kind != null) return states.find((s) => stateKind(s) === kind) || null;
  return null;
}

/** The targets a state's layers paint. */
const paintedTargets = (s) => new Set((s.layers || []).flatMap((l) => [l.target, ...(l.targets || []), ...Object.keys(l.images || {})]).filter(Boolean));

/**
 * Flatten the states of an eyes document.
 * → { [state]: { [target]: picture } }: the targets the state's layers paint, flattened; the targets it gives as
 *   finished textures alone (`baked`, a state made in any app, D39), as given; or, for a state made `from` another,
 *   the scaled iris and highlight. A target a state leaves out is as in `default` (§6.1 `baked`); `hide` is the
 *   app's to apply when it shows the state.
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
      const painted = paintedTargets(s);
      for (const t of painted) out[t] = flattenTarget(eyeTarget(doc, t), s.layers, { name: t, fills: doc.fills, load });
      // finished textures given as they are, for the targets no layer paints (D39)
      for (const [t, path] of Object.entries(s.baked || {})) if (t !== 'of' && !painted.has(t) && typeof path === 'string') out[t] = load(path);
    }
    done.set(s.name, out);
    return out;
  };
  const wanted = only ? only.map((n) => byName.get(n) ?? (() => { throw new Error(`no eye state ${n}`); })()) : doc.states || [];
  return Object.fromEntries(wanted.map((s) => [s.name, flattenState(s)]));
}

/**
 * What showing an eye state puts on the model (VRMXA §6.1, "Showing a state"): its finished textures by
 * material name, a target the state leaves out taking `default`'s; the materials of the targets it hides;
 * and the face shapes it holds. `flat` is flattenEyes' result, or the state's `baked` pictures in its shape.
 * → { pictures: { [material]: picture }, hide: [material], morphs: { [shape]: weight } }
 */
export function eyeStateTextures(doc, flat, stateName = 'default') {
  const state = (doc.states || []).find((s) => s.name === stateName);
  if (!state) throw new Error(`no eye state ${stateName}`);
  const pictures = {};
  for (const [t, d] of Object.entries(doc.targets || {})) {
    const p = flat[stateName]?.[t] ?? (stateName !== 'default' ? flat.default?.[t] : null);
    if (p && d.material) pictures[d.material] = p;
  }
  const hide = (state.hide || []).map((t) => doc.targets?.[t]?.material).filter(Boolean);
  return { pictures, hide, morphs: { ...(state.morphs || {}) } };
}

/**
 * The finished textures a character's layered editors put into avatar.vrm (VRMXA §6.0, "Writing into
 * avatar.vrm"): the default eye set and the skin, by material name. `docs` holds the eyes and skin documents,
 * `entries` the bundle's files, `spec` the base's VRM (for the skin's own art under its layers).
 * → { [material]: picture }
 */
export function layerTextures({ eyes = null, skin = null } = {}, entries, spec = null) {
  const out = {};
  if (!eyes && !skin) return out;
  const load = pictureLoader(entries);
  if (eyes?.states?.length) Object.assign(out, eyeStateTextures(eyes, flattenEyes(eyes, load, { states: ['default'] }), 'default').pictures);
  if (skin?.layers?.length) {
    const bases = {};
    if (spec) for (const [t, d] of Object.entries(skin.targets || {})) bases[t] = d.material ? materialPicture(spec, d.material) : null;
    const flat = flattenSkin(skin, load, bases);
    for (const [t, d] of Object.entries(skin.targets || {})) if (d.material && flat[t]) out[d.material] = flat[t];
  }
  return out;
}

/**
 * Flatten every eye state again and write its finished textures into the bundle (VRMXA §6.1 `baked`, §6.0 the picture
 * store): `appearance/baked/<sha12>.png`, named by content, each state's `baked` pointing at them. A state made `from`
 * another keeps none of its own (it has no layers). A finished picture no document refers to any more is removed.
 * → { changed: boolean, baked: { [state]: { [target]: path } } }
 */
export async function refreshBakedEyes(bundle) {
  const eyes = bundle.docs?.eyes;
  if (!eyes?.states?.length) return { changed: false, baked: {} };
  const flat = flattenEyes(eyes, pictureLoader(bundle.entries));
  const next = JSON.parse(JSON.stringify(eyes));
  const old = new Set(eyes.states.flatMap((s) => Object.entries(s.baked || {}).filter(([k]) => k !== 'of').map(([, p]) => p)));
  const out = {};
  for (const s of next.states) {
    if (s.from || !s.layers?.length) continue;
    // a target no layer paints keeps the finished texture it was given (D39)
    const painted = paintedTargets(s);
    const baked = Object.fromEntries(Object.entries(s.baked || {}).filter(([t]) => t !== 'of' && !painted.has(t)));
    for (const t of painted) {
      const pic = flat[s.name]?.[t];
      if (!pic) continue;
      const png = encodePng(pic);
      const path = bakedPath(sha12(await sha256(png)));
      if (!bundle.entries.has(path)) setEntry(bundle, path, png);
      baked[t] = path;
    }
    s.baked = baked;
    out[s.name] = baked;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(eyes);
  if (changed) {
    setDocument(bundle, 'eyes', next);
    const used = JSON.stringify(['eyes', 'mouth', 'skin'].map((r) => bundle.docs[r] ?? null));
    for (const p of old) if (!used.includes(JSON.stringify(p))) bundle.entries.delete(p);
  }
  return { changed, baked: out };
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
