// The specification's test files (PRD REF-3): made by scripts/make-spec-fixtures.mjs from Spec and generated art, they
// are regenerated here and compared with the specification's copies byte for byte, so the two can't drift; each
// behaves as fixtures/expected.json says, in this library's checker and in the specification's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { checkBundle, checkItem, readBundle, readItem, RefusedError } from '../src/index.js';
import { specChecker } from '../src/node/spec-check.js';
import { ROOT, SPEC_REPO, noSpecRepo, specVrm } from './helpers.mjs';

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const FIXTURES = SPEC_REPO && join(SPEC_REPO, 'fixtures');
const expected = () => JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8'));
const read = (f) => new Uint8Array(readFileSync(join(FIXTURES, f)));
const errorCodes = (P) => [...new Set(P.filter((p) => p.severity === 'error').map((p) => p.code))].sort();

test('running scripts/make-spec-fixtures.mjs again gives the specification\'s files, byte for byte', { skip: noSpecRepo, timeout: 180000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'vrmxa-spec-fixtures-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/make-spec-fixtures.mjs'), '--out', out, '--quiet'], { stdio: 'pipe' });
    const made = walk(out).map((f) => relative(out, f)).sort();
    const committed = walk(FIXTURES).map((f) => relative(FIXTURES, f)).filter((f) => !f.endsWith('README.md') && !f.endsWith('.DS_Store')).sort();
    assert.deepEqual(made, committed);
    for (const f of made) assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(FIXTURES, f))), `${f} differs from the specification's copy: run node scripts/make-spec-fixtures.mjs and commit the specification`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the valid fixtures pass this library\'s checker with nothing to report, and open', { skip: noSpecRepo, timeout: 60000 }, async () => {
  const spec = specVrm();
  for (const f of Object.keys(expected().valid)) {
    const P = f.endsWith('.vrmxw') ? await checkItem(read(f), { spec }) : await checkBundle(read(f), { spec });
    assert.deepEqual(P.filter((p) => p.severity !== 'info'), [], f);
    if (f.endsWith('.vrmxa')) await readBundle(read(f), { spec }); else await readItem(read(f));
  }
});

test('each invalid fixture is refused for the rule it names, and nothing else (this library)', { skip: noSpecRepo, timeout: 60000 }, async () => {
  const spec = specVrm();
  for (const [f, v] of Object.entries(expected().invalid)) {
    const P = f.endsWith('.vrmxw') ? await checkItem(read(f), { spec }) : await checkBundle(read(f), { spec });
    assert.deepEqual(errorCodes(P), [...v.library].sort(), f);
    assert.ok(v.codes.every((c) => errorCodes(P).includes(c)), `${f}: ${v.codes.join(', ')}`);
    if (f.endsWith('.vrmxa')) await assert.rejects(() => readBundle(read(f), { spec }), RefusedError, f);
  }
});

test('the specification\'s own checker agrees, fixture by fixture', { skip: noSpecRepo, timeout: 60000 }, () => {
  const sc = specChecker();
  const e = expected();
  for (const f of Object.keys(e.valid)) assert.deepEqual(sc.checkFile(read(f), { name: f }).filter((p) => p.severity !== 'info'), [], f);
  for (const [f, v] of Object.entries(e.invalid)) assert.deepEqual(errorCodes(sc.checkFile(read(f), { name: f })), [...v.spec].sort(), f);
});

test('the full character has every section, its avatar drawn with what it wears', { skip: noSpecRepo, timeout: 60000 }, async () => {
  const b = await readBundle(read('characters/full.vrmxa'), { spec: specVrm() });
  for (const d of ['edits', 'measurements', 'eyes', 'mouth', 'closet', 'animations', 'voices']) assert.ok(b.docs[d], d);
  assert.ok(b.database?.persona && b.database.examples.length === 2 && b.database.listing);
  assert.ok(b.docs.animations.clips.some((c) => c.derivedFrom && c.edit && c.groundedFor?.lift === 0.02));
  assert.ok(b.docs.voices.voices.some((v) => v.madeWith?.length) && b.docs.voices.voices.some((v) => v.realPerson && v.consent?.given));
  assert.equal(b.docs.closet.items.length, 8);
  assert.deepEqual(b.docs.eyes.states.map((s) => s.name), ['default', 'confused', 'squint', 'smitten']);
  assert.ok(b.docs.mouth.states.some((s) => s.offsets) && b.docs.mouth.states.some((s) => s.morphs));
});
