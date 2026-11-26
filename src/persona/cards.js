// Character cards (VRMXA §10.3, D7; PRD PER-3): the community Character Card formats, read into the core persona and
// written from it. Field names were checked against the published specs on 2026-11-17: Character Card V2
// (`spec: "chara_card_v2"`, `spec_version: "2.0"`, fields under `data`), V3 (`chara_card_v3`, `"3.0"`, V2's fields
// plus assets, nickname, creator_notes_multilingual, source, group_only_greetings, creation_date, modification_date)
// and V1, the flat form (name, description, personality, scenario, first_mes, mes_example). A PNG card keeps the JSON
// as base64 in a tEXt chunk: `ccv3` for V3 (preferred when both are there) and `chara` for V2.
//
// A card divides on import (§10.3):
//   core persona    name, description (looks and manner), personality, mes_example (→ example exchanges), tags, creator
//   the app's       scenario, first_mes, alternate_greetings, group_only_greetings, character_book, system_prompt,
//                   post_history_instructions: story and framing for the app that runs the character (§10.2)
//   left out        creator_notes, character_version, extensions, assets, nickname, source, dates: notes for the
//                   card's readers, an app's own data, pictures
// The app-side fields can't go in the bundle. What becomes of them is SPEC-QUESTIONS #72 (PRD OQ-1): here they are
// returned apart (`appSide`), never written into the bundle, so the app can show them and offer to keep the card file.

import { asBytes, concat, isPlainObject } from '../bytes.js';
import { crc32 } from '../zip.js';
import { memoryProblems } from './memory.js';

export const CARD_CORE = Object.freeze(['name', 'description', 'personality', 'mes_example', 'tags', 'creator']);
export const CARD_APP_SIDE = Object.freeze(['scenario', 'first_mes', 'alternate_greetings', 'group_only_greetings', 'character_book', 'system_prompt', 'post_history_instructions']);
export const CARD_LEFT_OUT = Object.freeze(['creator_notes', 'creator_notes_multilingual', 'character_version', 'extensions', 'assets', 'nickname', 'source', 'creation_date', 'modification_date']);

export class CardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CardError';
  }
}

// ---- PNG text chunks ---------------------------------------------------------------------------------------
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isPng = (u8) => u8.length > 8 && PNG_SIG.every((b, i) => u8[i] === b);
const latin1 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return s; };

/** The tEXt chunks of a PNG: Map(keyword → text as Latin-1). */
export function pngTexts(bytes) {
  const u8 = asBytes(bytes);
  if (!isPng(u8)) throw new CardError('not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = new Map();
  let p = 8;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p);
    const type = latin1(u8.subarray(p + 4, p + 8));
    if (p + 12 + len > u8.length) break;
    if (type === 'tEXt') {
      const data = u8.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z > 0) out.set(latin1(data.subarray(0, z)), latin1(data.subarray(z + 1)));
    }
    if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

/** A PNG with tEXt chunks set (others of the same keywords removed), placed before IEND. texts: { keyword: text (Latin-1) } */
export function withPngTexts(bytes, texts) {
  const u8 = asBytes(bytes);
  if (!isPng(u8)) throw new CardError('not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const keep = [u8.subarray(0, 8)];
  let p = 8, iend = null;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p);
    const type = latin1(u8.subarray(p + 4, p + 8));
    const chunk = u8.subarray(p, p + 12 + len);
    if (type === 'IEND') { iend = chunk; break; }
    let drop = false;
    if (type === 'tEXt') {
      const data = u8.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      drop = z > 0 && latin1(data.subarray(0, z)) in texts;
    }
    if (!drop) keep.push(chunk);
    p += 12 + len;
  }
  if (!iend) throw new CardError('the PNG has no end chunk');
  for (const [k, v] of Object.entries(texts)) {
    const body = new Uint8Array(k.length + 1 + v.length);
    for (let i = 0; i < k.length; i++) body[i] = k.charCodeAt(i);
    for (let i = 0; i < v.length; i++) body[k.length + 1 + i] = v.charCodeAt(i) & 0xff;
    const typed = concat([new Uint8Array([0x74, 0x45, 0x58, 0x74]), body]);
    const head = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, body.length);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(typed) >>> 0);
    keep.push(head, typed, crc);
  }
  keep.push(iend);
  return concat(keep);
}

