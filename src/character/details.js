// A character's details, licence and origin (VRMXA §5.3; PRD LIC-1 to LIC-4, CHR-4).
//
//   - The details are avatar.vrm's own `VRMC_vrm.meta`: name, version, authors, copyright, contact, references, the
//     licence and the permissions. They are edited in place in the model's JSON (the binary chunk is kept byte for
//     byte), and carried into every avatar.vrm drawn afterwards (closet/avatar.js `characterMeta`).
//   - The origin is character.sqlite's `listing` row: url, marketplace, listing id. No price (§5.3).
//   - A new character starts at VRM's most restricted permissions, not Spec's (LIC-3): `newCharacterMeta`. Whether the
//     person has chosen them is kept as the setting `x-xocialize.permissions-chosen` (the time), so the app can say
//     "nothing is allowed until you choose it".
//   - "Each character sets its own permissions, never looser than Spec's or its parts' allow" (§5.3): `permissionLimits`
//     gives, for each permission, the loosest value the worn pieces and the base allow and which pieces hold it there;
//     `setDetails` refuses a looser one, naming the piece.

import { clone, isPlainObject, nowIso } from '../bytes.js';
import { buildGlb, parseGlb } from '../glb.js';
import { setDatabase, setDocument } from '../vrmxa.js';
import { META_BOOLEANS, META_ENUMS, META_STRINGS } from '../vocab.js';
import { ORDER, PERMISSION_KEYS, RESTRICTED, SPEC_PERMISSIONS, looserThanPieces, permissionsOf, rank, wordsFor } from './terms.js';

export const VRM_LICENCE = 'https://vrm.dev/licenses/1.0/';
export const PERMISSIONS_CHOSEN = 'x-xocialize.permissions-chosen';
export const HONOURED_PREFIX = 'x-xocialize.honoured.';

/** The fields of VRMC_vrm.meta a person edits as the character's details (§5.3). thumbnailImage is the model's own. */
export const DETAIL_KEYS = Object.freeze([
  'name', 'version', 'authors', 'copyrightInformation', 'contactInformation', 'references',
  'licenseUrl', 'otherLicenseUrl', 'thirdPartyLicenses', ...PERMISSION_KEYS,
]);

export class DetailsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DetailsError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new DetailsError(code, message); };

/** The details a new character starts with (LIC-3): its name and makers, VRM's licence, every permission at its strictest. */
export function newCharacterMeta({ name = 'Untitled', authors = ['VRMXA Avatar Studio'], version = '1' } = {}) {
  return { name, version, authors: [...authors], licenseUrl: VRM_LICENCE, ...RESTRICTED };
}

const avatarPath = (bundle) => bundle.manifest.avatar?.file || 'avatar.vrm';

/** avatar.vrm's VRMC_vrm.meta as it stands (a copy), or null. */
export function avatarMeta(bundle) {
  const bytes = bundle.entries.get(avatarPath(bundle));
  if (!bytes) return null;
  try {
    const m = parseGlb(bytes).json.extensions?.VRMC_vrm?.meta;
    return m ? clone(m) : null;
  } catch {
    return null;
  }
}

// ---- character.sqlite, kept whole ----------------------------------------------------------------------
/** The database's rows in the form writeCharacterDb takes, or empty ones. */
export function databaseData(bundle) {
  const d = bundle.database;
  return {
    persona: d?.persona ? { ...d.persona } : null,
    examples: (d?.examples || []).map((e) => ({ ...e })),
    listing: d?.listing ? { url: d.listing.url ?? null, marketplace: d.listing.marketplace ?? null, listing_id: d.listing.listing_id ?? null } : null,
    settings: { ...(d?.settings || {}) },
  };
}

/**
 * Write the database back from data, or drop it when nothing is left (§3.3: present when the bundle has a persona, an
 * origin or settings). A database this reader skipped (a newer schema) is never written over (§2 rule 5).
 */
export async function writeDatabase(bundle, data) {
  if (bundle.skipped?.some((s) => s.section === 'persona')) fail('database-skipped', 'character.sqlite has a newer schema than this app knows: it is kept as it is and can\'t be changed here (VRMXA §12)');
  const empty = !data.persona && !data.examples.length && !data.listing && !Object.keys(data.settings).length;
  await setDatabase(bundle, empty ? null : data);
  return bundle;
}

