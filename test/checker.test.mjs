// The checker: hostile files, closet invariants (CLOSET.md §2), item rules (VRMXW §13), and that it
// never throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundle, checkItem } from '../src/checker.js';
import { readBundle, writeBundle, setDocument, bundleToEntries } from '../src/vrmxa.js';
import { readItem, writeItem, itemToEntries } from '../src/vrmxw.js';
import { parseGlb, buildGlb } from '../src/glb.js';
import { fixture, FIX, codes, noSpec, specVrm } from './helpers.mjs';

const expected = JSON.parse(readFileSync(join(FIX, 'hostile/expected.json'), 'utf8'));

test('each hostile fixture is refused for its reason; the control passes', async () => {
  for (const [file, want] of Object.entries(expected)) {
    const bytes = fixture(`hostile/${file}`);
    const p = file.endsWith('.vrmxw') ? await checkItem(bytes) : await checkBundle(bytes);
    const got = codes(p);
    if (!want.length) assert.deepEqual(got, [], file);
    for (const c of want) assert.ok(got.includes(c), `${file}: expected ${c}, got ${got.join(', ')}`);
  }
});

test('the closet invariants: C2, C3, C4, C5, C7', async () => {
  const base = await readBundle(fixture('characters/full.vrmxa'));
  const closet = () => JSON.parse(JSON.stringify(base.docs.closet));
  const run = async (mutate, mutateBundle) => {
    const b = await readBundle(fixture('characters/full.vrmxa'));
    const c = closet();
    mutate?.(c);
    setDocument(b, 'closet', c);
    mutateBundle?.(b);
    return codes(await checkBundle(await writeBundle(b)));
  };
  const [top, sword] = base.docs.closet.items;
  assert.deepEqual(await run(), []);
  assert.ok((await run((c) => { c.items.pop(); c.worn.items = [top.id]; c.worn.states = {}; c.outfits = []; c.worn.outfit = null; })).includes('closet.c3'), 'an item file not listed');
  assert.ok((await run(null, (b) => b.entries.delete(sword.file))).includes('closet.c3'), 'a listed file missing');
  assert.ok((await run((c) => { c.worn.items.push('00000000-0000-4000-8000-000000000000'); })).includes('closet.c4'), 'worn lists an unknown item');
  assert.ok((await run((c) => { c.worn.states[sword.id] = 'flying'; })).includes('closet.c5'), 'a state the item does not have');
  assert.ok((await run((c) => { c.worn.outfit = 'nope'; })).includes('closet.c5'), 'worn.outfit names no outfit');
  assert.ok((await run((c) => { c.items[0].base = '0'.repeat(64); })).includes('closet.c2'), 'another base');
  // C7: an animation set brought by an item that is not in the closet
  const b = await readBundle(fixture('characters/full.vrmxa'));
  const a = JSON.parse(JSON.stringify(b.docs.animations));
  a.sets.push({ id: 'brought', name: 'Brought', default: false, priority: 5, requires: ['held:staff'], from: '00000000-0000-4000-8000-00000000abcd', slots: { idle: [{ clip: a.clips[0].sha256 }] } });
  setDocument(b, 'animations', a);
  assert.ok(codes(await checkBundle(await writeBundle(b))).includes('closet.c7'));
});

test('an outfit that lists an item twice breaks the slot rules (C4)', async () => {
  const b = await readBundle(fixture('characters/full.vrmxa'));
  const c = JSON.parse(JSON.stringify(b.docs.closet));
  c.outfits.push({ id: 'o2', name: 'Bad', items: [c.items[0].id, c.items[0].id], states: {} });
  setDocument(b, 'closet', c);
  assert.ok(codes(await checkBundle(await writeBundle(b))).includes('closet.c4'));
});

