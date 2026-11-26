// Is a VRM a good candidate for testing in VRMXA Avatar Studio: would its pieces come into the closet, onto Spec?
// Advice for a person choosing files (the Quick Look 3D preview shows it beside the model), in plain words, each check
// with its reason, and a one-line verdict. It decides nothing: the importer still asks about every piece.
//
// Everything here is the importer's own judgement, not a second one: openSource (the VRM 0.x conversion, the pieces and
// their proposed groups, the licence), the donor body's fitting context (FITTING.md §7: measured, or refused when it
// isn't in a T-pose; stations estimated where the skin was cut away under clothes), the bodies' girth ratios, and each
// garment's Spec-fit verdict (fit/verdict.js). Without Spec's bytes the checks that need it say they weren't run.
// DOM-free: it runs in a browser, a Web Worker or Node.

import { openSource } from './source.js';
import { importRigs, fitContexts, groupModel, comesBySpecFit } from './session.js';
import { donorRig } from './onSpec.js';
import { girthRatios } from '../fit/specFit.js';
import { FITS, WARNS, FAILS } from '../fit/verdict.js';
import { T_POSE_TOLERANCE } from '../measure/bodyMeasure.js';

/** The types that are garments: what Spec-fit brings onto Spec (VRMXW §6, §7). */
export const GARMENT_TYPES = new Set(['top', 'pants', 'skirt', 'dress', 'coat']);
const STATION_WORDS = { neck: 'neck', chest: 'chest', bust: 'bust', underbust: 'underbust', waist: 'waist', hip: 'hips', thighL: 'left thigh', thighR: 'right thigh', kneeL: 'left knee', kneeR: 'right knee', calfL: 'left calf', calfR: 'right calf', ankleL: 'left ankle', ankleR: 'right ankle', upperArmL: 'left upper arm', upperArmR: 'right upper arm', elbowL: 'left elbow', elbowR: 'right elbow', wristL: 'left wrist', wristR: 'right wrist' };
const place = (id) => STATION_WORDS[id] || id.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The upper arms' angle from the T-pose (degrees, along X), from the rest pose's bone positions: the measurer's own
 * test (bodyMeasure.js, T_POSE_TOLERANCE), without measuring the body.
 */
export function armAngles(json) {
  const rig = donorRig(json);
  const angle = (upper, lower) => {
    const a = rig.at(upper), b = rig.at(lower);
    if (!a || !b) return null;
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    return len > 0 ? (Math.acos(Math.min(1, Math.abs(d[0]) / len)) * 180) / Math.PI : null;
  };
  return { left: angle('leftUpperArm', 'leftLowerArm'), right: angle('rightUpperArm', 'rightLowerArm') };
}

/**
 * bytes: the VRM's. opts: { spec (spec.vrm's bytes, or null), fileName, verdicts (default true: each garment's
 * Spec-fit verdict, the slowest part) }. Throws the importer's RefusedError for a file it refuses (no humanoid,
 * external references, …).
 * → { file, vrm, title, groups: [{ id, name, type, slot, kind, pieces, garment, specFit, verdict? }], body: [piece ids],
 *     checks: [{ id, title, level: 'good' | 'note' | 'problem', text }], verdict: { level: 'good' | 'partial' |
 *     'unsuitable', text }, ms: { open, fit, verdicts } }
 */
