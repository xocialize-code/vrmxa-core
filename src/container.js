// The two container forms shared by .vrmxa and .vrmxw (VRMXA §3.1, §3.2; VRMXW §3):
//   packed — one ZIP, the manifest first, a SHA-256 for every other entry in the manifest's `files`;
//   open   — the same layout as a Map of path → bytes (a folder on disk is src/node/folder.js).
// Hashes describe the packed entries and are recomputed when packing.

import { jsonBytes, parseJson } from './bytes.js';
import { sha256 } from './hash.js';
import { writeZip } from './zip.js';

/** Rank of a path in a .vrmxa, in the order of the layout (VRMXA §3.3); unknown entries go last. */
export function bundleRank(path) {
  const R = [
    [/^vrmxa\.json$/, 0],
    [/^thumbnail\.[^/]+$/, 1],
    [/^avatar\.vrm$/, 2],
    [/^character\.sqlite$/, 3],
    [/^appearance\/edits\.json$/, 4],
    [/^appearance\/measurements\.json$/, 5],
    [/^appearance\/hair\//, 6],
    [/^appearance\/eyes\/eyes\.json$/, 7],
    [/^appearance\/eyes\//, 8],
    [/^appearance\/mouth\/mouth\.json$/, 9],
    [/^appearance\/mouth\//, 10],
    [/^appearance\/textures\//, 11],
    [/^appearance\//, 12],
    [/^closet\/closet\.json$/, 13],
    [/^closet\/items\//, 14],
    [/^closet\/fitted\//, 15],
    [/^closet\/thumbs\//, 16],
    [/^closet\//, 17],
    [/^animations\/animations\.json$/, 18],
    [/^animations\/clips\//, 19],
    [/^animations\//, 20],
    [/^voice\/voices\.json$/, 21],
    [/^voice\/clips\//, 22],
    [/^voice\//, 23],
  ];
  for (const [re, r] of R) if (re.test(path)) return r;
  return 99;
}

/** Rank of a path in a .vrmxw, in the order of its layout (VRMXW §3). */
export function itemRank(path) {
  if (path === 'vrmxw.json') return 0;
  if (path === 'model.glb') return 1;
  if (/^thumbnail\.[^/]+$/.test(path)) return 2;
  if (path.startsWith('animations/')) return 3;
  if (path.startsWith('extensions/')) return 4;
  return 99;
}

const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Paths sorted by rank, then by name: the one order a writer uses, so output is repeatable. */
export function orderPaths(paths, rank) {
  return [...paths].sort((a, b) => rank(a) - rank(b) || byteOrder(a, b));
}

/**
 * The manifest's `files` for these entries, in writing order: path, size, SHA-256. Keys a previous
 * record had beyond those three are kept (VRMXA §2 rule 5).
 */
export async function inventory(entries, order, previous = []) {
  const prev = new Map((Array.isArray(previous) ? previous : []).filter((r) => r && typeof r.path === 'string').map((r) => [r.path, r]));
  const out = [];
  for (const path of order) {
    const data = entries.get(path);
    const rec = { ...(prev.get(path) || {}), path, size: data.length, sha256: await sha256(data) };
    // path, size, sha256 first, then whatever else the record carried
    const { path: p, size, sha256: h, ...rest } = rec;
    out.push({ path: p, size, sha256: h, ...rest });
  }
  return out;
}

/**
 * Pack: the manifest (with `files` already set) as the first entry, then the entries in `order`.
 * `store(path)` says which entries are stored rather than deflated.
 */
export function packZip(manifestName, manifest, entries, order, { store } = {}) {
  return writeZip([
    { name: manifestName, data: jsonBytes(manifest) },
    ...order.map((path) => ({ name: path, data: entries.get(path), store: store ? store(path) : undefined })),
  ]);
}

/** Read the manifest out of an open form's entries → { manifest } or { error }. */
export function manifestOf(entries, manifestName) {
  const raw = entries.get(manifestName);
  if (!raw) return { error: `there is no ${manifestName}` };
  const r = parseJson(raw);
  if (r.error) return { error: `${manifestName} is not valid JSON (${r.error})` };
  if (!r.value || typeof r.value !== 'object' || Array.isArray(r.value)) return { error: `${manifestName} is not a JSON object` };
  return { manifest: r.value };
}
