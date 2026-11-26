// The edit library (PRD REF-1, phase 2): the edit document (EDITS.md version 7) read, changed and
// written; applied to Spec and written into a VRM 1.0 (avatar.vrm); the edited body measured.
// DOM-free: browsers and Node. The live view in three.js is `@xocialize/vrmxa-core/edit/three`.

export {
  EDITS_FORMAT, EDITS_VERSION, EDITS_EDITOR, COLOR_ROLES, BONE_ROLES, STORED_HEAD_SHAPES,
  BODY_PARTS, BODY_SLIDERS, FACE_SHAPES, FACE_PARTS, HEAD_SHAPES,
  newEdits, editsRefusal, readEdits, editsChangeLook, upgradeEdits, editProblem, getEdit, setEdit, setEdits,
  editsForSave, editsHash, editLabel, changedPaths,
} from './document.js';
export { bakeAvatar, bakeHairDesign, headFrame } from './bake.js';
export { mergeItemModel, rigByName, HAIR_MARK } from './merge.js';
export { measureEdits } from './measure.js';
export { bodyRig, bodyShape, groundLift, soleSamples, bakeBody, bodyEdited, AMOUNTS as BODY_AMOUNTS } from './body.js';
export { faceInfo, faceLandmarks, deformPositions, morphKey, blushOn, shapesEdited, irisDiffers, SHAPES } from './face.js';
export { HEAD_TUNES, HEAD_DEFAULT, headShapeOf, headEdited, scanHead, headField, targetMap, gapToBase } from './headShape.js';
export { matchHead, donorHeadFromBytes, MATCH_SECTIONS, DEFAULT_SECTIONS, MATCH_KEYS, scanMatchHead, alignHead, faceHeight, readDonor, donorHead } from './headMatch.js';
export { HAIR_PARAMS, TEXTURE_PARAMS, CROSS_SECTIONS, MAX_GROUPS, MAX_STRANDS, MAX_POINTS, newGroup, cleanDesign, designEdited, smoothStroke, thinStroke, strandMesh, hairDesignMesh, paramOf } from './hairDesign.js';
export { overlay, paintBlush, overlayColour, blushRgb, blushAlpha, hairStrandTexture, BLUSH_SPREAD, CHEEK_BASE } from './pixels.js';
export { decodePng, encodePng, isPng, PngError } from './png.js';
export { hairDesignToItem } from './hairItem.js';