// ---- the limits the base and the worn pieces set ------------------------------------------------------
/**
 * For each permission, the loosest value the character may take: the strictest of the base's (avatar.vrm was drawn
 * from it; `baseMeta` when given, else Spec allows all) and of every piece merged into avatar.vrm (its
 * `extras.vrmxaPieces`, the hair piece and the worn items, D33). `avatarPermission` is the base's alone: items have
 * none (VRMXW §11).
 * → { [key]: { loosest, by: [{ id, name, value }] } }  (by: the pieces that hold it below the loosest value)
 */
export function permissionLimits(bundle, { baseMeta = null, pieces = null } = {}) {
  const list = pieces ?? partsOf(bundle);
  const out = {};
  for (const key of PERMISSION_KEYS) {
    const all = ORDER[key];
    let loosest = all[all.length - 1];
    const by = [];
    const consider = (value, who) => {
      const v = value ?? RESTRICTED[key];
      if (rank(key, v) < rank(key, loosest)) loosest = v;
      if (rank(key, v) < all.length - 1) by.push({ ...who, value: v }); // a piece that holds this permission back
    };
    if (baseMeta) consider(baseMeta[key], { id: 'base', name: baseMeta.name || 'the base' });
    if (key !== 'avatarPermission') for (const p of list) consider(p.meta?.[key], { id: p.id, name: p.name, slot: p.slot });
    out[key] = { loosest, by };
  }
  return out;
}

/** The pieces merged into avatar.vrm, from its extras.vrmxaPieces (D33): [{ id, name, slot, type, revision, state, meta, listing, origin }]. */
export function piecesOf(bundle) {
  const bytes = bundle.entries.get(avatarPath(bundle));
  if (!bytes) return [];
  try {
    const p = parseGlb(bytes).json.extras?.vrmxaPieces;
    return Array.isArray(p) ? clone(p) : [];
  } catch {
    return [];
  }
}

/**
 * The character's parts that limit its permissions (VRMXA §5.3, D35): the pieces merged into avatar.vrm, the hair piece and
 * the worn items. Read from the closet (what the next avatar.vrm will merge, so a piece just put on counts before the save
 * draws it); without a closet, from avatar.vrm's `extras.vrmxaPieces`. Spares are not parts. → [{ id, name, slot, meta }]
 */
export function partsOf(bundle) {
  const c = bundle.docs?.closet;
  if (!c) return piecesOf(bundle);
  const worn = new Set([...(c.worn?.items || []), ...(c.hair ? [c.hair] : [])]);
  return (c.items || []).filter((e) => worn.has(e.id)).map((e) => ({ id: e.id, name: e.name, slot: e.slot, meta: e.meta || null }));
}

// ---- tightening on put-on, loosening offered on take-off (VRMXA §5.3, D35) ----------------------------------------
export const TIGHTENED_PREFIX = 'x-xocialize.tightened.';

/**
 * What putting these pieces on would tighten (D35): each of the character's permissions (as shown: Spec's taken over
 * count as nothing allowed) looser than a piece allows, and what it becomes. pieces: [{ id, name, meta }].
 * → [{ key, from, to, by: [names], ids: [ids] }]
 */
export function tighteningFor(bundle, pieces, opts = {}) {
  const meta = effectiveMeta(bundle, opts);
  const out = [];
  for (const key of PERMISSION_KEYS) {
    if (key === 'avatarPermission') continue; // limited by the base alone (items have none)
    const from = meta[key] ?? RESTRICTED[key];
    let to = from;
    for (const p of pieces) if (rank(key, p.meta?.[key]) < rank(key, to)) to = p.meta?.[key] ?? RESTRICTED[key];
    if (rank(key, to) >= rank(key, from)) continue;
    const holders = pieces.filter((p) => rank(key, p.meta?.[key]) === rank(key, to));
    out.push({ key, from, to, by: holders.map((p) => p.name || p.id), ids: holders.map((p) => p.id) });
  }
  return out;
}

