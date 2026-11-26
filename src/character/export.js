// Export and share (PRD CHR-6, EXP-2 to EXP-5; VRMXA §4.1, §5.2, §2 rule 8).
//
//   exportVrm   a plain .vrm: the same model as avatar.vrm (CHR-6). For yourself it is avatar.vrm itself (drawn again
//               first if it is out of date); for someone else the worn pieces that may not be passed on are left out
//               and it is drawn again without them (HON-2's rule applied to the model).
//   exportItem  a closet item as its .vrmxw, exactly as it arrived (EXP-3, CLOSET.md §5.9).
//   shareCopy   a copy of the character for someone else (EXP-2): offered a new identity (CHR-4, §4.1), with what may
//               not be passed on left out (voices, item files, changed copies of worn pieces) and said, avatar.vrm and
//               the thumbnail drawn again without it, and the person's own answers to licence questions dropped.
// Each export is checked before it is given back (EXP-4): the bundle checker (`vrmxa validate`) or the model checker,
// and refused with the reasons when it fails.
//
// What VRM can't show (EXP-5, rule 8): a plain VRM has the default eyes and mouth, what is worn now in its state, the
// character's details and each merged piece's licence (`extras.vrmxaPieces`); voices, the persona, motion sets, eye
// and mouth states and the closet's spares are left out. `vrmLeavesOut` lists them for the person.

import { clone, newUuid, nowIso } from '../bytes.js';
import { checkBundle, checkItem, checkModel } from '../checker.js';
import { avatarIsCurrent, changeHair, closetOf, copyOut, removeItem, takeOff } from '../closet/ops.js';
import { drawAvatar, redrawAvatar } from '../closet/avatar.js';
import { setDocument, setEntry, writeBundle } from '../vrmxa.js';
import { voicesOf } from '../voice/voices.js';
import { HONOURED_PREFIX, TIGHTENED_PREFIX, avatarMeta, databaseData, writeDatabase, permissionsState, withPermissions, setWholeMeta, piecesOf } from './details.js';
import { RESTRICTED, looserThanPieces, looserLines } from './terms.js';
import { parseGlb } from '../glb.js';
import { shareReport, vrmShareReport } from './honour.js';
import { drawThumbnail as drawThumbnailOf } from './thumbnail.js';

export class ExportError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'ExportError';
    this.problems = problems;
  }
}

const errorsOf = (problems) => problems.filter((p) => p.severity === 'error');
const refuse = (what, problems) => {
  const e = errorsOf(problems);
  throw new ExportError(`${what} did not pass the checks: ${e.slice(0, 3).map((p) => `${p.where ? `${p.where}: ` : ''}${p.message}`).join(' · ')}${e.length > 3 ? ` (and ${e.length - 3} more)` : ''}`, problems);
};

const specMetaOf = (spec) => { try { return spec ? parseGlb(spec).json.extensions?.VRMC_vrm?.meta ?? null : null; } catch { return null; } };

/** A working copy of a bundle: its own manifest, documents, database rows and entry map (the bytes are shared). */
export function copyBundle(bundle) {
  return {
    ...bundle,
    manifest: clone(bundle.manifest),
    entries: new Map(bundle.entries),
    docs: clone(bundle.docs),
    database: clone(bundle.database),
    skipped: [...(bundle.skipped || [])],
    problems: [],
  };
}

// take a worn piece off: the hair piece is changed to none (CLOSET.md §5.7), an item taken off (§5.3)
async function takeOffPiece(bundle, id) {
  if (closetOf(bundle).hair === id) await changeHair(bundle, null);
  else await takeOff(bundle, id);
}

/** What a plain VRM leaves out of this character, in plain words (EXP-5, DES-9). → [text] */
export function vrmLeavesOut(bundle) {
  const out = [];
  const eyes = bundle.docs.eyes?.states?.length ?? 0;
  const mouth = bundle.docs.mouth?.states?.length ?? 0;
  out.push(eyes ? `Only the default eyes (${eyes} eye state${eyes === 1 ? '' : 's'} left out)` : 'Only the default eyes');
  out.push(mouth ? `Only the default mouth (${mouth} mouth state${mouth === 1 ? '' : 's'} left out)` : 'Only the default mouth');
  const c = closetOf(bundle);
  const spares = c.items.filter((e) => !c.worn.items.includes(e.id) && c.hair !== e.id).length;
  out.push(spares ? `Only what is worn now, in its state (${spares} spare item${spares === 1 ? '' : 's'} left out)` : 'Only what is worn now, in its state');
  const voices = voicesOf(bundle).voices.length;
  if (voices) out.push(`No voice (${voices} left out)`);
  if (bundle.database?.persona) out.push('No persona');
  const clips = bundle.docs.animations?.clips?.length ?? 0;
  if (clips) out.push(`No motions (${clips} clip${clips === 1 ? '' : 's'} left out: a VRM carries none)`);
  return out;
}

