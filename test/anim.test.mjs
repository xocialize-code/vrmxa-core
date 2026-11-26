// Animation sets and clip correction (PRD phase 6): reading and writing .vrma, the checker against the
// starter clips' known faults (assets/motions/kimodo/ISSUES.md M1–M9), every correction, the sets, and the
// operations on a character's bundle (VRMXA §8, CLOSET.md C7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { createBundle, readBundle, writeBundle, checkBundle } from '../src/index.js';
import { addItem, putOn, removeItem, closetSnapshot, restoreCloset } from '../src/closet/index.js';
import {
  readVrma, writeVrma, rigFromVrm, withLift, poseAt, solePoints, checkClip, autoCorrect, applyCorrections, solveLeg, starterRecord,
  addStarterClips, correctClip, correctionsOf, animationsOf, createSet, updateSet, setSlot, removeSet, removeClip, motionPlan, setClipDetails,
  resolveSlots, activeSets, pickClip, importMotion, mixamoToClip, track, contactSpans, keyCount, CORRECTIONS_PATH, addClip,
} from '../src/anim/index.js';
import { qmul, qconj, qangle, qeuler, qrot } from '../src/anim/quat.js';
import { ROOT, fixture, specVrm, noSpec, codes } from './helpers.mjs';

const KIMODO = join(ROOT, 'assets', 'motions', 'kimodo');
const listing = JSON.parse(readFileSync(join(KIMODO, 'clips.json'), 'utf8'));
const clipBytes = (id) => new Uint8Array(readFileSync(join(KIMODO, listing.clips.find((c) => c.id === id).file)));
const entry = (id) => listing.clips.find((c) => c.id === id);
const spec = noSpec ? null : rigFromVrm(specVrm(), { label: 'Spec' });
const boots = spec ? withLift(spec, 0.0313, 'Spec in boots') : null;
const check = (id, figure = null, extra = {}) => { const r = starterRecord(entry(id), { listing }); return checkClip(readVrma(clipBytes(id)), { details: r.details, rig: spec, figure, hints: r.hints, ...extra }); };
const ids = (r) => r.problems.map((p) => p.id);

test('a .vrma reads into normalized pose data and writes back the same', () => {
  const bytes = clipBytes('walk');
  const c = readVrma(bytes);
  assert.equal(c.fps, 30);
  assert.equal(c.frames, 32);
  assert.ok(Math.abs(c.restHips[1] - 1.0052) < 1e-3, 'the clip rests on SOMA\'s skeleton (hips 1.0052 m)');
  assert.equal(Object.keys(c.bones).length, 52);
  const back = readVrma(writeVrma(c));
  let d = 0;
  for (const b of Object.keys(c.bones)) for (let i = 0; i < c.bones[b].length; i++) d = Math.max(d, Math.abs(c.bones[b][i] - back.bones[b][i]));
  for (let i = 0; i < c.hips.length; i++) d = Math.max(d, Math.abs(c.hips[i] - back.hips[i]));
  assert.ok(d < 1e-6, `round trip ${d}`);
  assert.equal(keyCount(c), 53 * 32);
});

test('rest rotations in a .vrma are taken out as the player does (Wp · q · W⁻¹)', () => {
  // a two-bone clip whose spine node rests turned 90° about Y: its key "identity" must read as the inverse turn
  const c = readVrma(clipBytes('idle'));
  const bytes = writeVrma(c);
  // rebuild the JSON with a rest rotation on spine and keys that include it (local = rest · pose)
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const jl = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jl)));
  const spineNode = json.extensions.VRMC_vrm_animation.humanoid.humanBones.spine.node;
  const R = qeuler([0, 90, 0]);
  json.nodes[spineNode].rotation = R;
  const out = new Uint8Array(bytes); // same binary: keys are still the normalized pose, so the reader must turn them by R⁻¹ on the right
  const json2 = new TextEncoder().encode(JSON.stringify(json).padEnd(jl, ' '));
  if (json2.length !== jl) return; // can't patch in place (longer JSON): covered by the converter's own checks
  out.set(json2, 20);
  const r = readVrma(out);
  const q0 = Array.from(c.bones.spine.subarray(0, 4)), q1 = Array.from(r.bones.spine.subarray(0, 4));
  // world rest of spine is R (its parent hips rests at identity): normalized = I · q · R⁻¹
  assert.ok(qangle(q1, qmul(q0, qconj(R))) < 1e-5);
});

