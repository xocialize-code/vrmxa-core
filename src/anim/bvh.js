// BVH → .vrma (PRD ANI-1): our BVH converter, without its command-line part (which imports node: modules
// at the top level), so it bundles for the browser.

// bvh-to-vrma.mjs — turn a BVH motion-capture file into a VRM Animation (.vrma, VRMC_vrm_animation 1.0).
// No dependencies; also importable (browser or Node):
//
//   import { bvhToVrma } from './bvh-to-vrma.mjs';
//   const { glb, report } = bvhToVrma(bvhText, { fps: 30 });   // glb: Uint8Array
//
// CLI:
//   node bvh-to-vrma.mjs in.bvh [out.vrma] [options]
//     --fps N            resample to N keys per second (default 30, the spec's guideline; 0 = keep source frames)
//     --tpose rest       reference T-pose is the BVH rest pose (all rotations zero)            [default]
//     --tpose frame:N    reference T-pose is frame N of the motion (many files open with a T-pose)
//     --tpose align      rest pose, with arms and legs straightened onto the VRM T-pose axes (for A-pose rests)
//     --map file.json    {"humanBoneName": "BVH joint name", ...} overrides for the automatic mapping
//                        (a value of null leaves that bone out)
//     --print-map        print the resolved mapping and the checks, write nothing
//     --scale S          multiply positions by S (default: auto, so the hips sit between 0.4 and 1.5 m)
//     --yaw DEG          extra turn about the up axis after the automatic facing fix
//     --in-place         drop horizontal hips travel (keeps the vertical bounce), for game locomotion loops
//     --start S --end E  only this time range, in seconds
//     --no-fingers       leave finger bones out
//
// How it works (spec: VRMC_vrm_animation-1.0/how_to_transform_human_pose.md):
//   normalized world rotation of a bone  N(t) = W(t) · W_tpose⁻¹
//   normalized local rotation            n(t) = N_parentHumanBone(t)⁻¹ · N(t)
// Every node in the written file has an identity rest rotation, so the tracks are already "normalized"
// pose data and a loader has nothing to convert. Joints that map to no humanoid bone (extra spine links,
// hip joints, twist bones) are folded into the next mapped bone because world rotations are used.

// ------------------------------------------------------------------ math (quaternions are [x, y, z, w])
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
const qaxis = (x, y, z, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [x * s, y * s, z * s, Math.cos(h)]; };
const qrot = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
};
const qslerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qnorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
};
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vunit = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** shortest rotation taking unit vector a onto unit vector b */
const qfromTo = (a, b) => {
  const d = vdot(a, b);
  if (d < -0.999999) { const ax = vunit(Math.abs(a[0]) < 0.9 ? vcross(a, [1, 0, 0]) : vcross(a, [0, 1, 0])); return [ax[0], ax[1], ax[2], 0]; }
  const c = vcross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
};
/** rotation whose matrix has the given rows (rows = where the source axes land on X, Y, Z) */
const qfromRows = (r0, r1, r2) => {
  const m00 = r0[0], m01 = r0[1], m02 = r0[2], m10 = r1[0], m11 = r1[1], m12 = r1[2], m20 = r2[0], m21 = r2[1], m22 = r2[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return qnorm(q);
};
const snapAxis = (v) => { const a = v.map(Math.abs); const i = a.indexOf(Math.max(...a)); const o = [0, 0, 0]; o[i] = Math.sign(v[i]) || 1; return o; };
const deg = (rad) => (rad * 180) / Math.PI;

// ------------------------------------------------------------------ BVH parsing
/**
 * @returns {{joints: {name:string,parent:number,offset:number[],channels:string[],chan0:number,end:boolean,children:number[]}[],
 *            frames: Float64Array[], frameTime:number, channelCount:number}}
 */
export function parseBVH(text) {
  const tok = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const next = () => tok[i++];
  const expect = (w) => { const t = next(); if (!t || t.toUpperCase() !== w) throw new Error(`BVH: expected ${w}, got ${t} (token ${i})`); };
  const joints = [];
  let channelCount = 0;
  expect('HIERARCHY');
  const readJoint = (parent) => {
    const kind = next().toUpperCase();
    if (kind !== 'ROOT' && kind !== 'JOINT' && kind !== 'END') throw new Error(`BVH: unexpected ${kind}`);
    const isEnd = kind === 'END';
    let name = next();
    if (isEnd) name = `${joints[parent].name}_end`; // "End Site"
    else while (tok[i] !== '{') name += ' ' + next(); // names with spaces
    const index = joints.length;
    const j = { name, parent, offset: [0, 0, 0], channels: [], chan0: channelCount, end: isEnd, children: [] };
    joints.push(j);
    if (parent >= 0) joints[parent].children.push(index);
    expect('{');
    for (;;) {
      const t = tok[i].toUpperCase();
      if (t === 'OFFSET') { i++; j.offset = [parseFloat(next()), parseFloat(next()), parseFloat(next())]; }
      else if (t === 'CHANNELS') { i++; const n = parseInt(next(), 10); for (let k = 0; k < n; k++) j.channels.push(next().toLowerCase()); channelCount += n; }
      else if (t === 'JOINT' || t === 'END') readJoint(index);
      else if (t === '}') { i++; break; }
      else throw new Error(`BVH: unexpected token ${tok[i]} inside ${name}`);
    }
  };
  while (tok[i] && tok[i].toUpperCase() === 'ROOT') readJoint(-1);
  expect('MOTION');
  next(); // Frames:
  const nFrames = parseInt(next(), 10);
  next(); next(); // Frame Time:
  const frameTime = parseFloat(next());
  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const row = new Float64Array(channelCount);
    for (let c = 0; c < channelCount; c++) row[c] = parseFloat(tok[i++]);
    if (Number.isNaN(row[channelCount - 1])) throw new Error(`BVH: frame ${f} is short (file has fewer frames than its header says)`);
    frames.push(row);
  }
  return { joints, frames, frameTime, channelCount };
}