/**
 * A plain VRM 1.0 of the character (CHR-6, EXP-3). opts: { spec (spec.vrm, needed when it must be drawn), forSharing,
 * fitCache }. → { bytes, leftOut: [{ id, name, why }], notes, drawn (true when drawn again), problems }
 */
export async function exportVrm(bundle, { spec = null, forSharing = false, fitCache = undefined } = {}) {
  const left = forSharing ? vrmShareReport(bundle) : { items: [], notes: [] };
  let bytes, drawn = false;
  if (!left.items.length && (await avatarIsCurrent(bundle))) bytes = bundle.entries.get(bundle.manifest.avatar?.file || 'avatar.vrm');
  else {
    if (!spec) throw new ExportError('drawing the VRM again needs spec.vrm');
    const work = copyBundle(bundle);
    for (const it of left.items) await takeOffPiece(work, it.id);
    bytes = (await drawAvatar(work, { spec, fitCache })).bytes;
    drawn = true;
  }
  const notes = [...left.notes];
  const state = permissionsState(bundle, { baseMeta: specMetaOf(spec) });
  if (state === 'from-spec') {
    bytes = withPermissions(bytes, RESTRICTED);
    notes.push('The permissions were never chosen and were Spec\'s: written as nothing allowed (LIC-3). Choose them on Details.');
  } else if (state === 'from-file') notes.push('The permissions are the file\'s own, not confirmed here.');
  // what is written may be looser than a piece in it allows (VRMXA §5.3; how the meta is written is SPEC-QUESTIONS #74)
  const looser = looserThanPieces(parseGlb(bytes).json.extensions?.VRMC_vrm?.meta, parseGlb(bytes).json.extras?.vrmxaPieces || []);
  notes.push(...looserLines(looser));
  const { problems } = checkModel(bytes, { kind: 'vrm', where: 'export.vrm' });
  if (errorsOf(problems).length) refuse('The VRM', problems);
  return { bytes, leftOut: left.items, notes, looser, permissions: state, drawn, problems };
}

/** A closet item as its .vrmxw, exactly as it arrived (EXP-3), checked (EXP-4). → { bytes, name, problems } */
export async function exportItem(bundle, id, { spec = null } = {}) {
  const e = closetOf(bundle).items.find((x) => x.id === id);
  if (!e) throw new ExportError(`there is no item ${id} in the closet`);
  const bytes = copyOut(bundle, id);
  const problems = await checkItem(bytes, spec ? { spec } : {});
  if (errorsOf(problems).length) refuse(`"${e.name}"`, problems);
  return { bytes, name: e.name, problems };
}

/**
 * A copy of the character for someone else (EXP-2). opts:
 *   spec          spec.vrm (to draw avatar.vrm again when a worn piece is taken off)
 *   newIdentity   true: a new `id` and `fileId`, a new character to every app (CHR-4, §4.1); false: the same `id` and a
 *                 new `fileId`, another file of the same character
 *   drawThumbnail async (avatarVrmBytes, copy) → PNG bytes or null: draws the copy's thumbnail when worn pieces come
 *                 off. Default: this library's own drawing (./thumbnail.js), the same in Node and a browser. When it
 *                 gives nothing the copy has no thumbnail, never the old one, which shows what was left out.
 *   fitCache, now
 * → { bytes, bundle (the copy), report (shareReport), sameCharacter (true when the id was kept), notes, problems }
 */
