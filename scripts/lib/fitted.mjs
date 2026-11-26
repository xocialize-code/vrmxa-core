// Two garments made from Spec's own skin, for trying Spec-fit (PRD phase 5) in the app and the hand test
// (written by scripts/make-fixtures.mjs):
//   fixtures/items/fitted-top.vrmxw       Spec's torso and upper arms, 4 mm out: a fitted top with short sleeves
//   fixtures/items/fitted-trousers.vrmxw  Spec's hips and legs to the ankle, 5 mm out: fitted trousers
// Each vertex is a body-skin vertex pushed out along its normal, skinned as the skin is, with the bust bones
// folded into their humanoid ancestor as an item's writer folds them (VRMXW §5.3 rule 3, W21), so fitted by
// its bones the top doesn't follow Bust Size and Spec-fit has something to fix. Made from spec.vrm only.
// Deterministic: the same spec.vrm gives the same bytes.

import { createHash } from 'node:crypto';
import { parseGlb, readAccessor } from '../../src/glb.js';
import { parents } from '../../src/math.js';
import { extractItemModel } from '../../src/item-writer.js';
import { createItem, writeItem } from '../../src/vrmxw.js';
import { readSkin } from '../../src/fit/body.js';
import { vertexNormals } from '../../src/fit/geom.js';
import { humanBones } from '../../src/measure/bodyMeasure.js';

const T = '2026-11-17T00:00:00Z';
const GEN = 'vrmxa-core scripts/make-fixtures.mjs';
const uuid = (s) => { const h = createHash('sha256').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const meta = { version: '1.0', authors: ['Xocialize LLC'], copyrightInformation: '© 2026 Xocialize LLC', licenseUrl: 'https://vrm.dev/licenses/1.0/',
  commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' };

// garments cut from Spec's own skin: → { spec, garment(json, bin, { name, labels, y, x, offset, color, shape }) }
function garmentMaker(specBytes) {
  const spec = parseGlb(specBytes);
  const body = readSkin(spec.json, spec.bin);
  const flat = Int32Array.from(body.tris.flat());
  const N = vertexNormals(body.verts, flat);
  const hb = humanBones(spec.json);
  const human = new Set(Object.values(hb));
  const par = parents(spec.json.nodes);
  const humanNode = (n) => { for (let k = n; k != null; k = par.get(k)) if (human.has(k)) return k; return n; };

  function garment(json, bin, { name, labels, y, x = null, offset, color, shape = null }) {
    const keep = body.tris.filter((t) => t.every((i) => labels.includes(body.label[i]) && body.verts[i * 3 + 1] >= y[0] && body.verts[i * 3 + 1] <= y[1] && (!x || (body.verts[i * 3] >= x[0] && body.verts[i * 3] <= x[1]))));
    const map = new Map(), src = [];
    for (const t of keep) for (const i of t) if (!map.has(i)) { map.set(i, src.length); src.push(i); }
    const n = src.length;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), joints = new Uint16Array(n * 4), weights = new Float32Array(n * 4);
    // one skin of the humanoid joints the garment uses, with Spec's inverse bind matrices
    const bodySkin = spec.json.skins[spec.json.nodes.find((nd) => nd.name === 'Body').skin];
    const ibm = readAccessor(spec.json, spec.bin, bodySkin.inverseBindMatrices);
    const used = [];
    const slot = new Map();
    const jointOf = (node) => { if (!slot.has(node)) { slot.set(node, used.length); used.push(node); } return slot.get(node); };
    src.forEach((i, k) => {
      for (let a = 0; a < 3; a++) { pos[k * 3 + a] = body.verts[i * 3 + a] + N[i * 3 + a] * offset; nrm[k * 3 + a] = N[i * 3 + a]; }
      uv[k * 2] = (Math.atan2(body.verts[i * 3], body.verts[i * 3 + 2]) / Math.PI + 1) / 2; uv[k * 2 + 1] = 1 - body.verts[i * 3 + 1] / 1.6;
      const acc = new Map();
      for (let j = 0; j < 4; j++) { const w = body.skin.weight[i * 4 + j]; if (w > 1e-6) { const hn = humanNode(body.skin.node[i * 4 + j]); acc.set(hn, (acc.get(hn) || 0) + w); } }
      [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4).forEach(([node, w], j) => { joints[k * 4 + j] = jointOf(node); weights[k * 4 + j] = w; });
    });
    if (shape) shape(pos, n);
    const ibms = new Float32Array(used.length * 16);
    used.forEach((node, k) => { const s = bodySkin.joints.indexOf(node); ibms.set(ibm.subarray(s * 16, s * 16 + 16), k * 16); });
    const idx = Uint32Array.from(keep.flatMap((t) => t.map((i) => map.get(i))));
    // append the buffers
    const parts = [];
    let len = bin.length;
    const view = (typed, target) => {
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      const pad = (4 - (len % 4)) % 4;
      if (pad) { parts.push(new Uint8Array(pad)); len += pad; }
      json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: bytes.length, ...(target ? { target } : {}) });
      parts.push(bytes); len += bytes.length;
      return json.bufferViews.length - 1;
    };
    const accessor = (typed, componentType, type, count, extra = {}) => { json.accessors.push({ bufferView: view(typed, extra.target), componentType, count, type, ...(extra.min ? { min: extra.min, max: extra.max } : {}) }); return json.accessors.length - 1; };
    const min = [0, 1, 2].map((a) => Math.min(...Array.from({ length: n }, (_, k) => pos[k * 3 + a])));
    const max = [0, 1, 2].map((a) => Math.max(...Array.from({ length: n }, (_, k) => pos[k * 3 + a])));
    const attributes = {
      POSITION: accessor(pos, 5126, 'VEC3', n, { target: 34962, min, max }),
      NORMAL: accessor(nrm, 5126, 'VEC3', n, { target: 34962 }),
      TEXCOORD_0: accessor(uv, 5126, 'VEC2', n, { target: 34962 }),
      JOINTS_0: accessor(joints, 5123, 'VEC4', n, { target: 34962 }),
      WEIGHTS_0: accessor(weights, 5126, 'VEC4', n, { target: 34962 }),
    };
    const indices = accessor(idx, 5125, 'SCALAR', idx.length, { target: 34963 });
    json.materials.push({ name: `${name}_00_CLOTH`, doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 1 },
      extensions: { VRMC_materials_mtoon: { specVersion: '1.0', shadeColorFactor: color.map((c) => c * 0.65), shadingToonyFactor: 0.9, shadingShiftFactor: 0 } } });
    json.meshes.push({ name, primitives: [{ attributes, indices, material: json.materials.length - 1 }] });
    json.skins.push({ name, joints: used, inverseBindMatrices: accessor(ibms, 5126, 'MAT4', used.length) });
    json.nodes.push({ name, mesh: json.meshes.length - 1, skin: json.skins.length - 1 });
    json.scenes[json.scene || 0].nodes.push(json.nodes.length - 1);
    const out = new Uint8Array(len);
    out.set(bin, 0);
    let o = bin.length;
    for (const p of parts) { out.set(p, o); o += p.length; }
    json.buffers[0].byteLength = out.length;
    return { bin: out, mesh: json.meshes.length - 1, vertices: n };
  }
  return { spec, garment };
}

