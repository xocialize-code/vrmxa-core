// @xocialize/vrmxa-core/persona — the core persona (VRMXA §10.1), character cards (§10.3) and the memory guard (§11).
export { personaOf, setPersona, clearPersona, personaExchange, fromExchange, personaProblems, PERSONA_FIELDS, PERSONA_FORMAT, EMOTIONS, REST_EXPRESSIONS, PersonaError } from './persona.js';
export { readCard, cardToPersona, personaToCard, cardPng, pngTexts, withPngTexts, examplesFromMes, mesFromExamples, CARD_CORE, CARD_APP_SIDE, CARD_LEFT_OUT, CardError } from './cards.js';
export { memoryKeyProblem, memoryProblems } from './memory.js';
