// From the checker's problems to the corrections that fix them: what "Fix these" proposes, and what the
// CLI's `--auto` applies. Each problem names its tool (check.js); this puts the tools in an order that
// keeps them from undoing each other (timing, then facing and the cycle, travel, the floor, then the feet
// on that floor, and speed last)
// and gives the ones that solve on a figure the figure they solve on.

import { checkClip } from './check.js';
import { applyCorrections, figureOf } from './correct.js';

const ORDER = ['speed', 'trim', 'turn', 'loop', 'travel', 'ground', 'pinFoot', 'lockFeet', 'groundSpeed'];

/** Corrections for a check result's problems. → [op] (new ops only; `existing` ops are left as they are). */
export function suggestCorrections(result, { figure = null, details = {}, existing = [] } = {}) {
  const ops = [];
  const has = (kind) => existing.some((o) => o.kind === kind) || ops.some((o) => o.kind === kind);
  const fig = figure ? figureOf(figure) : undefined;
  for (const p of result.problems) {
    const t = p.tool;
    if (!t) continue;
    if (t.kind === 'turn') {
      if (details.loops) continue; // a cycle is turned and restarted by the loop tool
      if (p.id === 'facing-start' && result.problems.some((q) => q.id === 'facing-mean')) continue;
      if (!has('turn')) ops.push({ kind: 'turn', degrees: t.params.degrees });
    } else if (t.kind === 'loop') {
      const at = ops.find((o) => o.kind === 'loop');
      if (at) { Object.assign(at, t.params.startFacing ? { startFacing: true } : {}, t.params.blend ? { blend: Math.max(at.blend || 0, t.params.blend) } : {}); continue; }
      if (has('loop')) continue;
      ops.push({ kind: 'loop', ...(t.params.startFacing ? { startFacing: true } : {}), ...(t.params.blend ? { blend: t.params.blend } : {}) });
    } else if (t.kind === 'pinFoot') ops.push({ kind: 'pinFoot', ...t.params, ...(fig ? { figure: fig } : {}) });
    else if (t.kind === 'lockFeet' || t.kind === 'ground') { if (!has(t.kind)) ops.push({ kind: t.kind, ...t.params, ...(fig ? { figure: fig } : {}) }); }
    else if (!has(t.kind)) ops.push({ kind: t.kind, ...t.params });
  }
  // a facing problem in a loop with nothing else to do still needs the loop tool
  if (details.loops && result.problems.some((p) => p.id === 'facing-mean') && !has('loop')) ops.push({ kind: 'loop', startFacing: true });
  if (details.loops && result.problems.some((p) => p.id === 'facing-mean')) { const l = ops.find((o) => o.kind === 'loop'); if (l) l.startFacing = true; }
  return ops.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/**
 * Check, correct what the checker proposes, and check again (twice at most: a fix can show another
 * problem, as pinning a foot can show a slide). → { ops, before, after, clip, details }
 */
export function autoCorrect(original, { rig, figure = null, details = {}, hints = {}, ops: start = [] } = {}) {
  const before = checkClip(original, { details, rig, figure, hints, corrections: start });
  let ops = [...start];
  let res = applyCorrections(original, ops, { rig, details });
  let after = before;
  for (let round = 0; round < 2; round++) {
    const d = { ...details, ...res.details };
    after = checkClip(res.clip, { details: d, rig, figure, hints, corrections: ops });
    const more = suggestCorrections(after, { figure, details: d, existing: ops });
    if (!more.length) break;
    ops = [...ops, ...more];
    res = applyCorrections(original, ops, { rig, details });
    after = checkClip(res.clip, { details: { ...details, ...res.details }, rig, figure, hints, corrections: ops });
  }
  return { ops, before, after, clip: res.clip, details: { ...details, ...res.details }, notes: res.notes };
}
