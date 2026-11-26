// The VRM 1.0 humanoid hierarchy (humanoid.md), the groups the timeline shows, and the bones the
// checker and the corrections lean on.
//
// The humanoid parent table, grouped for the Motion screen's lanes (Body, Arms, Legs, Fingers, Face).

export const PARENT = {
  spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', jaw: 'head', leftEye: 'head', rightEye: 'head',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
};
export const FINGERS = [];
for (const s of ['left', 'right']) {
  PARENT[`${s}ThumbMetacarpal`] = `${s}Hand`; PARENT[`${s}ThumbProximal`] = `${s}ThumbMetacarpal`; PARENT[`${s}ThumbDistal`] = `${s}ThumbProximal`;
  FINGERS.push(`${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`);
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    PARENT[`${s}${f}Proximal`] = `${s}Hand`; PARENT[`${s}${f}Intermediate`] = `${s}${f}Proximal`; PARENT[`${s}${f}Distal`] = `${s}${f}Intermediate`;
    FINGERS.push(`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`);
  }
}
/** Every humanoid bone, parents before children. */
export const BONES = ['hips', ...Object.keys(PARENT)];
const depth = (b) => { let d = 0; for (let p = PARENT[b]; p; p = PARENT[p]) d++; return d; };
BONES.sort((a, b) => depth(a) - depth(b));

/** The timeline's lanes (design: Body, Arms, Legs, Fingers, then Face). */
export const LANES = [
  { id: 'body', label: 'Body', bones: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw'] },
  { id: 'arms', label: 'Arms', bones: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'] },
  { id: 'legs', label: 'Legs', bones: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'] },
  { id: 'fingers', label: 'Fingers', bones: FINGERS },
];
export const laneOf = (bone) => LANES.find((l) => l.bones.includes(bone))?.id || 'body';

/** The nearest ancestor of `bone` that `has` (a Set or a function) holds, or null. */
export function presentParent(bone, has) {
  const ok = typeof has === 'function' ? has : (b) => has.has(b);
  let p = PARENT[bone];
  while (p && !ok(p)) p = PARENT[p];
  return p || null;
}

export const LEG = (side) => ({ upper: `${side}UpperLeg`, lower: `${side}LowerLeg`, foot: `${side}Foot`, toes: `${side}Toes` });
export const SIDES = ['left', 'right'];

/** Expression presets of VRM 1.0 (gaze ones are not animated as weights in a .vrma). */
export const EXPRESSION_PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'neutral'];
