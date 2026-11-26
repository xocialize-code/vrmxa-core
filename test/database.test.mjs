// character.sqlite, schema 1 (VRMXA §12), opened defensively (§3.4, §3.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeCharacterDb, readCharacterDb, checkSqliteHeader, loadSqlJs, APPLICATION_ID } from '../src/database.js';
import { codes, same } from './helpers.mjs';

const data = {
  persona: { name: 'Mira', traits: ['calm'], languages: ['en'], updated: '2026-11-16T00:00:00.000Z' },
  examples: [{ id: 'b', seq: 2, user_text: 'two', character_text: '2' }, { id: 'a', seq: 1, user_text: 'one', character_text: '1' }],
  listing: { url: 'https://example.com/c', marketplace: 'Example', listing_id: 'X1' },
  settings: { 'x-test.b': '2', 'x-test.a': '1' },
};

test('writing is repeatable and the packed form is right (§3.4)', async () => {
  const a = await writeCharacterDb(data);
  const b = await writeCharacterDb(data);
  assert.ok(same(a, b));
  const dv = new DataView(a.buffer, a.byteOffset);
  assert.equal(dv.getUint32(68, false), APPLICATION_ID);
  assert.equal(dv.getUint32(60, false), 1, 'user_version is the schema version');
  assert.equal(a[18], 1, 'rollback journal, not WAL');
  assert.deepEqual(checkSqliteHeader(a), []);
});

test('reading gives the rows back, defaults filled in', async () => {
  const { data: d, problems } = await readCharacterDb(await writeCharacterDb(data));
  assert.deepEqual(problems, []);
  assert.equal(d.persona.name, 'Mira');
  assert.equal(d.persona.rest_expression, 'neutral');
  assert.deepEqual(JSON.parse(d.persona.allowed_expressions), ['happy', 'angry', 'sad', 'relaxed', 'surprised']);
  assert.deepEqual(d.examples.map((e) => e.id), ['a', 'b']);
  assert.deepEqual(d.settings, { 'x-test.a': '1', 'x-test.b': '2' });
});

async function variant(sql) {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(await writeCharacterDb(data));
  db.exec(sql);
  const out = db.export();
  db.close();
  return out;
}

test('anything beyond the four tables is refused: triggers, views, virtual tables, indexes, columns', async () => {
  for (const [sql, code] of [
    ['CREATE TRIGGER t AFTER INSERT ON setting BEGIN DELETE FROM persona; END;', 'db.extra-object'],
    ['CREATE VIEW v AS SELECT * FROM persona;', 'db.extra-object'],
    ['CREATE INDEX i ON persona_example(seq);', 'db.extra-object'],
    ['CREATE TABLE memory (id INTEGER);', 'db.extra-object'],
    ['ALTER TABLE persona ADD COLUMN secret TEXT;', 'db.columns'],
    ['DROP TABLE listing;', 'db.missing-table'],
  ]) {
    const { problems } = await readCharacterDb(await variant(sql));
    assert.ok(codes(problems).includes(code), `${sql} → ${codes(problems)}`);
  }
});

test('header checks: application id, schema version, WAL, damage', async () => {
  const good = await writeCharacterDb(data);
  const wrongApp = good.slice(); wrongApp[68] = 0;
  assert.ok(codes(checkSqliteHeader(wrongApp)).includes('db.application-id'));
  const v2 = good.slice(); v2[63] = 2;
  assert.ok(codes(checkSqliteHeader(v2)).includes('db.schema-version'));
  const wal = good.slice(); wal[18] = 2; wal[19] = 2;
  assert.ok(codes(checkSqliteHeader(wal)).includes('db.wal'));
  assert.deepEqual(codes(checkSqliteHeader(wal, { packed: false })), []);
  assert.ok(codes(checkSqliteHeader(new TextEncoder().encode('not a database at all, really'))).includes('db.not-sqlite'));
  const truncated = good.subarray(0, 5000);
  assert.ok((await readCharacterDb(truncated)).problems.length);
});

test('random damage never throws (100 corrupted databases)', async () => {
  const good = await writeCharacterDb(data);
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let k = 0; k < 100; k++) {
    const b = good.slice();
    for (let i = 0; i < 1 + (k % 8); i++) b[100 + Math.floor(rnd() * (b.length - 100))] = Math.floor(rnd() * 256);
    await assert.doesNotReject(readCharacterDb(b));
  }
});
