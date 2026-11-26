// vrmxa fit: Spec-fit from the command line, with FITTING.md §8's checks printed (PRD §16.1, MCP-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX, noSpec } from './helpers.mjs';
import { checkModel } from '../src/index.js';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });

test('vrmxa fit: a character on its own body, on another body, an item alone; the checks printed; avatar.vrm written', { skip: noSpec }, () => {
  const full = join(FIX, 'characters/full.vrmxa');
  const own = JSON.parse(run('fit', full, '--json').stdout);
  const top = own.items.find((x) => x.name === 'Fixture top');
  assert.equal(top.method, 'spec-fit');
  assert.equal(own.items.find((x) => x.name === 'Fixture sword').method, 'pin');
  const r = run('fit', full, '--body', '{"bustSize":1}', '--json');
  const o = JSON.parse(r.stdout);
  const t = o.items.find((x) => x.name === 'Fixture top');
  assert.ok(Number.isFinite(t.through) && Number.isFinite(t.throughBones) && Number.isFinite(t.easeRms) && Number.isFinite(t.hemsMm) && t.ms > 0);
  assert.deepEqual(o.body, { bustSize: 1 });
  const text = run('fit', join(FIX, 'items/skinned-top.vrmxw'), '--body', '{"waistSize":1}').stdout;
  assert.match(text, /Fixture top: (fits|fits with warnings|does not transfer well); Spec-fit, top fitted, \d+ vertices/);
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-fit-'));
  try {
    const out = join(dir, 'a.vrm');
    run('fit', full, '--body', '{"height":1}', '--out', out);
    assert.deepEqual(checkModel(new Uint8Array(readFileSync(out)), { kind: 'vrm' }).problems.filter((p) => p.severity === 'error'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(run('fit').status, 2);
});

test('vrmxa fit <model.vrm> --json: each garment\'s verdict and figures', { skip: noSpec }, async () => {
  const { dressSpec } = await import('../scripts/lib/dress.mjs');
  const { parseGlb, buildGlb } = await import('../src/glb.js');
  const { measureVrm } = await import('../src/measure/measure.js');
  const { specVrm } = await import('./helpers.mjs');
  const spec = specVrm();
  const p = parseGlb(spec);
  const d = dressSpec(JSON.parse(JSON.stringify(p.json)), p.bin, await measureVrm(spec));
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-fitv-'));
  try {
    const file = join(dir, 'dressed.vrm');
    writeFileSync(file, buildGlb(d.json, d.bin));
    const o = JSON.parse(run('fit', file, '--json').stdout);
    assert.ok(o.garments.length >= 1);
    assert.ok(o.garments.every((g) => typeof g.verdict === 'string' && g.figures));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
