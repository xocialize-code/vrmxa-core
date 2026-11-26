// The body's weights under a Spec-fitted garment (FITTING.md §5.6; VRMXW W27; SPEC-QUESTIONS #60): in
// avatar.vrm (and the live view) a Spec-fitted garment's vertices take the weights of the skin under them,
// bust bones included, so the cloth follows the body in a pose; vertices on the item's own bones keep
// theirs; the item file is never changed. The posed figures are printed as diagnostics.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readItem, parseGlb, readAccessor } from '../src/index.js';
import { bodyWeights, NEAR, FAR } from '../src/fit/weights.js';
import { checkWorn } from '../src/fit/checks.js';
import { RELAXED_POSE } from '../src/fit/worn.js';
import { addItem, putOn, drawAvatar, wornPieces, mergeWorn } from '../src/closet/index.js';
import { createBundle } from '../src/vrmxa.js';
import { newEdits, setEdits } from '../src/edit/index.js';
import { specVrm, noSpec, fixture } from './helpers.mjs';
import { specParts, garmentFromSkin } from './fit-helpers.mjs';

const SPEC = noSpec ? null : specVrm();
const P = noSpec ? null : specParts(SPEC);
const pct = (x) => `${(x * 100).toFixed(2)} %`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const FITTED_TOP = fixture('items/fitted-top.vrmxw');

async function wearing(bytes, edits) {
  const b = createBundle({ avatar: SPEC });
  const { id } = await addItem(b, bytes);
  await putOn(b, id);
  if (edits) b.docs.edits = setEdits(newEdits(), Object.entries(edits));
  return { b, id };
}
const bustNodes = (json) => new Set(json.nodes.map((n, i) => (/Bust/i.test(n.name || '') ? i : -1)).filter((i) => i >= 0));

test('avatar.vrm: a Spec-fitted top takes the body\'s weights, bust bones included; the item keeps its own', { skip: noSpec }, async (t) => {
  const item = await readItem(FITTED_TOP);
  const modelBefore = sha(item.entries.get('model.glb'));
  // the item's own weights carry no bust bones (VRMXW §5.3 rule 3)
  const own = parseGlb(item.entries.get('model.glb'));
  const ownBust = bustNodes(own.json);
  for (const node of own.json.nodes) {
    if (node.mesh == null || node.skin == null) continue;
    const skin = own.json.skins[node.skin];
    for (const p of own.json.meshes[node.mesh].primitives) {
      const jn = readAccessor(own.json, own.bin, p.attributes.JOINTS_0), wt = readAccessor(own.json, own.bin, p.attributes.WEIGHTS_0);
      for (let i = 0; i < jn.length; i++) if (wt[i] > 0) assert.ok(!ownBust.has(skin.joints[jn[i]]), 'the item file weights a bust bone');
    }
  }
  const { b, id } = await wearing(FITTED_TOP, { 'body.bustSize': 1 });
  const r = await drawAvatar(b, { spec: SPEC });
  assert.equal(r.methods[id], 'spec-fit');
  // avatar.vrm: the top's vertices weigh on the bust bones now
  const a = parseGlb(r.bytes);
  const bust = bustNodes(a.json);
  assert.ok(bust.size >= 2, 'Spec has bust bones');
  let onBust = 0, total = 0;
  a.json.nodes.forEach((node) => {
    if (node.mesh == null || node.skin == null || !/Fitted/i.test(a.json.meshes[node.mesh].name || node.name || '')) return;
    const skin = a.json.skins[node.skin];
    for (const p of a.json.meshes[node.mesh].primitives) {
      const jn = readAccessor(a.json, a.bin, p.attributes.JOINTS_0), wt = readAccessor(a.json, a.bin, p.attributes.WEIGHTS_0);
      for (let i = 0; i < jn.length; i += 4) {
        total++;
        let s = 0, bw = 0;
        for (let k = 0; k < 4; k++) { s += wt[i + k]; if (bust.has(skin.joints[jn[i + k]])) bw += wt[i + k]; }
        assert.ok(Math.abs(s - 1) < 1e-4, `weights sum to ${s}`);
        if (bw > 0.05) onBust++;
      }
    }
  });
  t.diagnostic(`avatar.vrm: ${onBust} of ${total} vertices of the fitted top weigh 5 % or more on a bust bone`);
  assert.ok(total > 1000 && onBust > 100, `${onBust} of ${total} on the bust`);
  // the item file in the bundle is unchanged, byte for byte
  const after = await readItem(FITTED_TOP);
  assert.equal(sha(after.entries.get('model.glb')), modelBefore);
  const w = await wornPieces(b, { adjust: false });
  assert.equal(sha(w.items[0].item.entries.get('model.glb')), modelBefore);
});