test('the checker finds ISSUES.md M1–M9 in the starter clips, with their numbers', { skip: noSpec }, () => {
  // M1 feet under the floor while sitting or lying
  const m1 = { sit_b: -0.095, death: -0.0695, death_b: -0.101, death_2: -0.0075, death_2_b: -0.118, roll: -0.100 };
  for (const [id, low] of Object.entries(m1)) {
    const r = check(id);
    const p = r.problems.find((x) => x.id === 'floor-below');
    assert.ok(p, `${id}: floor-below`);
    assert.ok(Math.abs(p.numbers.lowest - low) < 0.003, `${id}: lowest ${p.numbers.lowest} against ${low}`);
    assert.equal(p.tool.kind, 'pinFoot');
  }
  // M2 feet slide (idle_restless: travel removed)
  const m2 = check('idle_restless').problems.find((p) => p.id === 'slide');
  assert.ok(m2 && m2.numbers.worst > 0.2, 'idle_restless slides');
  assert.match(m2.text, /76\.0 cm of travel was removed/);
  // M3 eased loop: idle measured, idle_restless from its record
  assert.match(check('idle').problems.find((p) => p.id === 'seam').title, /jolts/);
  assert.ok(check('idle_restless').problems.some((p) => p.id === 'seam'));
  // M4 rougher seams on the fast cycles (from the record: the converter blended them)
  for (const id of ['run_b', 'sprint']) { const p = check(id).problems.find((x) => x.id === 'seam'); assert.ok(p, id); assert.ok(p.numbers.fromRecord); }
  // M5 not starting facing ahead
  const m5 = { sprint: 7.0, walk: -6.3, zombie_walk: -6.1, crouch_sneak: -5.1, sneak: -4.5, strafe_left_b: -8.8, strafe_right: 8.8 };
  for (const [id, deg] of Object.entries(m5)) {
    const p = check(id).problems.find((x) => x.id === 'facing-start');
    assert.ok(p, `${id}: facing-start`);
    assert.ok(Math.abs(p.numbers.start - deg) < 1.2, `${id}: ${p.numbers.start}° against ${deg}°`);
  }
  // M6 the strafes turned about 13° over the cycle
  for (const id of ['strafe_left_b', 'strafe_right']) assert.ok(Math.abs(Math.abs(check(id).problems.find((p) => p.id === 'facing-mean').numbers.mean) - 13.3) < 1, id);
  // M7 floor set against Spec's bare feet: every clip, on a character in boots
  for (const c of listing.clips) assert.ok(ids(check(c.id, boots)).includes('floor-dressed'), `${c.id}: floor-dressed`);
  assert.ok(!ids(check('walk')).includes('floor-dressed'), 'no M7 on bare Spec');
  // M8 playback speed only in the record
  for (const [id, rate] of [['punch', 1.3], ['punch_b', 1.3], ['one_two', 1.5]]) assert.equal(check(id).problems.find((p) => p.id === 'playback').numbers.rate, rate);
  // M9 ground speed not recorded for the in-place clips that walk on the spot
  const walking = listing.clips.filter((c) => c.in_place && !c.id.startsWith('idle')).map((c) => c.id);
  assert.equal(walking.length, 10);
  for (const id of walking) { const p = check(id).problems.find((x) => x.id === 'speed-missing'); assert.ok(p, id); assert.ok(p.numbers.measured > 0.3); }
  assert.ok(Math.abs(check('walk').problems.find((p) => p.id === 'speed-missing').numbers.measured - 1.59) < 0.05);
  // a clip with nothing to fix
  assert.deepEqual(ids(check('wave_b')), []);
});

test('every starter clip passes the checker after its corrections; the original is untouched', { skip: noSpec }, () => {
  for (const figure of [null, boots]) {
    for (const c of listing.clips) {
      const r = starterRecord(c, { listing });
      const bytes = clipBytes(c.id);
      const before = new Uint8Array(bytes);
      const out = autoCorrect(readVrma(bytes), { rig: spec, figure, details: r.details, hints: r.hints });
      assert.deepEqual(out.after.problems.map((p) => `${p.id}: ${p.text}`), [], `${c.id}${figure ? ' in boots' : ''}`);
      assert.deepEqual(bytes, before);
      if (r.details.loops) assert.ok(out.after.numbers.seam.gap < 1e-3, `${c.id}: the loop stays closed`);
    }
  }
});

test('timing, facing and loop corrections', { skip: noSpec }, () => {
  const walk = readVrma(clipBytes('walk'));
  const fast = applyCorrections(walk, [{ kind: 'speed', rate: 2 }], { rig: spec }).clip;
  assert.equal(fast.frames, 17); // 31 steps at 2× → 16 (rounded from 15.5), and the first key
  const cut = applyCorrections(walk, [{ kind: 'trim', from: 0.2, to: 0.8 }], { rig: spec }).clip;
  assert.equal(cut.frames, 19);
  const T0 = track(walk, spec);
  const turned = applyCorrections(walk, [{ kind: 'turn', degrees: 30 }], { rig: spec }).clip;
  assert.ok(Math.abs(track(turned, spec).facing[0] - T0.facing[0] - 30) < 0.01);
  const looped = applyCorrections(walk, [{ kind: 'loop', startFacing: true, blend: 0.1 }], { rig: spec, details: { loops: true } }).clip;
  const T1 = track(looped, spec);
  assert.ok(Math.abs(T1.facing[0]) < 3, `starts facing ahead: ${T1.facing[0]}`);
  for (const b of Object.keys(looped.bones)) assert.ok(qangle(Array.from(looped.bones[b].subarray(0, 4)), Array.from(looped.bones[b].subarray((looped.frames - 1) * 4))) < 1e-3, `${b}: last key is the first pose`);
});