/** Forward kinematics for one frame (row = channel values, or null for the rest pose). */
function fk(bvh, row) {
  const n = bvh.joints.length, W = new Array(n), P = new Array(n);
  for (let k = 0; k < n; k++) {
    const j = bvh.joints[k];
    let q = [0, 0, 0, 1];
    const p = [...j.offset];
    if (row) j.channels.forEach((ch, c) => {
      const v = row[j.chan0 + c];
      if (ch === 'xposition') p[0] += v; else if (ch === 'yposition') p[1] += v; else if (ch === 'zposition') p[2] += v;
      else if (ch === 'xrotation') q = qmul(q, qaxis(1, 0, 0, v));
      else if (ch === 'yrotation') q = qmul(q, qaxis(0, 1, 0, v));
      else if (ch === 'zrotation') q = qmul(q, qaxis(0, 0, 1, v));
    });
    if (j.parent < 0) { W[k] = q; P[k] = p; }
    else { W[k] = qmul(W[j.parent], q); P[k] = vadd(P[j.parent], qrot(W[j.parent], p)); }
  }
  return { W, P };
}

// ------------------------------------------------------------------ joint → humanoid bone mapping
const bare = (name) => name.replace(/^.*[:|]/, '').replace(/^mixamorig/i, '');
const PART = { hand: 'hand|wrist', foot: 'foot|ankle' };
function sideOf(name, part) {
  const s = bare(name), p = PART[part];
  if (new RegExp(`^(left|l)[ _.\\-]?(${p})$|^(${p})[ _.\\-]?(left|l)$`, 'i').test(s)) return 'left';
  if (new RegExp(`^(right|r)[ _.\\-]?(${p})$|^(${p})[ _.\\-]?(right|r)$`, 'i').test(s)) return 'right';
  return null;
}
const isTwist = (name) => /twist|roll/i.test(name);
const FINGERS = { Thumb: /thumb/i, Index: /index/i, Middle: /middle|mid(?![a-z])/i, Ring: /ring/i, Little: /pinky|pinkie|little/i };

