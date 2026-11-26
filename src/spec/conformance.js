// The conformance kit's runner (PRD REF-2, CLOSET.md §4 "Compliance tests"). conformance/cases.json says, for each case,
// what goes in (fixtures), what an app does with it, what it writes into <output-dir>/<case id>/, and how its output is
// compared with the reference library's: conformance/expected/<case id>.json holds the reference's summary of the same
// output, and the runner summarises the app's output the same way and compares the two, with tolerances where
// geometry is involved. Node only; no reference library.
//
//   runConformance({ kit, outputDir, checker, only }) → { ok, cases: [{ id, status, checks }], text }   (only: case ids)
//   summariseOutputs({ kit, outputDir, checker }) → { id: summary }   (writes nothing: the reference's maker writes expected/)

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readDirectory, readEntry } from './zip.js';

const sha256 = (u8) => createHash('sha256').update(u8).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r7 = (v) => Math.round(v * 1e7) / 1e7;

// ---- reading files ----------------------------------------------------------------------------------------------
function unzip(u8) {
  const d = readDirectory(u8);
  const m = new Map();
  for (const e of d.entries) { const r = readEntry(u8, e); if (r.data) m.set(e.name, r.data); }
  return m;
}
const text = (u8) => new TextDecoder().decode(u8);
const jsonOf = (u8) => JSON.parse(text(u8));
function parseGlb(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let p = 12, json = null, bin = new Uint8Array(0);
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    const c = u8.subarray(p + 8, p + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(text(c)); else if (type === 0x004e4942) bin = c;
    p += 8 + len;
  }
  return { json, bin };
}
const COMP = { 5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2], 5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4] };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function accessor({ json, bin }, i) {
  const a = json.accessors[i], v = json.bufferViews[a.bufferView];
  const [get, size] = COMP[a.componentType];
  const n = NUM[a.type];
  const stride = v.byteStride || size * n;
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = new Float64Array(a.count * n);
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) out[k * n + c] = dv[get](start + k * stride + c * size, true);
  return out;
}
function mat(node) {
  if (node.matrix) return node.matrix.slice();
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
}
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function worlds(json) {
  const nodes = json.nodes || [];
  const par = new Map();
  nodes.forEach((n, i) => { for (const c of n.children || []) par.set(c, i); });
  const cache = new Map();
  const w = (i) => { if (cache.has(i)) return cache.get(i); const m = par.has(i) ? mul(w(par.get(i)), mat(nodes[i])) : mat(nodes[i]); cache.set(i, m); return m; };
  return (i) => w(i);
}
function vrmSummary(u8, { meshes = null, every = 40 } = {}) {
  const g = parseGlb(u8);
  const vrm = g.json.extensions?.VRMC_vrm;
  const W = worlds(g.json);
  const bones = {};
  for (const [b, v] of Object.entries(vrm?.humanoid?.humanBones || {})) { const m = W(v.node); bones[b] = [r6(m[12]), r6(m[13]), r6(m[14])]; }
  const ms = {};
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const [mi, mesh] of (g.json.meshes || []).entries()) {
    const done = new Set();
    const samples = [];
    let count = 0;
    for (const p of mesh.primitives || []) {
      const ai = p.attributes?.POSITION;
      if (ai == null || done.has(ai)) continue;
      done.add(ai);
      const pos = accessor(g, ai);
      count += pos.length / 3;
      for (let k = 0; k < pos.length / 3; k++) {
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pos[k * 3 + a]); max[a] = Math.max(max[a], pos[k * 3 + a]); }
        if (k % every === 0) samples.push([r6(pos[k * 3]), r6(pos[k * 3 + 1]), r6(pos[k * 3 + 2])]);
      }
    }
    const name = mesh.name ?? `mesh ${mi}`;
    if (!meshes || meshes.includes(name)) ms[name] = { count, samples };
  }
  const meta = vrm?.meta || null;
  if (meta) delete meta.thumbnailImage;
  return {
    vrm: vrm?.specVersion ?? null, meta, bones, meshes: ms, bbox: { min: min.map(r6), max: max.map(r6) },
    pieces: arr(g.json.extras?.vrmxaPieces).map((p) => ({ id: p.id, name: p.name, slot: p.slot, type: p.type ?? null, state: p.state ?? null, meta: p.meta })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    hairMaterials: arr(g.json.materials).filter((m) => m?.extras?.vrmxaHair).length,
    springs: arr(g.json.extensions?.VRMC_springBone?.springs).length,
  };
}
function bundleSummary(u8, checker) {
  const E = unzip(u8);
  const m = jsonOf(E.get('vrmxa.json'));
  const closetPath = m.sections?.closet?.file;
  const c = closetPath && E.get(closetPath) ? jsonOf(E.get(closetPath)) : null;
  const v = m.sections?.voice?.file && E.get(m.sections.voice.file) ? jsonOf(E.get(m.sections.voice.file)) : null;
  const nameOf = (id) => c?.items?.find((i) => i.id === id)?.name ?? id;
  const problems = checker ? checker.checkBundle(u8).filter((p) => p.severity === 'error').map((p) => `${p.code} ${p.where}`) : [];
  return {
    id: m.id, fileId: m.fileId, title: m.title,
    errors: problems,
    avatarOfClosetCurrent: c ? m.avatar?.of?.closet === sha256(E.get(closetPath)) : null,
    closet: c && {
      items: c.items.map((i) => i.name).sort(),
      worn: c.worn.items.map(nameOf).sort(),
      states: Object.fromEntries(Object.entries(c.worn.states || {}).map(([id, s]) => [nameOf(id), s]).sort()),
      hair: c.hair ? nameOf(c.hair) : null,
      outfits: arr(c.outfits).map((o) => ({ name: o.name, items: o.items.map(nameOf).sort(), states: Object.fromEntries(Object.entries(o.states || {}).map(([id, s]) => [nameOf(id), s]).sort()) })).sort((a, b) => a.name.localeCompare(b.name)),
    },
    voices: v ? v.voices.map((x) => x.name).sort() : [],
    avatar: m.avatar?.file && E.get(m.avatar.file) ? (() => { const s = vrmSummary(E.get(m.avatar.file), { meshes: [] }); return { meta: s.meta, pieces: s.pieces.map((p) => p.name).sort() }; })() : null,
    entries: [...E.keys()],
  };
}

