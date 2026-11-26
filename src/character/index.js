// @xocialize/vrmxa-core/character — a character's details, licence and origin (VRMXA §5.3), honouring licences (PRD
// §14), export and share (§15).
export { RESTRICTED, PERMISSION_KEYS, USAGE_FLAGS, ORDER, SPEC_PERMISSIONS, rank, stricter, effective, wordsFor, termsOf, licenceLine, permissionsOf, looserThanPieces, looserLines } from './terms.js';
export {
  VRM_LICENCE, PERMISSIONS_CHOSEN, HONOURED_PREFIX, DETAIL_KEYS, DetailsError, newCharacterMeta, avatarMeta, databaseData, writeDatabase,
  permissionLimits, piecesOf, detailsOf, detailsProblems, setDetails, setListing, settingOf, setSetting, setWholeMeta, characterSnapshot, restoreCharacter, permissionsState, effectiveMeta, withPermissions, writeShownPermissions, partsOf, TIGHTENED_PREFIX, tighteningFor, tighteningLines, tightenPermissions, looseningOffer, loosenPermissions,
} from './details.js';
export { termsToAsk, answeredTerms, questionsBeforeWearing, tighteningQuestions, answerSetting, credits, shareReport, vrmShareReport, licenceTable } from './honour.js';
export { ExportError, copyBundle, vrmLeavesOut, exportVrm, exportItem, shareCopy } from './export.js';
export { drawThumbnail, bustCamera, BUST } from './thumbnail.js';
