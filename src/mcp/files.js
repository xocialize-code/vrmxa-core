// The agent tools with the app closed (MCP-10, plan 0.2 A1): the same seven tools as `vrmxa mcp --app`, over a
// .vrmxa read with the reference library. A file opens with `read` (file) or `run open`; changes made here are held in
// memory with Undo and Redo, and writing a file is an `ask` command, so it is refused: with the app closed there is no
// one to ask (MCP-6). The person writes files with the command-line tool. There is no renderer in Node, so `picture`
// is the thumbnail saved in the file, and says so.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readBundle, checkBundle, RefusedError, parseGlb } from '../index.js';
import { readEdits } from '../edit/index.js';
import * as closetOps from '../closet/index.js';
import * as character from '../character/index.js';
import * as voice from '../voice/index.js';
import * as persona from '../persona/index.js';
import * as anim from '../anim/index.js';
import { readSpecVrm } from '../node/index.js';
import { toolList, listFor, vetRun, kindOf, withContentNote, caller, CONTENT_NOTE } from './tools.js';

const CLOSET_CONTENT = ['closet.items[].name', 'closet.worn[]', 'closet.hair', 'closet.outfits[].name'];
const clone = (v) => structuredClone(v);

/** The open file and its undo list. */
class FileSession {
  constructor({ spec = null } = {}) { this.spec = spec; this.path = null; this.bundle = null; this.undoList = []; this.redoList = []; this.changes = 0; }

  async open(path) {
    const p = resolve(String(path));
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`${path}: no such file`);
    if (!/\.vrmxa$/i.test(p)) throw new Error(`${path}: not a character (.vrmxa); items (.vrmxw) open in the app`);
    let bundle;
    try { bundle = await readBundle(new Uint8Array(readFileSync(p)), { spec: this.specBytes() }); } catch (e) {
      if (e instanceof RefusedError) throw new Error(`${path}: refused by the checker: ${e.problems.filter((x) => x.severity === 'error').slice(0, 5).map((x) => `${x.code} ${x.where ?? ''} ${x.message}`).join('; ')}`);
      throw e;
    }
    this.path = p; this.bundle = bundle; this.undoList = []; this.redoList = []; this.changes = 0;
    return this.summary();
  }

  specBytes() { if (this.spec === null) { try { this.spec = readSpecVrm() ?? false; } catch { this.spec = false; } } return this.spec || null; }

  need() { if (!this.bundle) throw new Error('no file is open: read with file, or run open with path (a .vrmxa)'); return this.bundle; }

  snapshot() { const b = this.need(); return { manifest: clone(b.manifest), docs: clone(b.docs), entries: new Map(b.entries), database: clone(b.database), avatarCurrent: b.avatarCurrent }; }

  restore(s) { Object.assign(this.bundle, { manifest: s.manifest, docs: s.docs, entries: s.entries, database: s.database, avatarCurrent: s.avatarCurrent }); }

  /** One change as one undo step: on failure the file is as it was. */
  async change(label, fn) {
    const before = this.snapshot();
    try {
      const r = await fn(this.bundle);
      this.undoList.push({ label, state: before }); this.redoList = []; this.changes++;
      return r;
    } catch (e) { this.restore(before); throw e; }
  }

  undo() {
    const step = this.undoList.pop();
    if (!step) return { undone: null, note: 'nothing to undo' };
    this.redoList.push({ label: step.label, state: this.snapshot() }); this.restore(step.state); this.changes--;
    return { undone: step.label, nextUndo: this.undoList.at(-1)?.label ?? null, nextRedo: step.label };
  }

  redo() {
    const step = this.redoList.pop();
    if (!step) return { redone: null, note: 'nothing to redo' };
    this.undoList.push({ label: step.label, state: this.snapshot() }); this.restore(step.state); this.changes++;
    return { redone: step.label, nextUndo: step.label, nextRedo: this.redoList.at(-1)?.label ?? null };
  }

  summary() {
    const b = this.need();
    const c = closetOps.closetOf(b);
    const name = (id) => c.items.find((e) => e.id === id)?.name ?? id;
    return {
      file: this.path, fileName: basename(this.path), id: b.manifest.id, name: b.manifest.title ?? character.detailsOf(b).meta?.name ?? null, revision: b.manifest.revision,
      unsavedChanges: this.undoList.length > 0, hair: c.hair ? name(c.hair) : null, worn: c.worn.items.map(name), items: c.items.length, outfits: c.outfits.length,
      voices: (b.docs.voices?.voices || []).length, clips: (b.docs.animations?.clips || []).length, persona: !!b.manifest.sections?.persona,
      fileContent: { fields: ['name', 'hair', 'worn[]'], note: CONTENT_NOTE },
    };
  }
}

