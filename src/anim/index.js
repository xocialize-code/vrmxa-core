// @xocialize/vrmxa-core/anim — animation sets and clip correction (PRD phase 6, ANI): clips read and
// written as .vrma, BVH and Mixamo FBX brought in, the checker, the corrections, the sets, and the
// operations on a character's bundle. Plain JavaScript, no three.js (except reading FBX).

export { readVrma, writeVrma, isVrma, cloneClip, clipTracks, keyCount, rotAt, hipsAt, DEFAULT_FPS } from './clip.js';
export { rigFromVrm, rigFromClip, makeRig, withLift, poseAt, solePoints, sampleClip, facingOf } from './rig.js';
export { track, contactSpans, treadmill, seam, travel, meanDeg, CONTACT } from './analyse.js';
export { checkClip, checkLines, CHECK } from './check.js';
export { applyCorrections, solveLeg, opLabel, opRange, figureOf, boneList, OPS } from './correct.js';
export { suggestCorrections, autoCorrect } from './fix.js';
export { emptyAnimations, activeSets, resolveSlots, pickClip, clipUses, isSlot, isTag, setActive } from './sets.js';
export { starterRecord, STARTER_SETS } from './starter.js';
export { bvhToVrma, parseBVH, autoMap } from './bvh.js';
export { mixamoToClip, readMixamoFbx, MIXAMO } from './fbx.js';
export { importMotion, motionKind } from './bring.js';
export {
  animationsOf, correctionsOf, correctionFor, findClip, addClip, addStarterClips, setClipDetails, clipLicenceProblem, removeClip, correctClip, flattenClip,
  createSet, updateSet, setSlot, removeSet, equippedState, motionPlan, guessDetails, MotionError, CORRECTIONS_PATH, CORRECTIONS_FORMAT,
  migrateCorrections, editOf, editPath, groundedForOf, liftOf, EDIT_FORMAT, HINTS_KEY,
} from './motion.js';
export { PARENT, BONES, LANES, laneOf, FINGERS, EXPRESSION_PRESETS } from './humanoid.js';