/** The tightening in words, one line each, for the question asked before a piece is worn. */
export const tighteningLines = (changes) => changes.map((c) => `The character's permissions are tightened: "${wordsFor(c.key, c.from)}" becomes "${wordsFor(c.key, c.to)}", as ${c.by.map((n) => `"${n}"`).join(' and ')} ${c.by.length === 1 ? 'allows' : 'allow'} (VRMXA §5.3).`);

/**
 * Tighten the character's permissions for these pieces (D35): every permission is written as shown (Spec's taken over
 * become the strictest), the looser ones set to what the pieces allow. What was tightened is kept per piece
 * (`x-xocialize.tightened.<id>`: { key: earlier value }) so taking the piece off can offer to loosen it. → the changes
 */
export async function tightenPermissions(bundle, pieces, opts = {}) {
  const changes = tighteningFor(bundle, pieces, opts);
  const state = permissionsState(bundle, opts);
  if (!changes.length && state !== 'from-spec') return [];
  const meta = effectiveMeta(bundle, opts);
  const next = Object.fromEntries(PERMISSION_KEYS.map((k) => [k, meta[k] ?? RESTRICTED[k]]));
  for (const c of changes) next[c.key] = c.to;
  const path = avatarPath(bundle);
  bundle.entries.set(path, withPermissions(bundle.entries.get(path), next));
  if (changes.length) {
    const data = databaseData(bundle);
    for (const p of pieces) {
      const mine = changes.filter((c) => c.ids.includes(p.id));
      if (!mine.length) continue;
      const key = `${TIGHTENED_PREFIX}${p.id}`;
      let had = {};
      try { had = JSON.parse(data.settings[key] || '{}'); } catch { had = {}; }
      for (const c of mine) if (!(c.key in had)) had[c.key] = c.from;
      data.settings[key] = JSON.stringify(had);
    }
    await writeDatabase(bundle, data);
  }
  return changes;
}

/**
 * What may be loosened again (D35: offered, never done on its own): for each piece no longer worn that tightened a
 * permission, the earlier value, as far as the parts still worn allow. → [{ key, from (now), to, pieces: [ids] }]
 */
export function looseningOffer(bundle, opts = {}) {
  const settings = bundle.database?.settings || {};
  const wornIds = new Set(partsOf(bundle).map((p) => p.id));
  const limits = permissionLimits(bundle, opts);
  const meta = effectiveMeta(bundle, opts);
  const byKey = new Map();
  for (const [k, v] of Object.entries(settings)) {
    if (!k.startsWith(TIGHTENED_PREFIX)) continue;
    const id = k.slice(TIGHTENED_PREFIX.length);
    if (wornIds.has(id)) continue;
    let had = {};
    try { had = JSON.parse(v); } catch { continue; }
    for (const [key, earlier] of Object.entries(had)) {
      const e = byKey.get(key) || { key, earlier, pieces: [] };
      if (rank(key, earlier) > rank(key, e.earlier)) e.earlier = earlier;
      e.pieces.push(id);
      byKey.set(key, e);
    }
  }
  const out = [];
  for (const e of byKey.values()) {
    const now = meta[e.key] ?? RESTRICTED[e.key];
    const to = rank(e.key, e.earlier) <= rank(e.key, limits[e.key].loosest) ? e.earlier : limits[e.key].loosest;
    if (rank(e.key, to) > rank(e.key, now)) out.push({ key: e.key, from: now, to, pieces: e.pieces });
  }
  return out;
}

/** Loosen what the offer lists (the person's choice); the records of the pieces it came from go. → the changes */
export async function loosenPermissions(bundle, opts = {}) {
  const offer = looseningOffer(bundle, opts);
  const data = databaseData(bundle);
  const wornIds = new Set(partsOf(bundle).map((p) => p.id));
  for (const k of Object.keys(data.settings)) if (k.startsWith(TIGHTENED_PREFIX) && !wornIds.has(k.slice(TIGHTENED_PREFIX.length))) delete data.settings[k];
  if (offer.length) {
    const path = avatarPath(bundle);
    bundle.entries.set(path, withPermissions(bundle.entries.get(path), Object.fromEntries(offer.map((o) => [o.key, o.to]))));
  }
  await writeDatabase(bundle, data);
  return offer;
}

