// @xocialize/vrmxa-core — the file layer of the VRMXA reference library (PRD REF-1, phase 1).
// Plain JavaScript that runs in a browser and in Node. Folder access (the open form on disk) is in
// '@xocialize/vrmxa-core/node'.

export { sha256, sha12 } from './hash.js';
export { jsonBytes, newUuid, nowIso } from './bytes.js';
export { writeZip, readZip, scanZip, inflateEntry, isZip, crc32, entryNameProblem, DEFAULT_LIMITS, ZipError } from './zip.js';
export { parseGlb, buildGlb, readAccessor, isGlb, GltfError } from './glb.js';
export { orderPaths, bundleRank, itemRank } from './container.js';
export {
  VRMXA_MANIFEST, VRMXW_MANIFEST, BUNDLE_VERSION, ITEM_VERSION, SECTION_VERSIONS, DOCUMENTS, documentPaths, closetItemPath, layerPath, bakedPath,
} from './layout.js';
export { HUMAN_BONES, ITEM_TYPES, resolveItemType, SLOTS, ANIMATION_SLOTS, META_ENUMS, BASES, findBase, standardBase } from './vocab.js';
export {
  APPLICATION_ID, SCHEMA_SQL, setSqlJsLoader, loadSqlJs, openDatabase, readCharacterDb, writeCharacterDb, checkSqliteHeader,
} from './database.js';
export {
  createBundle, readBundle, bundleFromEntries, writeBundle, bundleToEntries, setDocument, setEntry, setDatabase, setAvatar,
  touchBundle, saveAsAnotherVersion, newIdentity, avatarOf, vrmMetaOf, normalizeVersion, versionProblem,
} from './vrmxa.js';
export {
  createItem, readItem, itemFromEntries, writeItem, itemToEntries, touchItem, duplicateItem, closetEntryFor, itemFromBareGlb, RefusedError,
} from './vrmxw.js';
export { extractItemModel, metaFromVrm, humanoidOf } from './item-writer.js';
export { checkBundle, checkItem, checkModel } from './checker.js';
export { measureVrm } from './measure/measure.js';
export { measureBody } from './measure/bodyMeasure.js';
