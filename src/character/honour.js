// Honouring licences and consent (PRD §14: HON-1 to HON-4; OPEN-ISSUES R4). The specification states licences and
// leaves honouring them to apps (VRMXA §2 rule 6, §5.3); this is how the reference app does it.
//
//   HON-1  before a piece is merged or worn (or brought in by the importer, which moves it onto Spec), ask when its
//          maker doesn't allow changes or passing it on, naming the piece and the term. The person's answer is kept as
//          the character's setting `x-xocialize.honoured.<item id>` (the terms answered and when), so the same
//          question isn't asked again for the same terms; a shared copy drops these answers (they are this person's).
//   HON-2  a voice that may not be passed on is left out of a shared copy, and the app says so. Items the same way: a
//          file whose maker doesn't allow passing it on stays out of the copy's closet, and a worn piece whose maker
//          doesn't allow passing on a changed copy is taken off in the copy (fitting it to her body changed it).
//   HON-3  a real person's voice isn't saved without recorded consent: voice/voices.js.
//   HON-4  credits: the makers of every piece that asks for credit.

import { closetOf } from '../closet/ops.js';
import { voicesOf } from '../voice/voices.js';
import { HONOURED_PREFIX, avatarMeta, settingOf, tighteningFor, tighteningLines } from './details.js';
import { effective, licenceLine, wordsFor } from './terms.js';

const whoOf = (meta) => (Array.isArray(meta?.authors) && meta.authors.length ? meta.authors.join(', ') : 'its maker');

/**
 * The terms a person is asked about before a piece is merged or worn (HON-1): its maker doesn't allow changes
 * (`modification` prohibited: wearing fits it to the body, and merging writes it into avatar.vrm), or doesn't allow
 * passing it on (`allowRedistribution` false: it then travels inside her file). Absent terms are VRM's defaults
 * (VRMXW §11), so an item that states nothing is asked about too.
 * piece: { id, name, meta } → [{ id, name, whose, term, value, text }]
 */
export function termsToAsk(piece, { action = 'wear' } = {}) {
  const e = effective(piece.meta, { kind: 'item' });
  const out = [];
  const who = whoOf(piece.meta);
  const name = piece.name || piece.id;
  const doing = action === 'import' ? 'Bringing it in moves it onto Spec, which changes it' : 'Wearing it fits it to the character\'s body and writes it into avatar.vrm, which changes it';
  if (e.modification === 'prohibited') out.push({ id: piece.id, name, whose: who, term: 'modification', value: e.modification, text: `"${name}": ${who} doesn't allow changes (${wordsFor('modification', e.modification)}). ${doing}.` });
  if (e.allowRedistribution !== true) out.push({ id: piece.id, name, whose: who, term: 'redistribution', value: false, text: `"${name}": ${who} doesn't allow passing it on. ${action === 'import' ? 'It will be in the closet' : 'It will be inside the character\'s file'}; a shared copy leaves it out.` });
  return out;
}

const answeredKey = (id) => `${HONOURED_PREFIX}${id}`;

/** The terms the person already answered for a piece in this character, or []. */
export function answeredTerms(bundle, id) {
  const raw = settingOf(bundle, answeredKey(id));
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v.terms) ? v.terms : []; } catch { return []; }
}

/**
 * The questions to ask before these closet items are worn (HON-1): each item's terms to ask that the person hasn't
 * answered in this character. ids: closet item ids. → [question]
 */
export function questionsBeforeWearing(bundle, ids, { action = 'wear' } = {}) {
  const closet = closetOf(bundle);
  const out = [];
  const pieces = [];
  for (const id of ids) {
    const e = closet.items.find((x) => x.id === id);
    if (!e) continue;
    pieces.push({ id, name: e.name, meta: e.meta });
    const done = answeredTerms(bundle, id);
    for (const q of termsToAsk({ id, name: e.name, meta: e.meta }, { action })) if (!done.includes(q.term)) out.push(q);
  }
  // putting them on tightens what they don't allow, and the person is told first, every time (VRMXA §5.3, D35)
  out.push(...tighteningQuestions(bundle, pieces));
  return out;
}

