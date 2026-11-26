// Node only: the specification's own checker (tools/check, copied into src/spec/) over the published schemas, bases and
// spec.vrm, for the CLI's conformance and fixtures commands. The reference library's checker (src/checker.js) goes
// further: it opens the database and checks models more deeply.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import SCHEMAS from '../schema/schemas.js';
import { BASES } from '../vocab.js';
import { createChecker, specBinds } from '../spec/check.js';
import { findSpecDir } from './spec.js';

let made = null;
/** The specification-level checker, made once. */
export function specChecker() {
  if (made) return made;
  const dir = findSpecDir();
  const binds = dir ? specBinds(new Uint8Array(readFileSync(join(dir, 'spec.vrm')))) : null;
  made = createChecker({ schemas: SCHEMAS, bases: BASES, specBinds: binds });
  return made;
}
