// The specification's own checker for .vrmxa and .vrmxw files, with no reference library (Node only):
//
//   container    the ZIP and untrusted-input rules (VRMXA §3.2, §3.5): names, sizes, manifest first, inventory, hashes
//   schemas      every manifest and section document against schemas/ (JSON Schema 2020-12)
//   references   what the schemas can't see: a published base, the closet's invariants C2–C5 and C7, clips and
//                pictures present with their hashes, a set's clips in clips, an item's sets requiring its own tags
//   models       VRMXW §13's rows on an item's model: a GLB without VRMC_vrm, the rig's nodes, skins of worn and
//                pinned items, state meshes, springs, and (with spec.vrm) the bind matrices against Spec's
//
// It does not open character.sqlite (that needs SQLite): the database rules of VRMXA §3.5 and §12 are left to
// readers that open it, such as the reference library. Each finding: { severity, code, where, rule, section, message }.
// The codes are the reference library's, so the two can be compared.

import { createHash } from 'node:crypto';
import { createSchemaChecker, FORMAT_SCHEMAS } from './validate.js';
import { readDirectory, readEntry } from './zip.js';

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObj(v) ? v : {});

const SECTIONS = {
  'zip.': ['VRMXA §3.2, §3.5', 'the ZIP rules'],
  'container.manifest-first': ['VRMXA §3.2; VRMXW §3', 'the manifest is the first entry'],
  'container.hash': ['VRMXA §3.2, §4 files', 'each entry\'s SHA-256 matches the manifest'],
  'container.inventory': ['VRMXA §3.5 Inventory', 'every entry is in files, and every listed file is an entry'],
  'container.size': ['VRMXA §3.5 Sizes', 'an entry never unpacks to more than the manifest declares'],
  'container.': ['VRMXA §3.1, §3.2', 'a bundle or an item is a ZIP'],
  'manifest.': ['VRMXA §4; VRMXW §4', 'the manifest is a JSON object, first'],
  'doc.': ['VRMXA §4, §2 rule 3', 'each document the manifest names is there, says its format, and is JSON'],
  'base.unknown': ['VRMXA §5.1; VRMXW §13 Base', 'the base is a published Spec (assets/spec/bases.json)'],
  'base.retired': ['VRMXA §5.1, D21', 'a retired Spec is moved onto the current one by the app'],
  'base.species': ['VRMXA §5.1, D24', 'species is the base\'s'],
  'closet.c2': ['CLOSET.md C2', 'every item names the bundle\'s base'],
  'closet.c3': ['CLOSET.md C3', 'closet.json lists exactly the item files present, each once'],
  'closet.c4': ['CLOSET.md C4; VRMXA §7.2', 'what is worn and every outfit list only closet items and obey the slot rules'],
  'closet.c5': ['CLOSET.md C5', 'every state recorded is one the item has; a worn outfit exists'],
  'closet.c7': ['CLOSET.md C7', 'every clip and set brought by an item belongs to an item in the closet'],
  'closet.item-id': ['VRMXA §7.4', 'an entry\'s id is the item\'s own'],
  'closet.hair': ['VRMXA §7.4, D4', 'hair names a hair piece in the closet'],
  'animations.slot-clip': ['VRMXA §8.4', 'a slot plays clips that are in clips'],
  'animations.clip-missing': ['VRMXA §8.1', 'every clip file exists'],
  'animations.clip-hash': ['VRMXA §8.4', 'a clip\'s sha256 is its file\'s'],
  'animations.edit-missing': ['VRMXA §8.4, D34', 'a clip\'s edit document is there'],
  'animations.edit-original': ['VRMXA §8.1, D34', 'the original stays in clips while an edit document refers to it'],
  'animations.item-requires': ['VRMXW §9, §13 Animations', 'every set an item brings requires one of the item\'s own tags'],
  'voice.clip-missing': ['VRMXA §9.2', 'every clip file is there'],
  'voice.clip-hash': ['VRMXA §9.2', 'a clip\'s sha256 is its file\'s'],
  'layers.file': ['VRMXA §6.0', 'every picture a layer or state names is there'],
  'eyes.fill': ['VRMXA §6.1', 'a layer\'s fill is in fills'],
  'skin.fill': ['VRMXA §6.3', 'a layer\'s fill is in fills'],
  'mouth.offsets': ['VRMXA §6.2', 'offsets are count records of 16 bytes, in order, inside the face mesh'],
  'item.model': ['VRMXW §4, §5', 'model.file names the model entry'],
  'item.model-vrm': ['VRMXW §5, §13 Model', 'the model is a glTF 2.0 GLB with no VRMC_vrm'],
  'item.rig': ['VRMXW §13 Rig', 'every index in rig.humanBones is a node in the model'],
  'item.state': ['VRMXW §8, §13 States', 'state names are unique; each bone is in the rig; show names mesh nodes; morphs are the item\'s'],
  'item.worn-skin': ['VRMXW §5.3 rule 1, §13 Worn', 'every mesh of a worn item has a skin'],
  'item.worn-joint': ['VRMXW §5.3, §13 Worn', 'every weighted joint is a humanoid bone or descends from one'],
  'item.pin-skin': ['VRMXW §5.4, W16, §13 Pin', 'no mesh of a pinned item is skinned to a humanoid bone'],
  'item.pin-place': ['VRMXW §5.4 rule 1, §13 Pin', 'a pinned item\'s nodes are under the node of attach.bone'],
  'item.bind': ['VRMXW §5.3 rule 4, §13 No change on Spec', 'every humanoid joint\'s inverse bind matrix is Spec\'s to within 1e-5'],
  'item.spring': ['VRMXW §5.5, §13 Springs', 'a node is a joint of one spring only, and joints descend in order'],
  'model.glb': ['VRMXA §3.5 Models', 'a model is a GLB whose parts lie inside it'],
  'model.external': ['VRMXA §3.5 Models', 'a model is self-contained'],
};
const sectionOf = (code) => {
  if (SECTIONS[code]) return SECTIONS[code];
  const k = Object.keys(SECTIONS).filter((p) => p.endsWith('.') && code.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return SECTIONS[k] || ['', ''];
};

class Findings {
  constructor() { this.list = []; }
  add(severity, code, where, message) {
    const [section, rule] = sectionOf(code);
    this.list.push({ severity, code, where, rule, section, message });
  }
  error(code, where, message) { this.add('error', code, where, message); }
  warn(code, where, message) { this.add('warning', code, where, message); }
}

const join = (...p) => p.filter((x) => x !== '' && x != null).join(' → ');

// ---- GLB (only what the checks read) ------------------------------------------------------------------------------
function parseGlb(u8) {
  if (u8.length < 20) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return null;
  const version = dv.getUint32(4, true);
  let p = 12, json = null, bin = null;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (p + 8 + len > u8.length) return null;
    const chunk = u8.subarray(p + 8, p + 8 + len);
    if (type === 0x4e4f534a && !json) { try { json = JSON.parse(new TextDecoder().decode(chunk)); } catch { return null; } }
    else if (type === 0x004e4942 && !bin) bin = chunk;
    p += 8 + len;
  }
  return json ? { version, json, bin: bin || new Uint8Array(0) } : null;
}
const COMPONENTS = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function readAccessor(json, bin, i) {
  const a = json.accessors?.[i];
  const v = json.bufferViews?.[a?.bufferView];
  const [Kind, bytes] = COMPONENTS[a?.componentType] || [];
  const n = SIZES[a?.type];
  if (!a || !v || !Kind || !n || a.sparse) return null;
  const stride = v.byteStride || bytes * n;
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  if (start + stride * (a.count - 1) + bytes * n > bin.length || start + stride * (a.count - 1) + bytes * n > (v.byteOffset || 0) + v.byteLength) return null;
  const out = new Kind(a.count * n);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](start + k * stride + c * bytes, true);
  return out;
}
function invert(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  const d = 1 / det;
  return [(a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d];
}
const parentsOf = (nodes) => { const p = new Map(); arr(nodes).forEach((n, i) => { for (const c of arr(n?.children)) p.set(c, i); }); return p; };

/** Spec's bind matrix (world, at rest) for each humanoid bone, from spec.vrm's skins. */
export function specBinds(specBytes) {
  const g = parseGlb(specBytes);
  const hb = g?.json?.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (!hb) return null;
  const boneOf = new Map(Object.entries(hb).map(([b, v]) => [v.node, b]));
  const out = new Map();
  for (const skin of arr(g.json.skins)) {
    const ibm = readAccessor(g.json, g.bin, skin.inverseBindMatrices);
    if (!ibm) continue;
    skin.joints.forEach((n, j) => { const b = boneOf.get(n); if (b && !out.has(b)) out.set(b, invert([...ibm.subarray(j * 16, j * 16 + 16)])); });
  }
  return out;
}

// ---- the checker ------------------------------------------------------------------------------------------------
/**
 * opts: { schemas ({ file: schema }), bases (bases.json's list), specBinds (Map, for the bind check), where }
 * → findings
 */
export function createChecker({ schemas, bases = [], specBinds: binds = null }) {
  const S = createSchemaChecker(schemas);

  function open(u8, manifestName, F, where) {
    const dir = readDirectory(u8);
    for (const p of dir.problems) F.error(p.code, join(where, p.where), p.message);
    if (!dir.entries.length) return null;
    if (dir.entries[0].name !== manifestName) F.error('container.manifest-first', join(where, dir.entries[0].name), `the first entry must be ${manifestName}`);
    const me = dir.entries.find((e) => e.name === manifestName);
    if (!me) { F.error('manifest.missing', join(where, manifestName), `there is no ${manifestName}`); return null; }
    const mr = readEntry(u8, me);
    if (mr.problem) { F.error(mr.problem.code, join(where, manifestName), mr.problem.message); return null; }
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(mr.data)); } catch (e) { F.error('manifest.json', join(where, manifestName), `is not JSON (${e.message})`); return null; }
    if (!isObj(manifest)) { F.error('manifest.json', join(where, manifestName), 'is not a JSON object'); return null; }
    const declared = new Map(arr(manifest.files).filter((f) => isObj(f) && typeof f.path === 'string').map((f) => [f.path, f]));
    const entries = new Map();
    const unsafe = new Set(dir.problems.filter((p) => ['zip.ratio', 'zip.entry-too-large', 'zip.entry-name', 'zip.link'].includes(p.code)).map((p) => p.where));
    for (const e of dir.entries) {
      if (e.name === manifestName || unsafe.has(e.name)) continue;
      const rec = declared.get(e.name);
      if (!rec) { F.error('container.inventory', join(where, e.name), 'is an entry the manifest\'s files does not list (VRMXA §3.5)'); continue; }
      if (Number.isInteger(rec.size) && e.size > rec.size) { F.error('container.size', join(where, e.name), `unpacks to ${e.size} bytes but the manifest declares ${rec.size}; not unpacked`); continue; }
      const r = readEntry(u8, e);
      if (r.problem) { F.error(r.problem.code, join(where, e.name), r.problem.message); continue; }
      if (typeof rec.sha256 === 'string' && sha256(r.data) !== rec.sha256) F.error('container.hash', join(where, e.name), 'does not match the SHA-256 the manifest declares');
      entries.set(e.name, r.data);
    }
    const present = new Set(dir.entries.map((e) => e.name));
    for (const path of declared.keys()) if (!present.has(path)) F.error('container.inventory', join(where, path), 'is listed in the manifest\'s files but is not in the archive');
    return { manifest, entries };
  }

  const schema = (F, doc, file, where) => F.list.push(...S.check(doc, file, { where }));
  const parse = (u8) => { try { return JSON.parse(new TextDecoder().decode(u8)); } catch { return undefined; } };

  function checkBase(F, base, where) {
    if (!isObj(base) || typeof base.sha256 !== 'string') return null;
    const known = bases.find((b) => b.sha256 === base.sha256);
    if (!known) { F.error('base.unknown', where, `the base ${base.sha256.slice(0, 12)}… is not a published Spec`); return null; }
    if ((known.species || 'human') !== (base.species || 'human')) F.error('base.species', where, `species is "${base.species || 'human'}" but that base is "${known.species || 'human'}"`);
    if (known.status === 'retired') F.warn('base.retired', where, 'names a retired Spec');
    return known;
  }

  // ---- items (VRMXW)
  function checkItem(u8, { where = '' } = {}) {
    const F = new Findings();
    const c = open(u8, 'vrmxw.json', F, where);
    if (!c) return F.list;
    const m = c.manifest;
    const at = (k) => join(where, 'vrmxw.json', k);
    schema(F, m, 'vrmxw.schema.json', join(where, 'vrmxw.json'));
    if (m.version !== 1) return F.list;
    checkBase(F, m.base, at('base'));
    const rig = obj(m.rig?.humanBones);
    const model = typeof m.model?.file === 'string' ? c.entries.get(m.model.file) : null;
    if (typeof m.model?.file === 'string' && !model) F.error('item.model', join(where, m.model.file), 'the model entry is missing');
    // states, by the manifest
    const names = new Set();
    for (const [i, s] of arr(m.states).entries()) {
      if (!isObj(s)) continue;
      if (names.has(s.name)) F.error('item.state', at(`states[${i}]`), `the name "${s.name}" is used twice`);
      names.add(s.name);
      if (s.bone !== undefined && m.kind === 'pin' && rig[s.bone] === undefined) F.error('item.state', at(`states[${i}]`), `bone "${s.bone}" is not in rig.humanBones`);
    }
    // animations the item brings
    if (isObj(m.animations)) {
      const own = new Set([...arr(m.tags), ...arr(m.states).flatMap((s) => arr(s?.tags))]);
      for (const [i, s] of arr(m.animations.sets).entries()) if (isObj(s) && arr(s.requires).length && !arr(s.requires).some((t) => own.has(t))) F.error('animations.item-requires', at(`animations.sets[${i}]`), 'requires none of the item\'s own tags');
      for (const cl of arr(m.animations.clips)) {
        if (!isObj(cl) || typeof cl.file !== 'string') continue;
        const b = c.entries.get(cl.file);
        if (!b) F.error('animations.clip-missing', join(where, cl.file), 'the clip file is missing');
        else if (cl.sha256 && sha256(b) !== cl.sha256) F.error('animations.clip-hash', join(where, cl.file), 'does not match the sha256 its record gives');
      }
    }
    if (model) checkItemModel(F, model, m, rig, join(where, m.model.file));
    return F.list;
  }

  function checkItemModel(F, u8, m, rig, where) {
    const g = parseGlb(u8);
    if (!g) return F.error('model.glb', where, 'is not a GLB');
    const { json, bin } = g;
    if (g.version !== 2 || json.asset?.version !== '2.0') F.error('item.model-vrm', where, 'is not glTF 2.0');
    if (json.extensions?.VRMC_vrm || arr(json.extensionsUsed).includes('VRMC_vrm')) F.error('item.model-vrm', where, 'carries VRMC_vrm: an item\'s model is a plain glTF, not a VRM (VRMXW §5)');
    for (const b of arr(json.buffers)) if (b?.uri !== undefined) F.error('model.external', where, 'refers to a buffer outside itself');
    for (const im of arr(json.images)) if (im?.uri !== undefined && !String(im.uri).startsWith('data:')) F.error('model.external', where, 'refers to an image outside itself');
    const nodes = arr(json.nodes);
    for (const [bone, n] of Object.entries(rig)) if (Number.isInteger(n) && n >= nodes.length) F.error('item.rig', join(where, `rig.humanBones.${bone}`), `node ${n} is not a node of the model`);
    const meshNodes = nodes.map((n, i) => (n?.mesh !== undefined ? i : -1)).filter((i) => i >= 0);
    const rigNodes = new Map(Object.entries(rig).map(([b, n]) => [n, b]));
    const par = parentsOf(nodes);
    const humanAncestor = (n) => { for (let c = n, k = 0; c !== undefined && k < 512; c = par.get(c), k++) if (rigNodes.has(c)) return c; return null; };
    // state meshes by node name (VRMXW §8, W24)
    const meshNames = new Set(meshNodes.map((i) => nodes[i]?.name).filter((x) => typeof x === 'string' && x));
    for (const [i, s] of arr(m.states).entries()) for (const name of arr(s?.show)) {
      if (Number.isInteger(name)) { if (!meshNodes.includes(name)) F.error('item.state', join(where, `states[${i}]`), `show names node ${name}, which is not a mesh node`); }
      else if (typeof name === 'string' && !meshNames.has(name)) F.error('item.state', join(where, `states[${i}]`), `show names "${name}", which is no mesh node's name`);
    }
    for (const [i, s] of arr(m.states).entries()) if (isObj(s?.morphs)) {
      const targets = new Set(arr(json.meshes).flatMap((me) => arr(me?.extras?.targetNames)));
      for (const k of Object.keys(s.morphs)) if (!targets.has(k)) F.error('item.state', join(where, `states[${i}]`), `morph "${k}" is not a morph target of the item`);
    }
    const weightedJoints = (n) => {
      const skin = json.skins?.[nodes[n].skin];
      const out = new Set();
      for (const p of arr(json.meshes?.[nodes[n].mesh]?.primitives)) {
        if (p?.attributes?.JOINTS_0 === undefined || p.attributes.WEIGHTS_0 === undefined) continue;
        const J = readAccessor(json, bin, p.attributes.JOINTS_0), W = readAccessor(json, bin, p.attributes.WEIGHTS_0);
        if (!J || !W) continue;
        for (let k = 0; k < J.length; k++) if (W[k] > 0) out.add(skin?.joints?.[J[k]]);
      }
      return out;
    };
    if (m.kind === 'worn') {
      for (const n of meshNodes) {
        if (nodes[n].skin === undefined) { F.error('item.worn-skin', join(where, `nodes[${n}]`), 'a worn item\'s every mesh has a skin (VRMXW §5.3)'); continue; }
        for (const j of weightedJoints(n)) if (j === undefined || humanAncestor(j) === null) F.error('item.worn-joint', join(where, `nodes[${j}]`), 'is weighted but is neither a humanoid bone nor descends from one');
      }
    } else if (m.kind === 'pin' && isObj(m.attach)) {
      const boneNode = rig[m.attach.bone];
      const chain = new Map();
      for (const [si, sp] of arr(json.extensions?.VRMC_springBone?.springs).entries()) for (const j of arr(sp?.joints)) chain.set(j?.node, si);
      for (const n of meshNodes) {
        if (nodes[n].skin !== undefined) {
          const js = weightedJoints(n);
          const chains = new Set([...js].map((j) => chain.get(j)));
          if ([...js].some((j) => rigNodes.has(j) || !chain.has(j)) || chains.size > 1) F.error('item.pin-skin', join(where, `nodes[${n}]`), 'a pinned item\'s mesh may be skinned only to the bones of one of its own spring chains, never to a humanoid bone');
        }
        let under = false;
        for (let c = par.get(n), k = 0; c !== undefined && k < 512; c = par.get(c), k++) if (c === boneNode) { under = true; break; }
        if (!under && Number.isInteger(boneNode) && boneNode < nodes.length) F.error('item.pin-place', join(where, `nodes[${n}]`), `is not under the node of ${m.attach.bone}`);
      }
    }
    const sb = json.extensions?.VRMC_springBone;
    if (sb) {
      const owner = new Map();
      for (const [si, sp] of arr(sb.springs).entries()) {
        const joints = arr(sp?.joints).map((j) => j?.node);
        joints.forEach((n, k) => {
          if (owner.has(n) && owner.get(n) !== si) F.error('item.spring', join(where, `VRMC_springBone.springs[${si}]`), `node ${n} is a joint of more than one spring`);
          owner.set(n, si);
          if (rigNodes.has(n)) F.error('item.spring', join(where, `VRMC_springBone.springs[${si}]`), `joint ${k} is a humanoid bone`);
          if (k > 0 && par.get(n) !== joints[k - 1]) F.error('item.spring', join(where, `VRMC_springBone.springs[${si}]`), `joint ${k} is not a child of joint ${k - 1}`);
        });
      }
    }
    if (binds && m.kind === 'worn') {
      let worst = 0, worstBone = null;
      for (const skin of arr(json.skins)) {
        const ibm = readAccessor(json, bin, skin?.inverseBindMatrices);
        if (!ibm) continue;
        skin.joints.forEach((node, j) => {
          const bone = rigNodes.get(node);
          const ref = bone && binds.get(bone);
          const a = ref && invert([...ibm.subarray(j * 16, j * 16 + 16)]);
          if (!a) return;
          const d = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((k) => Math.abs(a[k] - ref[k])));
          if (d > worst) { worst = d; worstBone = bone; }
        });
      }
      if (worst > 1e-5) F.error('item.bind', where, `its humanoid joints are not bound where Spec binds them: ${worstBone} is off by ${(worst * 1000).toFixed(2)} mm (checked through the bind matrices, not by wearing it)`);
    }
  }

  // ---- bundles (VRMXA)
  function checkBundle(u8, { where = '' } = {}) {
    const F = new Findings();
    const c = open(u8, 'vrmxa.json', F, where);
    if (!c) return F.list;
    const m = c.manifest;
    const E = c.entries;
    const at = (k) => join(where, 'vrmxa.json', k);
    schema(F, m, 'vrmxa.schema.json', join(where, 'vrmxa.json'));
    if (m.version !== 5) return F.list;
    const base = checkBase(F, m.base, at('base'));
    // avatar.vrm's pieces (VRMXA §5.2, D33)
    const avatar = typeof m.avatar?.file === 'string' ? E.get(m.avatar.file) : null;
    if (avatar) {
      const g = parseGlb(avatar);
      if (!g) F.error('model.glb', join(where, m.avatar.file), 'is not a GLB');
      else {
        if (g.json.extras?.vrmxaPieces !== undefined) schema(F, g.json.extras.vrmxaPieces, 'vrmxa-pieces.schema.json', join(where, m.avatar.file, 'extras.vrmxaPieces'));
        // skin hidden under worn items (VRMXA §5.2, D37)
        arr(g.json.materials).forEach((mt, i) => { if (mt?.extras?.vrmxaHidden !== undefined) schema(F, mt.extras.vrmxaHidden, 'vrmxa-hidden.schema.json', join(where, m.avatar.file, `materials[${i}].extras.vrmxaHidden`)); });
      }
    }
    // the documents the manifest names
    const s = obj(m.sections);
    const named = {};
    const ap = obj(s.appearance);
    for (const role of ['edits', 'measurements', 'eyes', 'mouth', 'skin']) { const d = ap[role]; if (typeof d === 'string') named[role] = d; else if (isObj(d) && typeof d.file === 'string') named[role] = d.file; }
    for (const [role, sec] of [['closet', 'closet'], ['animations', 'animations'], ['voices', 'voice']]) if (isObj(s[sec]) && typeof s[sec].file === 'string') named[role] = s[sec].file;
    const docs = {};
    for (const [role, path] of Object.entries(named)) {
      const b = E.get(path);
      if (!b) { F.error('doc.missing', join(where, path), `the ${role} document named in the manifest is missing`); continue; }
      const doc = parse(b);
      if (!isObj(doc)) { F.error('doc.json', join(where, path), 'is not a JSON object'); continue; }
      const file = S.schemaForFormat(doc);
      if (!file) { if (!FORMAT_SCHEMAS[doc.format]) F.error('doc.format', join(where, path), `format "${doc.format}" is not one of the specification's`); continue; }
      schema(F, doc, file, join(where, path));
      docs[role] = doc;
    }
    // pictures and shapes the eyes, mouth and skin name (VRMXA §6.0)
    const layerPictures = (l) => [l?.mask, l?.image, ...Object.values(obj(l?.images)), ...Object.values(obj(l?.masks))];
    if (docs.skin) {
      for (const l of arr(docs.skin.layers)) {
        for (const p of layerPictures(l)) if (typeof p === 'string' && !E.has(p)) F.error('layers.file', join(where, p), 'a layer picture is missing');
        if (typeof l?.fill === 'string' && !(l.fill in obj(docs.skin.fills))) F.error('skin.fill', join(where, named.skin), `a layer uses the fill "${l.fill}", which is not in fills`);
      }
      for (const p of Object.values(obj(docs.skin.baked))) if (typeof p === 'string' && !E.has(p)) F.error('layers.file', join(where, p), 'a finished texture is missing');
    }
    for (const role of ['eyes', 'mouth']) {
      const d = docs[role];
      if (!d) continue;
      for (const st of arr(d.states)) {
        for (const l of arr(st?.layers)) {
          for (const p of layerPictures(l)) if (typeof p === 'string' && !E.has(p)) F.error('layers.file', join(where, p), 'a layer picture is missing');
          if (role === 'eyes' && typeof l?.fill === 'string' && !(l.fill in obj(d.fills))) F.error('eyes.fill', join(where, named[role]), `a layer uses the fill "${l.fill}", which is not in fills`);
        }
        for (const [k, p] of Object.entries(obj(st?.baked))) if (k !== 'of' && typeof p === 'string' && !E.has(p)) F.error('layers.file', join(where, p), 'a finished texture is missing');
        const o = st?.offsets;
        if (role === 'mouth' && isObj(o) && typeof o.file === 'string') {
          const b = E.get(o.file);
          if (!b) F.error('mouth.offsets', join(where, o.file), 'the offsets file is missing');
          else if (Number.isInteger(o.count) && b.length !== o.count * 16) F.error('mouth.offsets', join(where, o.file), `holds ${b.length} bytes; ${o.count} records of 16 bytes make ${o.count * 16}`);
        }
      }
    }
    // the closet (CLOSET.md §2)
    const closetIds = new Set();
    if (docs.closet) {
      const cl = docs.closet;
      const byId = new Map();
      const files = new Set();
      for (const e of arr(cl.items)) {
        if (!isObj(e) || typeof e.id !== 'string') continue;
        if (byId.has(e.id)) F.error('closet.c3', join(where, named.closet), `lists item ${e.id} twice`);
        byId.set(e.id, { entry: e, states: arr(e.states).map((x) => x?.name), slot: e.slot });
        closetIds.add(e.id);
        if (typeof e.file !== 'string') continue;
        files.add(e.file);
        const b = E.get(e.file);
        if (!b) { F.error('closet.c3', join(where, e.file), 'is listed in closet.json but is not in the bundle'); continue; }
        // C1: the item is a valid item in its own right
        F.list.push(...checkItem(b, { where: join(where, e.file) }));
        const d = readDirectory(b);
        const me = d.entries.find((x) => x.name === 'vrmxw.json');
        const im = me ? parse(readEntry(b, me).data || new Uint8Array(0)) : null;
        if (isObj(im)) {
          if (im.id !== e.id) F.error('closet.item-id', join(where, named.closet), `the entry's id is ${e.id} but the item's own is ${im.id}`);
          if (base && im.base?.sha256 !== base.sha256) F.error('closet.c2', join(where, e.file), 'the item names another base than the character\'s');
          byId.get(e.id).states = arr(im.states).map((x) => x?.name);
          byId.get(e.id).slot = im.slot ?? e.slot;
        }
        if (base && typeof e.base === 'string' && e.base !== base.sha256) F.error('closet.c2', join(where, named.closet, 'base'), 'the entry\'s base is not the manifest\'s base.sha256');
      }
      for (const p of E.keys()) if (/^(closet\/items|appearance\/hair)\/[^/]+\.vrmxw$/.test(p) && !files.has(p)) F.error('closet.c3', join(where, p), 'is an item file not listed in closet.json');
      if (typeof cl.hair === 'string' && byId.get(cl.hair)?.slot !== 'hair') F.error('closet.hair', join(where, named.closet, 'hair'), 'names no hair piece in the closet');
      const checkSet = (ids, states, w) => {
        const slots = new Map();
        for (const id of arr(ids)) {
          const it = byId.get(id);
          if (!it) { F.error('closet.c4', w, `lists ${id}, which is not in the closet`); continue; }
          if (it.slot === 'hair') F.error('closet.c4', w, 'lists a hair piece: hair is chosen once (D4)');
          if (it.slot !== 'accessory') slots.set(it.slot, (slots.get(it.slot) || 0) + 1);
        }
        for (const [slot, n] of slots) if (n > 1 && slot !== 'hair') F.error('closet.c4', w, `has ${n} items in the slot "${slot}"; one per slot except accessory`);
        if (slots.has('onepiece') && (slots.has('tops') || slots.has('bottoms'))) F.error('closet.c4', w, 'has a onepiece with tops or bottoms');
        for (const [id, st] of Object.entries(obj(states))) {
          if (!arr(ids).includes(id)) { F.error('closet.c5', w, `records a state for ${id}, which it doesn't list`); continue; }
          if (byId.has(id) && !byId.get(id).states.includes(st)) F.error('closet.c5', w, `records the state "${st}" for ${id}, which the item does not have`);
        }
      };
      if (isObj(cl.worn)) {
        checkSet(cl.worn.items, cl.worn.states, join(where, named.closet, 'worn'));
        if (typeof cl.worn.outfit === 'string' && !arr(cl.outfits).some((o) => o?.id === cl.worn.outfit)) F.error('closet.c5', join(where, named.closet, 'worn.outfit'), 'names an outfit that does not exist');
      }
      for (const [i, o] of arr(cl.outfits).entries()) if (isObj(o)) checkSet(o.items, o.states, join(where, named.closet, `outfits[${i}]`));
    } else {
      for (const p of E.keys()) if (/^(closet\/items|appearance\/hair)\/[^/]+\.vrmxw$/.test(p)) F.error('closet.c3', join(where, p), 'is an item file, but the bundle has no closet.json');
    }
    // animations: clips present, a set's clips in clips, C7
    if (docs.animations) {
      const a = docs.animations;
      const clips = new Set();
      for (const [i, cl] of arr(a.clips).entries()) {
        if (!isObj(cl)) continue;
        if (typeof cl.sha256 === 'string') clips.add(cl.sha256);
        const b = typeof cl.file === 'string' ? E.get(cl.file) : null;
        if (!b) F.error('animations.clip-missing', join(where, cl.file || `clips[${i}]`), 'the clip file is missing');
        else if (cl.sha256 && sha256(b) !== cl.sha256) F.error('animations.clip-hash', join(where, cl.file), 'does not match the sha256 its record gives');
        if (typeof cl.edit === 'string') {
          const eb = E.get(cl.edit);
          if (!eb) F.error('animations.edit-missing', join(where, cl.edit), 'the edit document is missing');
          else { const ed = parse(eb); if (isObj(ed) && ed.version === 1) schema(F, ed, 'vrmxa-motion-edit.schema.json', join(where, cl.edit)); else if (!isObj(ed) || ed.format !== 'vrmxa-motion-edit') schema(F, ed ?? null, 'vrmxa-motion-edit.schema.json', join(where, cl.edit)); }
        }
        if (cl.from !== undefined && docs.closet && !closetIds.has(cl.from)) F.error('closet.c7', join(where, named.animations, `clips[${i}]`), `was brought by item ${cl.from}, which is not in the closet`);
      }
      for (const [i, cl] of arr(a.clips).entries()) if (isObj(cl) && cl.edit !== undefined && typeof cl.derivedFrom === 'string' && !clips.has(cl.derivedFrom)) F.error('animations.edit-original', join(where, named.animations, `clips[${i}]`), 'its edit document refers to an original that is not in clips');
      for (const [i, st] of arr(a.sets).entries()) {
        if (!isObj(st)) continue;
        for (const [slot, list] of Object.entries(obj(st.slots))) for (const e of arr(list)) if (isObj(e) && !clips.has(e.clip)) F.error('animations.slot-clip', join(where, named.animations, `sets[${i}].slots.${slot}`), `names a clip (${String(e.clip).slice(0, 12)}…) that is not in clips`);
        if (st.from !== undefined && (!docs.closet || !closetIds.has(st.from))) F.error('closet.c7', join(where, named.animations, `sets[${i}]`), `was brought by item ${st.from}, which is not in the closet`);
      }
    }
    // voices: clips present with their hashes
    if (docs.voices) for (const v of arr(docs.voices.voices)) for (const cl of arr(v?.clips)) {
      if (!isObj(cl) || typeof cl.file !== 'string') continue;
      const b = E.get(cl.file);
      if (!b) F.error('voice.clip-missing', join(where, cl.file), 'the clip file is missing');
      else if (cl.sha256 && sha256(b) !== cl.sha256) F.error('voice.clip-hash', join(where, cl.file), 'does not match the sha256 its record gives');
    }
    return F.list;
  }

  /** A .vrmxa or a .vrmxw, by its manifest's name (or the file's name when given). */
  function checkFile(u8, { name = '', where = '' } = {}) {
    const d = readDirectory(u8);
    const first = d.entries[0]?.name;
    const isItem = name.endsWith('.vrmxw') || (!name.endsWith('.vrmxa') && (first === 'vrmxw.json' || d.entries.some((e) => e.name === 'vrmxw.json')));
    return isItem ? checkItem(u8, { where }) : checkBundle(u8, { where });
  }

  return { checkBundle, checkItem, checkFile, schemaChecker: S };
}