test('offsets, keyed poses, thinning, expression and gaze tracks', { skip: noSpec }, () => {
  const c = readVrma(clipBytes('cheer'));
  const r = applyCorrections(c, [{ kind: 'offset', bones: ['thumbs'], rotation: [0, 6, 0] }, { kind: 'offset', bone: 'head', rotation: [10, 0, 0], from: 1, to: 2, easeIn: 0.2, easeOut: 0.2 }], { rig: spec }).clip;
  const d = qangle(qmul(qconj(Array.from(c.bones.leftThumbProximal.subarray(40, 44))), Array.from(r.bones.leftThumbProximal.subarray(40, 44))), [0, 0, 0, 1]);
  assert.ok(Math.abs(d - (6 * Math.PI) / 180) < 1e-4, 'a constant offset over the clip');
  const head = (cl, f) => Array.from(cl.bones.head.subarray(f * 4, f * 4 + 4));
  assert.ok(qangle(head(c, 0), head(r, 0)) < 1e-3, 'outside the range and its easing: unchanged');
  assert.ok(Math.abs(qangle(head(c, 45), head(r, 45)) - (10 * Math.PI) / 180) < 1e-4, 'inside: the whole offset');
  const thin = applyCorrections(c, [{ kind: 'thin', tolerance: 1 }], { rig: spec });
  assert.ok(thin.keys.after < thin.keys.before / 2, `${thin.keys.before} → ${thin.keys.after}`);
  for (const b of Object.keys(c.bones)) for (let f = 0; f < c.frames; f++) assert.ok(qangle(Array.from(c.bones[b].subarray(f * 4, f * 4 + 4)), Array.from(thin.clip.bones[b].subarray(f * 4, f * 4 + 4))) < (1.05 * Math.PI) / 180);
  const face = applyCorrections(c, [{ kind: 'expression', name: 'happy', keys: [{ t: 0.5, w: 0 }, { t: 1, w: 1 }, { t: 2, w: 0 }] }, { kind: 'gaze', keys: [{ t: 0, yaw: 0, pitch: 0 }, { t: 1, yaw: 20, pitch: 5 }] }], { rig: spec });
  const back = readVrma(writeVrma(face.clip));
  assert.ok(Math.abs(back.expressions.happy[30] - 1) < 1e-6 && Math.abs(back.expressions.happy[45] - 0.5) < 1e-6);
  assert.ok(back.lookAt, 'gaze track written and read back');
  assert.deepEqual(face.details.tracks, undefined);
});

test('a leg is solved to reach where the foot is pinned; pinning to the floor lifts the soles to it', { skip: noSpec }, () => {
  const c = readVrma(clipBytes('cheer'));
  const pose = poseAt(c, spec, 30);
  const ankle = pose.pos.leftFoot;
  const target = [ankle[0] + 0.03, ankle[1] + 0.05, ankle[2] - 0.02];
  const miss = solveLeg(c, spec, 30, 'left', target, pose);
  const after = poseAt(c, spec, 30);
  assert.equal(miss, 0);
  assert.ok(Math.hypot(...after.pos.leftFoot.map((v, i) => v - target[i])) < 1e-4);
  assert.ok(qangle(after.rot.leftFoot, pose.rot.leftFoot) < 2e-3, 'the foot keeps its turn in the world');
  const sit = readVrma(clipBytes('sit_b'));
  const pinned = applyCorrections(sit, [{ kind: 'pinFoot', foot: 'both', from: 0.5, to: 2.97, mode: 'floor', easeIn: 0.1, easeOut: 0 }], { rig: spec }).clip;
  const low = Math.min(...Array.from({ length: pinned.frames }, (_, f) => Math.min(...solePoints(poseAt(pinned, spec, f), spec).map((p) => p.at[1]))));
  assert.ok(low > -0.003, `lowest sole ${low}`);
});

test('locking the feet stops a planted foot sliding; keeping the travel lets the clip travel instead', { skip: noSpec }, () => {
  const c = readVrma(clipBytes('idle_restless'));
  const worst = (cl) => contactSpans(track(cl, spec)).reduce((m, s) => Math.max(m, s.slide), 0);
  assert.ok(worst(c) > 0.3);
  const locked = applyCorrections(c, [{ kind: 'lockFeet' }], { rig: spec, details: { loops: true } }).clip;
  assert.ok(worst(locked) < 0.03, `locked: ${worst(locked)}`);
  const kept = applyCorrections(c, [{ kind: 'travel', mode: 'fromFeet' }], { rig: spec });
  assert.equal(kept.details.rootMotion, 'travel');
  assert.ok(worst(kept.clip) < worst(c) / 2, `travel kept: ${worst(kept.clip)}`);
  const walk = readVrma(clipBytes('walk'));
  const sp = applyCorrections(walk, [{ kind: 'groundSpeed' }], { rig: spec });
  assert.ok(Math.abs(sp.details.speed - 1.59) < 0.05);
});

