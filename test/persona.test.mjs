// Phase 7: the core persona (VRMXA §10.1; PER-1, PER-2), character cards (§10.3; PER-3) and no memory, ever (§11; PER-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { fixture, codes } from './helpers.mjs';
import { readBundle, writeBundle, checkBundle, scanZip } from '../src/index.js';
import * as p from '../src/persona/index.js';
import { setSetting } from '../src/character/index.js';
import { encodePng } from '../src/edit/png.js';

const full = () => readBundle(fixture('characters/full.vrmxa'));

// every byte a bundle holds, unpacked: the entries' data (deflated ones inflated) and the database's pages
async function allText(bytes) {
  const z = scanZip(bytes);
  const parts = z.entries.map((e) => Buffer.from(e.data));
  return Buffer.concat(parts).toString('latin1') + Buffer.from(bytes).toString('latin1');
}

const chatCard = () => ({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Rook', description: 'Tall, in a grey coat, always reading.', personality: 'Dry humour; loyal.',
    scenario: 'You meet Rook in the archive at midnight.', first_mes: 'Ah. You found the back door.',
    mes_example: '<START>\n{{user}}: What are you reading?\n{{char}}: Something nobody asked me to.\n<START>\n{{user}}: Can you help me?\nRook: Depends what with.',
    creator_notes: 'Best with slow scenes.', system_prompt: 'Stay in character.', post_history_instructions: 'Keep replies short.',
    alternate_greetings: ['Evening.'], tags: ['archivist', 'fantasy'], creator: 'Card Maker', character_version: '3',
    character_book: { entries: [{ keys: ['archive'], content: 'The archive is under the old palace.', extensions: {}, enabled: true, insertion_order: 0 }], extensions: {} },
    extensions: { chat_history: ['User: hi', 'Rook: SECRET-CHAT-LINE'], 'x-app.memories': 'SECRET-MEMORY-FACT' },
  },
});

test('the core persona is edited with the rest of the database kept (PER-1)', async () => {
  const b = await full();
  const r = await p.setPersona(b, {
    name: 'Mira', age: '24', summary: 'A cartographer who would rather be out walking.', description: 'Short, quick, with ink on her fingers.',
    personality: 'Curious and plain-spoken.', traits: ['curious', 'steady'], speech_style: 'Short sentences, no slang.', languages: ['en', 'ja'],
    rest_expression: 'relaxed', allowed_expressions: ['happy', 'sad', 'surprised'], examples: [{ user: 'Lost again?', character: 'Never. Exploring.' }],
  }, { now: '2026-11-17T12:00:00.000Z' });
  assert.equal(r.age, '24');
  assert.deepEqual(r.traits, ['curious', 'steady']);
  assert.deepEqual(r.examples.map((e) => e.character), ['Never. Exploring.']);
  assert.equal(r.voice_id, b.docs.voices.default, 'the voice it speaks with is kept');
  const again = await readBundle(await writeBundle(b));
  assert.equal(p.personaOf(again).rest_expression, 'relaxed');
  assert.equal(again.database.listing.marketplace, 'Example Market', 'the origin is kept');
  assert.deepEqual(codes(await checkBundle(await writeBundle(b))), []);
  await assert.rejects(p.setPersona(b, { allowed_expressions: ['joy'] }), /five emotions/);
  await assert.rejects(p.setPersona(b, { name: '' }), /needs a name/);
});

test('nothing app-specific goes into the bundle (PER-2)', async () => {
  const b = await full();
  await assert.rejects(p.setPersona(b, { backstory: 'Born in the north.' }), /story, which belongs to the app/);
  await assert.rejects(p.setPersona(b, { level: 12 }), /game state/);
  await assert.rejects(p.setPersona(b, { system_prompt: 'Be nice.' }), /framing/);
  await assert.rejects(p.setPersona(b, { favourite_colour: 'blue' }), /not a field of the core persona/);
});

test('the exchange form round-trips (§10.1)', async () => {
  const b = await full();
  const x = p.personaExchange(b);
  assert.equal(x.format, 'vrmxa-persona');
  const c = await full();
  await p.clearPersona(c);
  assert.equal(p.personaOf(c), null);
  await p.setPersona(c, p.fromExchange(x));
  const y = p.personaExchange(c);
  delete x.updated; delete y.updated;
  assert.deepEqual(y, x);
});

