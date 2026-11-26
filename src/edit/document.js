// The edit document (VRMXA_Specification/EDITS.md, version 7): `appearance/edits.json`.
//
// Two views of one document:
//   • the document itself, as stored: what is read is kept, unknown keys included (VRMXA §2 rule 5,
//     PRD CHR-8), and changes are made to it key by key (setEdit), so nothing the app does not know
//     is lost on a save;
//   • the edits to apply (readEdits): known keys only, values clamped to their ranges, unknown keys
//     reported (EDITS.md §1). This is what the live view and the bake use.
//
// Nothing here touches a model. DOM-free.

import { jsonBytes, isPlainObject, clone } from '../bytes.js';
import { sha256 } from '../hash.js';
import { BODY_PARTS, BODY_SLIDERS } from './body.js';
import { SHAPES, FACE_PARTS } from './face.js';
import { HEAD_SHAPES, HEAD_DEFAULT } from './headShape.js';
import { cleanDesign, designEdited } from './hairDesign.js';

export const EDITS_FORMAT = 'vrmxa-edits';
export const EDITS_VERSION = 7;
export const EDITS_EDITOR = 'VRMXA Avatar Studio';

/** Colour roles (EDITS.md §3.2). `iris` is the app's "both eyes": it sets irisL and irisR. */
export const COLOR_ROLES = Object.freeze(['skin', 'brow', 'eyeline', 'mouth', 'eyeWhite', 'irisL', 'irisR', 'cheek', 'hair', 'hairEmission']);
/** Bone roles (EDITS.md §3.3). */
export const BONE_ROLES = Object.freeze({ iris: { key: 'iris', label: 'Iris Size', min: 0.7, max: 1.3, def: 1 } });
/** Head shapes a document may name (EDITS.md §3.5); absent means `spec`, the base's own head. */
export const STORED_HEAD_SHAPES = Object.freeze(HEAD_SHAPES.map((h) => h.id).filter((id) => id !== HEAD_DEFAULT));

export { BODY_PARTS, BODY_SLIDERS, SHAPES as FACE_SHAPES, FACE_PARTS, HEAD_SHAPES };

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isColour = (c) => Array.isArray(c) && c.length === 3 && c.every(finite);
const MORPH_KEY = /^[A-Z]+_[A-Za-z0-9_]+$/;

/** A new, empty document for a character made on this base. */
export function newEdits({ madeOn = null, editor = EDITS_EDITOR } = {}) {
  return {
    format: EDITS_FORMAT,
    version: EDITS_VERSION,
    editor,
    madeOn: madeOn ? { sha256: madeOn } : null,
    face: { morphs: {}, colors: {}, bones: {}, shapes: {} },
    body: {},
  };
}

/**
 * Can this reader apply the document? → null when it can, or the reason it can't (EDITS.md §1: a
 * newer version is opened without its edits, never applied in part).
 */
export function editsRefusal(doc) {
  if (!isPlainObject(doc)) return 'the edit document is not a JSON object';
  if (doc.format !== EDITS_FORMAT) return `the edit document's format is "${doc.format}", not "${EDITS_FORMAT}"`;
  if (!Number.isInteger(doc.version) || doc.version < 1) return `the edit document's version (${doc.version}) is not a whole number of 1 or more`;
  if (doc.version > EDITS_VERSION) return `the edit document is version ${doc.version}, newer than this app reads (${EDITS_VERSION}); the character opens without its edits`;
  return null;
}

/**
 * The edits to apply, from a stored document: known keys only, clamped, with what was ignored.
 * → { edits: { face: { morphs, colors, bones, shapes, headShape }, body, hairDesign }, ignored: [paths], refused }
 * `refused` is a reason (and `edits` empty) when the document can't be applied at all.
 */
