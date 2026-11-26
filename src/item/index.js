// The item editor's library (PRD ITM-1 to ITM-12): editing an item on the one writer, and making a plain model
// wearable in four steps.
export {
  ItemEditError, itemMeshes, itemSprings, allTags, setName, setWear, repin, addState, updateState, removeState, moveState, stateMatrix, partsShown, setPartShown,
  splitMesh, renameMesh, setSpring, setTags, setMeta, setListing, setOrigin, addClip, removeClip, setSets, saveItem, duplicateAsNew, itemChanged,
} from './edit.js';
export { WEAR_STEPS, plainModelInfo, specLandmarks, autoPlace, bindToSpec, makeWearable, wearSpec } from './wearable.js';
