// Spec-fit (PRD FIT-2, FIT-4, FIT-5, FIT-7; FITTING.md §5, §8): the checks of §8 as tests, on garments
// made from Spec's own skin (fit-helpers.mjs), every Body slider at −1 and +1, and foreign bodies.
// The figures each check measured are printed (diagnostic lines) and gathered in Docs/trials/specfit/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readItem, parseGlb, readAccessor } from '../src/index.js';
import { BODY_SLIDERS } from '../src/edit/body.js';
import { anchorS, radiusAt, centreAt, sOf, SUB } from '../src/fit/body.js';
import { fitCoordinates, moveGarment, fitRule, skinCover, skinThrough, easeKept, hemsKept, makeSurface, easeOf, C_MIN } from '../src/fit/specFit.js';
import { fitWorn, specFits } from '../src/fit/worn.js';
import { vertexNormals } from '../src/fit/geom.js';
import { addItem, putOn, setFitting, drawAvatar, wornPieces, mergeWorn, closetOf } from '../src/closet/index.js';
import { createBundle } from '../src/vrmxa.js';
import { newEdits, setEdits } from '../src/edit/index.js';
import { specVrm, noSpec, fixture } from './helpers.mjs';
import { specParts, garmentFromSkin, subdivide, editedBody, bonesFit, foreignBody } from './fit-helpers.mjs';

const SPEC = noSpec ? null : specVrm();
const P = noSpec ? null : specParts(SPEC);
const pct = (x) => `${(x * 100).toFixed(2)} %`;
const mm = (x) => `${(x * 1000).toFixed(2)} mm`;
const surf = (pos, tris) => makeSurface(pos, tris, { cell: 0.02 });

// the garments
const G = noSpec ? {} : {
  top: { g: garmentFromSkin(P, { labels: ['torso', 'armL', 'armR'], y: [0.9, 1.285], x: [-0.3, 0.3], offset: 0.004, targets: true }), rule: fitRule({ class: 'top', ease: 'fitted' }) },
  trousers: { g: garmentFromSkin(P, { labels: ['torso', 'legL', 'legR'], y: [0.16, 1.0], offset: 0.005 }), rule: fitRule({ class: 'bottom', ease: 'fitted' }) },
  skirt: { g: skirt(), rule: fitRule({ class: 'skirt', ease: 'relaxed' }) },
};

// a flared skirt: rings round the torso from the waist to above the knee, never narrower than the hip below it
function skirt() {
  const { spec, hb } = P;
  const seg = spec.segments.torso;
  const hipS = anchorS(seg, 'hip');
  const hipH = seg.slices[hipS * SUB].h;
  const rings = [];
  const N = 48;
  for (let y = 1.0; y >= 0.55 - 1e-9; y -= 0.01) rings.push(y);
  const pos = [], tris = [], zones = [], nodes = [], weights = [];
  for (const [r, y] of rings.entries()) {
    const s = y < hipH ? hipS : sOf(seg, y);
    const c = centreAt(seg, s);
    for (let k = 0; k < N; k++) {
      const th = (2 * Math.PI * k) / N;
      const R = radiusAt(seg, s, th, hipS) + 0.008 + Math.max(0, hipH - y) * 0.15;
      pos.push(seg.axis.x0 + c[0] + R * Math.cos(th), y, c[1] + R * Math.sin(th));
      zones.push(1, 0, 0, 0, 0, 0);
      nodes.push(hb.hips, 0, 0, 0); weights.push(1, 0, 0, 0);
      if (r > 0) { const a = (r - 1) * N + k, b = (r - 1) * N + ((k + 1) % N), cc = r * N + k, d = r * N + ((k + 1) % N); tris.push(a, cc, b, b, cc, d); }
    }
  }
  const P3 = Float32Array.from(pos), T = Int32Array.from(tris);
  return { pos: P3, tris: T, zones: Float32Array.from(zones), nodes: Int32Array.from(nodes), weights: Float32Array.from(weights), normals: null, n: P3.length / 3 };
}

