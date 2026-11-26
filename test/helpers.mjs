import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpecDir } from '../src/node/spec.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = join(ROOT, 'fixtures');
export const fixture = (rel) => new Uint8Array(readFileSync(join(FIX, rel)));
export const SPEC_DIR = findSpecDir();
export const specVrm = () => new Uint8Array(readFileSync(join(SPEC_DIR, 'spec.vrm')));
export const noSpec = !SPEC_DIR && 'spec.vrm not found (set VRMXA_SPEC_DIR)';
export const codes = (problems, severity = 'error') => problems.filter((p) => p.severity === severity).map((p) => p.code);
export const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
// the specification repository itself (schemas/, fixtures/, conformance/), when it is beside this one
import { findSpecRepo } from '../src/node/spec.js';
import { existsSync } from 'node:fs';
export const SPEC_REPO = findSpecRepo();
export const noSpecRepo = !(SPEC_REPO && existsSync(join(SPEC_REPO, 'fixtures/expected.json'))) && 'the specification repository with fixtures/ was not found beside this one';