// ---- summaries, by the case's `summary` -----------------------------------------------------------------------------
const SUMMARIES = {
  // the edited body written as a VRM: bones and vertices of Spec's own meshes (EDITS.md)
  body: (files, c) => vrmSummary(files['avatar.vrm'], { meshes: c.meshes }),
  measurements: (files) => {
    const m = jsonOf(files['measurements.json']);
    return { lengths: Object.fromEntries(Object.entries(m.lengths || {}).map(([k, v]) => [k, r6(v)])), joints: m.joints,
      stations: Object.fromEntries(arr(m.stations).map((s) => [s.id, { girth: r6(s.girth), width: r6(s.width), depth: r6(s.depth) }])) };
  },
  bundle: (files, c, ctx) => {
    const out = { result: bundleSummary(files[c.outputs[0]], ctx.checker) };
    for (const f of c.outputs.slice(1)) out[f] = f.endsWith('.json') ? jsonOf(files[f]) : f.endsWith('.vrm') ? (() => { const s = vrmSummary(files[f], { meshes: [] }); return { meta: s.meta, pieces: s.pieces.map((p) => p.name).sort() }; })() : null;
    return out;
  },
  avatar: (files) => vrmSummary(files['avatar.vrm'], { meshes: [] }),
  clip: (files) => {
    const g = parseGlb(files['clip.vrma']);
    const hips = g.json.extensions?.VRMC_vrm_animation?.humanoid?.humanBones?.hips?.node;
    const out = { hips: [] };
    for (const anim of g.json.animations || []) for (const ch of anim.channels || []) {
      if (ch.target?.node !== hips || ch.target?.path !== 'translation') continue;
      const s = anim.samplers[ch.sampler];
      const t = accessor(g, s.input), v = accessor(g, s.output);
      const end = t[t.length - 1];
      for (let f = 0; f <= Math.round(end * 30); f++) {
        const time = Math.min(end, f / 30);
        let k = 0;
        while (k < t.length - 2 && t[k + 1] < time) k++;
        const span = t[k + 1] - t[k] || 1;
        const u = Math.max(0, Math.min(1, (time - t[k]) / span));
        out.hips.push([0, 1, 2].map((a) => r6(v[k * 3 + a] * (1 - u) + v[(k + 1) * 3 + a] * u)));
      }
    }
    out.record = jsonOf(files['record.json']);
    return out;
  },
  memory: (files, c) => {
    const E = unzip(files['result.vrmxa']);
    const all = [...E.values()];
    const has = (s) => all.some((b) => text(b).includes(s));
    return { sentinels: c.sentinels.filter(has), kept: c.kept.filter(has) };
  },
  json: (files, c) => jsonOf(files[c.outputs[0]]),
  // each garment's fitted vertices: how many, and every `every`-th one (the kit compares those)
  fit: (files, c) => Object.fromEntries(c.bodies.map((b) => {
    const body = jsonOf(files[`${b.id}.json`]);
    const every = c.every || 5;
    return [b.id, Object.fromEntries(Object.entries(body).map(([item, pos]) => {
      const samples = [];
      for (let k = 0; k < pos.length / 3; k += every) samples.push(r7(pos[k * 3]), r7(pos[k * 3 + 1]), r7(pos[k * 3 + 2]));
      return [item, { count: pos.length / 3, samples }];
    }))];
  })),
};

