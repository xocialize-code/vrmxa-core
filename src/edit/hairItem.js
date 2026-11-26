// Drawn hair kept as a hair piece: the strands written onto Spec (bakeHairDesign) and cut out by the
// one item writer (extractItemModel), then made a `.vrmxw` hair item (VRMXW §6 type `hair`). It lets
// a person keep a drawn style as a piece of its own, and gives the tests a hair item made from
// nothing but Spec.

import { parseGlb } from '../glb.js';
import { extractItemModel } from '../item-writer.js';
import { createItem } from '../vrmxw.js';
import { bakeHairDesign, headFrame } from './bake.js';

/**
 * → a hair item (createItem's result), or null when the design has no strands.
 * opts: { name, meta (licence block, VRMXW §11), origin, thumbnail, id, created }
 */
export async function hairDesignToItem(specBytes, design, opts = {}) {
  const parsed = parseGlb(specBytes);
  const json = JSON.parse(JSON.stringify(parsed.json));
  const before = json.meshes.length;
  const { bin } = bakeHairDesign(json, parsed.bin.slice(), design, headFrame(json, parsed.bin));
  const prims = [];
  for (let mi = before; mi < json.meshes.length; mi++) json.meshes[mi].primitives.forEach((_, pi) => prims.push([mi, pi]));
  if (!prims.length) return null;
  const cut = extractItemModel({ json, bin }, { prims, kind: 'worn', name: opts.name || 'Drawn hair', generator: opts.generator });
  return createItem({
    model: cut.glb, rig: cut.rig, name: opts.name || 'Drawn hair', type: 'hair', slot: 'hair', kind: 'worn',
    meta: opts.meta, origin: opts.origin ?? { made: 'authored', source: 'drawn hair (EDITS.md §6)' },
    thumbnail: opts.thumbnail, id: opts.id, created: opts.created, generator: opts.generator,
  });
}
