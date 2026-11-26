// How well each garment of a dressed VRM would transfer onto Spec by Spec-fit (fit/verdict.js), from the file
// alone: no decisions, no writing. The importer's first grouping is used as it stands, so a run over many files
// (a dataset survey) is deterministic: the same file gives the same report. DOM-free.

import { openSource } from './source.js';
import { importRigs, groupModel, comesBySpecFit } from './session.js';

const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

/**
 * source: the VRM's bytes; spec: spec.vrm's bytes. opts: { fileName }.
 * → { file, sha256, vrm, lift, estimated, garments: [{ group, name, type, slot, pieces, method, verdict, reasons,
 *     figures, ms, vertices, pushed }], others: [{ group, name, type, slot }] (not fitted by Spec-fit), ms }
 */
export async function sourceVerdicts(source, spec, { fileName = 'model.vrm' } = {}) {
  const t0 = Date.now();
  const src = await openSource(source, { fileName });
  const rigs = importRigs(src, spec);
  const garments = [], others = [];
  for (const g of src.groups) {
    const base = { group: g.id, name: g.name, type: g.type, slot: g.slot };
    if (g.kind === 'pin' || !comesBySpecFit(g)) { others.push(base); continue; }
    const m = groupModel(src, g, rigs);
    const v = m.verdict;
    const figures = v ? Object.fromEntries(Object.entries(v.figures).map(([k, x]) => [k, typeof x === 'number' ? r4(x) : x])) : null;
    garments.push({ ...base, pieces: g.pieces.length, method: m.fit, verdict: v?.verdict ?? null, reasons: v?.reasons.map((r) => ({ ...r, value: r4(r.value) })) ?? [], figures, ms: m.fitStats?.ms ?? null, vertices: m.fitStats?.vertices ?? null, pushed: m.fitStats?.pushed ?? null, ...(m.fitWhy ? { why: m.fitWhy } : {}) });
  }
  return { file: src.file, sha256: src.sha256, vrm: src.vrm, lift: rigs.lift.lift, estimated: rigs.fit?.donor?.estimated || [], garments, others, ms: Date.now() - t0 };
}