const findItem = (bundle, ref) => {
  const c = closetOps.closetOf(bundle);
  const named = c.items.filter((x) => x.name === ref);
  const e = c.items.find((x) => x.id === ref) || named[0];
  if (!e) throw new Error(`no item "${ref}" in the closet: read closet for the ids and names`);
  if (named.length > 1 && e.id !== ref) throw new Error(`more than one item is named "${ref}": give its id`);
  return e;
};
const findOutfit = (bundle, ref) => {
  const o = closetOps.closetOf(bundle).outfits.find((x) => x.id === ref || x.name === ref);
  if (!o) throw new Error(`no outfit "${ref}": read closet for the outfits`);
  return o;
};
const closetFacts = (bundle) => {
  const c = closetOps.closetOf(bundle);
  const name = (id) => c.items.find((e) => e.id === id)?.name ?? id;
  return {
    items: c.items.map((e) => ({ id: e.id, name: e.name, slot: e.slot, kind: e.kind, worn: c.worn.items.includes(e.id), hair: c.hair === e.id, state: c.worn.items.includes(e.id) ? (c.worn.states[e.id] || e.states?.[0]?.name || null) : null, states: (e.states || []).map((s) => s.name), fitting: e.fitting || null })),
    worn: c.worn.items.map(name), hair: c.hair ? name(c.hair) : null,
    outfits: c.outfits.map((o) => ({ id: o.id, name: o.name, items: (o.items || []).length })), outfit: closetOps.outfitStatus(c),
  };
};
// HON-1 with the app closed: a piece whose maker doesn't allow changes or passing it on, or one that would tighten the
// character's permissions, is the person's to accept; the call is refused with the questions (MCP-6)
const honourOrAsk = (bundle, ids, what) => {
  const q = character.questionsBeforeWearing(bundle, ids);
  if (q.length) throw new Error(`${what} needs the person's answer first (HON-1): ${q.map((x) => x.text).join(' ')} With the app closed nobody can answer here: the person can wear it in the app, or with vrmxa closet … --accept-terms.`);
};
const specMeta = (spec) => { try { return spec ? parseGlb(spec).json.extensions.VRMC_vrm.meta : null; } catch { return null; } };

/**
 * The commands `run` can call with the app closed. Their names, args and kinds follow the app's commands of the same
 * name (MCP-10: one set of tools in two forms); only what the library can do without a renderer is here.
 * @param {FileSession} s
 */
