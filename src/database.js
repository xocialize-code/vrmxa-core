// character.sqlite, schema 1 (VRMXA §12), and the SQLite rules (§3.4) and untrusted-input rules
// (§3.5, "The database").
//
// SQLite runs through sql.js (SQLite compiled to WebAssembly), the same code in a browser and in Node.
// In Node the WebAssembly file is found beside sql.js. A browser app passes its own loader:
//   setSqlJsLoader(() => initSqlJs({ locateFile: (f) => `/assets/${f}` }))

import { asBytes, isPlainObject } from './bytes.js';

export const APPLICATION_ID = 0x56525841; // "VRXA"
export const SCHEMA_VERSION = 1;

/** The schema of §12, verbatim apart from the comments. */
export const SCHEMA_SQL = `
CREATE TABLE persona (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  name                TEXT NOT NULL,
  age                 TEXT,
  summary             TEXT,
  description         TEXT,
  personality         TEXT,
  traits              TEXT NOT NULL DEFAULT '[]',
  speech_style        TEXT,
  languages           TEXT NOT NULL DEFAULT '[]',
  rest_expression     TEXT NOT NULL DEFAULT 'neutral',
  allowed_expressions TEXT NOT NULL DEFAULT '["happy","angry","sad","relaxed","surprised"]',
  voice_id            TEXT,
  creator             TEXT,
  tags                TEXT NOT NULL DEFAULT '[]',
  extensions          TEXT NOT NULL DEFAULT '{}',
  updated             TEXT NOT NULL
);
CREATE TABLE persona_example (
  id             TEXT PRIMARY KEY,
  seq            INTEGER NOT NULL,
  user_text      TEXT NOT NULL,
  character_text TEXT NOT NULL
);
CREATE TABLE listing (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  url         TEXT,
  marketplace TEXT,
  listing_id  TEXT
);
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const TABLES = ['persona', 'persona_example', 'listing', 'setting'];
const PERSONA_COLUMNS = ['id', 'name', 'age', 'summary', 'description', 'personality', 'traits', 'speech_style', 'languages',
  'rest_expression', 'allowed_expressions', 'voice_id', 'creator', 'tags', 'extensions', 'updated'];
const JSON_COLUMNS = { traits: 'array', languages: 'array', allowed_expressions: 'array', tags: 'array', extensions: 'object' };

let loader = null;
let sqlPromise = null;

/** Set how sql.js is loaded: a function returning a promise of the initialised SQL module. */
export function setSqlJsLoader(fn) {
  loader = fn;
  sqlPromise = null;
}

/** The sql.js module, loaded once. */
export function loadSqlJs() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      if (loader) return loader();
      const mod = await import('sql.js');
      const init = mod.default || mod;
      return init();
    })();
    sqlPromise.catch(() => { sqlPromise = null; });
  }
  return sqlPromise;
}

/**
 * Check a database's 100-byte header before SQLite sees it. Returns problems (codes db.*).
 * `packed`: the packed form must use a rollback journal, not WAL (§3.4).
 */
export function checkSqliteHeader(bytes, { packed = true, where = 'character.sqlite' } = {}) {
  const u8 = asBytes(bytes);
  const P = [];
  const err = (code, message) => P.push({ severity: 'error', where, code, message });
  const magic = 'SQLite format 3\u0000';
  if (u8.length < 100 || String.fromCharCode(...u8.subarray(0, 16)) !== magic) {
    err('db.not-sqlite', 'not an SQLite 3 database');
    return P;
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pageSize = dv.getUint16(16, false);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) err('db.header', `the page size (${pageSize}) is not valid`);
  else if (u8.length % pageSize) err('db.header', 'the file is not a whole number of pages (truncated or padded)');
  const write = u8[18], read = u8[19];
  if (write === 2 || read === 2) {
    if (packed) err('db.wal', 'the database is in WAL mode; a packed bundle must use a rollback journal (journal_mode=DELETE)');
  } else if (write !== 1 || read !== 1) err('db.header', 'the database asks for a file format version this reader does not know');
  if (dv.getUint32(56, false) !== 1) err('db.encoding', 'the database text encoding is not UTF-8');
  const pages = dv.getUint32(28, false);
  if (pageSize && !(u8.length % pageSize) && pages && pages * pageSize !== u8.length && dv.getUint32(24, false) === dv.getUint32(92, false)) {
    err('db.header', `the header says ${pages} pages but the file holds ${u8.length / pageSize}`);
  }
  const appId = dv.getUint32(68, false);
  if (appId !== APPLICATION_ID) err('db.application-id', `application_id is 0x${appId.toString(16).padStart(8, '0')}, not 0x56525841 ("VRXA")`);
  const userVersion = dv.getUint32(60, false);
  if (userVersion !== SCHEMA_VERSION) err('db.schema-version', `user_version (the schema version) is ${userVersion}; this reader knows schema ${SCHEMA_VERSION}`);
  return P;
}

const rows = (db, sql, params) => {
  const st = db.prepare(sql);
  try {
    if (params) st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    return out;
  } finally {
    st.free();
  }
};

let referenceColumns = null;
async function reference() {
  if (referenceColumns) return referenceColumns;
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.exec(SCHEMA_SQL);
    referenceColumns = Object.fromEntries(TABLES.map((t) => [t, rows(db, `PRAGMA table_info("${t}")`)]));
  } finally {
    db.close();
  }
  return referenceColumns;
}

/**
 * Open a database from elsewhere, defensively (§3.5): header checked first; trusted_schema off;
 * quick_check; application_id and user_version; only the four tables of §12 with their columns, and no
 * triggers, views, virtual tables or indexes of its own. sql.js has no extension loading and keeps the
 * file in memory, so nothing outside it is touched.
 * → { db, problems } — db is null when a problem stops it being read. Never throws.
 */
export async function openDatabase(bytes, { packed = true, where = 'character.sqlite' } = {}) {
  const problems = checkSqliteHeader(bytes, { packed, where });
  if (problems.length) return { db: null, problems };
  const err = (code, message) => problems.push({ severity: 'error', where, code, message });
  let SQL;
  try {
    SQL = await loadSqlJs();
  } catch (e) {
    err('db.engine', `SQLite (sql.js) could not be loaded: ${e.message}`);
    return { db: null, problems };
  }
  let db = null;
  try {
    db = new SQL.Database(asBytes(bytes));
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA cell_size_check = ON; PRAGMA foreign_keys = ON;');
    const qc = rows(db, 'PRAGMA quick_check');
    const verdict = qc.map((r) => Object.values(r)[0]).join('; ');
    if (verdict !== 'ok') {
      err('db.damaged', `quick_check failed: ${verdict.slice(0, 300)}`);
      db.close();
      return { db: null, problems };
    }
    const objects = rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema");
    const ref = await reference();
    for (const o of objects) {
      if (o.type === 'table' && TABLES.includes(o.name)) continue;
      if (o.type === 'index' && /^sqlite_autoindex_/.test(o.name) && TABLES.includes(o.tbl_name)) continue;
      if (o.type === 'table' && /^sqlite_stat\d$/.test(o.name)) {
        problems.push({ severity: 'warning', where, code: 'db.stat-table', message: `holds SQLite's statistics table ${o.name} (left by ANALYZE)` });
        continue;
      }
      const what = /CREATE\s+VIRTUAL/i.test(o.sql || '') ? 'a virtual table' : `a ${o.type}`;
      err('db.extra-object', `holds ${what} "${o.name}", which schema 1 does not have (only the tables persona, persona_example, listing and setting are allowed)`);
    }
    for (const t of TABLES) {
      if (!objects.some((o) => o.type === 'table' && o.name === t)) {
        err('db.missing-table', `the table "${t}" is missing`);
        continue;
      }
      const cols = rows(db, `PRAGMA table_info("${t}")`);
      const want = ref[t];
      const sig = (c) => `${c.name} ${String(c.type).toUpperCase()} notnull=${c.notnull} pk=${c.pk}`;
      const have = new Map(cols.map((c) => [c.name, sig(c)]));
      for (const c of want) {
        if (!have.has(c.name)) err('db.columns', `the table "${t}" has no column "${c.name}"`);
        else if (have.get(c.name) !== sig(c)) err('db.columns', `the column ${t}.${c.name} is not as schema 1 defines it`);
      }
      for (const c of cols) if (!want.some((w) => w.name === c.name)) err('db.columns', `the table "${t}" has a column "${c.name}" that schema 1 does not have`);
    }
    if (problems.some((p) => p.severity === 'error')) {
      db.close();
      return { db: null, problems };
    }
    return { db, problems };
  } catch (e) {
    try { db?.close(); } catch { /* already closed */ }
    err('db.damaged', `the database could not be read (${e.message})`);
    return { db: null, problems };
  }
}