test('item rules: tags, slot, licence, pin placement, worn skins, animations that need the item\'s tags', async () => {
  const mutateItem = async (file, fn) => {
    const it = await readItem(fixture(`items/${file}.vrmxw`));
    fn(it);
    return codes(await checkItem(await writeItem(it)));
  };
  assert.ok((await mutateItem('pinned-hat', (it) => { it.manifest.tags = ['Hat']; })).includes('item.tag'));
  assert.ok((await mutateItem('pinned-hat', (it) => { it.manifest.type = 'cape'; })).includes('item.type'));
  assert.ok((await mutateItem('pinned-hat', (it) => { delete it.manifest.meta.licenseUrl; })).includes('licence.url'));
  assert.ok((await mutateItem('pinned-hat', (it) => { it.manifest.meta.commercialUsage = 'whatever'; })).includes('licence.value'));
  assert.ok((await mutateItem('pinned-hat', (it) => { it.manifest.attach.bone = 'leftFoot'; })).includes('item.attach'));
  assert.ok((await mutateItem('pinned-hat', (it) => { it.manifest.fit.lift = 0.02; })).includes('item.lift'));
  assert.ok((await mutateItem('state-sword', (it) => { it.manifest.states[1].name = 'held'; })).includes('item.state'));
  assert.ok((await mutateItem('state-sword', (it) => { it.manifest.states[1].bone = 'leftToes'; })).includes('item.state'));
  assert.ok((await mutateItem('animated-staff', (it) => { it.manifest.animations.sets[0].requires = ['held:axe']; })).includes('animations.item-requires'));
  assert.ok((await mutateItem('animated-staff', (it) => { it.manifest.version = 2; })).includes('item.version-newer'));
  // a pinned item whose mesh isn't under its bone
  const hat = await readItem(fixture('items/pinned-hat.vrmxw'));
  const g = parseGlb(hat.entries.get('model.glb'));
  const meshNode = g.json.nodes.findIndex((n) => n.mesh !== undefined);
  for (const n of g.json.nodes) if (n.children) n.children = n.children.filter((c) => c !== meshNode);
  g.json.scenes[0].nodes.push(meshNode);
  hat.entries.set('model.glb', buildGlb(g.json, g.bin));
  assert.ok(codes(await checkItem(await writeItem(hat))).includes('item.pin-place'));
  // a worn item with an unskinned mesh, and a spring joint on a humanoid bone
  const top = await readItem(fixture('items/skinned-top.vrmxw'));
  const t = parseGlb(top.entries.get('model.glb'));
  t.json.extensions.VRMC_springBone.springs[0].joints[0].node = top.manifest.rig.humanBones.upperChest;
  delete t.json.nodes.find((n) => n.mesh !== undefined).skin;
  top.entries.set('model.glb', buildGlb(t.json, t.bin));
  const c = codes(await checkItem(await writeItem(top)));
  assert.ok(c.includes('item.worn-skin') && c.includes('item.spring'), c.join(', '));
});

test('the bind check: a worn item not bound where Spec binds it is caught when spec.vrm is given', { skip: noSpec }, async () => {
  const top = await readItem(fixture('items/skinned-top.vrmxw'));
  assert.deepEqual(codes(await checkItem(await writeItem(top), { spec: specVrm() })), []);
  const g = parseGlb(top.entries.get('model.glb'));
  const ibm = g.json.accessors[g.json.skins[0].inverseBindMatrices];
  const bv = g.json.bufferViews[ibm.bufferView];
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset + (bv.byteOffset || 0));
  dv.setFloat32(13 * 4, dv.getFloat32(13 * 4, true) - 0.0313, true); // the first joint 31.3 mm lower, as Elena's lift
  top.entries.set('model.glb', buildGlb(g.json, g.bin));
  assert.ok(codes(await checkItem(await writeItem(top), { spec: specVrm() })).includes('item.bind'));
});

test('the open form is checked too (names, manifest), without the packed hashes', async () => {
  const b = await readBundle(fixture('characters/minimal.vrmxa'));
  const open = await bundleToEntries(b);
  assert.deepEqual(codes(await checkBundle(open)), []);
  open.set('../x', new Uint8Array(1));
  assert.ok(codes(await checkBundle(open)).includes('zip.entry-name'));
  const it = await itemToEntries(await readItem(fixture('items/pinned-hat.vrmxw')));
  assert.deepEqual(codes(await checkItem(it.entries)), []);
});

