// vrmxa closet: the closet operations from the command line, for agents (PRD §16.1, MCP-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX, noSpec, same } from './helpers.mjs';
import { readBundle, sha256, checkBundle } from '../src/index.js';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });
const TOP = 'b11a6647-7168-4dea-916b-70eccf5182ae';

test('vrmxa closet: list, add, put on, state, fine-tune, outfits, take off, remove, copy out; avatar.vrm redrawn each time the look changes', { skip: noSpec }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-closet-'));
  try {
    const full = join(FIX, 'characters/full.vrmxa');
    const list = JSON.parse(run('closet', full, '--json').stdout);
    assert.equal(list.closet.items.length, 2);
    assert.deepEqual(list.outfit, { outfit: list.closet.outfits[0].id, name: 'Adventurer', changed: false });
    const step = (from, ...args) => {
      const to = join(dir, `${args[0]}-${Math.random().toString(36).slice(2)}.vrmxa`);
      const r = run('closet', from, ...args, to, '--json');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return { to, o: JSON.parse(r.stdout) };
    };
    let s = step(full, 'add', join(FIX, 'items/pinned-hat.vrmxw'));
    assert.equal(s.o.redrawn, false);
    s = step(s.to, 'put-on', 'Fixture hat');
    assert.equal(s.o.redrawn, true);
    s = step(s.to, 'state', 'Fixture sword', 'held');
    s = step(s.to, 'fit', 'Fixture top', 'size=1.05', 'up=0.004', 'ease=relaxed');
    assert.deepEqual(s.o.closet.items.find((e) => e.id === TOP).fitting.adjust, { loose: 0.004, size: 1.05, up: 0.004 });
    s = step(s.to, 'outfit-save', 'With hat');
    s = step(s.to, 'take-off', 'Fixture hat');
    s = step(s.to, 'outfit-apply', 'With hat');
    assert.ok(s.o.closet.worn.items.includes(s.o.closet.items.find((e) => e.name === 'Fixture hat').id));
    const b = await readBundle(new Uint8Array(readFileSync(s.to)));
    assert.equal(b.manifest.avatar.of.closet, await sha256(b.entries.get('closet/closet.json')), 'avatar.vrm is current (C6)');
    assert.ok(!(await checkBundle(new Uint8Array(readFileSync(s.to)))).some((p) => p.code === 'bundle.avatar-stale'));
    // refusals are exit 1 and say why
    const worn = run('closet', s.to, 'remove', 'Fixture hat', join(dir, 'x.vrmxa'));
    assert.equal(worn.status, 1);
    assert.match(worn.stderr, /take it off first/);
    s = step(s.to, 'remove', 'Fixture hat', '--take-off');
    assert.equal(s.o.closet.items.length, 2);
    const copy = join(dir, 'top.vrmxw');
    assert.equal(run('closet', s.to, 'copy-out', 'Fixture top', copy).status, 0);
    const orig = (await readBundle(new Uint8Array(readFileSync(full)))).entries.get(`closet/items/tops-${TOP}.vrmxw`);
    assert.ok(same(new Uint8Array(readFileSync(copy)), orig));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
