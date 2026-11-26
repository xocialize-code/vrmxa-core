// FITTING.md §8's checks on what a character wears (PRD FIT-5): Spec-fit run on the merged model for some
// body edits, and per Spec-fitted item the figures — skin through cloth (against the skin the item covers
// on Spec, vertex for vertex, since a body made on the Body page is Spec's mesh moved), the same by the
// bones for comparison, ease kept, hems kept, time. For the CLI (`vrmxa fit`) and the app's probe.

import { BODY_SLIDERS } from '../edit/body.js';
import { fitWorn, posedSkinning, skinPositions, RELAXED_POSE } from './worn.js';
import { skinCover, skinThrough, makeSurface } from './specFit.js';

const surf = (pos, tris) => makeSurface(pos, tris, { cell: 0.02 });
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

/**
 * json, bin: the merged model; items: [{ id, manifest, fitting }]; edits: { body, bones, lift };
 * opts: { spec, cache, covered (from an earlier call, reused), pose (null, or { humanoid bone: z radians }, e.g.
 * RELAXED_POSE: skin through cloth also in that pose, with the body's weights and with the item's own), weights
 * (false: the items keep their own weights, fitWorn) }.
 * → { identity, ms, msMeasure, estimated, refused, items: [{ id, name, method, rule, ms, vertices, pushed,
 *     through, throughBones, uncovered, easeRms, hemsMm, hemsDs, warnings, refused?, posedThrough?, posedThroughOwn? }], covered }
 */
export function checkWorn(json, bin, items, edits, { spec, cache = new Map(), covered = null, pose = null, weights = true } = {}) {
  // what each item covers on Spec (its own skin, before any edit)
  if (!covered) {
    const base = fitWorn(json, bin, items, {}, { spec, cache });
    covered = new Map(base.items.filter((x) => x.fitted).map((x) => [x.id, skinCover(spec, [surf(x.fitted.pos, x.fitted.tris)])]));
  }
  const r = fitWorn(json, bin, items, edits, { spec, cache, checks: true, verdict: true, weights });
  const name = (id) => items.find((i) => i.id === id)?.manifest?.name || id;
  const posed = pose ? posedWorn(json, r, spec, { pose, covered }) : null;
  const out = {
    identity: r.identity, ms: r4(r.ms), msMeasure: r4(r.msMeasure ?? 0), estimated: r.target?.estimated || [], refused: r.target?.refused || null, covered,
    items: r.items.map((it) => {
      const row = { id: it.id, name: name(it.id), method: it.method, ...(it.rule ? { rule: it.rule } : {}), ...(it.refused ? { refused: it.refused } : {}) };
      if (!it.fitted) return row;
      Object.assign(row, { ms: r4(it.stats?.ms), vertices: it.stats?.vertices ?? null, pushed: it.stats?.pushed ?? 0, warnings: it.stats?.warnings || [], verdict: it.verdict?.verdict ?? null, reasons: it.verdict?.reasons || [], figures: it.verdict?.figures || null, ...(it.weights ? { weights: it.weights } : {}) });
      const cov = covered.get(it.id);
      if (cov && !r.identity) {
        const sf = skinThrough(r.target, [surf(it.fitted.pos, it.fitted.tris)], { covered: cov });
        const bo = it.bones ? skinThrough(r.target, [surf(it.bones, it.fitted.tris)], { covered: cov }) : null;
        Object.assign(row, {
          covered: sf.covered, through: r4(sf.share), throughCount: sf.through, uncovered: r4(sf.uncoveredShare), throughBones: bo ? r4(bo.share) : null,
          easeRms: r4(it.checks?.ease?.rms), hemsMm: it.checks ? Math.round(it.checks.hems.maxM * 1e5) / 100 : null, hemsDs: r4(it.checks?.hems?.max),
        });
      } else if (r.identity) Object.assign(row, { through: 0, throughBones: 0, easeRms: 0, hemsMm: 0, hemsDs: 0, covered: cov ? cov.reduce((a, b) => a + b, 0) : null });
      const ps = posed?.get(it.id);
      if (ps) Object.assign(row, { posedThrough: r4(ps.body), posedThroughOwn: r4(ps.own) });
      return row;
    }),
  };
  return out;
}

