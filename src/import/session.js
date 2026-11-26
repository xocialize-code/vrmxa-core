// An import: the person's decisions about one source file, kept as a plain document so it can be left and
// picked up again (PRD IMP-12), and the items it writes (IMP-10).
//
// The document holds no model data, only references to the source's pieces (`mesh/primitive`) and its
// SHA-256, so it is small and is checked against the file when it is resumed. Every function here returns a
// new document; nothing is changed in place (an app keeps the old one for undo).
//
//   { format: 'vrmxa-import', version: 1, created, updated,
//     source: { file, sha256, size, vrm, title, listing },
//     groups: [{ id, name, pieces: ['m/p'], type, slot, kind, attach, layer, tags, why,
//                status: 'waiting' | 'approved' | 'skipped', viewed, place: { move, turn, size },
//                item: { id, revision, sha256, file } | null }],
//     head: { shapes, headSize, before, after, status: 'offered' | 'accepted' | 'declined' } | null,
//     record: [{ at, group, item, name, pieces }] }
//
// Rules (IMP-3, IMP-5, IMP-6): an item is approved only after it has been viewed on Spec; changing a group's
// pieces or type sends it back to waiting; the face, the eyes and the body are never in a group.

import { clone, newUuid, nowIso } from '../bytes.js';
import { sha256 } from '../hash.js';
import { createItem, writeItem, GENERATOR } from '../vrmxw.js';
import { checkItem } from '../checker.js';
import { extractItemModel } from '../item-writer.js';
import { ITEM_TYPES, resolveItemType, standardBase } from '../vocab.js';
import { faceLandmarks } from '../edit/face.js';
import { matchHead, headScale, scanMatchHead } from '../edit/headMatch.js';
import { guessDonorParts } from '../measure/donorParts.js';
import { fitFor, typeName } from './source.js';
import { specRig, donorRig, measureLift, moveOntoSpec, placeItemModel, cleanPlace, itemCentre } from './onSpec.js';
import { specContext, donorContext, garmentOntoSpec, SPEC_FIT_SLOTS, fitVerdict } from '../fit/index.js';

export const IMPORT_FORMAT = 'vrmxa-import';
export const IMPORT_VERSION = 1;
const STATUSES = ['waiting', 'approved', 'skipped'];

export class ImportError extends Error {
  constructor(code, message) { super(message); this.name = 'ImportError'; this.code = code; }
}

const now = (opts) => opts?.now || nowIso();

/** A new import of an opened source (openSource): its proposed groups, all waiting. */
export function newImport(source, opts = {}) {
  const t = now(opts);
  return {
    format: IMPORT_FORMAT, version: IMPORT_VERSION, created: t, updated: t,
    source: { file: source.file, sha256: source.sha256, size: source.size, vrm: source.vrm, title: source.title, listing: source.listing ? clone(source.listing) : null },
    groups: source.groups.map((g) => ({ ...clone(g), tags: [], status: 'waiting', viewed: false, place: cleanPlace(null), item: null })),
    head: null,
    record: [],
  };
}

/**
 * Check a saved import against the source it is resumed with (IMP-12). → [problems as text]; empty when it
 * fits. A document from another file, of a newer version, or naming pieces the file doesn't have, is refused.
 */
export function importProblems(doc, source) {
  const out = [];
  if (doc?.format !== IMPORT_FORMAT) return ['this is not an import document'];
  if (!Number.isInteger(doc.version) || doc.version > IMPORT_VERSION) return [`import document version ${doc.version} is newer than this app knows (${IMPORT_VERSION})`];
  if (source && doc.source?.sha256 !== source.sha256) out.push(`it is an import of ${doc.source?.file || 'another file'} (${String(doc.source?.sha256).slice(0, 12)}), not of this file (${source.sha256.slice(0, 12)})`);
  const known = new Map((source?.pieces || []).map((p) => [p.id, p]));
  const seen = new Set();
  for (const g of doc.groups || []) {
    if (!STATUSES.includes(g.status)) out.push(`group ${g.id} has an unknown status "${g.status}"`);
    for (const id of g.pieces || []) {
      if (source && !known.has(id)) out.push(`group ${g.id} names piece ${id}, which the file does not have`);
      else if (known.get(id)?.never) out.push(`group ${g.id} holds piece ${id}, which is part of the body or face and is never imported`);
      if (seen.has(id)) out.push(`piece ${id} is in two groups`);
      seen.add(id);
    }
  }
  return out;
}

