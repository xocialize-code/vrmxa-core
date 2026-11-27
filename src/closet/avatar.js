// avatar.vrm drawn from the saved look (CLOSET.md C6, §4 items 2 to 11; VRMXA §5.2): Spec, the edit
// document, the hair piece and every worn item in its state, fitted (closet/fit.js) in layer order,
// with their springs and colliders, the figure raised by the shoes, and the pieces' licences carried.
// After redrawAvatar the bundle's avatar.of names the real closet.json, not null (D32 is only for an
// app that can't fit).

import { buildGlb, parseGlb } from '../glb.js';
import { clone } from '../bytes.js';
import { setAvatar } from '../vrmxa.js';
import { bakeAvatar } from '../edit/bake.js';
import { layerTextures } from '../layers/documents.js';
import { mergeItemModel } from '../edit/merge.js';
import { closetOf, itemOf } from './ops.js';
import { prepareItemModel, methodFor } from './fit.js';
import { fitMerged, specContextFor } from '../fit/index.js';
import { effectiveMeta } from '../character/details.js';

/**
 * The details every avatar.vrm drawn for this character carries (VRMXA §5.3; PRD LIC-1, LIC-4): avatar.vrm's own
 * VRMC_vrm.meta as it stands, whole, but its thumbnail picture (the new model's is Spec's), with `over` set on top.
 */
export function characterMeta(bundle, over = null) {
  // as shown (LIC-3): Spec's permissions taken over and never chosen are written as nothing allowed, so a save never
  // writes more than the character's parts allow (VRMXA §5.3)
  const m = effectiveMeta(bundle) || {};
  delete m.thumbnailImage;
  if (!m.name && bundle.manifest.title) m.name = bundle.manifest.title;
  return { ...m, ...(over || {}) };
}

const licence = (item, state) => {
  const m = item.manifest;
  return { id: m.id, name: m.name, slot: m.slot, type: m.type, revision: m.revision, ...(state ? { state } : {}), meta: clone(m.meta), listing: m.listing ? clone(m.listing) : null, ...(m.origin ? { origin: clone(m.origin) } : {}) };
};

/**
 * What the saved look wears, each piece prepared for wearing (prepareItemModel): the hair piece and
 * the worn items in layer order (inner first, FITTING.md §5.5; worn order among equals).
 * opts.adjust: false leaves the fine-tuning out (for a live view that applies it itself).
 * → { hair: { model, humanBones, prepared, item } | null, items: [{ id, prepared, item, entry, specFit }],
 *     lift, pieces: [licence records], methods: { id: method } }
 */
export async function wornPieces(bundle, { closet = closetOf(bundle), adjust = true } = {}) {
  const pieces = [];
  const methods = {};
  let hair = null;
  if (closet.hair != null) {
    const e = closet.items.find((x) => x.id === closet.hair);
    const item = await itemOf(bundle, closet.hair);
    const prepared = prepareItemModel(item.entries.get(item.manifest.model?.file || 'model.glb'), item.manifest, { adjust: adjust ? e?.fitting?.adjust : null });
    hair = { model: buildGlb(prepared.json, prepared.bin), humanBones: prepared.humanBones, prepared, item };
    pieces.push(licence(item));
    methods[closet.hair] = prepared.method;
  }
  const worn = [];
  for (const [k, id] of closet.worn.items.entries()) {
    const e = closet.items.find((x) => x.id === id);
    const item = await itemOf(bundle, id);
    worn.push({ k, id, e, item, layer: Number.isFinite(item.manifest.layer) ? item.manifest.layer : 0 });
  }
  worn.sort((a, b) => a.layer - b.layer || a.k - b.k);
  const items = [];
  let lift = 0;
  for (const { id, e, item } of worn) {
    const state = closet.worn.states?.[id] ?? null;
    // a Spec-fitted item's hand adjustments come after the automatic fit (VRMXA §7.5): fit/index.js applies them
    const spec = methodFor(item.manifest, e?.fitting) === 'spec-fit';
    const prepared = prepareItemModel(item.entries.get(item.manifest.model?.file || 'model.glb'), item.manifest, { state, adjust: adjust && !spec ? e?.fitting?.adjust : null, fitting: e?.fitting || null });
    items.push({ id, prepared, item, entry: e, specFit: spec });
    pieces.push(licence(item, prepared.state));
    methods[id] = prepared.method;
    lift = Math.max(lift, prepared.lift);
  }
  return { hair, items, lift, pieces, methods };
}