// ---- reading and setting -------------------------------------------------------------------------------
/**
 * The character's details as the Details screen and `vrmxa details` show them:
 * { meta, listing, chosen (when the permissions were chosen, or null), limits, title, author }.
 */
/**
 * Where the character's permissions stand (LIC-3):
 *   'chosen'     the person chose them in this app (`x-xocialize.permissions-chosen`)
 *   'restricted' never chosen, and allowing nothing (VRM's strictest: a character made here)
 *   'from-spec'  never chosen, and exactly Spec's: taken over from Spec, which LIC-3 doesn't allow. Treated as allowing
 *                nothing: shown so, and written so into every export and shared copy
 *   'from-file'  never chosen here, and not Spec's: the author's own, from the file it came in; kept as they are, shown
 *                as "from the file, not confirmed here"
 * opts.baseMeta: the base's meta when known (else Spec's published permissions).
 */
export function permissionsState(bundle, { baseMeta = null } = {}) {
  if (bundle.database?.settings?.[PERMISSIONS_CHOSEN]) return 'chosen';
  const p = permissionsOf(avatarMeta(bundle));
  const same = (o) => PERMISSION_KEYS.every((k) => p[k] === o[k]);
  if (same(RESTRICTED)) return 'restricted';
  if (same(baseMeta ? permissionsOf(baseMeta) : SPEC_PERMISSIONS) || same(SPEC_PERMISSIONS)) return 'from-spec';
  return 'from-file';
}

/** The meta as it is to be shown and written: Spec's permissions taken over unchosen become the strictest (LIC-3). */
export function effectiveMeta(bundle, opts = {}) {
  const meta = avatarMeta(bundle) || {};
  delete meta.thumbnailImage;
  return permissionsState(bundle, opts) === 'from-spec' ? { ...meta, ...RESTRICTED } : meta;
}

export function detailsOf(bundle, opts = {}) {
  const meta = effectiveMeta(bundle, opts);
  const settings = bundle.database?.settings || {};
  const limits = permissionLimits(bundle, opts);
  const permissions = permissionsState(bundle, opts);
  // permissions looser than a worn piece allows (a piece put on after they were chosen, §5.3)
  const looser = looserThanPieces(meta, partsOf(bundle));
  return {
    meta,
    permissions,
    looser,
    listing: bundle.database?.listing ? { url: bundle.database.listing.url ?? null, marketplace: bundle.database.listing.marketplace ?? null, listing_id: bundle.database.listing.listing_id ?? null } : null,
    chosen: settings[PERMISSIONS_CHOSEN] ?? null,
    limits,
    title: bundle.manifest.title ?? '',
    author: bundle.manifest.author ?? '',
  };
}

const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

/** What is wrong with a details patch (codes details.*), before anything is written. → [text] */
export function detailsProblems(patch) {
  const P = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!DETAIL_KEYS.includes(k)) { P.push(`"${k}" is not one of the character's details`); continue; }
    if (v === null || v === undefined) {
      if (['name', 'authors', 'licenseUrl'].includes(k)) P.push(`${k} can't be removed: a VRM must have it`);
      continue;
    }
    if (k === 'name' && !nonEmpty(v)) P.push('the name can\'t be empty');
    else if (k === 'authors' && (!Array.isArray(v) || !v.length || !v.every(nonEmpty))) P.push('name at least one maker (authors)');
    else if (k === 'references' && (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))) P.push('references must be a list of text');
    else if (k === 'licenseUrl' && !nonEmpty(v)) P.push('the licence (licenseUrl) can\'t be empty');
    else if (META_ENUMS[k] && !META_ENUMS[k].includes(v)) P.push(`${k} must be one of ${META_ENUMS[k].join(', ')}`);
    else if (META_BOOLEANS.includes(k) && typeof v !== 'boolean') P.push(`${k} must be true or false`);
    else if ((META_STRINGS.includes(k) || k === 'name') && typeof v !== 'string') P.push(`${k} must be text`);
  }
  return P;
}

