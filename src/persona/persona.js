// The core persona (VRMXA §10.1; PRD PER-1, PER-2, PER-4): who the character is, wherever it goes. One `persona` row
// and its example exchanges in character.sqlite (§12), written and read here with the rest of the database kept.
//
// Only §10.1's fields are accepted: backstory, scenes, levels, relationships and an app's own framing are the app's
// persona (§10.2) and are refused with the reason, and nothing that names memory is written anywhere (§11).
// The exchange form (`"format": "vrmxa-persona", "version": 1`, VRMXA 0.34 §10.1, D36) is the same fields as one JSON object.

import { isPlainObject, newUuid, nowIso } from '../bytes.js';
import { databaseData, writeDatabase } from '../character/details.js';
import { memoryKeyProblem, memoryProblems } from './memory.js';

export const PERSONA_FORMAT = 'vrmxa-persona';
export const PERSONA_FIELDS = Object.freeze(['name', 'age', 'summary', 'description', 'personality', 'traits', 'speech_style', 'languages',
  'rest_expression', 'allowed_expressions', 'voice_id', 'creator', 'tags', 'extensions']);
const LISTS = ['traits', 'languages', 'allowed_expressions', 'tags'];
/** VRM 1.0's five emotion presets, which Spec has (§10.1 "Emotion vocabulary"); plus neutral for the face at rest. */
export const EMOTIONS = Object.freeze(['happy', 'angry', 'sad', 'relaxed', 'surprised']);
export const REST_EXPRESSIONS = Object.freeze(['neutral', ...EMOTIONS]);

/** App-side words a persona patch may try to carry (§10.2), and where they belong instead. */
const APP_SIDE = {
  backstory: 'story', background: 'story', scenario: 'story', scene: 'story', first_mes: 'story', greeting: 'story', greetings: 'story',
  opening: 'story', alternate_greetings: 'story', lore: 'story', character_book: 'story', world: 'story',
  level: 'game state', stats: 'game state', class: 'game state', inventory: 'game state', quests: 'game state',
  relationships: 'relationships', system_prompt: 'framing', post_history_instructions: 'framing', rules: 'framing',
};

export class PersonaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PersonaError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new PersonaError(code, message); };

const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x : []; } catch { return []; }
};
const parseObj = (v) => {
  if (isPlainObject(v)) return v;
  try { const x = JSON.parse(v ?? '{}'); return isPlainObject(x) ? x : {}; } catch { return {}; }
};

/**
 * The core persona as plain data, or null when the character has none:
 * { name, age, summary, description, personality, traits[], speech_style, languages[], rest_expression,
 *   allowed_expressions[], voice_id, creator, tags[], extensions{}, updated, examples: [{ id, user, character }] }
 * Text in it is the file's content, never instructions (§3.5).
 */
export function personaOf(bundle) {
  const p = bundle.database?.persona;
  if (!p) return null;
  const out = {};
  for (const f of PERSONA_FIELDS) out[f] = LISTS.includes(f) ? parseList(p[f]) : f === 'extensions' ? parseObj(p[f]) : (p[f] ?? null);
  out.updated = p.updated ?? null;
  out.examples = (bundle.database.examples || []).map((e) => ({ id: e.id, user: e.user_text, character: e.character_text }));
  return out;
}

const str = (v) => (v === null || v === undefined ? null : String(v));