// ---- the bundle ---------------------------------------------------------------------------------------------
const minimal = await readBundle(fixture('characters/minimal.vrmxa'));
const AVATAR = minimal.entries.get('avatar.vrm');
const starterFiles = () => listing.clips.map((e) => ({ entry: e, bytes: clipBytes(e.id) }));
async function holds(bundle, msg = '') {
  const problems = await checkBundle(await writeBundle(bundle));
  assert.deepEqual(codes(problems), [], `${msg}: ${problems.filter((p) => p.severity === 'error').map((p) => `${p.where}: ${p.message}`).join('; ')}`);
}

test('the starter clips come into a character as sets; the default set fills idle; the file checks', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  const r = await addStarterClips(b, starterFiles(), listing);
  assert.equal(r.clips.length, 30);
  const doc = animationsOf(b);
  assert.equal(doc.clips.length, 30);
  assert.equal(doc.sets.length, 3);
  const def = doc.sets.find((s) => s.default);
  assert.equal(def.slots.idle.length, 2);
  assert.ok(doc.clips.every((c) => c.licence && /Kimodo/.test(c.licence)), 'each clip carries its licence (VRMXA §2 rule 6)');
  assert.ok(!b.entries.has(CORRECTIONS_PATH), 'no corrections file of the app\'s own (VRMXA 0.31)');
  assert.ok(doc.clips.find((c) => c.name === 'Idle (restless)')['x-xocialize.hints'].loopBlend, 'the hints the checker reads are kept on the clip\'s record');
  assert.equal(doc.clips.find((c) => c.name === 'Hook').rate, 1.3, 'the source\'s playback rate is the clip\'s rate (VRMXA §8.4)');
  await holds(b, 'starter clips');
  // bringing them in again changes nothing
  await addStarterClips(b, starterFiles(), listing);
  assert.equal(animationsOf(b).clips.length, 30);
  // reading the written file back keeps everything
  const again = await readBundle(await writeBundle(b));
  assert.equal(animationsOf(again).sets.length, 3);
  assert.equal(correctionsOf(again).clips.length, 30); // a view: the originals' hints
});

test('a correction is kept apart: the sets play the corrected clip, the original stays, and it can be changed or removed', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  const sit = animationsOf(b).clips.find((c) => c.name === entry('sit_b').label);
  const ops = [{ kind: 'pinFoot', foot: 'both', from: 0.5, to: 2.97, mode: 'floor' }, { kind: 'lockFeet' }];
  const r = await correctClip(b, sit.sha256, ops, { rig: spec });
  assert.ok(r.result && r.result !== sit.sha256);
  assert.ok(ids(r.before).includes('floor-below') && !ids(r.after).includes('floor-below'));
  const doc = animationsOf(b);
  assert.ok(doc.clips.some((c) => c.sha256 === sit.sha256), 'the original is never lost');
  assert.equal(doc.sets.find((s) => s.default).slots.sit[0].clip, r.result);
  assert.deepEqual(correctionsOf(b).clips.find((e) => e.original === sit.sha256).ops, ops);
  await holds(b, 'corrected');
  // changed: a new result replaces the old, which goes
  const r2 = await correctClip(b, r.result, [ops[0]], { rig: spec });
  assert.ok(!animationsOf(b).clips.some((c) => c.sha256 === r.result));
  assert.equal(animationsOf(b).sets.find((s) => s.default).slots.sit[0].clip, r2.result);
  // removed: the sets play the original again
  await correctClip(b, sit.sha256, [], { rig: spec });
  assert.equal(animationsOf(b).sets.find((s) => s.default).slots.sit[0].clip, sit.sha256);
  assert.equal(animationsOf(b).clips.length, 30);
  await holds(b, 'uncorrected');
});

test('sets follow what is worn; an item\'s sets are shown as its and become the character\'s when edited', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  const doc = animationsOf(b);
  const walk = (tags) => resolveSlots(doc, new Set(tags)).walk;
  assert.equal(walk([]).set.name, 'Default');
  assert.equal(walk(['footwear:heels']).set.name, 'In heels');
  assert.equal(activeSets(doc, new Set(['held:fists']))[0].name, 'Fists up');
  assert.equal(pickClip([{ clip: 'a', weight: 3 }, { clip: 'b', weight: 1 }], 0.7).clip, 'a');
  assert.equal(pickClip([{ clip: 'a', weight: 3 }, { clip: 'b', weight: 1 }], 0.8).clip, 'b');
  // an item that brings a set (the staff: idle and use while held)
  const staff = await addItem(b, fixture('items/animated-staff.vrmxw'));
  await putOn(b, staff.id);
  const plan = await motionPlan(b);
  const brought = animationsOf(b).sets.find((s) => s.from === staff.id);
  assert.ok(brought, 'the staff brought a set, marked as its');
  assert.ok(plan.equipped.tags.length && plan.active[0].from === staff.id, `the staff's set is active while it is worn: ${JSON.stringify(plan.active[0])}`);
  await holds(b, 'with the staff');
  const snap = closetSnapshot(b);
  await updateSet(b, brought.id, { priority: 20 });
  assert.equal(animationsOf(b).sets.find((s) => s.id === brought.id).from, undefined, 'edited: the character\'s own');
  restoreCloset(b, snap);
  assert.equal(animationsOf(b).sets.find((s) => s.id === brought.id).from, staff.id, 'undo brings the mark back');
  const { takeOff } = await import('../src/closet/index.js');
  await takeOff(b, staff.id);
  await removeItem(b, staff.id);
  assert.ok(!animationsOf(b).sets.some((s) => s.id === brought.id), 'a brought set goes with its item (C7)');
  await holds(b, 'staff removed');
});