/**
 * Spec with the hair piece and the worn items merged, nothing else applied (for a live view, which
 * applies the edits, the fine-tuning and the lift itself). → bytes of a VRM 1.0
 */
export function mergeWorn(specBytes, { hair = null, items = [] } = {}) {
  const parsed = parseGlb(specBytes);
  const json = clone(parsed.json);
  let bin = parsed.bin;
  if (hair) {
    const p = hair.prepared || (() => { const g = parseGlb(hair.model); return { json: clone(g.json), bin: g.bin, humanBones: hair.humanBones }; })();
    bin = mergeItemModel(json, bin, { json: clone(p.json), bin: p.bin }, { humanBones: p.humanBones || hair.humanBones || {}, mark: 'piece' }).bin;
  }
  for (const it of items) bin = mergeItemModel(json, bin, { json: clone(it.prepared.json), bin: it.prepared.bin }, { humanBones: it.prepared.humanBones || {} }).bin;
  return buildGlb(json, bin);
}

/**
 * avatar.vrm for the saved look, as bytes (CLOSET.md §4 item 10). opts: { spec (spec.vrm's bytes),
 * meta (VRM meta fields to set over the character's own details, which are carried whole), fitCache, fitWeights (false: Spec-fitted items
 * keep their own weights instead of the body's under them, FITTING.md §5.6) }.
 * → { bytes, lift, methods, pieces, refused, ignored }
 */
export async function drawAvatar(bundle, { spec, meta, fitCache, fitWeights = true } = {}) {
  if (!spec) throw new Error('drawing avatar.vrm needs spec.vrm');
  const w = await wornPieces(bundle);
  const fitItems = w.items.map((x) => ({ id: x.id, manifest: x.item.manifest, fitting: x.entry?.fitting || null }));
  const adjusts = Object.fromEntries(w.items.filter((x) => x.specFit && x.entry?.fitting?.adjust).map((x) => [x.id, x.entry.fitting.adjust]));
  const r = bakeAvatar(spec, bundle.docs.edits || null, {
    hair: w.hair ? { model: w.hair.model, humanBones: w.hair.humanBones } : null,
    items: w.items.map((x) => x.prepared),
    lift: w.lift,
    pieces: w.pieces,
    // the layered editors' default textures: the default eye set and the skin (VRMXA §6.0, rule 8 of §2)
    textures: layerTextures({ eyes: bundle.docs.eyes || null, skin: bundle.docs.skin || null }, bundle.entries, spec),
    // the character's own details, carried whole into every avatar.vrm (LIC-4); `meta` sets fields over them
    meta: characterMeta(bundle, meta),
    metaMode: 'replace',
    // Spec-fit (FITTING.md §5): the worn tops, bottoms, one-pieces and coats on this body
    fit: w.items.some((x) => x.specFit) ? (json, bin, edits) => {
      const f = fitMerged(json, bin, fitItems, edits, { spec: specContextFor(spec), cache: fitCache, adjusts, weights: fitWeights });
      return { bin: f.bin, report: f.result };
    } : null,
  });
  const methods = { ...w.methods };
  for (const it of r.fit?.items || []) methods[it.id] = it.method;
  return { bytes: r.bytes, lift: w.lift, methods, pieces: w.pieces, refused: r.refused, ignored: r.ignored, fit: r.fit ? fitSummary(r.fit) : null };
}

// what a fit did, for a report: per item its method, rule, timing, pushes and warnings
export function fitSummary(result) {
  return {
    identity: result.identity,
    ms: Math.round(result.ms * 10) / 10,
    estimated: result.target?.estimated || [],
    refused: result.target?.refused || null,
    items: result.items.map((it) => ({
      id: it.id, method: it.method, ...(it.rule ? { rule: it.rule } : {}), ...(it.refused ? { refused: it.refused } : {}),
      ...(it.stats ? { ms: Math.round(it.stats.ms * 10) / 10, vertices: it.stats.vertices, pushed: it.stats.pushed, warnings: it.stats.warnings || [] } : {}),
    })),
  };
}

/**
 * Redraw avatar.vrm from the saved look and put it in the bundle (CLOSET.md §5.2 step 4). avatar.of
 * is then written from the real edits.json and closet.json when the bundle is written. The thumbnail
 * is the app's to draw: this library has no renderer, so it is kept (VRMXA §5.2, D32).
 */
export async function redrawAvatar(bundle, opts = {}) {
  const r = await drawAvatar(bundle, opts);
  setAvatar(bundle, r.bytes);
  return r;
}
