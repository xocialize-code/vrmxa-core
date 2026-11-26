// The specification's JSON Schemas in the checker (PRD REF-4): the library's copies match the specification, every
// file the library writes passes them, a breach names its rule and section, and so does every finding of the checker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundle, checkItem } from '../src/index.js';
import { checkDocument, SCHEMAS, SCHEMA_FILES } from '../src/schema/index.js';
import { ROOT, FIX, fixture, noSpec, specVrm, SPEC_REPO, noSpecRepo } from './helpers.mjs';

test('the schemas and the checker modules are the specification\'s, byte for byte', { skip: noSpecRepo }, () => {
  const r = execFileSync(process.execPath, [join(ROOT, 'scripts/sync-schemas.mjs'), '--check'], { encoding: 'utf8' });
  assert.match(r, /match the specification/);
  const files = readdirSync(join(SPEC_REPO, 'schemas')).filter((f) => f.endsWith('.schema.json')).sort();
  assert.deepEqual(Object.keys(SCHEMAS).sort(), files);
});

test('there is a schema for every manifest and section document, and each is JSON Schema 2020-12', () => {
  for (const f of Object.values(SCHEMA_FILES)) {
    assert.ok(SCHEMAS[f], f);
    assert.equal(SCHEMAS[f].$schema, 'https://json-schema.org/draft/2020-12/schema', f);
  }
  assert.equal(Object.keys(SCHEMA_FILES).length, 15);
});

test('every fixture the library writes passes the schemas (no schema finding at all)', { skip: noSpec, timeout: 60000 }, async () => {
  const spec = specVrm();
  const files = [...readdirSync(join(FIX, 'characters')).map((f) => `characters/${f}`), ...readdirSync(join(FIX, 'items')).map((f) => `items/${f}`), 'hostile/control.vrmxa'];
  for (const f of files) {
    const P = f.endsWith('.vrmxw') ? await checkItem(fixture(f), { spec }) : await checkBundle(fixture(f), { spec });
    assert.deepEqual(P.filter((p) => p.code.startsWith('schema.')), [], f);
  }
});