/** Resume a saved import: checked, then returned as a fresh copy. Throws ImportError when it doesn't fit. */
export function resumeImport(doc, source) {
  const problems = importProblems(doc, source);
  if (problems.length) throw new ImportError('import.resume', `the import can't be resumed: ${problems.join('; ')}`);
  return clone(doc);
}

const touched = (doc, opts) => ({ ...doc, updated: now(opts) });
const groupOf = (doc, id) => {
  const g = doc.groups.find((x) => x.id === id);
  if (!g) throw new ImportError('import.no-group', `there is no group ${id}`);
  return g;
};
const nextId = (doc) => `g${Math.max(0, ...doc.groups.map((g) => Number(String(g.id).slice(1)) || 0)) + 1}`;
const backToWaiting = (g) => { g.status = g.status === 'skipped' ? 'skipped' : 'waiting'; g.viewed = false; g.item = null; };

// ---- regrouping (IMP-6) -----------------------------------------------------------------------------------

/** Move pieces into a group (another existing one, or a new one when `to` is null). Empty groups go. */
export function movePieces(doc, pieceIds, to, { source, name = 'New group', opts } = {}) {
  const d = clone(doc);
  const never = new Set((source?.pieces || []).filter((p) => p.never).map((p) => p.id));
  for (const id of pieceIds) if (never.has(id)) throw new ImportError('import.body', `piece ${id} is part of the body or face; it is never imported (IMP-5)`);
  let target = to ? groupOf(d, to) : null;
  if (!target) {
    const from = d.groups.find((g) => g.pieces.includes(pieceIds[0]));
    target = { id: nextId(d), name, pieces: [], type: from?.type || 'charm', slot: from?.slot || 'accessory', kind: from?.kind || 'pin', attach: from?.attach ?? null, layer: 0, tags: [], why: 'made by hand', status: 'waiting', viewed: false, place: cleanPlace(null), item: null };
    d.groups.push(target);
  }
  for (const g of d.groups) {
    if (g === target) continue;
    const before = g.pieces.length;
    g.pieces = g.pieces.filter((p) => !pieceIds.includes(p));
    if (g.pieces.length !== before) backToWaiting(g);
  }
  for (const id of pieceIds) if (!target.pieces.includes(id)) target.pieces.push(id);
  backToWaiting(target);
  d.groups = d.groups.filter((g) => g.pieces.length);
  return touched(d, opts);
}

/** Merge groups into the first one given. */
export function mergeGroups(doc, ids, { name, opts } = {}) {
  if (ids.length < 2) throw new ImportError('import.merge', 'merge needs two groups or more');
  const d = clone(doc);
  const [first, ...rest] = ids.map((id) => groupOf(d, id));
  for (const g of rest) first.pieces.push(...g.pieces.filter((p) => !first.pieces.includes(p)));
  if (name) first.name = name;
  backToWaiting(first);
  first.status = 'waiting';
  d.groups = d.groups.filter((g) => !rest.includes(g));
  return touched(d, opts);
}

/** Split pieces out of a group into a new group, beside it. */
export function splitGroup(doc, id, pieceIds, { name, opts } = {}) {
  const g = groupOf(doc, id);
  const out = pieceIds.filter((p) => g.pieces.includes(p));
  if (!out.length || out.length === g.pieces.length) throw new ImportError('import.split', 'choose some of the group\'s pieces, not none or all of them');
  const d = movePieces(doc, out, null, { name: name || `${g.name} (part)`, opts });
  // keep the new group next to the one it came from, with the same proposal
  const made = d.groups[d.groups.length - 1];
  Object.assign(made, { type: g.type, slot: g.slot, kind: g.kind, attach: g.attach, why: 'split by hand' });
  d.groups.splice(d.groups.length - 1, 1);
  d.groups.splice(d.groups.findIndex((x) => x.id === id) + 1, 0, made);
  return d;
}

