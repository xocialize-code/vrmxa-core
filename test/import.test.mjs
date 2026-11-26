// The importer (PRD §8.1, IMP-1 to IMP-12; VRMXW §7.1, §13, §14; FITTING.md §7): a dressed VRM opened as
// pieces, grouped and classified, each approved group moved onto Spec by its bones and written as a valid
// item with the source's licence and origin; a 0.x source converted on a copy; an import left and resumed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseGlb, buildGlb, readAccessor } from '../src/glb.js';
import { readItem, sha256 } from '../src/index.js';
import { checkItem } from '../src/checker.js';
import { localMatrix, multiply } from '../src/math.js';
import * as imp from '../src/import/index.js';
import { dressSpec } from '../scripts/lib/dress.mjs';
import { SPEC_DIR, noSpec, specVrm } from './helpers.mjs';

const dressed = () => {
  const s = parseGlb(specVrm());
  const m = JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8'));
  return dressSpec(JSON.parse(JSON.stringify(s.json)), s.bin, m);
};
const dressedBytes = () => { const d = dressed(); return buildGlb(d.json, d.bin); };

// a donor in shoes, as VRoid makes one: the whole figure raised by `lift` (its root moved up)
function raised(lift) {
  const d = dressed();
  const json = JSON.parse(JSON.stringify(d.json));
  for (const r of json.scenes[0].nodes) {
    const n = json.nodes[r];
    if (n.mesh !== undefined && n.skin !== undefined) continue;
    const m = multiply(localMatrix({ translation: [0, lift, 0] }), localMatrix(n));
    delete n.matrix;
    n.translation = [m[12], m[13], m[14]];
  }
  // skinned vertices are in bind space: raise them too, and their bind matrices with the bones
  const bin = d.bin.slice();
  const dv = new DataView(bin.buffer);
  const done = new Set();
  for (const mesh of json.meshes) for (const p of mesh.primitives) {
    const ai = p.attributes.POSITION;
    if (done.has(ai)) continue;
    done.add(ai);
    const a = json.accessors[ai], bv = json.bufferViews[a.bufferView];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 12;
    for (let i = 0; i < a.count; i++) dv.setFloat32(off + i * stride + 4, dv.getFloat32(off + i * stride + 4, true) + lift, true);
    a.min[1] += lift; a.max[1] += lift;
  }
  for (const skin of json.skins) {
    const a = json.accessors[skin.inverseBindMatrices], bv = json.bufferViews[a.bufferView];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
    if (done.has(`i${off}`)) continue;
    done.add(`i${off}`);
    // the bones are raised, W' = T(lift)·W, so each inverse bind becomes IBM·T(−lift)
    for (let i = 0; i < a.count; i++) {
      const at = (k) => off + i * 64 + k * 4;
      for (let r = 0; r < 3; r++) dv.setFloat32(at(12 + r), dv.getFloat32(at(12 + r), true) - lift * dv.getFloat32(at(4 + r), true), true);
    }
  }
  return { bytes: buildGlb(json, bin), parts: d.parts };
}

test('a dressed VRM opens as pieces: the body never comes in, the clothes are grouped and classified (IMP-5, IMP-7)', { skip: noSpec }, async () => {
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  assert.equal(src.vrm, '1.0');
  const body = src.pieces.filter((p) => p.never);
  assert.ok(body.some((p) => p.role === 'skin') && body.some((p) => p.role === 'face'), 'the body and face are pieces that are never imported');
  for (const g of src.groups) for (const id of g.pieces) assert.ok(!src.pieces.find((p) => p.id === id).never, `${g.name} holds no body piece`);
  const top = src.groups.find((g) => g.pieces.some((id) => /Top/.test(src.pieces.find((p) => p.id === id).material)));
  assert.equal(top.type, 'top');
  assert.equal(top.kind, 'worn');
  const sword = src.groups.find((g) => g.pieces.some((id) => /Sword|Metal/i.test(src.pieces.find((p) => p.id === id).material)) && g.kind === 'pin');
  assert.ok(sword, 'an unskinned piece is proposed as pinned');
  assert.ok(src.terms.length === 4 && typeof src.allowsChanges === 'boolean', 'the maker\'s terms, in plain words');
});

