// The clip checker (PRD ANI-13): run when a clip is brought in and on request. It lists each problem
// with its numbers and the tool that fixes it (ANI-9 to ANI-12), and the things that are fine.
//
//   checkClip(clip, { details, rig, figure, hints, corrections })
//     details      the clip's record in animations.json: { loops, rootMotion, speed, rate, groundedFor }
//     rig          Spec's figure (rig.js rigFromVrm(spec.vrm)): ground speed is metres per second on Spec (VRMXA §8.4)
//     figure       the character as dressed (its bones' rest places and shoes' lift; `of`: { base, edits }), when it isn't bare Spec
//     hints        what the clip's own record says that the keys can't (import.js: the source's playback
//                  rate, a seam the converter blended and how far apart the ends were before)
//     corrections  the corrections already applied (correct.js ops): a problem known only from the record
//                  is settled when the person has used its tool
//   → { problems: [{ id, severity: 'fix' | 'warn', title, text, numbers, tool }], fine: [{ id, title, text }], numbers }
//
// Every threshold is in CHECK. Measured on the 30 starter clips (assets/motions/kimodo/ISSUES.md M1–M9).

import { track, contactSpans, treadmill, seam, travel, meanDeg, ranges, footAt } from './analyse.js';

export const CHECK = Object.freeze({
  below: 0.005, // m: a sole further under the floor than this
  dressed: 0.003, // m: on the character as dressed, contact this far off the floor
  slide: 0.03, // m: a planted foot wandering further than this in one step
  seamGap: 0.02, // m: the last pose this far from the first (largest joint move)
  seamRough: 1.5, // the wrap's second difference over the 95th percentile of the clip's own
  facingStart: 3, // degrees at the first key
  facingMean: 5, // degrees over the clip
  travelInPlace: 0.05, // m of hips travel in a clip marked in place
  speedOff: 0.15, // share: a recorded ground speed this far from the measured one
});

const cm = (m) => `${(m * 100).toFixed(1)} cm`;
const sec = (f, fps) => +(f / fps).toFixed(2);
const pct = (x) => `${(x * 100).toFixed(1)} %`;
const deg = (d) => `${d.toFixed(1)}°`;
// a seam blend over 12 % of the cycle, at least 2 frames: long enough for a slow idle's head turn (25 of 210
// frames), short enough for a run's stride (4 of 36), measured on the starter clips
const seamBlend = (_frames, n, fps) => +(Math.max(2, Math.round(0.12 * (n - 2))) / fps).toFixed(3);
const used = (corrections, kind) => (corrections || []).some((c) => c.kind === kind);

