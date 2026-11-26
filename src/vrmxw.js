// .vrmxw, item format version 1 (VRMXW-base-draft.md §3, §4, §9, §10, §11, §12, §14).
//
// An item is { kind: 'vrmxw', manifest, entries, problems }:
//   manifest — vrmxw.json as an object; keys this library doesn't know are kept and written back
//   entries  — Map(path → bytes) of every other entry: model.glb, thumbnail, animations/, extensions/
// writeItem is a pure serializer: it recomputes `files` and nothing else, so an item read and written
// again gives the same bytes. touchItem bumps the revision when an item is edited and saved.

import { clone, isPlainObject, newUuid, nowIso, UUID_RE } from './bytes.js';
import { inventory, itemRank, manifestOf, orderPaths, packZip } from './container.js';
import { isGlb, parseGlb } from './glb.js';
import { sha12, sha256 } from './hash.js';
import { ITEM_VERSION, VRMXW_MANIFEST } from './layout.js';
import { ITEM_TYPES, resolveItemType, standardBase } from './vocab.js';
import { scanZip } from './zip.js';
import { showIndicesToNames } from './show.js';

export const GENERATOR = 'VRMXA reference library (vrmxa-core 0.1.0)';

export class RefusedError extends Error {
  constructor(what, problems) {
    const errors = problems.filter((p) => p.severity === 'error');
    super(`${what} was refused: ${errors.slice(0, 5).map((p) => (p.where ? `${p.where}: ${p.message}` : p.message)).join('; ')}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ''}`);
    this.name = 'RefusedError';
    this.problems = problems;
  }
}

const baseRef = (b) => ({ name: b.name, species: b.species || 'human', sha256: b.sha256 });

/**
 * A new item. Required: model (GLB bytes), name, type, rig, meta ({ authors, licenseUrl, … }).
 * Everything else takes the type's defaults (VRMXW §6) or the format's (§4).
 *   animations: { clips: [{ bytes, name, duration, loops, rootMotion, speed, tracks, source, licence }],
 *                 sets: [{ name, priority, requires, slots }] } — a set's slot entries name a clip by
 *                 its `sha256` or by its index in `clips` ({ clip: 0 }).
 *   extensions: { name: { data, files: { 'relative/path': bytes } } }
 *   thumbnail: PNG bytes
 */
export async function createItem(o) {
  const t = resolveItemType(o.type, o.slot, o.kind);
  if (!t) throw new Error(`unknown item type "${o.type}" (VRMXW §6 lists ${Object.keys(ITEM_TYPES).join(', ')}; a vendor's type is x-<vendor>.<name> and names its slot)`);
  if (!o.model || !isGlb(o.model)) throw new Error('model must be GLB bytes');
  if (!o.name) throw new Error('an item needs a name');
  if (!o.rig || !isPlainObject(o.rig.humanBones)) throw new Error('an item needs rig.humanBones');
  if (!o.incompleteLicence && (!o.meta || !Array.isArray(o.meta.authors) || !o.meta.authors.length || !o.meta.licenseUrl)) throw new Error('an item needs a licence block: meta.authors and meta.licenseUrl (VRMXW §11)');
  const kind = o.kind || t.kind;
  const base = o.base || standardBase('human');
  const entries = new Map([['model.glb', o.model]]);
  let animations = null;
  if (o.animations?.clips?.length) {
    const clips = [];
    for (const c of o.animations.clips) {
      const h = await sha256(c.bytes);
      const file = `animations/${sha12(h)}.vrma`;
      entries.set(file, c.bytes);
      clips.push({ sha256: h, file, name: c.name ?? null, duration: c.duration ?? null, loops: c.loops ?? null, rootMotion: c.rootMotion ?? null,
        speed: c.speed ?? null, tracks: c.tracks ?? ['humanoid'], source: c.source ?? null, licence: c.licence ?? null });
    }
    const ref = (x) => (Number.isInteger(x) ? clips[x].sha256 : x);
    const sets = (o.animations.sets || []).map((s) => ({
      name: s.name, priority: s.priority ?? 0, requires: s.requires || [],
      slots: Object.fromEntries(Object.entries(s.slots || {}).map(([slot, list]) => [slot, list.map((e) => ({ ...e, clip: ref(e.clip) }))])),
    }));
    animations = { clips, sets };
  }
  const extensions = {};
  for (const [name, ext] of Object.entries(o.extensions || {})) {
    extensions[name] = ext.data ?? {};
    for (const [rel, bytes] of Object.entries(ext.files || {})) entries.set(`extensions/${name}/${rel}`, bytes);
  }
  if (o.thumbnail) entries.set('thumbnail.png', o.thumbnail);
  const fit = clone(o.fit || t.fit);
  if (o.type === 'shoes' && o.lift !== undefined) fit.lift = o.lift;
  const manifest = {
    format: 'vrmxw',
    version: ITEM_VERSION,
    id: o.id || newUuid(),
    revision: o.revision ?? 1,
    name: o.name,
    created: o.created || nowIso(),
    generator: o.generator || GENERATOR,
    slot: o.slot || t.slot,
    type: o.type,
    kind,
    layer: o.layer ?? 0,
    tags: o.tags || [],
    base: baseRef(base),
    model: { file: 'model.glb' },
    rig: { humanBones: clone(o.rig.humanBones) },
    fit,
    attach: kind === 'pin' ? { bone: o.attach || t.bone } : null,
    states: clone(o.states || []),
    animations,
    extensions,
    meta: clone(o.meta),
    listing: o.listing ? clone(o.listing) : null,
    origin: o.origin ? clone(o.origin) : null,
    thumbnail: o.thumbnail ? 'thumbnail.png' : null,
    files: [],
  };
  return { kind: 'vrmxw', manifest, entries, problems: [] };
}