test('a donor in shoes: the lift is measured, taken out of every item and recorded on the shoes; items are bound where Spec binds (ITM-11, VRMXW §5.3)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const LIFT = 0.025;
  const flat = await imp.openSource(dressedBytes(), { fileName: 'flat.vrm' });
  const high = await imp.openSource(raised(LIFT).bytes, { fileName: 'raised.vrm' });
  const rigsFlat = imp.importRigs(flat, spec);
  const rigsHigh = imp.importRigs(high, spec);
  assert.equal(rigsFlat.lift.lift, 0);
  assert.ok(Math.abs(rigsHigh.lift.lift - LIFT) < 2e-4, `measured ${rigsHigh.lift.lift} m`);
  const g = high.groups.find((x) => x.type === 'top');
  const a = imp.groupModel(flat, flat.groups.find((x) => x.type === 'top'), rigsFlat);
  const b = imp.groupModel(high, g, rigsHigh);
  const pa = parseGlb(a.glb), pb = parseGlb(b.glb);
  const va = readAccessor(pa.json, pa.bin, pa.json.meshes[0].primitives[0].attributes.POSITION);
  const vb = readAccessor(pb.json, pb.bin, pb.json.meshes[0].primitives[0].attributes.POSITION);
  let worst = 0;
  for (let i = 0; i < va.length; i++) worst = Math.max(worst, Math.abs(va[i] - vb[i]));
  assert.ok(worst < 1e-5, `the raised donor's top lands where the flat one does (worst ${worst} m)`);
  assert.ok(Math.abs(b.travel - LIFT) < 1e-4, 'it travelled the lift');
  // as an item: valid against Spec, with its licence and origin
  let doc = imp.movePieces(imp.newImport(high), [high.pieces.find((p) => /Ribbon/.test(p.material)).id], g.id, { source: high });
  doc = imp.viewGroup(doc, g.id);
  doc = imp.approveGroup(doc, g.id);
  const r = await imp.importApproved(doc, high, rigsHigh, { spec });
  assert.deepEqual(r.failed, []);
  const bytes = r.items[0].bytes;
  assert.deepEqual((await checkItem(bytes, { spec })).filter((p) => p.severity === 'error'), []);
  const item = await readItem(bytes, { spec });
  const m = item.manifest;
  assert.equal(m.origin.made, 'extracted');
  assert.equal(m.origin.source, 'raised.vrm');
  assert.equal(m.origin.sha256, high.sha256);
  assert.equal(m.origin.fit, 'spec-fit', 'a top comes onto Spec by Spec-fit (FITTING.md §7)');
  assert.equal(m.fit.lift, undefined, 'only shoes carry a lift');
  assert.deepEqual(m.meta.authors, high.meta.authors, 'the source\'s licence goes with the item (IMP-4)');
  const json = parseGlb(item.entries.get('model.glb')).json;
  assert.ok(json.materials.every((x) => x.extensions?.VRMC_materials_mtoon), 'MToon kept (ITM-2)');
  assert.ok(json.extensions?.VRMC_springBone?.springs?.length, 'springs kept (ITM-2)');
  // shoes record the lift (a top classified as shoes, for the test)
  let d2 = imp.classifyGroup(imp.newImport(high), g.id, { type: 'shoes' });
  d2 = imp.approveGroup(imp.viewGroup(d2, g.id), g.id);
  const shoes = await imp.importApproved(d2, high, rigsHigh, { spec });
  assert.ok(Math.abs(shoes.items[0].item.manifest.fit.lift - rigsHigh.lift.lift) < 1e-9, 'shoes record the lift');
});

test('the place (move, turn, size) applies about the item\'s centre, the same in the model as in the formula (IMP-9)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  const rigs = imp.importRigs(src, spec);
  const g = src.groups.find((x) => x.type === 'top');
  const base = imp.groupModel(src, g, rigs);
  const place = { move: [0, 0.01, -0.005], turn: [0, 10, 0], size: 1.05 };
  const moved = imp.groupModel(src, { ...g, place }, rigs);
  const P = imp.placeMatrix(place, base.centre);
  const a = parseGlb(base.glb), b = parseGlb(moved.glb);
  const va = readAccessor(a.json, a.bin, a.json.meshes[0].primitives[0].attributes.POSITION);
  const vb = readAccessor(b.json, b.bin, b.json.meshes[0].primitives[0].attributes.POSITION);
  for (let i = 0; i < va.length; i += 300) {
    const v = [va[i], va[i + 1], va[i + 2]];
    const want = [0, 1, 2].map((r) => P[r] * v[0] + P[4 + r] * v[1] + P[8 + r] * v[2] + P[12 + r]);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(vb[i + k] - want[k]) < 1e-5);
  }
  assert.deepEqual(imp.cleanPlace({ size: 9, turn: [370, 0, -190] }), { move: [0, 0, 0], turn: [10, 0, 170], size: 2 });
});

