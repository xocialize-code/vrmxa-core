// Phase 2, for agents (PRD §16.1, MCP-10, OQ-12): the command-line tool reads and applies an edit document.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX, noSpec } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { readBundle, parseGlb, sha256 } from '../src/index.js';
import { editsHash } from '../src/edit/index.js';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });

test('vrmxa edits: the document as stored, what is applied and what is ignored', () => {
  const r = run('edits', join(FIX, 'characters/full.vrmxa'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.document.version, 7);
  assert.equal(o.applied.face.headShape, 'heart');
  assert.deepEqual(o.ignored, []);
  assert.match(run('edits', join(FIX, 'characters/full.vrmxa')).stdout, /face\.headShape = heart/);
  assert.equal(run('edits', join(FIX, 'hostile/path-escape.vrmxa')).status, 1, 'a hostile file is refused');
});

test('vrmxa apply-edits: sets the document, writes avatar.vrm and the measurements, keeps unknown keys; vrmxa bake writes the VRM', { skip: noSpec }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-edit-'));
  try {
    const doc = { format: 'vrmxa-edits', version: 7, editor: 'an agent', madeOn: null, face: { shapes: { noseSize: 0.5 }, 'x-note': 'kept' }, body: { height: 1 } };
    writeFileSync(join(dir, 'e.json'), JSON.stringify(doc));
    const out = join(dir, 'out.vrmxa');
    const r = run('apply-edits', join(FIX, 'characters/full.vrmxa'), join(dir, 'e.json'), out, '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const o = JSON.parse(r.stdout);
    assert.deepEqual(o.ignored, ['face.x-note']);
    assert.equal(Math.round(o.stature * 1000) / 10, 176.7);
    const b = await readBundle(new Uint8Array(readFileSync(out)));
    assert.equal(b.docs.edits.face['x-note'], 'kept');
    assert.equal(b.docs.edits.body.height, 1);
    assert.equal(b.manifest.avatar.of.edits, await editsHash(b.docs.edits));
    // since phase 3 the tool fits the worn clothes too, so avatar.of names the real closet (CLOSET.md C6)
    assert.equal(b.manifest.avatar.of.closet, await sha256(b.entries.get('closet/closet.json')));
    assert.ok(parseGlb(b.entries.get('avatar.vrm')).json.extras.vrmxaPieces.length === 2, 'the top and the sword are written in');
    assert.equal(b.docs.measurements.of.edits, await editsHash(b.docs.edits));
    assert.equal(run('validate', out).status, 0);
    const vrm = join(dir, 'out.vrm');
    assert.equal(run('bake', out, vrm).status, 0);
    assert.equal(parseGlb(new Uint8Array(readFileSync(vrm))).json.extensions.VRMC_vrm.meta.name, 'Mira');
    writeFileSync(join(dir, 'new.json'), JSON.stringify({ ...doc, version: 9 }));
    const refused = run('apply-edits', join(FIX, 'characters/full.vrmxa'), join(dir, 'new.json'), join(dir, 'x.vrmxa'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /newer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