/** The entries of an item's open form, manifest included, with `files` recomputed. */
export async function itemToEntries(item) {
  const order = orderPaths([...item.entries.keys()].filter((p) => p !== VRMXW_MANIFEST), itemRank);
  const manifest = { ...item.manifest, files: await inventory(item.entries, order, item.manifest.files) };
  const out = new Map([[VRMXW_MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n')]]);
  for (const p of order) out.set(p, item.entries.get(p));
  return { manifest, entries: out, order };
}

/**
 * Pack an item: vrmxw.json first, then the entries in the layout's order (VRMXW §3), `files`
 * recomputed. The same item gives the same bytes.
 */
export async function writeItem(item) {
  const order = orderPaths([...item.entries.keys()].filter((p) => p !== VRMXW_MANIFEST), itemRank);
  const manifest = { ...item.manifest, files: await inventory(item.entries, order, item.manifest.files) };
  item.manifest = manifest;
  return packZip(VRMXW_MANIFEST, manifest, item.entries, order);
}

/** The item as it would be after an edit is saved: the next revision (VRMXW §3). */
export function touchItem(item) {
  item.manifest.revision = (Number.isInteger(item.manifest.revision) ? item.manifest.revision : 0) + 1;
  return item;
}

/** A copy that is a different item: a new `id`, revision 1 (PRD ITM-10, "Duplicate as a new item"). */
export function duplicateItem(item, { id = newUuid(), created = nowIso() } = {}) {
  return { kind: 'vrmxw', manifest: { ...clone(item.manifest), id, revision: 1, created }, entries: new Map(item.entries), problems: [] };
}

/**
 * Read a packed item, refusing it (RefusedError, with every problem) when the checker finds an error.
 * Warnings come back in item.problems. opts: { limits, bases, spec } as for checkItem.
 */
export async function readItem(bytes, opts = {}) {
  const { checkItem } = await import('./checker.js');
  const problems = await checkItem(bytes, opts);
  if (problems.some((p) => p.severity === 'error')) throw new RefusedError('the item', problems);
  const { entries } = scanZip(bytes, { limits: opts.limits });
  const item = itemFromEntries(new Map(entries.map((e) => [e.name, e.data])), problems);
  // an older item's states named meshes by node index: read them as names (VRMXW §8, SPEC-QUESTIONS #44)
  if ((item.manifest.states || []).some((st) => (st?.show || []).some((x) => Number.isInteger(x)))) {
    const model = item.entries.get(item.manifest.model?.file || 'model.glb');
    if (model) showIndicesToNames(item.manifest, parseGlb(model).json.nodes);
  }
  return item;
}

/** An item from its open form (Map of path → bytes, vrmxw.json included). Doesn't check it. */
export function itemFromEntries(map, problems = []) {
  const m = manifestOf(map, VRMXW_MANIFEST);
  if (m.error) throw new Error(m.error);
  const entries = new Map([...map].filter(([p]) => p !== VRMXW_MANIFEST));
  return { kind: 'vrmxw', manifest: m.manifest, entries, problems };
}

/**
 * The item's entry in a character's closet.json → items (VRMXA §7.4; VRMXW §12): the manifest fields
 * copied so a closet can be listed without opening the item. `file` is where it sits in the bundle;
 * the model hash is computed. No `fitting`: that is the character's own, and starts empty.
 */
export async function closetEntryFor(item, { file, thumbnail = null, source = null } = {}) {
  const m = item.manifest;
  const e = {
    id: m.id, file, model: await sha256(item.entries.get(m.model?.file || 'model.glb')),
    name: m.name, slot: m.slot, type: m.type, kind: m.kind, bone: m.kind === 'pin' ? m.attach?.bone ?? null : null, layer: m.layer ?? 0,
    base: m.base?.sha256, tags: clone(m.tags || []),
  };
  if (Array.isArray(m.states) && m.states.length) {
    e.states = m.states.map((s) => {
      const o = { name: s.name };
      if (s.bone !== undefined) o.bone = s.bone;
      o.tags = clone(s.tags || []);
      return o;
    });
  }
  e.thumbnail = thumbnail;
  e.source = source;
  e.meta = clone(m.meta);
  e.listing = m.listing ? clone(m.listing) : null;
  if (m.origin) e.origin = clone(m.origin);
  return e;
}

/**
 * Bring in a bare GLB written by the earlier tools (VRMXW §14): an earlier tool's `asset.extras.rig`
 * and `provenance`, or item-studio's `asset.extras.itemStudio`. The model is kept byte for byte.
 * opts: { slot, type, name, id, base, created } — slot and type are guesses the person should confirm.
 * The donor's shoe lift is not taken out (ITM-11 is not built); the item says so in origin.note.
 */
export async function itemFromBareGlb(glb, opts = {}) {
  const { json } = parseGlb(glb);
  const ex = json.asset?.extras || {};
  const slot = opts.slot || 'accessory';
  const type = opts.type || Object.entries(ITEM_TYPES).find(([, t]) => t.slot === slot)?.[0] || 'charm';
  const prov = ex.provenance || null;
  const studio = ex.itemStudio || null;
  const sm = prov?.sourceMeta || {};
  const lic = studio?.licence || {};
  const authors = [sm.author || lic.author].filter(Boolean).flatMap((a) => String(a).split(/,\s*/));
  const meta = { authors, licenseUrl: sm.licenseUrl || lic.licenseUrl || lic.url || '' };
  if (sm.otherLicenseUrl) meta.otherLicenseUrl = sm.otherLicenseUrl;
  if (['personalNonProfit', 'personalProfit', 'corporation'].includes(sm.commercialUsage)) meta.commercialUsage = sm.commercialUsage;
  if (typeof sm.redistribution === 'boolean') meta.allowRedistribution = sm.redistribution;
  const humanBones = isPlainObject(ex.rig?.humanBones) ? clone(ex.rig.humanBones) : {};
  const t = resolveItemType(type, slot);
  const item = await createItem({
    model: glb, name: opts.name || prov?.role || 'Item', type, slot, kind: t.kind, rig: { humanBones },
    meta, incompleteLicence: true,
    origin: { made: 'imported', source: prov?.extractedFrom || studio?.source || null, note: 'brought in from a bare GLB: slot and type guessed; the donor shoe lift was not taken out' },
    id: opts.id && UUID_RE.test(opts.id) ? opts.id : undefined, base: opts.base, created: opts.created,
  });
  if (!meta.authors.length || !meta.licenseUrl) item.problems.push({ severity: 'warning', where: 'vrmxw.json → meta', code: 'item.legacy-licence', message: 'the bare GLB did not say who made it or under what licence; the item is not valid until meta.authors and meta.licenseUrl are filled in' });
  return item;
}
