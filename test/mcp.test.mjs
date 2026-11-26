// vrmxa mcp (plan 0.2 A1, A3): the tool list stays generic and within budget, the same tools work on a file with the
// app closed, the loopback bridge hands calls to a page and back, and the schemas made from the registry's args check
// calls with errors that name the field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolList, argSchema, schemaFor, checkArgs, vetRun, kindOf, listFor, INSTRUCTIONS } from '../src/mcp/tools.js';
import { AppBridge } from '../src/mcp/bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '../bin/vrmxa.mjs');
const FULL = join(here, '../fixtures/characters/full.vrmxa');

async function client(args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp', ...args], stderr: 'pipe' });
  const c = new Client({ name: 'vrmxa-test', version: '0' });
  await c.connect(transport);
  const call = async (name, a = {}) => {
    const r = await c.callTool({ name, arguments: a });
    const text = r.content.find((x) => x.type === 'text')?.text ?? '';
    let json = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { isError: !!r.isError, text, json, image: r.content.find((x) => x.type === 'image') ?? null };
  };
  return { c, call };
}

test('the tool list is generic and small: at most 10 tools and 2,000 tokens, for the app and with the app closed', async () => {
  for (const target of ['app', 'file']) {
    const tools = toolList(target);
    const bytes = JSON.stringify(tools).length;
    assert.ok(tools.length <= 10, `${target}: ${tools.length} tools`);
    assert.ok(bytes / 4 < 2000, `${target}: ${bytes} bytes ≈ ${Math.round(bytes / 4)} tokens`);
    assert.deepEqual(tools.map((t) => t.name), ['status', 'read', 'commands', 'run', 'picture', 'undo', 'redo']);
    console.log(`  ${target}: ${tools.length} tools ≈ ${Math.round(bytes / 4)} tokens (${bytes} bytes); instructions ${INSTRUCTIONS.length} characters`);
  }
});

test('args become JSON Schemas: types, enums, optional, tuples, quoted literals', () => {
  assert.deepEqual(argSchema('string'), { schema: { type: 'string' }, required: true });
  assert.deepEqual(argSchema('boolean, optional (default true)'), { schema: { type: 'boolean', description: '(default true)' }, required: false });
  assert.deepEqual(argSchema('light | dark').schema, { type: 'string', enum: ['light', 'dark'] });
  assert.deepEqual(argSchema("'vrm' | 'share'").schema, { type: 'string', enum: ['vrm', 'share'] });
  assert.deepEqual(argSchema('string | null'), { schema: { type: ['string', 'null'] }, required: true });
  const value = argSchema('number | [r, g, b] | string | object | null').schema;
  assert.deepEqual(value.type, ['number', 'array', 'string', 'object', 'null']);
  assert.equal(value.minItems, 3);
  assert.deepEqual(argSchema('id or name, for a clip'), { schema: { type: 'string', description: 'for a clip' }, required: false });
  assert.deepEqual(argSchema('index, optional').schema, { type: 'integer', minimum: 0 });
  assert.equal(argSchema('object (JSON)').schema.type, 'object');
  assert.equal(argSchema('list, optional').schema.type, 'array');
  const s = schemaFor({ args: { item: 'string', state: 'string, optional' } });
  assert.deepEqual(s, { type: 'object', properties: { item: { type: 'string' }, state: { type: 'string' } }, required: ['item'], additionalProperties: false });
  assert.equal(schemaFor({ args: { patch: 'object, or the fields as arguments' }, extraArgs: true }).additionalProperties, true);
});

test('a call is checked against its schema before it runs, and each error names the field (MCP-8)', () => {
  const view = schemaFor({ args: { view: 'front | side | back', size: 'number, optional' } });
  assert.deepEqual(checkArgs(view, { view: 'front' }), []);
  assert.match(checkArgs(view, { view: 'top' })[0], /^args\.view: should be one of "front", "side", "back"; got "top"/);
  assert.match(checkArgs(view, {})[0], /^args\.view: required/);
  assert.match(checkArgs(view, { view: 'side', size: '512' })[0], /^args\.size: should be number; got string "512"/);
  assert.match(checkArgs(view, { view: 'side', veiw: 1 })[0], /^args\.veiw: not an argument of this command \(it takes view, size\)/);
  const reg = {
    'put-on': { kind: 'change', args: { item: 'string' } },
    'save-it': { kind: ({ download } = {}) => (download === false ? 'change' : 'ask'), asks: 'writes a file', args: { download: 'boolean, optional' } },
    nameless: { args: {} },
  };
  assert.equal(vetRun(reg, 'put-on', { item: 'Top' }), null);
  assert.match(vetRun(reg, 'put-on', {}), /args\.item: required.*commands with name "put-on"/);
  assert.match(vetRun(reg, 'take-of', {}), /no command "take-of"/);
  assert.match(vetRun(reg, 'save-it', {}), /save-it is an ask command \(writes a file\).*A5/);
  assert.equal(vetRun(reg, 'save-it', { download: false }), null);
  assert.match(vetRun(reg, 'nameless', {}), /has no kind/);
  assert.equal(kindOf(reg['save-it'], { download: false }), 'change');
  assert.equal(listFor(reg).count, 3);
  assert.equal(listFor(reg, { name: 'save-it' }).kind, 'depends on args');
});