test('random damage to every fixture never makes the checker throw', async () => {
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const files = ['items/skinned-top.vrmxw', 'items/state-sword.vrmxw', 'items/animated-staff.vrmxw', 'hostile/control.vrmxa', 'hostile/db-trigger.vrmxa'];
  for (const f of files) {
    const good = fixture(f);
    for (let k = 0; k < 60; k++) {
      const b = good.slice();
      for (let i = 0; i < 1 + (k % 4); i++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const p = f.endsWith('.vrmxw') ? await checkItem(b) : await checkBundle(b);
      assert.ok(Array.isArray(p));
      assert.ok(!p.some((x) => x.code === 'checker.stopped'), `${f} #${k}: ${p.filter((x) => x.code === 'checker.stopped').map((x) => x.message).join('; ')}`);
    }
  }
});

test('decided 2026-11-16: vendor item types (W15), a newer database schema is skipped (D29)', async () => {
  const it = await readItem(fixture('items/pinned-hat.vrmxw'));
  it.manifest.type = 'x-acme.crown';
  const p = await checkItem(await writeItem(it));
  assert.ok(!codes(p).includes('item.type'), 'an x-<vendor>.<name> type naming a slot is allowed');
  assert.ok(codes(p, 'info').includes('item.type-vendor'));
  it.manifest.type = 'x-acme.crown'; it.manifest.slot = 'nowhere';
  assert.ok(codes(await checkItem(await writeItem(it))).includes('item.type'), 'a vendor type must name a slot of §6');

  const b = await readBundle(fixture('characters/full.vrmxa'));
  b.manifest.database.schema = 2;
  b.manifest.sections.persona.version = 2;
  const bytes = await writeBundle(b);
  const q = await checkBundle(bytes);
  assert.deepEqual(codes(q), [], 'not refused');
  assert.ok(codes(q, 'info').includes('db.schema-newer'));
  const r = await readBundle(bytes);
  assert.equal(r.database, null);
  assert.ok(r.skipped.some((s) => s.section === 'persona'));
  assert.ok(r.entries.has(b.manifest.database.file), 'the database is kept');
});

test('a pinned item may be skinned to its own spring chain, never to a humanoid bone (W16)', async () => {
  const withSkin = async (toHumanoid) => {
    const it = await readItem(fixture('items/pinned-hat.vrmxw'));
    const { json, bin } = parseGlb(it.entries.get('model.glb'));
    const meshNode = json.nodes.findIndex((n) => n.mesh !== undefined);
    const prim = json.meshes[json.nodes[meshNode].mesh].primitives[0];
    const count = json.accessors[prim.attributes.POSITION].count;
    let joint;
    if (toHumanoid) joint = it.manifest.rig.humanBones[it.manifest.attach.bone];
    else {
      joint = json.nodes.push({ name: 'dangle' }) - 1;
      (json.nodes[meshNode].children ||= []).push(joint);
      json.extensions ||= {}; json.extensionsUsed = [...new Set([...(json.extensionsUsed || []), 'VRMC_springBone'])];
      json.extensions.VRMC_springBone = { specVersion: '1.0', springs: [{ joints: [{ node: joint }] }] };
    }
    const pad = (n) => (n + 3) & ~3;
    const jOff = pad(bin.length), wOff = pad(jOff + count * 4);
    const out = new Uint8Array(wOff + count * 16);
    out.set(bin);
    const f = new Float32Array(out.buffer, wOff, count * 4);
    for (let i = 0; i < count; i++) f[i * 4] = 1;
    json.buffers[0].byteLength = out.length;
    const jv = json.bufferViews.push({ buffer: 0, byteOffset: jOff, byteLength: count * 4 }) - 1;
    const wv = json.bufferViews.push({ buffer: 0, byteOffset: wOff, byteLength: count * 16 }) - 1;
    prim.attributes.JOINTS_0 = json.accessors.push({ bufferView: jv, componentType: 5121, count, type: 'VEC4' }) - 1;
    prim.attributes.WEIGHTS_0 = json.accessors.push({ bufferView: wv, componentType: 5126, count, type: 'VEC4' }) - 1;
    json.nodes[meshNode].skin = (json.skins ||= []).push({ joints: [joint] }) - 1;
    it.entries.set('model.glb', buildGlb(json, out));
    return codes(await checkItem(await writeItem(it)));
  };
  assert.ok((await withSkin(true)).includes('item.pin-skin'), 'skinned to the head bone');
  assert.ok(!(await withSkin(false)).includes('item.pin-skin'), 'skinned to its own spring bone');
});
