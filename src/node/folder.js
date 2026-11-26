// Node only: the open form on disk (VRMXA §3.1). A folder with the same layout as the packed file.
// Reading refuses links and anything that is not a plain file; writing never leaves the folder.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { entryNameProblem } from '../zip.js';

const SKIP = new Set(['.DS_Store', 'Thumbs.db']);

/**
 * Read a folder into Map(path → bytes), paths with "/" separators. Refuses links. Skips .DS_Store.
 * A database's -wal or -shm file is refused: close the database (checkpoint it) before packing.
 */
export function readFolder(dir) {
  const root = resolve(dir);
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const full = join(d, name);
      const st = lstatSync(full);
      const rel = relative(root, full).split(sep).join('/');
      if (st.isSymbolicLink()) throw new Error(`${rel}: is a link; the open form holds plain files only`);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        if (/-(wal|shm|journal)$/.test(rel)) throw new Error(`${rel}: the database is still open; close it before packing (a packed bundle has no -wal or -shm files, VRMXA §3.4)`);
        out.set(rel, new Uint8Array(readFileSync(full)));
      } else throw new Error(`${rel}: is not a plain file`);
    }
  };
  walk(root);
  return out;
}

/** Write Map(path → bytes) into a folder (created if needed). Every path is checked to stay inside it. */
export function writeFolder(dir, entries, { overwrite = false } = {}) {
  const root = resolve(dir);
  if (existsSync(root) && readdirSync(root).length && !overwrite) throw new Error(`${dir}: the folder is not empty`);
  for (const [path, data] of entries) {
    const bad = entryNameProblem(path);
    if (bad) throw new Error(`${path}: ${bad}`);
    const full = resolve(root, ...path.split('/'));
    if (!full.startsWith(root + sep)) throw new Error(`${path}: would be written outside the folder`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
}
