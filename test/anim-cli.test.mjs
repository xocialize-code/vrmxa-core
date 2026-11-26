// vrmxa clip / vrmxa motion: listing, checking and correcting clips and building sets from the command
// line, for agents (PRD §16.1 MCP-10, "Animation": list and bring in clips; check; correct; build sets; play).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX, noSpec } from './helpers.mjs';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });
const KIMODO = join(ROOT, 'assets', 'motions', 'kimodo');

test('vrmxa clip check and correct a starter clip', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-clip-'));
  try {
    const c = run('clip', 'check', join(KIMODO, 'sit_b.vrma'), '--json');
    assert.equal(c.status, 1);
    const o = JSON.parse(c.stdout);
    assert.ok(o.problems.some((p) => p.id === 'floor-below' && p.tool.kind === 'pinFoot'));
    const out = join(dir, 'sit.vrma');
    const f = run('clip', 'correct', join(KIMODO, 'sit_b.vrma'), out, '--auto', '--json');
    assert.equal(f.status, 0, f.stdout + f.stderr);
    assert.deepEqual(JSON.parse(f.stdout).after.problems, []);
    assert.equal(run('clip', 'check', out).status, 0);
    const bad = run('clip', 'correct', join(KIMODO, 'sit_b.vrma'), join(dir, 'x.vrma'), '--ops', '[{"kind":"wiggle"}]');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not a correction/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vrmxa motion: starter clips and sets, check, correct all, sets and slots, details', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-motion-'));
  try {
    const step = (from, ...args) => {
      const to = join(dir, `${args[0]}-${Math.random().toString(36).slice(2)}.vrmxa`);
      const r = run('motion', from, ...args, to, '--json');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return { to, o: JSON.parse(r.stdout) };
    };
    let s = step(join(FIX, 'characters/minimal.vrmxa'), 'starter');
    assert.equal(s.o.animations.clips.length, 30);
    const before = run('motion', s.to, 'check', 'all', '--json');
    assert.equal(before.status, 1);
    assert.ok(JSON.parse(before.stdout).results.filter((r) => r.problems.length).length >= 25);
    s = step(s.to, 'correct', 'all', '--auto');
    assert.ok(s.o.result.every((r) => r.problemsAfter.length === 0), JSON.stringify(s.o.result.filter((r) => r.problemsAfter.length)));
    const after = run('motion', s.to, 'check', 'all', '--json');
    assert.equal(after.status, 0, after.stdout);
    s = step(s.to, 'set-new', 'Sword', '--requires', 'held:sword', '--priority', '10');
    s = step(s.to, 'slot', 'Sword', 'idle', 'Idle (subtle)*2,Idle (restless)');
    assert.equal(s.o.animations.sets.find((x) => x.name === 'Sword').slots.idle[0].weight, 2);
    s = step(s.to, 'details', 'Wave', 'licence=CC0', 'speed=0');
    assert.equal(s.o.animations.clips.find((c) => c.name === 'Wave').licence, 'CC0');
    s = step(s.to, 'uncorrect', 'Sit down');
    const list = JSON.parse(run('motion', s.to, '--json').stdout);
    assert.ok(list.plan.slots.idle.clips.length === 2);
    assert.equal(run('motion', s.to, 'set-remove', 'Nope', join(dir, 'n.vrmxa')).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