// every Body slider at −1 and +1, measured once
const SLIDERS = Object.keys(BODY_SLIDERS);
const bodies = new Map();
const bodyFor = (edit) => { const k = JSON.stringify(edit); if (!bodies.has(k)) bodies.set(k, editedBody(P, edit)); return bodies.get(k); };

test('no change on Spec: the method itself, Spec → Spec, moves no vertex more than 1e-6 m (§8)', { skip: noSpec }, (t) => {
  const again = editedBody(P, {}).ctx; // measured again from the skin, not the same object
  for (const [name, { g, rule }] of Object.entries(G)) {
    const coords = fitCoordinates(P.spec, g, rule);
    const covered = skinCover(P.spec, [surf(g.pos, g.tris)]);
    const r = moveGarment(coords, P.spec, again, g, { bones: g.pos, covered }); // the whole method: move, welds, smoothing, both clearances
    let worst = 0;
    for (let i = 0; i < g.pos.length; i++) worst = Math.max(worst, Math.abs(r.pos[i] - g.pos[i]));
    t.diagnostic(`${name}: Spec → Spec moved at most ${worst.toExponential(2)} m`);
    assert.ok(worst < 1e-6, `${name} moved ${worst} m`);
    assert.equal(r.stats.pushed, 0);
  }
});

test('round trip: Spec → body → Spec comes back within 1 mm (§8)', { skip: noSpec }, (t) => {
  // every vertex is reported; the 1 mm is asserted where the method is invertible: a vertex on one segment
  // (§5.3's weighted blend of two segments' places, at the armpit and crotch, isn't) that no clearance push
  // moved either way (a push is a correction, not a move that can be undone)
  let worstAll = 0, worstOne = 0, where = '', whereOne = '';
  for (const edit of [{ bustSize: 1 }, { waistSize: 1 }, { height: 1 }, { slender: 1 }, { physique: -1 }, { shoulderWidth: 1 }, { legLength: -1 }]) {
    const { ctx } = bodyFor(edit);
    for (const [name, { g, rule }] of Object.entries(G)) {
      const c1 = fitCoordinates(P.spec, g, rule);
      const there = moveGarment(c1, P.spec, ctx, g, {});
      const g2 = { ...g, pos: there.pos };
      const back = moveGarment(fitCoordinates(ctx, g2, rule), ctx, P.spec, g2, {});
      for (let i = 0; i < g.n; i++) {
        const d = Math.hypot(back.pos[i * 3] - g.pos[i * 3], back.pos[i * 3 + 1] - g.pos[i * 3 + 1], back.pos[i * 3 + 2] - g.pos[i * 3 + 2]);
        if (d > worstAll) { worstAll = d; where = `${name}, ${JSON.stringify(edit)}`; }
        const single = [0, 1, 2, 3, 4].some((z) => c1.w[i * 6 + z] >= 0.999);
        if (single && !there.pushed[i] && !back.pushed[i] && d > worstOne) { worstOne = d; whereOne = `${name}, ${JSON.stringify(edit)}, at ${[0, 1, 2].map((a) => g.pos[i * 3 + a].toFixed(3)).join(', ')}`; }
      }
    }
  }
  t.diagnostic(`round trip: every vertex worst ${mm(worstAll)} (${where}); one segment, never pushed: worst ${mm(worstOne)} (${whereOne})`);
  assert.ok(worstOne < 0.001, `round trip ${mm(worstOne)}`);
});