/** The fitted top and trousers made from spec.vrm's bytes. → [{ file: 'items/fitted-top.vrmxw', bytes, vertices }] */
export async function fittedSamples(specBytes) {
  const { spec, garment } = garmentMaker(specBytes);
  const json = JSON.parse(JSON.stringify(spec.json));
  let bin = spec.bin.slice();
  const t = garment(json, bin, { name: 'FittedTop', labels: ['torso', 'armL', 'armR'], y: [0.9, 1.285], x: [-0.3, 0.3], offset: 0.004, color: [0.35, 0.55, 0.78] });
  bin = t.bin;
  const p = garment(json, bin, { name: 'FittedTrousers', labels: ['torso', 'legL', 'legR'], y: [0.16, 1.0], offset: 0.005, color: [0.28, 0.3, 0.36] });
  bin = p.bin;
  const dressed = { json, bin };
  const results = [];
  for (const [file, part, name, type, cls] of [['fitted-top', t, 'Fitted top', 'top'], ['fitted-trousers', p, 'Fitted trousers', 'pants']]) {
    const cut = extractItemModel(dressed, { prims: [[part.mesh, 0]], kind: 'worn', name: name.replace(/\s/g, '_'), generator: GEN });
    const item = await createItem({ id: uuid(`fitted ${file}`), created: T, generator: GEN, name, type, model: cut.glb, rig: cut.rig, meta: { ...meta },
      origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, tags: [`${type === 'top' ? 'top' : 'bottoms'}:fitted`] });
    results.push({ file: `items/${file}.vrmxw`, bytes: await writeItem(item), vertices: part.vertices });
    void cls;
  }
  return results;
}

/**
 * Shoes made from Spec's own feet (for the specification's fixtures): the skin below the ankle 4 mm out, the sole
 * thickened downward by `lift`, so the item sits at Spec's height and raises its wearer by `lift` (VRMXW §7.1).
 * → the item's bytes. opts: { id, name, lift, created, generator, meta }
 */
export async function shoeSample(specBytes, { id, name = 'Shoes', lift = 0.02, created = T, generator = GEN, meta: m = meta } = {}) {
  const { spec, garment } = garmentMaker(specBytes);
  const json = JSON.parse(JSON.stringify(spec.json));
  const sole = (pos, n) => { for (let k = 0; k < n; k++) if (pos[k * 3 + 1] < 0.015) pos[k * 3 + 1] -= lift; };
  const g = garment(json, spec.bin.slice(), { name: 'Shoes', labels: ['legL', 'legR'], y: [-1, 0.1], offset: 0.004, color: [0.42, 0.26, 0.16], shape: sole });
  const cut = extractItemModel({ json, bin: g.bin }, { prims: [[g.mesh, 0]], kind: 'worn', name: 'Shoes', generator });
  const item = await createItem({ id, created, generator, name, type: 'shoes', model: cut.glb, rig: cut.rig, meta: { ...m },
    fit: { method: 'bones', lift }, origin: { made: 'generated', source: 'Spec\'s own feet, 4 mm out, the sole thickened' }, tags: ['footwear:shoes'] });
  return writeItem(item);
}