test('in the stage\'s pose the fuller bust stays inside the fitted top with the body\'s weights (#60)', { skip: noSpec }, async (t) => {
  const { b } = await wearing(FITTED_TOP);
  const w = await wornPieces(b, { adjust: false });
  const merged = parseGlb(mergeWorn(SPEC, w));
  const items = w.items.map((x) => ({ id: x.id, manifest: x.item.manifest, fitting: x.entry?.fitting || null }));
  for (const body of [{ bustSize: 1 }, { bustSize: -1 }, {}]) {
    const c = checkWorn(merged.json, merged.bin, items, { body }, { spec: P.spec, pose: RELAXED_POSE });
    const it = c.items.find((x) => x.method === 'spec-fit');
    t.diagnostic(`${JSON.stringify(body)}: posed (relaxed arms) skin through ${pct(it.posedThrough)} with the body's weights, ${pct(it.posedThroughOwn)} with its own; at rest ${pct(it.through)}; weights ${JSON.stringify(it.weights)}`);
    assert.ok(it.posedThrough < 0.005, `posed ${pct(it.posedThrough)}`);
    if (body.bustSize === 1) assert.ok(it.posedThroughOwn > 0.02, `with its own weights only ${pct(it.posedThroughOwn)} (the case #60 fixes)`);
  }
});

test('bodyWeights: the item\'s own bones keep their weights; far cloth blends toward its own; the four largest, normalised', { skip: noSpec }, () => {
  const g = garmentFromSkin(P, { labels: ['torso'], y: [0.95, 1.2], offset: 0.004 });
  const n = g.n;
  // three vertices: one on an item's own bone (a node no body joint uses), one 5 cm out, one 12 cm out
  const OWN = 99999;
  const pos = Float32Array.from(g.pos);
  const N = g.normals;
  g.nodes[0] = OWN; g.weights[0] = 0.3;
  for (let a = 0; a < 3; a++) { pos[3 + a] += N[3 + a] * 0.046; pos[6 + a] += N[6 + a] * 0.116; }
  const r = bodyWeights(P.spec.skin, P.spec.body.skin, pos, g);
  assert.equal(r.taken + r.blended + r.kept, n);
  for (let k = 0; k < 4; k++) { assert.equal(r.nodes[k], g.nodes[k]); assert.equal(r.weights[k], g.weights[k]); }
  assert.ok(r.kept >= 1 && r.blended >= 1, JSON.stringify({ kept: r.kept, blended: r.blended }));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) { s += r.weights[i * 4 + k]; if (k) assert.ok(r.weights[i * 4 + k] <= r.weights[i * 4 + k - 1] + 1e-7 || i === 0); }
    assert.ok(Math.abs(s - 1) < 1e-5 || i === 0, `vertex ${i} sums to ${s}`);
  }
  // 12 cm out (beyond FAR): its own weights
  assert.ok(0.116 > FAR && 0.046 > NEAR && 0.046 < FAR);
  for (let k = 0; k < 4; k++) assert.equal(r.weights[8 + k], g.weights[8 + k]);
  // the bust bones appear (the garment's own weights folded them into the chest)
  const json = P.parsed.json;
  const bust = new Set(json.nodes.map((nd, i) => (/Bust/i.test(nd.name || '') ? i : -1)).filter((i) => i >= 0));
  let onBust = 0;
  for (let i = 0; i < n * 4; i++) if (bust.has(r.nodes[i]) && r.weights[i] > 0.05) onBust++;
  assert.ok(onBust > 0);
  // deterministic
  const again = bodyWeights(P.spec.skin, P.spec.body.skin, pos, g);
  assert.deepEqual([...again.nodes], [...r.nodes]);
  assert.deepEqual([...again.weights], [...r.weights]);
});