/** The summaries the runner knows. */
export const SUMMARY_KINDS = Object.freeze(Object.keys(SUMMARIES));

/** Summarise one case's output folder. → summary (or throws with what is missing). */
export function summariseCase(c, dir, ctx = {}) {
  const files = {};
  for (const f of c.outputs || c.bodies?.map((b) => `${b.id}.json`) || []) {
    const p = join(dir, f);
    if (!existsSync(p)) throw Object.assign(new Error(`${f} is missing`), { missing: true });
    files[f] = new Uint8Array(readFileSync(p));
  }
  return SUMMARIES[c.summary](files, c, ctx);
}

// ---- comparing ---------------------------------------------------------------------------------------------------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function compareCase(c, got, want, ctx) {
  const checks = [];
  const C = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
  const tol = c.tolerances || {};
  const bonesWithin = (gb, wb, t, label = 'humanoid bones') => {
    let worst = 0, at = null;
    for (const [b, p] of Object.entries(wb || {})) { if (!gb?.[b]) { worst = Infinity; at = `${b} missing`; break; } const d = dist(gb[b], p); if (d > worst) { worst = d; at = b; } }
    C(`${label} within ${t * 1000} mm`, worst <= t, `worst ${at ?? '—'}: ${Number.isFinite(worst) ? `${(worst * 1000).toFixed(3)} mm` : 'missing'}`);
  };
  switch (c.summary) {
    case 'body': {
      C('a VRM 1.0', got.vrm === '1.0', `specVersion ${got.vrm}`);
      bonesWithin(got.bones, want.bones, tol.bones);
      for (const [name, w] of Object.entries(want.meshes)) {
        const g = got.meshes[name];
        if (!g) { C(`mesh "${name}"`, false, 'missing'); continue; }
        if (g.count !== w.count) { C(`mesh "${name}" vertices`, false, `${g.count} vertices, the reference has ${w.count}`); continue; }
        let worst = 0;
        w.samples.forEach((p, k) => { worst = Math.max(worst, dist(p, g.samples[k] || [Infinity, 0, 0])); });
        C(`mesh "${name}" within ${tol.vertices * 1000} mm`, worst <= tol.vertices, `worst ${(worst * 1000).toFixed(3)} mm over ${w.samples.length} sampled vertices`);
      }
      break;
    }
    case 'measurements': {
      let worst = 0, at = null;
      for (const [k, v] of Object.entries(want.lengths)) { const d = Math.abs((got.lengths[k] ?? Infinity) - v); if (d > worst) { worst = d; at = k; } }
      C(`lengths within ${tol.lengths * 1000} mm`, worst <= tol.lengths, `worst ${at ?? '—'}: ${(worst * 1000).toFixed(3)} mm`);
      worst = 0; at = null;
      for (const [id, s] of Object.entries(want.stations)) for (const k of ['girth', 'width', 'depth']) { const d = Math.abs((got.stations[id]?.[k] ?? Infinity) - s[k]); if (d > worst) { worst = d; at = `${id}.${k}`; } }
      C(`station girths, widths and depths within ${tol.girths * 1000} mm`, worst <= tol.girths, `worst ${at ?? '—'}: ${(worst * 1000).toFixed(3)} mm`);
      bonesWithin(got.joints, want.joints, tol.joints, 'joints');
      break;
    }
    case 'bundle': {
      const g = got.result, w = want.result;
      C('the bundle passes the specification\'s checks', !g.errors.length, g.errors.slice(0, 3).join('; '));
      if (c.sameId) C('the same id (the same character)', g.id === w.id, g.id);
      if (c.newFileId) C('a new fileId (another file)', g.fileId !== ctx.inputFileId, g.fileId);
      if (w.closet) {
        C('what is worn', same(g.closet?.worn, w.closet.worn), JSON.stringify(g.closet?.worn));
        C('the states of worn items', same(g.closet?.states, w.closet.states), JSON.stringify(g.closet?.states));
        C('the hair', same(g.closet?.hair, w.closet.hair), JSON.stringify(g.closet?.hair));
        C('the closet\'s items', same(g.closet?.items, w.closet.items), JSON.stringify(g.closet?.items));
        C('the outfits', same(g.closet?.outfits, w.closet.outfits), JSON.stringify(g.closet?.outfits));
        C('avatar.of names closet.json (avatar.vrm redrawn: CLOSET.md C6)', g.avatarOfClosetCurrent === true, String(g.avatarOfClosetCurrent));
      }
      if (c.compareVoices) C('the voices', same(g.voices, w.voices), JSON.stringify(g.voices));
      if (c.compareAvatarMeta) {
        const keys = c.compareAvatarMeta;
        const pick = (m) => Object.fromEntries(keys.map((k) => [k, m?.[k] ?? null]));
        C(`avatar.vrm's permissions (${keys.join(', ')})`, same(pick(g.avatar?.meta), pick(w.avatar?.meta)), JSON.stringify(pick(g.avatar?.meta)));
        C('the pieces in avatar.vrm', same(g.avatar?.pieces, w.avatar?.pieces), JSON.stringify(g.avatar?.pieces));
      }
      for (const f of c.outputs.slice(1)) {
        if (f.endsWith('.vrm')) C(`${f}: the pieces it carries`, same(got[f]?.pieces, want[f]?.pieces), JSON.stringify(got[f]?.pieces));
        else C(f, same(got[f], want[f]), JSON.stringify(got[f]));
      }
      break;
    }
    case 'avatar': {
      C('a VRM 1.0', got.vrm === '1.0', `specVersion ${got.vrm}`);
      C('the character\'s own meta: details and permissions (VRMXA §5.3)', same(got.meta, want.meta), JSON.stringify(got.meta)?.slice(0, 200));
      C('every merged piece with its licence, never weakened (extras.vrmxaPieces)', same(got.pieces, want.pieces), got.pieces.map((p) => `${p.name}${p.state ? ` [${p.state}]` : ''}`).join(', '));
      bonesWithin(got.bones, want.bones, tol.bones);
      const bb = Math.max(...[0, 1, 2].flatMap((a) => [Math.abs(got.bbox.min[a] - want.bbox.min[a]), Math.abs(got.bbox.max[a] - want.bbox.max[a])]));
      C(`the figure's extent within ${tol.bbox * 1000} mm`, bb <= tol.bbox, `${(bb * 1000).toFixed(3)} mm`);
      C('the hair\'s materials marked (extras.vrmxaHair)', got.hairMaterials > 0 === want.hairMaterials > 0, `${got.hairMaterials}`);
      C('the worn pieces\' springs carried', got.springs >= want.springs, `${got.springs} springs, the reference ${want.springs}`);
      break;
    }
    case 'clip': {
      const n = Math.min(got.hips.length, want.hips.length);
      let worst = got.hips.length && want.hips.length ? 0 : Infinity;
      for (let k = 0; k < n; k++) worst = Math.max(worst, dist(got.hips[k], want.hips[k]));
      C(`the hips track within ${tol.hips * 1000} mm at 30 fps`, worst <= tol.hips && Math.abs(got.hips.length - want.hips.length) <= 1, `worst ${(worst * 1000).toFixed(3)} mm over ${n} frames`);
      const gr = got.record?.groundedFor, wr = want.record?.groundedFor;
      C('groundedFor names the figure (base, lift, edits)', gr && gr.base === wr.base && Math.abs(gr.lift - wr.lift) <= 1e-4 && (gr.edits ?? null) === (wr.edits ?? null), JSON.stringify(gr));
      C('derivedFrom names the original clip', got.record?.derivedFrom === want.record?.derivedFrom, String(got.record?.derivedFrom));
      break;
    }
    case 'memory':
      C('nothing a character remembers is anywhere in the bundle (VRMXA §11)', got.sentinels.length === 0, got.sentinels.length ? `found: ${got.sentinels.join(', ')}` : 'none of the planted strings found');
      C('the core persona is kept', same(got.kept, want.kept), `kept: ${got.kept.join(', ')}`);
      break;
    case 'json':
      C(c.outputs[0], same(got, want), JSON.stringify(got).slice(0, 300));
      break;
    case 'fit': {
      for (const b of c.bodies) {
        const g = got[b.id], w = want[b.id];
        for (const [item, wi] of Object.entries(w)) {
          const gi = g?.[item];
          if (!gi || gi.count !== wi.count) { C(`${b.id}: ${item}`, false, gi ? `${gi.count} vertices, the reference has ${wi.count}` : 'missing'); continue; }
          const gp = gi.samples, wp = wi.samples;
          let worst = 0, sum = 0;
          for (let k = 0; k < wp.length; k += 3) { const d = Math.hypot(gp[k] - wp[k], gp[k + 1] - wp[k + 1], gp[k + 2] - wp[k + 2]); worst = Math.max(worst, d); sum += d * d; }
          const rms = Math.sqrt(sum / (wp.length / 3));
          const t = b.id === 'spec' ? tol.onSpec : tol.max;
          C(`${b.id}: ${ctx.itemNames?.[item] || item} within ${t * 1000} mm${b.id === 'spec' ? ' (no change on Spec, FITTING §8)' : `, RMS ${tol.rms * 1000} mm`}`, worst <= t && (b.id === 'spec' || rms <= tol.rms), `worst ${(worst * 1000).toFixed(4)} mm, RMS ${(rms * 1000).toFixed(4)} mm`);
        }
      }
      break;
    }
    default: C('a known summary', false, c.summary);
  }
  return checks;
}

