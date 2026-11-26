#!/usr/bin/env node
// The conformance kit's expected results (PRD REF-2): the reference library runs every case of
// VRMXA_Specification/conformance/cases.json (src/node/conformance.js) and the kit's own runner summarises that output
// into conformance/expected/<case id>.json. Repeatable: running it again gives the same files, and
// test/conformance.test.mjs checks both that and that the reference passes its own kit.
//   node scripts/make-conformance.mjs [--keep <folder for the reference's output>] [--only id,id]
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findSpecRepo, readSpecVrm } from '../src/node/spec.js';
import { referenceOutputs } from '../src/node/conformance.js';
import { summariseOutputs } from '../src/spec/conformance.js';
import { specChecker } from '../src/node/spec-check.js';

const repo = findSpecRepo();
const spec = readSpecVrm();
if (!repo || !spec) { console.error('the specification (with spec.vrm) is not beside this repository'); process.exit(2); }
const keepAt = process.argv.indexOf('--keep');
const onlyAt = process.argv.indexOf('--only');
const out = keepAt > 0 ? process.argv[keepAt + 1] : mkdtempSync(join(tmpdir(), 'vrmxa-conformance-'));
const only = onlyAt > 0 ? process.argv[onlyAt + 1].split(',') : null;
const t0 = Date.now();
const { cases } = await referenceOutputs(out, { spec, specRepo: repo, only });
const summaries = summariseOutputs({ kit: join(repo, 'conformance'), outputDir: out, checker: specChecker() });
mkdirSync(join(repo, 'conformance/expected'), { recursive: true });
for (const id of cases) {
  if (summaries[id].error) { console.error(`${id}: ${summaries[id].error}`); process.exit(1); }
  writeFileSync(join(repo, 'conformance/expected', `${id}.json`), `${JSON.stringify(summaries[id], null, 1)}\n`);
  console.log(`expected/${id}.json`);
}
console.log(`${cases.length} cases in ${((Date.now() - t0) / 1000).toFixed(1)} s${keepAt > 0 ? `; the reference's output is in ${out}` : ''}`);
if (keepAt < 0) rmSync(out, { recursive: true, force: true });
