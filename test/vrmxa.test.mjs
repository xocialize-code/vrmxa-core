// .vrmxa, bundle version 5: read, write, documents, database, identities, the version rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBundle, writeBundle, bundleToEntries, bundleFromEntries, createBundle, setDocument, setEntry, setDatabase, touchBundle,
  saveAsAnotherVersion, newIdentity, avatarOf,
} from '../src/vrmxa.js';
import { checkBundle } from '../src/checker.js';
import { RefusedError } from '../src/vrmxw.js';
import { jsonBytes } from '../src/bytes.js';
import { sha256 } from '../src/hash.js';
import { miniVrm } from '../scripts/lib/minivrm.mjs';
import { fixture, same, codes } from './helpers.mjs';

test('the character fixtures read and write back to the same bytes, packed and open', async () => {
  for (const f of ['characters/minimal.vrmxa', 'characters/full.vrmxa']) {
    const bytes = fixture(f);
    const b = await readBundle(bytes);
    assert.ok(same(await writeBundle(b), bytes), f);
    const open = await bundleToEntries(await readBundle(bytes));
    assert.ok(same(await writeBundle(await bundleFromEntries(open)), bytes), `${f} through the open form`);
  }
});

test('the full character reads into its parts', async () => {
  const b = await readBundle(fixture('characters/full.vrmxa'));
  assert.equal(b.manifest.version, 5);
  for (const k of ['edits', 'measurements', 'eyes', 'mouth', 'closet', 'animations', 'voices']) assert.ok(b.docs[k], k);
  assert.equal(b.database.persona.name, 'Mira');
  assert.equal(b.database.examples.length, 2);
  assert.equal(b.database.listing.listing_id, 'CH-0001');
  assert.equal(b.docs.closet.worn.states[b.docs.closet.items[1].id], 'stowed');
  assert.deepEqual(b.skipped, []);
});

test('a section newer than this reader is opened without, and kept byte for byte (§2 rules 4 and 5)', async () => {
  const b = await readBundle(fixture('characters/full.vrmxa'));
  b.manifest.sections.voice.version = 9;
  const futureBytes = b.entries.get('voice/voices.json');
  b.entries.set('x-vendor/unknown.bin', new Uint8Array([1, 2, 3]));
  const bytes = await writeBundle(b);
  const again = await readBundle(bytes);
  assert.equal(again.docs.voices, null);
  assert.deepEqual(again.skipped.map((s) => s.section), ['voice']);
  assert.ok(same(again.entries.get('voice/voices.json'), futureBytes));
  assert.deepEqual([...again.entries.get('x-vendor/unknown.bin')], [1, 2, 3]);
  assert.ok(again.problems.some((p) => p.code === 'bundle.section-newer'));
});

test('a new character: ids, the manifest\'s shape, avatar.of, revisions', async () => {
  const b = createBundle({ avatar: miniVrm('New') });
  assert.equal(b.manifest.title, 'New');
  assert.notEqual(b.manifest.id, b.manifest.fileId);
  const of = await avatarOf(b);
  assert.deepEqual(of, { base: b.manifest.base.sha256, edits: null, closet: null });
  const bytes = await writeBundle(b);
  assert.deepEqual(codes(await checkBundle(bytes)), []);
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode((await bundleToEntries(b)).get('vrmxa.json')))),
    ['format', 'version', 'meta', 'id', 'fileId', 'revision', 'title', 'author', 'created', 'updated', 'generator', 'thumbnail', 'base', 'avatar', 'database', 'sections', 'files']);
  touchBundle(b, { now: '2026-12-01T00:00:00.000Z' });
  assert.equal(b.manifest.revision, 2);
  const { id, fileId } = b.manifest;
  saveAsAnotherVersion(b);
  assert.equal(b.manifest.id, id);
  assert.notEqual(b.manifest.fileId, fileId);
  newIdentity(b);
  assert.notEqual(b.manifest.id, id);
});

test('avatar.of: recomputed when the avatar is current, kept when it may be stale', async () => {
  const b = createBundle({ avatar: miniVrm('Of') });
  setDocument(b, 'edits', { format: 'vrmxa-edits', version: 7, body: { height: 0.1 } });
  // edits changed after the avatar was drawn: of is kept as it was
  let m = JSON.parse(new TextDecoder().decode((await bundleToEntries(b)).get('vrmxa.json')));
  assert.equal(m.avatar.of.edits, null);
  assert.ok(codes(await checkBundle(await writeBundle(b)), 'warning').includes('bundle.avatar-stale'));
  // the app says avatar.vrm shows the current edits
  m = JSON.parse(new TextDecoder().decode((await bundleToEntries(b, { avatarOf: 'recompute' })).get('vrmxa.json')));
  assert.equal(m.avatar.of.edits, await sha256(b.entries.get('appearance/edits.json')));
});

test('the database is written and recorded with the persona section', async () => {
  const b = createBundle({ avatar: miniVrm('Db') });
  await setDatabase(b, { persona: { name: 'Db', updated: '2026-11-16T00:00:00.000Z' } });
  assert.deepEqual(b.manifest.database, { file: 'character.sqlite', schema: 1 });
  assert.deepEqual(b.manifest.sections.persona, { version: 1 });
  const again = await readBundle(await writeBundle(b));
  assert.equal(again.database.persona.name, 'Db');
});

test('a damaged or hostile bundle is refused as a whole, with every reason', async () => {
  const bytes = fixture('characters/minimal.vrmxa');
  const cut = bytes.subarray(0, bytes.length - 100);
  await assert.rejects(readBundle(cut), (e) => e instanceof RefusedError && e.problems.length > 0);
  await assert.rejects(readBundle(fixture('hostile/lying-hash.vrmxa')), RefusedError);
});

test('setDocument refuses a document of the wrong format, and setEntry the manifest', () => {
  const b = createBundle({ avatar: miniVrm('X') });
  assert.throws(() => setDocument(b, 'closet', { format: 'nope', version: 1 }));
  assert.throws(() => setEntry(b, 'vrmxa.json', jsonBytes({})));
});
