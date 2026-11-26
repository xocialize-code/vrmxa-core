// The command-line tool (MCP-10): exit codes, --json, and pack / unpack round trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX } from './helpers.mjs';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });

test('validate: exit 0 for a good file, 1 for a hostile one, 2 for a missing one', () => {
  assert.equal(run('validate', join(FIX, 'items/skinned-top.vrmxw')).status, 0);
  assert.equal(run('validate', join(FIX, 'characters/minimal.vrmxa')).status, 0);
  const bad = run('validate', join(FIX, 'hostile/path-escape.vrmxa'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAILS/);
  assert.equal(run('validate', join(FIX, 'nope.vrmxa')).status, 2);
  assert.equal(run('validate', join(FIX, 'characters/full.vrmxa'), '--strict').status, 1, 'the full fixture has a warning');
});

test('--json gives one parseable object for agents', () => {
  const r = run('inspect', join(FIX, 'characters/full.vrmxa'), '--json');
  const o = JSON.parse(r.stdout);
  assert.equal(o.kind, 'vrmxa');
  assert.equal(o.persona.name, 'Mira');
  assert.equal(o.closet.items.length, 2);
  const v = JSON.parse(run('validate', join(FIX, 'hostile/lying-hash.vrmxa'), '--json').stdout);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => p.code === 'container.hash'));
});

test('unpack then pack gives back the same bytes, for both formats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-cli-'));
  try {
    for (const f of ['characters/full.vrmxa', 'items/animated-staff.vrmxw']) {
      const folder = join(dir, f.replace(/\W/g, '_'));
      const out = join(dir, `${f.replace(/\W/g, '_')}.out`);
      assert.equal(run('unpack', join(FIX, f), folder).status, 0);
      assert.ok(existsSync(join(folder, f.endsWith('.vrmxa') ? 'vrmxa.json' : 'vrmxw.json')));
      const p = run('pack', folder, out);
      assert.equal(p.status, 0, p.stdout + p.stderr);
      assert.ok(readFileSync(out).equals(readFileSync(join(FIX, f))), `${f} round trip`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unpack refuses a hostile file and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-cli-'));
  try {
    const r = run('unpack', join(FIX, 'hostile/path-escape.vrmxa'), join(dir, 'x'));
    assert.equal(r.status, 1);
    assert.ok(!existsSync(join(dir, 'x')));
    assert.ok(!existsSync(join(dir, 'escape.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('upgrade brings a version 4 bundle forward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-cli-'));
  try {
    const out = join(dir, 'v5.vrmxa');
    const r = run('upgrade', join(FIX, 'legacy/v4.vrmxa'), out);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(run('validate', out).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
