// A state's `show` names an item's meshes by node `name`, and node names are unique within the item (VRMXW §8;
// SPEC-QUESTIONS #44, decided 2026-11-17). Items written before that named meshes by node index: those are read
// as names (with a note), never refused.

/** Make the nodes' names unique, in place: a repeated name gets " 2", " 3"… (the first keeps its own). → renamed count */
export function uniqueNodeNames(nodes) {
  const seen = new Set();
  let renamed = 0;
  for (const n of nodes || []) {
    if (typeof n?.name !== 'string' || !n.name) continue;
    if (!seen.has(n.name)) { seen.add(n.name); continue; }
    let k = 2;
    while (seen.has(`${n.name} ${k}`)) k++;
    n.name = `${n.name} ${k}`;
    seen.add(n.name);
    renamed++;
  }
  return renamed;
}

/** Names used by more than one node. */
export function duplicateNodeNames(nodes) {
  const count = new Map();
  for (const n of nodes || []) if (typeof n?.name === 'string' && n.name) count.set(n.name, (count.get(n.name) || 0) + 1);
  return [...count].filter(([, c]) => c > 1).map(([name]) => name);
}

/** Map a `show` list (names, or an older item's node indices) to node indices of the model's mesh nodes; unknown entries are left out. */
export function showToNodes(nodes, show) {
  const byName = new Map();
  (nodes || []).forEach((n, i) => { if (n?.mesh !== undefined && typeof n.name === 'string' && n.name && !byName.has(n.name)) byName.set(n.name, i); });
  const out = [];
  for (const s of Array.isArray(show) ? show : []) {
    const i = typeof s === 'string' ? byName.get(s) : Number.isInteger(s) && nodes?.[s]?.mesh !== undefined ? s : undefined;
    if (i !== undefined && !out.includes(i)) out.push(i);
  }
  return out;
}

/** A node index as the name a `show` list uses (its own index when the node has no name). */
export const nodeShowName = (nodes, i) => (typeof nodes?.[i]?.name === 'string' && nodes[i].name ? nodes[i].name : i);

/** An older item's `show` lists (node indices) rewritten as names; returns true when anything changed. In place on the manifest. */
export function showIndicesToNames(manifest, nodes) {
  let changed = false;
  for (const s of manifest?.states || []) {
    if (!Array.isArray(s?.show) || !s.show.some((x) => Number.isInteger(x))) continue;
    s.show = s.show.map((x) => (Number.isInteger(x) ? nodeShowName(nodes, x) : x));
    changed = true;
  }
  return changed;
}
