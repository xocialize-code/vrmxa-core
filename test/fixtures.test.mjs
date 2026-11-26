// The fixtures script is repeatable: run again, it writes the same bytes as the committed files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ROOT, FIX, noSpec } from './helpers.mjs';

const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

test('running scripts/make-fixtures.mjs again gives the committed bytes', { skip: noSpec, timeout: 120000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'vrmxa-fixtures-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts/make-fixtures.mjs'), '--out', out, '--quiet'], { stdio: 'pipe' });
    const made = walk(out).map((f) => relative(out, f)).sort();
    const committed = walk(FIX).map((f) => relative(FIX, f)).filter((f) => !f.endsWith('README.md') && !f.endsWith('.DS_Store')).sort(); // Finder's, when the folder is browsed
    assert.deepEqual(made, committed);
    for (const f of made) assert.ok(readFileSync(join(out, f)).equals(readFileSync(join(FIX, f))), `${f} differs`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
