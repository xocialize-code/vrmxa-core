// The importer (PRD §8.1, IMP-1 to IMP-12; VRMXW §14): a VRM opened as pieces, regrouped and classified by a
// person, each approved group moved onto Spec and written as a validated .vrmxw with the source's licence.
export { isVrm0, convertVrm0, convertVrm0Bytes, metaFromVrm0, vroidHubLicence, turnAround } from './vrm0.js';
export {
  openSource, readPieces, proposeGroups, proposeType, fitFor, typeName, termsOf, stricterMeta, listingFromVroidHub,
  vroidName, regionOf, nameHint, WORN_ACCESSORY, bodySecondaryBones,
} from './source.js';
export { specRig, donorRig, measureLift, moveOntoSpec, itemCentre, placeItemModel, placeMatrix, cleanPlace, placeEdited, quatFromTurn, WIDE } from './onSpec.js';
export {
  IMPORT_FORMAT, IMPORT_VERSION, ImportError, newImport, importProblems, resumeImport,
  movePieces, mergeGroups, splitGroup, renameGroup, classifyGroup, placeGroup, viewGroup, approveGroup, skipGroup, reopenGroup,
  importCounts, slotClashes, matchSourceHead, headEdits, setHead, importRigs, groupModel, groupItem, travelText, importApproved, importRecord, fitContexts, comesBySpecFit,
} from './session.js';
export { refitFromSource, refitProblem } from './refit.js';
export { sourceVerdicts } from './verdicts.js';
export { suitability, verdictOf, armAngles, GARMENT_TYPES } from './suitability.js';