/**
 * Change the character's details (LIC-1): the fields of `patch` (DETAIL_KEYS; null removes an optional one) are written
 * into avatar.vrm's VRMC_vrm.meta, the binary chunk untouched; the manifest's title and author follow (§4). A permission
 * looser than the base or a worn piece allows is refused, naming the piece (§5.3), unless `limits: false`.
 * Setting any permission records that the person chose them (LIC-3). → the new details (detailsOf)
 */
export async function setDetails(bundle, patch, { limits = true, now = nowIso(), baseMeta = null } = {}) {
  if (!isPlainObject(patch)) fail('details.shape', 'the details must be an object');
  const problems = detailsProblems(patch);
  if (problems.length) fail('details.value', problems.join('; '));
  if (limits) {
    const lim = permissionLimits(bundle, { baseMeta });
    for (const k of PERMISSION_KEYS) {
      if (!(k in patch) || patch[k] == null) continue;
      const l = lim[k];
      if (rank(k, patch[k]) > rank(k, l.loosest)) {
        const who = l.by.filter((b) => rank(k, b.value) === rank(k, l.loosest)).map((b) => `"${b.name}"`).join(' and ') || 'a piece she wears';
        fail('details.looser', `"${wordsFor(k, patch[k])}" is looser than ${who} allows (${wordsFor(k, l.loosest)}): a character's permissions are never looser than its parts' (VRMXA §5.3)`);
      }
    }
  }
  const fromSpec = permissionsState(bundle, { baseMeta }) === 'from-spec';
  const path = avatarPath(bundle);
  const bytes = bundle.entries.get(path);
  if (!bytes) fail('details.no-avatar', 'the character has no avatar.vrm');
  const { json, bin } = parseGlb(bytes);
  const vrm = json.extensions?.VRMC_vrm;
  if (!vrm?.meta) fail('details.no-meta', 'avatar.vrm has no VRMC_vrm.meta');
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete vrm.meta[k];
    else vrm.meta[k] = clone(v);
  }
  bundle.entries.set(path, buildGlb(json, bin));
  bundle.manifest.title = vrm.meta.name ?? '';
  bundle.manifest.author = Array.isArray(vrm.meta.authors) ? vrm.meta.authors.join(', ') : '';
  if (PERMISSION_KEYS.some((k) => k in patch)) {
    // the first choice over Spec's taken-over permissions: the others become what was shown, nothing allowed (LIC-3)
    if (fromSpec) for (const k of PERMISSION_KEYS) if (!(k in patch)) vrm.meta[k] = RESTRICTED[k];
    if (fromSpec) bundle.entries.set(path, buildGlb(json, bin));
    const data = databaseData(bundle);
    data.settings[PERMISSIONS_CHOSEN] = now;
    await writeDatabase(bundle, data);
  }
  return detailsOf(bundle, { baseMeta });
}

/**
 * Where the character was obtained (LIC-2): { url, marketplace, listing_id } (any may be null), or null to clear it.
 * A price is refused (§5.3: prices change). → the listing written, or null
 */
export async function setListing(bundle, listing) {
  const data = databaseData(bundle);
  if (listing === null) data.listing = null;
  else {
    if (!isPlainObject(listing)) fail('listing.shape', 'the origin must be an object or null');
    if ('price' in listing) fail('listing.price', 'no price is stored: prices change (VRMXA §5.3)');
    for (const k of Object.keys(listing)) if (!['url', 'marketplace', 'listing_id', 'id'].includes(k)) fail('listing.key', `"${k}" is not part of where a character came from (url, marketplace, listing_id)`);
    const pick = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
    const l = { url: pick(listing.url), marketplace: pick(listing.marketplace), listing_id: pick(listing.listing_id ?? listing.id) };
    data.listing = l.url || l.marketplace || l.listing_id ? l : null;
  }
  await writeDatabase(bundle, data);
  return data.listing;
}

/** A setting of the character's (character.sqlite `setting`), or null. */
export const settingOf = (bundle, key) => bundle.database?.settings?.[key] ?? null;