/** The tightening wearing these pieces would do, as questions (term 'tighten'): told before the piece is worn (D35). */
export function tighteningQuestions(bundle, pieces) {
  const changes = tighteningFor(bundle, pieces);
  return tighteningLines(changes).map((text, i) => ({ id: changes[i].ids[0], name: changes[i].by[0], whose: null, term: 'tighten', key: changes[i].key, from: changes[i].from, value: changes[i].to, text }));
}

/** The setting that records the person's answer to these questions (applied with details.js setSetting). → [key, value] */
export function answerSetting(id, terms, { now = new Date().toISOString() } = {}) {
  return [answeredKey(id), JSON.stringify({ terms: [...new Set(terms)].sort(), at: now })];
}

// ---- HON-4 credits -----------------------------------------------------------------------------------------------
/**
 * Who to credit (HON-4): the makers of every piece in the character whose terms ask for credit (`creditNotation`
 * required, or absent: VRM's default), its base included (Spec asks for none). Clips carry free-text licences
 * (VRMXA §8.4) and are listed with their licence text for the person to honour. → { makers: [{ maker, pieces:
 * [{ kind, id, name }] }], clips: [{ name, licence }], lines: [text] }
 */
export function credits(bundle, { baseMeta = null } = {}) {
  const byMaker = new Map();
  const add = (meta, piece) => {
    if (effective(meta, { kind: piece.kind === 'voice' ? 'voice' : 'item' }).creditNotation !== 'required') return;
    const makers = Array.isArray(meta?.authors) && meta.authors.length ? meta.authors : ['an unnamed maker'];
    for (const m of makers) {
      if (!byMaker.has(m)) byMaker.set(m, []);
      byMaker.get(m).push(piece);
    }
  };
  if (baseMeta) add(baseMeta, { kind: 'base', id: 'base', name: baseMeta.name || 'the base' });
  for (const e of closetOf(bundle).items) add(e.meta, { kind: e.slot === 'hair' ? 'hair' : 'item', id: e.id, name: e.name });
  const notices = [];
  for (const v of voicesOf(bundle).voices) {
    add(v.meta, { kind: 'voice', id: v.id, name: v.name });
    // a required notice or attribution of a model that made the voice is shown wherever the voice is credited (§9.2 madeWith)
    for (const m of Array.isArray(v.madeWith) ? v.madeWith : []) {
      for (const t of [m?.license?.attribution, m?.license?.notice]) if (t) notices.push({ voice: v.name, model: m.model, text: t });
    }
  }
  const anim = bundle.docs.animations?.clips || [];
  // a clip's licence: a block in VRM's terms is credited like an item; text is shown as it is (§8.4)
  for (const c of anim) if (c.licence && typeof c.licence === 'object') add(c.licence, { kind: 'clip', id: c.sha256, name: c.name || c.sha256.slice(0, 12) });
  const clips = anim.filter((c) => typeof c.licence === 'string' && c.licence).map((c) => ({ name: c.name || c.sha256.slice(0, 12), licence: c.licence }));
  const makers = [...byMaker].map(([maker, pieces]) => ({ maker, pieces })).sort((a, b) => a.maker.localeCompare(b.maker));
  const lines = makers.map((m) => `${m.maker}: ${m.pieces.map((p) => p.name).join(', ')}`);
  for (const n of notices) lines.push(`${n.voice} (made with ${n.model}): ${n.text}`);
  const seen = new Set();
  for (const c of clips) if (!seen.has(c.licence)) { seen.add(c.licence); lines.push(`Motions: ${c.licence}`); }
  return { makers, clips, notices, lines };
}

// ---- HON-2 what a shared copy or a VRM for sharing leaves out ------------------------------------------------------
/**
 * What may not go into a copy for someone else (EXP-2, HON-2), and why:
 *   voices     whose maker doesn't allow passing them on (§9.3)
 *   items      closet files whose maker doesn't allow passing them on: left out of the copy's closet (taken off if worn)
 *   changed    worn pieces (hair included) whose file may be passed on but not a changed copy: taken off in the copy
 *   clips      clips whose licence is text: carried, and listed for the person to judge (SPEC-QUESTIONS #71)
 *   own        the character's own permissions say she may not be passed on (the person is her maker: theirs to decide)
 * → { voices: [{ id, name, why }], items: [...], changed: [...], clips: [...], own: text|null, notes: [text] }
 */
