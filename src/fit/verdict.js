// A plain verdict on how well a garment transferred by Spec-fit (PRD phase 5; the hook for remaking a garment that
// doesn't transfer, an idea kept for after the MVP): "fits", "fits with warnings" or "does not transfer well", with the reasons and
// the figures they came from. Computed by the library alone, so the importer, the closet and `vrmxa fit` (and a
// batch over a dataset) give the same answer. DOM-free, deterministic.
//
// The thresholds, and the figures they were picked from (PRD §21.4, receipt AB-R-0920):
//   skin through cloth   fail at 0.5 % (FITTING.md §8); warn from 0.1 %. Measured: real garments 0–0.31 % after the
//                        fit, 1.4–8.4 % by bones; test garments 0 %.
//   girth ratio          warn outside 0.6–1.6 (FITTING.md §9); fail outside 0.5–2.0. Measured: VRoid donors 0.9–1.15.
//   clearance pushes     share of the garment's vertices the clearance moved: warn from 10 %, fail from 30 %.
//                        Measured: imports 1.4–3.6 %; a 4 mm top on Bust Size +1 21 % (the body grew under it).
//   ease kept (RMS)      warn from 1 mm (FITTING.md §8), fail from 3 mm. Measured: 0–0.8 mm, Elena's corset 1.2 mm.
//   estimated stations   warn when 25 % or more of the garment sits over stations the source's body didn't have
//                        (skin cut away under clothes): its fit there is an estimate. Elena's coat: upper arms.
//   refused              fail: the source body isn't in a T-pose, or can't be measured (FITTING.md §9).

export const VERDICT = Object.freeze({
  through: { warn: 0.001, fail: 0.005 },
  ratio: { warn: [0.6, 1.6], fail: [0.5, 2.0] },
  pushed: { warn: 0.10, fail: 0.30 },
  easeRms: { warn: 0.001, fail: 0.003 },
  estimated: { warn: 0.25 },
});
export const FITS = 'fits', WARNS = 'fits with warnings', FAILS = 'does not transfer well';

const pct = (x) => `${(x * 100).toFixed(2)} %`;

/**
 * figures: { through (share of covered skin vertices), girthRatios ({ station: ratio }), pushedShare, easeRms (metres),
 * estimatedShare (share of vertices over estimated stations), estimated ([station ids]), refused (reason) } — any may be
 * missing. → { verdict, reasons: [{ level: 'fail' | 'warn', code, text, value }], figures }
 */
export function fitVerdict(figures = {}, T = VERDICT) {
  const reasons = [];
  const add = (level, code, text, value) => reasons.push({ level, code, text, value });
  if (figures.refused) add('fail', 'refused', `Spec-fit can't run: ${figures.refused}`, null);
  const th = figures.through;
  if (Number.isFinite(th)) {
    if (th >= T.through.fail) add('fail', 'skin-through', `skin shows through the cloth at ${pct(th)} of what it covers (the limit is ${pct(T.through.fail)})`, th);
    else if (th >= T.through.warn) add('warn', 'skin-through', `a little skin shows through: ${pct(th)} of what it covers`, th);
  }
  for (const [id, r] of Object.entries(figures.girthRatios || {})) {
    if (r < T.ratio.fail[0] || r > T.ratio.fail[1]) add('fail', 'girth-ratio', `the bodies differ too much at ${id}: ${r.toFixed(2)} times (beyond ${T.ratio.fail.join('–')})`, r);
    else if (r < T.ratio.warn[0] || r > T.ratio.warn[1]) add('warn', 'girth-ratio', `the bodies differ a lot at ${id}: ${r.toFixed(2)} times (beyond ${T.ratio.warn.join('–')}); fitted with the relaxed rule`, r);
  }
  const ps = figures.pushedShare;
  if (Number.isFinite(ps)) {
    if (ps >= T.pushed.fail) add('fail', 'distortion', `the clearance had to move ${pct(ps)} of its vertices`, ps);
    else if (ps >= T.pushed.warn) add('warn', 'distortion', `the clearance moved ${pct(ps)} of its vertices`, ps);
  }
  const er = figures.easeRms;
  if (Number.isFinite(er)) {
    if (er >= T.easeRms.fail) add('fail', 'ease', `its distance from the skin changed by ${(er * 1000).toFixed(2)} mm (RMS)`, er);
    else if (er >= T.easeRms.warn) add('warn', 'ease', `its distance from the skin changed by ${(er * 1000).toFixed(2)} mm (RMS; the aim is under 1 mm)`, er);
  }
  const es = figures.estimatedShare;
  if (Number.isFinite(es) && es >= T.estimated.warn) add('warn', 'estimated', `${pct(es)} of it sits where the source's skin was cut away (${(figures.estimated || []).join(', ') || 'estimated stations'}): fitted from an estimate there`, es);
  const verdict = reasons.some((r) => r.level === 'fail') ? FAILS : reasons.length ? WARNS : FITS;
  return { verdict, reasons, figures: { ...figures } };
}

/** The share of a garment's vertices over stations estimated on the source (from fit coordinates). */
export function estimatedShare(coords) {
  let k = 0;
  for (let i = 0; i < coords.n; i++) if (coords.est[i]) k++;
  return coords.n ? k / coords.n : 0;
}
