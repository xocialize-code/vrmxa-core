// Node only: where the specification's published assets are on this machine.
// VRMXA_SPEC_DIR overrides; otherwise the specification repository is expected beside this one
// (…/VRMXA_Specification beside …/vrmxa-core), or beside the app that holds this library as
// packages/vrmxa-core (…/VRMXA_Specification beside …/vrmxa-avatar-studio).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The folder holding spec.vrm, spec.measurements.json and bases.json, or null when not found. */
export function findSpecDir() {
  const candidates = [
    process.env.VRMXA_SPEC_DIR,
    resolve(here, '../../../VRMXA_Specification/assets/spec'),
    resolve(here, '../../../../../VRMXA_Specification/assets/spec'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'spec.vrm'))) return c;
  return null;
}

/** spec.vrm's bytes, or null. */
export function readSpecVrm(dir = findSpecDir()) {
  return dir ? new Uint8Array(readFileSync(join(dir, 'spec.vrm'))) : null;
}

/**
 * The specification repository itself (holding schemas/, fixtures/, conformance/), or null: VRMXA_SPEC_REPO, else
 * two folders up from the assets folder findSpecDir finds.
 */
export function findSpecRepo() {
  const candidates = [process.env.VRMXA_SPEC_REPO, findSpecDir() && resolve(findSpecDir(), '..', '..')].filter(Boolean);
  for (const c of candidates) if (existsSync(join(c, 'schemas')) || existsSync(join(c, 'fixtures'))) return c;
  return null;
}