test('set and clip operations check what they write', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  const a = await addClip(b, clipBytes('wave_b'), { details: { name: 'Wave' }, rig: spec });
  assert.equal(a.record.loops, false);
  assert.equal(a.record.rootMotion, 'inPlace');
  await assert.rejects(createSet(b, { name: 'Bad', requires: ['not a tag'] }), /namespace:value/);
  await assert.rejects(createSet(b, { name: 'Bad', slots: { dancing: [{ clip: a.sha256 }] } }), /not a slot/);
  const id = await createSet(b, { name: 'Mine', default: true, slots: { idle: [{ clip: a.sha256 }] } });
  await setSlot(b, id, 'greet', [{ clip: a.sha256, rate: 1.2 }]);
  await assert.rejects(setSlot(b, id, 'walk', [{ clip: 'f'.repeat(64) }]), /not in clips/);
  await setClipDetails(b, a.sha256, { speed: 0, loops: false, licence: 'CC0' });
  await assert.rejects(setClipDetails(b, a.sha256, { speed: -1 }), /speed/);
  await assert.rejects(removeClip(b, a.sha256), /idle/);
  await assert.rejects(removeSet(b, 'nope'), /no set/);
  await holds(b, 'own set');
});

test('motion brought in as BVH converts to a clip that plays the same', { skip: noSpec }, async () => {
  // a BVH written from a starter clip on Spec's skeleton (Euler ZXY per joint), converted back
  const c = readVrma(clipBytes('cheer'));
  const chain = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];
  const legs = (s) => [`${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`, `${s}Toes`];
  const arms = (s) => [`${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`];
  const names = { hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head' };
  for (const [s, S] of [['left', 'Left'], ['right', 'Right']]) Object.assign(names, { [`${s}UpperLeg`]: `${S}UpLeg`, [`${s}LowerLeg`]: `${S}Leg`, [`${s}Foot`]: `${S}Foot`, [`${s}Toes`]: `${S}ToeBase`, [`${s}Shoulder`]: `${S}Shoulder`, [`${s}UpperArm`]: `${S}Arm`, [`${s}LowerArm`]: `${S}ForeArm`, [`${s}Hand`]: `${S}Hand` });
  const RW = spec.restWorld;
  const off = (b, p) => RW[b].map((v, i) => (v - (p ? RW[p][i] : 0)) * 100);
  const order = [];
  const joint = (b, p, kids, ind) => {
    order.push(b);
    const o = off(b, p).map((v) => v.toFixed(4)).join(' ');
    let s = `${ind}${p ? 'JOINT' : 'ROOT'} ${names[b]}\n${ind}{\n${ind}  OFFSET ${p ? o : '0 0 0'}\n${ind}  CHANNELS ${p ? 3 : 6} ${p ? '' : 'Xposition Yposition Zposition '}Zrotation Xrotation Yrotation\n`;
    for (const k of kids) s += k;
    if (!kids.length) s += `${ind}  End Site\n${ind}  {\n${ind}    OFFSET 0 -2 0\n${ind}  }\n`;
    return s + `${ind}}\n`;
  };
  const line = (list, p, ind) => (list.length ? joint(list[0], p, [line(list.slice(1), list[0], ind + '  ')].filter(Boolean), ind) : '');
  const hier = joint('hips', null, [
    joint('spine', 'hips', [joint('chest', 'spine', [joint('upperChest', 'chest', [
      joint('neck', 'upperChest', [joint('head', 'neck', [], '            ')], '          '),
      line(arms('left'), 'upperChest', '          '), line(arms('right'), 'upperChest', '          '),
    ], '        ')], '      ')], '    '),
    line(legs('left'), 'hips', '    '), line(legs('right'), 'hips', '    '),
  ], '');
  // the motion's columns follow the joints in the order the hierarchy lists them
  const byName = Object.fromEntries(Object.entries(names).map(([b, n]) => [n, b]));
  order.length = 0;
  for (const m of hier.matchAll(/(?:ROOT|JOINT) (\w+)/g)) order.push(byName[m[1]]);
  const k = spec.scaleHeight / c.restHips[1];
  const euler = new THREE.Euler();
  let motion = `MOTION\nFrames: ${c.frames}\nFrame Time: ${1 / 30}\n`;
  for (let f = 0; f < c.frames; f++) {
    const vals = [];
    for (const b of order) {
      if (b === 'hips') vals.push(...[c.hips[f * 3] * k, c.hips[f * 3 + 1] * k, c.hips[f * 3 + 2] * k].map((v) => (v * 100).toFixed(4)));
      const q = c.bones[b] ? Array.from(c.bones[b].subarray(f * 4, f * 4 + 4)) : [0, 0, 0, 1];
      euler.setFromQuaternion(new THREE.Quaternion(...q), 'ZXY');
      vals.push(...[euler.z, euler.x, euler.y].map((r) => ((r * 180) / Math.PI).toFixed(5)));
    }
    motion += vals.join(' ') + '\n';
  }
  const bvh = `HIERARCHY\n${hier}${motion}`;
  const r = await importMotion(new TextEncoder().encode(bvh), 'cheer.bvh', { bvh: { fingers: false } });
  assert.equal(r.kind, 'bvh');
  assert.equal(r.clip.frames, c.frames);
  // the same pose on Spec: joint places within 2 cm, frame by frame (fingers left out of the BVH)
  let worst = 0;
  for (let f = 0; f < c.frames; f += 5) {
    const a = poseAt(c, spec, f), b2 = poseAt(r.clip, spec, f);
    for (const bn of ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']) worst = Math.max(worst, Math.hypot(...a.pos[bn].map((v, i) => v - b2.pos[bn][i])));
  }
  assert.ok(worst < 0.02, `BVH round trip: ${worst} m`);
});

test('a Mixamo rig is retargeted onto the normalized humanoid', () => {
  // a Mixamo-like hierarchy whose bones rest turned (as Mixamo's do), with a clip that bends the left elbow 90°
  const root = new THREE.Group();
  const mk = (name, parent, pos, rot) => { const o = new THREE.Bone(); o.name = name; o.position.set(...pos); o.quaternion.setFromEuler(new THREE.Euler(...rot)); parent.add(o); return o; };
  const hips = mk('mixamorigHips', root, [0, 100, 0], [0.1, 0, 0]);
  const spine = mk('mixamorigSpine', hips, [0, 10, 0], [-0.1, 0, 0]);
  const arm = mk('mixamorigLeftArm', spine, [15, 30, 0], [0, 0, -Math.PI / 2]);
  const fore = mk('mixamorigLeftForeArm', arm, [0, 25, 0], [0, 0.3, 0]);
  root.updateMatrixWorld(true);
  const restW = (o) => o.getWorldQuaternion(new THREE.Quaternion());
  const Wf = restW(fore);
  // the pose: forearm turned 90° about world Y in the normalized frame → local key = Wp⁻¹ · N · W ... keyed as Mixamo stores it
  const N = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const Wp = restW(arm);
  const key = Wp.clone().invert().multiply(N).multiply(Wf);
  const times = [0, 1];
  const tracks = [
    new THREE.QuaternionKeyframeTrack('mixamorigLeftForeArm.quaternion', times, [...fore.quaternion.toArray(), ...key.toArray()]),
    new THREE.VectorKeyframeTrack('mixamorigHips.position', times, [0, 100, 0, 0, 100, 50]),
  ];
  const clip = mixamoToClip(root, new THREE.AnimationClip('mixamo.com', 1, tracks), THREE, { fps: 30 });
  assert.ok(Math.abs(clip.restHips[1] - 1) < 1e-6, 'centimetres to metres');
  const q = Array.from(clip.bones.leftLowerArm.subarray(30 * 4, 31 * 4));
  assert.ok(qangle(q, N.toArray()) < 1e-3, 'normalized rotation is the pose in the world');
  assert.ok(qangle(Array.from(clip.bones.leftLowerArm.subarray(0, 4)), [0, 0, 0, 1]) < 1e-3, 'rest is identity');
  assert.ok(Math.abs(clip.hips[30 * 3 + 2] - 0.5) < 1e-6);
  void qrot;
});

// ---- VRMXA 0.31 (SPEC-QUESTIONS #64–#68, D34) ------------------------------------------------------------------------------
import { jsonBytes } from '../src/bytes.js';
import { migrateCorrections, flattenClip, editOf, editPath, EDIT_FORMAT, HINTS_KEY, figureOf } from '../src/anim/index.js';
import { checkAnimations } from '../src/checker.js';

test('a corrected clip names its original and keeps its corrections in an edit document; rate and groundedFor are written', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  const walk = animationsOf(b).clips.find((c) => c.name === 'Walk');
  const fig = { ...boots, of: { base: b.manifest.base.sha256, edits: null } };
  const r = await correctClip(b, walk.sha256, [{ kind: 'loop', startFacing: true, blend: 0.13 }, { kind: 'ground', figure: figureOf(fig) }, { kind: 'groundSpeed' }], { rig: spec, figure: fig });
  const rec = animationsOf(b).clips.find((c) => c.sha256 === r.result);
  assert.equal(rec.derivedFrom, walk.sha256);
  assert.equal(rec.edit, editPath(r.result));
  assert.equal(rec.rate, 1);
  assert.deepEqual(rec.groundedFor, { base: b.manifest.base.sha256, lift: 0.0313, edits: null });
  assert.equal(rec[HINTS_KEY], undefined, 'the hints stay on the original');
  const ed = editOf(b, rec);
  assert.equal(ed.format, EDIT_FORMAT);
  assert.equal(ed.version, 1);
  assert.equal(ed.corrections.length, 3);
  assert.deepEqual(r.after.problems, [], 'grounded for her: the checker reads groundedFor');
  // other shoes: the clip shows again as set for another figure
  const higher = { ...withLift(spec, 0.05, 'Spec in platforms'), of: { base: b.manifest.base.sha256, edits: null } };
  const again = checkClip(readVrma(b.entries.get(rec.file)), { details: rec, rig: spec, figure: higher });
  assert.ok(again.problems.some((p) => p.id === 'floor-dressed'));
  // a rate baked into the keys
  const hook = animationsOf(b).clips.find((c) => c.name === 'Hook');
  assert.equal(hook.rate, 1.3);
  const h = await correctClip(b, hook.sha256, [{ kind: 'speed', rate: 1.3, bake: true }], { rig: spec });
  const hrec = animationsOf(b).clips.find((c) => c.sha256 === h.result);
  assert.equal(hrec.rate, 1);
  assert.ok(!h.after.problems.some((p) => p.id === 'playback'));
  assert.ok(Math.abs(hrec.duration - hook.duration / 1.3) < 0.02);
  await holds(b, 'derivedFrom, edit, rate, groundedFor');
});

