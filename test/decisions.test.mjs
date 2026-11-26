// The specification questions #37 to #46, decided 2026-11-17 ("yes, as recommended"; VRMXW W17 to W26), as the
// library carries them: origin's keys (#37 W17, #46 W26), the bodyAccessory type (#38 W18), the donor body's own bones
// folded (#41 W21), states that name their parts (#44 W24); and the importer saying when two groups can't be worn
// together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlb, buildGlb, readAccessor } from '../src/glb.js';
import { readItem, writeItem, checkItem, createItem, ITEM_TYPES, resolveItemType } from '../src/index.js';
import { extractItemModel } from '../src/item-writer.js';
import { prepareItemModel } from '../src/closet/fit.js';
import * as imp from '../src/import/index.js';
import * as ed from '../src/item/index.js';
import { dressSpec } from '../scripts/lib/dress.mjs';
import { fixture, noSpec, specVrm, SPEC_DIR, codes } from './helpers.mjs';

const dressedBytes = () => {
  const s = parseGlb(specVrm());
  const d = dressSpec(JSON.parse(JSON.stringify(s.json)), s.bin, JSON.parse(readFileSync(join(SPEC_DIR, 'spec.measurements.json'), 'utf8')));
  return buildGlb(d.json, d.bin);
};

test('#37 and #46 (W17, W26): origin\'s sha256, fit, lift, converted and headScale are known keys; a wrong type is a warning, not a refusal', async () => {
  const top = await readItem(fixture('items/skinned-top.vrmxw'));
  const good = { ...top, manifest: { ...top.manifest, origin: { made: 'extracted', source: 'Elena.vrm', sha256: 'a'.repeat(64), fit: 'bones', lift: 0.0313, converted: false, headScale: 1.129, pieces: ['x'], importer: 'y' } } };
  assert.deepEqual((await checkItem(await writeItem(good))).filter((p) => p.code === 'item.origin'), []);
  const bad = { ...top, manifest: { ...top.manifest, origin: { made: 'extracted', sha256: 'nope', fit: 'by eye', lift: -1, converted: 'VRM 0.x to 1.0', headScale: -2 } } };
  const problems = await checkItem(await writeItem(bad));
  assert.equal(problems.filter((p) => p.code === 'item.origin' && p.severity === 'warning').length, 5, 'one for each of the W17 and W26 keys');
  assert.deepEqual(codes(problems), [], 'no error');
});

test('#38: bodyAccessory is a standard type, worn and fitted by its bones; vendor types still work', { skip: noSpec }, async () => {
  assert.deepEqual(ITEM_TYPES.bodyAccessory, { slot: 'accessory', kind: 'worn', fit: { method: 'bones' } });
  assert.equal(resolveItemType('x-other.ears', 'accessory', 'worn').vendor, true);
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  const ribbon = src.groups.find((g) => g.name === 'Ribbon');
  assert.equal(ribbon.type, 'bodyAccessory', 'the importer proposes it for a skinned accessory');
  const spec = specVrm();
  let doc = imp.approveGroup(imp.viewGroup(imp.newImport(src), ribbon.id), ribbon.id);
  const r = await imp.importApproved(doc, src, imp.importRigs(src, spec), { spec });
  const problems = r.items[0].problems;
  assert.deepEqual(problems.filter((p) => p.severity !== 'info'), []);
  assert.ok(!problems.some((p) => p.code === 'item.type-vendor'), 'no longer a vendor type');
});

test('#41: the donor body\'s own bones (Spec\'s bust) are folded into the chest, never carried as the item\'s chain', { skip: noSpec }, async () => {
  const spec = specVrm();
  const { json, bin } = parseGlb(spec);
  const bodyMesh = json.meshes.findIndex((m) => /Body/.test(m.name));
  // a garment cut from the body itself leans on the bust bones as much as any top can
  const cut = extractItemModel({ json, bin }, { prims: [[bodyMesh, 0]], kind: 'worn', name: 'Suit' });
  const out = parseGlb(cut.glb).json;
  assert.ok(!out.nodes.some((n) => /Bust/.test(n.name || '')), 'no bust bone in the item');
  assert.equal(cut.springs, 0, 'no Bust spring chain');
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  assert.deepEqual(src.bodyBones.map((n) => src.json.nodes[n].name).sort(), ['J_Sec_L_Bust1', 'J_Sec_L_Bust2', 'J_Sec_R_Bust1', 'J_Sec_R_Bust2'], 'the body\'s own secondary bones, from the body\'s own vertices only');
  // a garment's own chain (the fixture top's ribbon) is still kept
  const top = src.groups.find((g) => g.type === 'top');
  const withRibbon = imp.movePieces(imp.newImport(src), [src.pieces.find((p) => /Ribbon/.test(p.material)).id], top.id, { source: src });
  const m = imp.groupModel(src, withRibbon.groups.find((g) => g.id === top.id), imp.importRigs(src, spec));
  assert.equal(m.springs, 1);
});