test('regrouping, classifying, approving: nothing comes in unseen, and a change sends a group back to waiting (IMP-3, IMP-6, IMP-7)', { skip: noSpec }, async () => {
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  let doc = imp.newImport(src, { now: '2026-11-16T00:00:00.000Z' });
  const top = doc.groups.find((g) => g.type === 'top');
  const ribbonPiece = src.pieces.find((p) => /Ribbon/.test(p.material)).id;
  assert.throws(() => imp.approveGroup(doc, top.id), /not been looked at/);
  doc = imp.approveGroup(imp.viewGroup(doc, top.id), top.id);
  assert.equal(doc.groups.find((g) => g.id === top.id).status, 'approved');
  // the ribbon moved into the top: the top is waiting and unseen again
  doc = imp.movePieces(doc, [ribbonPiece], top.id, { source: src });
  assert.equal(doc.groups.find((g) => g.id === top.id).status, 'waiting');
  assert.equal(doc.groups.find((g) => g.id === top.id).viewed, false);
  // split it out again, rename it, classify it
  const piece = ribbonPiece;
  doc = imp.splitGroup(doc, top.id, [piece], { name: 'Ribbon' });
  const ribbon = doc.groups.find((g) => g.name === 'Ribbon');
  assert.deepEqual(ribbon.pieces, [piece]);
  assert.equal(doc.groups.find((g) => g.id === top.id).status, 'waiting');
  assert.equal(doc.groups.indexOf(ribbon), doc.groups.findIndex((g) => g.id === top.id) + 1, 'the new group sits beside the one it came from');
  doc = imp.renameGroup(doc, ribbon.id, 'Back ribbon');
  doc = imp.classifyGroup(doc, ribbon.id, { type: 'back' });
  const r = doc.groups.find((g) => g.id === ribbon.id);
  assert.deepEqual([r.type, r.slot, r.kind, r.attach], ['back', 'accessory', 'pin', 'upperChest']);
  doc = imp.mergeGroups(doc, [top.id, ribbon.id]);
  assert.equal(doc.groups.find((g) => g.id === top.id).pieces.length, 2);
  assert.ok(!doc.groups.some((g) => g.id === ribbon.id));
  // the body is never moved into a group
  const bodyPiece = src.pieces.find((p) => p.never).id;
  assert.throws(() => imp.movePieces(doc, [bodyPiece], top.id, { source: src }), /never imported/);
  doc = imp.skipGroup(doc, top.id);
  assert.equal(imp.importCounts(doc).skipped, 1);
});

test('an import is left and resumed against the same file, and refused against another (IMP-12)', { skip: noSpec }, async () => {
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  let doc = imp.newImport(src);
  doc = imp.renameGroup(doc, doc.groups[0].id, 'Kept name');
  const saved = JSON.parse(JSON.stringify(doc));
  const again = imp.resumeImport(saved, src);
  assert.equal(again.groups[0].name, 'Kept name');
  const other = await imp.openSource(raised(0.01).bytes, { fileName: 'other.vrm' });
  assert.throws(() => imp.resumeImport(saved, other), /not of this file/);
  assert.throws(() => imp.resumeImport({ ...saved, version: 99 }, src), /newer/);
  const bad = JSON.parse(JSON.stringify(saved));
  bad.groups[0].pieces.push(src.pieces.find((p) => p.never).id);
  assert.match(imp.importProblems(bad, src).join(' '), /never imported/);
  // the record says what came from where
  const spec = specVrm();
  const g = doc.groups.find((x) => x.type === 'top');
  doc = imp.approveGroup(imp.viewGroup(doc, g.id), g.id);
  const r = await imp.importApproved(doc, src, imp.importRigs(src, spec), { spec });
  const rec = imp.importRecord(r.doc);
  assert.equal(rec.source.sha256, src.sha256);
  assert.equal(rec.taken.length, 1);
  assert.equal(rec.taken[0].item, r.items[0].item.manifest.id);
  assert.ok(rec.taken[0].pieces.length >= 1);
  assert.equal(r.doc.groups.find((x) => x.id === g.id).item.id, rec.taken[0].item);
});

