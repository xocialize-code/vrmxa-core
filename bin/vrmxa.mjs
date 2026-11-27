#!/usr/bin/env node
// vrmxa — the command-line tool for characters (.vrmxa) and items (.vrmxw) (PRD MCP-10).
// It runs the reference library directly. Plain text by default; --json for agents.
//
//   vrmxa inspect  <file|folder>            what is in it
//   vrmxa validate <file|folder>            check it; exit 0 when it passes, 1 when it doesn't
//   vrmxa pack     <folder> <out>           pack an open folder (files and hashes recomputed)
//   vrmxa unpack   <file> <folder>          check, then unpack to an open folder, byte for byte
//   vrmxa upgrade  <old.vrmxa> <out.vrmxa>  bring a version 2 to 4 bundle forward to version 5
//   vrmxa measure  <model.vrm>              measure a VRM's body (FITTING.md §4)
//   vrmxa edits    <file.vrmxa>             the character's edit document: as stored, what is applied, what is ignored
//   vrmxa apply-edits <file.vrmxa> <edits.json> <out.vrmxa>
//                                           set the edit document (EDITS.md version 7), write avatar.vrm
//                                           and the measurements again, and save as another file
//   vrmxa bake     <file.vrmxa> <out.vrm>   Spec with the character's edits, hair piece and worn items, as a plain VRM 1.0
//   vrmxa closet   <file.vrmxa>             the closet: items, what is worn (and in which state), outfits
//   vrmxa closet   <file.vrmxa> <operation> … <out>
//                                           a closet operation (CLOSET.md §5); avatar.vrm is redrawn when the look changes
//   vrmxa import   <model.vrm>              what the importer finds in a dressed VRM (0.x or 1.0): terms, pieces, groups
//   vrmxa fit      <model.vrm>              each garment's verdict: how it would transfer onto Spec by Spec-fit
//   vrmxa fit      <file.vrmxa|item.vrmxw> [--body <json>] [--on <char.vrmxa>] [--sweep] [--pose relaxed] [--own-weights] [--out <avatar.vrm>]
//                                           Spec-fit the worn tops, bottoms, one-pieces and coats to a body and print
//                                           FITTING.md §8's checks (skin through cloth, ease, hems, time)
//   vrmxa clip     check <clip.vrma|.bvh|.fbx> [--loops] [--in-place|--travel] [--lift <m>]
//                                           the clip checker (PRD ANI-13) on a clip file, on Spec
//   vrmxa clip     correct <clip> <out.vrma> --ops '<json>' | --auto
//                                           corrections (ANI-9 to ANI-12) applied to a clip file; numbers before and after
//   vrmxa motion   <file.vrmxa>             clips, their corrections, the sets, and what each slot plays for what is worn
//   vrmxa motion   <file.vrmxa> <operation> … <out.vrmxa>
//                                           add, starter, details, remove, check, correct, uncorrect, set-new, set, slot, set-remove
//   vrmxa import   <model.vrm> <folder> --approve all|g1,g2 …
//                                           write the approved groups as validated .vrmxw items, with import.json
//                                           (the decisions, to resume) and import-record.json (what came from where)
//   vrmxa details  <file.vrmxa> [set key=value … <out.vrmxa>]
//                                           the character's details, licence and origin (VRMXA §5.3); set them
//   vrmxa licence  <file.vrmxa> [--items <item,…>]
//                                           whose each piece is and what it allows, the limits they set, what would be
//                                           asked before wearing, and what a shared copy leaves out
//   vrmxa credits  <file.vrmxa>             the makers to credit (PRD HON-4)
//   vrmxa flatten  <file.vrmxa> [<folder>] [--state s,s]
//                                           the one flattener: every eye state's and the skin's finished textures,
//                                           with their hashes; written as PNGs when a folder is given
//   vrmxa export   <file.vrmxa> --vrm <out.vrm> [--share] | --item <item> <out.vrmxw>
//   vrmxa share    <file.vrmxa> <out.vrmxa> [--new-identity]
//   vrmxa voice    <file.vrmxa> [list|check] | import <clip.wav> --name N --transcript T … <out.vrmxa> | preset --engine E --preset P … <out.vrmxa>
//   vrmxa persona  <file.vrmxa> [show] | import <card.json|.png|persona.json> <out.vrmxa> | export <out.json|.png> [--card-version v3]
//   vrmxa fixtures [list|check] [--dir <fixtures>]
//                                           the specification's test files: what each is and covers; check that every one
//                                           behaves as fixtures/expected.json says, by this library and by the spec's checker
//   vrmxa conformance <their-output-dir> [--only id,id]   compare an app's output with the conformance kit (VRMXA_Specification/conformance)
//   vrmxa conformance run <out-dir> [--only id,id]   the reference library's own output for every case
//   vrmxa conformance cases                 the kit's cases: inputs, what to do, what to write
//   vrmxa mcp      --app [--port 5213]      the MCP server for agents (stdio), on the running studio
//   vrmxa mcp      [<file.vrmxa>]           the same tools on a file, with the app closed
// Options: --json, --spec <spec.vrm> (for the item bind check; found automatically when the
// specification repository is beside this one), --strict (warnings fail validation too),
// --force (pack or unpack over a non-empty folder / write a file that fails validation).
// Exit codes: 0 passed, 1 failed validation or refused, 2 bad usage or a file that can't be read.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBundle, checkItem, readBundle, writeBundle, bundleFromEntries, itemFromEntries, writeItem, documentPaths,
  measureVrm, scanZip, isZip, isGlb, findBase, VRMXA_MANIFEST, VRMXW_MANIFEST, RefusedError,
  setDocument, touchBundle, readItem, checkModel, sha256, parseGlb,
} from '../src/index.js';
import * as imp from '../src/import/index.js';
import { readEdits, editsRefusal, editsForSave, measureEdits } from '../src/edit/index.js';
import * as closetOps from '../src/closet/index.js';
import * as anim from '../src/anim/index.js';
import * as character from '../src/character/index.js';
import * as voice from '../src/voice/index.js';
import * as persona from '../src/persona/index.js';
import * as layers from '../src/layers/index.js';
import { encodePng } from '../src/edit/png.js';
import { readFolder, writeFolder, readSpecVrm, findSpecRepo } from '../src/node/index.js';

const argv = process.argv.slice(2);
const VALUED = ['--dir', '--only', '--kit', '--spec', '--listing', '--doc', '--approve', '--skip', '--into', '--out', '--name', '--merge', '--type', '--tags', '--body', '--on', '--place', '--ops', '--lift', '--requires', '--priority', '--root', '--speed', '--licence', '--source', '--loops',
  '--transcript', '--language', '--origin', '--speaker', '--consent-date', '--consent-scope', '--consent-record', '--vrm', '--item', '--items', '--style', '--card-version', '--app-fields', '--port', '--engine', '--preset', '--meta', '--state'];