/** Rename a group. */
export function renameGroup(doc, id, name, { opts } = {}) {
  if (!String(name || '').trim()) throw new ImportError('import.name', 'a group needs a name');
  const d = clone(doc);
  groupOf(d, id).name = String(name).trim().slice(0, 80);
  return touched(d, opts);
}

/**
 * Classify a group (IMP-7): its type, and with it the slot, kind and bone (VRMXW §6), which can each be
 * set too. A change sends an approved group back to waiting.
 */
export function classifyGroup(doc, id, { type, slot, kind, attach, layer, tags } = {}, { opts } = {}) {
  const d = clone(doc);
  const g = groupOf(d, id);
  const before = JSON.stringify([g.type, g.slot, g.kind, g.attach, g.layer]);
  if (type !== undefined) {
    const t = resolveItemType(type, slot ?? g.slot, kind);
    if (!t) throw new ImportError('import.type', `"${type}" is not an item type (VRMXW §6)`);
    g.type = type;
    g.slot = slot ?? t.slot;
    g.kind = kind ?? t.kind;
    g.attach = g.kind === 'pin' ? (attach ?? t.bone ?? g.attach ?? 'hips') : null;
  } else {
    if (slot !== undefined) g.slot = slot;
    if (kind !== undefined) { g.kind = kind; if (kind !== 'pin') g.attach = null; else g.attach = g.attach || 'hips'; }
    if (attach !== undefined && g.kind === 'pin') g.attach = attach;
  }
  if (layer !== undefined) g.layer = Number.isInteger(layer) ? layer : 0;
  if (tags !== undefined) g.tags = [...new Set(tags)];
  if (JSON.stringify([g.type, g.slot, g.kind, g.attach, g.layer]) !== before && g.status === 'approved') { g.status = 'waiting'; g.item = null; }
  g.why = 'chosen by hand';
  return touched(d, opts);
}

/** Set a group's place on Spec (IMP-9): { move: [x, y, z] m, turn: [x, y, z] degrees, size }. */
export function placeGroup(doc, id, place, { opts } = {}) {
  const d = clone(doc);
  const g = groupOf(d, id);
  g.place = cleanPlace({ ...g.place, ...place });
  if (g.status === 'approved') { g.status = 'waiting'; g.item = null; }
  return touched(d, opts);
}

/** The group was looked at on Spec in panel 3 (IMP-3): only then can it be approved. */
export function viewGroup(doc, id, { opts } = {}) {
  const d = clone(doc);
  groupOf(d, id).viewed = true;
  return touched(d, opts);
}

/** Approve a group (IMP-3): refused until it has been viewed on Spec. */
export function approveGroup(doc, id, { opts } = {}) {
  const d = clone(doc);
  const g = groupOf(d, id);
  if (!g.viewed) throw new ImportError('import.unseen', `${g.name} has not been looked at on Spec yet; nothing comes in unseen (IMP-3)`);
  g.status = 'approved';
  return touched(d, opts);
}

/** Skip a group: it is not imported. */
export function skipGroup(doc, id, { opts } = {}) {
  const d = clone(doc);
  const g = groupOf(d, id);
  g.status = 'skipped';
  g.item = null;
  return touched(d, opts);
}

/** Put a skipped or approved group back to waiting. */
export function reopenGroup(doc, id, { opts } = {}) {
  const d = clone(doc);
  const g = groupOf(d, id);
  g.status = 'waiting';
  g.item = null;
  return touched(d, opts);
}

/**
 * Groups that can't all be worn together (VRMXA §7.2: one item per slot except accessories; a one-piece takes the
 * place of a top and bottoms). Among the groups not skipped by default, or those of `statuses`. Nothing is merged:
 * the person merges them or chooses another slot. → [{ slot, groups: [ids], names: [names], text }]
 */
