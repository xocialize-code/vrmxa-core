// The specification's checker for .vrmxi game items (VRMXI §13), with no reference library (Node only):
//
//   container    the ZIP and untrusted-input rules (VRMXA §3.2, §3.5), with vrmxi.json first
//   schema       vrmxi.json against schemas/vrmxi.schema.json (code schema.vrmxi)
//   model        a GLB without VRMC_vrm, self-contained; unique node names; every name the manifest gives a node's;
//                implicit shapes only (§5.2); animated colliders kinematic (§5.1)
//   behaviour    joints, states, verbs, seat and spawn against the model (§6–§8); the type's needs (§2)
//   takeable     a takeable item's wearable is there, matches its record and is a valid .vrmxw (checked with the
//                VRMXW checker, its findings prefixed with where it is); an item that can't be taken carries none;
//                the item's terms are no looser than its wearable's (§9)
//
// Kept apart from check.js so the VRMXA and VRMXW checker the reference library mirrors byte for byte is unchanged.
// Each finding: { severity, code, where, rule, section, message }, as check.js reports them.

import { createHash } from 'node:crypto';
import { createSchemaChecker } from './validate.js';
import { readDirectory, readEntry } from './zip.js';

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (isObj(v) ? v : {});
const join = (...p) => p.filter((x) => x !== '' && x != null).join(' → ');

export const VRMXI_SCHEMA = 'vrmxi.schema.json';
export const VRMXI_TYPES = ['door', 'container', 'pickup', 'switch', 'seat', 'spawnPoint'];
export const VRMXI_LATER_TYPES = ['vehicle', 'ladder', 'screen'];
const VERB_SLOT = { open: 'use', take: 'take', use: 'use', sit: 'sit', talk: 'talk' };
const TYPE_NEEDS = { door: 'open', container: 'open', pickup: 'take', switch: 'use', seat: 'sit' };
const ALLOWED_EXTENSIONS = new Set(['KHR_physics_rigid_bodies', 'KHR_implicit_shapes', 'KHR_collision_shapes', 'VRMC_materials_mtoon', 'KHR_materials_unlit', 'KHR_texture_transform', 'KHR_materials_emissive_strength']);

const SECTIONS = {
  'zip.': ['VRMXA §3.2, §3.5', 'the ZIP rules'],
  'container.manifest-first': ['VRMXI §3; VRMXA §3.2', 'the manifest is the first entry'],
  'container.hash': ['VRMXA §3.2, §4 files', 'each entry\'s SHA-256 matches the manifest'],
  'container.inventory': ['VRMXA §3.5 Inventory', 'every entry is in files, and every listed file is an entry'],
  'container.size': ['VRMXA §3.5 Sizes', 'an entry never unpacks to more than the manifest declares'],
  'container.': ['VRMXI §3', 'a game item is a ZIP'],
  'manifest.': ['VRMXI §4', 'the manifest is a JSON object, first'],
  'model.glb': ['VRMXA §3.5 Models', 'a model is a GLB whose parts lie inside it'],
  'model.external': ['VRMXA §3.5 Models', 'a model is self-contained'],
  'vrmxi.model': ['VRMXI §5, §13 Model', 'the model is a glTF 2.0 GLB with no VRMC_vrm, requiring only §5\'s extensions'],
  'vrmxi.nodes': ['VRMXI §5, I8, §13 Model', 'node names are unique, and every name the manifest gives is a node\'s'],
  'vrmxi.shape': ['VRMXI §5.2, I6, §13 Shapes', 'colliders and sensors use a box, sphere, capsule or cylinder (equal radii); no plane, no mesh collider'],
  'vrmxi.body': ['VRMXI §5.1, §13 Bodies', 'every animated node with a collider under it is in a kinematic body'],
  'vrmxi.joint': ['VRMXI §6, I7, §13 Joints', 'a joint holds a dynamic body, by unique name, within its limits'],
  'vrmxi.state': ['VRMXI §7, §13 States', 'state names are unique; show, morphs, joints, play, loop and sensors name what the item has'],
  'vrmxi.verb': ['VRMXI §8, §13 Verbs', 'a verb\'s states, to, reach and at name what the item has; a verb appears at most once in a state'],
  'vrmxi.place': ['VRMXI §8.2, §8.3, §13 Seat, spawn', 'seat points and the spawn node are nodes of the model'],
  'vrmxi.type': ['VRMXI §2, §13 Type', 'an M1 type offers its verb: door and container open, pickup take, switch use, seat sit'],
  'vrmxi.takeable': ['VRMXI §9, I2, §13 Takeable', 'a takeable item offers take'],
  'vrmxi.wearable': ['VRMXI §9, I2, §13 Wearable', 'a takeable item embeds its .vrmxw as recorded; an item that can\'t be taken carries none'],
  'vrmxi.licence': ['VRMXI §9 rule 7, I15, §13 Licence', 'a takeable item\'s permissions are no looser than its wearable\'s'],
};
const sectionOf = (code) => {
  if (SECTIONS[code]) return SECTIONS[code];
  const k = Object.keys(SECTIONS).filter((p) => p.endsWith('.') && code.startsWith(p)).sort((a, b) => b.length - a.length)[0];
  return SECTIONS[k] || ['', ''];
};

