// The closet (PRD phase 3; REF-1, CLO, FIT-3, FIT-6): the closet protocol's operations (CLOSET.md
// §5), the fitting that stands in until Spec-fit exists, and avatar.vrm drawn from the saved look.
// DOM-free: browsers and Node.

export {
  ClosetError, emptyCloset, closetOf, slotProblems, closetProblems, avatarIsCurrent, itemOf, addItem, displacedBy, putOn, takeOff, setState,
  applyOutfit, outfitStatus, saveOutfit, makeOutfit, renameOutfit, duplicateOutfit, deleteOutfit, setFitting, changeHair, removeItem,
  copyOut, updateItem, closetSnapshot, restoreCloset,
} from './ops.js';
export {
  FIT_CONTROLS, EASES, HEM_ANCHORS, FIT_METHODS, adjustValue, adjustEdited, cleanFitting, fitPositions, decompose, stateOf, itemTags,
  methodFor, liftOf, prepareItemModel, SPEC_FIT_SLOTS, writeVec3,
} from './fit.js';
export { wornPieces, mergeWorn, drawAvatar, redrawAvatar, characterMeta } from './avatar.js';