export function checkClip(clip, { details = {}, rig, figure = null, hints = {}, corrections = [] } = {}) {
  if (!rig) throw new Error('checkClip needs Spec\'s rig');
  const problems = [], fine = [];
  const T = track(clip, rig);
  const fps = clip.fps, n = clip.frames;
  const N = { frames: n, duration: +clip.duration.toFixed(3), figure: figure?.label || rig.label };

  // ---- feet under the floor (M1) -------------------------------------------------------------------
  const F = figure ? track(clip, figure) : T;
  const fig = figure || rig;
  const lowest = Math.min(...F.lowest);
  N.lowestSole = +lowest.toFixed(4);
  if (lowest < -CHECK.below) {
    const per = {};
    for (const side of ['left', 'right']) {
      const low = (f) => Math.min(...F.soles[f].filter((p) => p.side === side).map((p) => p.at[1] - fig.ground));
      per[side] = { r: ranges(n, (f) => low(f) < -CHECK.below), min: Math.min(...Array.from({ length: n }, (_, f) => low(f))) };
    }
    const sides = ['left', 'right'].filter((s) => per[s].r.length);
    const all = sides.flatMap((s) => per[s].r);
    const from = Math.min(...all.map((r) => r[0])), to = Math.max(...all.map((r) => r[1]));
    const offFeet = Array.from({ length: n }, (_, f) => f).filter((f) => F.lowest[f] < -CHECK.below && !F.standing[f]).length;
    problems.push({
      id: 'floor-below', severity: 'fix', title: 'Feet go under the floor',
      text: `Lowest sole ${cm(lowest)}, from ${sec(from, fps)} to ${sec(to, fps)} s${offFeet ? ', while sitting or lying' : ''}.`,
      numbers: { lowest: +lowest.toFixed(4), from: sec(from, fps), to: sec(to, fps), feet: sides },
      tool: { kind: 'pinFoot', label: 'Pin to floor', params: { foot: sides.length === 2 ? 'both' : sides[0], from: sec(Math.max(0, from - 3), fps), to: sec(Math.min(n - 1, to + 3), fps), mode: 'floor', easeIn: 0.1, easeOut: 0.1 } },
    });
  } else fine.push({ id: 'floor-below', title: 'Feet stay above the floor', text: `Lowest point of a sole: ${cm(Math.max(0, lowest))}.` });

  // ---- floor contact set for bare feet on Spec (M7) ------------------------------------------------------
  if (figure) {
    // each step she stands on: how far the planted foot's lowest sole is off the floor (0 when the clip is set
    // on the floor for her). Spec's bare soles touch it in every step of a starter clip (the converter set them so).
    const steps = contactSpans(F, 0, { minFrames: 2 });
    const lows = steps.map((sp) => { let m = Infinity; for (let f = sp.from; f <= sp.to; f++) m = Math.min(m, footAt(F, f, sp.side).y); return m; });
    // in a loop a step held across the seam is one step (its halves are judged together)
    if (details.loops) for (const side of ['left', 'right']) {
      const a = steps.findIndex((x) => x.side === side && x.from === 0), b = steps.findIndex((x) => x.side === side && x.to === n - 1);
      if (a >= 0 && b >= 0 && a !== b) lows[a] = lows[b] = Math.min(lows[a], lows[b]);
    }
    const lo = lows.length ? Math.min(...lows) : 0, hi = lows.length ? Math.max(...lows) : 0;
    N.dressedContact = [+lo.toFixed(4), +hi.toFixed(4)];
    // grounded for her: the clip's groundedFor (VRMXA §8.4) names her figure (base, lift, edit document)
    const gf = details.groundedFor;
    const figLift = figure.of?.lift ?? ((figure.lift ?? 0) + (figure.bodyLift ?? 0)); // shoes + the body's own lift (§8.4)
    const grounded = !!gf && Math.abs((gf.lift ?? 0) - figLift) < 5e-4 && (!figure.of || ((gf.base ?? null) === (figure.of.base ?? gf.base ?? null) && (gf.edits ?? null) === (figure.of.edits ?? null)));
    N.groundedFor = gf || null;
    // grounded for her already: only if her figure changed since (other shoes, another body) does it show again
    const off = Math.abs(lo) > CHECK.dressed || Math.abs(hi) > CHECK.dressed;
    if (off || (!grounded && figure.lift > 0)) {
      const shoes = figure.lift > 0 ? `; she wears shoes that lift her ${cm(figure.lift)}` : '';
      problems.push({
        id: 'floor-dressed', severity: Math.max(Math.abs(lo), Math.abs(hi)) > CHECK.dressed ? 'fix' : 'warn', title: 'Floor set for bare feet',
        text: `The clip was set on the floor for Spec's bare feet. On ${figure.label}, standing soles are ${cm(lo)} to ${cm(hi)} off the floor${shoes}.`,
        numbers: { from: +lo.toFixed(4), to: +hi.toFixed(4), lift: figure.lift },
        tool: { kind: 'ground', label: 'Set on floor', params: {} },
      });
    } else fine.push({ id: 'floor-dressed', title: 'Set on the floor for her', text: `Standing soles ${cm(lo)} to ${cm(hi)} off the floor.` });
  }

  // ---- sliding feet (M2) and ground speed (M9) -----------------------------------------------------------
  // feet are judged on the figure she is (dressed); ground speed on Spec, where the record keeps it (§8.4)
  const meanFacing = meanDeg(T.facing);
  const tm = treadmill(contactSpans(T), meanFacing);
  const spans = figure ? contactSpans(F) : contactSpans(T);
  N.treadmill = tm.moving ? { speed: +tm.speed.toFixed(3), direction: +tm.direction.toFixed(1) } : null;
  if (!tm.moving) {
    const sliding = spans.filter((s) => s.slide > CHECK.slide);
    const worst = spans.reduce((m, s) => Math.max(m, s.slide), 0);
    N.slide = +worst.toFixed(4);
    if (sliding.length) {
      const removed = hints.travelRemoved ? ` ${cm(hints.travelRemoved).replace(' cm', '')} cm of travel was removed from its source.` : '';
      problems.push({
        id: 'slide', severity: 'fix', title: 'Feet slide',
        text: `A planted foot slides up to ${cm(worst)} while it carries weight (${sliding.length} step${sliding.length > 1 ? 's' : ''}).${removed}`,
        numbers: { worst: +worst.toFixed(4), steps: sliding.length, spans: sliding.map((s) => ({ side: s.side, from: sec(s.from, fps), to: sec(s.to, fps), slide: +s.slide.toFixed(4) })) },
        tool: { kind: 'lockFeet', label: 'Lock feet', params: { min: CHECK.slide } },
      });
    } else fine.push({ id: 'slide', title: 'Feet stay where they are put', text: `Largest slide of a planted foot: ${cm(worst)}.` });
  }
  if (details.rootMotion === 'inPlace' && tm.moving) {
    if (details.speed == null) {
      problems.push({
        id: 'speed-missing', severity: 'fix', title: 'Ground speed not recorded',
        text: `It walks on the spot at ${tm.speed.toFixed(2)} m/s on Spec, but no ground speed is recorded, so an app can't move her at the pace of her feet.`,
        numbers: { measured: +tm.speed.toFixed(3) },
        tool: { kind: 'groundSpeed', label: 'Record speed', params: {} },
      });
    } else if (Math.abs(details.speed - tm.speed) / tm.speed > CHECK.speedOff) {
      problems.push({
        id: 'speed-off', severity: 'warn', title: 'Ground speed differs from the feet',
        text: `Recorded ${details.speed.toFixed(2)} m/s; her feet move at ${tm.speed.toFixed(2)} m/s on Spec.`,
        numbers: { recorded: details.speed, measured: +tm.speed.toFixed(3) },
        tool: { kind: 'groundSpeed', label: 'Record speed', params: {} },
      });
    } else fine.push({ id: 'speed', title: 'Ground speed recorded', text: `${details.speed.toFixed(2)} m/s; her feet move at ${tm.speed.toFixed(2)} m/s.` });
  }

  // ---- travel in a clip marked in place --------------------------------------------------------------------
  const tr = travel(T);
  N.travel = +tr.far.toFixed(4);
  if (details.rootMotion === 'inPlace' && tr.far > CHECK.travelInPlace) {
    problems.push({
      id: 'travel-in-place', severity: 'fix', title: 'Travels, but marked in place',
      text: `The hips travel up to ${cm(tr.far)} from where they start.`,
      numbers: { far: +tr.far.toFixed(4), net: +tr.net.toFixed(4) },
      tool: { kind: 'travel', label: 'Remove travel', params: { mode: 'remove' } },
    });
  }

  // ---- the loop's seam (M3, M4) ---------------------------------------------------------------------------------
  if (details.loops) {
    const s = seam(T);
    N.seam = { gap: +s.gap.toFixed(4), roughness: +s.roughness.toFixed(2) };
    const blend = hints.loopBlend;
    const looped = (corrections || []).filter((c) => c.kind === 'loop');
    if (s.gap > CHECK.seamGap) {
      problems.push({ id: 'seam', severity: 'fix', title: 'The loop does not meet', text: `It ends ${cm(s.gap)} away from its start.`, numbers: N.seam, tool: { kind: 'loop', label: 'Fix loop', params: { blend: 0.3 } } });
    } else if (s.roughness > CHECK.seamRough) {
      const rec = blend ? ` Its last ${blend.frames} keys were blended back to the first pose (the source's ends were ${blend.gapPercent} % apart).` : '';
      problems.push({ id: 'seam', severity: 'fix', title: 'The loop jolts where it wraps', text: `The wrap is ${s.roughness.toFixed(1)} times as abrupt as the clip's roughest moments (its 95th percentile).${rec}`, numbers: N.seam, tool: { kind: 'loop', label: 'Fix loop', params: { blend: seamBlend((blend?.frames || 8) + 2, n, fps) } } });
    } else if (blend && (blend.frames > 1 || blend.gapPercent >= 5) && !looped.length) {
      problems.push({ id: 'seam', severity: 'warn', title: 'The loop is eased, not natural', text: `From the clip's record: its last ${blend.frames} key${blend.frames > 1 ? 's were' : ' was'} blended back to the first pose; the source's ends were ${blend.gapPercent} % apart. Measured now: the wrap is ${s.roughness.toFixed(2)} times as abrupt as the clip's roughest moments.`, numbers: { ...N.seam, blendFrames: blend.frames, sourceGapPercent: blend.gapPercent, fromRecord: true }, tool: { kind: 'loop', label: 'Fix loop', params: { blend: seamBlend(blend.frames, n, fps) } } });
    } else fine.push({ id: 'seam', title: 'The loop meets', text: `Ends ${cm(s.gap)} from its start; the wrap is ${s.roughness.toFixed(2)} times as abrupt as the clip's roughest moments.` });
  }

  // ---- facing (M5, M6) --------------------------------------------------------------------------------------------------
  N.facing = { start: +T.facing[0].toFixed(2), mean: +meanFacing.toFixed(2) };
  if (details.loops && Math.abs(meanFacing) > CHECK.facingMean) {
    problems.push({ id: 'facing-mean', severity: 'fix', title: 'Turned away over the clip', text: `She faces ${deg(meanFacing)} off ahead on average.`, numbers: N.facing, tool: { kind: 'turn', label: 'Face ahead', params: { degrees: +(-meanFacing).toFixed(1) } } });
  }
  if (Math.abs(T.facing[0]) > CHECK.facingStart) {
    problems.push({
      id: 'facing-start', severity: details.loops ? 'fix' : 'warn', title: 'Does not start facing ahead',
      text: `At the first key she faces ${deg(T.facing[0])} off ahead${details.loops ? ' (the cycle was cut mid-stride)' : ''}.`,
      numbers: N.facing,
      tool: details.loops ? { kind: 'loop', label: 'Start frame', params: { startFacing: true } } : { kind: 'turn', label: 'Face ahead', params: { degrees: +(-T.facing[0]).toFixed(1) } },
    });
  }
  if ((!details.loops || Math.abs(meanFacing) <= CHECK.facingMean) && Math.abs(T.facing[0]) <= CHECK.facingStart) fine.push({ id: 'facing', title: 'Faces ahead', text: `${deg(T.facing[0])} at the first key, ${deg(meanFacing)} on average.` });

  // ---- a playback rate the keys don't have (M8; VRMXA §8.4 `rate`) ---------------------------------------------------------
  const rate = details.rate ?? hints.playbackRate ?? 1;
  N.rate = rate;
  if (Math.abs(rate - 1) > 1e-3) {
    problems.push({
      id: 'playback', severity: 'warn', title: 'Meant to play faster than its keys',
      text: `Its rate is ${rate}×: its keys are stored at 1×, so a player that ignores the rate plays it slower than it was made.`,
      numbers: { rate },
      tool: { kind: 'speed', label: 'Bake the speed', params: { rate, bake: true } },
    });
  }

  N.problems = problems.length;
  return { problems, fine, numbers: N };
}

/** One line per problem, for the CLI and the probe: "floor-below: Feet go under the floor — Lowest sole −9.5 cm …". */
export function checkLines(result) {
  return [...result.problems.map((p) => `${p.severity === 'fix' ? '✗' : '!'} ${p.id}: ${p.title}. ${p.text} → ${p.tool.label}`), ...result.fine.map((f) => `✓ ${f.id}: ${f.title}. ${f.text}`)];
}

export { pct };