test('a VRM 0.x is converted on a copy: facing +Z, MToon, springs, humanoid and meta; the source bytes are unchanged (IMP-11)', { skip: noSpec }, async () => {
  // a 0.x made from the dressed Spec: turned to face −Z, its 1.0 blocks written the 0.x way
  const d = dressed();
  const t = imp.turnAround(d.json, d.bin);
  const j = t.json;
  const v1 = j.extensions.VRMC_vrm;
  const thumbs = { leftThumbMetacarpal: 'leftThumbProximal', leftThumbProximal: 'leftThumbIntermediate', rightThumbMetacarpal: 'rightThumbProximal', rightThumbProximal: 'rightThumbIntermediate' };
  j.extensions.VRM = {
    exporterVersion: 'test',
    meta: { title: 'Zero', author: 'Maker Zero', licenseName: 'CC_BY_ND', commercialUssageName: 'Allow', allowedUserName: 'Everyone' },
    humanoid: { humanBones: Object.entries(v1.humanoid.humanBones).map(([bone, o]) => ({ bone: thumbs[bone] || bone, node: o.node })) },
    materialProperties: j.materials.map((m) => ({ name: m.name, shader: 'VRM/MToon', floatProperties: { _BlendMode: 0, _OutlineWidthMode: 1, _OutlineWidth: 0.2 }, vectorProperties: { _Color: [1, 1, 1, 1], _ShadeColor: [0.5, 0.5, 0.6, 1] }, textureProperties: {} })),
    secondaryAnimation: { boneGroups: [{ comment: 'ribbon', stiffiness: 0.8, gravityPower: 0.3, gravityDir: { x: 0, y: -1, z: 0 }, dragForce: 0.4, hitRadius: 0.01, bones: [j.nodes.findIndex((n) => n.name === 'J_Sec_Ribbon_1')], colliderGroups: [] }], colliderGroups: [] },
  };
  delete j.extensions.VRMC_vrm;
  delete j.extensions.VRMC_springBone;
  for (const m of j.materials) if (m.extensions) delete m.extensions.VRMC_materials_mtoon;
  j.extensionsUsed = ['VRM', 'KHR_materials_unlit'];
  const zero = buildGlb(j, t.bin);
  const before = await sha256(zero);
  const src = await imp.openSource(zero, { fileName: 'zero.vrm' });
  assert.equal(await sha256(zero), before, 'the source bytes are unchanged');
  assert.equal(src.vrm, '0.x');
  assert.equal(src.sha256, before, 'the origin hash is the file\'s own, not the converted copy\'s');
  const c = src.json;
  assert.ok(c.extensions.VRMC_vrm && !c.extensions.VRM);
  assert.equal(c.extensions.VRMC_vrm.humanoid.humanBones.leftThumbMetacarpal.node, d.json.extensions.VRMC_vrm.humanoid.humanBones.leftThumbMetacarpal.node, 'the thumb renamed back');
  assert.ok(c.materials.every((m) => m.extensions?.VRMC_materials_mtoon));
  assert.ok(c.extensions.VRMC_springBone.springs.length >= 1, 'the ribbon swings again');
  assert.deepEqual(src.meta.authors, ['Maker Zero']);
  assert.equal(src.meta.modification, 'prohibited', 'CC BY-ND allows no changes');
  // facing +Z again: every vertex back where the 1.0 original had it
  const o = d.json.meshes.findIndex((m) => m.name === 'FixtureTop');
  const va = readAccessor(d.json, d.bin, d.json.meshes[o].primitives[0].attributes.POSITION);
  const vb = readAccessor(c, src.bin, c.meshes[o].primitives[0].attributes.POSITION);
  let worst = 0;
  for (let i = 0; i < va.length; i++) worst = Math.max(worst, Math.abs(va[i] - vb[i]));
  assert.ok(worst < 1e-6, `${worst}`);
  // and its items import
  const spec = specVrm();
  const g = src.groups.find((x) => x.type === 'top');
  let doc = imp.approveGroup(imp.viewGroup(imp.newImport(src), g.id), g.id);
  const r = await imp.importApproved(doc, src, imp.importRigs(src, spec), { spec });
  assert.deepEqual(r.failed, []);
  assert.equal(r.items[0].item.manifest.origin.vrm, '0.x');
});