/**
 * Read character.sqlite → { data, problems }. data: { persona, examples, listing, settings }, the
 * rows as stored (JSON columns stay text), or null when it can't be read. Never throws.
 */
export async function readCharacterDb(bytes, opts = {}) {
  const where = opts.where || 'character.sqlite';
  const { db, problems } = await openDatabase(bytes, opts);
  if (!db) return { data: null, problems };
  try {
    const persona = rows(db, 'SELECT * FROM persona ORDER BY id');
    if (persona.length > 1) problems.push({ severity: 'error', where, code: 'db.persona', message: 'the persona table has more than one row' });
    const p = persona[0] || null;
    if (p) {
      for (const [col, kind] of Object.entries(JSON_COLUMNS)) {
        let v;
        try { v = JSON.parse(p[col]); } catch { v = undefined; }
        const ok = kind === 'array' ? Array.isArray(v) : isPlainObject(v);
        if (!ok) problems.push({ severity: 'error', where: `${where} → persona.${col}`, code: 'db.json-column', message: `must hold a JSON ${kind}` });
      }
    }
    const listing = rows(db, 'SELECT * FROM listing ORDER BY id')[0] || null;
    const examples = rows(db, 'SELECT * FROM persona_example ORDER BY seq, id');
    const settings = Object.fromEntries(rows(db, 'SELECT key, value FROM setting ORDER BY key').map((r) => [r.key, r.value]));
    return { data: { persona: p, examples, listing, settings }, problems };
  } catch (e) {
    problems.push({ severity: 'error', where, code: 'db.damaged', message: `the database could not be read (${e.message})` });
    return { data: null, problems };
  } finally {
    db.close();
  }
}