/** The kit's cases (conformance/cases.json). */
export function loadKit(kit) {
  const cases = JSON.parse(readFileSync(join(kit, 'cases.json'), 'utf8'));
  return cases;
}

/** Summaries of an output folder, one per case found in it. → { id: summary | { error } } */
export function summariseOutputs({ kit, outputDir, checker }) {
  const K = loadKit(kit);
  const out = {};
  for (const c of K.cases) {
    try { out[c.id] = summariseCase(c, join(outputDir, c.id), { checker }); } catch (e) { out[c.id] = { error: e.message }; }
  }
  return out;
}

/** Run the kit over an app's output folder. */
export async function runConformance({ kit, outputDir, checker, only = null }) {
  const K = loadKit(kit);
  if (only) {
    const unknown = only.filter((id) => !K.cases.some((c) => c.id === id));
    if (unknown.length) throw new Error(`no case ${unknown.join(', ')} in the kit; its cases are ${K.cases.map((c) => c.id).join(', ')}`);
    K.cases = K.cases.filter((c) => only.includes(c.id));
  }
  const repo = resolve(kit, '..');
  const results = [];
  for (const c of K.cases) {
    const dir = join(outputDir, c.id);
    const wantPath = join(kit, 'expected', `${c.id}.json`);
    if (!existsSync(dir)) { results.push({ id: c.id, title: c.title, status: 'not run', checks: [] }); continue; }
    let got;
    try { got = summariseCase(c, dir, { checker }); } catch (e) { results.push({ id: c.id, title: c.title, status: e.missing ? 'incomplete' : 'error', error: e.message, checks: [] }); continue; }
    const want = JSON.parse(readFileSync(wantPath, 'utf8'));
    const ctx = { inputFileId: c.inputFileId, itemNames: c.itemNames };
    if (c.newFileId && c.inputs?.character) {
      const [f] = c.inputs.character.split('#');
      ctx.inputFileId = jsonOf(unzip(new Uint8Array(readFileSync(join(repo, f)))).get('vrmxa.json')).fileId;
    }
    const checks = compareCase(c, got, want, ctx);
    results.push({ id: c.id, title: c.title, sections: c.sections, status: checks.every((x) => x.ok) ? 'passes' : 'fails', checks });
  }
  const run = results.filter((r) => r.status !== 'not run');
  const ok = run.length > 0 && run.every((r) => r.status === 'passes');
  const lines = results.map((r) => {
    const head = `${r.status === 'passes' ? 'PASS' : r.status === 'not run' ? 'skip' : 'FAIL'}  ${r.id}: ${r.title}${r.sections ? ` (${r.sections})` : ''}`;
    if (r.status === 'not run') return `${head}\n        not run: no folder ${r.id}/ in the output`;
    if (r.error) return `${head}\n        ${r.status}: ${r.error}`;
    return [head, ...r.checks.map((x) => `        ${x.ok ? 'ok  ' : 'FAIL'} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`)].join('\n');
  });
  const passed = results.filter((r) => r.status === 'passes').length;
  return { ok, cases: results, text: `${lines.join('\n')}\n${passed} of ${results.length} cases pass${results.length - run.length ? ` (${results.length - run.length} not run)` : ''}` };
}