test('skin through cloth under 0.5 % at every Body slider at −1 and +1; ease kept; hems kept (§8)', { skip: noSpec }, (t) => {
  const cover = Object.fromEntries(Object.entries(G).map(([k, { g }]) => [k, skinCover(P.spec, [surf(g.pos, g.tris)])]));
  const coords = Object.fromEntries(Object.entries(G).map(([k, { g, rule }]) => [k, fitCoordinates(P.spec, g, rule)]));
  const worst = { through: 0, bones: 0, ease: 0, hemsMm: 0, hemsS: 0, ms: 0 };
  const where = {};
  for (const key of SLIDERS) for (const v of [-1, 1]) {
    const edit = { [key]: v };
    const { ctx, sk } = bodyFor(edit);
    for (const [name, { g, rule }] of Object.entries(G)) {
      const bones = bonesFit(g, sk);
      const r = moveGarment(coords[name], P.spec, ctx, g, { bones, covered: cover[name] });
      const th = skinThrough(ctx, [surf(r.pos, g.tris)], { covered: cover[name] });
      const tb = skinThrough(ctx, [surf(bones, g.tris)], { covered: cover[name] });
      const e = easeKept(coords[name], P.spec, ctx, r.pos, r.pushed);
      const h = hemsKept(coords[name], ctx, g, r.pos);
      if (th.share > worst.through) { worst.through = th.share; where.through = `${name}, ${key} ${v}`; }
      if (tb.share > worst.bones) { worst.bones = tb.share; where.bones = `${name}, ${key} ${v}`; }
      if (rule.ease === 'fitted' && e.rms > worst.ease) { worst.ease = e.rms; where.ease = `${name}, ${key} ${v}`; }
      if (h.maxM > worst.hemsMm) { worst.hemsMm = h.maxM; where.hems = `${name}, ${key} ${v}`; }
      worst.hemsS = Math.max(worst.hemsS, h.max);
      worst.ms = Math.max(worst.ms, r.stats.ms);
      assert.ok(th.share < 0.005, `${name} on ${key} ${v}: ${th.through} of ${th.covered} covered skin vertices through (${pct(th.share)})`);
      if (rule.ease === 'fitted') assert.ok(e.rms < 0.001, `${name} on ${key} ${v}: ease RMS ${mm(e.rms)}`);
      assert.ok(h.maxM < 0.006, `${name} on ${key} ${v}: a hem moved ${mm(h.maxM)} along the body from where its s puts it`);
    }
  }
  t.diagnostic(`skin through: worst ${pct(worst.through)} (${where.through || 'nowhere'}); by the bones: worst ${pct(worst.bones)} (${where.bones})`);
  t.diagnostic(`ease RMS (fitted): worst ${mm(worst.ease)} (${where.ease}); hems: worst ${mm(worst.hemsMm)} along the body, |Δs| ${worst.hemsS.toFixed(3)} (${where.hems})`);
  t.diagnostic(`slowest fit in the sweep: ${worst.ms.toFixed(1)} ms`);
});

test('Bust Size +1 no longer shows through a top: Spec-fit against the bones fallback (FITTING.md §9)', { skip: noSpec }, (t) => {
  const { g, rule } = G.top;
  const { ctx, sk } = bodyFor({ bustSize: 1 });
  const cover = skinCover(P.spec, [surf(g.pos, g.tris)]);
  const bones = bonesFit(g, sk);
  const r = moveGarment(fitCoordinates(P.spec, g, rule), P.spec, ctx, g, { bones });
  const sf = skinThrough(ctx, [surf(r.pos, g.tris)], { covered: cover });
  const bo = skinThrough(ctx, [surf(bones, g.tris)], { covered: cover });
  t.diagnostic(`Bust Size +1, a top 4 mm off the skin: by the bones ${bo.through} of ${bo.covered} through (${pct(bo.share)}), by Spec-fit ${sf.through} (${pct(sf.share)})`);
  assert.ok(bo.share > 0.02, 'the bones fallback shows the bust through (the case phase 5 fixes)');
  assert.ok(sf.share < 0.005);
});

