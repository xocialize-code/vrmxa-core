// .vrmxa, bundle version 5 (VRMXA-base-draft.md §1 to §5, §7.4, §8.4, §9.2, §12), and the earlier
// versions 2 to 4, read and brought forward (§1; PRD CHR-2).
//
// A bundle is { kind: 'vrmxa', manifest, entries, docs, database, skipped, problems, upgradedFrom }:
//   manifest — vrmxa.json as an object; unknown keys are kept and written back (§2 rule 5)
//   entries  — Map(path → bytes) of every other entry. This is the bundle's content: a section
//              document is changed with setDocument, which writes its bytes here, so an entry nobody
//              changed is written back byte for byte, unknown ones included
//   docs     — the section documents parsed: edits, measurements, eyes, mouth, closet, animations,
//              voices (null when absent or skipped)
//   database — character.sqlite's rows (database.js readCharacterDb), or null
//   skipped  — sections opened without, because their version is newer than this reader (§2 rule 4)
//   problems — the checker's warnings
// writeBundle is a pure serializer: it recomputes `files` and `avatar.of` and nothing else, so a
// bundle read and written again gives the same bytes. touchBundle marks a save (revision, updated).
//
// The manifest's `meta` and `header` blocks and the version 2 to 4 manifest fields are read; a missing
// version is 1 (VRMXA §3). The packer and unpacker write the version 5 layout.

import { clone, isPlainObject, jsonBytes, newUuid, nowIso, parseJson, UUID_RE } from './bytes.js';
import { bundleRank, inventory, manifestOf, orderPaths, packZip } from './container.js';
import { readCharacterDb, writeCharacterDb } from './database.js';
import { isGlb, parseGlb } from './glb.js';
import { sha12, sha256 } from './hash.js';
import {
  BIN_ENCODING_VERSION, BUNDLE_VERSION, DOCUMENTS, documentPaths, META_DATA_VERSION, SECTION_VERSIONS, VRMXA_MANIFEST, closetItemPath,
} from './layout.js';
import { findBase, standardBase } from './vocab.js';
import { closetEntryFor, itemFromBareGlb, RefusedError, writeItem } from './vrmxw.js';
import { isZip, scanZip, storedByDefault } from './zip.js';

export const GENERATOR = 'VRMXA reference library (vrmxa-core 0.1.0)';

/** A missing version means version 1; a version below 1 is a problem (versionProblem) and is read as 1. */
export const normalizeVersion = (v) => (Number.isInteger(v) && v > 1 ? v : 1);

/** The problem a stated version below 1 (or not a whole number) is, or null. */
export function versionProblem(v, where = 'manifest.json') {
  if (v === undefined || v === null || (Number.isInteger(v) && v >= 1)) return null;
  return { severity: 'warning', where, code: 'version.below-one', message: `states version ${JSON.stringify(v)}, read as version 1` };
}

/** Title and author from a VRM 1.0's own metadata (§4: the manifest keeps copies). */
export function vrmMetaOf(bytes) {
  try {
    const { json } = parseGlb(bytes);
    const m = json.extensions?.VRMC_vrm?.meta;
    return { title: m?.name ?? '', author: Array.isArray(m?.authors) ? m.authors.join(', ') : '', vrm: m ? '1.0' : json.extensions?.VRM ? '0.x' : '' };
  } catch {
    return { title: '', author: '', vrm: '' };
  }
}

/**
 * A new character (PRD CHR-4: a new `id` and `fileId`). Required: avatar (a VRM 1.0's bytes).
 * base: a bases.json entry or { name, species, sha256 }; the standard Spec when absent.
 * thumbnail: PNG bytes. The manifest is laid out as §4 shows it.
 */