export function readEdits(doc) {
  const edits = { face: { morphs: {}, colors: {}, bones: {}, shapes: {}, headShape: HEAD_DEFAULT }, body: {}, hairDesign: { groups: [] } };
  const ignored = [];
  const refused = doc == null ? null : editsRefusal(doc);
  if (doc == null || refused) return { edits, ignored, refused };
  const f = isPlainObject(doc.face) ? doc.face : {};
  for (const [k, w] of Object.entries(isPlainObject(f.morphs) ? f.morphs : {})) {
    if (MORPH_KEY.test(k) && finite(w)) edits.face.morphs[k] = clamp(w, 0, 1);
    else ignored.push(`face.morphs.${k}`);
  }
  for (const [k, c] of Object.entries(isPlainObject(f.colors) ? f.colors : {})) {
    if (COLOR_ROLES.includes(k) && isColour(c)) edits.face.colors[k] = c.map((v) => clamp(v, 0, 1));
    else ignored.push(`face.colors.${k}`);
  }
  for (const [k, s] of Object.entries(isPlainObject(f.bones) ? f.bones : {})) {
    const b = BONE_ROLES[k];
    if (b && finite(s)) edits.face.bones[k] = clamp(s, b.min, b.max);
    // versions 1 and 2 kept Head Size as a bone scale (0.85 … 1.15); it is body.headSize since 3
    else if (k === 'head' && finite(s) && doc.version < 3) edits.body.headSize = round(clamp((s - 1) / 0.15, -1, 1));
    else ignored.push(`face.bones.${k}`);
  }
  for (const [k, v] of Object.entries(isPlainObject(f.shapes) ? f.shapes : {})) {
    const sh = SHAPES[k];
    if (sh && finite(v)) edits.face.shapes[k] = clamp(v, sh.min, sh.max);
    else ignored.push(`face.shapes.${k}`);
  }
  if (f.headShape != null) {
    if (STORED_HEAD_SHAPES.includes(f.headShape)) edits.face.headShape = f.headShape;
    else ignored.push('face.headShape');
  }
  for (const k of Object.keys(f)) if (!['morphs', 'colors', 'bones', 'shapes', 'headShape'].includes(k)) ignored.push(`face.${k}`);
  for (const [k, v] of Object.entries(isPlainObject(doc.body) ? doc.body : {})) {
    if (BODY_SLIDERS[k] && finite(v)) edits.body[k] = clamp(v, -1, 1);
    else ignored.push(`body.${k}`);
  }
  if (doc.hairDesign != null) {
    const { design, ignored: bad } = cleanDesign(doc.hairDesign);
    edits.hairDesign = design;
    for (const b of bad) ignored.push(`hairDesign.${b}`);
  }
  // `items` (version 5's per-item fit) belongs to the closet document in a version 5 bundle (EDITS.md §5)
  for (const k of Object.keys(doc)) if (!['format', 'version', 'editor', 'madeOn', 'face', 'body', 'items', 'hairDesign'].includes(k)) ignored.push(k);
  return { edits, ignored, refused: null };
}

/** True when the edits change anything about the look. */
export function editsChangeLook(edits) {
  const f = edits?.face || {};
  return Object.values(f.morphs || {}).some((w) => Math.abs(w) > 1e-4)
    || Object.entries(f.colors || {}).some(([k, c]) => (k === 'hairEmission' ? c.some((v) => v > 1e-3) : c.some((v) => Math.abs(v - 1) > 1e-3)))
    || Object.values(f.bones || {}).some((s) => Math.abs(s - 1) > 1e-4)
    || Object.entries(f.shapes || {}).some(([k, v]) => Math.abs(v - (SHAPES[k]?.def ?? 0)) > 1e-4)
    || (f.headShape && f.headShape !== HEAD_DEFAULT)
    || Object.values(edits?.body || {}).some((v) => Math.abs(v) > 1e-4)
    || designEdited(edits?.hairDesign);
}

/**
 * Bring an older document up to version 7 for writing: Head Size moves from face.bones.head to
 * body.headSize (versions 1–2). Everything else in versions 1–6 means the same in 7. Unknown keys
 * stay. A document newer than 7 is returned as it is (it is never rewritten).
 */