function fileCommands(s) {
  return {
    open: { area: 'file', kind: 'look', description: 'Open a .vrmxa (a path on this computer); it becomes the file the other commands work on. Unsaved changes to the previous one are dropped.', args: { path: 'string' },
      run: ({ path }) => s.open(path) },
    'get-edits': { area: 'character', kind: 'look', description: 'The edit document as stored, what is applied and what is ignored.', args: {}, content: ['document.editor'],
      run: () => { const doc = s.need().docs.edits; if (!doc) return { document: null, note: 'no edit document: the character is Spec as it is' }; const r = readEdits(doc); return { document: doc, applied: r.edits, ignored: r.ignored, refused: r.refused }; } },
    'get-closet': { area: 'closet', kind: 'look', description: 'The closet: items (id, name, slot, worn, state, states, fine-tuning), what is worn, the hair, the outfits.', args: {}, content: CLOSET_CONTENT.map((f) => f.slice(7)),
      run: () => closetFacts(s.need()) },
    'put-on': { area: 'closet', kind: 'change', description: 'Put an item on (an id or a name), in its default state or the one given; what its slot replaces comes off. A piece whose maker limits it is refused with the questions the person is asked (HON-1).', args: { item: 'string', state: 'string, optional' }, content: CLOSET_CONTENT,
      run: ({ item, state }) => s.change(`Put on ${item}`, async (b) => { const id = findItem(b, item).id; honourOrAsk(b, [id], 'put-on'); const r = await closetOps.putOn(b, id, state ? { state } : {}); return { removed: r?.removed ?? [], closet: closetFacts(b) }; }) },
    'take-off': { area: 'closet', kind: 'change', description: 'Take an item off (an id or a name).', args: { item: 'string' }, content: CLOSET_CONTENT,
      run: ({ item }) => s.change(`Take off ${item}`, async (b) => { await closetOps.takeOff(b, findItem(b, item).id); return { closet: closetFacts(b) }; }) },
    'set-state': { area: 'closet', kind: 'change', description: "Switch a worn item's state.", args: { item: 'string', state: 'string' }, content: CLOSET_CONTENT,
      run: ({ item, state }) => s.change(`${item}: ${state}`, async (b) => { await closetOps.setState(b, findItem(b, item).id, state); return { closet: closetFacts(b) }; }) },
    'choose-hair': { area: 'closet', kind: 'change', description: 'Wear one of the closet\'s hair pieces (an id or a name), or none (null).', args: { id: 'string | null' }, content: CLOSET_CONTENT,
      run: ({ id }) => s.change(id ? `Hair ${id}` : 'No hair', async (b) => { const hid = id ? findItem(b, id).id : null; if (hid) honourOrAsk(b, [hid], 'choose-hair'); await closetOps.changeHair(b, hid); return { closet: closetFacts(b) }; }) },
    'apply-outfit': { area: 'closet', kind: 'change', description: 'Wear an outfit (an id or a name): everything worn is replaced by it; the hair stays.', args: { outfit: 'string' }, content: CLOSET_CONTENT,
      run: ({ outfit }) => s.change(`Wear ${outfit}`, async (b) => { const o = findOutfit(b, outfit); const worn = closetOps.closetOf(b).worn.items; honourOrAsk(b, (o.items || []).filter((x) => !worn.includes(x)), 'apply-outfit'); await closetOps.applyOutfit(b, o.id); return { closet: closetFacts(b) }; }) },
    'save-outfit': { area: 'closet', kind: 'change', description: 'Save what is worn as a new outfit.', args: { name: 'string, optional' }, content: CLOSET_CONTENT,
      run: ({ name }) => s.change(`Save outfit ${name ?? ''}`.trim(), async (b) => ({ id: await closetOps.saveOutfit(b, name), closet: closetFacts(b) })) },
    'delete-outfit': { area: 'closet', kind: 'change', description: 'Delete an outfit; what is worn stays.', args: { outfit: 'string' }, content: CLOSET_CONTENT,
      run: ({ outfit }) => s.change(`Delete outfit ${outfit}`, async (b) => { await closetOps.deleteOutfit(b, findOutfit(b, outfit).id); return { closet: closetFacts(b) }; }) },
    'remove-item': { area: 'closet', kind: 'change', description: 'Remove an item from the closet (a worn one is taken off first).', args: { item: 'string' }, content: CLOSET_CONTENT,
      run: ({ item }) => s.change(`Remove ${item}`, async (b) => { await closetOps.removeItem(b, findItem(b, item).id, { takeOff: true }); return { closet: closetFacts(b) }; }) },
    'get-details': { area: 'details', kind: 'look', description: "The character's details (VRM meta), origin, whether the permissions were chosen, and the limits the worn pieces set.", args: {}, content: ['meta', 'listing'],
      run: () => character.detailsOf(s.need(), { baseMeta: specMeta(s.specBytes()) }) },
    'set-details': { area: 'details', kind: 'change', description: 'Change the details: name, version, authors (a list), copyrightInformation, contactInformation, references, licenseUrl, and the permissions; null removes an optional one. A permission looser than a worn piece allows is refused, naming it.', args: { patch: 'object' }, content: ['meta'],
      run: ({ patch }) => s.change('Change details', async (b) => { await character.setDetails(b, patch, { baseMeta: specMeta(s.specBytes()) }); return character.detailsOf(b); }) },
    'get-licences': { area: 'details', kind: 'look', description: 'Whose each item, clip and voice is and what its maker allows, what would be asked before wearing, and what a shared copy leaves out.', args: {}, content: ['table', 'questions[].text', 'share.notes[]'],
      run: () => { const b = s.need(); return { table: character.licenceTable(b), questions: character.questionsBeforeWearing(b, closetOps.closetOf(b).items.map((e) => e.id)), share: character.shareReport(b) }; } },
    'get-voices': { area: 'voice', kind: 'look', description: "The character's voices: how each was made, whose it is, what it allows, consent, clips and their warnings.", args: {}, content: ['[].name', '[].speaker', '[].clips[].transcript', '[].licence'],
      run: () => voice.voiceSummaries(s.need()) },
    'get-persona': { area: 'persona', kind: 'look', description: 'The core persona (VRMXA §10.1), or null.', args: {}, content: ['persona'],
      run: () => ({ persona: persona.personaOf(s.need()) }) },
    'set-persona': { area: 'persona', kind: 'change', description: 'Change the core persona: name, age, summary, description, personality, traits, speech_style, languages, rest_expression, allowed_expressions, voice_id, creator, tags, examples. Anything that names memory is refused.', args: { patch: 'object' }, content: ['persona'],
      run: ({ patch }) => s.change('Change persona', async (b) => { await persona.setPersona(b, patch); return { persona: persona.personaOf(b) }; }) },
    'get-motion': { area: 'motion', kind: 'look', description: 'The clips (name, duration, loops, source, licence, corrections) and the sets with what each slot plays for what is worn.', args: {}, content: ['clips[].name', 'clips[].source', 'clips[].licence', 'sets[].name'],
      run: () => { const b = s.need(); const doc = b.docs.animations || anim.emptyAnimations(); return { clips: doc.clips, sets: doc.sets }; } },
    validate: { area: 'file', kind: 'look', description: 'Check the character as it is here with the reference library: each finding with its rule and section.', args: {},
      run: async () => { const b = s.need(); const { writeBundle } = await import('../index.js'); const bytes = await writeBundle({ ...b, manifest: clone(b.manifest) }); const p = await checkBundle(bytes, { spec: s.specBytes() }); return { ok: !p.some((x) => x.severity === 'error'), problems: p.map((x) => ({ severity: x.severity, code: x.code, where: x.where, message: x.message, section: x.section })) }; } },
    'save-character': { area: 'file', kind: 'ask', asks: 'writes a file', description: 'Write the character with the changes made here to a .vrmxa. Refused with the app closed: there is no one to ask (MCP-6).', args: { to: 'string, optional (the open file when absent)' },
      run: () => { throw new Error('refused'); } },
  };
}