class Findings {
  constructor() { this.list = []; }
  add(severity, code, where, message) { const [section, rule] = sectionOf(code); this.list.push({ severity, code, where, rule, section, message }); }
  error(code, where, message) { this.add('error', code, where, message); }
  warn(code, where, message) { this.add('warning', code, where, message); }
}

function parseGlb(u8) {
  if (u8.length < 20) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) return null;
  const version = dv.getUint32(4, true);
  let p = 12, json = null;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (p + 8 + len > u8.length) return null;
    if (type === 0x4e4f534a && !json) { try { json = JSON.parse(new TextDecoder().decode(u8.subarray(p + 8, p + 8 + len))); } catch { return null; } }
    p += 8 + len;
  }
  return json ? { version, json } : null;
}

// VRM 1.0's permission values, loosest last; absent values take VRM's defaults (VRMXW §11).
const ORDER = {
  commercialUsage: ['personalNonProfit', 'personalProfit', 'corporation'],
  creditNotation: ['required', 'unnecessary'],
  allowRedistribution: [false, true],
  modification: ['prohibited', 'allowModification', 'allowModificationRedistribution'],
  allowExcessivelyViolentUsage: [false, true],
  allowExcessivelySexualUsage: [false, true],
  allowPoliticalOrReligiousUsage: [false, true],
  allowAntisocialOrHateUsage: [false, true],
};
const rank = (meta, k) => { const o = ORDER[k]; const v = meta[k] === undefined ? o[0] : meta[k]; const i = o.indexOf(v); return i < 0 ? 0 : i; };

/**
 * opts: { schemas ({ file: schema }), itemChecker (check.js's createChecker result, for the embedded .vrmxw) }
 * → { checkGameItem(u8, { where }) → findings }
 */
