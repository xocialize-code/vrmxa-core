// The reference library's own run of the conformance kit (PRD REF-2): every case of VRMXA_Specification/conformance/
// cases.json done with the library's functions (the same ones the app's buttons and the CLI call), each output written
// into <out>/<case id>/. Its summaries are the kit's expected results (scripts/make-conformance.mjs), and
// `vrmxa conformance <out>` compares any app's output with them.
//
//   await referenceOutputs(outDir, { spec: spec.vrm bytes, specRepo: the specification's folder }) → { cases: [ids] }

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGlb, readAccessor } from '../glb.js';
import { sha256 } from '../hash.js';
import { createBundle, readBundle, setDocument, writeBundle } from '../vrmxa.js';
import { checkBundle, checkItem } from '../checker.js';
import * as closet from '../closet/index.js';
import * as motion from '../anim/index.js';
import { bakeAvatar, measureEdits } from '../edit/index.js';
import { questionsBeforeWearing, tighteningFor, tightenPermissions, shareCopy, exportVrm } from '../character/index.js';
import { cardToPersona, setPersona } from '../persona/index.js';
import { standardBase } from '../vocab.js';

const json = (v) => new TextEncoder().encode(`${JSON.stringify(v, null, 2)}\n`);
const read = (p) => new Uint8Array(readFileSync(p));