/** The file target: { tools, call } for the server. */
export function createFileTools({ file = null, spec = null } = {}) {
  const s = new FileSession({ spec });
  const registry = fileCommands(s);
  let opened = file ? s.open(file).catch((e) => { opened = null; throw e; }) : null;
  const ready = async () => { if (opened) { const p = opened; opened = null; await p; } };
  const AREA = {
    character: () => s.summary(),
    edits: () => registry['get-edits'], closet: () => registry['get-closet'], motion: () => registry['get-motion'], details: () => registry['get-details'],
    licences: () => registry['get-licences'], voices: () => registry['get-voices'], persona: () => registry['get-persona'], validation: () => registry.validate,
  };
  const handlers = {
    async status() {
      await ready().catch(() => {});
      return { connected: 'file', note: 'the app is closed: these tools work on a .vrmxa with the reference library; nothing is written', open: s.bundle ? s.summary() : null,
        nextUndo: s.undoList.at(-1)?.label ?? null, nextRedo: s.redoList.at(-1)?.label ?? null, spec: s.specBytes() ? 'found' : 'not found (the item bind check is skipped)' };
    },
    async read({ area, file: path }) {
      await ready();
      if (path) await s.open(path);
      const a = AREA[area];
      if (!a) throw new Error(`area: one of ${Object.keys(AREA).join(', ')}`);
      const got = a();
      if (got && typeof got.run === 'function') return withContentNote(await got.run({}), got.content);
      return got;
    },
    commands(q) { return listFor(registry, q); },
    async run({ command, args }) {
      await ready();
      const err = vetRun(registry, command, args, 'file');
      if (err) throw new Error(err);
      const c = registry[command];
      const result = await c.run(args ?? {});
      return { command, kind: kindOf(c, args ?? {}), ...(c.kind === 'change' ? { nextUndo: s.undoList.at(-1)?.label ?? null } : {}), result: withContentNote(result, c.content) };
    },
    async picture() {
      await ready();
      const b = s.need();
      const png = b.entries.get(b.manifest.thumbnail || 'thumbnail.png');
      if (!png) throw new Error('the file has no thumbnail, and there is no renderer with the app closed: open it in the studio (vrmxa mcp --app) for a picture');
      return { image: { data: Buffer.from(png).toString('base64'), mimeType: 'image/png' }, text: { picture: 'the thumbnail saved in the file', changedHere: s.undoList.length > 0, note: s.undoList.length ? 'changes made here since opening are not in it: there is no renderer with the app closed' : 'as saved' } };
    },
    undo: async () => { await ready(); s.need(); return s.undo(); },
    redo: async () => { await ready(); s.need(); return s.redo(); },
  };
  return { tools: toolList('file'), call: caller(handlers), registry, session: s };
}