/** @returns {{map: Record<string, number>, notes: string[]}} humanoid bone name → joint index */
export function autoMap(bvh, { fingers = true } = {}) {
  const J = bvh.joints, notes = [], map = {};
  const anc = (k) => { const a = []; for (let p = J[k].parent; p >= 0; p = J[p].parent) a.push(p); return a; }; // nearest first
  const find = (part, side) => J.findIndex((j) => !j.end && sideOf(j.name, part) === side);
  const lh = find('hand', 'left'), rh = find('hand', 'right'), lf = find('foot', 'left'), rf = find('foot', 'right');
  for (const [n, v] of [['left hand', lh], ['right hand', rh], ['left foot', lf], ['right foot', rf]]) if (v < 0) throw new Error(`could not find the ${n} joint by name; pass --map`);
  const lca = (a, b) => { const A = new Set([a, ...anc(a)]); for (const x of [b, ...anc(b)]) if (A.has(x)) return x; return -1; };
  const hips = lca(lf, rf), branch = lca(lh, rh);
  if (hips < 0 || branch < 0) throw new Error('the skeleton has no common ancestor for the feet or for the hands; pass --map');
  map.hips = hips;

  // torso: joints from hips (exclusive) up to where the arms split (inclusive)
  const torso = [];
  for (let k = branch; k !== hips && k >= 0; k = J[k].parent) torso.unshift(k);
  if (branch === hips) notes.push('arms attach directly to the hips joint: no spine joint to map (spine is required by VRM)');
  if (torso.length === 1) map.spine = torso[0];
  else if (torso.length === 2) { map.spine = torso[0]; map.chest = torso[1]; }
  else if (torso.length >= 3) {
    map.spine = torso[0]; map.upperChest = torso[torso.length - 1]; map.chest = torso[Math.floor((torso.length - 1) / 2)];
    if (torso.length > 3) notes.push(`${torso.length} spine joints: ${torso.map((k) => J[k].name).join(' → ')}; unmapped ones are folded into the next mapped bone`);
  }
  // head and neck: the non-arm chain above the branch
  let head = J.findIndex((j) => !j.end && /^head$/i.test(bare(j.name)));
  if (head < 0 || !anc(head).includes(branch)) {
    head = -1;
    for (const c of J[branch].children) if (!J[c].end && c !== lh && c !== rh && !anc(lh).includes(c) && !anc(rh).includes(c)) { let k = c; while (J[k].children.some((x) => !J[x].end)) k = J[k].children.find((x) => !J[x].end); head = k; }
    if (head >= 0) notes.push(`no joint named "Head"; using ${J[head].name}`);
  }
  if (head >= 0) {
    map.head = head;
    const neck = []; for (let k = J[head].parent; k !== branch && k >= 0; k = J[k].parent) neck.unshift(k);
    if (neck.length) map.neck = neck[0];
  }
  // limbs: walk up from the hand / foot, skipping twist joints
  const up = (k, stop) => { let p = J[k].parent; while (p >= 0 && p !== stop && isTwist(J[p].name)) p = J[p].parent; return p >= 0 && p !== stop ? p : -1; };
  for (const [side, hand, foot] of [['left', lh, lf], ['right', rh, rf]]) {
    map[`${side}Hand`] = hand;
    const lower = up(hand, branch), upper = lower < 0 ? -1 : up(lower, branch), shoulder = upper < 0 ? -1 : up(upper, branch);
    if (lower >= 0 && upper >= 0) { map[`${side}LowerArm`] = lower; map[`${side}UpperArm`] = upper; if (shoulder >= 0) map[`${side}Shoulder`] = shoulder; }
    else notes.push(`${side} arm has fewer than two joints above the hand`);
    map[`${side}Foot`] = foot;
    const shin = up(foot, hips), thigh = shin < 0 ? -1 : up(shin, hips);
    if (shin >= 0 && thigh >= 0) { map[`${side}LowerLeg`] = shin; map[`${side}UpperLeg`] = thigh; }
    else notes.push(`${side} leg has fewer than two joints above the foot`);
    const toe = J[foot].children.find((c) => !J[c].end);
    if (toe !== undefined) map[`${side}Toes`] = toe;
    if (fingers) for (const [f, re] of Object.entries(FINGERS)) {
      const first = J[hand].children.find((c) => !J[c].end && re.test(bare(J[c].name)));
      if (first === undefined) continue;
      let chain = [first];
      while (chain.length < 5) { const c = J[chain[chain.length - 1]].children.find((x) => !J[x].end); if (c === undefined) break; chain.push(c); }
      const names = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
      if (f !== 'Thumb' && chain.length >= 4) chain = chain.slice(1); // a metacarpal ("InHand") joint comes first
      names.forEach((seg, s) => { if (chain[s] !== undefined) map[`${side}${f}${seg}`] = chain[s]; });
    }
  }
  return { map, notes };
}