test('licences: the stricter of the file\'s and the listing\'s terms is kept; a VRoid Hub listing is read (IMP-4, LIC-4)', () => {
  const m = imp.stricterMeta({ authors: ['A'], modification: 'allowModificationRedistribution', allowRedistribution: true, commercialUsage: 'corporation' }, { modification: 'prohibited', allowRedistribution: false, commercialUsage: 'personalProfit' });
  assert.equal(m.modification, 'prohibited');
  assert.equal(m.allowRedistribution, false);
  assert.equal(m.commercialUsage, 'personalProfit');
  const l = imp.listingFromVroidHub({ id: '42', character: { id: '7', user: { name: 'Maker' } }, license: { modification: 'allow', redistribution: 'disallow', credit: 'necessary', corporate_commercial_use: 'disallow', personal_commercial_use: 'nonprofit' } });
  assert.equal(l.url, 'https://hub.vroid.com/characters/7/models/42');
  assert.equal(l.marketplace, 'VRoid Hub');
  assert.deepEqual(l.terms, { modification: 'allowModification', allowRedistribution: false, creditNotation: 'required', commercialUsage: 'personalNonProfit' });
  assert.equal(l.maker, 'Maker');
});

test('a 0.x "Other" licence with a VRoid Hub licence address is read from the address; the 0.x fields stay the stricter (IMP-4, LIC-4)', () => {
  const hub = (q) => `https://hub.vroid.com/license?allowed_to_use_user=everyone&characterization_allowed_user=everyone&${q}&version=1`;
  const open = hub('corporate_commercial_use=allow&credit=unnecessary&modification=allow&personal_commercial_use=profit&redistribution=allow&sexual_expression=disallow&violent_expression=allow');
  const base = { title: 'T', author: 'A', allowedUserName: 'Everyone', violentUssageName: 'Allow', sexualUssageName: 'Allow', commercialUssageName: 'Allow', licenseName: 'Other' };
  const m = imp.metaFromVrm0({ ...base, otherLicenseUrl: open, otherPermissionUrl: open });
  assert.equal(m.modification, 'allowModificationRedistribution');
  assert.equal(m.allowRedistribution, true);
  assert.equal(m.creditNotation, 'unnecessary');
  assert.equal(m.commercialUsage, 'corporation');
  assert.equal(m.avatarPermission, 'everyone');
  assert.equal(m.allowExcessivelySexualUsage, false, 'the address forbids it, so it stays forbidden although 0.x allows it');
  assert.equal(m.allowExcessivelyViolentUsage, true);
  assert.match(m.copyrightInformation, /VRoid Hub terms: https:\/\/hub\.vroid\.com\/license/);
  assert.equal(imp.termsOf(m).allowsChanges, true);
  // 0.x says no commercial use: the address can't loosen that
  assert.equal(imp.metaFromVrm0({ ...base, commercialUssageName: 'Disallow', otherLicenseUrl: open }).commercialUsage, 'personalNonProfit');
  // the address forbids changes and passing on
  const closed = imp.metaFromVrm0({ ...base, otherLicenseUrl: hub('modification=disallow&redistribution=disallow&credit=necessary&corporate_commercial_use=disallow&personal_commercial_use=nonprofit') });
  assert.equal(closed.modification, 'prohibited');
  assert.equal(closed.allowRedistribution, false);
  assert.equal(closed.creditNotation, 'required');
  assert.equal(closed.commercialUsage, 'personalNonProfit');
  // another host, or a named licence, leaves the address alone
  assert.equal(imp.metaFromVrm0({ ...base, otherLicenseUrl: open.replace('hub.vroid.com', 'example.com') }).modification, 'prohibited');
  assert.equal(imp.metaFromVrm0({ ...base, licenseName: 'CC_BY_ND', otherLicenseUrl: open }).modification, 'prohibited');
  assert.equal(imp.vroidHubLicence('not a url'), null);
});