test('a V2 card divides: core fields to the persona, app-side fields returned apart (PER-3, §10.3)', async () => {
  const r = p.cardToPersona(new TextEncoder().encode(JSON.stringify(chatCard())));
  assert.equal(r.version, 'v2');
  assert.deepEqual(Object.keys(r.patch).sort(), ['creator', 'description', 'examples', 'name', 'personality', 'tags']);
  assert.deepEqual(r.patch.examples, [{ user: 'What are you reading?', character: 'Something nobody asked me to.' }, { user: 'Can you help me?', character: 'Depends what with.' }]);
  assert.deepEqual(Object.keys(r.appSide).sort(), ['alternate_greetings', 'character_book', 'first_mes', 'post_history_instructions', 'scenario', 'system_prompt']);
  assert.deepEqual(r.leftOut.sort(), ['character_version', 'creator_notes', 'extensions']);
  assert.ok(r.notes.some((n) => /memory or chats/.test(n)));
});

test('V1, V3 and PNG cards are read; a card is written back as V2 or V3, and into a PNG (PER-3)', async () => {
  const v1 = p.cardToPersona({ name: 'Flat', description: 'A V1 card.', personality: 'Plain.', first_mes: 'Hi.', mes_example: '' });
  assert.equal(v1.version, 'v1');
  assert.equal(v1.appSide.first_mes, 'Hi.');
  const v3 = { spec: 'chara_card_v3', spec_version: '3.0', data: { ...chatCard().data, group_only_greetings: [], nickname: 'R' } };
  const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
  const withCard = p.cardPng(png, v3);
  const texts = p.pngTexts(withCard);
  assert.ok(texts.has('ccv3') && texts.has('chara'), 'a V3 card PNG carries a V2 card too, for older readers');
  const r = p.cardToPersona(withCard);
  assert.equal(r.version, 'v3');
  assert.equal(r.patch.name, 'Rook');
  // the persona back out as a card
  const b = await full();
  const card = p.personaToCard(p.personaOf(b));
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.data.name, 'Mira');
  assert.match(card.data.mes_example, /<START>\n\{\{user\}\}: Where are you going\?\n\{\{char\}\}: North\. Coming\?/);
  assert.equal(card.data.scenario, '');
  const back = p.cardToPersona(card);
  assert.deepEqual(back.patch.examples, p.personaOf(b).examples.map(({ user, character }) => ({ user, character })));
  const merged = p.personaToCard(p.personaOf(b), { version: 'v3', appSide: { scenario: 'At the gate.' } });
  assert.equal(merged.spec, 'chara_card_v3');
  assert.equal(merged.data.scenario, 'At the gate.');
  assert.deepEqual(merged.data.group_only_greetings, []);
  assert.throws(() => p.readCard({ spec: 'lorebook_v3', data: {} }), /not a character card format/);
  assert.throws(() => p.readCard(png), /carries no character card/);
});

test('no memory, ever: importing a card with chats and memories writes none of it into the bundle (PER-4, §11)', async () => {
  const b = await full();
  const r = p.cardToPersona(chatCard());
  await p.setPersona(b, r.patch);
  const bytes = await writeBundle(b);
  const all = await allText(bytes);
  for (const secret of ['SECRET-CHAT-LINE', 'SECRET-MEMORY-FACT', 'The archive is under the old palace', 'You meet Rook in the archive', 'Ah. You found the back door']) {
    assert.ok(!all.includes(secret), `"${secret}" is not in the bundle`);
  }
  // the database's own pages, inflated from the zip, hold the persona but not the card's story or memories
  const db = scanZip(bytes).entries.find((e) => e.name === 'character.sqlite');
  assert.ok(Buffer.from(db.data).toString('latin1').includes('Tall, in a grey coat'));
  // and every door a writer would use for memory is shut
  await assert.rejects(p.setPersona(b, { extensions: { memories: ['she likes tea'] } }), /names memory/);
  await assert.rejects(p.setPersona(b, { extensions: { 'x-acme.chat-log': [] } }), /names memory/);
  await assert.rejects(p.setPersona(b, { conversations: [] }), /names memory/);
  await assert.rejects(setSetting(b, 'x-acme.user_facts', 'lives in Oslo'), /names memory/);
  await assert.rejects(setSetting(b, 'x-acme.notes', 'User: hi\nMira: hello\nUser: how are you'), /conversation/);
  await setSetting(b, 'x-acme.theme', 'dark'); // an ordinary setting is fine
  assert.equal(b.database.settings['x-acme.theme'], 'dark');
  void inflateSync;
});