export function slotClashes(doc, { statuses = ['waiting', 'approved'] } = {}) {
  const live = doc.groups.filter((g) => statuses.includes(g.status));
  const out = [];
  const bySlot = new Map();
  for (const g of live) if (g.slot !== 'accessory') bySlot.set(g.slot, [...(bySlot.get(g.slot) || []), g]);
  for (const [slot, gs] of bySlot) {
    if (gs.length < 2) continue;
    out.push({ slot, groups: gs.map((g) => g.id), names: gs.map((g) => g.name), text: `${gs.map((g) => `"${g.name}"`).join(' and ')} are both ${slot}: only one can be worn at a time, so the other would come in as a spare. Merge them, or choose another type for one.` });
  }
  const one = bySlot.get('onepiece') || [];
  const under = [...(bySlot.get('tops') || []), ...(bySlot.get('bottoms') || [])];
  if (one.length && under.length) {
    out.push({ slot: 'onepiece', groups: [...one, ...under].map((g) => g.id), names: [...one, ...under].map((g) => g.name), text: `${one.map((g) => `"${g.name}"`).join(' and ')} is a one-piece, which takes the place of ${under.map((g) => `"${g.name}"`).join(' and ')} when worn. Choose another type for one, or merge them.` });
  }
  return out;
}

/** How many groups are in each status. */
export function importCounts(doc) {
  const c = { waiting: 0, approved: 0, skipped: 0, imported: 0, total: doc.groups.length };
  for (const g of doc.groups) { c[g.status]++; if (g.item) c.imported++; }
  return c;
}

// ---- the head (IMP-5) -------------------------------------------------------------------------------------

/**
 * The source's head shape, measured and matched on Spec as Face Shape edits (headMatch). The source's head
 * never comes in; the person accepts or declines the edits. Both heads are read as headMatch reads them
 * (head skin only, with landmarks, so the donor is aligned onto Spec); a source not named the VRoid way
 * has its face found by its parts' shape against Spec (donorParts.js). → { shapes, headSize, before,
 * after } or null when either head can't be scanned.
 */
export function matchSourceHead(source, specJsonBin) {
  const { vroid, parts } = guessDonorParts(source.json, source.bin, { base: specJsonBin });
  const donor = scanMatchHead(source.json, source.bin, vroid ? null : parts);
  const base = scanMatchHead(specJsonBin.json, specJsonBin.bin);
  if (!donor || !base) return null;
  const r = matchHead(base, donor);
  const round = (v) => Math.round(v * 100) / 100;
  return { shapes: r.shapes, headSize: r.headSize, before: round(r.before), after: round(r.after) };
}

/** The head match as edits for the character: [[path, value]] for setEdits (EDITS.md §3.5, §4). */
export function headEdits(head) {
  if (!head) return [];
  const out = Object.entries(head.shapes || {}).map(([k, v]) => [`face.shapes.${k}`, v]);
  if (Number.isFinite(head.headSize) && head.headSize !== 0) out.push(['body.headSize', head.headSize]);
  return out;
}

/** Offer, accept or decline the head match. */
export function setHead(doc, head, status = 'offered', { opts } = {}) {
  const d = clone(doc);
  d.head = head ? { ...clone(head), status } : null;
  return touched(d, opts);
}

// ---- building a group's item ------------------------------------------------------------------------------

const prims = (g) => g.pieces.map((id) => id.split('/').map(Number));

/** The rig cache: Spec's skeleton and the donor's, measured once per source. */
export function importRigs(source, spec) {
  const s = spec.bind ? spec : specRig(spec);
  const d = donorRig(source.json);
  return { spec: s, donor: d, lift: measureLift(d, s), head: headFit(source, s) };
}

// The donor's head against Spec's (both scanned as headMatch scans them): centre to centre, and Spec's size over
// the donor's, for what the head carries. null when either can't be scanned (a model not named the VRoid way).
function headFit(source, spec) {
  try {
    const a = faceLandmarks(source.json, source.bin)?.head;
    const b = spec._head ??= faceLandmarks(spec.json, spec.bin)?.head ?? null;
    if (!a || !b) return null;
    const k = headScale(b.R) / headScale(a.R);
    if (!(k > 0.75 && k < 1.33)) return null;
    return { from: a.c.slice(), to: b.c.slice(), k: Math.round(k * 1e4) / 1e4 };
  } catch { return null; }
}

/**
 * Spec's and the donor's fitting contexts (FITTING.md §7), measured once per source and kept on the rigs.
 * → { spec, donor } (donor may be { refused })
 */