export function upgradeEdits(doc) {
  if (!isPlainObject(doc) || editsRefusal(doc) || doc.version === EDITS_VERSION) return doc;
  const out = clone(doc);
  const head = out.face?.bones?.head;
  if (out.version < 3 && finite(head)) {
    out.body = isPlainObject(out.body) ? out.body : {};
    out.body.headSize = round(clamp((head - 1) / 0.15, -1, 1));
    delete out.face.bones.head;
  }
  out.version = EDITS_VERSION;
  return out;
}

const PATHS = {
  face: ['morphs', 'colors', 'bones', 'shapes', 'headShape'],
};
const toPath = (p) => (Array.isArray(p) ? p : String(p).split('.'));

/**
 * Check a path and value an app (or an agent) wants to set → null, or what is wrong with it.
 * Paths: face.morphs.<KEY>, face.colors.<role>, face.bones.iris, face.shapes.<key>, face.headShape,
 * body.<slider>, hairDesign. A null value removes the key (back to the base's own).
 */
export function editProblem(path, value) {
  const [top, group, key, ...rest] = toPath(path);
  if (value === null || value === undefined) {
    if (top === 'hairDesign' && group === undefined) return null;
    if (top === 'body' && BODY_SLIDERS[group] && key === undefined) return null;
    if (top === 'face' && group === 'headShape' && key === undefined) return null;
    if (top === 'face' && PATHS.face.includes(group) && key && !rest.length) return null;
    return `no edit at "${toPath(path).join('.')}"`;
  }
  if (top === 'body') {
    if (!BODY_SLIDERS[group] || key !== undefined) return `body has no slider "${group}"; known: ${Object.keys(BODY_SLIDERS).join(', ')}`;
    return finite(value) ? null : 'a body slider takes a number from -1 to 1';
  }
  if (top === 'hairDesign') return group === undefined && isPlainObject(value) && Array.isArray(value.groups) ? null : 'hairDesign takes { groups: [...] } (EDITS.md §6)';
  if (top !== 'face' || !PATHS.face.includes(group)) return `no edit at "${toPath(path).join('.')}"`;
  if (group === 'headShape') return key === undefined && STORED_HEAD_SHAPES.includes(value) ? null : `the head shape is one of ${STORED_HEAD_SHAPES.join(', ')} (or null for Spec's own)`;
  if (!key || rest.length) return `face.${group} needs one key`;
  if (group === 'morphs') return MORPH_KEY.test(key) && finite(value) ? null : 'a face morph is KEY_Name with a weight from 0 to 1';
  if (group === 'colors') return COLOR_ROLES.includes(key) && isColour(value) ? null : `a colour role is one of ${COLOR_ROLES.join(', ')}, with [r, g, b] from 0 to 1`;
  if (group === 'bones') return BONE_ROLES[key] && finite(value) ? null : 'face.bones has only iris (0.7 to 1.3)';
  if (group === 'shapes') return SHAPES[key] && finite(value) ? null : `face.shapes has no "${key}"; known: ${Object.keys(SHAPES).join(', ')}`;
  return `no edit at "${toPath(path).join('.')}"`;
}

/** The value the document holds at a path (undefined when absent). */
export function getEdit(doc, path) {
  let at = doc;
  for (const k of toPath(path)) { if (!isPlainObject(at)) return undefined; at = at[k]; }
  return at;
}

/**
 * The document with one edit changed (a new object; the old one is untouched, for undo). Unknown keys
 * are kept. A null value removes the key. Throws on a path or value that is not an edit (editProblem).
 * Values are stored clamped to their range, so the document never holds what can't be applied.
 */