const b64ToText = (s) => {
  const bin = typeof atob === 'function' ? atob(s.trim()) : Buffer.from(s.trim(), 'base64').toString('latin1');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(u8);
};
const textToB64 = (s) => {
  const u8 = new TextEncoder().encode(s);
  if (typeof btoa === 'function') { let bin = ''; for (const b of u8) bin += String.fromCharCode(b); return btoa(bin); }
  return Buffer.from(u8).toString('base64');
};

// ---- reading ---------------------------------------------------------------------------------------------------
/**
 * Read a card from a file's bytes (JSON or PNG) or an object. → { version: 'v1'|'v2'|'v3', data, from: 'json'|'png:ccv3'|'png:chara', notes }
 */
export function readCard(input) {
  const notes = [];
  let obj = input, from = 'json';
  if (input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const u8 = asBytes(input);
    if (isPng(u8)) {
      const t = pngTexts(u8);
      const raw = t.get('ccv3') ?? t.get('chara');
      if (!raw) throw new CardError('the picture carries no character card (no ccv3 or chara text chunk)');
      from = t.has('ccv3') ? 'png:ccv3' : 'png:chara';
      if (t.has('ccv3') && t.has('chara')) notes.push('the picture carries a V3 and a V2 card: the V3 one was read');
      try { obj = JSON.parse(b64ToText(raw)); } catch { throw new CardError('the card in the picture is not readable JSON'); }
    } else {
      try { obj = JSON.parse(new TextDecoder('utf-8').decode(u8)); } catch { throw new CardError('not a character card: neither JSON nor a PNG with a card in it'); }
    }
  }
  if (!isPlainObject(obj)) throw new CardError('a character card is a JSON object');
  if (obj.spec === 'chara_card_v3' || obj.spec === 'chara_card_v2') {
    if (!isPlainObject(obj.data)) throw new CardError(`a ${obj.spec} card keeps its fields under "data"`);
    const version = obj.spec === 'chara_card_v3' ? 'v3' : 'v2';
    const want = version === 'v3' ? '3.0' : '2.0';
    if (obj.spec_version && obj.spec_version !== want) notes.push(`spec_version is ${obj.spec_version}; read as ${want}`);
    return { version, data: obj.data, from, notes };
  }
  if (obj.spec) throw new CardError(`"${obj.spec}" is not a character card format this app reads (chara_card_v2, chara_card_v3, or the flat V1 form)`);
  if (typeof obj.name === 'string' && ('description' in obj || 'personality' in obj || 'first_mes' in obj)) return { version: 'v1', data: obj, from, notes };
  throw new CardError('not a character card: no name with a description or personality');
}

/**
 * mes_example → example exchanges. The usual layout: blocks begun by `<START>`, lines `{{user}}:` and `{{char}}:` (or the
 * character's name). → [{ user, character }]
 */
