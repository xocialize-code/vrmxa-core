// The checker (PRD ITM-12, CHR-9; VRMXA §3.5, VRMXW §13, CLOSET.md §2).
//
//   checkBundle(input, opts) → problems     a .vrmxa, packed (bytes) or open (Map of path → bytes)
//   checkItem(input, opts)   → problems     a .vrmxw, packed or open
//   checkModel(bytes, opts)  → { problems, json, bin }   one GLB: an avatar, an item model or a clip
//
// A problem is { severity: 'error' | 'warning' | 'info', where, code, message }: where names the entry
// and the place in it, code is a stable name for tools, and message says what is wrong in plain words.
// An error means the file must be refused as a whole (§3.5); a warning is worth showing; info is a note.
// The checker never throws on hostile input: anything unexpected while checking becomes an error too.
//
// opts: { limits (zip.js DEFAULT_LIMITS), bases (bases.json entries; the published ones by default),
//         spec (spec.vrm's bytes, for the bind check of items), maxTextureSize (8192), where }

import { isPlainObject, ISO_UTC_RE, parseJson, SHA256_RE, UUID_RE } from './bytes.js';
import { readCharacterDb } from './database.js';
import { checkAccessor, bufferViewRange, isGlb, parseGlb, readAccessor } from './glb.js';
import { sha12, sha256 } from './hash.js';
import { BUNDLE_VERSION, DOCUMENTS, documentPaths, ITEM_VERSION, LEGACY_BUNDLE_VERSIONS, SECTION_VERSIONS, VRMXA_MANIFEST, VRMXW_MANIFEST, closetItemPath } from './layout.js';
import { invert, parents } from './math.js';
import { duplicateNodeNames } from './show.js';
import { looserLines, looserThanPieces } from './character/terms.js';
import {
  ANIMATION_SLOTS, BASES, FIT_METHODS, HUMAN_BONE_SET, ITEM_TYPES, resolveItemType, META_BOOLEANS, META_ENUMS, META_STRINGS, SLOTS, SPECIES_RE, TAG_RE, VENDOR_NAME_RE, findBase,
} from './vocab.js';
import { entryNameProblem, inflateEntry, isZip, scanZip } from './zip.js';
import { withRule } from './rules.js';
import { checkDocument } from './schema/index.js';

const REQUIRED_HUMAN_BONES = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
const ITEM_EXTENSIONS = new Set(['VRMC_materials_mtoon', 'KHR_materials_unlit', 'VRMC_springBone', 'VRMC_springBone_extended_collider', 'VRMC_springBone_limit',
  'KHR_texture_transform', 'KHR_materials_emissive_strength']);
const VRM_EXTENSIONS = new Set([...ITEM_EXTENSIONS, 'VRMC_vrm', 'VRMC_node_constraint']);
const FIT_ADJUST = { loose: [-0.005, 0.02], size: [0.9, 1.15], up: [-0.03, 0.03], forward: [-0.03, 0.03], right: [-0.03, 0.03] };

const str = (v) => typeof v === 'string';
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isPlainObject(v) ? v : {});
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const join = (...parts) => parts.filter((p) => p !== '' && p !== undefined && p !== null).join(' → ');

class Report {
  constructor() {
    this.list = [];
  }

  /** Every finding with its rule and section; a schema finding that says what a rule's finding already says, at the same place, is left out. */
  done() {
    const norm = (w) => String(w || '').replace(/\[(\d+)\]/g, '.$1').replace(/\s*→\s*/g, '.');
    const rank = { error: 3, warning: 2, info: 1 };
    const own = this.list.filter((p) => !String(p.code).startsWith('schema.'));
    const out = this.list.filter((p) => !String(p.code).startsWith('schema.') || !own.some((o) => norm(o.where) === norm(p.where) && rank[o.severity] >= rank[p.severity]));
    return out.map(withRule);
  }

  /** The specification's JSON Schema for a document (src/schema/), its findings added. */
  schema(doc, role, where) {
    this.list.push(...checkDocument(doc, role, { where }));
  }

  add(severity, code, where, message) {
    this.list.push({ severity, where, code, message });
  }

  error(code, where, message) { this.add('error', code, where, message); }
  warn(code, where, message) { this.add('warning', code, where, message); }
  info(code, where, message) { this.add('info', code, where, message); }