/**
 * Skin through cloth in a pose (FITTING.md §5.6, SPEC-QUESTIONS #60): the fitted body and each Spec-fitted
 * garment of a fitWorn result (made with `checks`) skinned in the pose, the garment once with the body's
 * weights under it and once with its own. covered: Map(item id → mask on Spec). → Map(id → { body, own })
 */
export function posedWorn(json, result, spec, { pose = RELAXED_POSE, covered } = {}) {
  const sk = result.skinning;
  const out = new Map();
  if (!sk) return out;
  const Kof = posedSkinning(json, sk, pose);
  const base = spec.body;
  const ctx = { skin: makeSurface(skinPositions(Kof, base.verts, base.skin.node, base.skin.weight), spec.skin.tris, { cell: 0.01 }) };
  for (const it of result.items) {
    const b = it.bind, cov = covered?.get(it.id);
    if (!b || !cov) continue;
    const own = skinThrough(ctx, [surf(skinPositions(Kof, b.own, b.ownSkin.nodes, b.ownSkin.weights), b.tris)], { covered: cov }).share;
    const body = b.bodySkin ? skinThrough(ctx, [surf(skinPositions(Kof, b.pre, b.bodySkin.nodes, b.bodySkin.weights), b.tris)], { covered: cov }).share : own;
    out.set(it.id, { body, own });
  }
  return out;
}

/**
 * Every Body slider at −1 and +1 (FITTING.md §8), with the worst of each figure per item; with `pose`, skin
 * through in that pose too (posedWorn). → { rows, worst }
 */
export function sweepWorn(json, bin, items, { spec, cache = new Map(), bones = {}, pose = null, weights = true } = {}) {
  let covered = null;
  const rows = [];
  for (const key of Object.keys(BODY_SLIDERS)) for (const v of [-1, 1]) {
    const c = checkWorn(json, bin, items, { body: { [key]: v }, bones }, { spec, cache, covered, pose, weights });
    covered = c.covered;
    rows.push({ slider: key, value: v, items: c.items.filter((x) => x.through != null).map(({ id, name, through, throughBones, uncovered, easeRms, hemsMm, ms, pushed, posedThrough, posedThroughOwn }) => ({ id, name, through, throughBones, uncovered, easeRms, hemsMm, ms, pushed, ...(pose ? { posedThrough, posedThroughOwn } : {}) })) });
  }
  const worst = {};
  for (const row of rows) for (const it of row.items) {
    const w = worst[it.id] ||= { name: it.name, through: 0, throughAt: null, throughBones: 0, easeRms: 0, hemsMm: 0, ms: 0, ...(pose ? { posedThrough: 0, posedThroughAt: null, posedThroughOwn: 0 } : {}) };
    if (pose) {
      if ((it.posedThrough ?? 0) > w.posedThrough) { w.posedThrough = it.posedThrough; w.posedThroughAt = `${row.slider} ${row.value > 0 ? '+1' : '−1'}`; }
      w.posedThroughOwn = Math.max(w.posedThroughOwn, it.posedThroughOwn ?? 0);
    }
    if (it.through > w.through) { w.through = it.through; w.throughAt = `${row.slider} ${row.value > 0 ? '+1' : '−1'}`; }
    w.throughBones = Math.max(w.throughBones, it.throughBones ?? 0);
    w.easeRms = Math.max(w.easeRms, it.easeRms ?? 0);
    w.hemsMm = Math.max(w.hemsMm, it.hemsMm ?? 0);
    w.ms = Math.max(w.ms, it.ms ?? 0);
  }
  return { rows, worst };
}