/** Set (or with null clear) one of the character's settings. App keys are `x-<vendor>.` (§12). */
export async function setSetting(bundle, key, value) {
  const { memoryKeyProblem } = await import('../persona/memory.js');
  const why = memoryKeyProblem(key) || (value != null ? memoryKeyProblem(String(value), { value: true }) : null);
  if (why) fail('setting.memory', why);
  const data = databaseData(bundle);
  if (value === null || value === undefined) delete data.settings[key];
  else data.settings[key] = String(value);
  await writeDatabase(bundle, data);
}

/**
 * Write the permissions as shown (LIC-3): a character whose permissions were never chosen and are Spec's gets VRM's
 * strictest written into avatar.vrm (what the app shows and exports), so the file never claims more than its parts.
 * → true when it changed avatar.vrm
 */
export function writeShownPermissions(bundle, opts = {}) {
  if (permissionsState(bundle, opts) !== 'from-spec') return false;
  const path = avatarPath(bundle);
  bundle.entries.set(path, withPermissions(bundle.entries.get(path), RESTRICTED));
  return true;
}

/** A VRM's bytes with these permissions written into its meta (the binary chunk untouched). */
export function withPermissions(bytes, permissions) {
  const { json, bin } = parseGlb(bytes);
  const m = json.extensions?.VRMC_vrm?.meta;
  if (!m) return bytes;
  Object.assign(m, permissions);
  return buildGlb(json, bin);
}

/** Replace avatar.vrm's whole meta (undo of a details change; thumbnailImage kept). */
export function setWholeMeta(bundle, meta) {
  const path = avatarPath(bundle);
  const bytes = bundle.entries.get(path);
  if (!bytes || !meta) return;
  const { json, bin } = parseGlb(bytes);
  const vrm = json.extensions?.VRMC_vrm;
  if (!vrm?.meta) return;
  const thumb = vrm.meta.thumbnailImage;
  vrm.meta = clone(meta);
  if (thumb !== undefined) vrm.meta.thumbnailImage = thumb;
  bundle.entries.set(path, buildGlb(json, bin));
  bundle.manifest.title = vrm.meta.name ?? '';
  bundle.manifest.author = Array.isArray(vrm.meta.authors) ? vrm.meta.authors.join(', ') : '';
}

const voicePath = (p) => p.startsWith('voice/') && p !== 'voice/voices.json';

/**
 * What the details, voice and persona operations touch, for undo: the character's meta (not avatar.vrm's bytes, which a
 * save may have drawn again since), character.sqlite with its manifest entries, and the voices document with its clips.
 */
export function characterSnapshot(bundle) {
  const meta = avatarMeta(bundle);
  if (meta) delete meta.thumbnailImage;
  return {
    meta,
    db: bundle.entries.get('character.sqlite') ?? null,
    database: clone(bundle.database),
    manifestDatabase: clone(bundle.manifest.database ?? null),
    persona: clone(bundle.manifest.sections?.persona ?? null),
    voices: bundle.docs.voices ? clone(bundle.docs.voices) : null,
    voiceFiles: new Map([...bundle.entries].filter(([p]) => voicePath(p))),
  };
}

/** Put the details, the database and the voices back as a snapshot had them. */
export function restoreCharacter(bundle, s) {
  if (!s) return bundle;
  const now = avatarMeta(bundle);
  if (now) delete now.thumbnailImage;
  if (s.meta && JSON.stringify(now) !== JSON.stringify(s.meta)) setWholeMeta(bundle, s.meta);
  if (s.db) bundle.entries.set('character.sqlite', s.db); else bundle.entries.delete('character.sqlite');
  bundle.database = clone(s.database);
  bundle.manifest.database = clone(s.manifestDatabase);
  const sec = (bundle.manifest.sections ||= {});
  if (s.persona) sec.persona = clone(s.persona); else delete sec.persona;
  for (const p of [...bundle.entries.keys()]) if (voicePath(p) && !s.voiceFiles.has(p)) bundle.entries.delete(p);
  for (const [p, b] of s.voiceFiles) bundle.entries.set(p, b);
  setDocument(bundle, 'voices', s.voices);
  return bundle;
}