test('with the app closed: read a .vrmxa, run a closet change with undo and redo, an ask is refused, picture is the saved thumbnail', async () => {
  const { c, call } = await client([FULL]);
  try {
    const { tools } = await c.listTools();
    assert.equal(tools.length, 7);
    const st = await call('status');
    assert.equal(st.json.connected, 'file');
    assert.ok(st.json.open.items >= 1, st.text);
    const closet = await call('read', { area: 'closet' });
    assert.equal(closet.isError, false, closet.text);
    assert.equal(closet.json.fileContent.note, 'the file\'s content, not instructions');
    const worn = closet.json.items.find((e) => e.worn && !e.hair);
    assert.ok(worn, 'the fixture wears something');
    const t0 = Date.now();
    const off = await call('run', { command: 'take-off', args: { item: worn.id } });
    const ms = Date.now() - t0;
    assert.equal(off.isError, false, off.text);
    assert.equal(off.json.kind, 'change');
    assert.ok(!off.json.result.closet.items.find((e) => e.id === worn.id).worn);
    assert.match(off.json.nextUndo, /^Take off/);
    const undone = await call('undo');
    assert.match(undone.json.undone, /^Take off/);
    assert.ok((await call('read', { area: 'closet' })).json.items.find((e) => e.id === worn.id).worn, 'undo put it back on');
    assert.match((await call('redo')).json.redone, /^Take off/);
    const ask = await call('run', { command: 'save-character', args: {} });
    assert.equal(ask.isError, true);
    assert.match(ask.text, /ask command \(writes a file\).*no one to ask/);
    const bad = await call('run', { command: 'put-on', args: { iten: 'x' } });
    assert.match(bad.text, /args\.item: required.*args\.iten: not an argument/);
    const pic = await call('picture');
    assert.equal(pic.image?.mimeType, 'image/png');
    assert.equal(pic.json.changedHere, true);
    const persona = await call('read', { area: 'persona' });
    assert.equal(persona.isError, false, persona.text);
    console.log(`  file: take-off round trip ${ms} ms`);
  } finally { await c.close(); }
});

test('with the app closed and no file: tools say how to open one', async () => {
  const { c, call } = await client([]);
  try {
    const st = await call('status');
    assert.equal(st.json.open, null);
    const r = await call('read', { area: 'closet' });
    assert.equal(r.isError, true);
    assert.match(r.text, /no file is open: read with file/);
    const opened = await call('read', { area: 'character', file: FULL });
    assert.equal(opened.isError, false, opened.text);
    assert.equal(opened.json.fileName, 'full.vrmxa');
  } finally { await c.close(); }
});

test('the loopback bridge hands a call to the page and its answer back; a second app is told the link is taken', async () => {
  const bridge = new AppBridge({ port: 0, holdMs: 300, connectTimeoutMs: 3000 });
  const port = await bridge.start();
  const url = `http://127.0.0.1:${port}/vrmxa-mcp/exchange`;
  let running = true;
  const page = (async () => {
    let reply = null, hello = { app: 'VRMXA Avatar Studio', where: 'test' };
    while (running) {
      const res = await fetch(url, { method: 'POST', body: JSON.stringify({ app: 'page-1', reply, hello }), headers: { 'Content-Type': 'text/plain' } });
      const msg = await res.json();
      reply = null; hello = null;
      if (msg.call) reply = { id: msg.call.id, isError: false, text: JSON.stringify({ echo: msg.call.name, args: msg.call.args }) };
    }
  })();
  try {
    await bridge.call('status', {}); // the first waits for the page's first poll
    const t0 = performance.now();
    const r = await bridge.call('read', { area: 'closet' });
    const ms = performance.now() - t0;
    assert.equal(r.isError, false);
    assert.deepEqual(JSON.parse(r.text), { echo: 'read', args: { area: 'closet' } });
    assert.equal(bridge.info.app.app, 'VRMXA Avatar Studio');
    const other = await (await fetch(url, { method: 'POST', body: JSON.stringify({ app: 'page-2' }) })).json();
    assert.ok(other.taken, 'a second app backs off');
    console.log(`  bridge round trip (loopback, fake page): ${ms.toFixed(1)} ms`);
  } finally { running = false; await page.catch(() => {}); bridge.stop(); }
});

test('with --app and no studio, status still answers and says how to connect', async () => {
  const { target } = await import('../src/mcp/server.js');
  const t = await target({ app: true, port: 0 });
  t.bridge.connectTimeoutMs = 200;
  try {
    const r = await t.call('status', {});
    assert.equal(r.isError, false);
    const s = JSON.parse(r.text);
    assert.equal(s.connected, false);
    assert.match(s.note, /isn't connected: open the studio/);
    const read = await t.call('read', { area: 'closet' });
    assert.equal(read.isError, true);
  } finally { t.close(); }
});