export async function suitability(bytes, { spec = null, fileName = 'model.vrm', verdicts = true } = {}) {
  const t0 = Date.now();
  const src = await openSource(bytes, { fileName });
  const tOpen = Date.now();
  const checks = [];
  const add = (id, title, level, text) => checks.push({ id, title, level, text });

  const groups = src.groups.map((g) => ({
    id: g.id, name: g.name, type: g.type, slot: g.slot, kind: g.kind, pieces: g.pieces.slice(),
    garment: GARMENT_TYPES.has(g.type), specFit: comesBySpecFit(g),
  }));
  const body = src.pieces.filter((p) => p.never).map((p) => p.id);
  const garments = groups.filter((g) => g.garment);
  const others = groups.filter((g) => !g.garment);

  // 1. the VRM version
  if (src.vrm === '0.x') add('version', 'VRM 0.x', 'note', `A VRM 0.x file: the importer converts it to VRM 1.0 on a copy first${src.conversion?.notes?.length ? ` (${plural(src.conversion.notes.length, 'change')} noted)` : ''}, turning it to face forward and carrying its materials and springs over. The file itself isn't changed.`);
  else add('version', 'VRM 1.0', 'good', 'A VRM 1.0 file: the importer reads it as it is.');

  // 2. the rest pose
  const arms = armAngles(src.json);
  const worst = Math.max(arms.left ?? 0, arms.right ?? 0);
  const tPose = arms.left != null && arms.right != null && worst <= T_POSE_TOLERANCE;
  if (arms.left == null || arms.right == null) add('pose', 'Rest pose unknown', 'note', "Its arm bones couldn't be found, so whether it rests in a T-pose wasn't checked.");
  else if (tPose) add('pose', 'T-pose', 'good', `It rests in a T-pose (the arms within ${Math.round(worst)}° of level), as Spec-fit needs.`);
  else add('pose', 'Not a T-pose', 'problem', `It rests with the arms ${Math.round(worst)}° below level (an A-pose or similar). Spec-fit measures the body only in a T-pose, so its garments would come onto Spec by their bones alone, keeping this body's girth (FITTING.md §7, §9).`);

  // 3. separate garments, or clothes painted on
  if (garments.length) add('garments', plural(garments.length, 'separate garment'), 'good', `${list(garments.map((g) => g.name))}: each is its own mesh and can become a closet item.${others.length ? ` Also ${list(others.map((g) => g.name.toLowerCase()))}, which come by their bones.` : ''}`);
  else if (others.length) add('garments', 'No separate garments', 'problem', `Nothing it wears is a separate mesh: its clothes, if any, are painted onto the body's skin, so there is no garment to bring into the closet. Only ${list(others.map((g) => g.name.toLowerCase()))} could come in.`);
  else add('garments', 'No pieces', 'problem', 'It has no pieces apart from its body: nothing could come into the closet.');

  // 4–5. the body under the clothes, and its proportions against Spec's (both need Spec)
  let fit = null, rigs = null;
  const tFit0 = Date.now();
  if (spec) {
    try {
      rigs = importRigs(src, spec);
      fit = fitContexts(src, rigs);
    } catch (e) { fit = { donor: { refused: e.message || String(e) } }; }
  }
  const donor = fit?.donor;
  if (!spec) {
    add('skin', 'Body not measured', 'note', "Spec isn't available here, so the body under the clothes wasn't measured.");
  } else if (donor?.refused && !/T-pose/.test(donor.refused)) {
    add('skin', 'Body not measurable', 'problem', `The body couldn't be measured: ${donor.refused}. Garments would come by their bones alone.`);
  } else if (donor?.refused) {
    add('skin', 'Body not measured', 'note', 'The body is measured only in a T-pose, so whether its skin is whole under the clothes wasn\'t checked.');
  } else if (donor) {
    const est = donor.estimated || [];
    if (!est.length) add('skin', 'Skin under the clothes', 'good', 'The skin is whole under the clothes, so the body can be measured everywhere a garment sits.');
    else add('skin', 'Skin cut away', est.length > 4 ? 'problem' : 'note', `The skin was cut away under the clothes at the ${list(est.map(place))}: Spec-fit estimates those places from Spec's body, so garments there fit less exactly.`);
    const { ratios } = girthRatios(donor, fit.spec);
    const rs = Object.entries(ratios);
    const sm = fit.spec.m?.lengths?.stature, dm = donor.m?.lengths?.stature;
    const height = sm && dm ? ` It stands ${(dm * 100).toFixed(0)} cm tall barefoot, Spec ${(sm * 100).toFixed(0)} cm.` : '';
    if (!rs.length) add('proportions', 'Proportions not compared', 'note', `Its girths couldn't be compared with Spec's.${height}`);
    else {
      // girthRatios gives Spec's girth over this body's; said the other way round: this body's girth as a share of Spec's
      const share = rs.map(([id, r]) => [id, 1 / r]);
      const pct = (x) => `${Math.round(x * 100)} %`;
      const lo = Math.min(...share.map(([, x]) => x)), hi = Math.max(...share.map(([, x]) => x));
      // the verdict's bands (fit/verdict.js): Spec-fit fails beyond 0.5–2.0 times and relaxes beyond 0.6–1.6
      const farther = share.filter(([, x]) => x < 0.5 || x > 2.0), far = share.filter(([, x]) => x < 1 / 1.6 || x > 1.6);
      const near = share.every(([, x]) => x >= 0.85 && x <= 1.18);
      if (farther.length) add('proportions', 'Far from Spec', 'problem', `Its body differs too much from Spec's at the ${list(farther.map(([id]) => place(id)))} (${farther.map(([, x]) => pct(x)).join(', ')} of Spec's girth): garments there won't transfer well.${height}`);
      else if (far.length) add('proportions', 'Unlike Spec in places', 'note', `Its girths are ${pct(lo)}–${pct(hi)} of Spec's; at the ${list(far.map(([id]) => place(id)))} the difference is large enough that Spec-fit uses its relaxed rule.${height}`);
      else if (near) add('proportions', 'Close to Spec', 'good', `Its girths are ${pct(lo)}–${pct(hi)} of Spec's everywhere they were compared.${height}`);
      else add('proportions', 'Unlike Spec', 'note', `Its girths are ${pct(lo)}–${pct(hi)} of Spec's: Spec-fit moves its garments to Spec's body, so they will look different on it.${height}`);
    }
  }
  const tFit = Date.now();

  // 6. spring bones
  const springs = src.json.extensions?.VRMC_springBone?.springs?.length || 0;
  if (springs) add('springs', 'Spring bones', 'good', `It has ${plural(springs, 'spring chain')} (hair, skirts, ribbons): they come with the pieces that use them.`);
  else add('springs', 'No spring bones', 'note', 'It has no spring bones: its hair and skirts would hang still until chains are added.');

  // 7. the licence
  const terms = Object.fromEntries(src.terms.map((t) => [t.key, t]));
  // The importer doesn't refuse these: it asks the person first, naming the file and the term, and every piece carries
  // the terms (HON-1). So a licence is a caveat on the verdict, never a reason the file can't be tested.
  if (!src.allowsChanges) add('licence', 'No changes allowed', 'note', `Its maker doesn't allow changes, and bringing a piece onto Spec changes it: the importer asks you first, and every piece carries these terms. ${terms.redistribution.text}. ${terms.commercial.text}. ${terms.credit.text}.`);
  else add('licence', 'Licence', src.allowsPassingOn ? 'good' : 'note', `${terms.modification.text}. ${terms.redistribution.text}${src.allowsPassingOn ? '' : ': a character made with its pieces can be tested, but not shared'}. ${terms.commercial.text}. ${terms.credit.text}.`);

  // 8. each garment's Spec-fit verdict
  const tV0 = Date.now();
  if (verdicts && rigs && donor && !donor.refused) {
    for (const g of groups.filter((x) => x.specFit)) {
      try {
        const m = groupModel(src, src.groups.find((x) => x.id === g.id), rigs);
        if (m.verdict) g.verdict = { verdict: m.verdict.verdict, reasons: m.verdict.reasons.map((r) => ({ level: r.level, text: r.text })) };
        else if (m.fitWhy) g.verdict = { verdict: null, reasons: [{ level: 'warn', text: m.fitWhy }] };
      } catch (e) { g.verdict = { verdict: null, reasons: [{ level: 'fail', text: e.message || String(e) }] }; }
    }
    const judged = groups.filter((x) => x.verdict?.verdict);
    if (judged.length) {
      const by = (v) => judged.filter((x) => x.verdict.verdict === v);
      const fails = by(FAILS), warns = by(WARNS), fits = by(FITS);
      const say = (gs, what) => (gs.length ? `${list(gs.map((x) => x.name))} ${what}` : null);
      const text = [say(fits, 'fit'), say(warns, 'fit with warnings'), say(fails, gs1(fails) ? "doesn't transfer well" : "don't transfer well")].filter(Boolean).join('; ');
      const firstFail = fails[0]?.verdict.reasons.find((r) => r.level === 'fail')?.text;
      add('fit', 'Spec-fit', fails.length ? (fails.length === judged.length ? 'problem' : 'note') : warns.length ? 'note' : 'good', `On Spec, ${text}.${firstFail ? ` (${firstFail}.)` : ''}`);
    }
  } else if (garments.some((g) => g.specFit)) {
    add('fit', 'Spec-fit not tried', 'note', !spec ? "Spec isn't available here, so how the garments would fit wasn't tried." : "The body couldn't be measured, so Spec-fit wasn't tried.");
  }
  const tV = Date.now();

  return { file: src.file, vrm: src.vrm, title: src.title, groups, body, checks, verdict: verdictOf(checks, garments, others), ms: { open: tOpen - t0, fit: tFit - tFit0, verdicts: tV - tV0 } };
}