export function examplesFromMes(text, name = '') {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const charRe = new RegExp(`^\\s*(\\{\\{char\\}\\}|<BOT>${name ? `|${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` : ''})\\s*:\\s*`, 'i');
  const userRe = /^\s*(\{\{user\}\}|<USER>|You|User)\s*:\s*/i;
  for (const block of text.split(/<START>/i)) {
    let user = null, char = null, who = null;
    const flush = () => { if (user != null && char != null) out.push({ user: user.trim(), character: char.trim() }); user = null; char = null; };
    for (const line of block.split(/\r?\n/)) {
      if (userRe.test(line)) { if (char != null) flush(); user = (user ? `${user}\n` : '') + line.replace(userRe, ''); who = 'user'; }
      else if (charRe.test(line)) { char = (char ? `${char}\n` : '') + line.replace(charRe, ''); who = 'char'; }
      else if (line.trim() && who === 'user') user += `\n${line}`;
      else if (line.trim() && who === 'char') char += `\n${line}`;
    }
    flush();
  }
  return out;
}

/** Example exchanges → mes_example in the usual layout. */
export const mesFromExamples = (examples) => (examples || []).map((e) => `<START>\n{{user}}: ${e.user}\n{{char}}: ${e.character}`).join('\n');

const size = (v) => (typeof v === 'string' ? v.length : Array.isArray(v) ? v.length : isPlainObject(v) ? Object.keys(v).length : v == null ? 0 : 1);
const present = (v) => v != null && size(v) > 0;

/**
 * A card divided as §10.3 says. → { patch (for setPersona), appSide: { field: value } (never written into a bundle),
 * leftOut: [field], notes: [text], version }
 */
export function cardToPersona(input) {
  const card = readCard(input);
  const d = card.data;
  const notes = [...card.notes];
  const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null;
  if (!name) throw new CardError('the card has no name');
  const patch = { name };
  if (present(d.description)) patch.description = String(d.description);
  if (present(d.personality)) patch.personality = String(d.personality);
  if (Array.isArray(d.tags)) patch.tags = d.tags.filter((t) => typeof t === 'string');
  if (present(d.creator)) patch.creator = String(d.creator);
  const examples = examplesFromMes(d.mes_example, name);
  if (present(d.mes_example) && !examples.length) notes.push('its example messages were not in a layout this app reads ({{user}}: … / {{char}}: …), so no examples came over');
  if (examples.length) patch.examples = examples;
  if (present(d.description) && /\b(backstory|grew up|was born|years ago|history|past)\b/i.test(d.description)) notes.push('its description may hold background; the persona keeps looks and manner, and background is story for the app that runs the character (§10.3): check it');
  const appSide = {};
  for (const f of CARD_APP_SIDE) if (present(d[f])) appSide[f] = d[f];
  const leftOut = CARD_LEFT_OUT.filter((f) => present(d[f]));
  // anything in the card's extensions that names memory is a reason to say so, never to keep it
  if (isPlainObject(d.extensions) && memoryProblems(d.extensions).length) notes.push('its extensions name memory or chats: left out (VRMXA §11)');
  return { patch, appSide, leftOut, notes, version: card.version };
}

/**
 * The core persona as a card (§10.3 "Exporting a card puts the two back together"). `appSide` adds the app's fields
 * (the ones a card import returned, if the person kept them). version 'v2' (default, the most widely read) or 'v3'.
 * → the card object
 */
export function personaToCard(persona, { version = 'v2', appSide = {}, characterVersion = '' } = {}) {
  if (!persona?.name) throw new CardError('the character has no persona to export');
  const data = {
    name: persona.name,
    description: persona.description || '',
    personality: [persona.personality, persona.traits?.length ? `Traits: ${persona.traits.join(', ')}.` : '', persona.speech_style ? `Speech: ${persona.speech_style}` : ''].filter(Boolean).join('\n\n'),
    scenario: '',
    first_mes: '',
    mes_example: mesFromExamples(persona.examples),
    creator_notes: persona.summary || '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [...(persona.tags || [])],
    creator: persona.creator || '',
    character_version: characterVersion || '',
    extensions: {},
  };
  for (const f of CARD_APP_SIDE) if (appSide[f] !== undefined) data[f] = appSide[f];
  if (!data.character_book) delete data.character_book;
  if (version === 'v3') {
    data.group_only_greetings = Array.isArray(appSide.group_only_greetings) ? appSide.group_only_greetings : [];
    return { spec: 'chara_card_v3', spec_version: '3.0', data };
  }
  delete data.group_only_greetings;
  return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

/** A card written into a PNG (the character's thumbnail): `chara` (V2) always, and `ccv3` for a V3 card. → PNG bytes */
export function cardPng(png, card) {
  const texts = {};
  const v2 = card.spec === 'chara_card_v3' ? { spec: 'chara_card_v2', spec_version: '2.0', data: Object.fromEntries(Object.entries(card.data).filter(([k]) => !['group_only_greetings', 'assets', 'nickname', 'creator_notes_multilingual', 'source', 'creation_date', 'modification_date'].includes(k))) } : card;
  texts.chara = textToB64(JSON.stringify(v2));
  if (card.spec === 'chara_card_v3') texts.ccv3 = textToB64(JSON.stringify(card));
  return withPngTexts(png, texts);
}
