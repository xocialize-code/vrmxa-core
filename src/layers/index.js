// @xocialize/vrmxa-core/layers — the layer system shared by the eye, mouth and skin editors (VRMXA §6.0, D37)
// and the one flattener that writes every finished texture (PRD REF-10).
export { flattenTarget, scaleAboutEyes, eyesOf, adjuster, toLab, fromLab, appliesTo, bandOf, inBands, BANDS } from './flatten.js';
export { flattenEyes, flattenSkin, eyeTarget, pictureLoader, materialPicture, eyeStateTextures, layerTextures, refreshBakedEyes, SCALED_TARGETS } from './documents.js';
