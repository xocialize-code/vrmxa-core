#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
// Generate the test files (the start of PRD REF-3) from spec.vrm only:
//
//   fixtures/items/skinned-top.vrmxw      a skinned top with a swinging ribbon (MToon, springs, collider)
//   fixtures/items/fitted-top.vrmxw, fitted-trousers.vrmxw  Spec's own skin pushed out: garments for Spec-fit
//   fixtures/items/pinned-hat.vrmxw       a hat pinned to the head
//   fixtures/items/state-sword.vrmxw      a sword with two states: held in the right hand, stowed on the back
//   fixtures/items/animated-staff.vrmxw   a staff that brings an animation clip and a set
//   fixtures/items/state-parts.vrmxw      the top with its ribbon a part of its own, and states that show parts by name
//   fixtures/legacy/show-by-index.vrmxw   the same, as written before states named parts: by node index
//   fixtures/characters/minimal.vrmxa     the least a bundle holds: manifest, avatar.vrm, thumbnail
//   fixtures/characters/full.vrmxa        edits, measurements, eyes, mouth, a closet (the top and the
//                                         sword, worn) with an outfit, animations, a voice, persona
//   fixtures/legacy/v4.vrmxa              the earlier layout (version 4): body, edits with an item fit,
//                                         a bare-GLB item, a motion
//   fixtures/hostile/*                    files the checker must refuse (see hostile/expected.json)
//
// Everything is repeatable: fixed ids and times, so running it twice gives the same bytes.
//   node scripts/make-fixtures.mjs [--spec-dir <folder holding spec.vrm>] [--out <folder>] [--quiet]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { splitMesh } from '../src/item/edit.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { jsonBytes } from '../src/bytes.js';
import { buildGlb, parseGlb } from '../src/glb.js';
import { sha256 } from '../src/hash.js';
import { closetItemPath } from '../src/layout.js';
import { extractItemModel, metaFromVrm } from '../src/item-writer.js';
import { measureVrm } from '../src/measure/measure.js';
import { findBase } from '../src/vocab.js';
import { createBundle, setDatabase, setDocument, setEntry, writeBundle } from '../src/vrmxa.js';
import { closetEntryFor, createItem, writeItem } from '../src/vrmxw.js';
import { writeZip } from '../src/zip.js';
import { findSpecDir } from '../src/node/spec.js';
import { dressSpec, renameVrm } from './lib/dress.mjs';
import { fittedSamples } from './lib/fitted.mjs';
import { miniVrm } from './lib/minivrm.mjs';
import { png } from './lib/png.mjs';
import { rawZip } from './lib/rawzip.mjs';
import { vrma } from './lib/vrma.mjs';
import { wav } from './lib/wav.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? process.argv[argOut + 1] : join(here, '..', 'fixtures');
const quiet = process.argv.includes('--quiet');
const argDir = process.argv.indexOf('--spec-dir');
const SPEC_DIR = argDir > 0 ? process.argv[argDir + 1] : findSpecDir();
if (!SPEC_DIR) {
  console.error('spec.vrm not found: pass --spec-dir or set VRMXA_SPEC_DIR');
  process.exit(2);
}
const T = '2026-11-16T00:00:00.000Z';
const GEN = 'vrmxa-core fixtures (scripts/make-fixtures.mjs)';
/** A fixed UUID per label, so the fixtures are repeatable. */
const uuid = (label) => {
  const h = createHash('sha256').update(`vrmxa-core fixture: ${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const write = (rel, bytes) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  if (!quiet) console.log(`${String(bytes.length).padStart(9)}  fixtures/${rel}`);
};

const specBytes = new Uint8Array(readFileSync(join(SPEC_DIR, 'spec.vrm')));
const specMeasurements = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
const specSha = await sha256(specBytes);
const base = findBase(specSha);
if (!base || base.status !== 'standard') throw new Error(`spec.vrm (${specSha.slice(0, 12)}…) is not the standard Spec in bases.json`);
const spec = parseGlb(specBytes);
const specJson = JSON.parse(JSON.stringify(spec.json));
const xoc = { version: '1.0', authors: ['Xocialize LLC'], copyrightInformation: '© 2026 Xocialize LLC', licenseUrl: 'https://vrm.dev/licenses/1.0/',
  commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' };

// ---------------------------------------------------------------- items, cut from a dressed Spec
const dressed = dressSpec(specJson, spec.bin, specMeasurements);
const cut = (part, o) => extractItemModel(dressed, { prims: dressed.parts[part], generator: GEN, ...o });
const top = cut('top', { kind: 'worn', name: 'Top' });
const hat = cut('hat', { kind: 'pin', attach: 'head', name: 'Hat' });
const sword = cut('sword', { kind: 'pin', attach: 'rightHand', bones: ['upperChest'], name: 'Sword' });
const staff = cut('staff', { kind: 'pin', attach: 'leftHand', name: 'Staff' });
const thumb = (r, g, b) => png(64, 64, (x, y) => [r, g, b, Math.hypot(x - 31.5, y - 31.5) < 30 ? 255 : 0]);

const items = {};
items.top = await createItem({
  id: uuid('item top'), created: T, generator: GEN, name: 'Fixture top', type: 'top', model: top.glb, rig: top.rig,
  meta: { ...xoc }, listing: { url: 'https://example.com/items/fixture-top', marketplace: 'Example Market', id: 'FX-0001' },
  origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, thumbnail: thumb(80, 120, 190), tags: ['top:shell'],
});
items.hat = await createItem({
  id: uuid('item hat'), created: T, generator: GEN, name: 'Fixture hat', type: 'hat', model: hat.glb, rig: hat.rig,
  meta: { ...xoc, version: '2.0' }, origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, tags: ['headwear:hat'],
});
items.sword = await createItem({
  id: uuid('item sword'), created: T, generator: GEN, name: 'Fixture sword', type: 'handR', model: sword.glb, rig: sword.rig,
  meta: { ...xoc }, origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, tags: ['weapon:sword'],
  states: [
    { name: 'held', bone: 'rightHand', tags: ['held:sword'] },
    { name: 'stowed', bone: 'upperChest', tags: ['stowed:sword'], matrix: [0.7071068, 0.7071068, 0, 0, -0.7071068, 0.7071068, 0, 0, 0, 0, 1, 0, 0.12, 0.05, -0.16, 1] },
  ],
});
const staffClip = vrma('Staff twirl', { leftUpperArm: [[0, [0, 0, 1], 0], [0.6, [0, 0, 1], 35], [1.2, [0, 0, 1], 0]], spine: [[0, [0, 1, 0], 0], [0.6, [0, 1, 0], 10], [1.2, [0, 1, 0], 0]] });
items.staff = await createItem({
  id: uuid('item staff'), created: T, generator: GEN, name: 'Fixture staff', type: 'handL', model: staff.glb, rig: staff.rig,
  meta: { ...xoc }, origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, tags: ['weapon:staff', 'held:staff'],
  animations: {
    clips: [{ bytes: staffClip, name: 'Staff twirl', duration: 1.2, loops: true, rootMotion: 'inPlace', speed: null, tracks: ['humanoid'], source: 'made by scripts/make-fixtures.mjs', licence: 'CC0' }],
    sets: [{ name: 'Staff', priority: 10, requires: ['held:staff'], slots: { idle: [{ clip: 0 }], use: [{ clip: 0, rate: 1.5 }] } }],
  },
  extensions: { 'x-xocialize.fixture-note': { data: { version: 1, note: 'an extension the item carries; readers that do not know it keep it' }, files: { 'note.txt': new TextEncoder().encode('kept byte for byte\n') } } },
});
// the top with its ribbon split out into a part of its own, and two states that name the parts they show
// (VRMXW §8; SPEC-QUESTIONS #44, decided 2026-11-17)
const split = splitMesh(await createItem({
  id: uuid('item parts'), created: T, generator: GEN, name: 'Fixture top with parts', type: 'top', model: top.glb, rig: top.rig,
  meta: { ...xoc }, origin: { made: 'generated', source: 'scripts/make-fixtures.mjs from spec.vrm' }, tags: ['top:shell'],
}), top.meshes[0].node, [1], { name: 'Ribbon' });
items.parts = split.item;
const bodyName = parseGlb(items.parts.entries.get('model.glb')).json.nodes[top.meshes[0].node].name;
items.parts.manifest.states = [
  { name: 'tied', tags: ['ribbon:tied'], show: [bodyName, 'Ribbon'] },
  { name: 'no ribbon', tags: ['ribbon:off'], show: [bodyName] },
];
const itemBytes = {};
for (const [k, file] of [['top', 'skinned-top'], ['hat', 'pinned-hat'], ['sword', 'state-sword'], ['staff', 'animated-staff'], ['parts', 'state-parts']]) {
  itemBytes[k] = await writeItem(items[k]);
  write(`items/${file}.vrmxw`, itemBytes[k]);
}
// garments made from Spec's own skin, for trying Spec-fit (phase 5): a fitted top and fitted trousers
for (const f of await fittedSamples(specBytes)) write(f.file, f.bytes);
// the same item as written before #44: its states name parts by node index (read as names, with a note)
const older = { ...items.parts, manifest: { ...items.parts.manifest, id: uuid('item parts by index'), states: [
  { name: 'tied', tags: ['ribbon:tied'], show: [top.meshes[0].node, split.node] },
  { name: 'no ribbon', tags: ['ribbon:off'], show: [top.meshes[0].node] },
] }, entries: new Map(items.parts.entries) };
write('legacy/show-by-index.vrmxw', await writeItem(older));

// ---------------------------------------------------------------- the minimal character
const vrmNamed = (name) => buildGlb(renameVrm(spec.json, name, ['Xocialize LLC']), spec.bin);
const minimal = createBundle({ avatar: vrmNamed('Minimal'), base, thumbnail: thumb(200, 180, 160), id: uuid('minimal id'), fileId: uuid('minimal fileId'), created: T, generator: GEN });
minimal.manifest.avatar.header.id = uuid('minimal avatar header');
write('characters/minimal.vrmxa', await writeBundle(minimal));

// ---------------------------------------------------------------- the fuller character
const full = createBundle({ avatar: vrmNamed('Mira'), base, thumbnail: thumb(230, 150, 170), id: uuid('full id'), fileId: uuid('full fileId'), created: T, generator: GEN });
full.manifest.avatar.header.id = uuid('full avatar header');
setDocument(full, 'edits', {
  format: 'vrmxa-edits', version: 7, editor: GEN, madeOn: { sha256: specSha },
  face: { morphs: { EYE_Surprised: 0.2 }, colors: { irisL: [0.11, 0.24, 0.43], irisR: [0.11, 0.24, 0.43] }, bones: { iris: 1.05 }, shapes: { noseSize: 0.2, jawSize: 0.1 }, headShape: 'heart' },
  body: { height: 0.1, legLength: 0.2, physique: -0.2 },
});
const meas = await measureVrm(specBytes, { file: 'spec.vrm', of: { base: specSha, edits: null } });
setDocument(full, 'measurements', meas);
// eyes: a gradient fill clipped by a mask, and a baked iris, at the base's texture size
const W = 1024, H = 512;
const inEye = (x, y) => [[766, 260], [258, 260]].some(([cx, cy]) => ((x - cx) / 112) ** 2 + ((y - cy) / 126) ** 2 < 1);
const mask = png(W, H, (x, y) => [255, 255, 255, inEye(x, y) ? 255 : 0]);
const iris = png(W, H, (x, y) => (inEye(x, y) ? [Math.round(28 + 92 * (y / H)), Math.round(61 + 153 * (y / H)), Math.round(110 + 94 * (y / H)), 255] : [0, 0, 0, 0]));
const p12 = async (b) => (await sha256(b)).slice(0, 12);
const maskPath = `appearance/layers/${await p12(mask)}.png`; // the shared picture store (VRMXA §3.3, §6.0, D37)
const irisPath = `appearance/baked/${await p12(iris)}.png`;
setEntry(full, maskPath, mask);
setEntry(full, irisPath, iris);
setDocument(full, 'eyes', {
  format: 'vrmxa-eyes', version: 1, size: [W, H],
  targets: { white: { material: 'N00_000_00_EyeWhite_00_EYE (Instance)' }, iris: { material: 'N00_000_00_EyeIris_00_EYE (Instance)' }, highlight: { material: 'N00_000_00_EyeHighlight_00_EYE (Instance)' } },
  eyes: { left: { center: [766, 260], radius: [112, 126] }, right: { center: [258, 260], radius: [112, 126] } },
  fills: { eyeColour: { type: 'linear', stops: [{ at: 0, color: [0.11, 0.24, 0.43] }, { at: 1, color: [0.47, 0.84, 0.8] }] } },
  states: [
    { name: 'default', layers: [{ id: 'l1', name: 'Eye colour', target: 'iris', kind: 'fill', eye: 'both', fill: 'eyeColour', mask: maskPath }], baked: { iris: irisPath } },
    { name: 'squint', from: 'default', scale: 0.78 },
  ],
});
// mouth: a state of the base's own shapes, and one sculpted as offsets
const faceVerts = spec.json.accessors[spec.json.meshes[0].primitives[0].attributes.POSITION].count;
const offsets = new Uint8Array(3 * 16);
const odv = new DataView(offsets.buffer);
[[100, 0, -0.001, 0.0005], [101, 0, -0.0012, 0.0005], [102, 0, -0.001, 0.0004]].forEach(([v, x, y, z], k) => {
  odv.setUint32(k * 16, v, true); odv.setFloat32(k * 16 + 4, x, true); odv.setFloat32(k * 16 + 8, y, true); odv.setFloat32(k * 16 + 12, z, true);
});
const offPath = `appearance/mouth/shapes/${await p12(offsets)}.bin`;
setEntry(full, offPath, offsets);
setDocument(full, 'mouth', {
  format: 'vrmxa-mouth', version: 1, mesh: { name: spec.json.meshes[0].name, vertices: faceVerts },
  targets: { mouth: { material: 'N00_000_00_FaceMouth_00_FACE (Instance)', size: [512, 512] }, lips: { material: 'N00_000_00_Face_00_SKIN (Instance)', size: [1024, 1024], region: [384, 704, 256, 128] } },
  states: [
    { name: 'default' },
    { name: 'pout', offsets: { file: offPath, count: 3, of: { edits: await sha256(full.entries.get('appearance/edits.json')) } } },
    { name: 'scowl', morphs: { MTH_Angry: 1, MTH_Down: 0.3 } },
  ],
});
// closet: the top and the sword, both worn (the sword stowed); an outfit with the sword held
const topFile = closetItemPath('tops', items.top.manifest.id);
const swordFile = closetItemPath('accessory', items.sword.manifest.id);
setEntry(full, topFile, itemBytes.top);
setEntry(full, swordFile, itemBytes.sword);
const thumbPath = `closet/thumbs/${items.top.manifest.id}.png`;
setEntry(full, thumbPath, items.top.entries.get('thumbnail.png'));
const topEntry = await closetEntryFor(items.top, { file: topFile, thumbnail: thumbPath });
topEntry.fitting = { auto: true, method: 'bones', rule: { ease: 'relaxed' }, adjust: { loose: 0.004, size: 1.01, up: 0.002 } };
const outfitId = uuid('outfit adventurer');
setDocument(full, 'closet', {
  format: 'vrmxa-closet', version: 1, hair: null,
  worn: { items: [items.top.manifest.id, items.sword.manifest.id], states: { [items.sword.manifest.id]: 'stowed' }, outfit: outfitId },
  items: [topEntry, await closetEntryFor(items.sword, { file: swordFile })],
  outfits: [{ id: outfitId, name: 'Adventurer', items: [items.top.manifest.id, items.sword.manifest.id], states: { [items.sword.manifest.id]: 'stowed' }, thumbnail: null }],
});
// animations: one idle clip in the default set
const idle = vrma('Idle, breathing', { spine: [[0, [1, 0, 0], 0], [2, [1, 0, 0], 2.5], [4, [1, 0, 0], 0]], head: [[0, [0, 1, 0], 0], [2, [0, 1, 0], -4], [4, [0, 1, 0], 0]] });
const idleSha = await sha256(idle);
setEntry(full, `animations/clips/${idleSha.slice(0, 12)}.vrma`, idle);
setDocument(full, 'animations', {
  format: 'vrmxa-animations', version: 1,
  clips: [{ sha256: idleSha, file: `animations/clips/${idleSha.slice(0, 12)}.vrma`, name: 'Idle, breathing', duration: 4, loops: true, rootMotion: 'inPlace', speed: null, tracks: ['humanoid'], source: 'made by scripts/make-fixtures.mjs', licence: 'CC0' }],
  sets: [{ id: uuid('set default'), name: 'Default', default: true, priority: 0, requires: [], slots: { idle: [{ clip: idleSha, weight: 1 }] } }],
});
// voice: one designed voice with one clip
const clip = wav(3.5, 24000);
const clipSha = await sha256(clip);
const voiceId = uuid('voice mira');
setEntry(full, `voice/clips/${clipSha.slice(0, 12)}.wav`, clip);
setDocument(full, 'voices', {
  format: 'vrmxa-voices', version: 1, default: voiceId,
  voices: [{
    id: voiceId, name: 'Mira', language: 'en', origin: 'designed',
    design: { model: 'fixture-tone', version: '1', description: 'A soft hum standing in for a voice.', seed: 1, text: 'This clip is a test tone, not speech.', params: {} },
    realPerson: false, speaker: null, consent: null,
    meta: { authors: ['Xocialize LLC'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' },
    listing: null, created: T,
    clips: [{ sha256: clipSha, file: `voice/clips/${clipSha.slice(0, 12)}.wav`, transcript: 'This clip is a test tone, not speech.', language: 'en', duration: 3.5, sampleRate: 24000, style: 'neutral', primary: true }],
    engines: {},
  }],
});
await setDatabase(full, {
  persona: { name: 'Mira', age: 'mid-twenties', summary: 'A test character for the file layer.', description: 'Short, quick, and usually carrying a sword on her back.',
    personality: 'Curious and plain-spoken.', traits: ['curious', 'plain-spoken'], speech_style: 'Short sentences.', languages: ['en'], voice_id: voiceId,
    creator: 'Xocialize LLC', tags: ['fixture'], updated: T },
  examples: [{ id: uuid('example 1'), seq: 1, user_text: 'Where are you going?', character_text: 'North. Coming?' },
    { id: uuid('example 2'), seq: 2, user_text: 'Is that sword heavy?', character_text: 'Less than it looks.' }],
  listing: { url: 'https://example.com/characters/mira', marketplace: 'Example Market', listing_id: 'CH-0001' },
  settings: { 'x-xocialize.fixture': 'true' },
});
write('characters/full.vrmxa', await writeBundle(full));

// ---------------------------------------------------------------- an earlier bundle: version 4
{
  const topGlb = parseGlb(top.glb);
  topGlb.json.asset.extras = { rig: { version: 1, anchor: 'wear-time', humanBones: top.rig.humanBones }, provenance: { role: "closet item 'Top' (outfit) extracted from source VRM", extractedFrom: 'spec.vrm', sourceMeta: { fileName: 'spec.vrm', title: 'Spec', author: 'Xocialize', licenseUrl: 'https://vrm.dev/licenses/1.0/', commercialUsage: 'corporation', redistribution: true } } };
  const bare = buildGlb(topGlb.json, topGlb.bin);
  const bareSha = await sha256(bare);
  const edits = jsonBytes({ format: 'vrmxa-edits', version: 7, editor: 'VRM Developer', madeOn: { sha256: specSha }, face: { morphs: {} }, body: { height: 0.1 }, items: { [bareSha]: { loose: 0.006, size: 1.02 } } });
  const motion = jsonBytes({ format: 'vrmx-motion', version: 1, id: 'm1', name: 'Idle', fps: 30, bones: {}, expressions: {} });
  const h = (id, name, v) => ({ id, resourceName: name, formatVersion: v });
  const manifest = {
    format: 'vrmxa', version: 4, meta: { metaDataVersion: 1, schemaVersion: 4, binEncodingVersion: 1 }, id: uuid('legacy id'), revision: 3, title: 'Spec', author: 'Xocialize',
    created: T, updated: T, generator: 'VRM Developer',
    body: { header: h(uuid('legacy body'), 'Body', 1), file: 'body.vrm', source: 'spec.vrm', vrm: '1.0', size: specBytes.length, sha256: specSha },
    thumbnail: null,
    edits: { header: h(uuid('legacy edits'), 'Edits', 7), file: 'edits.json', format: 'vrmxa-edits', version: 7, sha256: await sha256(edits) },
    items: [{ header: h(uuid('legacy item'), 'Top', 1), file: `items/tops-${bareSha.slice(0, 12)}.vrmxw`, name: 'Top', category: 'outfit', slot: 'tops', worn: true, size: bare.length, sha256: bareSha }],
    animations: [{ header: h(uuid('legacy anim'), 'Idle', 1), id: 'm1', name: 'Idle', fps: 30, frames: 120, character: null,
      motion: { file: 'animations/m1.motion.json', format: 'vrmx-motion', version: 1, size: motion.length, sha256: await sha256(motion) },
      vrma: { file: 'animations/m1.vrma', size: idle.length, sha256: idleSha } }],
  };
  write('legacy/v4.vrmxa', writeZip([
    { name: 'vrmxa.json', data: jsonBytes(manifest) }, { name: 'body.vrm', data: specBytes }, { name: 'edits.json', data: edits },
    { name: manifest.items[0].file, data: bare }, { name: 'animations/m1.motion.json', data: motion }, { name: 'animations/m1.vrma', data: idle },
  ]));
}

// ---------------------------------------------------------------- hostile files
{
  const mini = miniVrm('Hostile');
  const miniSha = await sha256(mini);
  const tn = thumb(10, 10, 10);
  const manifestFor = async (files, extra = {}) => ({
    format: 'vrmxa', version: 5, meta: { metaDataVersion: 1, schemaVersion: 5, binEncodingVersion: 1 }, id: uuid('hostile id'), fileId: uuid('hostile fileId'), revision: 1,
    title: 'Hostile', author: 'Xocialize LLC', created: T, updated: T, generator: GEN, thumbnail: 'thumbnail.png',
    base: { name: 'Spec', species: 'human', vrm: '1.0', sha256: specSha },
    avatar: { header: { id: uuid('hostile avatar'), resourceName: 'Avatar', formatVersion: 1 }, file: 'avatar.vrm', vrm: '1.0', of: { base: specSha, edits: null, closet: null } },
    database: null, sections: {}, ...extra,
    files: await Promise.all(files.map(async ([path, data]) => ({ path, size: data.length, sha256: await sha256(data) }))),
  });
  const zip = async (files, extra, opts = {}) => rawZip([{ name: 'vrmxa.json', data: jsonBytes(await manifestFor(opts.listed || files, extra)) }, ...files.map(([name, data]) => ({ name, data, ...(opts.entry?.[name] || {}) }))]);
  const good = [['thumbnail.png', tn], ['avatar.vrm', mini]];
  // a clean control: the same hostile-free bundle must pass
  write('hostile/control.vrmxa', await zip(good));
  // 1. an entry that would unpack outside the folder
  const evil = new TextEncoder().encode('should never be written\n');
  write('hostile/path-escape.vrmxa', await zip([...good, ['../escape.txt', evil]]));
  // 2. a hash that lies: the manifest declares one SHA-256, the entry has another
  {
    const m = await manifestFor(good);
    m.files.find((f) => f.path === 'avatar.vrm').sha256 = miniSha.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    write('hostile/lying-hash.vrmxa', rawZip([{ name: 'vrmxa.json', data: jsonBytes(m) }, ...good.map(([name, data]) => ({ name, data }))]));
  }
  // 3. a huge entry: 300 MB of zeros that packs into 300 KB, declared honestly in the manifest
  {
    const huge = new Uint8Array(300 * 1024 * 1024);
    write('hostile/huge-entry.vrmxa', await zip([...good, ['padding.bin', huge]]));
  }
  // 4. a broken database: half of a real character.sqlite
  {
    const db = full.entries.get('character.sqlite');
    const half = db.subarray(0, Math.floor(db.length / 2) + 100);
    write('hostile/broken-db.vrmxa', await zip([...good, ['character.sqlite', half]], { database: { file: 'character.sqlite', schema: 1 }, sections: { persona: { version: 1 } } }));
  }
  // 5. a database with a trigger, which schema 1 does not allow
  {
    const { loadSqlJs } = await import('../src/database.js');
    const SQL = await loadSqlJs();
    const d = new SQL.Database(full.entries.get('character.sqlite'));
    d.exec("CREATE TRIGGER t AFTER INSERT ON setting BEGIN DELETE FROM persona; END; VACUUM;");
    const withTrigger = d.export();
    d.close();
    write('hostile/db-trigger.vrmxa', await zip([...good, ['character.sqlite', withTrigger]], { database: { file: 'character.sqlite', schema: 1 }, sections: { persona: { version: 1 } } }));
  }
  // 6. an item whose model reaches outside itself and whose entry is not in its manifest
  {
    const g = parseGlb(hat.glb);
    g.json.images = [{ uri: 'https://example.com/tracker.png' }];
    const model = buildGlb(g.json, g.bin);
    const it = await createItem({ id: uuid('hostile item'), created: T, generator: GEN, name: 'Hostile hat', type: 'hat', model, rig: hat.rig, meta: { ...xoc } });
    const bytes = await writeItem(it);
    const { entries } = (await import('../src/zip.js')).scanZip(bytes);
    write('hostile/item-external.vrmxw', rawZip([...entries.map((e) => ({ name: e.name, data: e.data })), { name: 'stowaway.js', data: new TextEncoder().encode('alert(1)\n') }]));
  }
  write('hostile/expected.json', jsonBytes({
    'control.vrmxa': [],
    'path-escape.vrmxa': ['zip.entry-name'],
    'lying-hash.vrmxa': ['container.hash'],
    'huge-entry.vrmxa': ['zip.ratio'],
    'broken-db.vrmxa': ['db.header'],
    'db-trigger.vrmxa': ['db.extra-object'],
    'item-external.vrmxw': ['model.external', 'container.inventory'],
  }));
}
// phase 7's samples (the Borrowed hat, synthetic hums, a card): their own script, into the same folder
execFileSync(process.execPath, [new URL('./make-phase7-samples.mjs', import.meta.url).pathname, '--out', OUT, ...(quiet ? ['--quiet'] : [])], { stdio: 'inherit' });
if (!quiet) console.log('done');