export function fitContexts(source, rigs) {
  if (!rigs.fit) {
    const spec = rigs.spec._fitCtx ??= specContext({ json: rigs.spec.json, bin: rigs.spec.bin });
    // a source whose names say nothing about its skin has it found by shape against Spec (donorParts.js)
    const names = source.bodyMats?.size ? null : guessDonorParts(source.json, source.bin);
    const noNames = names && !names.parts.some((p) => p.role === 'body' || p.role === 'face');
    const base = noNames ? { json: rigs.spec.json, bin: rigs.spec.bin } : undefined;
    rigs.fit = { spec, donor: donorContext(source.json, source.bin, spec, { bodyMats: source.bodyMats, base }) };
  }
  return rigs.fit;
}

/** Does a group's type come onto Spec by Spec-fit (tops, bottoms, one-pieces and coats: VRMXW §7, §14)? */
export const comesBySpecFit = (group) => fitFor(group.type)?.method === 'spec-fit' && SPEC_FIT_SLOTS.includes(group.slot);

/**
 * A group's model on Spec (what panel 3 shows, and what is written): cut from the source by the one item
 * writer (MToon and springs kept, ITM-2), moved onto Spec by its bones (the shoe lift with it), then, for a
 * garment, given its place around Spec's body by Spec-fit (FITTING.md §7: it no longer keeps the donor's
 * girth), then placed. opts.specFit: false keeps the bones' result.
 * → { glb, rig, centre (before the place), travel, moves, springs, colliders, meshes, fit: 'spec-fit' | 'bones', fitWhy?, fitStats?,
 *     verdict? ({ verdict, reasons, figures }: fit/verdict.js, for a garment) }
 */
export function groupModel(source, group, rigs, { specFit = true } = {}) {
  const kind = group.kind === 'pin' ? 'pin' : 'worn';
  const cut = extractItemModel({ json: source.json, bin: source.bin }, {
    prims: prims(group), kind, attach: kind === 'pin' ? group.attach : undefined, name: group.name.replace(/[^\w-]+/g, '_'),
    bodyBones: source.bodyBones || [],
    generator: GENERATOR,
  });
  const moved = moveOntoSpec(cut.glb, cut.rig.humanBones, rigs.spec, { head: rigs.head });
  let glb = moved.glb, fit = 'bones', fitWhy = null, fitStats = null, verdict = null;
  if (specFit && kind === 'worn' && comesBySpecFit(group)) {
    const ctx = fitContexts(source, rigs);
    try {
      const r = garmentOntoSpec(cut.glb, moved.glb, cut.rig.humanBones, ctx.donor, ctx.spec, fitFor(group.type));
      glb = r.glb; fit = r.method; fitWhy = r.reason || null; verdict = r.verdict || null;
      if (r.stats) fitStats = { ms: Math.round(r.stats.ms * 10) / 10, pushed: r.stats.pushed, vertices: r.stats.vertices, estimated: r.estimated || [], warnings: r.stats.warnings || [] };
    } catch (e) { fitWhy = e.message || String(e); verdict = fitVerdict({ refused: fitWhy }); }
  } else if (kind === 'worn' && comesBySpecFit(group) === false && fitFor(group.type)?.method === 'spec-fit') fitWhy = 'Spec-fit covers tops, bottoms, one-pieces and coats';
  const centre = itemCentre(glb);
  const placed = placeItemModel(glb, group.place, { centre });
  return { glb: placed.glb, rig: cut.rig, centre, travel: moved.travel, moves: moved.moves, springs: cut.springs, colliders: cut.colliders, meshes: cut.meshes, fit, fitWhy, fitStats, verdict };
}

/** Where the travel is largest, as words for the panel ("2.1 cm at the left upper arm"). */
export function travelText(moves) {
  const top = Object.entries(moves || {}).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const words = top[0].replace(/([A-Z])/g, ' $1').toLowerCase();
  return { bone: top[0], metres: top[1], text: `${(top[1] * 100).toFixed(1)} cm at the ${words}` };
}