export function shareReport(bundle) {
  const closet = closetOf(bundle);
  const worn = new Set([...closet.worn.items, ...(closet.hair ? [closet.hair] : [])]);
  const voices = voicesOf(bundle).voices.filter((v) => v.meta?.allowRedistribution !== true)
    .map((v) => ({ id: v.id, name: v.name, why: `${whoOf(v.meta)} doesn't allow passing ${v.realPerson ? `${v.speaker || 'this person'}'s voice` : 'this voice'} on` }));
  const items = [], changed = [];
  for (const e of closet.items) {
    const t = effective(e.meta, { kind: 'item' });
    if (t.allowRedistribution !== true) items.push({ id: e.id, name: e.name, slot: e.slot, worn: worn.has(e.id), why: `${whoOf(e.meta)} doesn't allow passing it on` });
    else if (worn.has(e.id) && t.modification !== 'allowModificationRedistribution') changed.push({ id: e.id, name: e.name, slot: e.slot, why: `${whoOf(e.meta)} doesn't allow passing on a changed copy, and wearing it fitted it to the character` });
  }
  const all = bundle.docs.animations?.clips || [];
  // clips with a licence block are honoured (§8.4): one that may not be passed on is left out; text is shown, not judged
  const clipsOut = all.filter((c) => c.licence && typeof c.licence === 'object' && c.licence.allowRedistribution !== true)
    .map((c) => ({ sha256: c.sha256, name: c.name || c.sha256.slice(0, 12), why: `${whoOf(c.licence)} doesn't allow passing it on` }));
  const clips = all.filter((c) => typeof c.licence === 'string' && c.licence).map((c) => ({ sha256: c.sha256, name: c.name || c.sha256.slice(0, 12), licence: c.licence }));
  const own = avatarMeta(bundle);
  const ownNote = own && own.allowRedistribution === false ? 'The character\'s own details don\'t allow passing the character on. As its maker, sharing it is yours to decide; the copy carries those terms.' : null;
  const notes = [];
  for (const v of voices) notes.push(`The voice "${v.name}" is left out: ${v.why}.`);
  for (const i of items) notes.push(`"${i.name}" is left out${i.worn ? ' and taken off' : ''}: ${i.why}.`);
  for (const c of changed) notes.push(`"${c.name}" is taken off in the copy (it stays in the closet): ${c.why}.`);
  for (const c of clipsOut) notes.push(`The motion "${c.name}" is left out: ${c.why}.`);
  return { voices, items, changed, clips, clipsOut, own: ownNote, notes };
}

/**
 * What a plain VRM for someone else leaves out (EXP-3 with "To share"): the worn pieces whose maker doesn't allow
 * passing them on, or passing on a changed copy. → { items: [{ id, name, why }], notes }
 */
export function vrmShareReport(bundle) {
  const r = shareReport(bundle);
  const items = [...r.items.filter((i) => i.worn), ...r.changed];
  return { items, notes: items.map((i) => `"${i.name}" is left out of the VRM: ${i.why}.`) };
}

/**
 * Everything a list row needs to say whose a piece is and what its maker allows (LIC-5), for every item, clip and
 * voice of the character. → { items: [{ id, name, slot, ...licenceLine }], clips: [...], voices: [...] }
 */
export function licenceTable(bundle) {
  return {
    items: closetOf(bundle).items.map((e) => ({ id: e.id, name: e.name, slot: e.slot, ...licenceLine(e.meta, { kind: 'item' }) })),
    clips: (bundle.docs.animations?.clips || []).map((c) => ({ sha256: c.sha256, name: c.name || c.sha256.slice(0, 12), source: c.source ?? null, block: !!(c.licence && typeof c.licence === 'object'), ...licenceLine(c.licence ?? null) })),
    voices: voicesOf(bundle).voices.map((v) => ({ id: v.id, name: v.name, ...licenceLine(v.meta, { kind: 'voice' }) })),
  };
}