export function createBundle({ avatar, base, thumbnail, title, author, id, fileId, created, generator = GENERATOR } = {}) {
  if (!avatar || !isGlb(avatar)) throw new Error('avatar must be the bytes of a VRM 1.0 (GLB)');
  const meta = vrmMetaOf(avatar);
  if (meta.vrm !== '1.0') throw new Error('avatar.vrm must be a VRM 1.0 (§13.1, D27)');
  const b = base || standardBase('human');
  const now = created || nowIso();
  const manifest = {
    format: 'vrmxa',
    version: BUNDLE_VERSION,
    meta: { metaDataVersion: META_DATA_VERSION, schemaVersion: BUNDLE_VERSION, binEncodingVersion: BIN_ENCODING_VERSION },
    id: id || newUuid(),
    fileId: fileId || newUuid(),
    revision: 1,
    title: title ?? meta.title,
    author: author ?? meta.author,
    created: now,
    updated: now,
    generator,
    thumbnail: thumbnail ? 'thumbnail.png' : null,
    base: { name: b.name, species: b.species || 'human', vrm: b.vrm || '1.0', sha256: b.sha256 },
    avatar: { header: { id: newUuid(), resourceName: 'Avatar', formatVersion: 1 }, file: 'avatar.vrm', vrm: '1.0', of: { base: b.sha256, edits: null, closet: null } },
    database: null,
    sections: {},
    files: [],
  };
  const entries = new Map([['avatar.vrm', avatar]]);
  if (thumbnail) entries.set('thumbnail.png', thumbnail);
  return { kind: 'vrmxa', manifest, entries, docs: emptyDocs(), database: null, skipped: [], problems: [], upgradedFrom: null, avatarCurrent: true };
}

const emptyDocs = () => Object.fromEntries(Object.keys(DOCUMENTS).map((k) => [k, null]));

/**
 * Put a section document into the bundle: its bytes into entries, its place into manifest.sections
 * (§4). role: edits, measurements, eyes, mouth, closet, animations or voices. null removes it.
 */