const flags = new Set(argv.filter((a) => a.startsWith('--') && !VALUED.includes(a)));
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const pos = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
const [cmd, ...args] = pos;
const asJson = flags.has('--json');
// written synchronously: the commands end with process.exit, which would cut off output still queued for a pipe (64 KB)
const say = (fd, str) => { const b = Buffer.from(str); let o = 0; while (o < b.length) { try { o += writeSync(fd, b, o); } catch (e) { if (e.code !== 'EAGAIN') throw e; } } };
const out = (obj, text) => { if (asJson) say(1, `${JSON.stringify(obj, null, 2)}\n`); else say(1, `${text}\n`); };
const fail = (code, message) => {
  if (asJson) say(1, `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  else say(2, `vrmxa: ${message}\n`);
  process.exit(code);
};

const USAGE = `usage: vrmxa <command> [options]
  inspect  <file|folder>             what is in a character or an item
  validate <file|folder>             check it (exit 0 passed, 1 failed)
  pack     <folder> <out>            pack an open folder into a .vrmxa or .vrmxw
  unpack   <file> <folder>           check, then unpack to an open folder
  upgrade  <old.vrmxa> <out.vrmxa>   bring a version 2 to 4 bundle forward to version 5
  measure  <model.vrm>               measure a VRM's body
  edits    <file.vrmxa>              the edit document: stored, applied, ignored
  apply-edits <file.vrmxa> <edits.json> <out.vrmxa>
                                     set the edit document; write avatar.vrm and the measurements again
  bake     <file.vrmxa> <out.vrm>    Spec with the edits, the hair piece and the worn items, as a plain VRM 1.0
  fit      <model.vrm>               how each garment of a dressed VRM would transfer onto Spec: a verdict with its figures
  fit      <file.vrmxa|item.vrmxw> [--body '{"bustSize":1}'] [--on <char.vrmxa>] [--sweep] [--pose relaxed]
           [--own-weights] [--out <avatar.vrm>]
                                     Spec-fit what is worn to the body (the character's, or Spec with --body; an item is
                                     worn alone on Spec or on --on's body) and print the checks; --sweep: every Body
                                     slider at −1 and +1; --pose relaxed: skin through also with the stage's lowered
                                     arms; --own-weights: garments keep their own weights (the body's by default,
                                     FITTING.md §5.6); --out writes avatar.vrm as fitted
  closet   <file.vrmxa>              the closet: items, what is worn, outfits
  closet   <file.vrmxa> add <item.vrmxw|model.glb> <out.vrmxa>     add an item as a spare
           <file.vrmxa> put-on <item> [<state>] <out.vrmxa>       put it on (what its slot replaces comes off)
           <file.vrmxa> take-off <item> <out.vrmxa>
           <file.vrmxa> state <item> <state> <out.vrmxa>          change a worn item's state
           <file.vrmxa> fit <item> <key=value …> <out.vrmxa>      fine-tune: loose, size, up, forward, right, auto, ease
           <file.vrmxa> hair <item|none> <out.vrmxa>
           <file.vrmxa> outfit-apply <outfit> <out.vrmxa>
           <file.vrmxa> outfit-save <name> <out.vrmxa>            save what is worn as an outfit
           <file.vrmxa> outfit-delete <outfit> <out.vrmxa>
           <file.vrmxa> remove <item> <out.vrmxa>                 (--take-off: take it off first)
           <file.vrmxa> refit <item> <source.vrm> <out.vrmxa>     fit a garment brought in by its bones again from its source
           <file.vrmxa> update <item.vrmxw> <out.vrmxa>           a newer revision of an item in the closet
           <file.vrmxa> copy-out <item> <out.vrmxw>               the item file exactly as it arrived
           <item>, <outfit>: an id or a name
  import   <model.vrm>               what the importer finds: the maker's terms, the pieces, the proposed items
  import   <model.vrm> <folder> --approve all|<g1,g2…> [--skip <g…>] [--doc <import.json>] [--listing <hub.json>]
           [--merge g5+g3 …] [--name g1=Name …] [--type g2=coat …] [--tags g3=footwear:heels,… …] [--place g2='{"move":[0,0.01,0],"turn":[0,0,0],"size":1}' …]
           [--into <char.vrmxa> --out <char-out.vrmxa> [--wear]]
                                     write the approved items (.vrmxw, validated), import.json and import-record.json;
                                     --into adds them to a character's closet, --wear puts them on
  clip     check <clip.vrma|.bvh|.fbx> [--loops true|false] [--in-place|--travel] [--lift <m>]
                                     the clip checker on Spec (--lift: in shoes that lift her this much): each problem
                                     with its numbers and the tool that fixes it
  clip     correct <clip> <out.vrma> --ops '[{"kind":"pinFoot",…}]' | --auto
                                     apply corrections (or the ones the checker proposes) and write the clip
  motion   <file.vrmxa>              the clips (with corrections), the sets, and what each slot plays for what is worn
  motion   <file.vrmxa> add <clip.vrma|.bvh|.fbx> [--name N] [--loops true|false] [--root inPlace|travel] [--speed m/s]
           [--licence L] [--source S] <out.vrmxa>
           <file.vrmxa> starter [<kimodo folder>] <out.vrmxa>    the 30 starter clips and the sets they make
           <file.vrmxa> details <clip> key=value … <out.vrmxa>    name, loops, rootMotion, speed, rate, source, licence
           <file.vrmxa> remove <clip> <out.vrmxa>
           <file.vrmxa> check [<clip>|all] [--dressed]             (no output file) the checker; --dressed: on avatar.vrm's figure
           <file.vrmxa> correct <clip|all> --ops '<json>' | --auto [--dressed] <out.vrmxa>
                                                                  replace a clip's corrections; the original is kept
           <file.vrmxa> uncorrect <clip> <out.vrmxa>               take its corrections away
           <file.vrmxa> keep-fixed <clip> <out.vrmxa>              drop a corrected clip's edit document (its original may then go)
           <file.vrmxa> set-new <name> [--requires a:b,c:d] [--priority N] [--default] <out.vrmxa>
           <file.vrmxa> set <set> key=value … <out.vrmxa>          name=, requires=a:b,c:d, priority=, default=true
           <file.vrmxa> slot <set> <slot> <clip[*weight]>,…|- <out.vrmxa>
           <file.vrmxa> set-remove <set> <out.vrmxa>
           <clip>: a sha256 (or 12 digits of one) or a name; <set>: an id or a name
  details  <file.vrmxa>              the character's details (VRM meta), origin, whether the permissions were chosen, and
                                     the limits the worn pieces set
  details  <file.vrmxa> set key=value … <out.vrmxa>
                                     name=, version=, authors=A,B, copyrightInformation=, contactInformation=, references=a,b,
                                     licenseUrl=, avatarPermission=, commercialUsage=, creditNotation=, allowRedistribution=true,
                                     modification=, allowExcessivelyViolentUsage= (and the other usage flags), listing.url=,
                                     listing.marketplace=, listing.listing_id=; key= (empty) removes an optional field
  licence  <file.vrmxa> [--items <item,…>]
                                     whose each item, clip and voice is and what it allows; the limits; the questions a
                                     person is asked before wearing (all items, or --items'); what a shared copy leaves out
  credits  <file.vrmxa>              the makers of every piece that asks for credit
  flatten  <file.vrmxa> [<folder>] [--state <s,s>]
                                     the finished textures of the eye states and the skin, by the one flattener
  export   <file.vrmxa> --vrm <out.vrm> [--share]
                                     a plain VRM 1.0, the same model as avatar.vrm; --share leaves out what may not be passed on
  export   <file.vrmxa> --item <item> <out.vrmxw>
                                     a closet item, exactly as it arrived
  share    <file.vrmxa> <out.vrmxa> [--new-identity]
                                     a copy for someone else: voices and items that may not be passed on are left out, and said
  voice    <file.vrmxa> [list]       the voices: how each was made, whose, what it allows, consent, clips and their warnings
  voice    <file.vrmxa> check        the same, exit 1 when a voice breaks a rule (a real person's voice without consent)
  voice    <file.vrmxa> preset --engine kokoro-82m --preset af_heart [--name N] [--language en] [--meta key=value …] [--default] [--persona] <out.vrmxa>
                                     add a preset voice: an engine's own speaker, no clip, no real person (VRMXA §9, D36); the
                                     engine id is the model's id in lower case; --persona names it as the persona's voice_id
  voice    <file.vrmxa> import <clip.wav> --name N --transcript T [--language en] [--origin imported|recorded] [--style S]
           [--source S] [--real-person --speaker S --consent-date 2026-11-17 --consent-scope S [--consent-record R]] <out.vrmxa>
                                     add a voice from a clip (16-bit mono WAV; other WAVs are mixed down, never resampled); a
                                     new voice starts at the most restricted licence; a real person's voice needs consent
  persona  <file.vrmxa> [show]       the core persona (shown as the file's content)
  persona  <file.vrmxa> import <card.json|.png|persona.json> <out.vrmxa> [--app-fields <out.json>]
                                     a character card's core fields into the persona (or every field from VRMXA's exchange
                                     form, "format": "vrmxa-persona"); its app-side fields (scenario, greetings,
                                     lorebook, prompts) are never written into the bundle: --app-fields keeps them in a file
  persona  <file.vrmxa> export <out.json|.png> [--card-version v2|v3] [--app-fields <in.json>]
                                     the persona as a character card (a .png is the character's thumbnail with the card in it)
  fixtures [list|check] [--dir <folder>]
                                     the specification's test files (VRMXA_Specification/fixtures): list what each is and the
                                     section it covers; check that each behaves as expected.json says (valid ones pass with
                                     nothing to report, invalid ones fail for the rule they name), by this library and by
                                     the specification's own checker
  conformance <their-output-dir> [--kit <folder>] [--only id,id]
                                     compare an app's output (one folder per case) with the conformance kit, per case
                                     (--only: those cases alone)
  conformance run <out-dir> [--only id,id]
                                     write the reference library's own output for every case of the kit
  conformance cases                  the kit's cases: what goes in, what to do, what to write
  mcp      --app [--port 5213]       the MCP server for agents over stdio, on the running studio (the Mac app, or the dev
                                     server in a browser) through a loopback bridge; register it with
                                     claude mcp add vrmxa-studio -- node packages/vrmxa-core/bin/vrmxa.mjs mcp --app
  mcp      [<file.vrmxa>]            the same tools on files with the app closed (nothing is written)
options: --json  --spec <spec.vrm>  --strict  --force`;

/** Load a file or a folder → { input, kind: 'vrmxa' | 'vrmxw', form } */
function load(path) {
  if (!path || !existsSync(path)) fail(2, `${path ?? '(no path)'}: not found`);
  if (statSync(path).isDirectory()) {
    let map;
    try { map = readFolder(path); } catch (e) { fail(2, e.message); }
    const kind = map.has(VRMXA_MANIFEST) ? 'vrmxa' : map.has(VRMXW_MANIFEST) ? 'vrmxw' : null;
    if (!kind) fail(2, `${path}: the folder has neither ${VRMXA_MANIFEST} nor ${VRMXW_MANIFEST}`);
    return { input: map, kind, form: 'open' };
  }
  const bytes = new Uint8Array(readFileSync(path));
  let kind = /\.vrmxw$/i.test(path) ? 'vrmxw' : /\.vrmxa$/i.test(path) ? 'vrmxa' : null;
  if (isZip(bytes)) {
    const names = scanZip(bytes, { inflate: false }).entries.map((e) => e.name);
    if (names.includes(VRMXA_MANIFEST)) kind = 'vrmxa';
    else if (names.includes(VRMXW_MANIFEST)) kind = 'vrmxw';
  } else if (isGlb(bytes)) kind = kind || 'vrmxw';
  if (!kind) fail(2, `${path}: not a .vrmxa or .vrmxw`);
  return { input: bytes, kind, form: 'packed' };
}

const specBytes = () => (opt('--spec') ? new Uint8Array(readFileSync(opt('--spec'))) : readSpecVrm());
const check = (l) => (l.kind === 'vrmxa' ? checkBundle(l.input, { spec: specBytes() }) : checkItem(l.input, { spec: specBytes() }));
const count = (ps, s) => ps.filter((p) => p.severity === s).length;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const problemLines = (ps) => ps.map((p) => `  ${p.severity.padEnd(7)}  ${p.where ? `${p.where}: ` : ''}${p.message}  [${p.code}${p.section ? ` · ${p.section}` : ''}]`).join('\n');
// validate's form: each finding with the rule it breaks, in plain words, and where the drafts state it (REF-4)
const ruleLines = (ps) => ps.map((p) => `  ${p.severity.padEnd(7)}  ${p.where ? `${p.where}: ` : ''}${p.message}  [${p.code}]${p.rule ? `\n           rule: ${p.rule}${p.section ? ` (${p.section})` : ''}` : ''}`).join('\n');
const verdict = (ps, strict) => count(ps, 'error') === 0 && (!strict || count(ps, 'warning') === 0);

function manifestOfInput(l) {
  const name = l.kind === 'vrmxa' ? VRMXA_MANIFEST : VRMXW_MANIFEST;
  const raw = l.input instanceof Map ? l.input.get(name) : scanZip(l.input).entries.find((e) => e.name === name)?.data;
  try { return raw ? JSON.parse(new TextDecoder().decode(raw)) : null; } catch { return null; }
}

function entriesOf(l) {
  if (l.input instanceof Map) return l.input;
  return new Map(scanZip(l.input).entries.map((e) => [e.name, e.data]));
}

async function inspect(path) {
  const l = load(path);
  const problems = await check(l);
  const m = manifestOfInput(l);
  if (!m) return out({ ok: false, path, problems }, `${path}: the manifest can't be read\n${problemLines(problems)}`);
  const entries = entriesOf(l);
  const totalBytes = [...entries.values()].reduce((n, b) => n + b.length, 0);
  const base = m.base?.sha256 ? findBase(m.base.sha256) : null;
  const baseText = m.base?.sha256 ? `${m.base.name || '?'} ${m.base.sha256.slice(0, 12)}… (${base ? base.status : 'not a published base'})` : '(none)';
  const summary = { ok: count(problems, 'error') === 0, path, kind: l.kind, form: l.form, format: m.format, version: m.version, entries: entries.size - 1, bytes: totalBytes };
  const lines = [];
  let baseTextV5 = null;
  if (l.kind === 'vrmxw') {
    Object.assign(summary, { id: m.id, revision: m.revision, name: m.name, slot: m.slot, type: m.type, kind: m.kind, layer: m.layer, tags: m.tags, base: m.base, attach: m.attach,
      states: (m.states || []).map((s) => s.name), humanBones: Object.keys(m.rig?.humanBones || {}).length, fit: m.fit, meta: m.meta, listing: m.listing, origin: m.origin,
      animations: m.animations ? { clips: (m.animations.clips || []).length, sets: (m.animations.sets || []).map((s) => s.name) } : null, extensions: Object.keys(m.extensions || {}) });
    lines.push(`${basename(path)}: VRMXW item, format version ${m.version} (${l.form})`,
      `  name       ${m.name}   id ${m.id}   revision ${m.revision}`,
      `  worn as    ${m.type} in ${m.slot}, ${m.kind}${m.attach?.bone ? ` on ${m.attach.bone}` : ''}, layer ${m.layer ?? 0}`,
      `  base       ${baseText}`,
      `  fit        ${JSON.stringify(m.fit)}`,
      `  rig        ${summary.humanBones} humanoid bones`,
      `  tags       ${(m.tags || []).join(', ') || '(none)'}`,
      `  states     ${(m.states || []).map((s) => `${s.name}${s.bone ? ` (${s.bone})` : ''}`).join(', ') || '(none)'}`,
      `  animations ${m.animations ? `${(m.animations.clips || []).length} clip(s); sets ${(m.animations.sets || []).map((s) => `${s.name} requires ${s.requires.join('+')}`).join(', ')}` : '(none)'}`,
      `  licence    ${(m.meta?.authors || []).join(', ') || '?'}; ${m.meta?.licenseUrl || 'no licence'}${m.meta?.version ? `; version ${m.meta.version}` : ''}`,
      `  listing    ${m.listing ? `${m.listing.marketplace || ''} ${m.listing.url || ''} ${m.listing.id || ''}`.trim() : '(none)'}`,
      `  origin     ${m.origin ? `${m.origin.made || ''} ${m.origin.source || ''}`.trim() : '(none)'}`,
      `  extensions ${Object.keys(m.extensions || {}).join(', ') || '(none)'}`);
  } else {
    let bundle = null;
    try { bundle = await readBundle(l.input, { spec: specBytes() }); } catch { /* refused: shown below */ }
    if (bundle?.upgradedFrom) {
      const b = bundle.manifest.base;
      const known = findBase(b.sha256);
      summary.base = b;
      m.base = b;
      m.fileId = `${bundle.manifest.fileId} (new)`;
      baseTextV5 = `${b.name} ${b.sha256.slice(0, 12)}… (${known ? known.status : 'not a published base'})`;
    }
    const docs = bundle?.docs || {};
    const closet = docs.closet;
    const nameOf = (id) => closet?.items?.find((i) => i.id === id)?.name || id;
    Object.assign(summary, { id: m.id, fileId: m.fileId, revision: m.revision, title: m.title, author: m.author, created: m.created, updated: m.updated, generator: m.generator, base: m.base,
      upgradedFrom: bundle?.upgradedFrom ?? null, sections: m.sections ? Object.keys(m.sections) : null, documents: bundle ? Object.keys(documentPaths(bundle.manifest)) : null,
      closet: closet ? { items: closet.items.map((i) => ({ id: i.id, name: i.name, slot: i.slot, kind: i.kind })), worn: closet.worn, outfits: (closet.outfits || []).map((o) => o.name), hair: closet.hair } : null,
      animations: docs.animations ? { clips: docs.animations.clips.length, sets: docs.animations.sets.map((s) => s.name) } : null,
      voices: docs.voices ? docs.voices.voices.map((v) => ({ id: v.id, name: v.name, origin: v.origin, clips: v.clips.length })) : null,
      persona: bundle?.database?.persona ? { name: bundle.database.persona.name, examples: bundle.database.examples.length } : null,
      skipped: bundle?.skipped || [] });
    lines.push(`${basename(path)}: VRMXA character, bundle version ${m.version}${bundle?.upgradedFrom ? ` (brought forward to 5 in memory)` : ''} (${l.form})`,
      `  title      ${m.title || '(none)'}   by ${m.author || '?'}`,
      `  id         ${m.id}   file ${m.fileId ?? '(none)'}   revision ${m.revision}`,
      `  base       ${baseTextV5 || baseText}`,
      `  entries    ${summary.entries}, ${(totalBytes / 1048576).toFixed(2)} MB unpacked`);
    if (bundle) {
      lines.push(`  documents  ${summary.documents.join(', ') || '(none)'}`);
      if (closet) {
        lines.push(`  closet     ${closet.items.map((i) => `${i.name} (${i.slot}, ${i.kind})`).join('; ')}`,
          `  worn       ${closet.worn.items.map((id) => `${nameOf(id)}${closet.worn.states?.[id] ? ` [${closet.worn.states[id]}]` : ''}`).join(', ') || '(nothing)'}${closet.hair ? `; hair ${nameOf(closet.hair)}` : ''}`,
          `  outfits    ${(closet.outfits || []).map((o) => o.name).join(', ') || '(none)'}`);
      }
      if (docs.animations) lines.push(`  animations ${docs.animations.clips.length} clip(s); sets ${docs.animations.sets.map((s) => `${s.name}${s.default ? ' (default)' : ''}`).join(', ')}`);
      if (docs.voices) lines.push(`  voices     ${docs.voices.voices.map((v) => `${v.name} (${v.origin}, ${v.clips.length} clip)`).join(', ')}`);
      if (bundle.database?.persona) lines.push(`  persona    ${bundle.database.persona.name}: ${bundle.database.persona.summary || ''}  [shown as the file's content]`);
      for (const s of bundle.skipped) lines.push(`  skipped    ${s.section}: ${s.reason}`);
    }
  }
  const e = count(problems, 'error'), w = count(problems, 'warning');
  lines.push(`  check      ${e ? `fails: ${plural(e, 'error')}` : 'passes'}${w ? `, ${plural(w, 'warning')}` : ''} (vrmxa validate for the list)`);
  out({ ...summary, problems }, lines.join('\n'));
}

async function validate(path) {
  const l = load(path);
  const problems = await check(l);
  const ok = verdict(problems, flags.has('--strict'));
  const e = count(problems, 'error'), w = count(problems, 'warning'), i = count(problems, 'info');
  const what = l.kind === 'vrmxa' ? 'VRMXA character' : 'VRMXW item';
  out({ ok, path, kind: l.kind, form: l.form, errors: e, warnings: w, notes: i, specChecked: Boolean(specBytes()), schemas: true, problems },
    `${basename(path)}: ${what} ${ok ? 'passes' : 'FAILS'} (${plural(e, 'error')}, ${plural(w, 'warning')}, ${plural(i, 'note')}; the specification's schemas and this library's rules)${problems.length ? `\n${ruleLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

async function pack(folder, outPath) {
  if (!outPath) fail(2, 'pack needs <folder> <out>');
  const l = load(folder);
  if (l.form !== 'open') fail(2, `${folder}: not a folder`);
  let bytes;
  try {
    bytes = l.kind === 'vrmxa' ? await writeBundle(await bundleFromEntries(l.input), { avatarOf: 'keep' }) : await writeItem(itemFromEntries(l.input));
  } catch (e) { fail(2, e.message); }
  const problems = l.kind === 'vrmxa' ? await checkBundle(bytes, { spec: specBytes() }) : await checkItem(bytes, { spec: specBytes() });
  const ok = verdict(problems, flags.has('--strict'));
  if (!ok && !flags.has('--force')) {
    out({ ok: false, path: outPath, written: false, problems }, `${outPath}: not written, the packed file fails validation (--force writes it anyway)\n${problemLines(problems)}`);
    process.exit(1);
  }
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  writeFileSync(outPath, bytes);
  out({ ok, path: outPath, written: true, bytes: bytes.length, problems }, `${outPath}: packed, ${bytes.length} bytes, ${ok ? 'passes' : 'FAILS'} validation${problems.length ? `\n${problemLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

async function unpack(file, folder) {
  if (!folder) fail(2, 'unpack needs <file> <folder>');
  const l = load(file);
  if (l.form !== 'packed') fail(2, `${file}: already a folder`);
  const problems = await check(l);
  if (count(problems, 'error')) {
    out({ ok: false, path: file, written: false, problems }, `${file}: refused, nothing unpacked\n${problemLines(problems)}`);
    process.exit(1);
  }
  const entries = new Map(scanZip(l.input).entries.map((e) => [e.name, e.data]));
  try { writeFolder(folder, entries, { overwrite: flags.has('--force') }); } catch (e) { fail(2, e.message); }
  out({ ok: true, path: folder, entries: entries.size, problems }, `${folder}: unpacked ${entries.size} entries${problems.length ? ` (${plural(count(problems, 'warning'), 'warning')})` : ''}`);
}

async function upgrade(file, outPath) {
  if (!outPath) fail(2, 'upgrade needs <old.vrmxa> <out.vrmxa>');
  const l = load(file);
  let bundle;
  try { bundle = await readBundle(l.input, { spec: specBytes() }); } catch (e) {
    if (e instanceof RefusedError) { out({ ok: false, path: file, problems: e.problems }, `${file}: refused\n${problemLines(e.problems)}`); process.exit(1); }
    fail(2, e.message);
  }
  if (!bundle.upgradedFrom) fail(2, `${file}: already bundle version ${bundle.manifest.version}`);
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  const bytes = await writeBundle(bundle);
  writeFileSync(outPath, bytes);
  const problems = await checkBundle(bytes, { spec: specBytes() });
  const notes = bundle.problems.filter((p) => p.severity === 'info' && p.code.startsWith('legacy.'));
  out({ ok: verdict(problems, false), path: outPath, from: bundle.upgradedFrom, notes, problems },
    `${outPath}: brought forward from version ${bundle.upgradedFrom} to 5, ${bytes.length} bytes\n${problemLines([...notes, ...problems])}`);
  process.exit(verdict(problems, false) ? 0 : 1);
}

async function measure(file) {
  if (!file || !existsSync(file)) fail(2, `${file ?? '(no path)'}: not found`);
  let m;
  try { m = await measureVrm(new Uint8Array(readFileSync(file)), { file: basename(file) }); } catch (e) { fail(2, `${file}: ${e.message}`); }
  if (!m) fail(1, `${file}: no body skin or humanoid found to measure`);
  const cm = (v) => (v == null ? '     -' : (v * 100).toFixed(1).padStart(6));
  out(m, [`${basename(file)}  stature ${cm(m.lengths.stature)} cm${m.lengths.lift ? ` barefoot (a shoe lift of ${(m.lengths.lift * 1000).toFixed(1)} mm taken out of the heights)` : ''}`, 'station      at      girth  width  depth (cm)',
    ...m.stations.map((s) => `${s.id.padEnd(12)} ${String(s.at).padStart(7)} ${cm(s.girth)} ${cm(s.width)} ${cm(s.depth)}`),
    ...m.missing.map((x) => `${x.id.padEnd(12)} not measured: ${x.reason}`), ...m.warnings.map((x) => `warning: ${x}`)].join('\n'));
}

// ---- the edit document (phase 2) -------------------------------------------------------------------
async function openBundle(file) {
  const l = load(file);
  if (l.kind !== 'vrmxa') fail(2, `${file}: not a character (.vrmxa)`);
  try { return await readBundle(l.input, { spec: specBytes() }); } catch (e) {
    if (e instanceof RefusedError) { out({ ok: false, path: file, problems: e.problems }, `${file}: refused\n${problemLines(e.problems)}`); process.exit(1); }
    fail(2, e.message);
  }
}
function needSpec() {
  const s = specBytes();
  if (!s) fail(2, 'spec.vrm was not found: give --spec <spec.vrm>');
  return s;
}
async function hairOf(bundle) {
  const id = bundle.docs.closet?.hair;
  const e = id && bundle.docs.closet.items?.find((x) => x.id === id);
  if (!e || !bundle.entries.has(e.file)) return null;
  const item = await readItem(bundle.entries.get(e.file));
  return { model: item.entries.get(item.manifest.model?.file || 'model.glb'), humanBones: item.manifest.rig?.humanBones || {}, name: item.manifest.name };
}

async function edits(file) {
  const bundle = await openBundle(file);
  const doc = bundle.docs.edits;
  if (!doc) { out({ ok: true, path: file, document: null }, `${file}: no edit document (the character is Spec as it is)`); return; }
  const r = readEdits(doc);
  const list = (o, pre) => Object.entries(o).map(([k, v]) => `  ${pre}${k} = ${JSON.stringify(v)}`);
  out({ ok: !r.refused, path: file, document: doc, applied: r.edits, ignored: r.ignored, refused: r.refused },
    [`${file}: edit document version ${doc.version} by ${JSON.stringify(doc.editor)} [shown as the file's content]`,
      ...(r.refused ? [`  not applied: ${r.refused}`] : [
        ...list(r.edits.body, 'body.'), ...list(r.edits.face.shapes, 'face.shapes.'), ...list(r.edits.face.colors, 'face.colors.'),
        ...list(r.edits.face.bones, 'face.bones.'), ...list(r.edits.face.morphs, 'face.morphs.'),
        ...(r.edits.face.headShape !== 'spec' ? [`  face.headShape = ${r.edits.face.headShape}`] : []),
        ...(r.edits.hairDesign.groups.length ? [`  hairDesign: ${r.edits.hairDesign.groups.length} group(s), ${r.edits.hairDesign.groups.reduce((n, g) => n + g.strands.length, 0)} stroke(s)`] : []),
      ]),
      ...(r.ignored.length ? [`  ignored (kept in the file): ${r.ignored.join(', ')}`] : [])].join('\n'));
}

async function applyEditsCmd(file, editsPath, outPath) {
  if (!editsPath || !outPath) fail(2, 'apply-edits needs <file.vrmxa> <edits.json> <out.vrmxa>');
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  let doc;
  try { doc = JSON.parse(readFileSync(editsPath, 'utf8')); } catch (e) { fail(2, `${editsPath}: not JSON (${e.message})`); }
  const refusal = editsRefusal(doc);
  if (refusal) fail(1, `${editsPath}: ${refusal}`);
  const spec = needSpec();
  const bundle = await openBundle(file);
  const specSha = await sha256(spec);
  const saved = editsForSave(doc, { editor: doc.editor || 'vrmxa CLI (vrmxa-core)', madeOn: specSha });
  const { ignored } = readEdits(saved);
  setDocument(bundle, 'edits', saved);
  const hair = await hairOf(bundle);
  // the worn items are fitted and written in with the edits (CLOSET.md §4): avatar.of names the real closet
  await closetOps.redrawAvatar(bundle, { spec });
  const m = await measureEdits(spec, saved);
  if (m) setDocument(bundle, 'measurements', m);
  touchBundle(bundle);
  const bytes = await writeBundle(bundle);
  const problems = await checkBundle(bytes, { spec });
  const ok = verdict(problems, false);
  writeFileSync(outPath, bytes);
  out({ ok, path: outPath, revision: bundle.manifest.revision, ignored, hair: hair?.name ?? null, stature: m?.lengths?.stature ?? null, problems },
    `${outPath}: edits applied, avatar.vrm and measurements written, revision ${bundle.manifest.revision}, ${bytes.length} bytes, ${ok ? 'passes' : 'FAILS'} validation` +
    `${ignored.length ? `\n  ignored (kept): ${ignored.join(', ')}` : ''}${m ? `\n  stature ${(m.lengths.stature * 100).toFixed(1)} cm` : ''}${problems.length ? `\n${problemLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

async function bake(file, outPath) {
  if (!outPath) fail(2, 'bake needs <file.vrmxa> <out.vrm>');
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  const spec = needSpec();
  const bundle = await openBundle(file);
  const hair = await hairOf(bundle);
  const r = await closetOps.drawAvatar(bundle, { spec });
  const problems = checkModel(r.bytes, { kind: 'vrm' }).problems;
  writeFileSync(outPath, r.bytes);
  out({ ok: !count(problems, 'error'), path: outPath, bytes: r.bytes.length, refused: r.refused, ignored: r.ignored, hair: hair?.name ?? null, problems },
    `${outPath}: ${r.bytes.length} bytes${hair ? `, wearing ${hair.name}` : ''}${r.refused ? `\n  edits not applied: ${r.refused}` : ''}${r.ignored.length ? `\n  ignored: ${r.ignored.join(', ')}` : ''}${problems.length ? `\n${problemLines(problems)}` : ''}`);
}

// ---- the closet (phase 3) ----------------------------------------------------------------------------
function findItem(bundle, ref) {
  const c = closetOps.closetOf(bundle);
  const e = c.items.find((x) => x.id === ref) || c.items.filter((x) => x.name === ref).at(0);
  if (!e) fail(1, `no item "${ref}" in the closet (give its id or its name)`);
  if (c.items.filter((x) => x.name === ref).length > 1 && e.id !== ref) fail(1, `more than one item is named "${ref}": give its id`);
  return e;
}
function findOutfit(bundle, ref) {
  const o = closetOps.closetOf(bundle).outfits.find((x) => x.id === ref || x.name === ref);
  if (!o) fail(1, `no outfit "${ref}"`);
  return o;
}
function closetText(file, c) {
  const st = closetOps.outfitStatus(c);
  const line = (e) => {
    const worn = c.worn.items.includes(e.id), state = c.worn.states[e.id] || e.states?.[0]?.name;
    const tune = e.fitting?.adjust ? ` fine-tuned ${Object.entries(e.fitting.adjust).map(([k, v]) => `${k}=${v}`).join(' ')}` : '';
    return `  ${c.hair === e.id ? 'hair ' : worn ? 'worn ' : 'spare'}  ${JSON.stringify(e.name)} [${e.slot}${e.kind === 'pin' ? `, on ${e.bone}` : ''}]${worn && state ? ` state ${state}` : ''}${tune}  ${e.id}`;
  };
  return [`${file}: ${c.items.length} item(s) [names are the file's content]`, ...c.items.map(line),
    ...(c.outfits.length ? ['outfits:', ...c.outfits.map((o) => `  ${JSON.stringify(o.name)}: ${(o.items || []).length} item(s)${st.outfit === o.id ? (st.changed ? ' (applied, changed since)' : ' (worn now)') : ''}  ${o.id}`)] : [])].join('\n');
}
// HON-1 on the command line: a piece whose maker doesn't allow changes or passing it on is merged or worn only when the
// person says so (--accept-terms, their acceptance for their own use, MCP-6); the answer is kept in the character as the
// app keeps it (x-xocialize.honoured.<id>)
// Putting a piece on also tightens the character's permissions it doesn't allow (VRMXA §5.3, D35): the person is told
// first, so that too needs --accept-terms, and the report lists what was tightened.
const tightened = [];
async function honourOrRefuse(bundle, ids, what) {
  const q = character.questionsBeforeWearing(bundle, ids);
  if (!q.length) return;
  if (!flags.has('--accept-terms')) fail(1, `${what} refused (PRD HON-1): ${q.map((x) => x.text).join(' ')} Pass --accept-terms if you, the person, accept ${q.every((x) => x.term === 'tighten') ? 'the tightening' : 'these terms for your own use'}.`);
  const terms = q.filter((x) => x.term !== 'tighten');
  for (const id of new Set(terms.map((x) => x.id))) {
    const [k, v] = character.answerSetting(id, terms.filter((x) => x.id === id).map((x) => x.term));
    await character.setSetting(bundle, k, v);
  }
  const c = closetOps.closetOf(bundle);
  const pieces = ids.map((id) => c.items.find((e) => e.id === id)).filter(Boolean).map((e) => ({ id: e.id, name: e.name, meta: e.meta }));
  tightened.push(...(await character.tightenPermissions(bundle, pieces)));
}
const tightenedText = () => (tightened.length ? `\n${character.tighteningLines(tightened).map((l) => `  ${l}`).join('\n')}` : '');

const LOOK_OPS = new Set(['put-on', 'take-off', 'state', 'fit', 'hair', 'outfit-apply', 'remove', 'update']);

async function closet(file, op, ...rest) {
  const bundle = await openBundle(file);
  if (!op) {
    const c = closetOps.closetOf(bundle);
    out({ ok: true, path: file, closet: c, outfit: closetOps.outfitStatus(c) }, closetText(file, c));
    return;
  }
  const outPath = rest.pop();
  if (!outPath) fail(2, `closet ${op} needs an output file last`);
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  const spec = specBytes();
  let result;
  try {
    switch (op) {
      case 'add': { if (!rest[0]) fail(2, 'closet add needs <item.vrmxw>'); result = await closetOps.addItem(bundle, new Uint8Array(readFileSync(rest[0])), { source: basename(rest[0]), spec }); break; }
      case 'put-on': { const id = findItem(bundle, rest[0]).id; await honourOrRefuse(bundle, [id], 'put-on'); result = await closetOps.putOn(bundle, id, rest[1] ? { state: rest[1] } : {}); break; }
      case 'take-off': result = await closetOps.takeOff(bundle, findItem(bundle, rest[0]).id); break;
      case 'state': result = await closetOps.setState(bundle, findItem(bundle, rest[0]).id, rest[1]); break;
      case 'fit': {
        const e = findItem(bundle, rest[0]);
        const patch = {};
        for (const kv of rest.slice(1)) {
          const [k, v] = kv.split('=');
          if (k === 'auto') patch.auto = v === 'true' || v === 'on';
          else if (k === 'ease' || k === 'hemAnchor') (patch.rule ||= {})[k] = v;
          else (patch.adjust ||= {})[k] = Number(v);
        }
        result = await closetOps.setFitting(bundle, e.id, patch, { merge: true });
        break;
      }
      case 'hair': { const id = rest[0] === 'none' ? null : findItem(bundle, rest[0]).id; if (id) await honourOrRefuse(bundle, [id], 'hair'); result = await closetOps.changeHair(bundle, id); break; }
      case 'outfit-apply': { const o = findOutfit(bundle, rest[0]); const worn = closetOps.closetOf(bundle).worn.items; await honourOrRefuse(bundle, (o.items || []).filter((x) => !worn.includes(x)), 'outfit-apply'); result = await closetOps.applyOutfit(bundle, o.id); break; }
      case 'outfit-save': result = await closetOps.saveOutfit(bundle, rest[0]); break;
      case 'outfit-delete': result = await closetOps.deleteOutfit(bundle, findOutfit(bundle, rest[0]).id); break;
      case 'remove': result = await closetOps.removeItem(bundle, findItem(bundle, rest[0]).id, { takeOff: flags.has('--take-off') }); break;
      case 'update': result = await closetOps.updateItem(bundle, new Uint8Array(readFileSync(rest[0])), { spec }); break;
      case 'refit': { // a garment brought in by its bones, fitted again from its source by Spec-fit (VRMXW W20)
        if (!rest[1]) fail(2, 'closet refit needs <item> <source.vrm>');
        const id = findItem(bundle, rest[0]).id;
        const r = await imp.refitFromSource(await closetOps.itemOf(bundle, id), new Uint8Array(readFileSync(rest[1])), spec, { fileName: basename(rest[1]) });
        result = { ...(await closetOps.updateItem(bundle, r.bytes, { source: basename(rest[1]), spec })), pushed: r.stats.pushed, estimated: r.estimated };
        break;
      }
      case 'copy-out': {
        const bytes = closetOps.copyOut(bundle, findItem(bundle, rest[0]).id);
        writeFileSync(outPath, bytes);
        out({ ok: true, path: outPath, bytes: bytes.length }, `${outPath}: ${bytes.length} bytes, exactly as it arrived`);
        return;
      }
      default: fail(2, `unknown closet operation "${op}"`);
    }
  } catch (e) {
    if (e instanceof closetOps.ClosetError) fail(1, `${op} refused: ${e.message} [${e.code}]`);
    throw e;
  }
  // the look changed: avatar.vrm is redrawn (the thumbnail is kept: no renderer here, VRMXA §5.2)
  const redrawn = LOOK_OPS.has(op) && !(await closetOps.avatarIsCurrent(bundle));
  if (redrawn) await closetOps.redrawAvatar(bundle, { spec: needSpec() });
  touchBundle(bundle);
  const bytes = await writeBundle(bundle);
  const problems = await checkBundle(bytes, { spec });
  const ok = verdict(problems, false);
  writeFileSync(outPath, bytes);
  const c = closetOps.closetOf(bundle);
  // taking a piece off may let what it tightened be loosened again: offered, never done on its own (D35)
  const loosen = character.looseningOffer(bundle);
  const loosenText = loosen.length ? `\ncould be loosened again (the person's choice; nothing was loosened): ${loosen.map((l) => `${l.key} back to "${character.wordsFor(l.key, l.to)}"`).join(', ')}` : '';
  out({ ok, path: outPath, op, result, redrawn, revision: bundle.manifest.revision, closet: c, tightened, couldLoosen: loosen, problems },
    `${outPath}: ${op} done${result?.removed?.length && op === 'put-on' ? ` (took off ${result.removed.map((id) => JSON.stringify(c.items.find((x) => x.id === id)?.name)).join(', ')})` : ''}${redrawn ? ', avatar.vrm redrawn' : ''}, revision ${bundle.manifest.revision}, ${ok ? 'passes' : 'FAILS'} validation${tightenedText()}${loosenText}\n${closetText(outPath, c)}${problems.length ? `\n${problemLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

// ---- import (PRD §8.1; VRMXW §14) ----------------------------------------------------------------------
const optAll = (k) => argv.flatMap((a, i) => (argv[i - 1] === k ? [a] : []));
async function importCmd(file, folder) {
  if (!file || !existsSync(file)) fail(2, `${file ?? '(no path)'}: not found`);
  const spec = needSpec();
  let listing = null;
  if (opt('--listing')) {
    let j;
    try { j = JSON.parse(readFileSync(opt('--listing'), 'utf8')); } catch (e) { fail(2, `${opt('--listing')}: ${e.message}`); }
    listing = imp.listingFromVroidHub(j) || (j && typeof j === 'object' ? { url: j.url ?? null, marketplace: j.marketplace ?? null, id: j.id ?? null, terms: j.terms } : null);
  }
  let source;
  try { source = await imp.openSource(new Uint8Array(readFileSync(file)), { fileName: basename(file), listing }); } catch (e) {
    if (e instanceof RefusedError) { out({ ok: false, path: file, problems: e.problems }, `${file}: refused\n${problemLines(e.problems)}`); process.exit(1); }
    throw e;
  }
  let doc;
  if (opt('--doc')) {
    try { doc = imp.resumeImport(JSON.parse(readFileSync(opt('--doc'), 'utf8')), source); } catch (e) { fail(1, e.message); }
  } else doc = imp.newImport(source);
  try {
    for (const m of optAll('--merge')) doc = imp.mergeGroups(doc, m.split('+'));
    for (const nv of optAll('--name')) { const [id, ...rest] = nv.split('='); doc = imp.renameGroup(doc, id, rest.join('=')); }
    for (const tv of optAll('--type')) { const [id, type] = tv.split('='); doc = imp.classifyGroup(doc, id, { type }); }
    // worn tags (VRMXW §6, the animation sets' requires): --tags g2=footwear:heels,style:town
    for (const tv of optAll('--tags')) { const [id, ...rest] = tv.split('='); doc = imp.classifyGroup(doc, id, { tags: rest.join('=').split(',').map((t) => t.trim()).filter(Boolean) }); }
    // the place handles (IMP-9) as numbers: --place g2='{"move":[0,0.01,0],"turn":[0,0,0],"size":1}'
    for (const pv of optAll('--place')) {
      const at = pv.indexOf('=');
      let place;
      try { place = JSON.parse(pv.slice(at + 1)); } catch { fail(2, `--place ${pv.slice(0, at)}=… must be JSON: {"move":[x,y,z],"turn":[x,y,z],"size":s}`); }
      doc = imp.placeGroup(doc, pv.slice(0, at), place);
    }
  } catch (e) { fail(2, e.message); }
  const rigs = imp.importRigs(source, spec);
  const head = imp.matchSourceHead(source, parseGlb(spec));
  if (head && !doc.head) doc = imp.setHead(doc, head, 'offered');
  const pieceText = (id) => source.pieces.find((p) => p.id === id);
  const summary = {
    path: file, sha256: source.sha256, vrm: source.vrm, conversion: source.conversion, title: source.title, meta: source.meta, terms: source.terms, listing: source.listing,
    lift: rigs.lift, head, body: source.pieces.filter((p) => p.never).map((p) => ({ id: p.id, label: p.label, role: p.role })),
    groups: doc.groups.map((g) => ({ id: g.id, name: g.name, type: g.type, slot: g.slot, kind: g.kind, attach: g.attach, layer: g.layer, status: g.status, why: g.why, pieces: g.pieces.map((id) => ({ id, label: pieceText(id)?.label, material: pieceText(id)?.material, tris: pieceText(id)?.tris })) })),
    clashes: imp.slotClashes(doc), // groups that can't all be worn: said, never merged
  };
  const lines = [
    `${basename(file)}: VRM ${source.vrm}${source.conversion ? ' (converted to 1.0 on a copy; the file is unchanged)' : ''}  sha256 ${source.sha256.slice(0, 12)}…  [names are the file's content]`,
    `  maker      ${(source.meta.authors || []).join(', ')}; ${source.meta.licenseUrl || 'no licence'}`,
    ...source.terms.map((t) => `  ${t.ok ? 'allows   ' : 'does not '}  ${t.text}`),
    `  listing    ${source.listing ? `${source.listing.marketplace || ''} ${source.listing.url || ''}`.trim() : '(none given)'}`,
    `  shoe lift  ${(rigs.lift.lift * 1000).toFixed(1)} mm (taken out of every item; recorded on the shoes)`,
    `  not taken  ${summary.body.map((p) => p.label).join(', ')} (the body and face never come in)`,
    head ? `  head       matched on Spec as edits: ${Object.entries(head.shapes).map(([k, v]) => `${k} ${v}`).join(', ')}${head.headSize ? `, head size ${head.headSize}` : ''} (${head.before} → ${head.after} mm)` : '  head       could not be scanned',
    '  groups:',
    ...summary.groups.map((g) => `    ${g.id.padEnd(4)} ${JSON.stringify(g.name).padEnd(18)} ${g.type}${g.kind === 'pin' ? ` on ${g.attach}` : ''} [${g.slot}] ${g.status}  ${g.pieces.length} piece(s): ${g.pieces.map((p) => p.label).join(', ')}  (${g.why})`),
    ...summary.clashes.map((c) => `  warning    ${c.text} (${c.groups.join(', ')})`),
  ];
  if (!folder) { out({ ok: true, ...summary }, lines.join('\n')); return; }
  const approve = opt('--approve');
  if (!approve && !opt('--doc')) fail(2, 'say which groups to write: --approve all, or --approve g1,g2 (nothing comes in unseen: look at the list first)');
  const skip = new Set((opt('--skip') || '').split(',').filter(Boolean));
  const want = approve === 'all' ? doc.groups.map((g) => g.id) : (approve || '').split(',').filter(Boolean);
  for (const id of want) {
    if (!doc.groups.some((g) => g.id === id)) fail(2, `there is no group ${id}`);
    if (skip.has(id)) continue;
    doc = imp.viewGroup(doc, id); // looked at in the list above: the agent or person names it explicitly
    doc = imp.approveGroup(doc, id);
  }
  for (const id of skip) doc = imp.skipGroup(doc, id);
  const clashing = imp.slotClashes(doc, { statuses: ['approved'] });
  const r = await imp.importApproved(doc, source, rigs, { spec });
  doc = r.doc;
  mkdirSync(folder, { recursive: true });
  for (const it of r.items) writeFileSync(join(folder, it.fileName), it.bytes);
  writeFileSync(join(folder, 'import.json'), `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(join(folder, 'import-record.json'), `${JSON.stringify(imp.importRecord(doc), null, 2)}\n`);
  const written = r.items.map((it) => ({ group: it.group, file: join(folder, it.fileName), id: it.item.manifest.id, name: it.item.manifest.name, type: it.item.manifest.type, bytes: it.bytes.length, travel: it.model.travel, springs: it.model.springs, fit: it.model.fit, fitWhy: it.model.fitWhy, fitStats: it.model.fitStats, warnings: it.problems.filter((p) => p.severity === 'warning').length }));
  const res = { ok: !r.failed.length, ...summary, clashes: clashing, written, failed: r.failed };
  const tail = [
    ...clashing.map((c) => `  warning    approved together: ${c.text}`),
    ...written.map((w) => `  wrote ${w.file}  ${w.type}, ${w.bytes} bytes, ${w.springs} spring(s), ${w.fit === 'spec-fit' ? `brought onto Spec by Spec-fit (${w.fitStats?.ms ?? '?'} ms, ${w.fitStats?.pushed ?? 0} pushed clear${w.fitStats?.estimated?.length ? `; estimated: ${w.fitStats.estimated.join(', ')}` : ''})` : `moved onto Spec by bones (largest move ${(w.travel * 100).toFixed(1)} cm)${w.fitWhy ? `: ${w.fitWhy}` : ''}`}, validated`),
    ...r.failed.map((f) => `  FAILED ${f.group} ${JSON.stringify(f.name)}: ${f.error}`),
  ];
  if (opt('--into')) {
    const outChar = opt('--out');
    if (!outChar) fail(2, '--into needs --out <char-out.vrmxa>');
    if (existsSync(outChar) && !flags.has('--force')) fail(2, `${outChar}: already exists (--force replaces it)`);
    const bundle = await openBundle(opt('--into'));
    for (const it of r.items) await closetOps.addItem(bundle, it.bytes, { source: basename(file), spec });
    if (flags.has('--wear')) await honourOrRefuse(bundle, r.items.map((it) => it.item.manifest.id), 'import --wear');
    for (const it of r.items) {
      if (flags.has('--wear')) {
        if (it.item.manifest.slot === 'hair') await closetOps.changeHair(bundle, it.item.manifest.id);
        else await closetOps.putOn(bundle, it.item.manifest.id);
      }
    }
    if (!(await closetOps.avatarIsCurrent(bundle))) await closetOps.redrawAvatar(bundle, { spec });
    touchBundle(bundle);
    const bytes = await writeBundle(bundle);
    const problems = await checkBundle(bytes, { spec });
    writeFileSync(outChar, bytes);
    res.into = { path: outChar, problems, closet: closetOps.closetOf(bundle) };
    res.ok = res.ok && verdict(problems, false);
    tail.push(`  ${outChar}: ${r.items.length} item(s) added${flags.has('--wear') ? ' and worn' : ''}, ${verdict(problems, false) ? 'passes' : 'FAILS'} validation${tightenedText()}`, closetText(outChar, closetOps.closetOf(bundle)));
    res.tightened = tightened;
    if (problems.length) tail.push(problemLines(problems));
  }
  out(res, [...lines.filter((l) => !l.startsWith('  warning ')), ...tail].join('\n'));
  process.exit(res.ok ? 0 : 1);
}

// ---- Spec-fit (phase 5) -----------------------------------------------------------------------------------------
async function fitCmd(file) {
  if (!file) fail(2, 'fit needs <file.vrmxa|item.vrmxw>');
  const spec = needSpec();
  const { specContext } = await import('../src/fit/index.js');
  const { checkWorn, sweepWorn } = await import('../src/fit/checks.js');
  const { newEdits, setEdits } = await import('../src/edit/index.js');
  const bytes = new Uint8Array(readFileSync(file));
  if (/\.(vrm|glb)$/i.test(file)) {
    // a dressed VRM: how each garment would transfer onto Spec by Spec-fit (fit/verdict.js), nothing written
    const r = await imp.sourceVerdicts(bytes, spec, { fileName: basename(file) });
    const pc = (v) => (v == null ? '–' : `${(v * 100).toFixed(2)} %`);
    const lines = r.garments.map((g) => `  ${g.group} "${g.name}" (${g.type}): ${g.verdict}${g.method !== 'spec-fit' ? ` [${g.method}${g.why ? `: ${g.why}` : ''}]` : ''}; skin through ${pc(g.figures?.through)}, pushes ${pc(g.figures?.pushedShare)}, ease RMS ${g.figures?.easeRms != null ? (g.figures.easeRms * 1000).toFixed(2) : '–'} mm${g.ms != null ? `, ${g.ms} ms` : ''}${g.reasons.length ? `\n    ${g.reasons.map((x) => `${x.level}: ${x.text}`).join('\n    ')}` : ''}`);
    out({ ok: true, ...r }, `${file}: how its garments would transfer onto Spec by Spec-fit (${r.ms} ms)${r.estimated.length ? `; estimated stations: ${r.estimated.join(', ')}` : ''}\n${lines.join('\n') || '  no tops, bottoms, one-pieces or coats'}${r.others.length ? `\n  not fitted by Spec-fit: ${r.others.map((o) => `${o.name} (${o.type})`).join(', ')}` : ''}`);
    return;
  }
  let bundle;
  if (file.endsWith('.vrmxw') || opt('--on')) {
    // an item: worn alone, on Spec or on the given character's body
    bundle = opt('--on') ? await openBundle(opt('--on')) : (await import('../src/vrmxa.js')).createBundle({ avatar: spec });
    if (file.endsWith('.vrmxw')) {
      const c = closetOps.closetOf(bundle);
      const keep = c.worn.items.filter((id) => !['tops', 'bottoms', 'onepiece', 'outer'].includes(c.items.find((e) => e.id === id)?.slot));
      const { id } = await closetOps.addItem(bundle, bytes, { source: basename(file), spec });
      c.worn.items = keep;
      await closetOps.putOn(bundle, id);
    }
  } else bundle = await openBundle(file);
  let body = null;
  if (opt('--body')) { try { body = JSON.parse(opt('--body')); } catch { fail(2, '--body must be JSON, such as {"bustSize":1}'); } }
  const edits = readEdits(bundle.docs.edits || null).edits;
  const use = { body: body ?? edits.body, bones: edits.face.bones };
  const w = await closetOps.wornPieces(bundle, { adjust: false });
  use.lift = w.lift;
  const merged = parseGlb(closetOps.mergeWorn(spec, w));
  const items = w.items.map((x) => ({ id: x.id, manifest: x.item.manifest, fitting: x.entry?.fitting || null }));
  const ctx = specContext(parseGlb(spec));
  const cache = new Map();
  const pctS = (v) => (v == null ? '–' : `${(v * 100).toFixed(2)} %`);
  // in a pose (FITTING.md §5.6): the stage's relaxed arms, checked with the body's weights and with the item's own
  const { RELAXED_POSE } = await import('../src/fit/worn.js');
  const poseName = opt('--pose');
  if (poseName && poseName !== 'relaxed' && poseName !== 'none') fail(2, '--pose takes relaxed or none');
  const pose = poseName === 'relaxed' ? RELAXED_POSE : null;
  const weights = !flags.has('--own-weights');
  if (flags.has('--sweep')) {
    const sw = sweepWorn(merged.json, merged.bin, items, { spec: ctx, cache, bones: use.bones, pose, weights });
    const lines = Object.values(sw.worst).map((x) => `  ${x.name}: skin through worst ${pctS(x.through)}${x.throughAt ? ` (${x.throughAt})` : ''}, by the bones ${pctS(x.throughBones)}; ease RMS ${((x.easeRms || 0) * 1000).toFixed(2)} mm; hems ${x.hemsMm.toFixed(2)} mm; slowest ${x.ms.toFixed(1)} ms${pose ? `\n    posed (relaxed arms): worst ${pctS(x.posedThrough)}${x.posedThroughAt ? ` (${x.posedThroughAt})` : ''} with the body's weights, ${pctS(x.posedThroughOwn)} with its own` : ''}`);
    const pass = Object.values(sw.worst).every((x) => x.through < 0.005);
    out({ ok: pass, worst: sw.worst, rows: sw.rows }, `${file}: every Body slider at −1 and +1 (FITTING.md §8)\n${lines.join('\n') || '  nothing worn is fitted by Spec-fit'}\n  ${pass ? 'passes' : 'fails'}: skin through cloth under 0.5 %`);
    process.exit(pass ? 0 : 1);
  }
  const c = checkWorn(merged.json, merged.bin, items, use, { spec: ctx, cache, pose, weights });
  if (opt('--out')) {
    const outPath = opt('--out');
    if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
    if (body) bundle.docs.edits = setEdits(bundle.docs.edits || newEdits(), Object.entries(body).map(([k, v]) => [`body.${k}`, v]));
    writeFileSync(outPath, (await closetOps.drawAvatar(bundle, { spec, fitCache: cache, fitWeights: weights })).bytes);
  }
  const pass = c.items.every((x) => x.through == null || x.through < 0.005);
  const lines = c.items.map((x) => x.method !== 'spec-fit' ? `  ${x.name}: by ${x.method}${x.refused ? ` (${x.refused})` : ''}`
    : `  ${x.name}: ${x.verdict ? `${x.verdict}; ` : ''}Spec-fit, ${x.rule?.class} ${x.rule?.ease}, ${x.vertices} vertices in ${x.ms?.toFixed(1)} ms, ${x.pushed} pushed clear; skin through ${pctS(x.through)} (by the bones ${pctS(x.throughBones)}), uncovered ${pctS(x.uncovered)}; ease RMS ${x.easeRms != null ? (x.easeRms * 1000).toFixed(2) : '–'} mm; hems ${x.hemsMm != null ? x.hemsMm.toFixed(2) : '–'} mm${x.posedThrough != null ? `; posed (relaxed arms) ${pctS(x.posedThrough)} with the body's weights, ${pctS(x.posedThroughOwn)} with its own` : ''}${x.reasons?.length ? `\n    ${x.reasons.map((q) => `${q.level}: ${q.text}`).join('\n    ')}` : ''}${x.warnings?.length ? `\n    ${x.warnings.join('\n    ')}` : ''}`);
  const { covered, ...report } = c;
  void covered;
  out({ ok: pass, body: use.body, ...report, ...(opt('--out') ? { out: opt('--out') } : {}) },
    `${file}: fitted to ${body ? `Spec with ${JSON.stringify(body)}` : 'its body'}${c.identity ? ' (unedited: nothing moves)' : ''}; measured in ${c.msMeasure.toFixed(0)} ms${c.estimated.length ? `; estimated stations: ${c.estimated.join(', ')}` : ''}${c.refused ? `\n  refused: ${c.refused}` : ''}\n${lines.join('\n')}${opt('--out') ? `\n  wrote ${opt('--out')}` : ''}`);
  process.exit(pass ? 0 : 1);
}

// ---- motion (PRD phase 6: ANI; VRMXA §8) -----------------------------------------------------------------
const KIMODO = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'motions', 'kimodo');
const specRig = () => anim.rigFromVrm(needSpec(), { label: 'Spec' });
const cmS = (m) => `${(m * 100).toFixed(1)} cm`;
const checkText = (name, r) => `${name}: ${r.problems.length ? `${plural(r.problems.length, 'thing')} to fix` : 'nothing to fix'}\n${anim.checkLines(r).map((l) => `  ${l}`).join('\n')}`;
const parseOps = () => { try { const o = JSON.parse(opt('--ops')); if (!Array.isArray(o)) throw new Error('not a list'); return o; } catch (e) { return fail(2, `--ops must be a JSON list of corrections: ${e.message}`); } };
const boolOpt = (k) => (opt(k) == null ? undefined : opt(k) === 'true' ? true : opt(k) === 'false' ? false : fail(2, `${k} is true or false`));
const numbersLine = (n) => [n.lowestSole != null && `lowest sole ${cmS(n.lowestSole)}`, n.slide != null && `slide ${cmS(n.slide)}`, n.seam && `seam ${cmS(n.seam.gap)}, wrap ×${n.seam.roughness}`, n.facing && `facing ${n.facing.start}° (mean ${n.facing.mean}°)`, n.treadmill && `on the spot at ${n.treadmill.speed} m/s`, n.dressedContact && `standing soles ${cmS(n.dressedContact[0])}…${cmS(n.dressedContact[1])}`].filter(Boolean).join('; ');

async function clipCmd(op, file, outPath) {
  if (!['check', 'correct'].includes(op)) fail(2, 'clip check <clip> | clip correct <clip> <out.vrma> --ops … | --auto');
  if (!file || !existsSync(file)) fail(2, `${file ?? '(no path)'}: not found`);
  const rig = specRig();
  const m = await anim.importMotion(new Uint8Array(readFileSync(file)), basename(file));
  const g = anim.guessDetails(m.clip, rig);
  const details = { loops: boolOpt('--loops') ?? g.loops, rootMotion: flags.has('--in-place') ? 'inPlace' : flags.has('--travel') ? 'travel' : g.rootMotion, speed: opt('--speed') != null ? +opt('--speed') : null };
  const figure = opt('--lift') ? anim.withLift(rig, +opt('--lift'), `Spec in shoes of ${opt('--lift')} m`) : null;
  if (op === 'check') {
    const r = anim.checkClip(m.clip, { details, rig, figure });
    out({ ok: !r.problems.length, path: file, kind: m.kind, details, report: m.report, ...r }, checkText(file, r));
    process.exit(r.problems.length ? 1 : 0);
  }
  if (!outPath) fail(2, 'clip correct needs <out.vrma>');
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  const res = flags.has('--auto') ? anim.autoCorrect(m.clip, { rig, figure, details }) : (() => {
    const ops = parseOps();
    const before = anim.checkClip(m.clip, { details, rig, figure });
    const r = anim.applyCorrections(m.clip, ops, { rig, details });
    const d = { ...details, ...r.details };
    return { ops, before, after: anim.checkClip(r.clip, { details: d, rig, figure, corrections: ops }), clip: r.clip, details: d, notes: r.notes };
  })();
  writeFileSync(outPath, anim.writeVrma(res.clip, { extras: { 'x-xocialize.corrected': { from: basename(file), ops: res.ops } } }));
  out({ ok: !res.after.problems.length, path: outPath, ops: res.ops, notes: res.notes, details: res.details, before: res.before, after: res.after },
    `${outPath}: ${res.ops.map(anim.opLabel).join('; ') || 'no corrections'}\n  before: ${numbersLine(res.before.numbers)}\n  after:  ${numbersLine(res.after.numbers)}${res.notes.length ? `\n  ${res.notes.map(([i, t]) => `${anim.opLabel(res.ops[i])}: ${t}`).join('\n  ')}` : ''}\n${checkText('after', res.after)}`);
  process.exit(res.after.problems.length ? 1 : 0);
}

const findClipRef = (bundle, ref) => anim.findClip(bundle, ref) || fail(2, `no clip "${ref}"`);
const findSet = (bundle, ref) => anim.animationsOf(bundle).sets.find((s) => s.id === ref || s.name === ref) || fail(2, `no set "${ref}"`);
async function dressedFigure(bundle) {
  const av = bundle.entries.get('avatar.vrm');
  let lift = 0;
  const c = closetOps.closetOf(bundle);
  for (const id of c.worn.items) if (c.items.find((x) => x.id === id)?.slot === 'shoes') { try { lift = Math.max(lift, closetOps.liftOf((await closetOps.itemOf(bundle, id)).manifest)); } catch { /* unreadable */ } }
  const fig = anim.rigFromVrm(av, { label: `${bundle.manifest.title || 'the character'} (avatar.vrm)` });
  fig.lift = lift;
  // what groundedFor names (VRMXA §8.4): the base, how far this figure stands above its bare soles, the edit document
  // lift: the shoes' plus the body's own ground lift (the measurer's lengths.lift), not the hips over Spec's (§8.4)
  fig.bodyLift = bundle.docs.measurements?.lengths?.lift ?? 0;
  fig.of = { base: bundle.manifest.base?.sha256 ?? null, edits: bundle.manifest.avatar?.of?.edits ?? null, lift: Math.round((lift + fig.bodyLift) * 1e4) / 1e4 };
  return fig;
}
function motionText(file, doc, corr, plan) {
  const corrOf = (h) => corr.clips.find((e) => e.original === h || e.result === h);
  const lines = doc.clips.map((c) => {
    const e = corrOf(c.sha256);
    const role = e?.result === c.sha256 ? `corrected (${e.ops.map(anim.opLabel).join('; ')})` : e?.result ? 'original (corrected copy in use)' : '';
    return `  ${c.sha256.slice(0, 12)}  ${String(c.name).padEnd(22)} ${c.duration != null ? `${(+c.duration).toFixed(2)} s` : '–'}  ${c.loops ? 'loops' : 'once'}  ${c.rootMotion || '–'}${c.speed != null ? ` ${c.speed} m/s` : ''}${c.from ? `  from ${c.from}` : ''}${role ? `  ${role}` : ''}`;
  });
  const sets = doc.sets.map((s) => `  ${s.default ? '*' : ' '} ${s.name} (priority ${s.priority ?? 0}${s.requires?.length ? `, requires ${s.requires.join(' ')}` : ''}${s.from ? `, from ${s.from}` : ''}): ${Object.keys(s.slots || {}).join(', ')}`);
  const slots = Object.entries(plan.slots).map(([slot, v]) => `  ${slot.padEnd(22)} ${v.set.name}: ${v.clips.map((e) => doc.clips.find((c) => c.sha256 === e.clip)?.name || e.clip.slice(0, 12)).join(', ')}`);
  return `${file}: ${plural(doc.clips.length, 'clip')}, ${plural(doc.sets.length, 'set')}\n${lines.join('\n')}\nsets (* default):\n${sets.join('\n')}\nworn tags: ${plan.equipped.tags.join(' ') || '(none)'}; active: ${plan.active.map((s) => s.name).join(' > ')}\n${slots.join('\n')}`;
}
async function motion(file, op, ...rest) {
  const bundle = await openBundle(file);
  // a bundle written before VRMXA 0.31 kept corrections in the app's own file: moved into the fields (written by any operation)
  const migrated = specBytes() ? await anim.migrateCorrections(bundle, { specHips: specRig().restWorld.hips[1] }) : { moved: 0 };
  if (!op) {
    const doc = anim.animationsOf(bundle), corr = anim.correctionsOf(bundle), plan = await anim.motionPlan(bundle);
    out({ ok: true, path: file, animations: doc, corrections: corr, plan, migrated: migrated.moved }, motionText(file, doc, corr, plan) + (migrated.moved ? `\n(${migrated.moved} corrected clip(s) read from the app's pre-0.31 corrections file; any operation writes them in the 0.31 fields)` : ''));
    return;
  }
  const rig = specRig();
  if (op === 'check') {
    const figure = flags.has('--dressed') ? await dressedFigure(bundle) : null;
    const doc = anim.animationsOf(bundle);
    const which = !rest[0] || rest[0] === 'all' ? doc.clips.filter((c) => !anim.correctionsOf(bundle).clips.some((e) => e.result && e.original === c.sha256)) : [findClipRef(bundle, rest[0])];
    const results = which.map((c) => {
      const e = anim.correctionFor(bundle, c.sha256);
      const r = anim.checkClip(anim.readVrma(bundle.entries.get(c.file)), { details: c, rig, figure, hints: e?.hints || {}, corrections: e?.result === c.sha256 ? e.ops : [] });
      return { clip: c.sha256, name: c.name, ...r };
    });
    const bad = results.filter((r) => r.problems.length).length;
    out({ ok: !bad, path: file, figure: figure?.label || 'Spec', results }, results.map((r) => checkText(r.name, r)).join('\n'));
    process.exit(bad ? 1 : 0);
  }
  const outPath = rest.pop();
  if (!outPath) fail(2, `motion ${op} needs an output file last`);
  if (existsSync(outPath) && !flags.has('--force')) fail(2, `${outPath}: already exists (--force replaces it)`);
  let result;
  try {
    switch (op) {
      case 'add': {
        if (!rest[0]) fail(2, 'motion add needs <clip.vrma|.bvh|.fbx>');
        const m = await anim.importMotion(new Uint8Array(readFileSync(rest[0])), basename(rest[0]));
        const details = { name: opt('--name') || m.name, source: opt('--source') || basename(rest[0]), licence: opt('--licence') ?? null, ...(boolOpt('--loops') !== undefined ? { loops: boolOpt('--loops') } : {}), ...(opt('--root') ? { rootMotion: opt('--root') } : {}), ...(opt('--speed') ? { speed: +opt('--speed') } : {}) };
        result = { ...(await anim.addClip(bundle, m.bytes, { details, rig })), converted: m.kind, report: m.report };
        break;
      }
      case 'starter': {
        const dir = rest[0] || KIMODO;
        const listing = JSON.parse(readFileSync(join(dir, 'clips.json'), 'utf8'));
        result = await anim.addStarterClips(bundle, listing.clips.map((e) => ({ entry: e, bytes: new Uint8Array(readFileSync(join(dir, e.file))) })), listing);
        break;
      }
      case 'details': {
        const patch = {};
        for (const kv of rest.slice(1)) {
          const [k, ...v] = kv.split('='); const val = v.join('=');
          patch[k] = k === 'speed' || k === 'rate' ? (val === 'null' ? null : +val) : k === 'loops' ? (val === 'null' ? null : val === 'true') : val === 'null' ? null : k === 'licence' && val.trim().startsWith('{') ? JSON.parse(val) : val; // licence: text, or a block in VRM's terms as JSON (§8.4)
        }
        result = await anim.setClipDetails(bundle, findClipRef(bundle, rest[0]).sha256, patch);
        break;
      }
      case 'remove': result = await anim.removeClip(bundle, findClipRef(bundle, rest[0]).sha256); break;
      case 'keep-fixed': result = await anim.flattenClip(bundle, findClipRef(bundle, rest[0]).sha256); break;
      case 'correct': case 'uncorrect': {
        const figure = flags.has('--dressed') ? await dressedFigure(bundle) : null;
        const doc = anim.animationsOf(bundle);
        const corr = anim.correctionsOf(bundle);
        const targets = rest[0] === 'all' ? doc.clips.filter((c) => !corr.clips.some((e) => e.result === c.sha256)) : [findClipRef(bundle, rest[0])];
        result = [];
        for (const c of targets) {
          const e = anim.correctionFor(bundle, c.sha256);
          const original = e?.original || c.sha256;
          const rec = doc.clips.find((x) => x.sha256 === original);
          let ops = op === 'uncorrect' ? [] : flags.has('--auto') ? null : parseOps();
          if (ops === null) ops = anim.autoCorrect(anim.readVrma(bundle.entries.get(rec.file)), { rig, figure, details: rec, hints: e?.hints || {} }).ops;
          const r = await anim.correctClip(bundle, original, ops, { rig, figure });
          result.push({ name: c.name, original: r.original, result: r.result, ops, notes: r.notes, before: r.before.numbers, after: r.after.numbers, problemsBefore: r.before.problems.map((p) => p.id), problemsAfter: r.after.problems.map((p) => `${p.id}: ${p.text}`) });
        }
        break;
      }
      case 'set-new': result = { id: await anim.createSet(bundle, { name: rest[0] || 'New set', requires: opt('--requires') ? opt('--requires').split(',') : [], priority: +(opt('--priority') || 0), default: flags.has('--default') }) }; break;
      case 'set': {
        const s = findSet(bundle, rest[0]);
        const patch = {};
        for (const kv of rest.slice(1)) {
          const [k, ...v] = kv.split('='); const val = v.join('=');
          patch[k] = k === 'requires' ? (val ? val.split(',') : []) : k === 'priority' ? +val : k === 'default' ? val === 'true' : val;
        }
        result = await anim.updateSet(bundle, s.id, patch);
        break;
      }
      case 'slot': {
        const s = findSet(bundle, rest[0]);
        const entries = !rest[2] || rest[2] === '-' ? [] : rest[2].split(',').map((x) => { const [ref, w] = x.split('*'); return { clip: findClipRef(bundle, ref).sha256, ...(w ? { weight: +w } : {}) }; });
        result = await anim.setSlot(bundle, s.id, rest[1], entries);
        break;
      }
      case 'set-remove': result = await anim.removeSet(bundle, findSet(bundle, rest[0]).id); break;
      default: fail(2, `unknown motion operation "${op}"`);
    }
  } catch (e) {
    if (e instanceof anim.MotionError) fail(1, `${op} refused: ${e.message} [${e.code}]`);
    throw e;
  }
  touchBundle(bundle);
  const bytes = await writeBundle(bundle);
  const problems = await checkBundle(bytes, { spec: specBytes() });
  const ok = verdict(problems, false);
  writeFileSync(outPath, bytes);
  const doc = anim.animationsOf(bundle);
  const corrLines = op === 'correct' || op === 'uncorrect' ? `\n${result.map((r) => `  ${r.name}: ${r.ops.map(anim.opLabel).join('; ') || 'no corrections'}\n    before: ${numbersLine(r.before)} [${r.problemsBefore.join(', ')}]\n    after:  ${numbersLine(r.after)}${r.problemsAfter.length ? ` [${r.problemsAfter.join('; ')}]` : ' (passes)'}`).join('\n')}` : '';
  out({ ok, path: outPath, op, result, revision: bundle.manifest.revision, animations: doc, problems },
    `${outPath}: motion ${op} done, revision ${bundle.manifest.revision}, ${plural(doc.clips.length, 'clip')}, ${plural(doc.sets.length, 'set')}, ${ok ? 'passes' : 'FAILS'} validation${corrLines}${problems.length ? `\n${problemLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}

// ---- phase 7: details, licences, export, voices, persona (PRD §11 to §15) -----------------------------------------
const cq = (s) => JSON.stringify(s); // text from a file is shown quoted: the file's content (MCP-7)
async function finish(bundle, outPath, what, result, extraText = '') {
  touchBundle(bundle);
  const bytes = await writeBundle(bundle);
  const problems = await checkBundle(bytes, { spec: specBytes() });
  const ok = verdict(problems, false);
  writeFileSync(outPath, bytes);
  out({ ok, path: outPath, op: what, result, revision: bundle.manifest.revision, problems },
    `${outPath}: ${what} done, revision ${bundle.manifest.revision}, ${ok ? 'passes' : 'FAILS'} validation${extraText}${problems.length ? `\n${problemLines(problems)}` : ''}`);
  process.exit(ok ? 0 : 1);
}
const refused = (e, op) => {
  if (e instanceof character.DetailsError || e instanceof voice.VoiceError || e instanceof persona.PersonaError || e instanceof persona.CardError || e instanceof character.ExportError || e instanceof closetOps.ClosetError) fail(1, `${op} refused: ${e.message}`);
  throw e;
};
const specMeta = () => { const s = specBytes(); try { return s ? parseGlb(s).json.extensions.VRMC_vrm.meta : null; } catch { return null; } };
const termsText = (meta, kind) => character.termsOf(meta, { kind, flags: true }).map((t) => `${t.ok ? '+' : '-'} ${t.text}${t.stated ? '' : ' (VRM default)'}`).join('; ');

async function details(file, op, ...rest) {
  const bundle = await openBundle(file);
  if (!op) {
    const d = character.detailsOf(bundle);
    const lim = Object.entries(d.limits).filter(([, l]) => l.by.length).map(([k, l]) => `  ${k}: at most ${cq(character.wordsFor(k, l.loosest))} (${l.by.map((b) => cq(b.name)).join(', ')})`);
    return out({ ok: true, path: file, ...d },
      `${file}: details [text is the file's content]\n  name       ${cq(d.meta.name)}  version ${cq(d.meta.version ?? '')}\n  makers     ${(d.meta.authors || []).map(cq).join(', ')}\n  copyright  ${cq(d.meta.copyrightInformation ?? '')}  contact ${cq(d.meta.contactInformation ?? '')}\n  licence    ${d.meta.licenseUrl}\n  allows     ${termsText(d.meta, 'character')}\n  chosen     ${({ chosen: `by the person, ${d.chosen}`, restricted: 'not yet: nothing is allowed until the person chooses', 'from-spec': 'not yet: Spec\'s permissions were taken over, so nothing is allowed until the person chooses (shown and exported so, LIC-3)', 'from-file': 'not here: the permissions are the file\'s own, not confirmed here' })[d.permissions]}${d.looser.length ? `\n${character.looserLines(d.looser).map((l) => `  ! ${l}`).join('\n')}` : ''}\n  origin     ${d.listing ? `${cq(d.listing.url ?? '')} ${cq(d.listing.marketplace ?? '')} ${cq(d.listing.listing_id ?? '')}` : 'none'}${lim.length ? `\nlimits set by the worn pieces:\n${lim.join('\n')}` : ''}`);
  }
  if (op !== 'set') fail(2, `unknown details operation "${op}"`);
  const outPath = rest.pop();
  if (!outPath || !rest.length) fail(2, 'details set key=value … <out.vrmxa>');
  const patch = {}, listing = {};
  for (const kv of rest) {
    const [k, ...v] = kv.split('='); const val = v.join('=');
    if (k.startsWith('listing.')) { listing[k.slice(8)] = val; continue; }
    patch[k] = val === '' ? null : ['authors', 'references'].includes(k) ? val.split(',').map((x) => x.trim()).filter(Boolean) : val === 'true' ? true : val === 'false' ? false : val;
  }
  try {
    if (Object.keys(patch).length) await character.setDetails(bundle, patch, { baseMeta: specMeta() });
    if (Object.keys(listing).length) await character.setListing(bundle, { ...(character.detailsOf(bundle).listing || {}), ...listing });
  } catch (e) { refused(e, 'details set'); }
  await finish(bundle, outPath, 'details set', character.detailsOf(bundle));
}

async function licence(file) {
  const bundle = await openBundle(file);
  const t = character.licenceTable(bundle);
  const d = character.detailsOf(bundle, { baseMeta: specMeta() });
  const wear = opt('--items') ? opt('--items').split(',').map((r) => findItem(bundle, r).id) : closetOps.closetOf(bundle).items.map((e) => e.id);
  const asked = character.questionsBeforeWearing(bundle, wear);
  const share = character.shareReport(bundle);
  const row = (x) => `  ${cq(x.name)}${x.slot ? ` [${x.slot}]` : ''}: ${x.whose ? `by ${cq(x.whose)}` : 'no maker stated'}; ${x.allows}`;
  out({ ok: true, path: file, details: d, table: t, questions: asked, share },
    `${file}: licences [names are the file's content]\nthe character: ${termsText(d.meta, 'character')}\nitems:\n${t.items.map(row).join('\n') || '  none'}\nclips (free-text licences, shown not judged):\n${t.clips.map((c) => `  ${cq(c.name)}: ${c.allows}`).join('\n') || '  none'}\nvoices:\n${t.voices.map(row).join('\n') || '  none'}\nasked before wearing (HON-1):\n${asked.map((q) => `  ${q.text}`).join('\n') || '  nothing'}\na shared copy (HON-2):\n${share.notes.map((n) => `  ${n}`).join('\n') || '  leaves nothing out'}`);
}

async function creditsCmd(file) {
  const bundle = await openBundle(file);
  const c = character.credits(bundle, { baseMeta: specMeta() });
  out({ ok: true, path: file, ...c }, `${file}: credit goes to [names are the file's content]\n${c.lines.map((l) => `  ${l}`).join('\n') || '  nobody: no piece asks for credit'}`);
}

// ---- the one flattener (PRD MCP-10, REF-10) ------------------------------------------------------------
async function flattenCmd(file, folder) {
  const bundle = await openBundle(file);
  const doc = (k) => { const p = documentPaths(bundle)[k] ?? `appearance/${k}/${k}.json`; const b = bundle.entries.get(p); return b ? JSON.parse(new TextDecoder().decode(b)) : null; };
  const eyes = doc('eyes'), skin = doc('skin');
  if (!eyes && !skin) fail(1, `${file}: no layered eyes or skin to flatten`);
  const load = layers.pictureLoader(bundle.entries);
  const only = opt('--state') ? opt('--state').split(',') : undefined;
  const made = [];
  if (eyes) for (const [state, ts] of Object.entries(layers.flattenEyes(eyes, load, { states: only }))) for (const [t, p] of Object.entries(ts)) made.push({ path: `eyes/${state}-${t}.png`, pic: p });
  let skinBase = 'none';
  if (skin && !only) {
    const spec = specBytes();
    const bases = {};
    if (spec) { for (const [t, d] of Object.entries(skin.targets || {})) bases[t] = layers.materialPicture(spec, d.material); skinBase = "the base's own skin"; }
    for (const [t, p] of Object.entries(layers.flattenSkin(skin, load, bases))) made.push({ path: `skin/${t}.png`, pic: p });
  }
  const list = [];
  for (const m of made) {
    const png = encodePng(m.pic);
    if (folder) { const to = join(folder, m.path); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, png); }
    list.push({ path: m.path, size: [m.pic.width, m.pic.height], pixels: await sha256(m.pic.data), png: await sha256(png) });
  }
  out({ ok: true, path: file, folder: folder || null, skinBase, textures: list },
    `${file}: ${list.length} finished texture${list.length === 1 ? '' : 's'}${folder ? `, written to ${folder}` : ''}${skin && !only ? ` (skin over ${skinBase})` : ''}\n${list.map((t) => `  ${t.path.padEnd(28)} ${t.size.join('×').padEnd(10)} ${t.pixels.slice(0, 12)}`).join('\n')}`);
}

async function exportCmd(file, outArg) {
  const bundle = await openBundle(file);
  try {
    if (opt('--vrm')) {
      const r = await character.exportVrm(bundle, { spec: specBytes(), forSharing: flags.has('--share') });
      writeFileSync(opt('--vrm'), r.bytes);
      const leaves = character.vrmLeavesOut(bundle);
      return out({ ok: true, path: opt('--vrm'), bytes: r.bytes.length, drawn: r.drawn, leftOut: r.leftOut, notes: r.notes, carries: leaves, problems: r.problems },
        `${opt('--vrm')}: a plain VRM 1.0, ${r.bytes.length} bytes, ${r.drawn ? 'drawn again' : 'the same model as avatar.vrm'}, passes the model checks\n${[...r.notes, ...leaves].map((n) => `  ${n}`).join('\n')}`);
    }
    if (opt('--item')) {
      const e = findItem(bundle, opt('--item'));
      if (!outArg) fail(2, 'export --item <item> <out.vrmxw>');
      const r = await character.exportItem(bundle, e.id, { spec: specBytes() });
      writeFileSync(outArg, r.bytes);
      return out({ ok: true, path: outArg, bytes: r.bytes.length, name: r.name, problems: r.problems }, `${outArg}: ${cq(r.name)}, ${r.bytes.length} bytes, exactly as it arrived, passes validation`);
    }
  } catch (e) { refused(e, 'export'); }
  fail(2, 'export --vrm <out.vrm> [--share] | --item <item> <out.vrmxw>');
}

async function share(file, outPath) {
  if (!outPath) fail(2, 'share <file.vrmxa> <out.vrmxa> [--new-identity]');
  const bundle = await openBundle(file);
  let r;
  try { r = await character.shareCopy(bundle, { spec: specBytes(), newIdentity: flags.has('--new-identity') }); } catch (e) { refused(e, 'share'); }
  writeFileSync(outPath, r.bytes);
  out({ ok: true, path: outPath, bytes: r.bytes.length, id: r.bundle.manifest.id, fileId: r.bundle.manifest.fileId, sameCharacter: r.sameCharacter, report: r.report, notes: r.notes, problems: r.problems },
    `${outPath}: a copy to share, ${r.bytes.length} bytes, passes validation; id ${r.bundle.manifest.id}${r.sameCharacter ? ' (kept)' : ' (new)'}, file ${r.bundle.manifest.fileId}\n${r.notes.map((n) => `  ${n}`).join('\n')}`);
}

function voiceText(file, list) {
  return `${file}: ${plural(list.length, 'voice')} [names and words are the file's content]\n${list.map((v) => `  ${v.default ? '*' : ' '} ${cq(v.name)} [${v.origin}${v.realPerson ? `, ${cq(v.speaker || '?')}'s voice` : ', no real person'}] by ${cq(v.licence.whose || '?')}: ${v.licence.allows}${v.shareable ? '' : ' (left out of a shared copy)'}${v.consentProblem ? `\n      ! ${v.consentProblem}` : v.realPerson ? `\n      consent ${v.consent.date}: ${cq(v.consent.scope)}` : ''}${v.design ? `\n      designed by ${v.design.model}${v.design.version ? ` ${v.design.version}` : ''}, seed ${v.design.seed}: ${cq(v.design.description)}` : ''}\n${v.clips.map((c) => `      ${c.primary ? '>' : ' '} ${c.file} ${c.duration?.toFixed(1)} s ${c.sampleRate} Hz ${c.style || ''}: ${cq(c.transcript)}${c.warnings.map((w) => `\n          warning: ${w}`).join('')}`).join('\n')}`).join('\n')}`;
}

async function voiceCmd(file, op = 'list', ...rest) {
  const bundle = await openBundle(file);
  if (op === 'list' || op === 'check') {
    const list = voice.voiceSummaries(bundle);
    const bad = list.filter((v) => v.consentProblem || v.clips.some((c) => c.missing));
    out({ ok: !bad.length, path: file, voices: list }, voiceText(file, list));
    process.exit(op === 'check' && bad.length ? 1 : 0);
  }
  if (op === 'preset') return voicePreset(bundle, rest);
  if (op !== 'import') fail(2, `unknown voice operation "${op}"`);
  const [clipPath, outPath] = rest;
  if (!clipPath || !outPath || !opt('--name') || !opt('--transcript')) fail(2, 'voice import <clip.wav> --name N --transcript T … <out.vrmxa>');
  const real = flags.has('--real-person');
  // a recording is a real person's voice unless the person says it isn't (HON-3)
  if ((opt('--origin') === 'recorded') && !real && !flags.has('--no-real-person')) fail(1, 'voice import refused: a recording is a real person\'s voice: pass --real-person with --speaker and their consent (--consent-date, --consent-scope), or --no-real-person if no real person\'s voice is in it (HON-3)');
  if (real && flags.has('--no-real-person')) fail(2, '--real-person and --no-real-person can\'t both be given');
  const spec = {
    name: opt('--name'), language: opt('--language') || 'en', origin: opt('--origin') || (real ? 'recorded' : 'imported'), realPerson: real,
    source: opt('--source') || basename(clipPath),
    ...(real ? { speaker: opt('--speaker'), consent: opt('--consent-date') || opt('--consent-scope') ? { given: true, date: opt('--consent-date'), scope: opt('--consent-scope'), ...(opt('--consent-record') ? { record: opt('--consent-record') } : {}) } : null } : {}),
    // as in the app: a real person's voice is credited to them; otherwise to the character's own makers
    meta: voice.newVoiceMeta({ authors: real && opt('--speaker') ? [opt('--speaker')] : (character.avatarMeta(bundle)?.authors?.length ? character.avatarMeta(bundle).authors : ['VRMXA Avatar Studio']) }),
    clips: [{ bytes: new Uint8Array(readFileSync(clipPath)), transcript: opt('--transcript'), style: opt('--style') || 'neutral' }],
  };
  let r;
  try { r = await voice.addVoice(bundle, spec); } catch (e) { refused(e, 'voice import'); }
  await finish(bundle, outPath, 'voice import', r, `\n${voiceText(outPath, voice.voiceSummaries(bundle).filter((v) => v.id === r.id))}${r.changed.length ? `\n  the clip was ${r.changed.join(', ')}` : ''}`);
}

// A preset voice (VRMXA §9 origin "preset", D36): an engine's built-in speaker, named under `engines`, with no clip. The
// engine id is the model's id in lower case (kokoro-82m: AB-A-0323's working default); the preset is the engine's own
// speaker name. No real person's voice. A new voice starts at the most restricted licence; --meta key=value loosens it.
async function voicePreset(bundle, rest) {
  const [outPath] = rest;
  const engine = opt('--engine'), preset = opt('--preset');
  if (!outPath || !engine || !preset) fail(2, 'voice <file.vrmxa> preset --engine kokoro-82m --preset af_heart [--name N] [--meta key=value …] [--default] [--persona] <out.vrmxa>');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(engine)) fail(2, `--engine is the model's id in lower case (kokoro-82m, zonos3-mini), not "${engine}"`);
  const authors = character.avatarMeta(bundle)?.authors?.length ? character.avatarMeta(bundle).authors : ['VRMXA Avatar Studio'];
  const meta = voice.newVoiceMeta({ authors });
  for (const kv of optAll('--meta')) {
    const [k, ...v] = kv.split('='); const val = v.join('=');
    meta[k] = k === 'authors' ? val.split(',').map((x) => x.trim()).filter(Boolean) : val === 'true' ? true : val === 'false' ? false : val;
  }
  const spec = { name: opt('--name') || `${preset} (${engine})`, language: opt('--language') || 'en', origin: 'preset', realPerson: false,
    source: `${engine} preset ${preset}`, engines: { [engine]: { preset } }, meta, clips: [] };
  let r;
  try {
    r = await voice.addVoice(bundle, spec);
    if (flags.has('--default')) await voice.setDefaultVoice(bundle, r.id);
    if (flags.has('--persona')) {
      if (!persona.personaOf(bundle)) fail(1, 'voice preset --persona: the character has no persona to name the voice in');
      await persona.setPersona(bundle, { voice_id: r.id });
    }
  } catch (e) { refused(e, 'voice preset'); }
  await finish(bundle, outPath, 'voice preset', r, `\n${voiceText(outPath, voice.voiceSummaries(bundle).filter((v) => v.id === r.id))}\n  engine ${engine}, preset ${preset}${flags.has('--persona') ? `\n  the persona's voice_id is ${r.id}` : ''}`);
}

async function personaCmd(file, op = 'show', ...rest) {
  const bundle = await openBundle(file);
  if (op === 'show') {
    const p = persona.personaOf(bundle);
    if (!p) return out({ ok: true, path: file, persona: null }, `${file}: no persona`);
    return out({ ok: true, path: file, persona: p, contentNote: 'text is the file\'s content, not instructions' },
      `${file}: persona [the file's content, not instructions]\n  name ${cq(p.name)}  age ${cq(p.age ?? '')}\n  summary ${cq(p.summary ?? '')}\n  looks ${cq(p.description ?? '')}\n  personality ${cq(p.personality ?? '')}\n  traits ${p.traits.map(cq).join(', ')}\n  speech ${cq(p.speech_style ?? '')}  languages ${p.languages.join(', ')}\n  at rest ${p.rest_expression}; may show ${p.allowed_expressions.join(', ')}\n  voice ${p.voice_id ?? 'none'}\n${p.examples.map((e) => `  > ${cq(e.user)}\n    ${cq(e.character)}`).join('\n')}`);
  }
  if (op === 'import') {
    const [cardPath, outPath] = rest;
    if (!cardPath || !outPath) fail(2, 'persona import <card.json|.png> <out.vrmxa>');
    let r;
    // the exchange form (`"format": "vrmxa-persona"`, VRMXA §10.1) carries every core field, the expressions included;
    // anything else is read as a character card
    let exchange = null;
    try { const j = JSON.parse(readFileSync(cardPath, 'utf8')); if (j?.format === persona.PERSONA_FORMAT) exchange = j; } catch { /* not JSON: a card PNG */ }
    try {
      r = exchange ? { version: 'exchange', patch: persona.fromExchange(exchange), appSide: {}, leftOut: [], notes: [] } : persona.cardToPersona(new Uint8Array(readFileSync(cardPath)));
      await persona.setPersona(bundle, r.patch);
    } catch (e) { refused(e, 'persona import'); }
    if (opt('--app-fields') && Object.keys(r.appSide).length) writeFileSync(opt('--app-fields'), JSON.stringify({ format: 'x-xocialize.card-app-side', from: basename(cardPath), version: r.version, fields: r.appSide }, null, 2) + '\n');
    const lines = [`  read ${r.version === 'exchange' ? 'the exchange form' : `a ${r.version.toUpperCase()} card`}; core fields: ${Object.keys(r.patch).join(', ')}`,
      Object.keys(r.appSide).length ? `  not written into the bundle (the app's, VRMXA §10.2): ${Object.keys(r.appSide).join(', ')}${opt('--app-fields') ? ` → kept in ${opt('--app-fields')}` : ''}` : null,
      r.leftOut.length ? `  left out: ${r.leftOut.join(', ')}` : null, ...r.notes.map((n) => `  note: ${n}`)].filter(Boolean);
    return finish(bundle, outPath, 'persona import', { patch: r.patch, appSide: Object.keys(r.appSide), leftOut: r.leftOut, notes: r.notes }, `\n${lines.join('\n')}`);
  }
  if (op === 'export') {
    const [outPath] = rest;
    if (!outPath) fail(2, 'persona export <out.json|.png>');
    const p = persona.personaOf(bundle);
    let appSide = {};
    if (opt('--app-fields')) { try { appSide = JSON.parse(readFileSync(opt('--app-fields'), 'utf8')).fields || {}; } catch (e) { fail(2, `${opt('--app-fields')}: ${e.message}`); } }
    let card;
    try { card = persona.personaToCard(p, { version: opt('--card-version') || 'v2', appSide, characterVersion: character.detailsOf(bundle).meta.version || '' }); } catch (e) { refused(e, 'persona export'); }
    if (/\.png$/i.test(outPath)) {
      const thumb = bundle.entries.get(bundle.manifest.thumbnail || 'thumbnail.png');
      if (!thumb) fail(1, 'the character has no thumbnail to carry the card: export a .json card instead');
      writeFileSync(outPath, persona.cardPng(thumb, card));
    } else writeFileSync(outPath, JSON.stringify(card, null, 2) + '\n');
    return out({ ok: true, path: outPath, card }, `${outPath}: ${card.spec} for ${cq(card.data.name)}${Object.keys(appSide).length ? `, with the app-side fields ${Object.keys(appSide).join(', ')}` : ', core persona only'}`);
  }
  fail(2, `unknown persona operation "${op}"`);
}

// ---- the specification's test files and the conformance kit (PRD REF-2, REF-3, MCP-9) ------------------------------
function specRepoOrFail() {
  const repo = opt('--kit') ? join(opt('--kit'), '..') : findSpecRepo();
  if (!repo || !existsSync(join(repo, 'fixtures'))) fail(2, 'the specification repository (with fixtures/ and conformance/) was not found beside this one; set VRMXA_SPEC_REPO');
  return repo;
}

async function fixturesCmd(sub = 'list') {
  const repo = specRepoOrFail();
  const dir = opt('--dir') || join(repo, 'fixtures');
  const exp = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  if (sub === 'list') {
    const total = [...Object.values(exp.valid), ...Object.values(exp.invalid)].reduce((a, v) => a + v.size, 0);
    out({ ok: true, dir, ...exp, total },
      `${dir}: ${Object.keys(exp.valid).length} valid and ${Object.keys(exp.invalid).length} invalid files, ${mb(total)}\n\nvalid (each passes with nothing to report):\n${Object.entries(exp.valid).map(([f, v]) => `  ${f.padEnd(34)} ${String(v.size).padStart(9)}  ${v.covers}\n${' '.repeat(47)}${v.what}`).join('\n')}\n\ninvalid (each fails for one rule):\n${Object.entries(exp.invalid).map(([f, v]) => `  ${f.padEnd(48)} ${v.section}: ${v.rule}  [${v.library.join(', ')}]`).join('\n')}`);
    process.exit(0);
  }
  if (sub !== 'check') fail(2, `fixtures ${sub}: list or check`);
  const { specChecker } = await import('../src/node/spec-check.js');
  const sc = specChecker();
  const spec = specBytes();
  const rows = [];
  for (const [f, v] of [...Object.entries(exp.valid).map((e) => [...e, true]), ...Object.entries(exp.invalid).map((e) => [...e, false])]) {
    const bytes = new Uint8Array(readFileSync(join(dir, f)));
    const lib = f.endsWith('.vrmxw') ? await checkItem(bytes, { spec }) : await checkBundle(bytes, { spec });
    const sp = sc.checkFile(bytes, { name: f });
    const codes = (P) => [...new Set(P.filter((p) => p.severity === 'error').map((p) => p.code))].sort();
    let ok;
    if (v.valid !== undefined || exp.valid[f]) ok = !lib.some((p) => p.severity !== 'info') && !sp.some((p) => p.severity !== 'info');
    else ok = JSON.stringify(codes(lib)) === JSON.stringify([...v.library].sort()) && JSON.stringify(codes(sp)) === JSON.stringify([...v.spec].sort());
    rows.push({ file: f, valid: !!exp.valid[f], ok, library: codes(lib), spec: codes(sp), rule: v.rule, section: v.section });
  }
  const ok = rows.every((r) => r.ok);
  out({ ok, rows }, `${rows.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.file}: ${r.valid ? 'passes with nothing to report' : `fails for "${r.rule}" (${r.section}) — library ${r.library.join(', ')}; spec checker ${r.spec.join(', ') || '— (needs SQLite)'}`}`).join('\n')}\n${rows.filter((r) => r.ok).length} of ${rows.length} fixtures behave as expected.json says`);
  process.exit(ok ? 0 : 1);
}

async function conformanceCmd(sub, ...rest) {
  const repo = specRepoOrFail();
  const kit = opt('--kit') || join(repo, 'conformance');
  const cases = JSON.parse(readFileSync(join(kit, 'cases.json'), 'utf8')).cases;
  if (!sub) fail(2, 'conformance <their-output-dir> | run <out-dir> | cases');
  if (sub === 'cases') {
    out({ ok: true, cases }, cases.map((c) => `${c.id} — ${c.title} (${c.sections}; ${c.level})\n  in:   ${Object.values(c.inputs).join('; ')}\n  do:   ${c.operation}\n  out:  ${(c.outputs || c.bodies.map((b) => `${b.id}.json`)).join(', ')}${c.outputForm ? `  ${c.outputForm}` : ''}${c.compares ? `\n  compared: ${c.compares}` : ''}`).join('\n\n'));
    process.exit(0);
  }
  if (sub === 'run') {
    const dir = rest[0];
    if (!dir) fail(2, 'conformance run <out-dir>');
    const spec = needSpec();
    const { referenceOutputs } = await import('../src/node/conformance.js');
    const t0 = Date.now();
    const r = await referenceOutputs(dir, { spec, specRepo: repo, only: opt('--only') ? opt('--only').split(',') : null });
    out({ ok: true, dir, cases: r.cases, seconds: (Date.now() - t0) / 1000 }, `${dir}: the reference library's output for ${r.cases.length} cases (${r.cases.join(', ')}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    process.exit(0);
  }
  // compare an app's output: the kit's runner, then this library's checker on every bundle and item written (it opens the
  // database and checks models more deeply than the specification's checker)
  const { runConformance } = await import('../src/spec/conformance.js');
  const { specChecker } = await import('../src/node/spec-check.js');
  let r;
  try { r = await runConformance({ kit, outputDir: sub, checker: specChecker(), only: opt('--only') ? opt('--only').split(',') : null }); } catch (e) { fail(2, e.message); }
  const deep = [];
  for (const c of r.cases) {
    if (c.status === 'not run') continue;
    for (const f of (cases.find((x) => x.id === c.id)?.outputs || []).filter((x) => /\.vrmx[aw]$/.test(x))) {
      const p = join(sub, c.id, f);
      if (!existsSync(p)) continue;
      const bytes = new Uint8Array(readFileSync(p));
      const P = (f.endsWith('.vrmxw') ? await checkItem(bytes, { spec: specBytes() }) : await checkBundle(bytes, { spec: specBytes() })).filter((x) => x.severity === 'error');
      const ok = !P.length;
      c.checks.push({ name: `${f} passes the reference library's checker`, ok, detail: P.slice(0, 3).map((x) => `${x.code} ${x.where}`).join('; ') });
      if (!ok) { c.status = 'fails'; deep.push(c.id); }
    }
  }
  const ok = r.ok && !deep.length;
  const text = r.cases.map((c) => {
    const head = `${c.status === 'passes' ? 'PASS' : c.status === 'not run' ? 'skip' : 'FAIL'}  ${c.id}: ${c.title}${c.sections ? ` (${c.sections})` : ''}`;
    if (c.status === 'not run') return `${head}\n        not run: no folder ${c.id}/ in the output`;
    if (c.error) return `${head}\n        ${c.status}: ${c.error}`;
    return [head, ...c.checks.map((x) => `        ${x.ok ? 'ok  ' : 'FAIL'} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`)].join('\n');
  }).join('\n');
  const passed = r.cases.filter((c) => c.status === 'passes').length;
  out({ ok, cases: r.cases }, `${text}\n${passed} of ${r.cases.length} cases pass`);
  process.exit(ok ? 0 : 1);
}

// the MCP server (PRD MCP-1 as amended, MCP-10): runs until its client closes stdin
async function mcpCmd(file) {
  const { serve } = await import('../src/mcp/server.js');
  await serve({ app: flags.has('--app'), port: opt('--port') ? Number(opt('--port')) : undefined, file: file ?? null });
}

const commands = { mcp: mcpCmd, inspect, validate, pack, unpack, upgrade, measure, edits, 'apply-edits': applyEditsCmd, bake, closet, import: importCmd, fit: fitCmd, clip: clipCmd, motion,
  details, licence, credits: creditsCmd, flatten: flattenCmd, export: exportCmd, share, voice: voiceCmd, persona: personaCmd, fixtures: fixturesCmd, conformance: conformanceCmd };
if (!cmd || flags.has('--help') || !commands[cmd]) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(cmd && !flags.has('--help') ? 2 : 0);
}
try {
  await commands[cmd](...args);
} catch (e) {
  fail(2, e?.message || String(e));
}