export function setEdit(doc, path, value) {
  const p = toPath(path);
  const problem = editProblem(p, value);
  if (problem) throw new Error(problem);
  const out = clone(doc) || newEdits();
  const [top, group, key] = p;
  const remove = value === null || value === undefined;
  if (top === 'hairDesign') {
    if (remove || !designEdited(cleanDesign(value).design)) delete out.hairDesign;
    else out.hairDesign = cleanDesign(value).design;
    return out;
  }
  if (top === 'body') {
    out.body = isPlainObject(out.body) ? out.body : {};
    if (remove) delete out.body[group]; else out.body[group] = round(clamp(value, -1, 1));
    return out;
  }
  out.face = isPlainObject(out.face) ? out.face : {};
  if (group === 'headShape') {
    if (remove) delete out.face.headShape; else out.face.headShape = value;
    return out;
  }
  out.face[group] = isPlainObject(out.face[group]) ? out.face[group] : {};
  if (remove) { delete out.face[group][key]; return out; }
  let v = value;
  if (group === 'morphs') v = round(clamp(value, 0, 1));
  else if (group === 'colors') v = value.map((c) => round(clamp(c, 0, 1)));
  else if (group === 'bones') v = round(clamp(value, BONE_ROLES[key].min, BONE_ROLES[key].max));
  else if (group === 'shapes') v = round(clamp(value, SHAPES[key].min, SHAPES[key].max));
  out.face[group][key] = v;
  return out;
}

/** Several edits at once: [[path, value], …] → a new document. */
export function setEdits(doc, changes) {
  let out = doc;
  for (const [p, v] of changes) out = setEdit(out, p, v);
  return out;
}

const round = (v) => Math.round(v * 1e6) / 1e6;

/** The document as it is written into a bundle: version 7, this editor, no `items` (EDITS.md §5). */
export function editsForSave(doc, { editor = EDITS_EDITOR, madeOn } = {}) {
  const out = upgradeEdits(clone(doc) || newEdits());
  if (editsRefusal(out)) return out; // a newer document is written back exactly as read
  out.format = EDITS_FORMAT;
  out.version = EDITS_VERSION;
  out.editor = editor;
  if (madeOn !== undefined) out.madeOn = madeOn ? { sha256: madeOn } : null;
  delete out.items;
  // keep the keys in the order EDITS.md §2 shows
  const order = ['format', 'version', 'editor', 'madeOn', 'face', 'body', 'items', 'hairDesign'];
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)));
}

/** The SHA-256 of the document as a bundle stores it (for avatar.of and measurements.of). */
export const editsHash = (doc) => sha256(jsonBytes(doc));

const LABELS = {
  ...Object.fromEntries(Object.entries(BODY_SLIDERS).map(([k, s]) => [`body.${k}`, s.label])),
  ...Object.fromEntries(Object.entries(SHAPES).map(([k, s]) => [`face.shapes.${k}`, s.label])),
  'face.headShape': 'Head shape', 'face.bones.iris': 'Iris size', hairDesign: 'Drawn hair',
  'face.colors.skin': 'Skin colour', 'face.colors.brow': 'Eyebrow colour', 'face.colors.eyeline': 'Eyeline colour',
  'face.colors.mouth': 'Mouth colour', 'face.colors.eyeWhite': 'Eye white colour', 'face.colors.irisL': 'Iris colour (her left eye)',
  'face.colors.irisR': 'Iris colour (her right eye)', 'face.colors.cheek': 'Blush colour', 'face.colors.hair': 'Hair colour', 'face.colors.hairEmission': 'Hair glow',
};

/** A person's name for an edit, for the undo list ("Height", "Nose Size", "Skin colour"). */
export function editLabel(path) {
  const p = toPath(path).join('.');
  if (LABELS[p]) return LABELS[p];
  if (p.startsWith('face.morphs.')) return `Face shape ${p.slice(12)}`;
  return p;
}

/** Which paths differ between two documents (known and unknown keys alike). */
export function changedPaths(a, b, prefix = []) {
  const out = [];
  const keys = new Set([...Object.keys(isPlainObject(a) ? a : {}), ...Object.keys(isPlainObject(b) ? b : {})]);
  for (const k of keys) {
    const x = a?.[k], y = b?.[k];
    if (isPlainObject(x) && isPlainObject(y) && !(prefix.length === 0 && k === 'hairDesign')) out.push(...changedPaths(x, y, [...prefix, k]));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push([...prefix, k].join('.'));
  }
  return out;
}