test('the original stays while an edit document refers to it; kept fixed, it may go (D34)', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  const sit = animationsOf(b).clips.find((c) => c.name === 'Sit down');
  const r = await correctClip(b, sit.sha256, [{ kind: 'pinFoot', foot: 'both', from: 0.5, to: 2.97, mode: 'floor' }], { rig: spec });
  // the validator refuses an edit document whose original is gone
  const doc = animationsOf(b);
  doc.clips = doc.clips.filter((c) => c.sha256 !== sit.sha256);
  assert.ok((await checkAnimations(doc, b.entries)).some((p) => p.code === 'animations.edit-original'));
  // removing the original takes the corrected clip and its edit document with it
  const b2 = await readBundle(await writeBundle(b));
  const gone = await removeClip(b2, sit.sha256);
  assert.deepEqual(new Set(gone.removed), new Set([sit.sha256, r.result]));
  assert.ok(!b2.entries.has(editPath(r.result)));
  await holds(b2, 'original removed with its corrected clip');
  // kept fixed: the edit document goes, derivedFrom stays, and the original may be removed alone
  await flattenClip(b, r.result);
  const rec = animationsOf(b).clips.find((c) => c.sha256 === r.result);
  assert.equal(rec.edit, undefined);
  assert.equal(rec.derivedFrom, sit.sha256);
  const g2 = await removeClip(b, sit.sha256);
  assert.deepEqual(g2.removed, [sit.sha256]);
  assert.ok(animationsOf(b).clips.some((c) => c.sha256 === r.result), 'the corrected clip stays, naming where it came from');
  await holds(b, 'original removed after its corrections were kept fixed');
});