const gs1 = (gs) => gs.length === 1;

/** The one line: a good candidate, a partial one (and why), or not suitable. Advice only. */
export function verdictOf(checks, garments, others) {
  const c = Object.fromEntries(checks.map((x) => [x.id, x]));
  const caveat = c.licence?.title === 'No changes allowed' ? " Its maker doesn't allow changes: the importer asks you first, and nothing made from it may be shared."
    : c.licence?.level === 'note' ? ' Its maker doesn\'t allow passing it on: test it, but don\'t share what you make from it.' : '';
  if (!garments.length && !others.length) return { level: 'unsuitable', text: `Not suitable: it has no pieces to bring into the closet.` };
  const why = [];
  if (!garments.length) why.push('its clothes are painted on, so only ' + list(others.map((g) => g.name.toLowerCase())) + ' would come in');
  if (c.pose?.level === 'problem') why.push('it isn\'t in a T-pose, so garments would come by their bones');
  if (c.skin?.level === 'problem') why.push(c.skin.title === 'Skin cut away' ? 'much of its skin is cut away under the clothes' : 'its body can\'t be measured');
  if (c.proportions?.level === 'problem') why.push('its body is far from Spec\'s');
  if (c.fit?.level === 'problem') why.push('none of its garments transfer well');
  else if (c.fit?.level === 'note' && /transfer well/.test(c.fit.text)) why.push('some garments don\'t transfer well');
  if (!why.length) {
    const tried = c.fit?.level === 'good';
    return { level: 'good', text: `A good candidate: ${plural(garments.length, 'separate garment')}${tried ? ' that fit Spec' : ''}${c.pose?.level === 'good' ? ', in a T-pose' : ''}.${tried ? '' : ' (How the garments fit wasn\'t tried here.)'}${caveat}` };
  }
  if (!garments.length && why.length === 1) return { level: 'partial', text: `A partial candidate: ${why[0]}.${caveat}` };
  return { level: 'partial', text: `A partial candidate: ${list(why)}.${caveat}` };
}