// ---- real avatars, when present on this machine (third-party art is never in git) -----------------------

const ELENA = process.env.VRMXA_ELENA_VRM || join(homedir(), 'Documents/VRM/Elena.vrm');
test('Elena: five items, valid against Spec, MToon and springs kept, the 31.3 mm lift on the boots', { skip: noSpec || (!existsSync(ELENA) && 'Elena.vrm is not on this machine') }, async () => {
  const spec = specVrm();
  const src = await imp.openSource(new Uint8Array(readFileSync(ELENA)), { fileName: 'Elena.vrm' });
  const rigs = imp.importRigs(src, spec);
  assert.equal(rigs.lift.lift, 0.0313);
  const types = Object.fromEntries(src.groups.map((g) => [g.name, g.type]));
  assert.deepEqual(types, { Hair: 'hair', Tops: 'coat', Bottoms: 'socks', 'Tops 2': 'dress', Shoes: 'shoes', Onepiece: 'socks' });
  let doc = imp.newImport(src);
  const shoes = doc.groups.find((g) => g.name === 'Shoes'), cuffs = doc.groups.find((g) => g.name === 'Bottoms');
  doc = imp.mergeGroups(doc, [shoes.id, cuffs.id], { name: 'Thigh boots' });
  for (const g of doc.groups) doc = imp.approveGroup(imp.viewGroup(doc, g.id), g.id);
  const r = await imp.importApproved(doc, src, rigs, { spec });
  assert.deepEqual(r.failed, []);
  assert.equal(r.items.length, 5);
  for (const it of r.items) {
    assert.deepEqual(it.problems.filter((p) => p.severity !== 'info'), [], it.item.manifest.name);
    const j = parseGlb(it.item.entries.get('model.glb')).json;
    assert.ok(j.materials.every((x) => x.extensions?.VRMC_materials_mtoon), `${it.item.manifest.name}: MToon`);
  }
  const hair = r.items.find((it) => it.item.manifest.type === 'hair');
  assert.equal(hair.model.springs, 21);
  // #41: the dress leans on her bust bones, which are folded into the chest, not carried as "Bust" chains
  const dress = r.items.find((it) => it.item.manifest.type === 'dress');
  const dj = parseGlb(dress.item.entries.get('model.glb')).json;
  assert.ok(!(dj.extensions?.VRMC_springBone?.springs || []).some((sp) => /Bust/i.test(sp.name || '')), 'no Bust chain');
  assert.ok(!dj.nodes.some((n) => /Bust/.test(n.name || '')), 'no bust bone');
  assert.ok(dress.model.springs > 0, 'the skirt\'s own chains are kept');
  const boots = r.items.find((it) => it.item.manifest.type === 'shoes').item.manifest;
  assert.equal(boots.fit.lift, 0.0313);
  assert.equal(boots.origin.pieces.length, 2);
  assert.deepEqual(boots.meta.authors, ['Xocialize']);
});

// A local copy of a VRoid Hub model, when VRMXA_DATASET_DIR names the folder of such copies (never in this repository).
const DATASET = join(process.env.VRMXA_DATASET_DIR || '/nonexistent', 'vroid/0/1008310613509133290');
test('a VRoid 0.x from the dataset: converted, imported, every item valid, the listing carried', { skip: noSpec || (!existsSync(DATASET) && 'set VRMXA_DATASET_DIR to run it') }, async () => {
  const spec = specVrm();
  const id = '1008310613509133290';
  const listing = imp.listingFromVroidHub(JSON.parse(readFileSync(join(DATASET, `${id}.json`), 'utf8')));
  const src = await imp.openSource(new Uint8Array(readFileSync(join(DATASET, `${id}.vrm`))), { fileName: `${id}.vrm`, listing });
  assert.equal(src.vrm, '0.x');
  let doc = imp.newImport(src);
  for (const g of doc.groups) doc = imp.approveGroup(imp.viewGroup(doc, g.id), g.id);
  const r = await imp.importApproved(doc, src, imp.importRigs(src, spec), { spec });
  assert.deepEqual(r.failed, []);
  assert.ok(r.items.length >= 4);
  for (const it of r.items) {
    assert.equal(it.item.manifest.listing.marketplace, 'VRoid Hub');
    assert.equal(it.item.manifest.listing.id, id);
    assert.equal(it.item.manifest.origin.converted, true);
  }
});