export async function shareCopy(bundle, { spec = null, newIdentity = false, fitCache = undefined, now = nowIso(), idFactory = newUuid, drawThumbnail = null } = {}) {
  const report = shareReport(bundle);
  const copy = copyBundle(bundle);
  const notes = [...report.notes];
  // voices that may not be passed on (HON-2), and the clips only they used
  if (report.voices.length) {
    const gone = new Set(report.voices.map((v) => v.id));
    const doc = voicesOf(copy);
    const keep = doc.voices.filter((v) => !gone.has(v.id));
    const used = new Set(keep.flatMap((v) => (v.clips || []).map((c) => c.file)));
    for (const v of doc.voices) if (gone.has(v.id)) for (const c of v.clips || []) if (!used.has(c.file)) setEntry(copy, c.file, null);
    doc.voices = keep;
    if (gone.has(doc.default)) doc.default = keep[0]?.id ?? null;
    setDocument(copy, 'voices', keep.length ? doc : null);
    const data = databaseData(copy);
    if (data.persona && gone.has(data.persona.voice_id)) { data.persona = { ...data.persona, voice_id: doc.default }; await writeDatabase(copy, data); }
  }
  // items: files that may not be passed on leave the closet; worn pieces that may not be passed on changed come off
  let lookChanged = false;
  for (const it of report.items) { await removeItem(copy, it.id, { takeOff: true }); lookChanged ||= it.worn; }
  for (const it of report.changed) { await takeOffPiece(copy, it.id); lookChanged = true; }
  if (lookChanged) {
    if (!spec) throw new ExportError('taking a worn piece off in the copy needs spec.vrm to draw avatar.vrm again');
    await redrawAvatar(copy, { spec, fitCache });
    // the thumbnail too, from the copy's own avatar.vrm: the old one shows what may not be passed on (blocker 6)
    const avatar = copy.entries.get(copy.manifest.avatar?.file || 'avatar.vrm');
    let thumb = null;
    try { thumb = avatar ? await (drawThumbnail || drawThumbnailOf)(avatar, copy) : null; } catch { thumb = null; }
    if (thumb) {
      setEntry(copy, 'thumbnail.png', thumb);
      copy.manifest.thumbnail = 'thumbnail.png';
      notes.push('The copy\'s avatar.vrm and thumbnail were drawn again without what was taken off.');
    } else {
      if (copy.manifest.thumbnail) setEntry(copy, copy.manifest.thumbnail, null);
      copy.manifest.thumbnail = null;
      notes.push('The copy\'s avatar.vrm was drawn again without what was taken off. Its thumbnail couldn\'t be drawn, so the copy has none rather than the old one.');
    }
  }
  // clips whose licence block doesn't allow passing them on (§8.4)
  if (report.clipsOut?.length) {
    const { removeClip } = await import('../anim/motion.js');
    for (const c of report.clipsOut) {
      try { await removeClip(copy, c.sha256); } catch (e) { throw new ExportError(`the motion "${c.name}" may not be passed on and can't be left out of the copy: ${e.message}`); }
    }
  }
  // permissions never chosen and taken over from Spec are written as nothing allowed (LIC-3)
  const state = permissionsState(bundle, { baseMeta: specMetaOf(spec) });
  if (state === 'from-spec') {
    const m = avatarMeta(copy);
    delete m.thumbnailImage;
    setWholeMeta(copy, { ...m, ...RESTRICTED });
    notes.push('The permissions were never chosen and were Spec\'s: the copy says nothing is allowed (LIC-3). Choose them on Details.');
  } else if (state === 'from-file') notes.push('The permissions are the file\'s own, not confirmed here.');
  notes.push(...looserLines(looserThanPieces(avatarMeta(copy), piecesOf(copy))));
  // the person's answers to licence questions are theirs, not the copy's
  const data = databaseData(copy);
  const answered = Object.keys(data.settings).filter((k) => k.startsWith(HONOURED_PREFIX) || k.startsWith(TIGHTENED_PREFIX));
  if (answered.length) { for (const k of answered) delete data.settings[k]; await writeDatabase(copy, data); }
  // identity (§4.1)
  copy.manifest.fileId = idFactory();
  if (newIdentity) copy.manifest.id = idFactory();
  copy.manifest.updated = now;
  const sameCharacter = !newIdentity;
  notes.push(sameCharacter
    ? 'The copy keeps the character\'s id: an app that keys its data by character alone will treat the copy as the same character, with the same memories and progress. Give it a new identity to make it a character of its own.'
    : 'The copy has a new identity: every app treats it as a new character.');
  if (report.own) notes.push(report.own);
  if (report.clips.length) notes.push(`${report.clips.length} motion clip${report.clips.length === 1 ? ' goes' : 's go'} with the copy under ${report.clips.length === 1 ? 'its' : 'their'} own licence text, which this app shows but can't judge.`);
  const bytes = await writeBundle(copy);
  const problems = await checkBundle(bytes, spec ? { spec } : {});
  if (errorsOf(problems).length) refuse('The shared copy', problems);
  return { bytes, bundle: copy, report, sameCharacter, notes, problems, meta: avatarMeta(copy), permissions: state };
}
