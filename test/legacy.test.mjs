// Versions 2 to 4 are read and brought forward (VRMXA §1; PRD CHR-2; EDITS.md §5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBundle, writeBundle } from '../src/vrmxa.js';
import { checkBundle } from '../src/checker.js';
import { readItem } from '../src/vrmxw.js';
import { jsonBytes } from '../src/bytes.js';
import { sha256 } from '../src/hash.js';
import { writeZip, scanZip } from '../src/zip.js';
import { miniVrm } from '../scripts/lib/minivrm.mjs';
import { fixture, codes, noSpec, specVrm } from './helpers.mjs';

test('a version 4 bundle is brought forward: base by hash, items packed, fits moved, motions as clips', async () => {
  const b = await readBundle(fixture('legacy/v4.vrmxa'));
  assert.equal(b.upgradedFrom, 4);
  assert.equal(b.manifest.version, 5);
  assert.equal(b.manifest.base.name, 'Spec');
  assert.equal(b.manifest.revision, 3, 'the revision is kept');
  // the item: a bare GLB, now a version 1 .vrmxw, worn, with its fit moved from edits.json
  const entry = b.docs.closet.items[0];
  assert.equal(entry.slot, 'tops');
  assert.deepEqual(entry.fitting.adjust, { loose: 0.006, size: 1.02 });
  assert.deepEqual(b.docs.closet.worn.items, [entry.id]);
  assert.equal(b.docs.edits.items, undefined, 'items no longer in the edit document');
  const item = await readItem(b.entries.get(entry.file));
  assert.equal(item.manifest.origin.made, 'imported');
  // motions: the clip in a default set, the motion document kept at its old path
  assert.equal(b.docs.animations.clips.length, 1);
  assert.ok(b.docs.animations.sets[0].default && b.docs.animations.sets[0].slots.idle.length);
  assert.ok(b.entries.has('animations/m1.motion.json'));
  // avatar.vrm stands in as the unedited Spec, and says so
  assert.ok(b.problems.some((p) => p.code === 'legacy.avatar'));
  const v5 = await writeBundle(b);
  const problems = await checkBundle(v5);
  assert.deepEqual(codes(problems), []);
  assert.ok(codes(problems, 'warning').includes('bundle.avatar-stale'));
});

test('a version 3 bundle without items or motions comes forward too', { skip: noSpec }, async () => {
  const body = specVrm();
  const edits = jsonBytes({ format: 'vrmxa-edits', version: 7, face: { morphs: {} } });
  const m = { format: 'vrmxa', version: 3, meta: { metaDataVersion: 1, schemaVersion: 3, binEncodingVersion: 1 }, id: '00000000-0000-4000-8000-000000000003', revision: 1, title: 'Three',
    body: { file: 'body.vrm', sha256: await sha256(body) }, edits: { file: 'edits.json', sha256: await sha256(edits) }, thumbnail: null, items: [] };
  const zip = writeZip([{ name: 'vrmxa.json', data: jsonBytes(m) }, { name: 'body.vrm', data: body }, { name: 'edits.json', data: edits }]);
  const b = await readBundle(zip);
  assert.equal(b.upgradedFrom, 3);
  const { entries } = scanZip(zip);
  assert.ok(Buffer.from(b.entries.get('appearance/edits.json')).equals(Buffer.from(entries.find((e) => e.name === 'edits.json').data)), 'unchanged edits are kept byte for byte');
  assert.equal(b.docs.closet, null);
});

test('a version 3 bundle whose body is not a published Spec is refused, with the reason', async () => {
  const body = miniVrm('Not Spec');
  const m = { format: 'vrmxa', version: 3, id: 'x', revision: 1, body: { file: 'body.vrm', sha256: await sha256(body) }, items: [] };
  const zip = writeZip([{ name: 'vrmxa.json', data: jsonBytes(m) }, { name: 'body.vrm', data: body }]);
  const p = await checkBundle(zip);
  assert.ok(codes(p).includes('legacy.unknown-body'));
});