test('vrmxa import: lists what it finds, writes approved items with the import and its record, and can put them on a character (MCP-10)', { skip: noSpec }, async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-import-'));
  try {
    const src = join(dir, 'dressed.vrm');
    writeFileSync(src, dressedBytes());
    const cli = join(import.meta.dirname, '..', 'bin', 'vrmxa.mjs');
    const run = (...a) => JSON.parse(execFileSync(process.execPath, [cli, ...a, '--json'], { encoding: 'utf8' }));
    const list = run('import', src);
    assert.ok(list.groups.length >= 3);
    assert.ok(list.body.some((p) => p.role === 'skin'));
    assert.throws(() => execFileSync(process.execPath, [cli, 'import', src, join(dir, 'out')], { stdio: 'pipe' }), /approve/, 'nothing is written without saying which groups');
    const top = list.groups.find((g) => g.type === 'top');
    const r = run('import', src, join(dir, 'out'), '--approve', top.id, '--name', `${top.id}=Sailor top`, '--tags', `${top.id}=top:sailor, style:school`, '--into', join(import.meta.dirname, '..', 'fixtures', 'characters', 'minimal.vrmxa'), '--out', join(dir, 'char.vrmxa'), '--wear');
    assert.equal(r.ok, true);
    assert.deepEqual(r.written.map((w) => w.name), ['Sailor top']);
    const files = readdirSync(join(dir, 'out')).sort();
    assert.ok(files.includes('import.json') && files.includes('import-record.json') && files.some((f) => f.endsWith('.vrmxw')));
    assert.ok(r.into.closet.worn.items.length === 1, 'worn on the character');
    const motion = run('motion', join(dir, 'char.vrmxa'));
    assert.deepEqual([...motion.plan.equipped.tags].sort(), ['style:school', 'top:sailor'], 'the tags given on the command line are worn');
    // resuming with the saved import writes nothing new for a group already written
    const again = run('import', src, join(dir, 'out2'), '--doc', join(dir, 'out', 'import.json'));
    assert.deepEqual(again.written, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('what the head carries follows the head\'s size: moved centre to centre and scaled, the bones unscaled (VRMXW §7 head)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  const rigs = imp.importRigs(src, spec);
  assert.ok(rigs.head && Math.abs(rigs.head.k - 1) < 1e-3, 'Spec dressed is Spec: the same head');
  let doc = imp.newImport(src);
  const hat = doc.groups.find((g) => g.name === 'Hat');
  doc = imp.classifyGroup(doc, hat.id, { type: imp.WORN_ACCESSORY }); // skinned to the head, so worn
  const g = doc.groups.find((x) => x.id === hat.id);
  const plain = imp.groupModel(src, g, { ...rigs, head: null });
  const head = { from: rigs.head.to, to: rigs.head.to, k: 1.1 };
  const big = imp.groupModel(src, g, { ...rigs, head });
  const a = parseGlb(plain.glb), b = parseGlb(big.glb);
  const va = readAccessor(a.json, a.bin, a.json.meshes[0].primitives[0].attributes.POSITION);
  const vb = readAccessor(b.json, b.bin, b.json.meshes[0].primitives[0].attributes.POSITION);
  for (let i = 0; i < va.length; i += 3) for (let k = 0; k < 3; k++) assert.ok(Math.abs(vb[i + k] - (head.to[k] + 1.1 * (va[i + k] - head.to[k]))) < 1e-5);
  assert.ok(b.json.nodes.every((n) => !n.scale), 'no node carries a scale');
  const bytes = (await imp.groupItem(src, doc, g, { ...rigs, head }, { spec })).bytes;
  assert.deepEqual((await checkItem(bytes, { spec })).filter((p) => p.severity === 'error'), [], 'still bound where Spec binds');
});

test('a garment brought in by its bones is fitted again from its source by Spec-fit (VRMXW W20): same as bringing it in by Spec-fit, item kept', { skip: noSpec }, async () => {
  const spec = specVrm();
  const high = raised(0.03);
  const src = await imp.openSource(high.bytes, { fileName: 'raised.vrm' });
  const rigs = imp.importRigs(src, spec);
  const g = src.groups.find((x) => x.type === 'top');
  let doc = imp.approveGroup(imp.viewGroup(imp.newImport(src), g.id), g.id);
  const byBones = await imp.importApproved(doc, src, rigs, { spec, specFit: false });
  assert.deepEqual(byBones.failed, []);
  const old = byBones.items[0];
  assert.equal(old.item.manifest.origin.fit, 'bones');
  assert.equal(imp.refitProblem(old.item.manifest), null);
  // the wrong file is refused
  await assert.rejects(imp.refitFromSource(old.bytes, dressedBytes(), spec, { fileName: 'other.vrm' }), /is not the file/);
  const r = await imp.refitFromSource(old.bytes, high.bytes, spec, { fileName: 'raised.vrm' });
  const m = r.item.manifest;
  assert.equal(m.origin.fit, 'spec-fit');
  assert.equal(m.id, old.item.manifest.id);
  assert.equal(m.revision, old.item.manifest.revision + 1);
  assert.deepEqual(r.problems.filter((p) => p.severity === 'error'), []);
  assert.match(imp.refitProblem(m), /already/);
  // the same vertices as an import by Spec-fit in the first place
  const fresh = await imp.importApproved(imp.approveGroup(imp.viewGroup(imp.newImport(src), g.id), g.id), src, imp.importRigs(src, spec), { spec });
  const pos = (bytes) => { const { json, bin } = parseGlb(bytes); return json.meshes.flatMap((mesh) => mesh.primitives.flatMap((p) => [...readAccessor(json, bin, p.attributes.POSITION)])); };
  const a = pos(r.item.entries.get('model.glb')), b = pos(fresh.items[0].item.entries.get('model.glb'));
  assert.equal(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  assert.ok(worst < 1e-5, `refitted vertices are ${worst} m from a Spec-fit import`);
});

test('each garment of a VRM gets a fit verdict with its figures, the same every run (fit/verdict.js; a batch over a dataset)', { skip: noSpec }, async () => {
  const spec = specVrm();
  const bytes = raised(0.02).bytes;
  const a = await imp.sourceVerdicts(bytes, spec, { fileName: 'raised.vrm' });
  const b = await imp.sourceVerdicts(bytes, spec, { fileName: 'raised.vrm' });
  const top = a.garments.find((g) => g.type === 'top');
  assert.ok(top, 'the top is judged');
  assert.equal(top.method, 'spec-fit');
  assert.ok(['fits', 'fits with warnings', 'does not transfer well'].includes(top.verdict));
  for (const k of ['through', 'pushedShare', 'easeRms', 'estimatedShare']) assert.ok(Number.isFinite(top.figures[k]), k);
  assert.ok(a.others.some((o) => o.slot === 'accessory'), 'what Spec-fit doesn\'t cover is listed apart');
  const strip = (r) => JSON.stringify({ ...r, ms: 0, garments: r.garments.map((g) => ({ ...g, ms: 0, figures: { ...g.figures, ms: 0 } })) }); // timings aside
  assert.equal(strip(a), strip(b), 'deterministic');
});

test('the verdict\'s thresholds: fits, fits with warnings, does not transfer well (named figures)', async () => {
  const { fitVerdict, VERDICT, FITS, WARNS, FAILS } = await import('../src/fit/verdict.js');
  assert.equal(fitVerdict({ through: 0, pushedShare: 0.02, easeRms: 0.0004, girthRatios: { bust: 1.05 } }).verdict, FITS);
  assert.equal(fitVerdict({ through: 0.002 }).verdict, WARNS);
  assert.equal(fitVerdict({ through: VERDICT.through.fail }).verdict, FAILS);
  assert.equal(fitVerdict({ girthRatios: { waist: 1.7 } }).verdict, WARNS);
  assert.equal(fitVerdict({ girthRatios: { waist: 2.2 } }).verdict, FAILS);
  assert.equal(fitVerdict({ pushedShare: 0.35 }).verdict, FAILS);
  assert.equal(fitVerdict({ estimatedShare: 0.4, estimated: ['upperArmL'] }).verdict, WARNS);
  const ap = fitVerdict({ refused: 'the body is not in a T-pose' });
  assert.equal(ap.verdict, FAILS);
  assert.equal(ap.reasons[0].code, 'refused');
});