export function createGameItemChecker({ schemas, itemChecker }) {
  const S = createSchemaChecker(schemas);

  function open(u8, F, where) {
    const name = 'vrmxi.json';
    const dir = readDirectory(u8);
    for (const p of dir.problems) F.error(p.code, join(where, p.where), p.message);
    if (!dir.entries.length) return null;
    if (dir.entries[0].name !== name) F.error('container.manifest-first', join(where, dir.entries[0].name), `the first entry must be ${name}`);
    const me = dir.entries.find((e) => e.name === name);
    if (!me) { F.error('manifest.missing', join(where, name), `there is no ${name}`); return null; }
    const mr = readEntry(u8, me);
    if (mr.problem) { F.error(mr.problem.code, join(where, name), mr.problem.message); return null; }
    let manifest;
    try { manifest = JSON.parse(new TextDecoder().decode(mr.data)); } catch (e) { F.error('manifest.json', join(where, name), `is not JSON (${e.message})`); return null; }
    if (!isObj(manifest)) { F.error('manifest.json', join(where, name), 'is not a JSON object'); return null; }
    const declared = new Map(arr(manifest.files).filter((f) => isObj(f) && typeof f.path === 'string').map((f) => [f.path, f]));
    const entries = new Map();
    const unsafe = new Set(dir.problems.filter((p) => ['zip.ratio', 'zip.entry-too-large', 'zip.entry-name', 'zip.link'].includes(p.code)).map((p) => p.where));
    for (const e of dir.entries) {
      if (e.name === name || unsafe.has(e.name)) continue;
      const rec = declared.get(e.name);
      if (!rec) { F.error('container.inventory', join(where, e.name), 'is an entry the manifest\'s files does not list (VRMXA §3.5)'); continue; }
      if (Number.isInteger(rec.size) && e.size > rec.size) { F.error('container.size', join(where, e.name), `unpacks to ${e.size} bytes but the manifest declares ${rec.size}; not unpacked`); continue; }
      const r = readEntry(u8, e);
      if (r.problem) { F.error(r.problem.code, join(where, e.name), r.problem.message); continue; }
      if (typeof rec.sha256 === 'string' && sha256(r.data) !== rec.sha256) F.error('container.hash', join(where, e.name), 'does not match the SHA-256 the manifest declares');
      entries.set(e.name, { data: r.data, method: e.method });
    }
    const present = new Set(dir.entries.map((e) => e.name));
    for (const path of declared.keys()) if (!present.has(path)) F.error('container.inventory', join(where, path), 'is listed in the manifest\'s files but is not in the archive');
    return { manifest, entries };
  }

  function checkGameItem(u8, { where = '' } = {}) {
    const F = new Findings();
    const c = open(u8, F, where);
    if (!c) return F.list;
    const m = c.manifest;
    const at = (k) => join(where, 'vrmxi.json', k);
    for (const p of S.check(m, VRMXI_SCHEMA, { where: join(where, 'vrmxi.json') })) F.list.push(p.code === 'schema' ? { ...p, code: 'schema.vrmxi' } : p);
    if (m.version !== 1) return F.list;

    // ---- the model
    const modelPath = typeof m.model?.file === 'string' ? m.model.file : null;
    const model = modelPath ? c.entries.get(modelPath)?.data : null;
    if (modelPath && !model) F.error('vrmxi.model', join(where, modelPath), 'the model entry is missing');
    let json = null;
    if (model) {
      const g = parseGlb(model);
      if (!g) F.error('model.glb', join(where, modelPath), 'is not a GLB');
      else {
        json = g.json;
        const w = join(where, modelPath);
        if (g.version !== 2 || json.asset?.version !== '2.0') F.error('vrmxi.model', w, 'is not glTF 2.0');
        if (json.extensions?.VRMC_vrm || arr(json.extensionsUsed).includes('VRMC_vrm')) F.error('vrmxi.model', w, 'carries VRMC_vrm: a game item\'s model is a plain glTF, not a VRM');
        for (const x of arr(json.extensionsRequired)) if (!ALLOWED_EXTENSIONS.has(x)) F.error('vrmxi.model', w, `requires ${x}, which is not one of VRMXI §5's extensions`);
        for (const b of arr(json.buffers)) if (b?.uri !== undefined) F.error('model.external', w, 'refers to a buffer outside itself');
        for (const im of arr(json.images)) if (im?.uri !== undefined && !String(im.uri).startsWith('data:')) F.error('model.external', w, 'refers to an image outside itself');
      }
    }
    const nodes = arr(json?.nodes);
    const w = join(where, modelPath);
    const byName = new Map();
    nodes.forEach((n, i) => {
      if (typeof n?.name !== 'string' || !n.name) return;
      if (byName.has(n.name)) F.error('vrmxi.nodes', join(w, `nodes[${i}]`), `the name "${n.name}" is used by more than one node`);
      else byName.set(n.name, i);
    });
    const par = new Map();
    nodes.forEach((n, i) => { for (const ch of arr(n?.children)) par.set(ch, i); });
    const khr = (i) => obj(nodes[i]?.extensions?.KHR_physics_rigid_bodies);
    const bodyOf = (i) => { for (let k = i, d = 0; k !== undefined && d < 512; k = par.get(k), d++) if (isObj(khr(k).motion)) return k; return null; };
    const subtree = (i) => { const out = [i]; for (let q = 0; q < out.length && out.length < 4096; q++) for (const ch of arr(nodes[out[q]]?.children)) out.push(ch); return out; };
    const meshNames = new Set(nodes.filter((n) => n?.mesh !== undefined && typeof n.name === 'string').map((n) => n.name));
    const sensorNames = new Set(nodes.filter((n, i) => isObj(khr(i).trigger) && typeof n?.name === 'string').map((n) => n.name));
    const animNames = new Set(arr(json?.animations).map((a) => a?.name).filter((x) => typeof x === 'string'));
    const morphNames = new Set(arr(json?.meshes).flatMap((me) => arr(me?.extras?.targetNames)));
    const hasModel = !!json;
    const node = (name, where2, what) => {
      if (!hasModel || typeof name !== 'string') return null;
      if (!byName.has(name)) { F.error('vrmxi.nodes', where2, `${what} names "${name}", which is no node's name in the model`); return null; }
      return byName.get(name);
    };

    // ---- shapes and bodies (§5.1, §5.2)
    if (json) {
      const shapes = arr(json.extensions?.KHR_implicit_shapes?.shapes ?? json.extensions?.KHR_collision_shapes?.shapes);
      nodes.forEach((n, i) => {
        const k = khr(i);
        if (k.joint !== undefined) F.warn('vrmxi.joint', join(w, `nodes[${i}]`), 'carries a KHR joint, which a reader ignores: joints are in the manifest (VRMXI §6)');
        for (const role of ['collider', 'trigger']) {
          if (!isObj(k[role])) continue;
          const g = obj(k[role].geometry);
          const here = join(w, `nodes[${i}]${n?.name ? ` (${n.name})` : ''}`, role);
          if (g.node !== undefined || g.convexHull !== undefined || (k[role].nodes !== undefined && g.shape === undefined)) { F.error('vrmxi.shape', here, 'is a mesh collider; version 1 allows implicit shapes only'); continue; }
          const s = shapes[g.shape];
          if (!isObj(s)) { F.error('vrmxi.shape', here, `names shape ${g.shape}, which is not in KHR_implicit_shapes`); continue; }
          const d = obj(s[s.type]);
          const pos = (v) => typeof v === 'number' && v > 0;
          if (s.type === 'box') { if (!(Array.isArray(d.size) && d.size.length === 3 && d.size.every(pos))) F.error('vrmxi.shape', here, 'a box\'s size is three lengths above 0'); }
          else if (s.type === 'sphere') { if (!pos(d.radius)) F.error('vrmxi.shape', here, 'a sphere\'s radius is above 0'); }
          else if (s.type === 'capsule' || s.type === 'cylinder') {
            if (!pos(d.radiusTop) || d.radiusTop !== d.radiusBottom) F.error('vrmxi.shape', here, `a ${s.type}'s radiusTop and radiusBottom are equal and above 0 (no tapered shapes in version 1)`);
            if (!(typeof d.height === 'number' && (s.type === 'capsule' ? d.height >= 0 : d.height > 0))) F.error('vrmxi.shape', here, `a ${s.type}'s height is ${s.type === 'capsule' ? '0 or more' : 'above 0'}`);
          } else F.error('vrmxi.shape', here, `uses a ${JSON.stringify(s.type)} shape; version 1 allows box, sphere, capsule and cylinder`);
        }
      });
      for (const [ai, a] of arr(json.animations).entries()) {
        const moved = new Set(arr(a?.channels).map((ch) => ch?.target?.node).filter(Number.isInteger));
        for (const n of moved) {
          if (!subtree(n).some((k) => isObj(khr(k).collider))) continue;
          const b = bodyOf(n);
          if (b === null || khr(b).motion?.isKinematic !== true) F.error('vrmxi.body', join(w, `animations[${ai}]${a?.name ? ` (${a.name})` : ''}`), `moves node ${n}${nodes[n]?.name ? ` (${nodes[n].name})` : ''}, which has a collider but is not in a kinematic body`);
        }
      }
    }

    // ---- joints (§6)
    const joints = new Map();
    for (const [i, j] of arr(m.joints).entries()) {
      if (!isObj(j)) continue;
      const here = at(`joints[${i}]`);
      if (joints.has(j.name)) F.error('vrmxi.joint', here, `the name "${j.name}" is used twice`);
      joints.set(j.name, j);
      const b = node(j.body, here, 'body');
      if (b !== null) {
        const mo = khr(b).motion;
        if (!isObj(mo) || mo.isKinematic === true) F.error('vrmxi.joint', here, `body "${j.body}" is not a node with a dynamic body (a motion without isKinematic)`);
      }
      if (typeof j.to === 'string') { const t = node(j.to, here, 'to'); if (t !== null && !isObj(khr(t).motion)) F.error('vrmxi.joint', here, `to "${j.to}" is not a node with a body`); }
      if ((j.type === 'hinge' || j.type === 'slider') && Array.isArray(j.axis) && j.axis.every((v) => v === 0)) F.error('vrmxi.joint', here, 'its axis is zero');
      const L = obj(j.limits);
      if (typeof L.min === 'number' && typeof L.max === 'number' && L.min > L.max) F.error('vrmxi.joint', here, 'its limits have min above max');
      if (isObj(j.motor) && typeof j.motor.target === 'number' && typeof L.min === 'number' && (j.motor.target < L.min || j.motor.target > L.max)) F.error('vrmxi.joint', here, 'its motor\'s target is outside its limits');
    }

    // ---- states (§7)
    const states = new Map();
    for (const [i, s] of arr(m.states).entries()) {
      if (!isObj(s)) continue;
      const here = at(`states[${i}]`);
      if (states.has(s.name)) F.error('vrmxi.state', here, `the name "${s.name}" is used twice`);
      states.set(s.name, s);
      if (hasModel) {
        for (const n of arr(s.show)) if (typeof n === 'string' && !meshNames.has(n)) F.error('vrmxi.state', here, `show names "${n}", which is no mesh node's name`);
        for (const k of Object.keys(obj(s.morphs))) if (!morphNames.has(k)) F.error('vrmxi.state', here, `morph "${k}" is not a morph target of the item`);
        for (const k of ['play', 'loop']) if (typeof s[k] === 'string' && !animNames.has(s[k])) F.error('vrmxi.state', here, `${k} names "${s[k]}", which is not an animation of the model`);
        for (const n of arr(s.sensors)) if (typeof n === 'string' && !sensorNames.has(n)) F.error('vrmxi.state', here, `sensors names "${n}", which is not a sensor (a trigger node)`);
      }
      for (const [k, v] of Object.entries(obj(s.joints))) {
        const j = joints.get(k);
        if (!j) { F.error('vrmxi.state', here, `joints names "${k}", which is not a joint of the item`); continue; }
        const L = obj(j.limits);
        if (typeof v === 'number' && typeof L.min === 'number' && (v < L.min || v > L.max)) F.error('vrmxi.state', here, `the target for "${k}" is outside its limits`);
      }
    }

    // ---- verbs (§8)
    const verbs = arr(m.verbs).filter(isObj);
    const offered = new Map();
    for (const [i, v] of arr(m.verbs).entries()) {
      if (!isObj(v)) continue;
      const here = at(`verbs[${i}]`);
      for (const s of arr(v.states)) if (!states.has(s)) F.error('vrmxi.verb', here, `is offered in "${s}", which is not a state of the item`);
      if (typeof v.to === 'string' && !states.has(v.to)) F.error('vrmxi.verb', here, `moves the item to "${v.to}", which is not a state of the item`);
      if (typeof v.reach === 'string' && hasModel && !sensorNames.has(v.reach)) F.error('vrmxi.verb', here, `reach names "${v.reach}", which is not a sensor (a trigger node)`);
      if (typeof v.at === 'string') node(v.at, here, 'at');
      for (const s of (v.states ? arr(v.states) : [...states.keys(), '*'])) {
        const key = `${v.verb}|${s}`;
        if (offered.has(key)) F.error('vrmxi.verb', here, `"${v.verb}" is offered twice in ${s === '*' ? 'the item' : `the state "${s}"`}`);
        offered.set(key, i);
      }
    }
    const verbSet = new Set(verbs.map((v) => v.verb));

    // ---- seat, spawn (§8.2, §8.3), and the type's needs (§2)
    for (const [i, p] of arr(m.seat?.points).entries()) { node(p?.node, at(`seat.points[${i}]`), 'node'); if (typeof p?.exit === 'string') node(p.exit, at(`seat.points[${i}]`), 'exit'); }
    if (isObj(m.spawn)) node(m.spawn.node, at('spawn'), 'node');
    const need = TYPE_NEEDS[m.type];
    if (need && !verbSet.has(need)) F.error('vrmxi.type', at('verbs'), `a ${m.type} offers "${need}"`);

    // ---- takeable and the wearable (§9)
    const wearableEntries = [...c.entries.keys()].filter((p) => p.endsWith('.vrmxw'));
    if (m.takeable === true && !verbSet.has('take')) F.error('vrmxi.takeable', at('verbs'), 'a takeable item offers take');
    if (m.takeable === true && isObj(m.wearable)) {
      const wr = m.wearable;
      for (const p of wearableEntries) if (p !== wr.file) F.error('vrmxi.wearable', join(where, p), 'is a second .vrmxw: an item embeds one wearable, named in wearable.file');
      const e = typeof wr.file === 'string' ? c.entries.get(wr.file) : null;
      if (!e) F.error('vrmxi.wearable', join(where, wr.file), 'the wearable entry is missing');
      else {
        const ww = join(where, wr.file);
        if (e.method !== 0) F.error('vrmxi.wearable', ww, 'is deflated; the wearable is stored (method 0), as a closet stores it');
        if (typeof wr.sha256 === 'string' && sha256(e.data) !== wr.sha256) F.error('vrmxi.wearable', ww, 'does not match wearable.sha256');
        F.list.push(...itemChecker.checkItem(e.data, { where: ww }));
        const d = readDirectory(e.data);
        const me = d.entries.find((x) => x.name === 'vrmxw.json');
        let im = null;
        if (me) { const r = readEntry(e.data, me); try { im = r.data ? JSON.parse(new TextDecoder().decode(r.data)) : null; } catch { im = null; } }
        if (isObj(im)) {
          if (typeof wr.id === 'string' && im.id !== wr.id) F.error('vrmxi.wearable', at('wearable.id'), `is ${wr.id} but the wearable's own id is ${im.id}`);
          if (typeof wr.state === 'string' && !arr(im.states).some((s) => s?.name === wr.state)) F.error('vrmxi.wearable', at('wearable.state'), `"${wr.state}" is not one of the wearable's states`);
          if (isObj(im.meta) && isObj(m.meta)) {
            const looser = Object.keys(ORDER).filter((k) => rank(m.meta, k) > rank(im.meta, k));
            if (looser.length) F.error('vrmxi.licence', at('meta'), `allows more than its wearable's terms in ${looser.join(', ')}: each permission is the stricter of the two`);
          }
        }
      }
    } else if (m.takeable !== true) {
      for (const p of wearableEntries) F.error('vrmxi.wearable', join(where, p), 'is a .vrmxw, but the item is not takeable: an item that can\'t be taken carries no VRMXW');
    }
    return F.list;
  }

  return { checkGameItem, schemaChecker: S, VERB_SLOT };
}