/** Write the reference's output for every case of the kit into outDir. */
export async function referenceOutputs(outDir, { spec, specRepo, only = null }) {
  const kit = JSON.parse(readFileSync(join(specRepo, 'conformance/cases.json'), 'utf8'));
  const fixtures = join(specRepo, 'fixtures');
  const fullBytes = read(join(fixtures, 'characters/full.vrmxa'));
  const minimalBytes = read(join(fixtures, 'characters/minimal.vrmxa'));
  const open = (bytes) => readBundle(bytes, { spec });
  const done = [];
  const put = (id, name, bytes) => { mkdirSync(join(outDir, id), { recursive: true }); writeFileSync(join(outDir, id, name), bytes); };
  const idOf = (b, name) => closet.closetOf(b).items.find((i) => i.name === name)?.id;
  const run = {
    'reader-verdicts': async () => {
      const exp = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8'));
      const verdicts = {};
      for (const f of [...Object.keys(exp.valid), ...Object.keys(exp.invalid)].sort()) {
        const bytes = read(join(fixtures, f));
        const P = f.endsWith('.vrmxw') ? await checkItem(bytes, { spec }) : await checkBundle(bytes, { spec });
        verdicts[f] = P.some((p) => p.severity === 'error') ? 'refused' : 'opens';
      }
      put('reader-verdicts', 'verdicts.json', json(verdicts));
    },
    'edits-apply': async () => {
      const b = await open(fullBytes);
      put('edits-apply', 'avatar.vrm', bakeAvatar(spec, b.docs.edits).bytes);
    },
    measure: async () => {
      const b = await open(fullBytes);
      put('measure', 'measurements.json', json(await measureEdits(spec, b.docs.edits)));
    },
    'closet-operations': async () => {
      const b = await open(fullBytes);
      const o = { spec };
      const refused = [];
      const step = async (n, fn) => { try { await fn(); } catch (e) { if (e instanceof closet.ClosetError) refused.push(n); else throw e; } };
      await step(1, () => closet.putOn(b, idOf(b, 'Ribbon top'), o));
      await step(2, () => closet.setState(b, idOf(b, 'Short sword'), 'held', o));
      await step(3, () => closet.takeOff(b, idOf(b, 'Boots'), o));
      await step(4, () => closet.removeItem(b, idOf(b, 'Borrowed hat'), o));
      await step(5, () => closet.removeItem(b, idOf(b, 'Fitted trousers'), o));
      await step(6, () => closet.applyOutfit(b, closet.closetOf(b).outfits.find((x) => x.name === 'Adventurer').id, o));
      await step(7, () => closet.putOn(b, idOf(b, 'Staff'), o));
      await step(8, () => closet.saveOutfit(b, 'With the staff', o));
      await closet.redrawAvatar(b, { spec });
      put('closet-operations', 'result.vrmxa', await writeBundle(b));
      put('closet-operations', 'refused.json', json({ refused }));
    },
    'avatar-write': async () => {
      const b = await open(fullBytes);
      put('avatar-write', 'avatar.vrm', (await closet.drawAvatar(b, { spec })).bytes);
    },
    specfit: async () => {
      const c = kit.cases.find((x) => x.id === 'specfit');
      const top = read(join(fixtures, 'items/specfit-top.vrmxw'));
      const trousers = read(join(fixtures, 'items/specfit-trousers.vrmxw'));
      for (const body of c.bodies) {
        const b = createBundle({ avatar: spec, base: standardBase('human'), id: '00000000-0000-4000-8000-000000000001', fileId: '00000000-0000-4000-8000-000000000002', created: '2026-11-18T00:00:00.000Z' });
        setDocument(b, 'edits', { format: 'vrmxa-edits', version: 7, editor: 'conformance', madeOn: null, body: body.body });
        const ids = [(await closet.addItem(b, top, { spec })).id, (await closet.addItem(b, trousers, { spec })).id];
        for (const id of ids) await closet.putOn(b, id, { spec });
        const { bytes } = await closet.drawAvatar(b, { spec });
        const g = parseGlb(bytes);
        const out = {};
        for (const id of ids) {
          const pos = [];
          const seen = new Set();
          for (const n of g.json.nodes) {
            if (n.mesh === undefined || n.extras?.vrmxaFit?.item !== id) continue;
            for (const p of g.json.meshes[n.mesh].primitives) {
              const ai = p.attributes.POSITION;
              if (seen.has(ai)) continue;
              seen.add(ai);
              for (const v of readAccessor(g.json, g.bin, ai)) pos.push(Math.round(v * 1e7) / 1e7);
            }
          }
          out[id] = pos;
        }
        put('specfit', `${body.id}.json`, new TextEncoder().encode(`${JSON.stringify(out)}\n`));
      }
    },
    'licence-questions': async () => {
      const b = await open(fullBytes);
      const id = idOf(b, 'Borrowed hat');
      const qs = questionsBeforeWearing(b, [id]).filter((q) => q.term !== 'tighten');
      const e = closet.closetOf(b).items.find((i) => i.id === id);
      const t = tighteningFor(b, [{ id, name: e.name, meta: e.meta }]);
      const tightens = Object.fromEntries((t.changes || t).map((c) => [c.key, c.to]).sort(([a], [b2]) => a.localeCompare(b2)));
      put('licence-questions', 'questions.json', json({ ask: [{ item: e.name, terms: [...new Set(qs.map((q) => q.term))].sort() }], tightens }));
    },
    'licence-tighten': async () => {
      const b = await wearBorrowed(await open(fullBytes));
      put('licence-tighten', 'result.vrmxa', await writeBundle(b));
    },
    'share-copy': async () => {
      const b = await wearBorrowed(await open(fullBytes));
      // the copy's new fileId is fixed here, so the kit's expected results are repeatable
      put('share-copy', 'share.vrmxa', (await shareCopy(b, { spec, idFactory: () => '5ba4ec0b-6f2a-4c7e-9d1b-2f7e8c3a9d40', now: '2026-11-18T00:00:00.000Z' })).bytes);
      put('share-copy', 'share.vrm', (await exportVrm(b, { spec, forSharing: true })).bytes);
    },
    'clip-ground': async () => {
      const b = await open(fullBytes);
      const orig = b.docs.animations.clips.find((c) => c.name === 'Walk' && !c.derivedFrom);
      const rig = motion.rigFromVrm(spec, { label: 'Spec' });
      const figure = motion.figureOf(motion.withLift(rig, 0.02, 'Spec in 2 cm boots'));
      const r = await motion.correctClip(b, orig.sha256, [{ kind: 'ground', figure }], { rig });
      put('clip-ground', 'clip.vrma', b.entries.get(r.record.file));
      put('clip-ground', 'record.json', json(r.record));
    },
    'memory-rule': async () => {
      const b = await open(minimalBytes);
      const r = cardToPersona(read(join(specRepo, 'conformance/inputs/card-with-memory.json')));
      await setPersona(b, r.patch);
      put('memory-rule', 'result.vrmxa', await writeBundle(b));
    },
  };
  async function wearBorrowed(b) {
    const id = idOf(b, 'Borrowed hat');
    const e = closet.closetOf(b).items.find((i) => i.id === id);
    await closet.putOn(b, id, { spec });
    await tightenPermissions(b, [{ id, name: e.name, meta: e.meta }]);
    await closet.redrawAvatar(b, { spec });
    return b;
  }
  for (const c of kit.cases) {
    if (only && !only.includes(c.id)) continue;
    if (!run[c.id]) throw new Error(`the reference has no run for case ${c.id}`);
    await run[c.id]();
    done.push(c.id);
  }
  void sha256;
  return { cases: done };
}