test('a bundle with the app\'s old corrections file is moved to the 0.31 fields', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  const sit = animationsOf(b).clips.find((c) => c.name === 'Sit down');
  const hook = animationsOf(b).clips.find((c) => c.name === 'Hook');
  const ops = [{ kind: 'pinFoot', foot: 'both', from: 0.5, to: 2.97, mode: 'floor' }];
  const r = await correctClip(b, sit.sha256, ops, { rig: spec });
  // rebuild what an older build wrote: no derivedFrom, edit, rate or hints on records; the x-xocialize file instead
  const doc = animationsOf(b);
  const old = { format: 'x-xocialize.clip-corrections', version: 1, clips: [] };
  for (const c of doc.clips) {
    const hints = c[HINTS_KEY];
    if (hints || c.rate !== undefined) old.clips.push({ original: c.sha256, result: null, ops: [], hints: { ...(hints || {}), ...(c.rate && c.rate !== 1 ? { playbackRate: c.rate } : {}) } });
    delete c[HINTS_KEY]; if (!c.derivedFrom) delete c.rate;
  }
  const res = doc.clips.find((c) => c.sha256 === r.result);
  old.clips.find((e) => e.original === sit.sha256).result = r.result;
  old.clips.find((e) => e.original === sit.sha256).ops = ops;
  delete res.derivedFrom; delete res.edit; delete res.rate;
  b.entries.delete(editPath(r.result));
  const { setDocument, setEntry } = await import('../src/vrmxa.js');
  setDocument(b, 'animations', doc);
  setEntry(b, CORRECTIONS_PATH, jsonBytes(old));
  const read = await readBundle(await writeBundle(b));
  assert.ok(read.entries.has(CORRECTIONS_PATH));
  const m = await migrateCorrections(read);
  assert.equal(m.moved, 1);
  assert.ok(!read.entries.has(CORRECTIONS_PATH));
  const moved = animationsOf(read).clips.find((c) => c.sha256 === r.result);
  assert.equal(moved.derivedFrom, sit.sha256);
  assert.deepEqual(editOf(read, moved).corrections, ops);
  assert.equal(animationsOf(read).clips.find((c) => c.sha256 === hook.sha256).rate, 1.3);
  assert.ok(animationsOf(read).clips.find((c) => c.name === 'Idle (restless)')[HINTS_KEY].loopBlend);
  await holds(read, 'moved forward');
});

