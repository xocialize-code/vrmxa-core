#!/usr/bin/env node
// The specification's test files (PRD REF-3, OPEN-ISSUES P1), written into VRMXA_Specification/fixtures/:
//
//   characters/minimal.vrmxa, characters/full.vrmxa     the least a bundle holds; every section, built through the
//                                                       library's own operations (the same calls the app's buttons make)
//   items/*.vrmxw                                       one item of each kind
//   invalid/*                                           one file per check that must fail, each naming its rule
//   expected.json                                       what each file is, the section it covers, what a checker reports
//
// Made from spec.vrm and the project's own generated art only: no dataset art, no one's avatar, no real person's
// voice (the voice clips are synthetic hums made here). Repeatable: fixed ids and times, zeroed ZIP timestamps
// (VRMXA §3.2), so running it twice gives the same bytes; the library's test/spec-fixtures.test.mjs regenerates
// them and compares them with the specification's copies byte for byte.
//
//   node scripts/make-spec-fixtures.mjs [--out <folder>] [--quiet]
//
// The specification depends on nothing here to be checked: its own tools/check validates these files with the
// schemas alone. This script needs the reference library to write them, which is why it lives with the library.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---- repeatable ids and times: the library's operations draw UUIDs and "now"; here they are fixed
const T = '2026-11-18T00:00:00.000Z';
const FIXED = Date.parse(T);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED])); }
  static now() { return FIXED; }
};
const uuid = (label) => {
  const h = createHash('sha256').update(`vrmxa spec fixture: ${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
let drawn = 0;
globalThis.crypto.randomUUID = () => uuid(`drawn ${drawn++}`);

const { jsonBytes } = await import('../src/bytes.js');
const { buildGlb, parseGlb } = await import('../src/glb.js');
const { sha256 } = await import('../src/hash.js');
const { extractItemModel } = await import('../src/item-writer.js');
const { findBase, BASES } = await import('../src/vocab.js');
const { createBundle, setDocument, setEntry, writeBundle, setAvatar } = await import('../src/vrmxa.js');
const { createItem, writeItem, readItem } = await import('../src/vrmxw.js');
const { scanZip } = await import('../src/zip.js');
const { findSpecDir, findSpecRepo } = await import('../src/node/spec.js');
const closet = await import('../src/closet/index.js');
const motion = await import('../src/anim/index.js');
const { hairDesignToItem, measureEdits } = await import('../src/edit/index.js');
const voices = await import('../src/voice/index.js');
const { setPersona } = await import('../src/persona/index.js');
const { setDetails, setListing, setSetting } = await import('../src/character/index.js');
const { checkBundle, checkItem } = await import('../src/checker.js');
const { dressSpec, renameVrm } = await import('./lib/dress.mjs');
const { fittedSamples, shoeSample } = await import('./lib/fitted.mjs');
const { miniVrm } = await import('./lib/minivrm.mjs');
const { png } = await import('./lib/png.mjs');
const { rawZip } = await import('./lib/rawzip.mjs');
const { vrma } = await import('./lib/vrma.mjs');
const { splitMesh } = await import('../src/item/edit.js');

const argOut = process.argv.indexOf('--out');
const SPEC_DIR = findSpecDir();
const REPO = findSpecRepo();
if (!SPEC_DIR) { console.error('spec.vrm not found: set VRMXA_SPEC_DIR or put the specification beside this repository'); process.exit(2); }
const OUT = argOut > 0 ? process.argv[argOut + 1] : join(REPO, 'fixtures');
const quiet = process.argv.includes('--quiet');
const GEN = 'VRMXA reference library (vrmxa-core scripts/make-spec-fixtures.mjs)';
const sizes = {};
const write = (rel, bytes) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  sizes[rel] = bytes.length;
  if (!quiet) console.log(`${String(bytes.length).padStart(9)}  fixtures/${rel}`);
};
for (const d of ['characters', 'items', 'invalid']) rmSync(join(OUT, d), { recursive: true, force: true });

const specBytes = new Uint8Array(readFileSync(join(SPEC_DIR, 'spec.vrm')));
const specMeasurements = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
const specSha = await sha256(specBytes);
const base = findBase(specSha);
if (!base || base.status !== 'standard') throw new Error(`spec.vrm (${specSha.slice(0, 12)}…) is not the standard Spec in bases.json`);
const retired = BASES.find((b) => b.status === 'retired' && b.species === 'human');
const spec = parseGlb(specBytes);
const specJson = JSON.parse(JSON.stringify(spec.json));
const xoc = { version: '1.0', authors: ['Xocialize LLC'], copyrightInformation: '© 2026 Xocialize LLC', licenseUrl: 'https://vrm.dev/licenses/1.0/',
  commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' };
const ORIGIN = { made: 'generated', source: 'scripts/make-spec-fixtures.mjs, from spec.vrm' };
const thumb = (r, g, b) => png(64, 64, (x, y) => [r, g, b, Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0]);
const p12 = async (b) => (await sha256(b)).slice(0, 12);
const hum = (seconds, rate = 24000, pitch = 180) => {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.05, (seconds - t) / 0.05);
    s[i] = env * (0.3 * Math.sin(2 * Math.PI * pitch * t) + 0.1 * Math.sin(2 * Math.PI * 2 * pitch * t)) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * t));
  }
  return voices.encodeWav16(s, rate);
};

// ================================================================ items: one of each kind
const dressed = dressSpec(specJson, spec.bin, specMeasurements);
const cut = (part, o) => extractItemModel(dressed, { prims: dressed.parts[part], generator: GEN, ...o });
const top = cut('top', { kind: 'worn', name: 'Top' });
const hat = cut('hat', { kind: 'pin', attach: 'head', name: 'Hat' });
const sword = cut('sword', { kind: 'pin', attach: 'rightHand', bones: ['upperChest'], name: 'Sword' });
const staff = cut('staff', { kind: 'pin', attach: 'leftHand', name: 'Staff' });

const items = {};
items.worn = await createItem({
  id: uuid('item worn top'), created: T, generator: GEN, name: 'Ribbon top', type: 'top', model: top.glb, rig: top.rig, meta: { ...xoc },
  listing: { url: 'https://example.com/items/ribbon-top', marketplace: 'Example Market', id: 'FX-0001' }, origin: { ...ORIGIN }, thumbnail: thumb(80, 120, 190), tags: ['top:shell'],
});
items.pinned = await createItem({ id: uuid('item pinned hat'), created: T, generator: GEN, name: 'Hat', type: 'hat', model: hat.glb, rig: hat.rig, meta: { ...xoc, version: '2.0' }, origin: { ...ORIGIN }, tags: ['headwear:hat'] });
items.states = await createItem({
  id: uuid('item sword'), created: T, generator: GEN, name: 'Short sword', type: 'handR', model: sword.glb, rig: sword.rig, meta: { ...xoc }, origin: { ...ORIGIN }, tags: ['weapon:sword'],
  states: [
    { name: 'held', bone: 'rightHand', tags: ['held:sword'] },
    { name: 'stowed', bone: 'upperChest', tags: ['stowed:sword'], matrix: [0.7071068, 0.7071068, 0, 0, -0.7071068, 0.7071068, 0, 0, 0, 0, 1, 0, 0.12, 0.05, -0.16, 1] },
  ],
});
const staffClip = vrma('Staff twirl', { leftUpperArm: [[0, [0, 0, 1], 0], [0.6, [0, 0, 1], 35], [1.2, [0, 0, 1], 0]], spine: [[0, [0, 1, 0], 0], [0.6, [0, 1, 0], 10], [1.2, [0, 1, 0], 0]] });
items.animated = await createItem({
  id: uuid('item staff'), created: T, generator: GEN, name: 'Staff', type: 'handL', model: staff.glb, rig: staff.rig, meta: { ...xoc }, origin: { ...ORIGIN }, tags: ['weapon:staff', 'held:staff'],
  animations: {
    clips: [{ bytes: staffClip, name: 'Staff twirl', duration: 1.2, loops: true, rootMotion: 'inPlace', speed: null, tracks: ['humanoid'], source: 'made by scripts/make-spec-fixtures.mjs', licence: 'CC0-1.0' }],
    sets: [{ name: 'Staff', priority: 10, requires: ['held:staff'], slots: { idle: [{ clip: 0 }], use: [{ clip: 0, rate: 1.5 }] } }],
  },
  extensions: { 'x-xocialize.fixture-note': { data: { version: 1, note: 'an extension the item carries; readers that do not know it keep it' }, files: { 'note.txt': new TextEncoder().encode('kept byte for byte\n') } } },
});
const split = splitMesh(await createItem({ id: uuid('item parts'), created: T, generator: GEN, name: 'Top with a ribbon', type: 'top', model: top.glb, rig: top.rig, meta: { ...xoc }, origin: { ...ORIGIN }, tags: ['top:shell'] }),
  top.meshes[0].node, [1], { name: 'Ribbon' });
items.shown = split.item;
const bodyName = parseGlb(items.shown.entries.get('model.glb')).json.nodes[top.meshes[0].node].name;
items.shown.manifest.states = [{ name: 'tied', tags: ['ribbon:tied'], show: [bodyName, 'Ribbon'] }, { name: 'no ribbon', tags: ['ribbon:off'], show: [bodyName] }];
const fringe = () => {
  const strands = [];
  for (let i = -5; i <= 5; i++) { const x = i * 0.012; strands.push({ points: [[x, 0.16, 0.06], [x * 1.1, 0.14, 0.1], [x * 1.2, 0.1, 0.115], [x * 1.25, 0.06, 0.12]] }); }
  const back = [];
  for (let i = -6; i <= 6; i++) { const a = (i / 6) * 1.2; const x = Math.sin(a) * 0.09, z = -Math.cos(a) * 0.09; back.push({ points: [[x * 0.5, 0.17, z * 0.5], [x, 0.12, z], [x * 1.05, 0.0, z * 1.05], [x * 1.05, -0.08, z * 1.08]] }); }
  return { groups: [
    { id: 'g1', name: 'Fringe', cross: 'Flat', color: [0.36, 0.22, 0.16], params: { width: 0.02 }, strands },
    { id: 'g2', name: 'Back', cross: 'Diamond', color: [0.36, 0.22, 0.16], params: { width: 0.026, bounce: 0.4 }, strands: back },
  ] };
};
items.hair = await hairDesignToItem(specBytes, fringe(), { id: uuid('item hair'), created: T, generator: GEN, name: 'Short hair', meta: { ...xoc }, origin: { made: 'authored', source: 'drawn hair (EDITS.md §6), scripts/make-spec-fixtures.mjs' } });
const itemBytes = {};
for (const [k, file] of [['worn', 'worn-skinned'], ['pinned', 'pinned'], ['states', 'states-pinned'], ['shown', 'states-shown'], ['animated', 'animated'], ['hair', 'hair']]) {
  itemBytes[k] = await writeItem(items[k]);
  write(`items/${file}.vrmxw`, itemBytes[k]);
}
itemBytes.shoes = await shoeSample(specBytes, { id: uuid('item shoes'), name: 'Boots', lift: 0.02, created: T, generator: GEN, meta: { ...xoc } });
write('items/shoes-lift.vrmxw', itemBytes.shoes);
{
  const r = await readItem(itemBytes.pinned);
  r.manifest.id = uuid('item restricted hat');
  r.manifest.name = 'Borrowed hat';
  r.manifest.meta = { authors: ['Another Maker'], licenseUrl: 'https://example.com/licence/borrowed-hat', commercialUsage: 'personalNonProfit', creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' };
  r.manifest.listing = { url: 'https://example.com/items/borrowed-hat', marketplace: 'Example Market', id: 'FX-0099' };
  itemBytes.restricted = await writeItem(r);
  write('items/restricted.vrmxw', itemBytes.restricted);
}
for (const f of await fittedSamples(specBytes)) {
  const r = await readItem(f.bytes);
  r.manifest.id = uuid(`item ${f.file}`);
  r.manifest.generator = GEN;
  const name = f.file.includes('top') ? 'specfit-top' : 'specfit-trousers';
  itemBytes[name] = await writeItem(r);
  write(`items/${name}.vrmxw`, itemBytes[name]);
}

// ================================================================ the minimal character
const vrmNamed = (name) => buildGlb(renameVrm(spec.json, name, ['Xocialize LLC']), spec.bin);
{
  const minimal = createBundle({ avatar: vrmNamed('Minimal'), base, thumbnail: thumb(200, 180, 160), id: uuid('minimal id'), fileId: uuid('minimal fileId'), created: T, generator: GEN });
  minimal.manifest.avatar.header.id = uuid('minimal avatar header');
  write('characters/minimal.vrmxa', await writeBundle(minimal));
}

// ================================================================ the full character: every section
const full = createBundle({ avatar: vrmNamed('Mira'), base, thumbnail: thumb(230, 150, 170), id: uuid('full id'), fileId: uuid('full fileId'), created: T, generator: GEN });
full.manifest.avatar.header.id = uuid('full avatar header');
const opts = { spec: specBytes };
// appearance: the edit document (face, body, a drawn strand), then eyes and mouth
const editsDoc = {
  format: 'vrmxa-edits', version: 7, editor: GEN, madeOn: { sha256: specSha },
  face: { morphs: { EYE_Surprised: 0.2 }, colors: { irisL: [0.11, 0.24, 0.43], irisR: [0.11, 0.24, 0.43], cheek: [1, 0.6, 0.7] }, bones: { iris: 1.05 }, shapes: { noseSize: 0.2, jawSize: 0.1, blush: 0.5 }, headShape: 'heart' },
  body: { height: 0.1, legLength: 0.2, physique: -0.2, waistSize: -0.1 },
  hairDesign: { groups: [{ id: 'ahoge', name: 'Ahoge', cross: 'Flat', color: [0.36, 0.22, 0.16], params: { width: 0.01, tip: 0.1 }, strands: [{ points: [[0, 0.175, 0.02], [0.005, 0.2, 0.03], [0.015, 0.21, 0.05]] }] }] },
};
setDocument(full, 'edits', editsDoc);
const editsSha = await sha256(full.entries.get('appearance/edits.json'));
{
  const W = 1024, H = 512;
  const inEye = (x, y) => [[766, 260], [258, 260]].some(([cx, cy]) => ((x - cx) / 112) ** 2 + ((y - cy) / 126) ** 2 < 1);
  const ring = (x, y) => [[766, 260], [258, 260]].some(([cx, cy]) => { const d = ((x - cx) / 112) ** 2 + ((y - cy) / 126) ** 2; return d < 1 && d > 0.7; });
  const mask = png(W, H, (x, y) => [255, 255, 255, inEye(x, y) ? 255 : 0]);
  const shade = png(W, H, (x, y) => (inEye(x, y) ? [40, 40, 60, Math.round(120 * (1 - y / H))] : [0, 0, 0, 0]));
  const ringPng = png(W, H, (x, y) => (ring(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const iris = png(W, H, (x, y) => (inEye(x, y) ? [Math.round(28 + 92 * (y / H)), Math.round(61 + 153 * (y / H)), Math.round(110 + 94 * (y / H)), 255] : [0, 0, 0, 0]));
  const zoned = png(W, H, (x, y) => (ring(x, y) ? [0, 0, 0, 255] : inEye(x, y) ? [60, 130, 160, 255] : [0, 0, 0, 0]));
  // a state given as a finished texture alone, as if painted in another app (D39): a pink heart in each eye
  const inHeart = (x, y) => [[766, 260], [258, 260]].some(([cx, cy]) => {
    const u = (x - cx) / 90, v = -(y - cy) / 90 + 0.25;
    return (u * u + v * v - 1) ** 3 - u * u * v * v * v < 0;
  });
  const heart = png(W, H, (x, y) => (inHeart(x, y) ? [235, 70, 120, 255] : inEye(x, y) ? [60, 20, 40, 255] : [0, 0, 0, 0]));
  const paths = {};
  for (const [k, b, dir] of [['mask', mask, 'layers'], ['shade', shade, 'layers'], ['ring', ringPng, 'layers'], ['iris', iris, 'baked'], ['zoned', zoned, 'baked'], ['heart', heart, 'baked']]) {
    paths[k] = `appearance/${dir}/${await p12(b)}.png`; // the shared picture store (VRMXA §3.3, §6.0, D37)
    setEntry(full, paths[k], b);
  }
  setDocument(full, 'eyes', {
    format: 'vrmxa-eyes', version: 1, size: [W, H],
    targets: {
      white: { material: 'N00_000_00_EyeWhite_00_EYE (Instance)' }, iris: { material: 'N00_000_00_EyeIris_00_EYE (Instance)' }, highlight: { material: 'N00_000_00_EyeHighlight_00_EYE (Instance)' },
      brow: { material: 'N00_000_00_FaceBrow_00_FACE (Instance)', size: [1024, 256] }, eyeline: { material: 'N00_000_00_FaceEyeline_00_FACE (Instance)', size: [1024, 256] }, eyelash: { material: 'N00_000_00_FaceEyelash_00_FACE (Instance)', size: [1024, 256] },
    },
    eyes: { left: { center: [766, 260], radius: [112, 126] }, right: { center: [258, 260], radius: [112, 126] } },
    fills: { eyeColour: { type: 'linear', stops: [{ at: 0, color: [0.11, 0.24, 0.43] }, { at: 1, color: [0.47, 0.84, 0.8] }] } },
    states: [
      { name: 'default', layers: [
        { id: 'l1', name: 'Eye colour', target: 'iris', kind: 'fill', eye: 'both', fill: 'eyeColour', mask: paths.mask },
        { id: 'l2', name: 'Shading', target: 'iris', kind: 'image', image: paths.shade, blend: 'multiply', opacity: 0.9 },
      ], baked: { iris: paths.iris } },
      { name: 'confused', kind: 'confused', layers: [
        { id: 'l1', name: 'Eye colour', target: 'iris', kind: 'fill', eye: 'both', fill: 'eyeColour', mask: paths.mask },
        { id: 'l2', name: 'Outer ring', target: 'iris', kind: 'image', image: paths.ring },
      ], baked: { iris: paths.zoned }, hide: ['highlight'] },
      { name: 'squint', from: 'default', scale: 0.78 },
      { name: 'smitten', kind: 'love', baked: { iris: paths.heart }, hide: ['highlight'] },
    ],
  });
}
// skin layers (VRMXA §6.3, D37): a tone on both skin textures and a mark on the body, over the base's own skin
let skinSha;
{
  const mark = png(1024, 1024, (x, y) => (Math.hypot(x - 900, y - 160) < 14 ? [24, 40, 92, 255] : [0, 0, 0, 0]));
  const markPath = `appearance/layers/${await p12(mark)}.png`;
  setEntry(full, markPath, mark);
  setDocument(full, 'skin', {
    format: 'vrmxa-skin', version: 1,
    targets: { skinFace: { material: 'N00_000_00_Face_00_SKIN (Instance)', size: [1024, 1024] }, skinBody: { material: 'N00_000_00_Body_00_SKIN (Instance)', size: [1024, 1024] } },
    layers: [
      { id: 's1', name: 'Skin tone', kind: 'adjust', band: 'adjust', targets: ['skinFace', 'skinBody'], tone: { from: [0.98, 0.91, 0.86], to: [0.94, 0.84, 0.78] } },
      { id: 's2', name: 'Mole', kind: 'image', band: 'on', images: { skinBody: markPath }, source: { kind: 'mark', placement: 'uv' } },
    ],
  });
  skinSha = await sha256(full.entries.get('appearance/skin/skin.json'));
}
{
  const faceVerts = spec.json.accessors[spec.json.meshes[0].primitives[0].attributes.POSITION].count;
  const offsets = new Uint8Array(3 * 16);
  const dv = new DataView(offsets.buffer);
  [[100, 0, -0.001, 0.0005], [101, 0, -0.0012, 0.0005], [102, 0, -0.001, 0.0004]].forEach(([v, x, y, z], k) => { dv.setUint32(k * 16, v, true); dv.setFloat32(k * 16 + 4, x, true); dv.setFloat32(k * 16 + 8, y, true); dv.setFloat32(k * 16 + 12, z, true); });
  const offPath = `appearance/mouth/shapes/${await p12(offsets)}.bin`;
  setEntry(full, offPath, offsets);
  const lips = png(256, 128, (x, y) => [200, 120, 120, Math.abs(y - 64) < 2 && x > 80 && x < 176 ? 0 : 255]);
  const lipsLayer = png(256, 128, (x, y) => [0, 0, 0, Math.abs(y - 64) < 2 && x > 80 && x < 176 ? 0 : 0]);
  const lipsPath = `appearance/baked/${await p12(lips)}.png`;
  const layerPath = `appearance/layers/${await p12(lipsLayer)}.png`;
  setEntry(full, lipsPath, lips);
  setEntry(full, layerPath, lipsLayer);
  setDocument(full, 'mouth', {
    format: 'vrmxa-mouth', version: 1, mesh: { name: spec.json.meshes[0].name, vertices: faceVerts },
    targets: { mouth: { material: 'N00_000_00_FaceMouth_00_FACE (Instance)', size: [512, 512] }, lips: { material: 'N00_000_00_Face_00_SKIN (Instance)', size: [1024, 1024], region: [384, 704, 256, 128] } },
    states: [
      { name: 'default' },
      { name: 'pout', offsets: { file: offPath, count: 3, of: { edits: editsSha } }, layers: [{ id: 'l1', name: 'No mouth line', target: 'lips', kind: 'image', band: 'skin', image: layerPath }], baked: { lips: lipsPath, of: { skin: skinSha, edits: editsSha } } },
      { name: 'scowl', morphs: { MTH_Angry: 1, MTH_Down: 0.3 } },
    ],
  });
}
// the closet, through the closet protocol (CLOSET.md §5): items added, worn, a state, hair, fine-tuning, outfits
const ids = {};
for (const [k, b, source] of [['top', itemBytes['specfit-top'], 'specfit-top.vrmxw'], ['trousers', itemBytes['specfit-trousers'], 'specfit-trousers.vrmxw'], ['shoes', itemBytes.shoes, 'shoes-lift.vrmxw'],
  ['sword', itemBytes.states, 'states-pinned.vrmxw'], ['staff', itemBytes.animated, 'animated.vrmxw'], ['hair', itemBytes.hair, 'hair.vrmxw'], ['ribbon', itemBytes.worn, 'worn-skinned.vrmxw'],
  ['borrowed', itemBytes.restricted, 'restricted.vrmxw']]) {
  ids[k] = (await closet.addItem(full, b, { source, spec: specBytes })).id;
}
await closet.putOn(full, ids.top, opts);
await closet.putOn(full, ids.trousers, opts);
await closet.putOn(full, ids.shoes, opts);
await closet.putOn(full, ids.sword, { ...opts, state: 'stowed' });
await closet.changeHair(full, ids.hair, opts);
await closet.setFitting(full, ids.top, { rule: { ease: 'relaxed' }, adjust: { loose: 0.002, up: 0.001 } }, { ...opts, merge: true });
await closet.saveOutfit(full, 'Adventurer', { idFactory: () => uuid('outfit adventurer') });
await closet.makeOutfit(full, { id: uuid('outfit ribbon'), name: 'Ribbon and staff', items: [ids.ribbon, ids.trousers, ids.staff], states: {} });
// animations: an idle in the default set; a walk whose feet sink, corrected by grounding it for Spec in 2 cm boots
const idle = vrma('Idle, breathing', { spine: [[0, [1, 0, 0], 0], [2, [1, 0, 0], 2.5], [4, [1, 0, 0], 0]], head: [[0, [0, 1, 0], 0], [2, [0, 1, 0], -4], [4, [0, 1, 0], 0]] });
const walk = vrma('Walk', {
  leftUpperLeg: [[0, [1, 0, 0], -20], [0.5, [1, 0, 0], 20], [1, [1, 0, 0], -20]], rightUpperLeg: [[0, [1, 0, 0], 20], [0.5, [1, 0, 0], -20], [1, [1, 0, 0], 20]],
  leftLowerLeg: [[0, [1, 0, 0], 5], [0.25, [1, 0, 0], 30], [0.5, [1, 0, 0], 5], [1, [1, 0, 0], 5]], rightLowerLeg: [[0, [1, 0, 0], 5], [0.5, [1, 0, 0], 5], [0.75, [1, 0, 0], 30], [1, [1, 0, 0], 5]],
}, { legs: true, hips: [[0, [0, 0.8784, 0.0036]], [0.5, [0, 0.8784, 0.0036]], [1, [0, 0.8784, 0.0036]]] });
const idleSha = (await motion.addClip(full, idle, { details: { name: 'Idle, breathing', duration: 4, loops: true, rootMotion: 'inPlace', speed: null, source: 'made by scripts/make-spec-fixtures.mjs', licence: 'CC0-1.0' } })).sha256;
const walkSha = (await motion.addClip(full, walk, { details: { name: 'Walk', duration: 1, loops: true, rootMotion: 'inPlace', speed: 1.1, source: 'made by scripts/make-spec-fixtures.mjs',
  licence: { authors: ['Xocialize LLC'], licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', allowRedistribution: true, modification: 'allowModificationRedistribution', commercialUsage: 'corporation', creditNotation: 'unnecessary' } } })).sha256;
const defaultSet = await motion.createSet(full, { name: 'Default', default: true, slots: { idle: [{ clip: idleSha, weight: 1 }], walk: [{ clip: walkSha, rate: 1, blendIn: 0.25 }] } });
const specRig = motion.rigFromVrm(specBytes, { label: 'Spec' });
const boots = motion.figureOf(motion.withLift(specRig, 0.02, 'Spec in 2 cm boots'));
const corrected = await motion.correctClip(full, walkSha, [{ kind: 'ground', figure: boots }], { rig: specRig });
void defaultSet;
// voices: a designed voice with the models that made it, and a real person's voice with recorded consent. Both clips are
// synthetic hums made here: the "real person" is a stand-in, so a reader meets the fields a real one has.
const designed = await voices.addVoice(full, {
  name: 'Mira', language: 'en', origin: 'designed',
  design: { model: 'fixture-voice-designer', version: '1', description: 'A soft hum standing in for a calm voice.', seed: 7, text: 'This clip is a synthetic tone, not speech.', params: {} },
  madeWith: [{ model: 'fixture-voice-designer', version: '1', license: { spdx: 'Apache-2.0', commercialUse: true, termsUrl: 'https://www.apache.org/licenses/LICENSE-2.0', notice: null, attribution: null }, seed: 7, prompt: 'A soft hum standing in for a calm voice.', input: null }],
  realPerson: false, meta: { authors: ['Xocialize LLC'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' },
  clips: [{ bytes: hum(4, 24000, 180), transcript: 'This clip is a synthetic tone, not speech.', style: 'neutral' }],
}, { idFactory: () => uuid('voice designed') });
await voices.addVoice(full, {
  name: 'Recorded stand-in', language: 'en-GB', origin: 'recorded', realPerson: true,
  speaker: 'Test Speaker (a stand-in: this clip is a synthetic tone, no one\'s voice)',
  consent: { given: true, date: '2026-11-18', scope: 'This character only. Not to be passed on. Non-commercial. (A test record.)', record: 'https://example.com/consent/fixture-0001' },
  meta: { authors: ['Test Speaker'], licenseUrl: 'https://example.com/licence/recorded-voice', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' },
  clips: [{ bytes: hum(5, 48000, 140), transcript: 'A synthetic tone stands in for a recording.', style: 'neutral' }],
}, { idFactory: () => uuid('voice recorded') });
await voices.setDefaultVoice(full, designed.id);
// persona, origin and settings (character.sqlite)
await setPersona(full, {
  name: 'Mira', age: 'mid-twenties', summary: 'A test character for the specification.', description: 'Short, quick, and usually carrying a sword on her back.',
  personality: 'Curious and plain-spoken.', traits: ['curious', 'plain-spoken'], speech_style: 'Short sentences.', languages: ['en'], rest_expression: 'neutral',
  allowed_expressions: ['happy', 'angry', 'sad', 'relaxed', 'surprised'], voice_id: designed.id, creator: 'Xocialize LLC', tags: ['fixture'], extensions: { 'x-xocialize.fixture': { travels: true } },
  examples: [{ user: 'Where are you going?', character: 'North. Coming?' }, { user: 'Is that sword heavy?', character: 'Less than it looks.' }],
});
await setListing(full, { url: 'https://example.com/characters/mira', marketplace: 'Example Market', listing_id: 'CH-0001' });
await setSetting(full, 'x-xocialize.fixture', 'true');
// details and permissions, never looser than what she wears (VRMXA §5.3), then avatar.vrm drawn with everything worn
await setDetails(full, {
  name: 'Mira', version: '1.0', authors: ['Xocialize LLC'], copyrightInformation: '© 2026 Xocialize LLC', contactInformation: 'https://example.com/contact', references: ['https://example.com/characters/mira'],
  licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlySeparatelyLicensedPerson', commercialUsage: 'personalProfit', creditNotation: 'required', allowRedistribution: true, modification: 'allowModification',
  allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false,
});
setDocument(full, 'measurements', await measureEdits(specBytes, editsDoc));
await closet.redrawAvatar(full, { spec: specBytes });
write('characters/full.vrmxa', await writeBundle(full));
void corrected;

// ================================================================ invalid files: one rule broken in each
const invalid = [];
const bad = (file, entry) => invalid.push({ file: `invalid/${file}`, ...entry });
const tn = thumb(10, 10, 10);
const mini = miniVrm('Control');
const control = () => {
  const b = createBundle({ avatar: mini, base, thumbnail: tn, id: uuid('control id'), fileId: uuid('control fileId'), created: T, generator: GEN });
  b.manifest.avatar.header.id = uuid('control avatar header');
  return b;
};
const packed = (b) => writeBundle(b, { avatarOf: 'recompute' });
const entriesOf = (bytes) => scanZip(bytes).entries.map((e) => ({ name: e.name, data: e.data }));
const json = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
// rewrite one JSON entry of a bundle or item, the manifest's files updated so the change is the only fault
async function rewrite(bytes, path, fn, manifestName = 'vrmxa.json') {
  const es = entriesOf(bytes);
  const e = es.find((x) => x.name === path);
  const doc = json(e.data);
  fn(doc);
  e.data = jsonBytes(doc);
  const m = es.find((x) => x.name === manifestName);
  const man = json(m.data);
  if (path !== manifestName) {
    const rec = man.files.find((f) => f.path === path);
    if (rec) { rec.size = e.data.length; rec.sha256 = await sha256(e.data); }
    // the stand-in avatar.vrm is taken as drawn from the closet as it now is, so the closet's fault is the only one
    if (path === 'closet/closet.json' && man.avatar?.of) man.avatar.of.closet = rec.sha256;
    m.data = jsonBytes(man);
  }
  return rawZip(es.map((x) => ({ ...x, store: /\.(vrmxw|png)$/.test(x.name) })));
}
const manifestOf = (bytes, name = 'vrmxa.json') => json(entriesOf(bytes).find((x) => x.name === name).data);
// a small character with a closet (a hat, a sword in two states, a staff that brings a set), the base for the closet faults
const withCloset = async () => {
  const b = control();
  const k = {};
  const idleClip = vrma('Idle', { spine: [[0, [1, 0, 0], 0], [2, [1, 0, 0], 2], [4, [1, 0, 0], 0]] });
  const sha = (await motion.addClip(b, idleClip, { details: { name: 'Idle', duration: 4, loops: true, rootMotion: 'inPlace', speed: null, source: 'made by scripts/make-spec-fixtures.mjs', licence: 'CC0-1.0' } })).sha256;
  await motion.createSet(b, { name: 'Default', default: true, slots: { idle: [{ clip: sha }] } });
  for (const [n, bytes] of [['hat', itemBytes.pinned], ['sword', itemBytes.states], ['staff', itemBytes.animated], ['top', itemBytes.worn], ['shown', itemBytes.shown]]) k[n] = (await closet.addItem(b, bytes, { spec: specBytes })).id;
  b._ids = k;
  return b;
};
const controlBytes = await packed(control());
write('invalid/control.vrmxa', controlBytes);
const closetControl = await withCloset();
const closetControlBytes = await packed(closetControl);
write('invalid/control-closet.vrmxa', closetControlBytes);
const cid = closetControl._ids;
const itemControl = itemBytes.pinned;

// -- the container (VRMXA §3.2, §3.5)
{
  const es = entriesOf(controlBytes);
  write('invalid/manifest-not-first.vrmxa', rawZip([es[1], es[0], ...es.slice(2)]));
  bad('manifest-not-first.vrmxa', { rule: 'the manifest is the first entry', section: 'VRMXA §3.2', codes: ['container.manifest-first'], spec: ['container.manifest-first'] });
  const evil = new TextEncoder().encode('should never be written\n');
  const m = manifestOf(controlBytes);
  m.files.push({ path: '../escape.txt', size: evil.length, sha256: await sha256(evil) });
  write('invalid/entry-name-escapes.vrmxa', rawZip([{ name: 'vrmxa.json', data: jsonBytes(m) }, ...es.slice(1), { name: '../escape.txt', data: evil }]));
  bad('entry-name-escapes.vrmxa', { rule: 'an entry name never has a ".." segment, so nothing is written outside the folder', section: 'VRMXA §3.5 Entry names', codes: ['zip.entry-name', 'schema.manifest'], spec: ['zip.entry-name', 'schema.manifest'] });
  const m2 = manifestOf(controlBytes);
  m2.files.find((f) => f.path === 'avatar.vrm').sha256 = '0'.repeat(64);
  write('invalid/hash-mismatch.vrmxa', rawZip([{ name: 'vrmxa.json', data: jsonBytes(m2) }, ...es.slice(1)]));
  bad('hash-mismatch.vrmxa', { rule: 'each entry\'s SHA-256 matches the manifest', section: 'VRMXA §3.2, §4 files', codes: ['container.hash'], spec: ['container.hash'] });
  write('invalid/entry-not-listed.vrmxa', rawZip([...es, { name: 'stowaway.txt', data: new TextEncoder().encode('not in the manifest\n') }]));
  bad('entry-not-listed.vrmxa', { rule: 'every entry is in the manifest\'s files', section: 'VRMXA §3.5 Inventory', codes: ['container.inventory'], spec: ['container.inventory'] });
  write('invalid/listed-not-present.vrmxa', rawZip(es.filter((e) => e.name !== 'thumbnail.png')));
  bad('listed-not-present.vrmxa', { rule: 'every listed file is an entry', section: 'VRMXA §3.5 Inventory', codes: ['container.inventory', 'bundle.thumbnail'], spec: ['container.inventory'] });
  const m3 = manifestOf(controlBytes);
  m3.files.push({ path: 'padding.bin', size: 4 * 1024 * 1024, sha256: await sha256(new Uint8Array(4 * 1024 * 1024)) });
  write('invalid/zip-bomb.vrmxa', rawZip([{ name: 'vrmxa.json', data: jsonBytes(m3) }, ...es.slice(1), { name: 'padding.bin', data: new Uint8Array(4 * 1024 * 1024) }]));
  bad('zip-bomb.vrmxa', { rule: 'an entry over 1 MB never unpacks to more than 500 times its packed size', section: 'VRMXA §3.5 Sizes, D31', codes: ['zip.ratio'], spec: ['zip.ratio'] });
}
// -- the manifest (VRMXA §4, §5)
const manifestFault = async (file, fn, entry) => { write(`invalid/${file}`, await rewrite(controlBytes, 'vrmxa.json', fn)); bad(file, entry); };
await manifestFault('id-not-uuid.vrmxa', (m) => { m.id = 'mira'; }, { rule: 'id, the character\'s identity, is a UUID', section: 'VRMXA §4.1', codes: ['bundle.id'], spec: ['schema.manifest'] });
await manifestFault('no-avatar.vrmxa', (m) => { delete m.avatar; }, { rule: 'every bundle carries the last configured VRM, named in avatar', section: 'VRMXA §5.2, D2', codes: ['bundle.avatar'], spec: ['schema.manifest'] });
await manifestFault('version-newer.vrmxa', (m) => { m.version = 6; m.meta.schemaVersion = 6; }, { rule: 'a bundle version newer than the reader knows is refused', section: 'VRMXA §2 rule 4, §1', codes: ['bundle.version-newer'], spec: ['schema.manifest'] });
await manifestFault('persona-without-database.vrmxa', (m) => { m.sections.persona = { version: 1 }; }, { rule: 'a persona section requires character.sqlite, named in database', section: 'VRMXA §3.3', codes: ['bundle.database'], spec: ['schema.manifest'] });
await manifestFault('unknown-base.vrmxa', (m) => { m.base.sha256 = 'f'.repeat(64); m.avatar.of.base = 'f'.repeat(64); }, { rule: 'the base is a published Spec', section: 'VRMXA §5.1', codes: ['base.unknown'], spec: ['base.unknown'] });
// -- the closet (VRMXA §7; CLOSET.md §2)
const closetFault = async (file, fn, entry) => {
  const es = entriesOf(closetControlBytes);
  write(`invalid/${file}`, await rewrite(closetControlBytes, 'closet/closet.json', fn));
  void es;
  bad(file, entry);
};
await closetFault('closet-two-tops-worn.vrmxa', (c) => { c.worn.items = [cid.top, cid.shown]; }, { rule: 'one item per slot except accessory', section: 'CLOSET.md C4; VRMXA §7.2', codes: ['closet.c4'], spec: ['closet.c4'] });
await closetFault('closet-unknown-state.vrmxa', (c) => { c.worn.items = [cid.sword]; c.worn.states = { [cid.sword]: 'sheathed' }; }, { rule: 'every state recorded is one the item has', section: 'CLOSET.md C5', codes: ['closet.c5'], spec: ['closet.c5'] });
await closetFault('closet-worn-not-in-closet.vrmxa', (c) => { c.worn.items = [uuid('nowhere')]; }, { rule: 'what is worn lists only items in the closet', section: 'CLOSET.md C4', codes: ['closet.c4'], spec: ['closet.c4'] });
await closetFault('closet-outfit-id-not-uuid.vrmxa', (c) => { c.outfits = [{ id: 'evening', name: 'Evening', items: [cid.hat], states: {}, thumbnail: null }]; }, { rule: 'an outfit\'s id is a UUID', section: 'VRMXA §7.4, D36', codes: ['closet.outfit'], spec: ['schema.closet'] });
await closetFault('closet-outfit-missing.vrmxa', (c) => { c.worn.outfit = uuid('no such outfit'); }, { rule: 'an outfit named in worn exists', section: 'CLOSET.md C5', codes: ['closet.c5'], spec: ['closet.c5'] });
{
  // an item file with no closet entry (C3)
  const es = entriesOf(closetControlBytes);
  write('invalid/closet-file-not-listed.vrmxa', await rewrite(closetControlBytes, 'closet/closet.json', (c) => { c.items = c.items.filter((i) => i.id !== cid.hat); }));
  void es;
  bad('closet-file-not-listed.vrmxa', { rule: 'closet.json lists exactly the item files present', section: 'CLOSET.md C3', codes: ['closet.c3'], spec: ['closet.c3'] });
}
{
  // an item fitted to another base (C2): the hat re-made on the retired Spec, put in the closet in its place
  const r = await readItem(itemControl);
  r.manifest.base = { name: 'Spec', species: 'human', sha256: retired.sha256 };
  const other = await writeItem(r);
  const es = entriesOf(closetControlBytes);
  const path = es.find((e) => e.name.includes(cid.hat)).name;
  const m = manifestOf(closetControlBytes);
  const rec = m.files.find((f) => f.path === path);
  rec.size = other.length; rec.sha256 = await sha256(other);
  const c = json(es.find((e) => e.name === 'closet/closet.json').data);
  const entry = c.items.find((i) => i.id === cid.hat);
  entry.base = retired.sha256;
  const cb = jsonBytes(c);
  const crec = m.files.find((f) => f.path === 'closet/closet.json');
  crec.size = cb.length; crec.sha256 = await sha256(cb);
  m.avatar.of.closet = crec.sha256;
  write('invalid/closet-item-other-base.vrmxa', rawZip(es.map((e) => (e.name === 'vrmxa.json' ? { name: e.name, data: jsonBytes(m) } : e.name === path ? { name: path, data: other, store: true } : e.name === 'closet/closet.json' ? { name: e.name, data: cb } : { ...e, store: /\.(vrmxw|png)$/.test(e.name) }))));
  bad('closet-item-other-base.vrmxa', { rule: 'every item names the bundle\'s base', section: 'CLOSET.md C2', codes: ['closet.c2'], spec: ['closet.c2'] });
}
// -- animations (VRMXA §8)
const animFault = async (file, fn, entry) => { write(`invalid/${file}`, await rewrite(closetControlBytes, 'animations/animations.json', fn)); bad(file, entry); };
await animFault('animations-set-from-missing-item.vrmxa', (a) => { a.sets.find((x) => x.from).from = uuid('an item that left'); }, { rule: 'a set marked as brought by an item belongs to an item in the closet', section: 'CLOSET.md C7', codes: ['closet.c7'], spec: ['closet.c7'] });
await animFault('animations-default-without-idle.vrmxa', (a) => { const d = a.sets.find((x) => x.default); d.slots = { walk: d.slots.idle }; }, { rule: 'the default set fills idle', section: 'VRMXA §8.2', codes: ['animations.default-idle'], spec: ['schema.animations'] });
await animFault('animations-bad-tag.vrmxa', (a) => { a.sets.find((x) => x.from).requires = ['Held Staff']; }, { rule: 'a tag is namespace:value, each part [a-z0-9][a-z0-9._-]*', section: 'VRMXA §8.3', codes: ['animations.set'], spec: ['schema.animations'] });
await animFault('animations-slot-clip-missing.vrmxa', (a) => { a.sets.find((x) => x.default).slots.idle = [{ clip: 'e'.repeat(64) }]; }, { rule: 'a slot plays clips that are in clips', section: 'VRMXA §8.4', codes: ['animations.slot-clip'], spec: ['animations.slot-clip'] });
// -- voices (VRMXA §9), on the full character's voices document
const fullBytes = await writeBundle(full);
const voiceFault = async (file, fn, entry) => {
  const b = control();
  const fv = json(entriesOf(fullBytes).find((e) => e.name === 'voice/voices.json').data);
  const v = JSON.parse(JSON.stringify(fv.voices[0]));
  const clipEntry = entriesOf(fullBytes).find((e) => e.name === v.clips[0].file);
  setEntry(b, clipEntry.name, clipEntry.data);
  const doc = { format: 'vrmxa-voices', version: 1, default: v.id, voices: [v] };
  fn(v, doc);
  setEntry(b, 'voice/voices.json', jsonBytes(doc));
  b.manifest.sections.voice = { version: 1, file: 'voice/voices.json' };
  write(`invalid/${file}`, await packed(b));
  bad(file, entry);
};
await voiceFault('voice-real-person-without-consent.vrmxa', (v) => { v.realPerson = true; v.speaker = 'Someone'; v.consent = null; }, { rule: 'a real person\'s voice says how they agreed (consent)', section: 'VRMXA §9.3, D19', codes: ['voice.consent'], spec: ['schema.voices'] });
await voiceFault('voice-clip-without-transcript.vrmxa', (v) => { delete v.clips[0].transcript; }, { rule: 'every clip has its exact transcript', section: 'VRMXA §9.1, D8', codes: ['voice.transcript'], spec: ['schema.voices'] });
await voiceFault('voice-clip-without-sha256.vrmxa', (v) => { delete v.clips[0].sha256; }, { rule: 'a clip\'s record has its file, its sha256 and its transcript', section: 'VRMXA §9.2, D36', codes: ['voice.clip'], spec: ['schema.voices'] });
await voiceFault('voice-without-licence.vrmxa', (v) => { delete v.meta; }, { rule: 'a voice says who made it and what they allow (meta)', section: 'VRMXA §9.3, D19', codes: ['licence.missing'], spec: ['schema.voices'] });
await voiceFault('voice-made-with-local-path.vrmxa', (v) => { v.madeWith[0].model = '/Users/someone/models/voice'; }, { rule: 'madeWith never holds a local path', section: 'VRMXA §9.2, D35', codes: ['voice.made-with'], spec: ['schema.voices'] });
// -- eyes and mouth (VRMXA §6.1, §6.2)
{
  const fe = entriesOf(fullBytes);
  const eyes = json(fe.find((e) => e.name === 'appearance/eyes/eyes.json').data);
  const b = control();
  for (const s of eyes.states) for (const p of [...(s.layers || []).flatMap((l) => [l.mask, l.image]), ...Object.values(s.baked || {})]) if (p) setEntry(b, p, fe.find((e) => e.name === p).data);
  eyes.states = [eyes.states[1], eyes.states[0], eyes.states[2]];
  setEntry(b, 'appearance/eyes/eyes.json', jsonBytes(eyes));
  b.manifest.sections.appearance = { version: 1, eyes: { file: 'appearance/eyes/eyes.json', format: 'vrmxa-eyes', version: 1 } };
  write('invalid/eyes-first-state-not-default.vrmxa', await packed(b));
  bad('eyes-first-state-not-default.vrmxa', { rule: 'the first eye state is default', section: 'VRMXA §6.1', codes: ['eyes.default'], spec: ['schema.eyes'] });
  // eye-state morphs as a list of names, not names with weights (D36)
  const listed = JSON.parse(JSON.stringify(eyes));
  listed.states = [eyes.states[1], eyes.states[0], eyes.states[2]]; // back in order: the fault above swapped them
  listed.states[1].morphs = ['EYE_Surprised'];
  const b3 = control();
  for (const s2 of listed.states) for (const p of [...(s2.layers || []).flatMap((l) => [l.mask, l.image]), ...Object.values(s2.baked || {})]) if (p) setEntry(b3, p, fe.find((e) => e.name === p).data);
  setEntry(b3, 'appearance/eyes/eyes.json', jsonBytes(listed));
  b3.manifest.sections.appearance = { version: 1, eyes: { file: 'appearance/eyes/eyes.json', format: 'vrmxa-eyes', version: 1 } };
  write('invalid/eyes-morphs-as-list.vrmxa', await packed(b3));
  bad('eyes-morphs-as-list.vrmxa', { rule: 'an eye state\'s morphs are face shape → weight, 0 to 1', section: 'VRMXA §6.1, D36', codes: ['eyes.state'], spec: ['schema.eyes'] });
  const mouth = json(fe.find((e) => e.name === 'appearance/mouth/mouth.json').data);
  const b2 = control();
  const pout = mouth.states.find((s) => s.offsets);
  const off = fe.find((e) => e.name === pout.offsets.file).data;
  setEntry(b2, pout.offsets.file, off);
  for (const p of [...(pout.layers || []).map((l) => l.image), ...Object.values(pout.baked || {}).filter((v) => typeof v === 'string')]) setEntry(b2, p, fe.find((e) => e.name === p).data);
  pout.offsets.count = 4;
  delete mouth.mesh;
  setEntry(b2, 'appearance/mouth/mouth.json', jsonBytes(mouth));
  b2.manifest.sections.appearance = { version: 1, mouth: { file: 'appearance/mouth/mouth.json', format: 'vrmxa-mouth', version: 1 } };
  write('invalid/mouth-offsets-count.vrmxa', await packed(b2));
  bad('mouth-offsets-count.vrmxa', { rule: 'offsets are count records of 16 bytes', section: 'VRMXA §6.2', codes: ['mouth.offsets'], spec: ['mouth.offsets'] });
  // skin layers (VRMXA §6.3, D37)
  const skin = json(fe.find((e) => e.name === 'appearance/skin/skin.json').data);
  const skinBundle = (doc, withPictures = true) => {
    const b4 = control();
    if (withPictures) for (const l of doc.layers) for (const pth of Object.values(l.images || {})) setEntry(b4, pth, fe.find((e) => e.name === pth).data);
    setEntry(b4, 'appearance/skin/skin.json', jsonBytes(doc));
    b4.manifest.sections.appearance = { version: 1, skin: { file: 'appearance/skin/skin.json', format: 'vrmxa-skin', version: 1 } };
    return b4;
  };
  const wrongTarget = JSON.parse(JSON.stringify(skin));
  wrongTarget.layers[1].images = { skinHead: wrongTarget.layers[1].images.skinBody };
  write('invalid/skin-layer-unknown-target.vrmxa', await packed(skinBundle(wrongTarget)));
  bad('skin-layer-unknown-target.vrmxa', { rule: 'a skin layer\'s targets are skinFace and skinBody', section: 'VRMXA §6.3, D37', codes: ['layers.target'], spec: ['schema.skin'] });
  write('invalid/skin-picture-missing.vrmxa', await packed(skinBundle(skin, false)));
  bad('skin-picture-missing.vrmxa', { rule: 'every picture a layer names is in the bundle', section: 'VRMXA §6.0, D37', codes: ['layers.file'], spec: ['layers.file'] });
}
// -- the database (VRMXA §3.5, §12): checked by readers that open SQLite
{
  const fe = entriesOf(fullBytes);
  const { loadSqlJs } = await import('../src/database.js');
  const SQL = await loadSqlJs();
  const d = new SQL.Database(fe.find((e) => e.name === 'character.sqlite').data);
  d.exec('CREATE TABLE memory (id INTEGER PRIMARY KEY, said TEXT); VACUUM;');
  const withTable = d.export();
  d.close();
  const b = control();
  setEntry(b, 'character.sqlite', withTable);
  b.manifest.database = { file: 'character.sqlite', schema: 1 };
  b.manifest.sections.persona = { version: 1 };
  write('invalid/database-extra-table.vrmxa', await packed(b));
  bad('database-extra-table.vrmxa', { rule: 'the database holds only the tables and columns of its schema (a memory table least of all)', section: 'VRMXA §3.5 The database, §12, §11', codes: ['db.extra-object'], spec: [], needs: 'SQLite' });
}
// -- items (VRMXW §13)
const itemFault = async (file, fn, entry, from = itemControl) => { write(`invalid/${file}`, await rewrite(from, 'vrmxw.json', fn, 'vrmxw.json')); bad(file, entry); };
{
  const es = entriesOf(itemControl);
  write('invalid/item-manifest-not-first.vrmxw', rawZip([es[1], es[0], ...es.slice(2)]));
  bad('item-manifest-not-first.vrmxw', { rule: 'vrmxw.json is the first entry', section: 'VRMXW §3, §13 Container', codes: ['container.manifest-first'], spec: ['container.manifest-first'] });
}
await itemFault('item-without-licence.vrmxw', (m) => { delete m.meta; }, { rule: 'meta is present with authors and licenseUrl', section: 'VRMXW §11, §13 Licence', codes: ['licence.missing'], spec: ['schema.item'] });
await itemFault('item-bad-permission.vrmxw', (m) => { m.meta.commercialUsage = 'anything'; }, { rule: 'every permission meta gives is one of VRM\'s values', section: 'VRMXW §11, §13 Licence', codes: ['licence.value'], spec: ['schema.item'] });
await itemFault('item-unknown-type.vrmxw', (m) => { m.type = 'cape'; }, { rule: 'type is one of VRMXW §6\'s, or an x-<vendor>.<name>', section: 'VRMXW §6, §13 Type', codes: ['item.type'], spec: ['schema.item'] });
await itemFault('item-bad-tag.vrmxw', (m) => { m.tags = ['Head Wear']; }, { rule: 'a tag is namespace:value, each part [a-z0-9][a-z0-9._-]*', section: 'VRMXW §13 Tags', codes: ['item.tag'], spec: ['schema.item'] });
await itemFault('item-rig-not-humanoid.vrmxw', (m) => { m.rig.humanBones.hatBrim = m.rig.humanBones.head; }, { rule: 'every name in rig.humanBones is a VRM 1.0 humanoid bone', section: 'VRMXW §13 Rig', codes: ['item.rig'], spec: ['schema.item'] });
await itemFault('item-rig-node-missing.vrmxw', (m) => { m.rig.humanBones.neck = 9999; }, { rule: 'every index in rig.humanBones is a node in the model', section: 'VRMXW §13 Rig', codes: ['item.rig'], spec: ['item.rig'] });
await itemFault('item-pin-without-attach.vrmxw', (m) => { m.attach = null; }, { rule: 'a pinned item names the humanoid bone it follows', section: 'VRMXW §8, §13 Pin', codes: ['item.attach'], spec: ['schema.item'] });
await itemFault('item-state-name-twice.vrmxw', (m) => { m.states[1].name = 'held'; }, { rule: 'state names are unique', section: 'VRMXW §8, §13 States', codes: ['item.state'], spec: ['item.state'] }, itemBytes.states);
await itemFault('item-state-bone-not-rigged.vrmxw', (m) => { m.states[1].bone = 'leftFoot'; }, { rule: 'each state\'s bone is in rig.humanBones', section: 'VRMXW §8, §13 States', codes: ['item.state'], spec: ['item.state'] }, itemBytes.states);
await itemFault('item-state-shows-unknown-mesh.vrmxw', (m) => { m.states[0].show = [...m.states[0].show, 'Hood']; }, { rule: 'each show name is a mesh node\'s', section: 'VRMXW §8, W24, §13 States', codes: ['item.state'], spec: ['item.state'] }, itemBytes.shown);
await itemFault('item-set-without-own-tag.vrmxw', (m) => { m.animations.sets[0].requires = ['held:sword']; }, { rule: 'every set an item brings requires at least one of the item\'s own tags', section: 'VRMXW §9, §13 Animations', codes: ['animations.item-requires'], spec: ['animations.item-requires'] }, itemBytes.animated);
await itemFault('item-hide-skin-not-boolean.vrmxw', (m) => { m.fit.hideSkin = 'no'; }, { rule: 'fit.hideSkin is true or false', section: 'VRMXW §7, W29', codes: ['item.fit'], spec: ['schema.item'] });
await itemFault('item-lift-not-shoes.vrmxw', (m) => { m.fit.lift = 0.02; }, { rule: 'only shoes record a lift', section: 'VRMXW §7.1', codes: ['item.lift'], spec: ['schema.item'] });
await itemFault('item-version-newer.vrmxw', (m) => { m.version = 2; }, { rule: 'an item format newer than the reader knows is refused', section: 'VRMXW §13 Manifest', codes: ['item.version-newer'], spec: ['schema.item'] });
await itemFault('item-unknown-base.vrmxw', (m) => { m.base.sha256 = 'f'.repeat(64); }, { rule: 'base.sha256 is a published base', section: 'VRMXW §13 Base', codes: ['base.unknown'], spec: ['base.unknown'] });
// faults in the model itself
const modelFault = async (file, edit, entry, from = items.pinned) => {
  const g = parseGlb(from.entries.get('model.glb'));
  const bin = g.bin.slice();
  const m = JSON.parse(JSON.stringify(from.manifest));
  const out = edit(g.json, m, bin);
  const it = await createItem({ id: m.id, created: T, generator: GEN, name: m.name, type: m.type, kind: m.kind, attach: m.attach?.bone, model: buildGlb(g.json, out instanceof Uint8Array ? out : bin), rig: m.rig, meta: m.meta, origin: m.origin, tags: m.tags, states: m.states });
  write(`invalid/${file}`, await writeItem(it));
  bad(file, entry);
};
await modelFault('item-model-is-a-vrm.vrmxw', (j) => { j.extensionsUsed = [...(j.extensionsUsed || []), 'VRMC_vrm']; j.extensions = { ...(j.extensions || {}), VRMC_vrm: { specVersion: '1.0', meta: { name: 'x', authors: ['x'], licenseUrl: 'x' }, humanoid: { humanBones: {} } } }; },
  { rule: 'the model is a glTF 2.0 GLB with no VRMC_vrm', section: 'VRMXW §5, §13 Model', codes: ['item.model-vrm'], spec: ['item.model-vrm'] });
await modelFault('item-worn-mesh-unskinned.vrmxw', (j) => { for (const n of j.nodes) if (n.mesh !== undefined) delete n.skin; },
  { rule: 'every mesh of a worn item has a skin', section: 'VRMXW §5.3 rule 1, §13 Worn', codes: ['item.worn-skin'], spec: ['item.worn-skin'] }, items.worn);
await modelFault('item-pin-skinned-to-body.vrmxw', (j, m, bin) => {
  // the hat's mesh skinned, every vertex wholly, to the head bone
  const meshNode = j.nodes.findIndex((n) => n.mesh !== undefined);
  const prims = j.meshes[j.nodes[meshNode].mesh].primitives;
  let out = bin;
  const append = (typed, componentType, type, count, target) => {
    const pad = (4 - (out.length % 4)) % 4;
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const next = new Uint8Array(out.length + pad + bytes.length);
    next.set(out, 0); next.set(bytes, out.length + pad);
    j.bufferViews.push({ buffer: 0, byteOffset: out.length + pad, byteLength: bytes.length, ...(target ? { target } : {}) });
    out = next;
    j.buffers[0].byteLength = out.length;
    j.accessors.push({ bufferView: j.bufferViews.length - 1, componentType, count, type });
    return j.accessors.length - 1;
  };
  for (const p of prims) {
    const n = j.accessors[p.attributes.POSITION].count;
    const w = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) w[i * 4] = 1;
    p.attributes.JOINTS_0 = append(new Uint16Array(n * 4), 5123, 'VEC4', n, 34962);
    p.attributes.WEIGHTS_0 = append(w, 5126, 'VEC4', n, 34962);
  }
  const ibm = append(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 5126, 'MAT4', 1);
  j.skins = [...(j.skins || []), { joints: [m.rig.humanBones.head], inverseBindMatrices: ibm }];
  j.nodes[meshNode].skin = j.skins.length - 1;
  return out;
}, { rule: 'no mesh of a pinned item is skinned to a humanoid bone', section: 'VRMXW §5.4, §13 Pin', codes: ['item.pin-skin'], spec: ['item.pin-skin'] });
await modelFault('item-not-on-spec.vrmxw', (j, m, bin) => {
  // every humanoid joint bound 1 cm higher than Spec binds it: the inverse bind matrices' Y translation, in place
  const human = new Set(Object.values(m.rig.humanBones));
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (const skin of j.skins || []) {
    const a = j.accessors[skin.inverseBindMatrices];
    const off = (j.bufferViews[a.bufferView].byteOffset || 0) + (a.byteOffset || 0);
    skin.joints.forEach((node, k) => { if (human.has(node)) { const at = off + (k * 16 + 13) * 4; dv.setFloat32(at, dv.getFloat32(at, true) - 0.01, true); } });
  }
}, { rule: 'every humanoid joint\'s inverse bind matrix is Spec\'s to within 1e-5', section: 'VRMXW §5.3 rule 4, §13 No change on Spec', codes: ['item.bind'], spec: ['item.bind'] }, items.worn);
await modelFault('item-spring-joint-twice.vrmxw', (j) => {
  const sb = j.extensions.VRMC_springBone;
  sb.springs.push({ name: 'Again', joints: sb.springs[0].joints.map((x) => ({ ...x })), colliderGroups: sb.springs[0].colliderGroups });
}, { rule: 'a node is a joint of one spring only', section: 'VRMXW §5.5, §13 Springs', codes: ['item.spring'], spec: ['item.spring'] }, items.worn);

// ================================================================ check, then write expected.json
const expectedOf = async (rel, bytes) => {
  const isItem = rel.endsWith('.vrmxw');
  const P = isItem ? await checkItem(bytes, { spec: specBytes }) : await checkBundle(bytes, { spec: specBytes });
  return { errors: P.filter((p) => p.severity === 'error'), warnings: P.filter((p) => p.severity === 'warning') };
};
const VALID = {
  'characters/minimal.vrmxa': { what: 'the least a bundle holds: manifest, avatar.vrm (Spec, named "Minimal"), thumbnail. No sections, no database', covers: 'VRMXA §3.3, §4, §5.2, D2, D30' },
  'characters/full.vrmxa': { what: '"Mira", every section: the edit document (face, body, drawn hair), measurements of the edited body, eye states over the six eye targets (fill, mask, image layers; confused hiding the highlight; squint made from default; smitten, of kind love, given as a finished texture alone), skin layers (a tone on both skin textures, a mark on the body); avatar.vrm carries the default eye set and the layered skin, flattened (§6.0), mouth states (offsets with layers and a baked lip patch recording the skin it was flattened over; shapes), pictures in appearance/layers/ and appearance/baked/, a closet of eight items with a Spec-fitted top and trousers, boots with lift, a sword stowed, a hair piece, fine-tuning, two outfits, a staff that brought its set and clip, a restricted hat as a spare; animations with a corrected clip, its edit document and groundedFor; a designed voice with madeWith and a real-person stand-in with recorded consent; persona, examples, origin and a setting in character.sqlite; details and permissions in avatar.vrm, with every worn piece\'s licence in extras.vrmxaPieces', covers: 'VRMXA §3–§12, D37; CLOSET.md C1–C8; EDITS v7; FITTING §4.5' },
  'items/worn-skinned.vrmxw': { what: 'a worn, skinned top: MToon with a texture, a ribbon on three bones of its own with a spring and a collider, a thumbnail, a listing', covers: 'VRMXW §5.3, §5.5, §11' },
  'items/pinned.vrmxw': { what: 'a hat pinned to the head', covers: 'VRMXW §5.4, §8' },
  'items/states-pinned.vrmxw': { what: 'a sword with two states: held in the right hand, stowed on the upper chest with a matrix; state tags', covers: 'VRMXW §8' },
  'items/states-shown.vrmxw': { what: 'a worn top whose ribbon is a part of its own; states name the parts they show', covers: 'VRMXW §8, W24' },
  'items/animated.vrmxw': { what: 'a staff that brings a clip and a set requiring its own tag, and carries a vendor extension with a file', covers: 'VRMXW §9, §10' },
  'items/hair.vrmxw': { what: 'a hair piece made from drawn strands (type hair, fit head)', covers: 'VRMXW §6, §7; EDITS §6' },
  'items/shoes-lift.vrmxw': { what: 'boots made from Spec\'s feet with a 2 cm sole: fit.lift 0.02', covers: 'VRMXW §7.1' },
  'items/restricted.vrmxw': { what: 'the hat under another maker\'s terms: no changes, no passing on, non-commercial, credit required', covers: 'VRMXW §11; VRMXA §5.3; PRD HON' },
  'items/specfit-top.vrmxw': { what: 'a top made from Spec\'s own skin, 4 mm out, the bust bones folded in: for Spec-fit', covers: 'FITTING §5, §8; VRMXW §5.3 rule 3' },
  'items/specfit-trousers.vrmxw': { what: 'trousers made from Spec\'s own skin, 5 mm out: for Spec-fit', covers: 'FITTING §5, §8' },
  'invalid/control.vrmxa': { what: 'the small bundle the bundle faults are made from, without a fault: a 2 KB stand-in VRM, a thumbnail', covers: 'VRMXA §3, §4' },
  'invalid/control-closet.vrmxa': { what: 'the same with a closet of five items and the set the staff brought: the base of the closet and animation faults', covers: 'VRMXA §7, §8' },
};
const report = { valid: {}, invalid: {} };
const problemsLine = (P) => P.map((p) => `${p.code} ${p.where}: ${p.message}`).join('\n');
let failed = 0;
for (const [rel, v] of Object.entries(VALID)) {
  const bytes = new Uint8Array(readFileSync(join(OUT, rel)));
  const { errors, warnings } = await expectedOf(rel, bytes);
  if (errors.length || warnings.length) { failed++; console.error(`✗ ${rel} should pass with nothing to report:\n${problemsLine([...errors, ...warnings])}`); }
  report.valid[rel] = { ...v, size: bytes.length, sha256: await sha256(bytes) };
}
for (const e of invalid) {
  const bytes = new Uint8Array(readFileSync(join(OUT, e.file)));
  const { errors } = await expectedOf(e.file, bytes);
  const got = [...new Set(errors.map((p) => p.code))].sort();
  const want = [...new Set(e.codes)].sort();
  // the library's schema findings join its own codes; a fixture fails for its rule alone when every code is the one named
  const ok = want.every((c) => got.includes(c)) && got.every((c) => want.includes(c) || c.startsWith('schema.'));
  if (!ok) { failed++; console.error(`✗ ${e.file}: expected ${want.join(', ')}, the library reports ${got.join(', ') || 'nothing'}\n${problemsLine(errors)}`); }
  const { file, ...rest } = e;
  report.invalid[file] = { ...rest, library: got, size: bytes.length, sha256: await sha256(bytes) };
}
write('expected.json', new TextEncoder().encode(`${JSON.stringify({
  format: 'vrmxa-fixtures', version: 1,
  note: 'What each fixture is and the section it covers. A valid file passes with nothing to report. An invalid file breaks one rule: `rule` and `section` name it, `library` lists the codes the reference library reports (its checker\'s own and its schema findings), and `spec` the codes tools/check reports for it ([] when it needs SQLite, which tools/check does not open). Sizes are bytes; Git LFS keeps the files.',
  generator: GEN, base: specSha, ...report,
}, null, 2)}\n`));
if (failed) { console.error(`${failed} fixture(s) do not behave as expected`); process.exit(1); }
if (!quiet) console.log(`${Object.keys(report.valid).length} valid and ${Object.keys(report.invalid).length} invalid fixtures, ${(Object.values(sizes).reduce((a, b) => a + b, 0) / 1048576).toFixed(2)} MB`);