  /** Run one part of the check; anything it throws is reported, not raised. */
  async guard(where, fn) {
    try {
      return await fn();
    } catch (e) {
      this.error('checker.stopped', where, `could not be checked: ${e?.message || e}`);
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Containers

/**
 * Open a container for checking → { entries: Map(path → bytes), sizes: Map(path → size), packed,
 * manifest } or null when it can't be opened. Packed: the ZIP rules, then each entry's size against
 * the manifest before it is unpacked, then its SHA-256 after (§3.5, "Sizes").
 */
async function openContainer(input, manifestName, R, where, opts) {
  if (input instanceof Map) {
    const entries = new Map();
    for (const [name, data] of input) {
      const bad = entryNameProblem(name);
      if (bad) R.error('zip.entry-name', join(where, name), bad);
      else entries.set(name, data instanceof Uint8Array ? data : new Uint8Array(data));
    }
    const m = entries.get(manifestName);
    if (!m) {
      R.error('manifest.missing', join(where, manifestName), `there is no ${manifestName}`);
      return null;
    }
    const pj = parseJson(m);
    if (pj.error || !isPlainObject(pj.value)) {
      R.error('manifest.json', join(where, manifestName), `is not a JSON object${pj.error ? ` (${pj.error})` : ''}`);
      return null;
    }
    entries.delete(manifestName);
    return { entries, packed: false, manifest: pj.value };
  }
  let u8;
  try {
    u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  } catch {
    R.error('container.not-bytes', where, 'is not a file');
    return null;
  }
  if (!isZip(u8)) {
    if (isGlb(u8)) R.error('container.bare-glb', where, `is a bare GLB, not a ZIP. ${manifestName === VRMXW_MANIFEST ? 'Items written by the earlier tools are brought in by packing them as version 1 (VRMXW §14, itemFromBareGlb)' : 'A bundle is a ZIP'}`);
    else R.error('container.not-zip', where, 'is not a ZIP archive');
    return null;
  }
  const dir = scanZip(u8, { inflate: false, limits: opts.limits, where });
  for (const p of dir.problems) R.list.push(p);
  if (!dir.entries.length) return null;
  if (dir.entries[0].name !== manifestName) R.error('container.manifest-first', join(where, dir.entries[0].name), `the first entry must be ${manifestName}`);
  const me = dir.entries.find((e) => e.name === manifestName);
  if (!me) {
    R.error('manifest.missing', join(where, manifestName), `there is no ${manifestName}`);
    return null;
  }
  if (me.size > 16 * 1024 * 1024) {
    R.error('manifest.too-large', join(where, manifestName), 'is larger than 16 MB');
    return null;
  }
  const mr = inflateEntry(u8, me, { where });
  if (mr.problem) {
    R.list.push(mr.problem);
    return null;
  }
  const pj = parseJson(mr.data);
  if (pj.error || !isPlainObject(pj.value)) {
    R.error('manifest.json', join(where, manifestName), `is not a JSON object${pj.error ? ` (${pj.error})` : ''}`);
    return null;
  }
  const manifest = pj.value;
  const declared = new Map(arr(manifest.files).filter((f) => isPlainObject(f) && str(f.path)).map((f) => [f.path, f]));
  const entries = new Map();
  for (const e of dir.entries) {
    if (e.name === manifestName) continue;
    const rec = declared.get(e.name);
    // before unpacking: never unpack more than the manifest declares
    if (rec && Number.isInteger(rec.size) && e.size > rec.size) {
      R.error('container.size', join(where, e.name), `unpacks to ${e.size} bytes but the manifest declares ${rec.size}; not unpacked`);
      continue;
    }
    const r = inflateEntry(u8, e, { where });
    if (r.problem) {
      R.list.push(r.problem);
      continue;
    }
    entries.set(e.name, r.data);
  }
  return { entries, packed: true, manifest, zipNames: new Set(dir.names) };
}

/** Every entry is in `files` and every listed file is an entry; sizes and SHA-256s match (packed). */
async function checkInventory(c, manifestName, R, where) {
  const files = c.manifest.files;
  const at = join(where, manifestName, 'files');
  if (!Array.isArray(files)) {
    R.error('manifest.files', at, 'is missing: the manifest must list every entry with its size and SHA-256');
    return;
  }
  const listed = new Set();
  for (const [i, f] of files.entries()) {
    const fat = `${at}[${i}]`;
    if (!isPlainObject(f) || !str(f.path)) {
      R.error('manifest.files', fat, 'is not a { path, size, sha256 } record');
      continue;
    }
    if (listed.has(f.path)) R.error('manifest.files', fat, `lists "${f.path}" twice`);
    listed.add(f.path);
    const names = c.packed ? c.zipNames : c.entries;
    if (f.path === manifestName) {
      R.error('manifest.files', fat, 'lists the manifest itself, which it must not');
      continue;
    }
    if (!names.has(f.path)) {
      R.error('container.inventory', join(where, f.path), 'is listed in the manifest but is not in the archive');
      continue;
    }
    if (!c.packed) continue; // the open form recomputes hashes when it is packed (§3.1)
    const data = c.entries.get(f.path);
    if (!data) continue; // refused or not unpacked: already reported
    if (!Number.isInteger(f.size) || f.size !== data.length) R.error('container.size', join(where, f.path), `is ${data.length} bytes but the manifest declares ${f.size}`);
    if (!str(f.sha256) || !SHA256_RE.test(f.sha256)) R.error('container.hash', join(where, f.path), 'has no valid SHA-256 in the manifest');
    else if ((await sha256(data)) !== f.sha256) R.error('container.hash', join(where, f.path), 'does not match the SHA-256 the manifest declares (the file was changed or damaged)');
  }
  const names = c.packed ? c.zipNames : new Set(c.entries.keys());
  for (const n of names) if (n !== manifestName && !listed.has(n)) R.error('container.inventory', join(where, n), 'is in the archive but not listed in the manifest');
}

// ---------------------------------------------------------------------------------------------
// Models

function imageSize(u8) {
  if (u8.length >= 24 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { type: 'png', w: dv.getUint32(16, false), h: dv.getUint32(20, false) };
  }
  if (u8.length >= 4 && u8[0] === 0xff && u8[1] === 0xd8) {
    let p = 2;
    while (p + 9 < u8.length) {
      if (u8[p] !== 0xff) return { type: 'jpeg' };
      const marker = u8[p + 1];
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: 'jpeg', h: (u8[p + 5] << 8) | u8[p + 6], w: (u8[p + 7] << 8) | u8[p + 8] };
      p += 2 + len;
    }
    return { type: 'jpeg' };
  }
  return null;
}

/**
 * Check one GLB as untrusted (§3.5, "Models"): it parses; it is glTF 2.0; it is self-contained;
 * every index points at something; every accessor and buffer view lies inside its buffer; textures
 * are PNG or JPEG within the size cap. kind: 'vrm' (a VRM 1.0), 'item' (no VRMC_vrm) or 'clip' (.vrma).
 */
export function checkModel(bytes, { where = '', kind = 'vrm', maxTextureSize = 8192 } = {}) {
  const R = new Report();
  let json, bin;
  try {
    ({ json, bin } = parseGlb(bytes));
  } catch (e) {
    R.error('model.glb', where, `is not a valid GLB: ${e.message}`);
    return { problems: R.list.map(withRule), json: null, bin: null };
  }
  try {
    if (json.asset?.version !== '2.0') R.error('model.version', where, `is glTF "${json.asset?.version}", not 2.0`);
    const count = (k) => (Array.isArray(json[k]) ? json[k].length : 0);
    const idx = (v, k) => Number.isInteger(v) && v >= 0 && v < count(k);
    for (const [i, b] of arr(json.buffers).entries()) {
      if (b?.uri !== undefined) R.error('model.external', join(where, `buffers[${i}]`), 'refers to data outside the file; a model must be self-contained');
      else if (i > 0) R.error('model.external', join(where, `buffers[${i}]`), 'a GLB has only one buffer of its own');
    }
    for (const [i, im] of arr(json.images).entries()) {
      if (im?.uri !== undefined) {
        R.error('model.external', join(where, `images[${i}]`), 'refers to a picture outside the file; a model must be self-contained');
        continue;
      }
      try {
        const { start, end } = bufferViewRange(json, bin, im.bufferView);
        const s = imageSize(bin.subarray(start, end));
        if (!s) R.error('model.image', join(where, `images[${i}]`), 'is not a PNG or JPEG');
        else if (s.w > maxTextureSize || s.h > maxTextureSize) R.error('model.texture-size', join(where, `images[${i}]`), `is ${s.w}×${s.h}; the cap is ${maxTextureSize}×${maxTextureSize}`);
      } catch (e) {
        R.error('model.bounds', join(where, `images[${i}]`), e.message);
      }
    }
    for (let i = 0; i < count('bufferViews'); i++) {
      try { bufferViewRange(json, bin, i); } catch (e) { R.error('model.bounds', join(where, `bufferViews[${i}]`), e.message); }
    }
    for (let i = 0; i < count('accessors'); i++) {
      try { checkAccessor(json, bin, i); } catch (e) { R.error('model.bounds', join(where, `accessors[${i}]`), e.message); }
    }
    const parentCount = new Map();
    for (const [i, n] of arr(json.nodes).entries()) {
      const nat = join(where, `nodes[${i}]`);
      if (n?.mesh !== undefined && !idx(n.mesh, 'meshes')) R.error('model.index', nat, `names mesh ${n.mesh}, which does not exist`);
      if (n?.skin !== undefined && !idx(n.skin, 'skins')) R.error('model.index', nat, `names skin ${n.skin}, which does not exist`);
      for (const c of arr(n?.children)) {
        if (!idx(c, 'nodes')) R.error('model.index', nat, `has child ${c}, which does not exist`);
        else parentCount.set(c, (parentCount.get(c) || 0) + 1);
      }
    }
    for (const [c, k] of parentCount) if (k > 1) R.error('model.tree', join(where, `nodes[${c}]`), 'has more than one parent');
    // cycles
    const pOf = parents(json.nodes);
    for (let i = 0; i < count('nodes'); i++) {
      const seen = new Set();
      for (let n = i; n !== undefined; n = pOf.get(n)) {
        if (seen.has(n)) { R.error('model.tree', join(where, `nodes[${i}]`), 'is part of a cycle in the node tree'); break; }
        seen.add(n);
      }
    }
    for (const [mi, m] of arr(json.meshes).entries()) {
      for (const [pi, p] of arr(m?.primitives).entries()) {
        const pat = join(where, `meshes[${mi}].primitives[${pi}]`);
        for (const [a, ai] of Object.entries(obj(p?.attributes))) if (!idx(ai, 'accessors')) R.error('model.index', pat, `attribute ${a} names accessor ${ai}, which does not exist`);
        if (p?.indices !== undefined && !idx(p.indices, 'accessors')) R.error('model.index', pat, 'its indices accessor does not exist');
        if (p?.material !== undefined && !idx(p.material, 'materials')) R.error('model.index', pat, `names material ${p.material}, which does not exist`);
        for (const t of arr(p?.targets)) for (const ai of Object.values(obj(t))) if (!idx(ai, 'accessors')) R.error('model.index', pat, 'a morph target names an accessor that does not exist');
      }
    }
    for (const [si, s] of arr(json.skins).entries()) {
      const sat = join(where, `skins[${si}]`);
      for (const j of arr(s?.joints)) if (!idx(j, 'nodes')) R.error('model.index', sat, `has joint ${j}, which is not a node`);
      if (s?.inverseBindMatrices !== undefined) {
        if (!idx(s.inverseBindMatrices, 'accessors')) R.error('model.index', sat, 'its inverse bind matrices accessor does not exist');
        else if ((json.accessors[s.inverseBindMatrices].count ?? 0) < arr(s.joints).length) R.error('model.skin', sat, 'has fewer inverse bind matrices than joints');
      }
    }
    for (const [ti, t] of arr(json.textures).entries()) {
      if (t?.source !== undefined && !idx(t.source, 'images')) R.error('model.index', join(where, `textures[${ti}]`), 'names an image that does not exist');
      if (t?.sampler !== undefined && !idx(t.sampler, 'samplers')) R.error('model.index', join(where, `textures[${ti}]`), 'names a sampler that does not exist');
    }
    for (const [si, s] of arr(json.scenes).entries()) for (const n of arr(s?.nodes)) if (!idx(n, 'nodes')) R.error('model.index', join(where, `scenes[${si}]`), `names node ${n}, which does not exist`);
    const used = arr(json.extensionsUsed);
    const allowed = kind === 'item' ? ITEM_EXTENSIONS : kind === 'clip' ? new Set(['VRMC_vrm_animation']) : VRM_EXTENSIONS;
    for (const e of used) if (!allowed.has(e)) R.warn('model.extension', where, `uses the extension ${e}, which ${kind === 'item' ? 'VRMXW §5' : 'this reader'} does not list`);
    for (const e of arr(json.extensionsRequired)) if (!allowed.has(e)) R.error('model.extension-required', where, `requires the extension ${e}, which this reader cannot honour`);
    const vrm = json.extensions?.VRMC_vrm;
    if (kind === 'vrm') {
      if (json.extensions?.VRM && !vrm) R.error('model.vrm0', where, 'is a VRM 0.x; VRMXA is defined against VRM 1.0 (§13.1, D27): convert it when bringing it in');
      else if (!vrm) R.error('model.not-vrm', where, 'is not a VRM 1.0 (no VRMC_vrm)');
      else {
        if (!String(vrm.specVersion || '').startsWith('1.')) R.error('model.vrm-version', where, `VRMC_vrm.specVersion is "${vrm.specVersion}", not 1.0`);
        const hb = obj(vrm.humanoid?.humanBones);
        for (const b of REQUIRED_HUMAN_BONES) if (!Number.isInteger(hb[b]?.node) || !idx(hb[b].node, 'nodes')) R.error('model.humanoid', join(where, 'VRMC_vrm.humanoid'), `has no node for the required bone "${b}"`);
        checkMeta(vrm.meta, join(where, 'VRMC_vrm.meta'), R, { model: true });
      }
    } else if (kind === 'item') {
      if (vrm) R.error('item.model-vrm', where, 'carries VRMC_vrm; an item model is a plain glTF (VRMXW §5)');
    } else if (kind === 'clip') {
      if (!json.extensions?.VRMC_vrm_animation) R.error('clip.not-vrma', where, 'is not a VRM animation (no VRMC_vrm_animation)');
    }
  } catch (e) {
    R.error('checker.stopped', where, `could not be checked: ${e.message}`);
  }
  return { problems: R.list.map(withRule), json, bin };
}

/** A licence block in VRM's terms (VRMXW §11; VRMXA §9.3). */
function checkMeta(meta, where, R, { model = false } = {}) {
  if (!isPlainObject(meta)) {
    R.error('licence.missing', where, 'is missing: who made it and what they allow must be stated (VRMXA §2 rule 6)');
    return;
  }
  if (model && !nonEmpty(meta.name)) R.error('licence.name', where, 'has no name');
  if (!Array.isArray(meta.authors) || !meta.authors.length || !meta.authors.every(nonEmpty)) R.error('licence.authors', where, 'must name at least one author (authors)');
  if (!nonEmpty(meta.licenseUrl)) R.error('licence.url', where, 'must give the licence it is under (licenseUrl)');
  for (const [k, values] of Object.entries(META_ENUMS)) if (meta[k] !== undefined && !values.includes(meta[k])) R.error('licence.value', where, `${k} is "${meta[k]}"; VRM's values are ${values.join(', ')}`);
  for (const k of META_BOOLEANS) if (meta[k] !== undefined && typeof meta[k] !== 'boolean') R.error('licence.value', where, `${k} must be true or false`);
  for (const k of META_STRINGS) if (meta[k] !== undefined && !str(meta[k])) R.error('licence.value', where, `${k} must be text`);
  if (meta.references !== undefined && (!Array.isArray(meta.references) || !meta.references.every(str))) R.error('licence.value', where, 'references must be a list of text');
}

function checkListing(l, where, R) {
  if (l === null || l === undefined) return;
  if (!isPlainObject(l)) return R.error('listing.shape', where, 'must be an object or null');
  for (const k of ['url', 'marketplace', 'id', 'listing_id']) if (l[k] !== undefined && l[k] !== null && !str(l[k])) R.error('listing.shape', where, `${k} must be text`);
  if ('price' in l) R.warn('listing.price', where, 'has a price; the format stores none (prices change)');
}

function checkBase(base, where, R, bases) {
  if (!isPlainObject(base)) {
    R.error('base.missing', where, 'is missing: the base must be named by its SHA-256');
    return null;
  }
  if (!str(base.sha256) || !SHA256_RE.test(base.sha256)) {
    R.error('base.hash', where, 'has no valid sha256');
    return null;
  }
  if (base.species !== undefined && (!str(base.species) || !SPECIES_RE.test(base.species))) R.error('base.species', where, `species "${base.species}" is not human or an x-<vendor>.<name>`);
  const known = findBase(base.sha256, bases);
  if (!known) {
    R.error('base.unknown', where, `the base ${base.sha256.slice(0, 12)}… is not a published Spec (assets/spec/bases.json)`);
    return null;
  }
  if ((known.species || 'human') !== (base.species || 'human')) R.error('base.species', where, `species is "${base.species || 'human'}" but that base is "${known.species || 'human'}"`);
  if (known.status === 'retired') R.warn('base.retired', where, `names a retired Spec (${known.adopted ? `adopted ${known.adopted}` : 'the first'}); the app has to move it onto the current one (VRMXA §5.1, D21)`);
  return known;
}

// ---------------------------------------------------------------------------------------------
// Items

/** Check a .vrmxw, packed or open. Returns problems; never throws. */
export async function checkItem(input, opts = {}) {
  const R = new Report();
  const where = opts.where || '';
  await R.guard(where, () => checkItemInto(input, opts, R, where));
  return R.done();
}

async function checkItemInto(input, opts, R, where) {
  const c = await openContainer(input, VRMXW_MANIFEST, R, where, opts);
  if (!c) return null;
  const m = c.manifest;
  const at = (k) => join(where, VRMXW_MANIFEST, k);
  if (m.format !== 'vrmxw') R.error('item.format', at('format'), `is "${m.format}", not "vrmxw"`);
  if (!Number.isInteger(m.version)) R.error('item.version', at('version'), 'is missing');
  else if (m.version > ITEM_VERSION) {
    R.error('item.version-newer', at('version'), `item format version ${m.version} is newer than this reader knows (${ITEM_VERSION})`);
    return null;
  }
  await checkInventory(c, VRMXW_MANIFEST, R, where);
  if (m.version === ITEM_VERSION) R.schema(m, 'item', join(where, VRMXW_MANIFEST));
  if (!str(m.id) || !UUID_RE.test(m.id)) R.error('item.id', at('id'), 'must be a UUID');
  if (!Number.isInteger(m.revision) || m.revision < 1) R.error('item.revision', at('revision'), 'must be a whole number from 1');
  if (!nonEmpty(m.name)) R.error('item.name', at('name'), 'is missing');
  if (m.created !== undefined && !(str(m.created) && ISO_UTC_RE.test(m.created))) R.warn('item.time', at('created'), 'is not an ISO 8601 UTC time');
  const type = resolveItemType(m.type, m.slot, m.kind === 'worn' || m.kind === 'pin' ? m.kind : undefined);
  if (!type) R.error('item.type', at('type'), `"${m.type}" is not one of the types of VRMXW §6, nor an x-<vendor>.<name> type naming a slot of §6`);
  else if (type.vendor) R.info('item.type-vendor', at('type'), `"${m.type}" is a vendor's type: it is treated as an item of the slot "${m.slot}" (VRMXW §6, W15)`);
  if (!SLOTS.includes(m.slot)) R.error('item.slot', at('slot'), `"${m.slot}" is not a slot (VRMXA §7.2)`);
  else if (type && !type.vendor && type.slot !== m.slot) R.warn('item.slot-type', at('slot'), `is "${m.slot}" but a ${m.type} goes in "${type.slot}"`);
  if (m.kind !== 'worn' && m.kind !== 'pin') R.error('item.kind', at('kind'), 'must be "worn" or "pin"');
  else if (type && !type.vendor && type.kind !== m.kind) R.warn('item.kind-type', at('kind'), `is "${m.kind}" but a ${m.type} is "${type.kind}"`);
  if (m.layer !== undefined && !Number.isInteger(m.layer)) R.error('item.layer', at('layer'), 'must be a whole number');
  const tags = new Set();
  for (const t of arr(m.tags)) {
    if (!str(t) || !TAG_RE.test(t)) R.error('item.tag', at('tags'), `"${t}" is not a namespace:value tag, each part [a-z0-9][a-z0-9._-]*`);
    else tags.add(t);
  }
  if (m.tags !== undefined && !Array.isArray(m.tags)) R.error('item.tag', at('tags'), 'must be a list');
  checkBase(m.base, at('base'), R, opts.bases || BASES);
  // the model
  const modelFile = m.model?.file;
  let model = null;
  if (!nonEmpty(modelFile)) R.error('item.model', at('model'), 'model.file is missing');
  else if (!c.entries.has(modelFile)) R.error('item.model', join(where, modelFile), 'the model entry is missing');
  else {
    model = checkModel(c.entries.get(modelFile), { where: join(where, modelFile), kind: 'item', maxTextureSize: opts.maxTextureSize });
    R.list.push(...model.problems);
  }
  // fit
  const fit = m.fit;
  if (!isPlainObject(fit)) R.error('item.fit', at('fit'), 'is missing: the item must say how it is fitted (VRMXW §7)');
  else {
    if (!FIT_METHODS.includes(fit.method)) R.error('item.fit', at('fit.method'), `"${fit.method}" is not one of ${FIT_METHODS.join(', ')}`);
    if (fit.method === 'spec-fit') {
      if (!['top', 'bottom', 'skirt', 'dress'].includes(fit.class)) R.error('item.fit', at('fit.class'), 'must be top, bottom, skirt or dress');
      if (fit.ease !== undefined && !['fitted', 'relaxed'].includes(fit.ease)) R.error('item.fit', at('fit.ease'), 'must be fitted or relaxed');
      if (fit.hemAnchor !== undefined && !['body', 'absolute'].includes(fit.hemAnchor)) R.error('item.fit', at('fit.hemAnchor'), 'must be body or absolute');
    }
    if (fit.lift === undefined && m.type === 'shoes') R.warn('item.lift', at('fit.lift'), 'shoes record their lift in fit.lift, 0 when they add none (VRMXW §7.1, W28)');
    if (fit.lift !== undefined) {
      if (m.type !== 'shoes') R.error('item.lift', at('fit.lift'), 'only shoes record a lift (VRMXW §7.1)');
      else if (!num(fit.lift) || fit.lift < 0 || fit.lift > 0.3) R.error('item.lift', at('fit.lift'), 'must be a height in metres, 0 to 0.3');
    }
    if (m.kind === 'pin' && fit.method && fit.method !== 'pin') R.warn('item.fit', at('fit.method'), 'a pinned item is fitted by "pin"');
    if (fit.hideSkin !== undefined && typeof fit.hideSkin !== 'boolean') R.error('item.fit', at('fit.hideSkin'), 'is true or false: false forbids hiding the skin under the item (VRMXW §7, W29)');
  }
  // rig, attach, states
  const rig = obj(m.rig?.humanBones);
  if (!isPlainObject(m.rig?.humanBones)) R.error('item.rig', at('rig'), 'rig.humanBones is missing');
  const nodeCount = arr(model?.json?.nodes).length;
  const seenNodes = new Map();
  for (const [bone, n] of Object.entries(rig)) {
    if (!HUMAN_BONE_SET.has(bone)) R.error('item.rig', at(`rig.humanBones.${bone}`), 'is not a VRM 1.0 humanoid bone');
    if (!Number.isInteger(n) || n < 0 || (model?.json && n >= nodeCount)) R.error('item.rig', at(`rig.humanBones.${bone}`), `node ${n} is not a node of the model`);
    else if (seenNodes.has(n)) R.error('item.rig', at(`rig.humanBones.${bone}`), `is the same node as ${seenNodes.get(n)}`);
    else seenNodes.set(n, bone);
  }
  if (m.kind === 'pin') {
    if (!isPlainObject(m.attach) || !HUMAN_BONE_SET.has(m.attach.bone)) R.error('item.attach', at('attach'), 'a pinned item must name the humanoid bone it follows (attach.bone)');
    else if (rig[m.attach.bone] === undefined) R.error('item.attach', at('attach.bone'), `"${m.attach.bone}" is not in rig.humanBones`);
  } else if (m.attach !== null && m.attach !== undefined) R.warn('item.attach', at('attach'), 'only pinned items have attach');
  const stateNames = new Set();
  const stateTags = new Set();
  for (const [i, s] of arr(m.states).entries()) {
    const sat = at(`states[${i}]`);
    if (!isPlainObject(s) || !nonEmpty(s.name)) { R.error('item.state', sat, 'must have a name'); continue; }
    if (stateNames.has(s.name)) R.error('item.state', sat, `the name "${s.name}" is used twice`);
    stateNames.add(s.name);
    for (const t of arr(s.tags)) {
      if (!str(t) || !TAG_RE.test(t)) R.error('item.tag', sat, `"${t}" is not a namespace:value tag, each part [a-z0-9][a-z0-9._-]*`);
      else stateTags.add(t);
    }
    if (s.bone !== undefined) {
      if (m.kind !== 'pin') R.warn('item.state', sat, 'bone applies to pinned items only');
      else if (rig[s.bone] === undefined) R.error('item.state', sat, `bone "${s.bone}" is not in rig.humanBones`);
    }
    if (s.matrix !== undefined && !(Array.isArray(s.matrix) && s.matrix.length === 16 && s.matrix.every(num))) R.error('item.state', sat, 'matrix must be 16 numbers');
    // `show` names meshes by node name (VRMXW §8, SPEC-QUESTIONS #44); an older item's node indices are read as names
    const mnodes = arr(model?.json?.nodes);
    const meshNodes = new Set(mnodes.map((n, k) => (n?.mesh !== undefined ? k : -1)).filter((k) => k >= 0));
    const meshNames = new Set([...meshNodes].map((k) => mnodes[k]?.name).filter((x) => str(x) && x));
    let byIndex = false;
    for (const n of arr(s.show)) {
      if (Number.isInteger(n)) {
        byIndex = true;
        if (model?.json && !meshNodes.has(n)) R.error('item.state', sat, `show names node ${n}, which is not a mesh node`);
      } else if (!str(n) || !n) R.error('item.state', sat, 'show lists meshes by their node name');
      else if (model?.json && !meshNames.has(n)) R.error('item.state', sat, `show names "${n}", which is no mesh node's name`);
    }
    if (byIndex) R.info('item.show-index', sat, 'an older item: show names meshes by node index; it is read as their names (VRMXW §8)');
    if (s.morphs !== undefined) {
      const names = new Set(arr(model?.json?.meshes).flatMap((me) => arr(me?.extras?.targetNames)));
      for (const k of Object.keys(obj(s.morphs))) {
        if (model?.json && !names.has(k)) R.error('item.state', sat, `morph "${k}" is not a morph target of the item`);
        if (!num(s.morphs[k]) || s.morphs[k] < 0 || s.morphs[k] > 1) R.error('item.state', sat, `morph "${k}" must be 0 to 1`);
      }
    }
  }
  if (model?.json) {
    // unique within an item that has states, so a state can name a mesh (VRMXW §8, W24)
    const dup = arr(m.states).length ? duplicateNodeNames(model.json.nodes) : [];
    if (dup.length) R.error('item.node-names', join(where, modelFile), `node names must be unique within an item that has states, so a state can name a mesh (VRMXW §8, W24): ${dup.slice(0, 5).map((d) => `"${d}"`).join(', ')}${dup.length > 5 ? ` and ${dup.length - 5} more` : ''} used twice`);
  }
  if (model?.json && !model.problems.some((p) => p.severity === 'error')) checkItemModel(model.json, model.bin, m, rig, R, join(where, modelFile), opts);
  // animations
  if (m.animations !== null && m.animations !== undefined) {
    const allTags = new Set([...tags, ...stateTags]);
    await checkAnimationsDoc(m.animations, c.entries, R, at('animations'), { item: true, itemTags: allTags, where });
  }
  // extensions
  const ext = m.extensions;
  if (ext !== undefined && !isPlainObject(ext)) R.error('item.extensions', at('extensions'), 'must be an object');
  for (const name of Object.keys(obj(ext))) {
    if (!VENDOR_NAME_RE.test(name)) R.warn('item.extension-name', at(`extensions.${name}`), 'names without an x-<vendor>. prefix are reserved for the specification');
  }
  for (const p of c.entries.keys()) {
    const mm = /^extensions\/([^/]+)\//.exec(p);
    if (mm && !(mm[1] in obj(ext))) R.warn('item.extension-files', join(where, p), `belongs to no extension named in the manifest ("${mm[1]}")`);
  }
  checkMeta(m.meta, at('meta'), R);
  if ('avatarPermission' in obj(m.meta)) R.info('licence.not-for-items', at('meta.avatarPermission'), 'does not apply to an item (VRMXW §11)');
  checkListing(m.listing, at('listing'), R);
  if (m.origin !== undefined && m.origin !== null) {
    if (!isPlainObject(m.origin)) R.error('item.origin', at('origin'), 'must be an object or null');
    else {
      const o = m.origin;
      if (o.made !== undefined && !['authored', 'extracted', 'generated', 'imported'].includes(o.made)) R.error('item.origin', at('origin.made'), 'must be authored, extracted, generated or imported');
      // the keys of VRMXW W17 and W26 (SPEC-QUESTIONS #37, #46): a wrong type is worth showing, not a reason to refuse
      if (o.sha256 !== undefined && !(str(o.sha256) && SHA256_RE.test(o.sha256))) R.warn('item.origin', at('origin.sha256'), 'should be the source file\'s SHA-256, 64 lower-case hex digits');
      if (o.fit !== undefined && !['spec-fit', 'bones', 'four-steps'].includes(o.fit)) R.warn('item.origin', at('origin.fit'), 'should be spec-fit, bones or four-steps: how the item was brought onto Spec');
      if (o.lift !== undefined && !(num(o.lift) && o.lift >= 0 && o.lift < 0.5)) R.warn('item.origin', at('origin.lift'), 'should be the donor\'s shoe lift taken out, in metres');
      if (o.converted !== undefined && typeof o.converted !== 'boolean') R.warn('item.origin', at('origin.converted'), 'should be true or false: whether the source was converted from VRM 0.x');
      if (o.headScale !== undefined && !(num(o.headScale) && o.headScale > 0)) R.warn('item.origin', at('origin.headScale'), 'should be a positive number: Spec\'s head size over the donor\'s (VRMXW W26)');
    }
  }
  if (m.thumbnail !== null && m.thumbnail !== undefined) {
    if (!c.entries.has(m.thumbnail)) R.error('item.thumbnail', at('thumbnail'), `names "${m.thumbnail}", which is not in the item`);
    else if (!imageSize(c.entries.get(m.thumbnail))) R.warn('item.thumbnail', join(where, m.thumbnail), 'is not a PNG or JPEG');
  }
  return { manifest: m, entries: c.entries };
}

/** VRMXW §5.3 to §5.5 and §13's model rows: skins, pins, springs; and the bind check against Spec. */
function checkItemModel(json, bin, m, rig, R, where, opts) {
  const nodes = arr(json.nodes);
  const pOf = parents(nodes);
  const rigNodes = new Map(Object.entries(rig).map(([b, n]) => [n, b]));
  const humanAncestor = (n) => {
    for (let c = n, k = 0; c !== undefined && k < 512; c = pOf.get(c), k++) if (rigNodes.has(c)) return c;
    return null;
  };
  const meshNodes = nodes.map((n, i) => (n?.mesh !== undefined ? i : -1)).filter((i) => i >= 0);
  if (!meshNodes.length) R.error('item.empty', where, 'has no mesh');
  if (m.kind === 'worn') {
    for (const ni of meshNodes) {
      const n = nodes[ni];
      if (n.skin === undefined) { R.error('item.worn-skin', join(where, `nodes[${ni}]`), 'a worn item\'s every mesh must have a skin (VRMXW §5.3)'); continue; }
      const skin = json.skins[n.skin];
      for (const p of arr(json.meshes[n.mesh]?.primitives)) {
        if (p.attributes?.JOINTS_1 !== undefined) R.error('item.influences', join(where, `meshes[${n.mesh}]`), 'has more than 4 influences per vertex (JOINTS_1)');
        if (p.attributes?.JOINTS_0 === undefined || p.attributes?.WEIGHTS_0 === undefined) { R.error('item.worn-skin', join(where, `meshes[${n.mesh}]`), 'a primitive has no skin weights'); continue; }
        const J = readAccessor(json, bin, p.attributes.JOINTS_0);
        const W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
        const weighted = new Set();
        for (let i = 0; i < J.length; i++) if (W[i] > 0) weighted.add(J[i]);
        for (const slot of weighted) {
          const node = skin.joints[slot];
          if (node === undefined) { R.error('item.worn-skin', join(where, `meshes[${n.mesh}]`), `weights joint slot ${slot}, which the skin does not have`); continue; }
          if (humanAncestor(node) === null) R.error('item.worn-joint', join(where, `nodes[${node}]`), 'is weighted but is neither a mapped humanoid bone nor descends from one (VRMXW §5.3 rule 1)');
        }
      }
    }
  } else if (m.kind === 'pin' && isPlainObject(m.attach)) {
    const boneNode = rig[m.attach.bone];
    // a dangling part may be skinned to the bones of one of its own spring chains, never to a humanoid bone (§5.4, W16)
    const chainOf = new Map();
    for (const [si, sp] of arr(json.extensions?.VRMC_springBone?.springs).entries()) for (const j of arr(sp?.joints)) if (Number.isInteger(j?.node)) chainOf.set(j.node, si);
    for (const ni of meshNodes) {
      const n = nodes[ni];
      if (n.skin !== undefined) {
        const skin = json.skins?.[n.skin];
        const chains = new Set();
        let bad = !skin;
        for (const p of arr(json.meshes[n.mesh]?.primitives)) {
          if (!skin || p.attributes?.JOINTS_0 === undefined || p.attributes?.WEIGHTS_0 === undefined) continue;
          const J = readAccessor(json, bin, p.attributes.JOINTS_0);
          const W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
          for (let i = 0; i < J.length; i++) {
            if (!(W[i] > 0)) continue;
            const node = skin.joints[J[i]];
            if (node === undefined || rigNodes.has(node) || !chainOf.has(node)) bad = true;
            else chains.add(chainOf.get(node));
          }
        }
        if (bad || chains.size > 1) R.error('item.pin-skin', join(where, `nodes[${ni}]`), 'a pinned item\'s mesh may be skinned only to the bones of one of its own spring chains, never to a humanoid bone (VRMXW §5.4)');
      }
      let under = false;
      for (let c = pOf.get(ni), k = 0; c !== undefined && k < 512; c = pOf.get(c), k++) if (c === boneNode) { under = true; break; }
      if (!under) R.error('item.pin-place', join(where, `nodes[${ni}]`), `is not under the node of ${m.attach.bone} (VRMXW §5.4)`);
    }
  }
  // springs (VRMXW §5.5; VRMC_springBone's own rules)
  const sb = json.extensions?.VRMC_springBone;
  if (sb) {
    const owner = new Map();
    for (const [si, s] of arr(sb.springs).entries()) {
      const sat = join(where, `VRMC_springBone.springs[${si}]`);
      const joints = arr(s?.joints).map((j) => j?.node);
      joints.forEach((n, k) => {
        if (!Number.isInteger(n) || n < 0 || n >= nodes.length) return R.error('item.spring', sat, `joint ${k} is not a node`);
        if (rigNodes.has(n)) R.error('item.spring', sat, `joint ${k} is the humanoid bone ${rigNodes.get(n)}; spring joints are the item's own bones`);
        if (owner.has(n) && owner.get(n) !== si) R.error('item.spring', sat, `node ${n} is a joint of more than one spring`);
        owner.set(n, si);
        if (k > 0 && pOf.get(n) !== joints[k - 1]) R.error('item.spring', sat, `joint ${k} is not a child of joint ${k - 1}`);
      });
      if (joints.length && humanAncestor(joints[0]) === null) R.warn('item.spring', sat, 'its root does not descend from a humanoid bone, so it can\'t be re-seated when worn');
      for (const gi of arr(s?.colliderGroups)) if (!Number.isInteger(gi) || gi >= arr(sb.colliderGroups).length) R.error('item.spring', sat, `collider group ${gi} does not exist`);
    }
    for (const [ci, col] of arr(sb.colliders).entries()) {
      if (!rigNodes.has(col?.node)) R.error('item.collider', join(where, `VRMC_springBone.colliders[${ci}]`), 'must be on a humanoid bone, so it can move to the character\'s matching bone (VRMXW §5.5)');
    }
    for (const [gi, g] of arr(sb.colliderGroups).entries()) for (const ci of arr(g?.colliders)) if (!Number.isInteger(ci) || ci >= arr(sb.colliders).length) R.error('item.collider', join(where, `VRMC_springBone.colliderGroups[${gi}]`), `collider ${ci} does not exist`);
  }
  // bound where Spec binds (VRMXW §5.3 rule 4): compared through each humanoid joint's bind matrix
  if (opts.spec && m.kind === 'worn') {
    const ref = specBinds(opts.spec);
    if (ref) {
      let worst = 0, worstBone = null;
      for (const skin of arr(json.skins)) {
        if (skin.inverseBindMatrices === undefined) continue;
        const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
        skin.joints.forEach((node, j) => {
          const bone = rigNodes.get(node);
          if (!bone || !ref.has(bone)) return;
          const a = invert([...ibm.subarray(j * 16, j * 16 + 16)]);
          const b = ref.get(bone);
          if (!a) return;
          const d = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((k) => Math.abs(a[k] - b[k])));
          if (d > worst) { worst = d; worstBone = bone; }
        });
      }
      if (worst > 1e-5) R.error('item.bind', where, `its humanoid joints are not bound where Spec binds them: ${worstBone} is off by ${(worst * 1000).toFixed(2)} mm (VRMXW §5.3 rule 4; checked through the bind matrices, not by wearing it)`);
    }
  }
}

let specCache = null;
function specBinds(specBytes) {
  if (specCache?.bytes === specBytes) return specCache.map;
  try {
    const { json, bin } = parseGlb(specBytes);
    const hb = obj(json.extensions?.VRMC_vrm?.humanoid?.humanBones);
    const boneOf = new Map(Object.entries(hb).map(([b, o]) => [o.node, b]));
    const map = new Map();
    for (const skin of arr(json.skins)) {
      if (skin.inverseBindMatrices === undefined) continue;
      const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
      skin.joints.forEach((node, j) => {
        const b = boneOf.get(node);
        if (b && !map.has(b)) map.set(b, invert([...ibm.subarray(j * 16, j * 16 + 16)]));
      });
    }
    specCache = { bytes: specBytes, map };
    return map;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Animations (VRMXA §8.4; VRMXW §9)

async function checkAnimationsDoc(doc, entries, R, at, { item = false, itemTags = new Set(), closetIds = null, where = '' } = {}) {
  if (!isPlainObject(doc)) return R.error('animations.shape', at, 'must be an object');
  const clips = new Set();
  for (const [i, c] of arr(doc.clips).entries()) {
    const cat = `${at} → clips[${i}]`;
    if (!isPlainObject(c)) { R.error('animations.clip', cat, 'is not an object'); continue; }
    // a clip's licence: text, or a licence block in VRM's terms (§8.4, D35)
    if (isPlainObject(c.licence)) checkMeta(c.licence, `${cat} → licence`, R);
    else if (c.licence !== undefined && c.licence !== null && !str(c.licence)) R.error('licence.value', `${cat} → licence`, 'is text or a licence block in VRM\'s terms (§8.4)');
    if (!str(c.sha256) || !SHA256_RE.test(c.sha256)) R.error('animations.clip', cat, 'sha256 must be the clip file\'s full SHA-256');
    else clips.add(c.sha256);
    if (!nonEmpty(c.file)) { R.error('animations.clip', cat, 'file is missing'); continue; }
    const bytes = entries.get(c.file);
    if (!bytes) { R.error('animations.clip-missing', join(where, c.file), 'the clip file is missing'); continue; }
    const h = await sha256(bytes);
    if (str(c.sha256) && h !== c.sha256) R.error('animations.clip-hash', join(where, c.file), 'does not match the sha256 its record gives');
    const expect = item ? `animations/${sha12(h)}.vrma` : `animations/clips/${sha12(h)}.vrma`;
    if (c.file !== expect) R.warn('animations.clip-name', join(where, c.file), `files are named by content: expected ${expect} (VRMXA §2 rule 2)`);
    R.list.push(...checkModel(bytes, { where: join(where, c.file), kind: 'clip' }).problems);
    if (c.loops !== undefined && c.loops !== null && typeof c.loops !== 'boolean') R.error('animations.clip', cat, 'loops must be true, false or null');
    if (c.rootMotion !== undefined && c.rootMotion !== null && !['inPlace', 'travel'].includes(c.rootMotion)) R.error('animations.clip', cat, 'rootMotion must be inPlace or travel');
    for (const t of arr(c.tracks)) if (!['humanoid', 'expressions', 'lookAt'].includes(t)) R.error('animations.clip', cat, `track "${t}" is not humanoid, expressions or lookAt`);
    if (c.from !== undefined && closetIds && !closetIds.has(c.from)) R.error('closet.c7', cat, `was brought by item ${c.from}, which is not in the closet (CLOSET.md C7)`);
    // VRMXA 0.31 §8.4: rate, derivedFrom, edit, groundedFor (D34)
    if (c.rate !== undefined && c.rate !== null && !(num(c.rate) && c.rate > 0)) R.error('animations.clip', cat, 'rate must be a playback speed above 0 (VRMXA §8.4)');
    if (c.derivedFrom !== undefined && (!str(c.derivedFrom) || !SHA256_RE.test(c.derivedFrom))) R.error('animations.clip', cat, 'derivedFrom must be the sha256 of the clip it was made from (VRMXA §8.4)');
    if (c.edit !== undefined) {
      const want = `animations/edits/${sha12(h)}.json`;
      if (!str(c.edit)) R.error('animations.edit', cat, 'edit must be the path of its edit document');
      else {
        if (c.edit !== want) R.warn('animations.edit-name', join(where, c.edit), `an edit document is named by its clip: expected ${want} (VRMXA §8.4)`);
        const eb = entries.get(c.edit);
        if (!eb) R.error('animations.edit-missing', join(where, c.edit), 'the edit document is missing');
        else {
          let ed = null;
          try { ed = JSON.parse(new TextDecoder().decode(eb)); } catch { R.error('animations.edit', join(where, c.edit), 'is not JSON'); }
          if (ed && ed.format === 'vrmxa-motion-edit' && ed.version === 1) R.schema(ed, 'motionEdit', join(where, c.edit));
          if (ed && ed.format !== 'vrmxa-motion-edit') R.error('animations.edit', join(where, c.edit), 'format must be "vrmxa-motion-edit" (VRMXA §8.4)');
          else if (ed && !(Number.isInteger(ed.version) && ed.version >= 1)) R.error('animations.edit', join(where, c.edit), 'version must be a whole number, 1 or more');
          else if (ed && ed.version > 1) R.info('animations.edit-newer', join(where, c.edit), `version ${ed.version} is newer than this reader knows; kept as it is (rule 5)`);
        }
      }
      if (!str(c.derivedFrom)) R.error('animations.edit-original', cat, 'has an edit document but names no original (derivedFrom): the original stays while an edit document refers to it (VRMXA §8.1, D34)');
    }
    if (c.groundedFor !== undefined && c.groundedFor !== null) {
      const g = c.groundedFor;
      if (!isPlainObject(g) || !str(g.base) || !SHA256_RE.test(g.base) || !num(g.lift) || !(g.edits === null || (str(g.edits) && SHA256_RE.test(g.edits)))) R.error('animations.clip', cat, 'groundedFor must be { base: sha256, lift: metres, edits: sha256 or null } (VRMXA §8.4)');
    }
  }
  // an edit document refers to its original, which must stay in clips (VRMXA §8.1, D34)
  for (const [i, c] of arr(doc.clips).entries()) {
    if (isPlainObject(c) && c.edit !== undefined && str(c.derivedFrom) && !clips.has(c.derivedFrom)) R.error('animations.edit-original', `${at} → clips[${i}]`, `its edit document refers to the original ${c.derivedFrom.slice(0, 12)}…, which is not in clips: the original stays while an edit document refers to it (VRMXA §8.1, D34)`);
  }
  let defaults = 0;
  const setIds = new Set();
  for (const [i, s] of arr(doc.sets).entries()) {
    const sat = `${at} → sets[${i}]`;
    if (!isPlainObject(s)) { R.error('animations.set', sat, 'is not an object'); continue; }
    if (item) {
      if (s.id !== undefined) R.warn('animations.set', sat, 'sets in an item have no id; the character gives one (VRMXW §9)');
      if (s.default) R.error('animations.item-default', sat, 'an item can never replace a character\'s default set (VRMXW §9)');
      const req = arr(s.requires);
      if (!req.some((t) => itemTags.has(t))) R.error('animations.item-requires', sat, 'must require at least one of the item\'s own tags, so it plays only while the item is equipped (VRMXW §9)');
    } else {
      if (!nonEmpty(s.id)) R.error('animations.set', sat, 'has no id');
      else if (setIds.has(s.id)) R.error('animations.set', sat, `the id ${s.id} is used twice`);
      setIds.add(s.id);
      if (s.default === true) {
        defaults++;
        if (!arr(obj(s.slots).idle).length) R.error('animations.default-idle', sat, 'the default set must fill idle (VRMXA §8.2)');
      }
      if (s.from !== undefined && closetIds && !closetIds.has(s.from)) R.error('closet.c7', sat, `was brought by item ${s.from}, which is not in the closet (CLOSET.md C7)`);
    }
    for (const t of arr(s.requires)) if (!str(t) || !TAG_RE.test(t)) R.error('animations.set', sat, `requires "${t}", which is not a namespace:value tag`);
    if (s.priority !== undefined && !num(s.priority)) R.error('animations.set', sat, 'priority must be a number');
    for (const [slot, list] of Object.entries(obj(s.slots))) {
      if (!ANIMATION_SLOTS.includes(slot) && !VENDOR_NAME_RE.test(slot)) R.warn('animations.slot', sat, `"${slot}" is not in the slot vocabulary; new slots begin as x-<vendor>.<name> (VRMXA §8.2)`);
      for (const e of arr(list)) {
        if (!clips.has(e?.clip)) R.error('animations.slot-clip', `${sat} → slots.${slot}`, `names a clip (${String(e?.clip).slice(0, 12)}…) that is not in clips`);
        for (const k of ['weight', 'rate', 'blendIn']) if (e?.[k] !== undefined && (!num(e[k]) || e[k] < 0)) R.error('animations.slot', `${sat} → slots.${slot}`, `${k} must be a number, 0 or more`);
      }
    }
  }
  // A character whose only sets were brought by items (it took in an item before it had a default
  // set of its own) has no default to give them: noted, not refused (SPEC-QUESTIONS #29).
  const onlyBrought = arr(doc.sets).length > 0 && arr(doc.sets).every((s) => isPlainObject(s) && s.from !== undefined);
  if (!item && arr(doc.sets).length && defaults === 0 && onlyBrought) R.warn('animations.no-default', at, 'has only sets brought by items and no default set of the character\'s own (VRMXA §8.2); the brought sets play over nothing until one is made');
  else if (!item && arr(doc.sets).length && defaults !== 1) R.error('animations.default', at, defaults ? 'more than one set is marked default' : 'no set is marked default (one must be, and fill idle)');
}

/**
 * Check a character's animations document against its entries (VRMXA §8.4; CLOSET.md C7 when closetIds is
 * given): what the animation operations run before they write (anim/motion.js). → problems
 */
export async function checkAnimations(doc, entries, { closetIds = null } = {}) {
  const R = new Report();
  await R.guard('animations/animations.json', () => checkAnimationsDoc(doc, entries instanceof Map ? entries : new Map(Object.entries(entries || {})), R, 'animations/animations.json', { closetIds }));
  return R.list;
}

// ---------------------------------------------------------------------------------------------
// Bundles

/** Check a .vrmxa, packed or open. Returns problems; never throws. */
export async function checkBundle(input, opts = {}) {
  const R = new Report();
  const where = opts.where || '';
  await R.guard(where || 'bundle', async () => {
    const c = await openContainer(input, VRMXA_MANIFEST, R, where, opts);
    if (!c) return;
    const m = c.manifest;
    const at = (k) => join(where, VRMXA_MANIFEST, k);
    if (m.format !== 'vrmxa') {
      R.error('bundle.format', at('format'), `is "${m.format}", not "vrmxa"`);
      return;
    }
    const v = Number.isInteger(m.meta?.schemaVersion) && m.meta.schemaVersion > 1 ? m.meta.schemaVersion : Number.isInteger(m.version) && m.version > 1 ? m.version : 1;
    if (m.meta?.metaDataVersion > 1) R.error('bundle.meta-version', at('meta.metaDataVersion'), `manifest layout version ${m.meta.metaDataVersion} is newer than this reader knows (1)`);
    if (m.meta?.binEncodingVersion > 1) R.error('bundle.encoding-version', at('meta.binEncodingVersion'), `encoding version ${m.meta.binEncodingVersion} is newer than this reader knows (1)`);
    if (v > BUNDLE_VERSION) return R.error('bundle.version-newer', at('version'), `bundle version ${v} is newer than this reader knows (${BUNDLE_VERSION})`);
    if (LEGACY_BUNDLE_VERSIONS.includes(v)) return checkLegacy(c, v, R, where, opts);
    if (v !== BUNDLE_VERSION) return R.error('bundle.version', at('version'), `bundle version ${v} is not one this reader reads (2 to 5)`);
    if (m.version !== BUNDLE_VERSION) R.error('bundle.version', at('version'), `must be ${BUNDLE_VERSION}`);
    await checkInventory(c, VRMXA_MANIFEST, R, where);
    await checkV5(c, R, where, opts);
  });
  return R.done();
}

async function checkV5(c, R, where, opts) {
  const m = c.manifest;
  const E = c.entries;
  const at = (k) => join(where, VRMXA_MANIFEST, k);
  const bases = opts.bases || BASES;
  R.schema(m, 'manifest', join(where, VRMXA_MANIFEST));
  if (!str(m.id) || !UUID_RE.test(m.id)) R.error('bundle.id', at('id'), 'must be a UUID: the character\'s identity (§4.1)');
  if (!str(m.fileId) || !UUID_RE.test(m.fileId)) R.error('bundle.file-id', at('fileId'), 'must be a UUID: this file\'s identity (§4.1)');
  if (!Number.isInteger(m.revision) || m.revision < 1) R.error('bundle.revision', at('revision'), 'must be a whole number from 1');
  for (const k of ['created', 'updated']) if (!(str(m[k]) && ISO_UTC_RE.test(m[k]))) R.warn('bundle.time', at(k), 'is not an ISO 8601 UTC time');
  for (const k of ['title', 'author', 'generator']) if (m[k] !== undefined && m[k] !== null && !str(m[k])) R.error('bundle.text', at(k), 'must be text');
  const base = checkBase(m.base, at('base'), R, bases);
  if (m.base?.file !== undefined) R.warn('bundle.base-file', at('base.file'), 'the base has no file in a version 5 bundle: the reader supplies it (§5.1)');

  // avatar.vrm (§5.2)
  const avatarFile = m.avatar?.file;
  let avatar = null;
  if (!isPlainObject(m.avatar) || !nonEmpty(avatarFile)) R.error('bundle.avatar', at('avatar'), 'is missing: every bundle carries the last configured VRM (§5.2, D2)');
  else if (!E.has(avatarFile)) R.error('bundle.avatar', join(where, avatarFile), 'avatar.vrm is missing');
  else {
    avatar = checkModel(E.get(avatarFile), { where: join(where, avatarFile), kind: 'vrm', maxTextureSize: opts.maxTextureSize });
    R.list.push(...avatar.problems);
    const vm = avatar.json?.extensions?.VRMC_vrm?.meta;
    if (vm) {
      if (str(m.title) && vm.name !== m.title) R.warn('bundle.title', at('title'), `is "${m.title}" but avatar.vrm's own name is "${vm.name}" (the manifest keeps a copy, §4)`);
      const authors = Array.isArray(vm.authors) ? vm.authors.join(', ') : '';
      if (str(m.author) && m.author !== authors) R.warn('bundle.author', at('author'), `is "${m.author}" but avatar.vrm's authors are "${authors}"`);
      // the character's permissions are never looser than a piece merged into it allows (VRMXA §5.3)
      const pieces = Array.isArray(avatar.json?.extras?.vrmxaPieces) ? avatar.json.extras.vrmxaPieces : [];
      if (avatar.json?.extras?.vrmxaPieces !== undefined) R.schema(avatar.json.extras.vrmxaPieces, 'pieces', join(where, avatarFile, 'extras.vrmxaPieces'));
      // skin hidden under worn items is recorded on each skin material it changed (VRMXA §5.2, D37)
      arr(avatar.json?.materials).forEach((mt, i) => { if (mt?.extras?.vrmxaHidden !== undefined) R.schema(mt.extras.vrmxaHidden, 'hidden', join(where, avatarFile, `materials[${i}].extras.vrmxaHidden`)); });
      for (const line of looserLines(looserThanPieces(vm, pieces))) R.warn('details.looser', join(where, avatarFile, 'VRMC_vrm.meta'), line);
    }
  }
  if (m.thumbnail !== null && m.thumbnail !== undefined) {
    if (!E.has(m.thumbnail)) R.error('bundle.thumbnail', at('thumbnail'), `names "${m.thumbnail}", which is not in the bundle`);
    else if (!imageSize(E.get(m.thumbnail))) R.warn('bundle.thumbnail', join(where, m.thumbnail), 'is not a PNG or JPEG');
  } else R.warn('bundle.thumbnail', at('thumbnail'), 'there is no thumbnail of the character (§3.3, PRD CHR-10)');

  // sections and their documents; rule 4 for newer versions
  const sections = isPlainObject(m.sections) ? m.sections : {};
  if (m.sections !== undefined && !isPlainObject(m.sections)) R.error('bundle.sections', at('sections'), 'must be an object');
  const skipped = new Set();
  for (const [name, s] of Object.entries(sections)) {
    if (s === null) continue;
    if (!(name in SECTION_VERSIONS)) { R.info('bundle.section-unknown', at(`sections.${name}`), 'is a section this reader doesn\'t know; it is kept as it is (§2 rule 5)'); continue; }
    if (!isPlainObject(s) || !Number.isInteger(s.version)) { R.error('bundle.section', at(`sections.${name}`), 'must have a version'); continue; }
    if (s.version > SECTION_VERSIONS[name]) {
      skipped.add(name);
      R.info('bundle.section-newer', at(`sections.${name}`), `section version ${s.version} is newer than this reader knows (${SECTION_VERSIONS[name]}): the character opens without it, and it is kept (§2 rule 4)`);
    }
  }
  const docs = {};
  const paths = documentPaths(m);
  for (const [role, loc] of Object.entries(paths)) {
    const d = DOCUMENTS[role];
    if (skipped.has(d.section)) continue;
    const dat = join(where, loc.path);
    if (!E.has(loc.path)) { R.error('doc.missing', dat, `the ${role} document named in the manifest is missing`); continue; }
    const r = parseJson(E.get(loc.path));
    if (r.error || !isPlainObject(r.value)) { R.error('doc.json', dat, `is not a JSON object${r.error ? ` (${r.error})` : ''}`); continue; }
    const doc = r.value;
    if (doc.format !== d.format) { R.error('doc.format', dat, `format is "${doc.format}", expected "${d.format}"`); continue; }
    if (!Number.isInteger(doc.version)) { R.error('doc.version', dat, 'has no version'); continue; }
    if (doc.version > d.version) { R.info('doc.newer', dat, `version ${doc.version} is newer than this reader knows (${d.version}): opened without it, and kept (§2 rule 4)`); continue; }
    if (loc.declared !== undefined && loc.declared !== doc.version) R.warn('doc.version', dat, `the manifest says version ${loc.declared}, the document says ${doc.version}`);
    R.schema(doc, role, dat);
    docs[role] = doc;
  }
  const sha = async (role) => (paths[role] && E.has(paths[role].path) ? sha256(E.get(paths[role].path)) : null);
  const editsSha = await sha('edits');
  const closetSha = await sha('closet');

  // avatar.of (§4)
  const of = m.avatar?.of;
  if (!isPlainObject(of)) R.warn('bundle.avatar-of', at('avatar.of'), 'is missing: a reader can\'t tell whether avatar.vrm matches the edits and the closet');
  else {
    const stale = [];
    if (of.base !== (m.base?.sha256 ?? null)) stale.push('the base');
    if ((of.edits ?? null) !== editsSha) stale.push('edits.json');
    if ((of.closet ?? null) !== closetSha) stale.push('closet.json');
    if (stale.length) R.warn('bundle.avatar-stale', at('avatar.of'), `avatar.vrm was made from a different ${stale.join(', ')}: it may not show the character as now described. An app that can fit must redraw it (CLOSET.md C6)`);
  }

  // database (§12) and persona
  const db = m.database;
  let persona = null;
  if (db !== null && db !== undefined) {
    if (!isPlainObject(db) || !nonEmpty(db.file)) R.error('bundle.database', at('database'), 'must be { file, schema } or null');
    else if (!Number.isInteger(db.schema) || db.schema < 1) R.error('db.schema-version', at('database.schema'), 'must be a whole number from 1');
    else if (!E.has(db.file)) R.error('bundle.database', join(where, db.file), 'the database named in the manifest is missing');
    else if (db.schema > 1) {
      // D29: a newer schema is skipped under rule 4, not refused; the file is kept as it is
      skipped.add('persona');
      R.info('db.schema-newer', at('database.schema'), `schema ${db.schema} is newer than this reader knows (1): the character opens without its persona, origin and settings, and the database is kept (§12, §2 rule 4)`);
    } else if (!skipped.has('persona')) {
      const r = await readCharacterDb(E.get(db.file), { packed: c.packed, where: join(where, db.file) });
      R.list.push(...r.problems);
      persona = r.data?.persona ?? null;
      if (persona) R.schema(personaExchangeOf(persona, r.data.examples), 'persona', join(where, db.file, 'persona'));
      if (r.data && sections.persona && !persona) R.warn('db.persona', join(where, db.file), 'the persona section is present but the persona table has no row');
    }
    if (isPlainObject(db) && Number.isInteger(db.schema) && isPlainObject(sections.persona) && sections.persona.version !== db.schema) {
      R.warn('db.persona-version', at('sections.persona.version'), `is ${sections.persona.version} but the database's schema is ${db.schema}: they are the same number (§12)`);
    }
  } else if (sections.persona) R.error('bundle.database', at('sections.persona'), 'the persona section needs character.sqlite, and the manifest names no database');

  // the documents
  if (docs.edits) checkEdits(docs.edits, R, join(where, paths.edits.path));
  if (docs.measurements) {
    const mat = join(where, paths.measurements.path);
    const mo = docs.measurements.of;
    if (!isPlainObject(mo)) R.warn('measurements.of', mat, 'has no "of": a reader can\'t tell which body it measured (§6)');
    else if (mo.base !== m.base?.sha256 || (mo.edits ?? null) !== editsSha) R.info('measurements.stale', mat, 'was measured on another body or other edits; a reader measures again (§6)');
  }
  const closetIds = docs.closet ? new Set(arr(docs.closet.items).map((i) => i?.id).filter(str)) : new Set();
  if (docs.closet) await checkCloset(docs.closet, E, R, where, paths.closet.path, { base, opts, editsSha, animations: docs.animations, packed: c.packed });
  else {
    for (const p of E.keys()) if (/^(closet\/items|appearance\/hair)\/[^/]+\.vrmxw$/.test(p)) R.error('closet.c3', join(where, p), 'is an item file, but the bundle has no closet.json listing it (CLOSET.md C3)');
  }
  if (docs.animations) await checkAnimationsDoc(docs.animations, E, R, join(where, paths.animations.path), { closetIds, where });
  if (docs.voices) await checkVoices(docs.voices, E, R, where, paths.voices.path);
  if (persona?.voice_id && docs.voices && !arr(docs.voices.voices).some((x) => x?.id === persona.voice_id)) R.warn('persona.voice', join(where, db.file, 'persona.voice_id'), 'names a voice that is not in voices.json');
  if (docs.eyes) checkEyes(docs.eyes, E, R, join(where, paths.eyes.path), avatar);
  if (docs.mouth) checkMouth(docs.mouth, E, R, join(where, paths.mouth.path), avatar);
  if (docs.skin) checkSkin(docs.skin, E, R, join(where, paths.skin.path), avatar);
}

// the persona row as its exchange form (VRMXA §10.1), so the persona schema can check it
function personaExchangeOf(row, examples = []) {
  const json = (v, d) => { try { const x = JSON.parse(v); return x ?? d; } catch { return v; } };
  const out = { format: 'vrmxa-persona', version: 1 };
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue;
    if (['traits', 'languages', 'allowed_expressions', 'tags'].includes(k)) out[k] = typeof v === 'string' ? json(v, []) : v;
    else if (k === 'extensions') out[k] = typeof v === 'string' ? json(v, {}) : v;
    else if (v !== null) out[k] = v;
  }
  out.examples = arr(examples).map((e) => ({ user: e.user_text, character: e.character_text }));
  return out;
}

function checkEdits(doc, R, at) {
  if (doc.items !== undefined) R.warn('edits.items', at, 'has "items": a version 5 bundle keeps each item\'s fit in closet.json (EDITS.md §5); a reader moves them');
  for (const k of ['face', 'body', 'hairDesign']) if (doc[k] !== undefined && !isPlainObject(doc[k])) R.error('edits.shape', at, `${k} must be an object`);
  for (const [k, val] of Object.entries(obj(doc.body))) if (!num(val) || val < -1 || val > 1) R.warn('edits.range', `${at} → body.${k}`, 'is outside −1 … 1 and will be clamped');
  if (doc.madeOn !== undefined && doc.madeOn !== null && !(isPlainObject(doc.madeOn) && str(doc.madeOn.sha256))) R.warn('edits.made-on', at, 'madeOn must be { sha256 } or null');
}

async function checkCloset(doc, E, R, where, path, { base, opts, editsSha, animations }) {
  const at = join(where, path);
  const items = arr(doc.items);
  if (!Array.isArray(doc.items)) R.error('closet.shape', at, 'items must be a list');
  const byId = new Map();
  const files = new Set();
  for (const [i, e] of items.entries()) {
    const iat = `${at} → items[${i}]`;
    if (!isPlainObject(e) || !str(e.id) || !UUID_RE.test(e.id)) { R.error('closet.item', iat, 'must have an id (a UUID)'); continue; }
    if (byId.has(e.id)) { R.error('closet.c3', iat, `lists item ${e.id} twice (CLOSET.md C3)`); continue; }
    byId.set(e.id, e);
    if (!nonEmpty(e.file)) { R.error('closet.item', iat, 'has no file'); continue; }
    if (files.has(e.file)) R.error('closet.c3', iat, `the file ${e.file} is listed twice`);
    files.add(e.file);
    if (!E.has(e.file)) { R.error('closet.c3', join(where, e.file), 'is listed in closet.json but is not in the bundle (CLOSET.md C3)'); continue; }
    if (!e.file.endsWith('.vrmxw')) R.error('closet.not-vrmxw', join(where, e.file), 'closet items are always .vrmxw files (D12)');
    const expect = closetItemPath(e.slot, e.id);
    if (e.file !== expect) R.warn('closet.item-path', join(where, e.file), `is expected at ${expect} (VRMXW §12)`);
    // C1: the item itself
    const ip = await checkItem(E.get(e.file), { ...opts, where: join(where, e.file) });
    R.list.push(...ip);
    let im = null;
    try {
      const { entries } = scanZip(E.get(e.file), { limits: opts.limits });
      const mf = entries.find((x) => x.name === VRMXW_MANIFEST);
      const pj = mf ? parseJson(mf.data) : { error: 'none' };
      if (!pj.error) im = { manifest: pj.value, model: entries.find((x) => x.name === pj.value?.model?.file)?.data };
    } catch { /* reported by checkItem */ }
    if (im?.manifest) {
      const mm = im.manifest;
      if (mm.id !== e.id) R.error('closet.item-id', iat, `the entry's id is ${e.id} but the item's own id is ${mm.id}`);
      if (mm.base?.sha256 !== base?.sha256 && base) R.error('closet.c2', join(where, e.file), 'the item names another base than the character\'s (CLOSET.md C2): it has to be moved onto this base first');
      if ((mm.base?.species || 'human') !== (base?.species || 'human') && base) R.error('closet.c2', join(where, e.file), 'the item is for another species');
      for (const k of ['name', 'slot', 'type', 'kind', 'layer']) if (e[k] !== undefined && mm[k] !== undefined && e[k] !== mm[k]) R.warn('closet.copy', `${iat} → ${k}`, `is "${e[k]}" but the item says "${mm[k]}"; the item file is the authority (§7.4)`);
      if (im.model && str(e.model) && (await sha256(im.model)) !== e.model) R.warn('closet.copy', `${iat} → model`, 'is not the SHA-256 of the item\'s model.glb; the copy is out of date');
      e.__states = arr(mm.states).map((s) => s?.name);
      e.__slot = mm.slot;
    }
    if (e.base !== undefined && base && e.base !== base.sha256) R.error('closet.c2', `${iat} → base`, 'must equal the manifest\'s base.sha256 (§7.4)');
    if (e.meta === undefined) R.warn('closet.copy', `${iat} → meta`, 'the copy of the item\'s licence block is missing (§7.4)');
    if (e.attach !== undefined) R.info('closet.copy', `${iat} → attach`, 'a closet entry names a pinned item\'s bone in bone; attach is not copied and is ignored here (VRMXW §12, W28)');
    // fine-tuning (§7.5)
    const f = e.fitting;
    if (f !== undefined) {
      if (!isPlainObject(f)) R.error('closet.fitting', `${iat} → fitting`, 'must be an object');
      else {
        if (f.auto !== undefined && typeof f.auto !== 'boolean') R.error('closet.fitting', `${iat} → fitting.auto`, 'must be true or false');
        if (f.method !== undefined && !FIT_METHODS.includes(f.method)) R.error('closet.fitting', `${iat} → fitting.method`, `"${f.method}" is not a fit method`);
        for (const [k, val] of Object.entries(obj(f.adjust))) {
          const r = FIT_ADJUST[k];
          if (!r) R.warn('closet.fitting', `${iat} → fitting.adjust.${k}`, 'is not one of loose, size, up, forward, right');
          else if (!num(val) || val < r[0] || val > r[1]) R.warn('closet.fitting', `${iat} → fitting.adjust.${k}`, `is outside ${r[0]} … ${r[1]} and will be clamped (EDITS.md §5)`);
        }
        const fd = f.fitted;
        if (fd !== undefined) {
          const fat = `${iat} → fitting.fitted`;
          if (!isPlainObject(fd) || !nonEmpty(fd.file)) R.error('closet.c8', fat, 'must name its file');
          else if (!E.has(fd.file)) R.error('closet.c8', join(where, fd.file), 'the stored fitted shape is missing');
          else {
            if (!isPlainObject(fd.of)) R.error('closet.c8', fat, 'must say what it was made from (of.edits, of.model; CLOSET.md C8)');
            else if (fd.of.edits !== editsSha || fd.of.model !== e.model) R.info('closet.fitted-stale', fat, 'is out of date and will be ignored until an app that can fit computes it again (§7.5)');
            const size = E.get(fd.file).length;
            for (const a of arr(fd.accessors)) if (!Number.isInteger(a?.offset) || !Number.isInteger(a?.count) || a.offset < 0 || a.offset + a.count * 12 > size) R.error('closet.c8', fat, `an accessor's offsets run past the end of ${fd.file}`);
          }
        }
      }
    }
  }
  // C3: every item file present is listed
  for (const p of E.keys()) if (/^(closet\/items|appearance\/hair)\/[^/]+\.vrmxw$/.test(p) && !files.has(p)) R.error('closet.c3', join(where, p), 'is an item file not listed in closet.json (CLOSET.md C3)');
  for (const p of E.keys()) if (/^closet\/items\//.test(p) && !p.endsWith('.vrmxw')) R.error('closet.not-vrmxw', join(where, p), 'closet items are always .vrmxw files (D12)');
  const slotOf = (id) => byId.get(id)?.__slot ?? byId.get(id)?.slot;
  // hair
  if (doc.hair !== null && doc.hair !== undefined) {
    if (!byId.has(doc.hair)) R.error('closet.hair', `${at} → hair`, `names ${doc.hair}, which is not in the closet`);
    else if (slotOf(doc.hair) !== 'hair') R.error('closet.hair', `${at} → hair`, 'names an item that is not a hair piece');
  }
  // C4, C5: what is worn and every outfit
  const checkSet = (ids, states, sat) => {
    const list = arr(ids);
    const slots = new Map();
    for (const id of list) {
      if (!byId.has(id)) { R.error('closet.c4', sat, `lists ${id}, which is not in the closet (CLOSET.md C4)`); continue; }
      const s = slotOf(id);
      if (s === 'hair') R.error('closet.c4', sat, 'lists a hair piece; hair is chosen once in Appearance, not worn or put in outfits (D4)');
      if (s !== 'accessory') slots.set(s, [...(slots.get(s) || []), id]);
    }
    if (new Set(list).size !== list.length) R.error('closet.c4', sat, 'lists an item twice');
    for (const [s, ids2] of slots) if (ids2.length > 1 && s !== 'hair') R.error('closet.c4', sat, `has ${ids2.length} items in the slot "${s}"; one per slot except accessory (VRMXA §7.2)`);
    if (slots.has('onepiece') && (slots.has('tops') || slots.has('bottoms'))) R.error('closet.c4', sat, 'has a onepiece with tops or bottoms (VRMXA §7.2)');
    for (const [id, st] of Object.entries(obj(states))) {
      if (!list.includes(id)) { R.error('closet.c5', sat, `records a state for ${id}, which it doesn't list`); continue; }
      const names = byId.get(id)?.__states ?? arr(byId.get(id)?.states).map((s) => s?.name);
      if (!names.includes(st)) R.error('closet.c5', sat, `records the state "${st}" for ${id}, which the item does not have (CLOSET.md C5)`);
    }
  };
  if (!isPlainObject(doc.worn)) R.error('closet.worn', `${at} → worn`, 'is missing');
  else {
    checkSet(doc.worn.items, doc.worn.states, `${at} → worn`);
    if (doc.worn.outfit !== null && doc.worn.outfit !== undefined && !arr(doc.outfits).some((o) => o?.id === doc.worn.outfit)) R.error('closet.c5', `${at} → worn.outfit`, 'names an outfit that does not exist (CLOSET.md C5)');
  }
  const outfitIds = new Set();
  for (const [i, o] of arr(doc.outfits).entries()) {
    const oat = `${at} → outfits[${i}]`;
    if (!isPlainObject(o) || !nonEmpty(o.id)) { R.error('closet.outfit', oat, 'must have an id'); continue; }
    if (!UUID_RE.test(o.id)) R.error('closet.outfit', oat, `its id "${o.id}" is not a UUID (VRMXA §7.4, D36)`);
    if (outfitIds.has(o.id)) R.error('closet.outfit', oat, `the id ${o.id} is used twice`);
    outfitIds.add(o.id);
    if (!nonEmpty(o.name)) R.warn('closet.outfit', oat, 'has no name');
    checkSet(o.items, o.states, oat);
  }
  for (const e of items) if (isPlainObject(e)) { delete e.__states; delete e.__slot; }
  // C7 is checked with the animations document
  if (!animations) for (const e of items) if (isPlainObject(e) && e.animations) R.info('closet.animations', at, 'an item brings animations but the bundle has no animations document');
}

function wavInfo(u8) {
  if (u8.length < 44 || String.fromCharCode(...u8.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...u8.subarray(8, 12)) !== 'WAVE') {
    if (u8.length >= 4 && String.fromCharCode(...u8.subarray(0, 4)) === 'fLaC') return { flac: true };
    return null;
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 12, fmt = null, dataLen = null;
  while (p + 8 <= u8.length) {
    const id = String.fromCharCode(...u8.subarray(p, p + 4));
    const len = dv.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 24 <= u8.length) fmt = { format: dv.getUint16(p + 8, true), channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    if (id === 'data') dataLen = Math.min(len, u8.length - p - 8);
    p += 8 + len + (len & 1);
  }
  if (!fmt || dataLen === null) return null;
  return { ...fmt, duration: dataLen / (fmt.rate * fmt.channels * (fmt.bits / 8)) };
}

async function checkVoices(doc, E, R, where, path) {
  const at = join(where, path);
  const voices = arr(doc.voices);
  const ids = new Set();
  for (const [i, v] of voices.entries()) {
    const vat = `${at} → voices[${i}]`;
    if (!isPlainObject(v) || !nonEmpty(v.id)) { R.error('voice.id', vat, 'must have an id'); continue; }
    if (ids.has(v.id)) R.error('voice.id', vat, `the id ${v.id} is used twice`);
    ids.add(v.id);
    if (v.language !== undefined && !(str(v.language) && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v.language))) R.warn('voice.language', vat, 'language is not a BCP 47 tag');
    if (!['designed', 'recorded', 'imported', 'preset'].includes(v.origin)) R.error('voice.origin', vat, 'origin must be designed, recorded, imported or preset');
    if (v.origin === 'designed' && !isPlainObject(v.design)) R.error('voice.design', vat, 'a designed voice records how it was made (design)');
    if (typeof v.realPerson !== 'boolean') R.error('voice.real-person', vat, 'realPerson (true or false) is required (§9.3)');
    if (v.realPerson === true) {
      if (!nonEmpty(v.speaker)) R.error('voice.speaker', vat, 'a real person\'s voice must say whose it is (speaker)');
      if (!isPlainObject(v.consent) || typeof v.consent.given !== 'boolean') R.error('voice.consent', vat, 'a real person\'s voice must say how they agreed (consent.given)');
    }
    if (v.madeWith !== undefined && v.madeWith !== null) {
      if (!Array.isArray(v.madeWith)) R.error('voice.made-with', `${vat} → madeWith`, 'is a list, one entry per model (§9.2)');
      else for (const [k, mw] of v.madeWith.entries()) {
        if (!isPlainObject(mw) || !nonEmpty(mw.model)) R.error('voice.made-with', `${vat} → madeWith[${k}]`, 'names its model (§9.2)');
        else if ([mw.model, mw.version, mw.prompt, mw.license?.termsUrl].some((t) => typeof t === 'string' && /^(\/|~\/|file:|[A-Za-z]:[\\/])/.test(t))) R.error('voice.made-with', `${vat} → madeWith[${k}]`, 'holds a local path; madeWith never does (§9.2)');
      }
    }
    if (v.source !== undefined && v.source !== null && !str(v.source)) R.error('voice.source', `${vat} → source`, 'is text (§9.2)');
    checkMeta(v.meta, `${vat} → meta`, R);
    checkListing(v.listing, `${vat} → listing`, R);
    for (const [k, cl] of arr(v.clips).entries()) {
      const cat = `${vat} → clips[${k}]`;
      if (!isPlainObject(cl)) { R.error('voice.clip', cat, 'is not an object'); continue; }
      if (!nonEmpty(cl.transcript)) R.error('voice.transcript', cat, 'every clip needs its exact transcript (§9.1, D8)');
      if (!nonEmpty(cl.file) || !E.has(cl.file)) { R.error('voice.clip-missing', join(where, cl.file || cat), 'the clip file is missing'); continue; }
      const bytes = E.get(cl.file);
      const h = await sha256(bytes);
      if (cl.sha256 === undefined) R.error('voice.clip', cat, 'has no sha256: a clip\'s record has its file, its sha256 and its transcript (VRMXA §9.2, D36)');
      else if (cl.sha256 !== h) R.error('voice.clip-hash', join(where, cl.file), 'does not match the sha256 its record gives');
      const w = wavInfo(bytes);
      if (!w) R.error('voice.clip-format', join(where, cl.file), 'is not a WAV or FLAC file');
      else if (!w.flac) {
        if (w.format !== 1 || w.bits !== 16 || w.channels !== 1) R.warn('voice.clip-format', join(where, cl.file), 'the standard is WAV, 16-bit PCM, mono (D8)');
        if (w.rate < 24000) R.warn('voice.clip-rate', join(where, cl.file), `is ${w.rate} Hz; the standard is 24 kHz or higher (D8)`);
        if (w.duration < 3 || w.duration > 20) R.warn('voice.clip-length', join(where, cl.file), `is ${w.duration.toFixed(1)} s; outside 3 to 20 s some engines trim or refuse it (§9.1)`);
      }
    }
  }
  if (doc.default !== undefined && doc.default !== null && !ids.has(doc.default)) R.error('voice.default', `${at} → default`, 'names a voice that is not in the document');
}

function materialNames(avatar) {
  return new Set(arr(avatar?.json?.materials).map((x) => x?.name));
}

const ADJUST_KEYS = ['tone', 'brightness', 'saturation', 'multiply'];
const BANDS = ['skin', 'adjust', 'on', 'worn'];
// one layer (VRMXA §6.0, D37); `single`: the editor's layers have exactly one target each (eyes, mouth)
function checkLayer(l, E, R, lat, where, targets, { single = false } = {}) {
  if (!isPlainObject(l)) { R.error('layers.shape', lat, 'is not an object'); return; }
  const named = [...(l.target !== undefined ? [l.target] : []), ...arr(l.targets), ...Object.keys(obj(l.images)), ...Object.keys(obj(l.masks))];
  if (single && l.target === undefined) R.error('layers.target', lat, `a layer here has one target, one of ${targets.join(', ')}`);
  if (!named.length) R.error('layers.target', lat, 'names no target: give target, targets or images');
  for (const t of named) if (!targets.includes(t)) R.error('layers.target', lat, `target "${t}" must be one of ${targets.join(', ')}`);
  if (!['fill', 'image', 'adjust'].includes(l.kind)) R.error('layers.kind', lat, 'kind must be fill, image or adjust');
  if (l.kind === 'image' && l.image === undefined && !isPlainObject(l.images)) R.error('layers.kind', lat, 'an image layer names its picture, or a picture per target');
  if (l.kind === 'adjust' && !ADJUST_KEYS.some((k) => l[k] !== undefined)) R.error('layers.kind', lat, 'an adjust layer has a tone, brightness, saturation or multiply');
  if (l.blend !== undefined && !['normal', 'multiply', 'screen', 'overlay'].includes(l.blend)) R.error('layers.blend', lat, 'blend must be normal, multiply, screen or overlay');
  if (l.opacity !== undefined && (!num(l.opacity) || l.opacity < 0 || l.opacity > 1)) R.error('layers.opacity', lat, 'opacity must be 0 to 1');
  if (l.band !== undefined && !BANDS.includes(l.band)) R.error('layers.band', lat, `band must be ${BANDS.join(', ')}`);
  for (const f of [l.mask, l.image, ...Object.values(obj(l.images)), ...Object.values(obj(l.masks))]) if (f !== undefined && f !== null && !E.has(f)) R.error('layers.file', join(where, String(f)), 'a layer picture is missing');
}

function checkLayers(state, E, R, sat, where, targets) {
  for (const [k, l] of arr(state.layers).entries()) checkLayer(l, E, R, `${sat} → layers[${k}]`, where, targets, { single: true });
  for (const [t, f] of Object.entries(obj(state.baked))) {
    if (t === 'of') continue;
    if (!targets.includes(t)) R.error('layers.target', `${sat} → baked.${t}`, 'is not a target');
    if (!E.has(f)) R.error('layers.file', join(where, String(f)), 'a finished texture is missing');
  }
}

function checkEyes(doc, E, R, at, avatar) {
  const where = at.split(' → ').slice(0, -1).join(' → ');
  const targets = ['white', 'iris', 'highlight', 'brow', 'eyeline', 'eyelash'];
  const mats = materialNames(avatar);
  if (!(Array.isArray(doc.size) && doc.size.length === 2 && doc.size.every((x) => Number.isInteger(x) && x > 0))) R.error('eyes.size', at, 'size must be [width, height] in pixels');
  for (const [t, v] of Object.entries(obj(doc.targets))) {
    if (!targets.includes(t)) R.error('eyes.target', `${at} → targets.${t}`, 'is not one of the six eye targets: white, iris, highlight, brow, eyeline, eyelash');
    if (v?.size !== undefined && !(Array.isArray(v.size) && v.size.length === 2 && v.size.every((x) => Number.isInteger(x) && x > 0))) R.error('eyes.size', `${at} → targets.${t}.size`, 'size must be [width, height] in pixels');
    if (avatar?.json && !mats.has(v?.material)) R.warn('eyes.material', `${at} → targets.${t}`, `the material "${v?.material}" is not in avatar.vrm`);
  }
  const states = arr(doc.states);
  if (!states.length || states[0]?.name !== 'default') R.error('eyes.default', at, 'the first state must be "default" (§6.1)');
  const names = new Set();
  for (const [i, s] of states.entries()) {
    const sat = `${at} → states[${i}]`;
    if (!isPlainObject(s) || !nonEmpty(s.name)) { R.error('eyes.state', sat, 'must have a name'); continue; }
    if (names.has(s.name)) R.error('eyes.state', sat, `the name "${s.name}" is used twice`);
    names.add(s.name);
    if (s.from !== undefined && !states.some((x) => x?.name === s.from && x !== s)) R.error('eyes.state', sat, `is made from "${s.from}", which is not a state`);
    for (const h of arr(s.hide)) if (!targets.includes(h)) R.error('eyes.state', sat, `hides "${h}", which is not a target`);
    if (s.morphs !== undefined) {
      if (!isPlainObject(s.morphs)) R.error('eyes.state', sat, 'morphs are face shape → weight, 0 to 1, as for a mouth state (VRMXA §6.1, D36)');
      else for (const [k, v] of Object.entries(s.morphs)) if (!num(v) || v < 0 || v > 1) R.error('eyes.state', sat, `morph "${k}" must be 0 to 1`);
    }
    for (const l of arr(s.layers)) if (str(l?.fill) && !(l.fill in obj(doc.fills))) R.error('eyes.fill', sat, `a layer uses the fill "${l.fill}", which is not in fills`);
    checkLayers(s, E, R, sat, where, targets);
  }
}

function checkSkin(doc, E, R, at, avatar) {
  const where = at.split(' → ').slice(0, -1).join(' → ');
  const targets = ['skinFace', 'skinBody'];
  const mats = materialNames(avatar);
  for (const t of targets) if (!isPlainObject(obj(doc.targets)[t])) R.error('skin.target', `${at} → targets`, `has no ${t}: the skin document names both skin textures (VRMXA §6.3)`);
  for (const [t, v] of Object.entries(obj(doc.targets))) {
    if (!targets.includes(t)) R.error('skin.target', `${at} → targets.${t}`, 'is not skinFace or skinBody');
    else if (avatar?.json && !mats.has(v?.material)) R.warn('skin.material', `${at} → targets.${t}`, `the material "${v?.material}" is not in avatar.vrm`);
  }
  for (const [k, l] of arr(doc.layers).entries()) {
    checkLayer(l, E, R, `${at} → layers[${k}]`, where, targets);
    if (str(l?.fill) && !(l.fill in obj(doc.fills))) R.error('skin.fill', `${at} → layers[${k}]`, `uses the fill "${l.fill}", which is not in fills`);
  }
  for (const [t, f] of Object.entries(obj(doc.baked))) {
    if (!targets.includes(t)) R.error('layers.target', `${at} → baked.${t}`, 'is not a target');
    if (!E.has(f)) R.error('layers.file', join(where, String(f)), 'a finished texture is missing');
  }
}

function checkMouth(doc, E, R, at, avatar) {
  const where = at.split(' → ').slice(0, -1).join(' → ');
  const targets = ['mouth', 'lips'];
  if (avatar?.json && doc.mesh?.name && !arr(avatar.json.meshes).some((me) => me?.name === doc.mesh.name)) R.warn('mouth.mesh', `${at} → mesh`, `the mesh "${doc.mesh.name}" is not in avatar.vrm`);
  const mats = materialNames(avatar);
  for (const [t, v] of Object.entries(obj(doc.targets))) {
    if (!targets.includes(t)) R.error('mouth.target', `${at} → targets.${t}`, 'is not mouth or lips');
    if (avatar?.json && !mats.has(v?.material)) R.warn('mouth.material', `${at} → targets.${t}`, `the material "${v?.material}" is not in avatar.vrm`);
  }
  const states = arr(doc.states);
  if (!states.length || states[0]?.name !== 'default') R.error('mouth.default', at, 'the first state must be "default" (§6.2)');
  const names = new Set();
  for (const [i, s] of states.entries()) {
    const sat = `${at} → states[${i}]`;
    if (!isPlainObject(s) || !nonEmpty(s.name)) { R.error('mouth.state', sat, 'must have a name'); continue; }
    if (names.has(s.name)) R.error('mouth.state', sat, `the name "${s.name}" is used twice`);
    names.add(s.name);
    for (const [k, val] of Object.entries(obj(s.morphs))) if (!num(val) || val < 0 || val > 1) R.error('mouth.morph', sat, `morph "${k}" must be 0 to 1`);
    if (s.offsets !== undefined) {
      const o = s.offsets;
      if (!isPlainObject(o) || !nonEmpty(o.file) || !Number.isInteger(o.count)) R.error('mouth.offsets', sat, 'offsets must be { file, count, of }');
      else if (!E.has(o.file)) R.error('mouth.offsets', join(where, o.file), 'the offsets file is missing');
      else if (E.get(o.file).length !== o.count * 16) R.error('mouth.offsets', join(where, o.file), `holds ${E.get(o.file).length} bytes; ${o.count} records of 16 bytes make ${o.count * 16} (§6.2)`);
      else if (doc.mesh?.vertices) {
        const b = E.get(o.file);
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        let last = -1;
        for (let k = 0; k < o.count; k++) {
          const v = dv.getUint32(k * 16, true);
          if (v >= doc.mesh.vertices || v <= last) { R.error('mouth.offsets', join(where, o.file), 'vertex indices must be in order and inside the face mesh'); break; }
          last = v;
        }
      }
    }
    const bo = obj(s.baked).of;
    if (bo !== undefined && (!isPlainObject(bo) || ['skin', 'edits'].some((k) => bo[k] !== undefined && bo[k] !== null && !(str(bo[k]) && /^[0-9a-f]{64}$/.test(bo[k]))))) R.error('mouth.baked-of', `${sat} → baked.of`, 'names the skin and edit documents by SHA-256: { skin, edits } (VRMXA §6.2, D37)');
    checkLayers(s, E, R, sat, where, targets);
  }
}

// ---------------------------------------------------------------------------------------------
// Versions 2 to 4 (§1)

async function checkLegacy(c, v, R, where, opts) {
  const m = c.manifest;
  const E = c.entries;
  const at = (k) => join(where, VRMXA_MANIFEST, k);
  R.info('legacy.version', at('version'), `bundle version ${v}: it is brought forward to version 5 when opened (§1)`);
  const listed = new Map();
  const want = (path, sha, what) => {
    if (!nonEmpty(path)) return;
    listed.set(path, { sha, what });
  };
  want(m.body?.file || 'body.vrm', m.body?.sha256, 'the body');
  if (m.edits) want(m.edits.file || 'edits.json', m.edits.sha256, 'the edits');
  if (m.thumbnail) want(m.thumbnail, null, 'the thumbnail');
  for (const it of arr(m.items)) want(it?.file, it?.sha256, 'an item');
  for (const a of arr(m.animations)) {
    want(a?.motion?.file, a?.motion?.sha256, 'a motion document');
    want(a?.vrma?.file, a?.vrma?.sha256, 'a motion clip');
  }
  for (const [path, { sha, what }] of listed) {
    if (!E.has(path)) { R.error('legacy.missing', join(where, path), `${what} named in the manifest is missing`); continue; }
    if (sha && (await sha256(E.get(path))) !== sha) R.error('container.hash', join(where, path), 'does not match the SHA-256 the manifest declares (the bundle was changed or damaged)');
  }
  const names = c.packed ? c.zipNames : new Set(E.keys());
  for (const n of names) if (n !== VRMXA_MANIFEST && !listed.has(n)) R.error('container.inventory', join(where, n), 'is in the archive but the manifest does not name it');
  const bodyPath = m.body?.file || 'body.vrm';
  if (E.has(bodyPath)) {
    const body = E.get(bodyPath);
    const h = await sha256(body);
    const known = findBase(h, opts.bases || BASES);
    if (!known) R.error('legacy.unknown-body', join(where, bodyPath), `is not a published Spec (its SHA-256 is ${h.slice(0, 12)}…), so the bundle can't be brought forward: version 5 names its base, and a version ${v} bundle whose body isn't Spec has none (§1)`);
    else if (known.status === 'retired') R.warn('base.retired', join(where, bodyPath), 'is a retired Spec; the app has to move the character onto the current one (D21)');
    R.list.push(...checkModel(body, { where: join(where, bodyPath), kind: 'vrm', maxTextureSize: opts.maxTextureSize }).problems);
  }
  for (const it of arr(m.items)) {
    const b = E.get(it?.file);
    if (b && !isGlb(b) && !isZip(b)) R.error('legacy.item', join(where, it.file), 'is neither a GLB nor a .vrmxw');
  }
  if (m.edits && E.has(m.edits.file || 'edits.json')) {
    const r = parseJson(E.get(m.edits.file || 'edits.json'));
    if (r.error || !isPlainObject(r.value) || r.value.format !== 'vrmxa-edits') R.error('legacy.edits', join(where, m.edits.file || 'edits.json'), 'is not an edit document');
  }
}