test('#44: a state names parts by node name; names are unique; an older item\'s indices are read as names with a note', { skip: noSpec }, async () => {
  const spec = specVrm();
  const parts = await readItem(fixture('items/state-parts.vrmxw'), { spec });
  assert.deepEqual(parts.manifest.states.map((s) => s.show), [['Top_FixtureTop', 'Ribbon'], ['Top_FixtureTop']]);
  const older = await readItem(fixture('legacy/show-by-index.vrmxw'), { spec });
  assert.deepEqual(older.manifest.states.map((s) => s.show), [['Top_FixtureTop', 'Ribbon'], ['Top_FixtureTop']], 'read as names');
  assert.ok(older.problems.some((p) => p.code === 'item.show-index' && p.severity === 'info'), 'with a note');
  // the closet shows what the state names
  const model = parts.entries.get('model.glb');
  const nodes = parseGlb(model).json.nodes;
  const ribbon = nodes.findIndex((n) => n.name === 'Ribbon');
  assert.deepEqual(prepareItemModel(model, parts.manifest, { state: 'no ribbon' }).hidden, [ribbon]);
  assert.deepEqual(prepareItemModel(older.entries.get('model.glb'), older.manifest, { state: 'no ribbon' }).hidden, [ribbon]);
  // the checker: a name no node has, and names used twice, are errors
  const badShow = { ...parts, manifest: { ...parts.manifest, states: [{ name: 'x', tags: [], show: ['Nobody'] }] } };
  assert.ok(codes(await checkItem(await writeItem(badShow))).includes('item.state'));
  const p = parseGlb(model);
  const j = JSON.parse(JSON.stringify(p.json));
  j.nodes[ribbon].name = 'Top_FixtureTop';
  const dupModel = buildGlb(j, p.bin);
  const dup = { ...parts, entries: new Map([...parts.entries, ['model.glb', dupModel]]), manifest: { ...parts.manifest, states: [{ name: 'only', tags: [] }] } };
  assert.ok(codes(await checkItem(await writeItem(dup))).includes('item.node-names'), 'an item with states needs unique names');
  const noStates = { ...dup, manifest: { ...dup.manifest, states: [] } };
  assert.ok(!codes(await checkItem(await writeItem(noStates))).includes('item.node-names'), 'without states, W24 asks nothing');
  // the writer makes names unique, and renaming a part keeps the states' names in step
  const renamed = ed.renameMesh(parts, ribbon, 'Bow');
  assert.deepEqual(renamed.manifest.states[0].show, ['Top_FixtureTop', 'Bow']);
  assert.throws(() => ed.renameMesh(parts, ribbon, 'Top_FixtureTop'), /already called/);
  const two = await createItem({ model: (() => { const q = JSON.parse(JSON.stringify(p.json)); q.nodes.push({ name: 'Ribbon' }); return buildGlb(q, p.bin); })(), name: 'x', type: 'top', rig: parts.manifest.rig, meta: parts.manifest.meta, states: [{ name: 'a', tags: [] }] });
  assert.ok(codes(await checkItem(await writeItem(two))).includes('item.node-names'), 'createItem does not rename: the checker catches it');
});

test('the importer says when two groups can\'t be worn together, and merges nothing', { skip: noSpec }, async () => {
  const src = await imp.openSource(dressedBytes(), { fileName: 'dressed.vrm' });
  let doc = imp.newImport(src);
  assert.deepEqual(imp.slotClashes(doc), []);
  const [a, b] = doc.groups;
  doc = imp.classifyGroup(doc, b.id, { type: 'top' });
  const c = imp.slotClashes(doc);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].groups, [a.id, b.id]);
  assert.match(c[0].text, /only one can be worn/);
  doc = imp.classifyGroup(doc, b.id, { type: 'dress' });
  assert.match(imp.slotClashes(doc)[0].text, /takes the place of/);
  assert.deepEqual(imp.slotClashes(imp.skipGroup(doc, b.id)), [], 'a skipped group clashes with nothing');
  assert.equal(doc.groups.length, src.groups.length, 'nothing merged');
});