export function setDocument(bundle, role, doc) {
  const d = DOCUMENTS[role];
  if (!d) throw new Error(`unknown section document "${role}"`);
  const s = (bundle.manifest.sections ||= {});
  const path = documentPaths(bundle.manifest)[role]?.path || d.path;
  if (doc === null) {
    bundle.entries.delete(path);
    bundle.docs[role] = null;
    if (d.section === 'appearance') {
      if (s.appearance) delete s.appearance[role];
      if (s.appearance && Object.keys(s.appearance).every((k) => k === 'version')) delete s.appearance;
    } else delete s[d.section];
    return bundle;
  }
  if (doc.format !== d.format) throw new Error(`${role}: format must be "${d.format}"`);
  bundle.entries.set(path, jsonBytes(doc));
  bundle.docs[role] = clone(doc);
  if (role === 'edits' || role === 'closet') bundle.avatarCurrent = false; // the look may have changed: avatar.vrm is redrawn with setAvatar
  if (d.section === 'appearance') {
    s.appearance ||= { version: SECTION_VERSIONS.appearance };
    s.appearance[role] = { file: path, format: d.format, version: doc.version ?? d.version };
    // keep appearance's keys in the order §4 shows: version, edits, measurements, eyes, mouth
    const order = ['version', 'edits', 'measurements', 'eyes', 'mouth'];
    s.appearance = Object.fromEntries(Object.entries(s.appearance).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
  } else if (role === 'closet') s.closet = { version: SECTION_VERSIONS.closet, file: path, vrmxw: 1 };
  else if (role === 'animations') s.animations = { version: SECTION_VERSIONS.animations, file: path };
  else if (role === 'voices') s.voice = { version: SECTION_VERSIONS.voice, file: path };
  const order = ['appearance', 'closet', 'animations', 'voice', 'persona'];
  bundle.manifest.sections = Object.fromEntries(Object.entries(s).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
  return bundle;
}

/** Put or replace any other entry (a model, a picture, a clip). null removes it. */
export function setEntry(bundle, path, bytes) {
  if (path === VRMXA_MANIFEST) throw new Error('the manifest is written by writeBundle');
  if (bytes === null) bundle.entries.delete(path);
  else bundle.entries.set(path, bytes);
  return bundle;
}

/**
 * Write character.sqlite from data ({ persona, examples, listing, settings }, database.js) and record
 * it in the manifest, with the persona section (§10, §12). null removes the database.
 */
export async function setDatabase(bundle, data) {
  const s = (bundle.manifest.sections ||= {});
  if (data === null) {
    bundle.entries.delete('character.sqlite');
    bundle.manifest.database = null;
    delete s.persona;
    bundle.database = null;
    return bundle;
  }
  const bytes = await writeCharacterDb(data);
  bundle.entries.set('character.sqlite', bytes);
  bundle.manifest.database = { file: 'character.sqlite', schema: 1 };
  if (data.persona) s.persona = { version: SECTION_VERSIONS.persona };
  const order = ['appearance', 'closet', 'animations', 'voice', 'persona'];
  bundle.manifest.sections = Object.fromEntries(Object.entries(s).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
  bundle.database = (await readCharacterDb(bytes)).data;
  return bundle;
}

/** Replace avatar.vrm (the character as last configured, §5.2); the manifest's title and author follow its metadata. */
export function setAvatar(bundle, bytes) {
  const meta = vrmMetaOf(bytes);
  if (meta.vrm !== '1.0') throw new Error('avatar.vrm must be a VRM 1.0');
  bundle.entries.set(bundle.manifest.avatar?.file || 'avatar.vrm', bytes);
  bundle.manifest.title = meta.title;
  bundle.manifest.author = meta.author;
  bundle.avatarCurrent = true;
  return bundle;
}

/** Mark a save: the next revision and the time (§4). */
export function touchBundle(bundle, { now = nowIso() } = {}) {
  bundle.manifest.revision = (Number.isInteger(bundle.manifest.revision) ? bundle.manifest.revision : 0) + 1;
  bundle.manifest.updated = now;
  return bundle;
}

/** PRD CHR-4 and §4.1: another file of the same character (same id, new fileId). */
export function saveAsAnotherVersion(bundle) {
  bundle.manifest.fileId = newUuid();
  return bundle;
}

/** §4.1: a clone that is a different character (both ids new), or give this copy a new identity. */
export function newIdentity(bundle) {
  bundle.manifest.id = newUuid();
  bundle.manifest.fileId = newUuid();
  return bundle;
}

const store = (path) => storedByDefault(path);

/** The hashes avatar.vrm is made from (§4, `avatar.of`): the base, edits.json and closet.json. */
export async function avatarOf(bundle) {
  const paths = documentPaths(bundle.manifest);
  const h = async (role) => (paths[role] && bundle.entries.has(paths[role].path) ? sha256(bundle.entries.get(paths[role].path)) : null);
  return { base: bundle.manifest.base?.sha256 ?? null, edits: await h('edits'), closet: await h('closet') };
}

async function finalManifest(bundle, { avatarOf: mode } = {}) {
  const order = orderPaths([...bundle.entries.keys()].filter((p) => p !== VRMXA_MANIFEST), bundleRank);
  const manifest = clone(bundle.manifest);
  // avatar.of says what avatar.vrm was made from. It is recomputed only when avatar.vrm is known to
  // show the current base, edits and closet: set by createBundle and setAvatar, cleared by changing
  // edits or closet. Otherwise it is kept as read, so a stale avatar is never reported as current.
  // An app that changes closet.json without changing the look (adding a spare) passes
  // avatarOf: 'recompute' (VRMXA §4).
  if ((mode ?? (bundle.avatarCurrent ? 'recompute' : 'keep')) === 'recompute' && isPlainObject(manifest.avatar)) {
    const of = await avatarOf(bundle);
    manifest.avatar.of = isPlainObject(manifest.avatar.of) ? { ...manifest.avatar.of, ...of } : of;
  }
  manifest.files = await inventory(bundle.entries, order, bundle.manifest.files);
  return { manifest, order };
}

/**
 * Pack a bundle: vrmxa.json first, the entries in the layout's order (§3.3), closet items and
 * pictures stored, the rest deflated; `files` and `avatar.of` recomputed. The same bundle gives the
 * same bytes. opts.avatarOf: 'recompute' or 'keep'; by default it is recomputed only when avatar.vrm is
 * known to be current (bundle.avatarCurrent), and kept otherwise.
 */
export async function writeBundle(bundle, opts = {}) {
  const { manifest, order } = await finalManifest(bundle, opts);
  bundle.manifest = manifest;
  return packZip(VRMXA_MANIFEST, manifest, bundle.entries, order, { store });
}

/** The open form: Map(path → bytes) with vrmxa.json first and `files` recomputed. */
export async function bundleToEntries(bundle, opts = {}) {
  const { manifest, order } = await finalManifest(bundle, opts);
  bundle.manifest = manifest;
  const out = new Map([[VRMXA_MANIFEST, jsonBytes(manifest)]]);
  for (const p of order) out.set(p, bundle.entries.get(p));
  return out;
}

/**
 * Read a bundle, packed (bytes) or open (Map of path → bytes). It is checked first (§3.5): any
 * error refuses it as a whole (RefusedError, with every problem). Versions 2 to 4 are brought
 * forward to version 5 in memory (bundle.upgradedFrom says from which).
 * opts: { limits, bases, spec, idFactory, now } — see checkBundle; idFactory makes new UUIDs.
 */
export async function readBundle(input, opts = {}) {
  const { checkBundle } = await import('./checker.js');
  const problems = await checkBundle(input, opts);
  if (problems.some((p) => p.severity === 'error')) throw new RefusedError('the bundle', problems);
  const map = input instanceof Map ? input : new Map(scanZip(input, { limits: opts.limits }).entries.map((e) => [e.name, e.data]));
  const { manifest } = manifestOf(map, VRMXA_MANIFEST);
  const stated = manifest.meta?.schemaVersion ?? manifest.version;
  const v = normalizeVersion(stated);
  const bundle = v === BUNDLE_VERSION ? await bundleFromEntries(map) : await upgradeLegacy(map, manifest, v, opts);
  bundle.problems.push(...problems);
  const vp = versionProblem(stated);
  if (vp) bundle.problems.push(vp);
  return bundle;
}

/**
 * A version 5 bundle from its open form, without checking it (readBundle checks). Section documents
 * newer than this reader knows are skipped, not parsed (§2 rule 4); their entries are kept.
 */
export async function bundleFromEntries(map) {
  const m = manifestOf(map, VRMXA_MANIFEST);
  if (m.error) throw new Error(m.error);
  const manifest = m.manifest;
  const entries = new Map([...map].filter(([p]) => p !== VRMXA_MANIFEST));
  const bundle = { kind: 'vrmxa', manifest, entries, docs: emptyDocs(), database: null, skipped: [], problems: [], upgradedFrom: null, avatarCurrent: false };
  const sections = isPlainObject(manifest.sections) ? manifest.sections : {};
  for (const [name, known] of Object.entries(SECTION_VERSIONS)) {
    const s = sections[name];
    if (isPlainObject(s) && normalizeVersion(s.version) > known) bundle.skipped.push({ section: name, reason: `section version ${s.version} is newer than this reader knows (${known})` });
  }
  const skippedSections = new Set(bundle.skipped.map((s) => s.section));
  for (const [role, loc] of Object.entries(documentPaths(manifest))) {
    const d = DOCUMENTS[role];
    if (skippedSections.has(d.section)) continue;
    const raw = entries.get(loc.path);
    if (!raw) continue;
    const r = parseJson(raw);
    if (r.error || !isPlainObject(r.value)) continue;
    if (normalizeVersion(r.value.version) > d.version) {
      bundle.skipped.push({ section: role, reason: `${role} document version ${r.value.version} is newer than this reader knows (${d.version})` });
      continue;
    }
    bundle.docs[role] = r.value;
  }
  if (isPlainObject(manifest.database) && Number.isInteger(manifest.database.schema) && manifest.database.schema > 1) {
    // D29: a newer database schema is skipped, not refused; the file stays in entries and is written back
    bundle.skipped.push({ section: 'persona', reason: `database schema ${manifest.database.schema} is newer than this reader knows (1)` });
  } else if (isPlainObject(manifest.database) && entries.has(manifest.database.file) && !skippedSections.has('persona')) {
    const r = await readCharacterDb(entries.get(manifest.database.file));
    bundle.database = r.data;
  }
  return bundle;
}

const vrmaDuration = (bytes) => {
  try {
    const { json } = parseGlb(bytes);
    let d = 0;
    for (const a of json.animations || []) for (const s of a.samplers || []) d = Math.max(d, json.accessors?.[s.input]?.max?.[0] ?? 0);
    const ext = json.extensions?.VRMC_vrm_animation || {};
    const tracks = ['humanoid', 'expressions', 'lookAt'].filter((k) => ext[k]);
    return { duration: d || null, tracks: tracks.length ? tracks : ['humanoid'] };
  } catch {
    return { duration: null, tracks: ['humanoid'] };
  }
};

/**
 * Bring a version 2, 3 or 4 bundle forward to version 5, in memory (§1; PRD CHR-2):
 *   body.vrm      → the base, named by hash; it must be a published Spec (the checker makes sure)
 *   avatar.vrm    → the unedited body for now: edits and worn items are not written in, because that
 *                   takes the fitting code. avatar.of names only the base (and is kept
 *                   on writing), so a reader can see it doesn't match the edits and closet yet
 *   edits.json    → appearance/edits.json; its `items` (fits keyed by file hash) move to each closet
 *                   item's fitting.adjust, keyed by id (EDITS.md §5)
 *   items/*.vrmxw → each bare GLB packed as a version 1 .vrmxw (VRMXW §14); the `worn` ones are worn
 *   animations    → (version 4) each .vrma becomes a clip in a default set; the editable motion
 *                   documents have no place in version 5 and are kept at their old paths, unread
 */
async function upgradeLegacy(map, old, v, opts = {}) {
  const idf = opts.idFactory || newUuid;
  const now = opts.now || nowIso();
  const notes = [];
  const note = (code, message, where = '') => notes.push({ severity: 'info', where, code, message });
  const bodyPath = old.body?.file || 'body.vrm';
  const body = map.get(bodyPath);
  const bodySha = await sha256(body);
  const base = findBase(bodySha, opts.bases);
  const bundle = createBundle({
    avatar: body, base, title: old.title || '', author: old.author || '', id: UUID_RE.test(old.id || '') ? old.id : idf(), fileId: idf(), created: old.created || now,
  });
  bundle.manifest.revision = Number.isInteger(old.revision) ? old.revision : 1;
  bundle.manifest.updated = old.updated || now;
  bundle.manifest.avatar.of = { base: bodySha, edits: null, closet: null };
  bundle.upgradedFrom = v;
  note('legacy.avatar', `brought forward from bundle version ${v}: avatar.vrm is the unedited Spec for now, without the edits or what is worn. An app that can fit must redraw it before the bundle is shared (CLOSET.md C6)`, 'avatar.vrm');
  if (old.thumbnail && map.has(old.thumbnail)) {
    bundle.entries.set(old.thumbnail, map.get(old.thumbnail));
    bundle.manifest.thumbnail = old.thumbnail;
  }
  // items → closet
  const closet = { format: 'vrmxa-closet', version: 1, hair: null, worn: { items: [], states: {}, outfit: null }, items: [], outfits: [] };
  const idOfFileHash = new Map();
  for (const it of Array.isArray(old.items) ? old.items : []) {
    const raw = map.get(it.file);
    const slot = it.category === 'hair' ? 'hair' : it.slot || 'accessory';
    const id = UUID_RE.test(it.header?.id || '') ? it.header.id : idf();
    let item;
    if (isZip(raw)) {
      const { readItem } = await import('./vrmxw.js');
      item = await readItem(raw, opts);
    } else {
      item = await itemFromBareGlb(raw, { slot, name: it.name, id, base, created: now });
      note('legacy.item', `packed from a bare GLB as a version 1 .vrmxw; slot "${slot}" and type "${item.manifest.type}" are guesses to confirm, and the donor's shoe lift was not taken out`, it.file);
    }
    const bytes = isZip(raw) ? raw : await writeItem(item); // an item already in the ZIP form stays as it arrived (C1)
    const file = closetItemPath(item.manifest.slot, item.manifest.id);
    bundle.entries.set(file, bytes);
    closet.items.push(await closetEntryFor(item, { file }));
    idOfFileHash.set(it.sha256 || (await sha256(raw)), item.manifest.id);
    if (it.worn !== false) {
      if (item.manifest.slot === 'hair') closet.hair = item.manifest.id;
      else closet.worn.items.push(item.manifest.id);
    }
  }
  // edits → appearance/edits.json, with item fits moved to the closet
  if (old.edits && map.has(old.edits.file || 'edits.json')) {
    const raw = map.get(old.edits.file || 'edits.json');
    const r = parseJson(raw);
    if (!r.error && isPlainObject(r.value) && isPlainObject(r.value.items)) {
      const doc = clone(r.value);
      for (const [key, adjust] of Object.entries(doc.items)) {
        const id = idOfFileHash.get(key);
        const entry = closet.items.find((e) => e.id === id);
        if (entry) entry.fitting = { auto: true, adjust: clone(adjust) };
        else note('legacy.fit-dropped', `a fit for the item ${key.slice(0, 12)}… had no item in the bundle and was left out`, 'edits.json → items');
      }
      delete doc.items;
      setDocument(bundle, 'edits', doc);
      note('legacy.fits-moved', 'the per-item fits in edits.json moved to each item\'s fitting.adjust in closet.json (EDITS.md §5)', 'appearance/edits.json');
    } else if (!r.error && isPlainObject(r.value)) {
      bundle.entries.set('appearance/edits.json', raw); // unchanged, byte for byte
      bundle.manifest.sections.appearance = { version: 1, edits: { file: 'appearance/edits.json', format: 'vrmxa-edits', version: r.value.version } };
      bundle.docs.edits = r.value;
    }
  }
  if (closet.items.length) setDocument(bundle, 'closet', closet);
  // version 4 animations → clips in a default set; motion documents kept as they are
  const anims = Array.isArray(old.animations) ? old.animations : [];
  if (anims.length) {
    const doc = { format: 'vrmxa-animations', version: 1, clips: [], sets: [] };
    const slots = {};
    for (const a of anims) {
      if (a.motion?.file && map.has(a.motion.file)) {
        bundle.entries.set(a.motion.file, map.get(a.motion.file));
        note('legacy.motion-kept', 'an editable motion document has no place in version 5 yet (PRD OQ-7); kept unread at its old path', a.motion.file);
      }
      const vb = a.vrma?.file ? map.get(a.vrma.file) : null;
      if (!vb) continue;
      const h = await sha256(vb);
      const file = `animations/clips/${sha12(h)}.vrma`;
      bundle.entries.set(file, vb);
      const { duration, tracks } = vrmaDuration(vb);
      doc.clips.push({ sha256: h, file, name: a.name || null, duration, loops: null, rootMotion: null, speed: null, tracks, source: `bundle version 4 motion "${a.name || a.id}"`, licence: null });
      const slot = `x-xocialize.motion-${String(a.id || doc.clips.length).replace(/[^A-Za-z0-9._-]/g, '_')}`;
      slots[slot] = [{ clip: h }];
    }
    if (doc.clips.length) {
      const idle = doc.clips.find((c) => /idle/i.test(c.name || '')) || doc.clips[0];
      doc.sets.push({ id: idf(), name: 'Default', default: true, priority: 0, requires: [], slots: { idle: [{ clip: idle.sha256 }], ...slots } });
      setDocument(bundle, 'animations', doc);
      note('legacy.animations', `the version 4 motions became ${doc.clips.length} clip(s) in a default set; "${idle.name}" plays as idle`, 'animations/animations.json');
    }
  }
  // anything else the old bundle held that this reader doesn't place is kept (§2 rule 5)
  const placed = new Set([VRMXA_MANIFEST, bodyPath, old.edits?.file || 'edits.json', ...(old.items || []).map((i) => i.file), ...anims.flatMap((a) => [a.motion?.file, a.vrma?.file])]);
  for (const [p, b] of map) if (!placed.has(p) && !bundle.entries.has(p)) bundle.entries.set(p, b);
  bundle.avatarCurrent = false; // the unedited Spec stands in until an app that can fit redraws it
  bundle.problems.push(...notes);
  return bundle;
}
