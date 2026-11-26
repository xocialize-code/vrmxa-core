// Measuring the edited body (VRMXA §6, FITTING.md §4): Spec with the body's edits written in,
// measured by the measurer, with `of` naming the base and the edit document it was measured from.

import { measureVrm } from '../measure/measure.js';
import { sha256 } from '../hash.js';
import { bakeAvatar } from './bake.js';
import { editsHash } from './document.js';

/**
 * → the `vrm-body-measurements` document of Spec with these edits, `of: { base, edits }` added
 * (edits: the SHA-256 of the document as the bundle stores it; null when there is none).
 */
export async function measureEdits(specBytes, doc, { file = 'avatar.vrm' } = {}) {
  const { bytes } = bakeAvatar(specBytes, doc, { bodyOnly: true });
  const of = { base: await sha256(specBytes), edits: doc ? await editsHash(doc) : null };
  return measureVrm(bytes, { file, of });
}