test('a breach names the rule and the section, and a required key names the key', () => {
  const P = checkDocument({ format: 'vrmxa-closet', version: 1, worn: { items: [] }, items: [{ id: 'not-a-uuid', file: 'closet/items/x.glb', fitting: { adjust: { size: 3 } } }] }, 'closet', { where: 'closet.json' });
  const file = P.find((p) => p.where === 'closet.json → items.0.file');
  assert.equal(file.severity, 'error');
  assert.match(file.rule, /always a \.vrmxw/);
  assert.match(file.section, /VRMXA §3\.3, §7\.1, D12/);
  const id = P.find((p) => p.where === 'closet.json → items.0.id');
  assert.match(id.section, /VRMXA §4\.1/);
  const size = P.find((p) => p.where === 'closet.json → items.0.fitting.adjust.size');
  assert.equal(size.severity, 'warning', 'a value a reader clamps is a warning, not a reason to refuse (EDITS §1)');
  const M = checkDocument({ format: 'vrmxa', version: 5, fileId: '6c1a3d1e-2f43-4a52-9d6c-4f8a3e1d0b77', revision: 1, base: { sha256: 'a'.repeat(64) }, avatar: { file: 'avatar.vrm', of: {} }, files: [], thumbnail: 'thumbnail.png' }, 'manifest', { where: 'vrmxa.json' });
  const missing = M.find((p) => p.where === 'vrmxa.json → id');
  assert.match(missing.rule, /character's identity.*missing/);
  assert.equal(missing.section, 'VRMXA §4.1');
});

test('the edit document\'s unknown keys are notes and its out-of-range values warnings (EDITS §1)', () => {
  const P = checkDocument({ format: 'vrmxa-edits', version: 7, face: { shapes: { noseSize: 2, wobble: 1 } }, body: { height: 3 }, mystery: true }, 'edits', { where: 'edits.json' });
  assert.ok(P.length > 0);
  assert.ok(P.every((p) => p.severity !== 'error'), JSON.stringify(P));
  assert.ok(P.some((p) => p.severity === 'info' && p.where === 'edits.json'));
  assert.ok(P.some((p) => p.severity === 'warning' && p.where === 'edits.json → body.height'));
});

test('a voice: a real person\'s needs consent; madeWith never holds a local path; a preset may have no clips', () => {
  const meta = { authors: ['a'], licenseUrl: 'u' };
  const doc = (v) => ({ format: 'vrmxa-voices', version: 1, voices: [{ id: 'v', meta, ...v }] });
  assert.ok(checkDocument(doc({ origin: 'recorded', realPerson: true, clips: [{ file: 'voice/clips/aaaaaaaaaaaa.wav', transcript: 't' }] }), 'voices').some((p) => /consent/.test(p.rule)));
  assert.ok(checkDocument(doc({ origin: 'designed', realPerson: false, design: {}, madeWith: [{ model: 'C:\\models\\x' }], clips: [{ file: 'voice/clips/aaaaaaaaaaaa.wav', transcript: 't' }] }), 'voices').some((p) => /local path/.test(p.rule)));
  assert.deepEqual(checkDocument(doc({ origin: 'preset', realPerson: false, engines: { e: { preset: 'p' } } }), 'voices'), []);
  assert.ok(checkDocument(doc({ origin: 'imported', realPerson: false }), 'voices').some((p) => /one or more reference clips/.test(p.rule)));
});

test('every finding of the checker names its rule and section', { skip: noSpec, timeout: 60000 }, async () => {
  const spec = specVrm();
  const expected = JSON.parse(readFileSync(join(FIX, 'hostile/expected.json'), 'utf8'));
  for (const f of Object.keys(expected)) {
    const P = f.endsWith('.vrmxw') ? await checkItem(fixture(`hostile/${f}`), { spec }) : await checkBundle(fixture(`hostile/${f}`), { spec });
    for (const p of P) { assert.ok(p.rule, `${f}: ${p.code} has no rule`); assert.ok(p.section, `${f}: ${p.code} has no section`); }
  }
  const P = await checkBundle(fixture('characters/full.vrmxa'), { spec });
  assert.ok(P.length && P.every((p) => p.rule && p.section));
});

test('VRMXA 0.34 (D36) and VRMXW 0.16 (W28): the decided details, in the schemas and in the library', async () => {
  const { checkDocument: doc } = await import('../src/schema/index.js');
  const meta = { authors: ['a'], licenseUrl: 'u' };
  // an eye state's morphs are shape → weight (D36)
  const eyes = (morphs) => ({ format: 'vrmxa-eyes', version: 1, size: [8, 8], targets: { white: { material: 'a' }, iris: { material: 'b' }, highlight: { material: 'c' } }, states: [{ name: 'default' }, { name: 'wide', morphs }] });
  assert.deepEqual(doc(eyes({ EYE_Surprised: 1 }), 'eyes'), []);
  assert.ok(doc(eyes(['EYE_Surprised']), 'eyes').some((p) => p.severity === 'error' && /D36/.test(p.section)));
  // a clip's record has file, sha256 and transcript (D36)
  const v = { format: 'vrmxa-voices', version: 1, voices: [{ id: 'v', origin: 'imported', realPerson: false, meta, clips: [{ file: 'voice/clips/aaaaaaaaaaaa.wav', transcript: 't' }] }] };
  assert.ok(doc(v, 'voices').some((p) => p.where.endsWith('clips.0.sha256') && p.severity === 'error'));
  // an outfit's id is a UUID (D36); a closet entry's attach is a note, never a refusal (W28)
  const c = (o, e = {}) => ({ format: 'vrmxa-closet', version: 1, worn: { items: [] }, items: [{ id: '5d0c9a1e-0000-4000-8000-000000000000', file: 'closet/items/accessory-x.vrmxw', meta, ...e }], outfits: [o] });
  assert.ok(doc(c({ id: 'evening', items: [] }), 'closet').some((p) => p.severity === 'error' && /UUID/.test(p.rule)));
  const att = doc(c({ id: '5d0c9a1e-0000-4000-8000-0000000000aa', items: [] }, { bone: 'head', attach: { bone: 'head' } }), 'closet');
  assert.ok(att.length && att.every((p) => p.severity === 'info'));
  // the exchange form says version 1 (D36); shoes without a lift are a warning (W28)
  assert.ok(doc({ format: 'vrmxa-persona', name: 'X' }, 'persona').some((p) => p.where.endsWith('version')));
  const { fromExchange } = await import('../src/persona/index.js');
  assert.throws(() => fromExchange({ format: 'vrmxa-persona', name: 'X' }), /version/);
  const shoes = { format: 'vrmxw', version: 1, id: '5d0c9a1e-0000-4000-8000-000000000001', revision: 1, name: 'S', slot: 'shoes', type: 'shoes', kind: 'worn', base: { sha256: 'a'.repeat(64) }, model: { file: 'model.glb' }, rig: { humanBones: {} }, fit: { method: 'bones' }, meta, files: [] };
  const P = doc(shoes, 'item');
  assert.ok(P.length && P.every((p) => p.severity === 'warning') && P.some((p) => p.where.endsWith('fit.lift')));
});