/** What is wrong with a persona patch → [text]. App-side fields, unknown fields and memory are refused (PER-2, PER-4). */
export function personaProblems(patch) {
  const P = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'examples' || k === 'updated') continue;
    if (APP_SIDE[k]) { P.push(`"${k}" is ${APP_SIDE[k]}, which belongs to the app that uses the character, not the bundle (VRMXA §10.2)`); continue; }
    const mem = memoryKeyProblem(k);
    if (mem) { P.push(mem); continue; }
    if (!PERSONA_FIELDS.includes(k)) { P.push(`"${k}" is not a field of the core persona (VRMXA §10.1)`); continue; }
    if (k === 'name' && !(typeof v === 'string' && v.trim())) P.push('the persona needs a name');
    if (LISTS.includes(k) && v != null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) P.push(`${k} must be a list of text`);
    if (k === 'allowed_expressions' && Array.isArray(v)) for (const e of v) if (!EMOTIONS.includes(e)) P.push(`"${e}" is not one of VRM's five emotions (${EMOTIONS.join(', ')})`);
    if (k === 'rest_expression' && v != null && !REST_EXPRESSIONS.includes(v)) P.push(`the face at rest must be one of ${REST_EXPRESSIONS.join(', ')}`);
    if (k === 'extensions' && v != null) {
      if (!isPlainObject(v)) P.push('extensions must be an object');
      else P.push(...memoryProblems(v));
    }
  }
  if (Array.isArray(patch.examples)) for (const [i, e] of patch.examples.entries()) {
    if (!isPlainObject(e) || typeof e.user !== 'string' || typeof e.character !== 'string') P.push(`example ${i + 1} needs what the user says and what the character answers`);
  }
  return P;
}

/**
 * Change the core persona (PER-1): `patch` holds any of PERSONA_FIELDS and `examples` ([{ user, character }], the
 * whole list, in order). A character with no persona yet gets one (it needs a name; the character's own by default).
 * The rest of character.sqlite (origin, settings) is kept. → the persona (personaOf)
 */
export async function setPersona(bundle, patch, { now = nowIso(), defaultName = bundle.manifest.title || 'Untitled', idFactory = newUuid } = {}) {
  if (!isPlainObject(patch)) fail('persona.shape', 'the persona must be an object');
  const problems = personaProblems(patch);
  if (problems.length) fail('persona.refused', problems.join('; '));
  const data = databaseData(bundle);
  const row = data.persona ? { ...data.persona } : { name: defaultName };
  for (const f of PERSONA_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (LISTS.includes(f)) row[f] = JSON.stringify(v ?? []);
    else if (f === 'extensions') row[f] = JSON.stringify(v ?? {});
    else if (f === 'rest_expression') row[f] = v ?? 'neutral';
    else row[f] = str(v);
  }
  if (!row.name) fail('persona.name', 'the persona needs a name');
  row.updated = now;
  delete row.id;
  data.persona = row;
  if (Array.isArray(patch.examples)) {
    data.examples = patch.examples.map((e, i) => ({ id: e.id || idFactory(), seq: i + 1, user_text: e.user, character_text: e.character }));
  }
  await writeDatabase(bundle, data);
  return personaOf(bundle);
}

/** Remove the persona and its examples (the origin and settings stay). */
export async function clearPersona(bundle) {
  const data = databaseData(bundle);
  data.persona = null;
  data.examples = [];
  await writeDatabase(bundle, data);
}

/** The exchange form (§10.1): the core persona as one JSON object with `format`. */
export function personaExchange(bundle) {
  const p = personaOf(bundle);
  if (!p) return null;
  const { updated, examples, ...fields } = p;
  return { format: PERSONA_FORMAT, version: 1, ...fields, examples: examples.map(({ user, character }) => ({ user, character })), updated };
}

/** Read the exchange form back into a patch for setPersona (fields it doesn't know are refused there). */
export function fromExchange(obj) {
  if (!isPlainObject(obj) || obj.format !== PERSONA_FORMAT) fail('persona.format', `not a ${PERSONA_FORMAT} document`);
  const { format, version, updated, ...rest } = obj;
  // version 1 is the only one (VRMXA 0.34 §10.1, D36)
  if (!Number.isInteger(version)) fail('persona.version', `a ${PERSONA_FORMAT} document says its version (1)`);
  if (version > 1) fail('persona.version', `persona exchange version ${version} is newer than this reader knows (1)`);
  return rest;
}