test('between two sets of the same kind and priority, the one listed first wins (VRMXA §8.3)', () => {
  const doc = { sets: [
    { id: 'd', name: 'Default', default: true, priority: 0, requires: [], slots: { idle: [{ clip: 'i' }], walk: [{ clip: 'w0' }] } },
    { id: 'a', name: 'First', priority: 5, requires: ['footwear:heels'], slots: { walk: [{ clip: 'w1' }] } },
    { id: 'b', name: 'Second', priority: 5, requires: ['footwear:heels'], slots: { walk: [{ clip: 'w2' }] } },
    { id: 'c', name: 'Brought', priority: 5, requires: ['footwear:heels'], from: 'item', slots: { walk: [{ clip: 'w3' }], run: [{ clip: 'r3' }] } },
  ] };
  const s = resolveSlots(doc, new Set(['footwear:heels']));
  assert.equal(s.walk.set.name, 'First');
  assert.equal(s.run.set.name, 'Brought', 'a slot only the brought set fills still comes from it');
  doc.sets.splice(1, 2, doc.sets[2], doc.sets[1]);
  assert.equal(resolveSlots(doc, new Set(['footwear:heels'])).walk.set.name, 'Second');
  doc.sets = [doc.sets[0], doc.sets[3], doc.sets[1], doc.sets[2]];
  assert.equal(resolveSlots(doc, new Set(['footwear:heels'])).walk.set.name, 'Second', 'the character\'s own before a brought set, wherever it is listed');
});

test('groundedFor.lift is the shoes plus the body\'s own lift, not the hips: an edited body in boots (VRMXA §8.4)', { skip: noSpec }, async () => {
  const b = createBundle({ avatar: AVATAR });
  await addStarterClips(b, starterFiles(), listing);
  // an edited body 4 % taller (its hips 3.6 cm above Spec's), as the stage gives it: Spec's scale height, in 3.1 cm boots
  const { makeRig } = await import('../src/anim/rig.js');
  const tall = makeRig(Object.fromEntries(Object.entries(spec.restWorld).map(([k, v]) => [k, [v[0] * 1.04, v[1] * 1.04, v[2] * 1.04]])), { scaleHeight: spec.scaleHeight, label: 'a taller body' });
  const edits = 'e'.repeat(64);
  const fig = { ...withLift(tall, 0.0313, 'a taller body in boots'), of: { base: b.manifest.base.sha256, edits } };
  assert.ok(fig.restWorld.hips[1] - spec.restWorld.hips[1] > 0.06, 'her hips stand more than 6 cm over Spec\'s');
  const walk = animationsOf(b).clips.find((c) => c.name === 'Walk');
  const r = await correctClip(b, walk.sha256, [{ kind: 'ground', figure: figureOf(fig) }, { kind: 'groundSpeed' }, { kind: 'loop', startFacing: true, blend: 0.13 }], { rig: spec, figure: fig });
  const rec = animationsOf(b).clips.find((c) => c.sha256 === r.result);
  assert.ok(Math.abs(rec.groundedFor.lift - 0.031) < 0.001, `lift ${rec.groundedFor.lift}`);
  assert.equal(rec.groundedFor.edits, edits);
  assert.ok(!r.after.problems.some((p) => p.id === 'floor-dressed'), 'grounded for her');
  // other shoes: reported again; other edits: reported again
  const clip = readVrma(b.entries.get(rec.file));
  const shoes = { ...withLift(tall, 0.05, 'in platforms'), of: { base: b.manifest.base.sha256, edits } };
  assert.ok(checkClip(clip, { details: rec, rig: spec, figure: shoes }).problems.some((p) => p.id === 'floor-dressed'));
  const other = { ...fig, of: { base: b.manifest.base.sha256, edits: 'f'.repeat(64) } };
  const again = checkClip(clip, { details: rec, rig: spec, figure: other });
  assert.equal(again.numbers.groundedFor.lift, rec.groundedFor.lift);
  assert.ok(again.problems.some((p) => p.id === 'floor-dressed'), 'set for another edit document: reported again');
  await holds(b, 'edited body in boots');
});