const jsonText = (v, fallback) => (v === undefined || v === null ? fallback : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Write character.sqlite, schema 1, in the packed form: rollback journal, vacuumed, application_id
 * and user_version set (§3.4). The same data gives the same bytes with the same sql.js version.
 *   data.persona: { name (required), age, summary, …, updated (ISO time, required) }; the JSON
 *     columns take arrays and objects, or text already in JSON
 *   data.examples: [{ id, seq, user_text, character_text }]
 *   data.listing: { url, marketplace, listing_id } or null
 *   data.settings: { key: value }
 */
export async function writeCharacterDb(data) {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  try {
    db.exec(`PRAGMA page_size = 4096; PRAGMA journal_mode = DELETE; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec(SCHEMA_SQL);
    const p = data.persona;
    if (p) {
      if (!p.name) throw new Error('persona.name is required');
      if (!p.updated) throw new Error('persona.updated is required');
      const cols = PERSONA_COLUMNS.filter((c) => c !== 'id');
      const vals = cols.map((c) => {
        if (JSON_COLUMNS[c]) return jsonText(p[c], undefined);
        return p[c] === undefined ? undefined : p[c]; // absent: the column's default applies
      });
      const use = cols.map((c, i) => [c, vals[i]]).filter(([, v]) => v !== undefined);
      db.run(`INSERT INTO persona (id, ${use.map(([c]) => c).join(', ')}) VALUES (1, ${use.map(() => '?').join(', ')})`, use.map(([, v]) => v));
    }
    const ex = [...(data.examples || [])].sort((a, b) => a.seq - b.seq || String(a.id).localeCompare(String(b.id)));
    for (const e of ex) db.run('INSERT INTO persona_example (id, seq, user_text, character_text) VALUES (?, ?, ?, ?)', [e.id, e.seq, e.user_text, e.character_text]);
    if (data.listing) db.run('INSERT INTO listing (id, url, marketplace, listing_id) VALUES (1, ?, ?, ?)', [data.listing.url ?? null, data.listing.marketplace ?? null, data.listing.listing_id ?? null]);
    for (const k of Object.keys(data.settings || {}).sort()) db.run('INSERT INTO setting (key, value) VALUES (?, ?)', [k, String(data.settings[k])]);
    db.exec('VACUUM');
    return db.export();
  } finally {
    db.close();
  }
}
