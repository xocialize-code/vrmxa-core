// The conformance kit (PRD REF-2, MCP-9): the reference library's own output passes every case, the kit's expected
// results are what the reference gives (regenerated here), and an output that is wrong fails the case it breaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceOutputs } from '../src/node/conformance.js';
import { runConformance, summariseOutputs } from '../src/spec/conformance.js';
import { specChecker } from '../src/node/spec-check.js';
import { ROOT, SPEC_REPO, noSpecRepo, specVrm } from './helpers.mjs';

let out = null;
const kit = () => join(SPEC_REPO, 'conformance');
async function reference() {
  if (out) return out;
  out = mkdtempSync(join(tmpdir(), 'vrmxa-conformance-'));
  await referenceOutputs(out, { spec: specVrm(), specRepo: SPEC_REPO });
  return out;
}
test.after(() => { if (out) rmSync(out, { recursive: true, force: true }); });

test('the reference library\'s own output passes every case of the kit', { skip: noSpecRepo, timeout: 180000 }, async () => {
  const r = await runConformance({ kit: kit(), outputDir: await reference(), checker: specChecker() });
  const cases = JSON.parse(readFileSync(join(kit(), 'cases.json'), 'utf8')).cases;
  assert.equal(r.cases.length, cases.length);
  for (const c of r.cases) assert.equal(c.status, 'passes', `${c.id}: ${c.checks.filter((x) => !x.ok).map((x) => `${x.name} ${x.detail}`).join('; ') || c.error}`);
  assert.ok(r.ok);
});

test('the kit\'s expected results are the reference\'s summaries, exactly', { skip: noSpecRepo, timeout: 180000 }, async () => {
  const s = summariseOutputs({ kit: kit(), outputDir: await reference(), checker: specChecker() });
  for (const [id, summary] of Object.entries(s)) {
    assert.equal(`${JSON.stringify(summary, null, 1)}\n`, readFileSync(join(kit(), 'expected', `${id}.json`), 'utf8'), `${id}: run node scripts/make-conformance.mjs and commit the specification`);
  }
});

test('an output that is wrong fails the case it breaks, and only that case', { skip: noSpecRepo, timeout: 180000 }, async () => {
  const bad = mkdtempSync(join(tmpdir(), 'vrmxa-conformance-bad-'));
  try {
    cpSync(await reference(), bad, { recursive: true });
    // the refusal not made; every garment 3 mm off on one body; a planted memory string in the bundle; a clip grounded for bare feet
    writeFileSync(join(bad, 'closet-operations/refused.json'), '{ "refused": [] }\n');
    const f = join(bad, 'specfit/bust-plus.json');
    const fit = JSON.parse(readFileSync(f, 'utf8'));
    for (const k of Object.keys(fit)) fit[k] = fit[k].map((v, i) => (i % 3 === 0 ? v + 0.003 : v));
    writeFileSync(f, JSON.stringify(fit));
    const rec = JSON.parse(readFileSync(join(bad, 'clip-ground/record.json'), 'utf8'));
    rec.groundedFor.lift = 0;
    writeFileSync(join(bad, 'clip-ground/record.json'), JSON.stringify(rec));
    rmSync(join(bad, 'measure'), { recursive: true });
    const r = await runConformance({ kit: kit(), outputDir: bad, checker: specChecker() });
    const status = Object.fromEntries(r.cases.map((c) => [c.id, c.status]));
    assert.equal(status['closet-operations'], 'fails');
    assert.equal(status.specfit, 'fails');
    assert.equal(status['clip-ground'], 'fails');
    assert.equal(status.measure, 'not run');
    for (const id of ['reader-verdicts', 'edits-apply', 'avatar-write', 'licence-tighten', 'share-copy', 'memory-rule', 'licence-questions']) assert.equal(status[id], 'passes', id);
    assert.ok(!r.ok);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test('the CLI: fixtures list and check, conformance cases and a comparison, validate naming rules', { skip: noSpecRepo, timeout: 180000 }, async () => {
  const cli = (...a) => execFileSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...a], { encoding: 'utf8' });
  assert.match(cli('fixtures', 'list'), /14 valid and 54 invalid files/);
  assert.match(cli('fixtures', 'check'), /68 of 68 fixtures behave as expected\.json says/);
  assert.match(cli('conformance', 'cases'), /memory-rule — Nothing a character remembers/);
  const dir = await reference();
  const r = JSON.parse(cli('conformance', dir, '--json'));
  assert.ok(r.ok && r.cases.every((c) => c.status === 'passes'));
  let text = '';
  try { cli('validate', join(SPEC_REPO, 'fixtures/invalid/closet-unknown-state.vrmxa')); } catch (e) { text = e.stdout; }
  assert.match(text, /rule: every state recorded is one the item has; a worn outfit exists \(CLOSET\.md C5\)/);
  void readdirSync;
});