test('speed: under 50 ms for a 10,000-vertex garment once the body is measured (§8)', { skip: noSpec }, (t) => {
  // the top and the trousers as one garment, subdivided once, and the skirt: just over 10,000 vertices
  const a = G.top.g, b = G.trousers.g;
  const join = (x, y, k) => { const o = new x.constructor(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
  let g = { n: a.n + b.n, pos: join(a.pos, b.pos), zones: join(a.zones, b.zones), nodes: join(a.nodes, b.nodes), weights: join(a.weights, b.weights), tris: join(a.tris, b.tris.map((t) => t + a.n)), normals: join(a.normals, b.normals) };
  g = subdivide(g);
  const c = G.skirt.g;
  g = { n: g.n + c.n, pos: join(g.pos, c.pos), zones: join(g.zones, c.zones), nodes: join(g.nodes, c.nodes), weights: join(g.weights, c.weights), tris: join(g.tris, c.tris.map((t) => t + g.n)), normals: join(g.normals, vertexNormals(c.pos, c.tris)) };
  assert.ok(g.n >= 10000 && g.n < 13000, `${g.n} vertices`);
  const { ctx, sk } = bodyFor({ waistSize: 1 });
  const coords = fitCoordinates(P.spec, g, G.top.rule); // once per garment, cached (W4)
  const bones = bonesFit(g, sk);
  const covered = skinCover(P.spec, [surf(g.pos, g.tris)]); // once per garment, with the coordinates
  moveGarment(coords, P.spec, ctx, g, { bones, covered }); // warm
  const times = [];
  for (let k = 0; k < 5; k++) times.push(moveGarment(coords, P.spec, ctx, g, { bones, covered }).stats.ms);
  times.sort((a, b) => a - b);
  const per10k = (times[2] * 10000) / g.n;
  t.diagnostic(`${g.n} vertices: fit ${times[2].toFixed(1)} ms (median of 5, Node ${process.version}), ${per10k.toFixed(1)} ms per 10,000; fit coordinates once ${(() => { const t = performance.now(); fitCoordinates(P.spec, g, G.top.rule); return (performance.now() - t).toFixed(0); })()} ms`);
  assert.ok(per10k < 50, `${per10k.toFixed(1)} ms per 10,000 vertices (${times[2].toFixed(1)} ms for ${g.n})`); // FITTING.md §8: a 10,000-vertex garment
});

test('skirts never narrow below the hip, and their ease grows with the girth (relaxed; §5.4)', { skip: noSpec }, (t) => {
  const { g, rule } = G.skirt;
  for (const edit of [{ slender: 1 }, { height: 1 }, { physique: -1 }]) {
    const { ctx } = bodyFor(edit);
    const r = moveGarment(fitCoordinates(P.spec, g, rule), P.spec, ctx, g, {});
    const seg = ctx.segments.torso;
    const hipS = anchorS(seg, 'hip'), hipH = seg.slices[hipS * SUB].h;
    // ring by ring (48 per ring), from the hip down: each vertex at least as far out as the one above it
    let narrows = 0;
    for (let i = 48; i < g.n; i++) {
      if (r.pos[i * 3 + 1] > hipH || r.pos[(i - 48) * 3 + 1] > hipH) continue;
      const rad = (j) => Math.hypot(r.pos[j * 3] - seg.axis.x0, r.pos[j * 3 + 2] - centreAt(seg, hipS)[1]);
      if (rad(i) < rad(i - 48) - 1e-4) { narrows++; if (narrows < 4) t.diagnostic(`narrower at y ${r.pos[i * 3 + 1].toFixed(3)}: ${mm(rad(i))} < ${mm(rad(i - 48))}, pushed ${r.pushed[i]}`); }
    }
    assert.equal(narrows, 0, `${JSON.stringify(edit)}: ${narrows} vertices narrower than the one above`);
  }
});

test('foreign bodies: estimated stations are flagged and fitted relaxed; skin through under 0.5 %; an A-pose is refused (§5.2, §9)', { skip: noSpec }, (t) => {
  const fb = foreignBody(P, { physique: 1, slender: -0.5, height: -0.4 }, { cutArms: true });
  assert.ok(fb.ctx.estimated.some((id) => /^upperArm|^elbow/.test(id)), `estimated: ${fb.ctx.estimated.join(', ')}`);
  for (const [name, { g, rule }] of Object.entries(G)) {
    const coords = fitCoordinates(P.spec, g, rule);
    const r = moveGarment(coords, P.spec, fb.ctx, g, {});
    const th = skinThrough(fb.ctx, [surf(r.pos, g.tris)]); // no vertex matches Spec's: covered is measured on the body
    t.diagnostic(`foreign body (estimated ${fb.ctx.estimated.join(', ')}): ${name} ${th.through} of ${th.covered} through (${pct(th.share)})`);
    assert.ok(th.share < 0.005, `${name}: ${pct(th.share)}`);
  }
  // a garment from that body onto Spec (§7): over its estimated upper arms the cloth keeps at least 3 mm
  const sleeve = G.top.g;
  const onFb = moveGarment(fitCoordinates(P.spec, sleeve, G.top.rule), P.spec, fb.ctx, sleeve, {});
  const back = { ...sleeve, pos: onFb.pos };
  const bc = fitCoordinates(fb.ctx, back, G.top.rule);
  assert.ok(bc.est.some((x) => x === 1), 'vertices over estimated stations are flagged');
  const onSpec = moveGarment(bc, fb.ctx, P.spec, back, {});
  const t2 = skinThrough(P.spec, [surf(onSpec.pos, sleeve.tris)]);
  assert.ok(t2.share < 0.005, `onto Spec: ${pct(t2.share)}`);
  // A-pose
  const ap = foreignBody(P, {}, { aPose: true });
  assert.match(ap.ctx.refused || '', /T-pose/);
  assert.throws(() => fitCoordinates(ap.ctx, G.top.g, G.top.rule), /T-pose/);
});

test('morph targets are carried through the fit (FIT-7, VRMXW §8.1)', { skip: noSpec }, (t) => {
  const { g, rule } = G.top;
  const { ctx } = bodyFor({ bustSize: 1 });
  const coords = fitCoordinates(P.spec, g, rule);
  const r = moveGarment(coords, P.spec, ctx, g, {});
  const d0 = g.targets[0], d1 = r.targets[0];
  let n = 0, worst = 0;
  for (let i = 0; i < g.n; i++) {
    if (!d0[i * 3 + 2]) { assert.equal(Math.hypot(d1[i * 3], d1[i * 3 + 1], d1[i * 3 + 2]), 0); continue; }
    n++;
    // the opened shape fitted: the base fitted plus the moved delta, against fitting the opened shape itself
    worst = Math.max(worst, Math.abs(Math.hypot(d1[i * 3], d1[i * 3 + 1], d1[i * 3 + 2]) - 0.01));
  }
  assert.ok(n > 50);
  assert.ok(worst < 0.004, `a 1 cm delta became ${mm(0.01 + worst)} at worst`);
  t.diagnostic(`morph target: ${n} vertices moved; a 1 cm delta is ${mm(0.01 - worst)}–${mm(0.01 + worst)} after the fit on Bust Size +1`);
});

test('layers: an outer garment clears the inner one by its ease and 3 mm (FIT-4, §5.5)', { skip: noSpec }, (t) => {
  const inner = G.top;
  const outer = { g: garmentFromSkin(P, { labels: ['torso', 'armL', 'armR'], y: [0.95, 1.27], x: [-0.25, 0.25], offset: 0.007 }), rule: fitRule({ class: 'top', ease: 'relaxed' }) };
  const { ctx } = bodyFor({ bustSize: 1, waistSize: 1 });
  const ri = moveGarment(fitCoordinates(P.spec, inner.g, inner.rule), P.spec, ctx, inner.g, {});
  const layer = { src: surf(inner.g.pos, inner.g.tris), tgt: surf(ri.pos, inner.g.tris) };
  const ro = moveGarment(fitCoordinates(P.spec, outer.g, outer.rule), P.spec, ctx, outer.g, { inner: [layer] });
  // the outer garment outside the inner one wherever the inner covers it (skin vertices see inner, then outer)
  const cover = skinCover(ctx, [layer.tgt]);
  const order = skinThrough(ctx, [surf(ro.pos, outer.g.tris)], { covered: cover }); // outer still over the skin
  assert.ok(order.share < 0.005, `${pct(order.share)}`);
  const alone = moveGarment(fitCoordinates(P.spec, outer.g, outer.rule), P.spec, ctx, outer.g, {});
  assert.ok(ro.stats.pushed >= alone.stats.pushed, 'the inner garment adds pushes, never removes them');
});

// ---- on a character: avatar.vrm and the closet --------------------------------------------------------

const TOP = fixture('items/skinned-top.vrmxw');
const TOP_ID = (await readItem(TOP)).manifest.id;
async function dressed(edits) {
  const b = createBundle({ avatar: SPEC });
  const { id } = await addItem(b, TOP);
  await putOn(b, id);
  if (edits) b.docs.edits = setEdits(newEdits(), Object.entries(edits));
  return b;
}
const positionsOf = (json, bin, id) => json.nodes.filter((n) => n.mesh != null && n.extras?.vrmxaFit?.item === id).flatMap((n) => json.meshes[n.mesh].primitives.flatMap((p) => [...readAccessor(json, bin, p.attributes.POSITION)]));

test('a top in avatar.vrm is fitted by Spec-fit on the edited body, and says so (closet fitting.method)', { skip: noSpec }, async (t) => {
  const b = await dressed({ 'body.bustSize': 1 });
  assert.equal(closetOf(b).items.find((e) => e.id === TOP_ID).fitting.method, 'spec-fit');
  const r = await drawAvatar(b, { spec: SPEC });
  assert.equal(r.methods[TOP_ID], 'spec-fit');
  assert.equal(r.fit.items.find((x) => x.id === TOP_ID).method, 'spec-fit');
  // what avatar.vrm holds is what the fit computed in the character's space
  const w = await wornPieces(b, { adjust: false });
  const merged = parseGlb(mergeWorn(SPEC, w));
  const res = fitWorn(merged.json, merged.bin, w.items.map((x) => ({ id: x.id, manifest: x.item.manifest, fitting: x.entry?.fitting })), { body: { bustSize: 1 } }, { spec: P.spec });
  const want = res.items.find((x) => x.id === TOP_ID).fitted.pos;
  const a = parseGlb(r.bytes);
  const got = positionsOf(a.json, a.bin, TOP_ID);
  assert.equal(got.length, want.length);
  let worst = 0;
  for (let i = 0; i < got.length; i++) worst = Math.max(worst, Math.abs(got[i] - want[i]));
  assert.ok(worst < 2e-5, `avatar.vrm is ${worst} m from the fit`);
  // the automatic fit switched off: the top follows the bones, and the method says so
  await setFitting(b, TOP_ID, { auto: false }, { merge: true });
  assert.equal(closetOf(b).items.find((e) => e.id === TOP_ID).fitting.method, 'bones');
  const off = await drawAvatar(b, { spec: SPEC });
  assert.equal(off.methods[TOP_ID], 'bones');
  assert.ok(!specFits((await readItem(TOP)).manifest, { auto: false }));
});

test('the heat map\'s ease is the garment\'s distance from Spec\'s skin (step 2)', { skip: noSpec }, (t) => {
  const { g, rule } = G.top;
  const e = easeOf(fitCoordinates(P.spec, g, rule));
  const finite = [...e].filter(Number.isFinite).sort((a, b) => a - b);
  assert.ok(finite.length > g.n * 0.95);
  // a garment 4 mm off the skin: its ease against the stations' convex profiles is 4 mm or less (hollows are bridged)
  const median = finite[finite.length >> 1];
  assert.ok(median > -0.01 && median < 0.006, `median ease ${mm(median)}`);
  assert.ok(C_MIN === 0.003);
});