const HUMAN_PARENT = (() => {
  const P = { spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', jaw: 'head',
    leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
    rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
    leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
    rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm' };
  for (const s of ['left', 'right']) {
    P[`${s}ThumbMetacarpal`] = `${s}Hand`; P[`${s}ThumbProximal`] = `${s}ThumbMetacarpal`; P[`${s}ThumbDistal`] = `${s}ThumbProximal`;
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) { P[`${s}${f}Proximal`] = `${s}Hand`; P[`${s}${f}Intermediate`] = `${s}${f}Proximal`; P[`${s}${f}Distal`] = `${s}${f}Intermediate`; }
  }
  return P;
})();
const REQUIRED = ['hips', 'spine', 'head', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand'];
// bone order: parents before children
const ORDER = ['hips', ...(() => { const out = []; const add = (b) => { for (const [c, p] of Object.entries(HUMAN_PARENT)) if (p === b) { out.push(c); add(c); } }; add('hips'); return out; })()];

// ------------------------------------------------------------------ conversion
/**
 * @param {string} text BVH file contents
 * @param {{fps?:number, tpose?:string, map?:Record<string,string|null>, scale?:number, yaw?:number, inPlace?:boolean,
 *          start?:number, end?:number, fingers?:boolean}} [o]
 * @returns {{glb: Uint8Array, report: object, tracks: {times: Float32Array, hips: Float32Array, rotations: Record<string, Float32Array>}}}
 */
export function bvhToVrma(text, o = {}) {
  const bvh = parseBVH(text);
  const J = bvh.joints;
  const warnings = [];
  if (!bvh.frames.length) throw new Error('BVH has no motion frames');

  // --- mapping
  let auto = { map: {}, notes: [] };
  try { auto = autoMap(bvh, { fingers: o.fingers !== false }); }
  catch (e) { if (!o.map) throw e; warnings.push(`automatic mapping failed (${e.message}); using --map only`); }
  const map = { ...auto.map };
  for (const [bone, name] of Object.entries(o.map || {})) {
    if (name === null) { delete map[bone]; continue; }
    if (bone !== 'hips' && !(bone in HUMAN_PARENT)) throw new Error(`--map: "${bone}" is not a VRM humanoid bone name`);
    const k = J.findIndex((j) => j.name === name || bare(j.name) === name);
    if (k < 0) throw new Error(`--map: no BVH joint named "${name}" (for ${bone})`);
    map[bone] = k;
  }
  delete map.leftEye; delete map.rightEye; // not allowed in a VRM Animation
  const missing = REQUIRED.filter((b) => !(b in map));
  if (missing.length) warnings.push(`required humanoid bones not mapped: ${missing.join(', ')} (the file will not be a valid VRM Animation)`);
  const bones = ORDER.filter((b) => b in map);
  const humanParent = (b) => { let p = HUMAN_PARENT[b]; while (p && !(p in map)) p = HUMAN_PARENT[p]; return p || null; };

  // --- reference pose
  const tposeMode = o.tpose || 'rest';
  let refRow = null;
  if (tposeMode.startsWith('frame:')) {
    const f = parseInt(tposeMode.slice(6), 10);
    if (!(f >= 0 && f < bvh.frames.length)) throw new Error(`--tpose ${tposeMode}: the file has frames 0..${bvh.frames.length - 1}`);
    refRow = new Float64Array(bvh.frames[f]);
    let k = map.hips; while (J[k].parent >= 0) k = J[k].parent; // keep the pose, drop where it stood
    J[k].channels.forEach((ch, c) => { if (ch.endsWith('position')) refRow[J[k].chan0 + c] = 0; });
  } else if (tposeMode !== 'rest' && tposeMode !== 'align') throw new Error(`--tpose: expected rest, align or frame:N, got ${tposeMode}`);
  const ref = fk(bvh, refRow);

  // --- basis: turn the source so up is +Y and the figure faces +Z (its left side on +X), as VRM 1.0 does
  const upSrc = snapAxis(vsub(ref.P[map.head ?? map.spine ?? map.hips], ref.P[map.hips]));
  let leftSrc = vsub(ref.P[map.leftUpperLeg ?? map.leftFoot], ref.P[map.rightUpperLeg ?? map.rightFoot]);
  leftSrc = snapAxis(leftSrc.map((v, i) => (upSrc[i] ? 0 : v)));
  let G = qfromRows(leftSrc, upSrc, vcross(leftSrc, upSrc));
  if (o.yaw) G = qmul(qaxis(0, 1, 0, o.yaw), G);
  const Ginv = qinv(G);
  const basisChanged = Math.abs(G[3]) < 0.9999;
  const toW = (q) => qmul(qmul(G, q), Ginv);
  const refP = ref.P.map((p) => qrot(G, p));
  const refW = ref.W.map(toW);

  // --- T-pose corrections (world), then the T-pose world rotation of every mapped bone
  const child = (b) => bones.find((c) => humanParent(c) === b);
  const IDEAL = {};
  for (const [s, x] of [['left', 1], ['right', -1]]) {
    IDEAL[`${s}UpperArm`] = [x, 0, 0]; IDEAL[`${s}LowerArm`] = [x, 0, 0]; // hands, fingers, feet follow the limb they hang from
    IDEAL[`${s}UpperLeg`] = [0, -1, 0]; IDEAL[`${s}LowerLeg`] = [0, -1, 0];
  }
  const boneDir = (b) => {
    let c = child(b), tip = c ? refP[map[c]] : null;
    if (!tip) { const k = J[map[b]].children[0]; if (k !== undefined) tip = refP[k]; }
    if (!tip) return null;
    const d = vsub(tip, refP[map[b]]);
    return vlen(d) > 1e-6 ? vunit(d) : null;
  };
  const T = {}; // world correction taking the reference pose to the VRM T-pose
  const offAxis = [];
  for (const b of bones) {
    const p = humanParent(b);
    T[b] = p ? T[p] : [0, 0, 0, 1];
    if (!(b in IDEAL)) { if (/Shoulder|^spine$|chest|neck|head|hips/i.test(b)) T[b] = [0, 0, 0, 1]; continue; }
    const d = boneDir(b);
    if (!d) continue;
    const angle = deg(Math.acos(Math.max(-1, Math.min(1, vdot(d, IDEAL[b])))));
    if (angle > 20) offAxis.push(`${b} ${angle.toFixed(0)}°`);
    T[b] = tposeMode === 'align' ? qfromTo(d, IDEAL[b]) : [0, 0, 0, 1];
  }
  if (tposeMode !== 'align') for (const b of bones) T[b] = [0, 0, 0, 1];
  if (offAxis.length && tposeMode !== 'align') warnings.push(`the reference pose is not a T-pose (${offAxis.join(', ')} away from the VRM T-pose axis). The motion will look bent by that much. Try --tpose align, or --tpose frame:N if a frame holds a T-pose.`);
  const WT = {};
  for (const b of bones) WT[b] = qmul(T[b], refW[map[b]]);

  // --- T-pose joint positions (metres), for the nodes of the output file
  const ground = Math.min(...refP.map((p) => p[1]));
  const hipsHeightSrc = refP[map.hips][1] - ground;
  if (!(hipsHeightSrc > 1e-6)) throw new Error('could not measure the hips height in the reference pose');
  let scale = o.scale;
  if (!scale) scale = hipsHeightSrc >= 0.4 && hipsHeightSrc <= 1.5 ? 1 : 0.9 / hipsHeightSrc;
  const PT = { hips: [0, hipsHeightSrc * scale, 0] };
  const local = { hips: PT.hips };
  for (const b of bones) {
    if (b === 'hips') continue;
    const p = humanParent(b);
    local[b] = qrot(T[p], vsub(refP[map[b]], refP[map[p]])).map((v) => v * scale);
    PT[b] = vadd(PT[p], local[b]);
  }

  // --- sample
  const srcDur = (bvh.frames.length - 1) * bvh.frameTime;
  const t0 = Math.max(0, o.start ?? 0), t1 = Math.min(srcDur, o.end ?? srcDur);
  if (!(t1 >= t0)) throw new Error('--start/--end: empty time range');
  const fps = o.fps === 0 ? 0 : o.fps || 30;
  const step = fps ? 1 / fps : bvh.frameTime;
  const count = Math.max(1, Math.floor((t1 - t0) / step + 1e-6) + 1);
  const times = new Float32Array(count);
  const hips = new Float32Array(count * 3);
  const rotations = Object.fromEntries(bones.map((b) => [b, new Float32Array(count * 4)]));
  const poseAt = (f) => { const p = fk(bvh, bvh.frames[f]); return p; };
  let cacheF = -1, cache = null, cacheF2 = -1, cache2 = null;
  const prev = {};
  let hips0 = null;
  for (let k = 0; k < count; k++) {
    const t = t0 + k * step;
    times[k] = k * step;
    const x = Math.min(bvh.frames.length - 1, t / bvh.frameTime), f = Math.floor(x), a = x - f;
    if (f !== cacheF) { if (f === cacheF2) { cache = cache2; } else cache = poseAt(f); cacheF = f; }
    const f2 = Math.min(bvh.frames.length - 1, f + 1);
    if (f2 !== cacheF2) { cache2 = f2 === f ? cache : poseAt(f2); cacheF2 = f2; }
    const N = {};
    for (const b of bones) {
      const j = map[b];
      const w = a > 1e-6 ? qslerp(cache.W[j], cache2.W[j], a) : cache.W[j];
      N[b] = qmul(toW(w), qinv(WT[b]));
      const p = humanParent(b);
      let q = qnorm(p ? qmul(qinv(N[p]), N[b]) : N[b]);
      if (prev[b] && vdot(prev[b], q) + prev[b][3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]; // keep keys on one side
      prev[b] = q;
      rotations[b].set(q, k * 4);
    }
    const pa = cache.P[map.hips], pb = cache2.P[map.hips];
    let p = qrot(G, [pa[0] + (pb[0] - pa[0]) * a, pa[1] + (pb[1] - pa[1]) * a, pa[2] + (pb[2] - pa[2]) * a]).map((v) => v * scale);
    if (!hips0) hips0 = p;
    if (o.inPlace) p = [0, p[1], 0];
    hips.set(p, k * 3);
  }
  let minHipsY = Infinity, maxHipsY = -Infinity;
  for (let k = 0; k < count; k++) { minHipsY = Math.min(minHipsY, hips[k * 3 + 1]); maxHipsY = Math.max(maxHipsY, hips[k * 3 + 1]); }
  if (maxHipsY < PT.hips[1] * 0.3) warnings.push(`the hips never rise above ${(maxHipsY).toFixed(2)} m while the T-pose hips are at ${PT.hips[1].toFixed(2)} m: the motion's floor is probably not at height 0, or the root has no position channel`);

  const report = {
    joints: J.filter((j) => !j.end).length, frames: bvh.frames.length, sourceFps: +(1 / bvh.frameTime).toFixed(3), duration: +(times[count - 1]).toFixed(3),
    keys: count, fps: fps || +(1 / bvh.frameTime).toFixed(3), tpose: tposeMode, scale: +scale.toFixed(6), hipsHeight: +PT.hips[1].toFixed(4),
    basis: basisChanged ? `re-oriented (source up ${JSON.stringify(upSrc)}, left ${JSON.stringify(leftSrc)})` : 'already Y-up facing +Z',
    map: Object.fromEntries(bones.map((b) => [b, J[map[b]].name])),
    unmappedJoints: J.filter((j, k) => !j.end && !Object.values(map).includes(k)).map((j) => j.name),
    notes: auto.notes, warnings,
  };
  const glb = writeVrma({ bones, humanParent, local, times, hips, rotations, name: o.name || 'bvh' });
  return { glb, report, tracks: { times, hips, rotations } };
}

// ------------------------------------------------------------------ .vrma (GLB) writer
function writeVrma({ bones, humanParent, local, times, hips, rotations, name }) {
  const nodes = bones.map((b) => ({ name: b, translation: local[b].map((v) => +v.toFixed(6)) }));
  bones.forEach((b, i) => { const p = humanParent(b); if (p) (nodes[bones.indexOf(p)].children ||= []).push(i); });
  const parts = [], bufferViews = [], accessors = [];
  let offset = 0;
  const push = (arr, type, extra = {}) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    parts.push(bytes); offset += bytes.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: arr.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type, ...extra });
    return accessors.length - 1;
  };
  const tAcc = push(times, 'SCALAR', { min: [times[0]], max: [times[times.length - 1]] });
  const samplers = [], channels = [];
  const add = (node, path, acc) => { samplers.push({ input: tAcc, output: acc, interpolation: 'LINEAR' }); channels.push({ sampler: samplers.length - 1, target: { node, path } }); };
  add(0, 'translation', push(hips, 'VEC3'));
  bones.forEach((b, i) => add(i, 'rotation', push(rotations[b], 'VEC4')));
  const json = {
    asset: { version: '2.0', generator: 'bvh-to-vrma.mjs (vrm skill)' },
    extensionsUsed: ['VRMC_vrm_animation'],
    scene: 0, scenes: [{ nodes: [0] }], nodes,
    animations: [{ name, samplers, channels }],
    accessors, bufferViews, buffers: [{ byteLength: offset }],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(bones.map((b, i) => [b, { node: i }])) } } },
  };
  let jb = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jb.length % 4)) % 4;
  const total = 12 + 8 + jb.length + jpad + 8 + offset; // float data is already 4-aligned
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jb.length + jpad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jb, 20); out.fill(0x20, 20 + jb.length, 20 + jb.length + jpad);
  let p = 20 + jb.length + jpad;
  dv.setUint32(p, offset, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

// ------------------------------------------------------------------ CLI