/**
 * The item a group becomes (IMP-10): a .vrmxw with the source's licence and origin (IMP-4, ITM-8, ITM-9), the
 * shoes' lift recorded (ITM-11), validated against Spec (ITM-12). Refused (ImportError) when it fails.
 *   opts: { spec (spec.vrm bytes, for the bind check), id, created, generator }
 * → { item, bytes, problems, model }
 */
export async function groupItem(source, doc, group, rigs, opts = {}) {
  const model = groupModel(source, group, rigs, { specFit: opts.specFit !== false });
  const type = group.type;
  const fit = fitFor(type);
  const lift = group.slot === 'shoes' ? rigs.lift.lift : undefined;
  const origin = {
    made: 'extracted',
    source: source.file,
    sha256: source.sha256,
    vrm: source.vrm,
    pieces: group.pieces.map((id) => source.pieces.find((p) => p.id === id)?.material || id),
    fit: model.fit, // spec-fit for a garment Spec-fit could bring on, else bones (VRMXW §11, W20)
    lift: rigs.lift.lift,
    ...(rigs.head && model.rig.humanBones.head !== undefined ? { headScale: rigs.head.k } : {}),
    importer: opts.generator || GENERATOR,
  };
  origin.converted = source.vrm === '0.x'; // VRMXW §4 origin (SPEC-QUESTIONS #37)
  if (source.makerFrom === 'listing') origin.makerFrom = 'listing';
  const item = await createItem({
    model: model.glb, name: group.name, type, slot: group.slot, kind: group.kind, attach: group.attach || undefined,
    layer: group.layer || 0, tags: group.tags || [], rig: model.rig, meta: clone(source.meta), fit,
    lift, listing: source.listing, origin, base: standardBase('human'), generator: opts.generator,
    id: opts.id || group.item?.id || newUuid(), created: opts.created,
  });
  if (type === 'shoes') item.manifest.fit.lift = lift ?? 0;
  const bytes = await writeItem(item);
  const problems = await checkItem(bytes, { spec: opts.spec });
  if (problems.some((p) => p.severity === 'error')) {
    const e = new ImportError('import.invalid', `${group.name} did not pass the item checks: ${problems.filter((p) => p.severity === 'error').slice(0, 3).map((p) => p.message).join('; ')}`);
    e.problems = problems;
    throw e;
  }
  return { item, bytes, problems, model };
}

/**
 * Write every approved group not yet written. → { doc (each written group with its `item`, the record
 * extended), items: [{ group, item, bytes, problems, fileName }] }. A group that fails stops nothing else;
 * its error is returned in `failed`.
 */
export async function importApproved(doc, source, rigs, opts = {}) {
  const d = clone(doc);
  const items = [], failed = [];
  for (const g of d.groups) {
    if (g.status !== 'approved' || g.item) continue;
    try {
      const r = await groupItem(source, d, g, rigs, opts);
      const m = r.item.manifest;
      const fileName = `${m.slot}-${slug(m.name)}.vrmxw`;
      g.item = { id: m.id, revision: m.revision, sha256: await sha256(r.bytes), file: fileName };
      d.record.push({ at: now(opts), group: g.id, item: m.id, name: m.name, type: m.type, file: fileName, pieces: clone(m.origin.pieces) });
      items.push({ group: g.id, ...r, fileName });
    } catch (e) {
      failed.push({ group: g.id, name: g.name, error: e.message, problems: e.problems || [] });
    }
  }
  return { doc: touched(d, opts), items, failed };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

/**
 * What was taken from which file (IMP-12), for keeping beside the items or in a working folder:
 * { source, taken: [...], skipped: [...], waiting: [...], head }.
 */
export function importRecord(doc) {
  const of = (st) => doc.groups.filter((g) => g.status === st);
  return {
    format: 'vrmxa-import-record', version: 1,
    source: clone(doc.source),
    taken: doc.record.map((r) => clone(r)),
    skipped: of('skipped').map((g) => ({ group: g.id, name: g.name, pieces: g.pieces.length })),
    waiting: of('waiting').map((g) => ({ group: g.id, name: g.name, pieces: g.pieces.length })),
    head: doc.head ? { status: doc.head.status, shapes: clone(doc.head.shapes), headSize: doc.head.headSize } : null,
    updated: doc.updated,
  };
}

export { typeName, ITEM_TYPES };
