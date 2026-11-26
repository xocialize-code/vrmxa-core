// Names, versions and paths of the two formats, shared by the readers, writers and the checker.

export const VRMXA_MANIFEST = 'vrmxa.json';
export const VRMXW_MANIFEST = 'vrmxw.json';

/** Bundle versions: 5 is written; 2 to 4 are read and brought forward (VRMXA §1, D22). */
export const BUNDLE_VERSION = 5;
export const LEGACY_BUNDLE_VERSIONS = [2, 3, 4];
export const ITEM_VERSION = 1;

/** The manifest's `meta` block (version 3's, unchanged; VRMXA §4). */
export const META_DATA_VERSION = 1;
export const BIN_ENCODING_VERSION = 1;

/** Section versions this library knows (VRMXA §2 rule 4). */
export const SECTION_VERSIONS = Object.freeze({ appearance: 1, closet: 1, animations: 1, voice: 1, persona: 1 });

/** Every section document: its role, default path, format name, newest version known, section. */
export const DOCUMENTS = Object.freeze({
  edits: { path: 'appearance/edits.json', format: 'vrmxa-edits', version: 7, section: 'appearance' },
  measurements: { path: 'appearance/measurements.json', format: 'vrm-body-measurements', version: 1, section: 'appearance' },
  eyes: { path: 'appearance/eyes/eyes.json', format: 'vrmxa-eyes', version: 1, section: 'appearance' },
  mouth: { path: 'appearance/mouth/mouth.json', format: 'vrmxa-mouth', version: 1, section: 'appearance' },
  skin: { path: 'appearance/skin/skin.json', format: 'vrmxa-skin', version: 1, section: 'appearance' },
  closet: { path: 'closet/closet.json', format: 'vrmxa-closet', version: 1, section: 'closet' },
  animations: { path: 'animations/animations.json', format: 'vrmxa-animations', version: 1, section: 'animations' },
  voices: { path: 'voice/voices.json', format: 'vrmxa-voices', version: 1, section: 'voice' },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Where a version 5 manifest says each section document is → { role: { path, declared } }, where
 * `declared` is the document's own declared format version when the manifest gives one. A role is
 * absent when its section or its entry is absent.
 */
export function documentPaths(manifest) {
  const s = isObj(manifest?.sections) ? manifest.sections : {};
  const out = {};
  const ap = isObj(s.appearance) ? s.appearance : null;
  if (ap) {
    for (const role of ['edits', 'eyes', 'mouth', 'skin']) {
      const e = ap[role];
      if (isObj(e) && typeof e.file === 'string') out[role] = { path: e.file, declared: e.version };
      else if (typeof e === 'string') out[role] = { path: e };
    }
    const m = ap.measurements;
    if (typeof m === 'string') out.measurements = { path: m };
    else if (isObj(m) && typeof m.file === 'string') out.measurements = { path: m.file, declared: m.version };
  }
  if (isObj(s.closet) && typeof s.closet.file === 'string') out.closet = { path: s.closet.file };
  if (isObj(s.animations) && typeof s.animations.file === 'string') out.animations = { path: s.animations.file };
  if (isObj(s.voice) && typeof s.voice.file === 'string') out.voices = { path: s.voice.file };
  return out;
}

/** Where the layered editors keep their pictures, named by content (VRMXA §3.3, §6.0, D37). */
export const layerPath = (sha12) => `appearance/layers/${sha12}.png`;
export const bakedPath = (sha12) => `appearance/baked/${sha12}.png`;

/** Item path in a closet (VRMXW §12): closet/items/<slot>-<id>.vrmxw, or appearance/hair/hair-<id>.vrmxw. */
export const closetItemPath = (slot, id) => (slot === 'hair' ? `appearance/hair/hair-${id}.vrmxw` : `closet/items/${slot}-${id}.vrmxw`);
