# @xocialize/vrmxa-core

The VRMXA reference library (PRD §21, phases 0 to 2; REF-1). Its file layer reads, writes
and checks **`.vrmxa` characters** (bundle version 5, and versions 2 to 4 brought forward) and
**`.vrmxw` items** (item format version 1). It is plain JavaScript that runs in a browser and in
Node, separate from the app's screens. A command-line tool runs it directly for agents (MCP-10).

Since phase 2 it also **applies the edit document** (`EDITS.md` version 7) to Spec: live in three.js,
and written into a VRM 1.0 (`avatar.vrm`), with the edited body measured (`src/edit/`, below).

Since phase 4 it **brings dressed VRMs in as items** (0.x converted on a copy, pieces grouped and classified, each
group moved onto Spec by its bones and written with the source's licence and origin: `src/import/`) and **edits
items** on the one writer, with states, tags, the licence block, revisions, and a plain model made wearable in four
steps (`src/item/`).

Since phase 3 it **runs the closet protocol** (`CLOSET.md` §5) and fits worn items, writing them into
`avatar.vrm` in their states, with their springs and colliders (`src/closet/`, below).

Since phase 5 it **fits tops, bottoms, one-pieces and coats by Spec-fit** (`FITTING.md` §5): each garment
vertex keeps its place around the body and its distance from the skin on any body made on the Body page or
measured from another file, in layer order, morph targets carried, with `FITTING.md` §8's checks as tests and
on the command line (`src/fit/`, below). The importer brings garments onto Spec the same way (§7). Shoes,
socks, gloves and accessories stay on their bones; hair on the head.

Since phase 6 it **brings motion in, checks and corrects clips, and builds animation sets** (VRMXA §8;
`src/anim/`, below): `.vrma` read and written as normalized pose data, `.bvh` and Mixamo `.fbx` converted, the
clip checker listing each problem with its numbers and its tool, corrections kept apart from the clip they
correct, sets and slots chosen by what is worn, and the operations on a character's bundle, checked before
they write.

Since phase 7 it **keeps who a character is and what may be done with it** (VRMXA §5.3, §9, §10, §11; `src/character/`,
`src/voice/`, `src/persona/`, below): the character's details edited in avatar.vrm's own meta and carried into every
avatar.vrm drawn after, a new character starting with nothing allowed, permissions never looser than the worn pieces
allow; whose each piece is and what it allows, the questions to ask before wearing one, credits; a plain VRM and a copy to
share that leave out what may not be passed on; voices with their clips, licences and recorded consent; the core persona,
character cards in and out, and no memory in a bundle, ever.

Status: 0.1.0, private, written 2026-11-16 against `VRMXA-base-draft.md` 0.26,
`VRMXW-base-draft.md` 0.10, `CLOSET.md` 0.4 and `EDITS.md` version 7; the closet (phase 3) against
`VRMXA-base-draft.md` 0.28, `VRMXW-base-draft.md` 0.11 and `CLOSET.md` 0.5; Spec-fit (phase 5, 2026-11-17)
against `FITTING.md` 0.2, `VRMXW-base-draft.md` 0.14, `CLOSET.md` 0.6 and `VRMXA-base-draft.md` 0.30.

## What was verified, and how

| Claim | How it was checked |
|---|---|
| The measurer reproduces `spec.measurements.json` exactly from `spec.vrm` (apart from `source`) | `test/measure.test.mjs`, in Node and in Chrome |
| Writing is repeatable: the same content gives the same bytes | every fixture regenerated and compared byte for byte (`test/fixtures.test.mjs`); a fresh `character.sqlite` gives the same SHA-256 in Node and in Chrome |
| Read then write gives the same bytes | every item and character fixture, packed and through the open form (`test/vrmxw.test.mjs`, `test/vrmxa.test.mjs`), and through `vrmxa unpack` then `vrmxa pack` (`test/cli.test.mjs`) |
| Toon materials, textures, springs and colliders survive the item writer | `test/item-writer.test.mjs` on items cut from a dressed Spec |
| Items' humanoid joints are bound where Spec binds them | the bind check against `spec.vrm` (`test/item-writer.test.mjs`, `test/checker.test.mjs`) |
| The checker refuses hostile files for the right reason and never throws | the hostile fixtures; 500 corrupted ZIPs, 300 corrupted models, 100 corrupted databases, 300 corrupted fixtures (`test/zip`, `glb`, `database`, `checker`) |
| It runs in a browser | `scripts/browser-check.html`: 17 checks, all passing in the app's built-in browser (Chrome 156), using the same modules and the Node-written fixtures |

The edit library (phase 2):

| Claim | How it was checked |
|---|---|
| The edit document keeps what it doesn't apply: unknown keys stay, values are clamped only when applied, a newer version is refused whole | `test/edit-document.test.mjs` |
| The edited body measures as FITTING.md §4.3 says: Height +1 gives a stature of 176.7 cm, Waist Size +1 a waist of 53.2 cm, no edits Spec's published measurements | `test/edit-bake.test.mjs` (measureEdits) |
| The body bake moves the head 12 % higher at Height +1, keeps every bone at scale 1 and the feet on the ground | `test/edit-bake.test.mjs` |
| The live view puts every humanoid bone where the bake writes it (within 0.1 mm) | `test/edit-live.test.mjs`, on Spec's skeleton as three.js objects |
| Face shapes move the face mesh; different iris colours split the iris per eye; the blush is painted at the cheek and nowhere else; colours multiply the materials | `test/edit-bake.test.mjs` |
| Drawn hair kept as a hair piece passes the item checker with the bind check against Spec; a merged piece brings its springs and colliders, its bones matched by humanoid role; the hair colour is Overlay per channel | `test/edit-bake.test.mjs` |
| A character saved with edits, a hair piece, `avatar.vrm` and measurements reads back with identical edits and no warning | `test/edit-bake.test.mjs`; the app's `tests/character.test.js` through the app's own store |
| The baked `avatar.vrm` loads in three-vrm and shows the edits | by eye, in the app (Chrome) and in the Mac app (WebKit), 2026-11-16 |
| `vrmxa edits`, `apply-edits` and `bake` | `test/edit-cli.test.mjs` |

The closet (phase 3):

| Claim | How it was checked |
|---|---|
| Every operation of `CLOSET.md` §5 keeps C1 to C5 and C7, and is all or nothing | `test/closet.test.mjs`: after each step the bundle is written and checked; refused steps leave it byte for byte as it was |
| An app that can't fit is refused the seven look-changing operations of §7 and allowed the rest | `test/closet.test.mjs` |
| A change that leaves the look alone keeps `avatar.vrm` current; one that changes it is reported stale until redrawn | `test/closet.test.mjs` |
| No change on Spec: a worn item in `avatar.vrm` is where its model puts it (under 1 µm) | `test/closet-fit.test.mjs` |
| Bones: a top rises with the chest at Height +1, a hat with the head; shoes raise every bone by their lift; states place a pinned item; fine-tuning is written into `avatar.vrm` and never into the item; inner layers first | `test/closet-fit.test.mjs` |
| The live view's fine-tuning equals the bake's | `test/closet-fit.test.mjs` (the formula on the marked centre against the baked vertices) |
| `full.vrmxa` redrawn: `avatar.of.closet` is the real hash, no stale warning; springs, colliders and licences carried | `test/closet-fit.test.mjs`; in three-vrm in a browser the saved ribbon swings up to 16.5 cm from rest |
| `vrmxa closet` runs each operation from the command line | `test/closet-cli.test.mjs` |

The importer and the item editor (phase 4):

| Claim | How it was checked |
|---|---|
| A donor in shoes: the lift is measured to 0.2 mm, every item lands where the flat donor's does (under 10 µm), shoes record it | `test/import.test.mjs`, on the dressed Spec raised 25 mm |
| Barefoot measuring (FITTING.md §11 q4): Spec raised 31.3 mm measures Spec's heights with `lengths.lift` 0.0313; a body standing on the floor keeps its heights; Spec unchanged | `test/measure.test.mjs` |
| A Spec-fitted garment takes the body's weights in `avatar.vrm` (bust bones included), the item file unchanged; with the stage's lowered arms the fuller bust stays inside the sample top (0.00 %, 4.61 % with its own weights) | `test/spec-fit-weights.test.mjs` |
| Every imported item is valid against Spec (bind matrices), keeps MToon and springs, carries the source's licence, file, hash and listing | `test/import.test.mjs`; Elena (5 items, 21 hair springs, lift 31.3 mm) and a VRoid 0.x dataset model when they are on the machine |
| A 0.x is converted on a copy: the file's bytes and hash unchanged, vertices back where the 1.0 original had them (under 1 µm), MToon, springs, thumbs | `test/import.test.mjs`, a 0.x made from the dressed Spec |
| Nothing comes in unseen; a change sends a group back to waiting; the body is never grouped; an import resumes only against its own file | `test/import.test.mjs` |
| The place in the model equals the formula the stage uses (under 10 µm) | `test/import.test.mjs` |
| `vrmxa import` lists, refuses to write without `--approve`, writes items, the import and its record, and puts them on a character | `test/import.test.mjs` |
| Item edits are checked and leave the item valid; a pinned item re-pinned stays where it was; saving is the next revision and refuses an invalid item | `test/item-edit.test.mjs` |
| Four steps: a plain cylinder is placed from Spec's hips to its shoulders (under 2 mm), bound mostly to the torso, valid; a hat pins to the head | `test/item-edit.test.mjs` |
| What the head carries is moved centre to centre and scaled by k, the bones unscaled, still bound where Spec binds | `test/import.test.mjs` |
| Imported items worn on Mira in the closet, in three-vrm | by eye in the app (Chrome), 2026-11-16 and 17: Elena, three chosen and eight random VRoid 0.x models from the dataset (32 items, all passing `--strict`) |

131 tests pass in Node 26 in about 10 seconds (58 for the file layer, 22 for the edit library, 26 for the closet,
24 for the importer, the item editor and the decisions of SPEC-QUESTIONS #37 to #45 (`test/decisions.test.mjs`); Elena and the dataset model are skipped on a machine without them). Not checked: Safari or WebKit (the Swift wrapper's web
view), Firefox, Node 20 (the declared minimum), files written by any other app.

## Using it

```js
import { readBundle, writeBundle, readItem, writeItem, checkBundle, checkItem } from '@xocialize/vrmxa-core';

const bundle = await readBundle(bytes);          // checked first; refused as a whole on any error
bundle.docs.closet;                              // the section documents, parsed
bundle.database?.persona;                        // character.sqlite's rows
const again = await writeBundle(bundle);         // same bytes when nothing changed

const problems = await checkItem(itemBytes);     // [{ severity, where, code, message }]
```

In a browser, tell it where sql.js's WebAssembly file is:

```js
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import { setSqlJsLoader } from '@xocialize/vrmxa-core';
setSqlJsLoader(() => initSqlJs({ locateFile: (f) => `/assets/${f}` }));
```

### API

**Characters** (`src/vrmxa.js`)

| Function | Does |
|---|---|
| `readBundle(input, opts)` | check, then read a bundle, packed (bytes) or open (`Map` of path → bytes). Throws `RefusedError` (with `.problems`) on any error. Versions 2 to 4 come back as version 5 (`bundle.upgradedFrom`) |
| `writeBundle(bundle, { avatarOf })` | pack it. Recomputes `files`; recomputes `avatar.of` only when `avatar.vrm` is known to be current (see below) |
| `bundleToEntries(bundle)` / `bundleFromEntries(map)` | the open form, as a `Map` |
| `createBundle({ avatar, base, thumbnail, … })` | a new character: new `id` and `fileId`, manifest laid out as §4 shows it |
| `setDocument(bundle, role, doc)` | put a section document in (`edits`, `measurements`, `eyes`, `mouth`, `skin`, `closet`, `animations`, `voices`), with its place in `sections`; `null` removes it. The layered editors' pictures go in `appearance/layers/` and `appearance/baked/` (`layerPath`, `bakedPath`; VRMXA §3.3, D37) |
| `setEntry(bundle, path, bytes)` | put any other file in (a picture, a clip, an item) |
| `setDatabase(bundle, data)` | write `character.sqlite` from `{ persona, examples, listing, settings }` |
| `setAvatar(bundle, bytes)` | replace `avatar.vrm`; marks it current; title and author follow its VRM metadata |
| `touchBundle(bundle)` | a save: next `revision`, `updated` now |
| `saveAsAnotherVersion(bundle)`, `newIdentity(bundle)` | CHR-4: a new `fileId`; or new `id` and `fileId` |
| `avatarOf(bundle)` | the hashes `avatar.vrm` would be made from now |

`avatar.of` says what `avatar.vrm` was made from. The library never reports a stale avatar as
current: `createBundle` and `setAvatar` mark the avatar current, changing `edits` or `closet` clears
that, and a bundle that is read keeps its `avatar.of` as it was. An app that changes `closet.json`
without changing the look (adding a spare) passes `avatarOf: 'recompute'` (§4).

**Items** (`src/vrmxw.js`, `src/item-writer.js`)

| Function | Does |
|---|---|
| `extractItemModel(vrm, { prims, kind, attach, bones })` | **the one item writer** (ITM-2): cut an item's `model.glb` out of a dressed VRM 1.0 by editing the glTF directly |
| `createItem({ model, name, type, rig, meta, … })` | a new item; slot, kind and fit default from the type (VRMXW §6) |
| `readItem(bytes)` / `writeItem(item)` | check and read; pack (same bytes when nothing changed) |
| `itemToEntries(item)` / `itemFromEntries(map)` | the open form |
| `touchItem(item)`, `duplicateItem(item)` | the next revision; a copy with a new `id` (ITM-10) |
| `closetEntryFor(item, { file })` | the item's entry in a closet (the copied fields, the model hash, no `fitting`) |
| `itemFromBareGlb(glb, { slot, type })` | bring in a bare GLB from the earlier tools (VRMXW §14) |
| `metaFromVrm(json)` | an item's licence block from the VRM it came from |

**Checking** (`src/checker.js`)

| Function | Checks |
|---|---|
| `checkBundle(input, opts)` | a `.vrmxa`, packed or open |
| `checkItem(input, opts)` | a `.vrmxw`, packed or open |
| `checkModel(bytes, { kind })` | one GLB: an avatar (`vrm`), an item model (`item`) or a clip (`clip`) |

Each returns `[{ severity, where, code, message }]` and never throws. `error` means refuse the file
as a whole (§3.5); `warning` is worth showing; `info` is a note. Options: `limits` (see
`DEFAULT_LIMITS`), `bases` (another list than the published one), `spec` (`spec.vrm`'s bytes, for
the bind check of items), `maxTextureSize` (8192).

**The edit library** (`@xocialize/vrmxa-core/edit`, `src/edit/`; DOM-free)

| Function | Does |
|---|---|
| `newEdits({ madeOn })` | an empty edit document, version 7 |
| `readEdits(doc)` | what to apply: known keys, clamped (§1), `{ edits, ignored, refused }`. A newer version is `refused`, never applied in part |
| `setEdit(doc, path, value)`, `setEdits(doc, changes)` | a new document with one (or several) edits changed; unknown keys kept; `null` removes. Paths: `body.<slider>`, `face.shapes.<key>`, `face.colors.<role>`, `face.bones.iris`, `face.headShape`, `face.morphs.<KEY>`, `hairDesign` |
| `editProblem(path, value)`, `editLabel(path)`, `changedPaths(a, b)` | check an edit (with the reason); a person's name for it (for undo lists); which paths differ |
| `editsForSave(doc, { editor, madeOn })`, `editsHash(doc)` | the document as a bundle stores it (version 7, no `items`); its SHA-256 as stored (for `avatar.of` and `measurements.of`) |
| `bakeAvatar(spec, doc, { hair, meta })` | Spec + the edits + a hair piece → a VRM 1.0 (`avatar.vrm`): hair merged and drawn hair added, face reshaped, iris split, body written into mesh and bones, blush and hair colour painted, colours and default face shapes set |
| `measureEdits(spec, doc)` | the edited body's `vrm-body-measurements`, with `of: { base, edits }` (VRMXA §6) |
| `mergeItemModel(json, bin, item, { humanBones, mark })` | a worn item's model into an avatar, springs and colliders carried |
| `hairDesignToItem(spec, design, { name, meta })` | drawn hair kept as a `.vrmxw` hair item, cut by the one item writer |
| `BODY_PARTS`, `FACE_PARTS`, `FACE_SHAPES`, `HEAD_SHAPES`, `HAIR_PARAMS`, … | the controls, their ranges and defaults |
| `decodePng`, `encodePng`, `paintBlush`, `overlayColour`, `hairStrandTexture` | pixels in plain JavaScript, the same in a browser and in Node (REF-10) |

**The live view** (`@xocialize/vrmxa-core/edit/three`, `src/edit/three/live.js`; needs `three` 0.187,
used unmodified): `createLiveEdits(vrm, { json, bin })` → `apply(readEdits(doc).edits)` changes only what
changed (bones and inverse bind matrices, face positions, morph weights, colours, textures, drawn hair
under the head bone), `step(dt)` sways drawn hair, `toHead(point)` for drawing strokes.

**The closet** (`@xocialize/vrmxa-core/closet`, `src/closet/`; DOM-free)

| Function | Does |
|---|---|
| `addItem(bundle, input, { source, spec })` | §5.1: a `.vrmxw` (or a bare GLB, packed first: CLO-2) into the closet as a spare, with its picture and the animations it brings |
| `putOn(bundle, id, { state })` → `{ removed }` | §5.2: the slot rules take off what it replaces (returned, so an app can offer it back); an item asking `spec-fit` records the method used in `fitting.method` (`spec-fit` for tops, bottoms, one-pieces and coats with the automatic fit on, else `bones`) |
| `takeOff`, `setState`, `changeHair` | §5.3, §5.4, §5.7 |
| `applyOutfit(bundle, id)` → `{ removed, added }`, `outfitStatus(closet)` | §5.5; which outfit the look came from and whether it changed (CLO-12) |
| `saveOutfit(bundle, name, { over })`, `makeOutfit`, `renameOutfit`, `duplicateOutfit`, `deleteOutfit` | §5.12 |
| `setFitting(bundle, id, fitting, { merge })` | §5.6: the character's fine-tuning, checked and clamped (`cleanFitting`) |
| `removeItem(bundle, id, { takeOff })`, `copyOut`, `updateItem` | §5.8 (its animations go with it), §5.9, §5.11 (fine-tuning kept) |
| `closetSnapshot`, `restoreCloset` | for an app's undo |
| `wornPieces(bundle, { adjust })`, `mergeWorn(spec, pieces)` | what the saved look wears, each piece prepared; Spec with them merged, for a live view |
| `drawAvatar(bundle, { spec })`, `redrawAvatar(bundle, { spec })` | `avatar.vrm` from the saved look: the edits, the hair and the worn items fitted, in layer order, lifted by the shoes, licences in `extras.vrmxaPieces` |
| `prepareItemModel(model, manifest, { state, adjust })`, `fitPositions`, `FIT_CONTROLS`, `liftOf`, `methodFor` | the fit's parts: a state applied, the fine-tuning's formula and controls, the shoes' lift, the method used |

Every operation takes `{ canFit: false }` for an app that can't fit (the look-changing ones are then
refused, `CLOSET.md` §3) and `{ redraw: { spec } }` to redraw `avatar.vrm` in the same step. A refusal is a
`ClosetError` with a `code` (`needs-fitting`, `worn`, `slot`, `no-state`, `wrong-base`, `duplicate`, …).
`createLiveEdits(…).fit({ id: adjust })` shows the fine-tuning live; `apply(edits, { lift })` the shoes' lift.

**Spec-fit** (`@xocialize/vrmxa-core/fit`, `src/fit/`; DOM-free; FITTING.md §5–§8, PRD FIT-2, FIT-4, FIT-5, FIT-7)

| Function | Does |
|---|---|
| `readSkin(json, bin)`, `measuredContext(body, { ref })`, `bodyContext(body, m, { ref })` | a body's fitting context: its skin (the measurer's vertices, with their weights), its measurements, and per segment a stack of cuts along it, the stations as anchors with three cuts between each two (SPEC-QUESTIONS #47); stations the measurer refuses are estimated from Spec's and flagged (§5.2); an A-pose is refused (§9) |
| `fitCoordinates(src, garment, rule)` | §5.1: per vertex and zone (s, θ, e), plus its distance from the source skin and the garment's welds, neighbours and hems. Computed, never stored (W4); cache it |
| `moveGarment(coords, src, tgt, garment, { bones, inner, covered })` | §5.3–§5.6: the move (fitted / relaxed ease, hem anchor, skirts), welds, smoothing of the displacement, clearance (by vertex and by triangle), layers, normals, morph targets → `{ pos, normals, targets, pushed, stats }` |
| `fitWorn(json, bin, items, { body, bones, lift }, { spec, cache })` | on a character: the merged model (`mergeWorn`), the shaped skeleton, the edited body measured, each Spec-fitted item fitted inner first, and given back in Spec's bind space so the bake or the live view's skinning puts it on the body |
| `fitMerged`, `applyFitResult` | the same written into a merged model, the fine-tuning applied after it (VRMXA §7.5): what `drawAvatar` does |
| `garmentOntoSpec(cut, moved, rig, donor, spec, fit)`, `donorContext` | §7: a garment from another body onto Spec (the importer's `groupModel`; `origin.fit: "spec-fit"`) |
| `skinCover`, `skinThrough`, `easeKept`, `hemsKept`, `checkWorn`, `sweepWorn` (`src/fit/checks.js`) | §8's checks: skin through cloth, ease RMS, hems (as Δs and in millimetres), on one body or every Body slider at −1 and +1 |
| `easeOf(coords)` | each vertex's ease on Spec, for the heat map (§10 step 2) |
| `bodyWeights(skin, skinWeights, fittedPos, garment)` (`src/fit/weights.js`) | §5.6, W27: the body's weights under each fitted vertex (nearest point of the fitted body's skin, bust bones included; the item's own bones keep theirs; cloth far from the skin blends toward its own, #62). `fitWorn` uses them for the bind-space positions and returns them with each accessor (`skin`); `applyFitResult` writes them into the garment's skin; `createLiveEdits(…).specFit` binds the live garment to them. The item file keeps its own |
| `checkWorn(…, { pose: RELAXED_POSE })`, `posedSkinning`, `skinPositions` | skin through cloth in a pose (the stage's lowered arms), with the body's weights and with the garment's own: `vrmxa fit … --pose relaxed [--own-weights]` |
| `fitVerdict(figures)`, `VERDICT` (`src/fit/verdict.js`); `sourceVerdicts(vrmBytes, spec)` (`src/import/verdicts.js`) | a garment's verdict: fits, fits with warnings, does not transfer well, with reasons and the figures (thresholds named in the file); every garment of a VRM judged from the file alone, deterministic, for a dataset survey |
| `suitability(vrmBytes, { spec })` (`src/import/suitability.js`) | is a VRM a good candidate for the closet: its version, rest pose (T or not), separate garments or clothes painted on, skin cut away under the clothes, proportions against Spec's, spring bones, licence and each garment's Spec-fit verdict, each with its reason, and a one-line verdict (good, partial, not suitable). Advice only, from the importer's own judgement; the Mac app's 3D Quick Look preview shows it |

Reshaping seam: `moveGarment(…, { shape })` and `fitWorn(…, { shape })` take multipliers on the target's radius and the
ease per place (segment, s, θ): where per-band girth, length or flare controls, or an automatic match, would plug in.

`createLiveEdits(…).specFit(result.accessors)` shows a fit on the live model (the fine-tuning on top);
`fileVertices(mesh)` maps a three.js geometry back to the file's vertices (three-vrm drops unused ones).
The choices this library made inside FITTING.md 0.2 are SPEC-QUESTIONS #47 to #61 (#47 to #60 decided in FITTING.md 0.3); #62 and #63 came from building #60 and #59.

**The importer** (`@xocialize/vrmxa-core/import`, `src/import/`; DOM-free)

| Function | Does |
|---|---|
| `openSource(bytes, { fileName, listing })` | check a VRM as untrusted, convert a 0.x on a copy, read its pieces and propose groups. → `{ file, sha256, vrm, conversion, json, bin, glb, meta, terms, allowsChanges, allowsPassingOn, listing, pieces, groups }`; `RefusedError` for a file that breaks a rule |
| `slotClashes(doc, { statuses })` | groups that can't all be worn together (VRMXA §7.2): said, never merged |
| `listingFromVroidHub(json)`, `stricterMeta(a, b)`, `termsOf(meta)` | a VRoid Hub listing in VRM's terms; the stricter of two licence blocks; the terms in plain words |
| `newImport(source)`, `resumeImport(doc, source)`, `importProblems` | the import document (IMP-12), checked against its own file |
| `movePieces`, `mergeGroups`, `splitGroup`, `renameGroup`, `classifyGroup`, `placeGroup`, `viewGroup`, `approveGroup`, `skipGroup`, `reopenGroup` | the person's decisions, each returning a new document; approve refuses an unseen group |
| `matchSourceHead(source, spec)`, `headEdits(head)`, `setHead` | the head shape matched on Spec, as edits |
| `importRigs(source, spec)`, `groupModel(source, group, rigs, { specFit })` | the rigs and the lift; a group's model cut, moved onto Spec by its bones, then (tops, bottoms, one-pieces, coats) by Spec-fit from the donor's measured body (`fit`: `spec-fit`, or `bones` with `fitWhy`), and placed |
| `groupItem`, `importApproved(doc, source, rigs, { spec })`, `importRecord(doc)` | the items written and checked; what came from where |
| `convertVrm0(json, bin)`, `turnAround`, `measureLift`, `moveOntoSpec`, `placeMatrix`, `cleanPlace` | the parts: 0.x to 1.0, the lift, the bones fit, the place |
| `refitFromSource(item, sourceBytes, spec)`, `refitProblem(manifest)` | W20: a garment brought in by its bones, its vertices taken back to the donor (the bones' move undone exactly) and brought onto Spec by Spec-fit; the item keeps its id, parts, states and weights and becomes its next revision with `origin.fit: "spec-fit"`. The importer's place, which the item doesn't record, isn't undone |

**The item editor** (`@xocialize/vrmxa-core/item`, `src/item/`; DOM-free). Every function takes an item and returns
a new one; `ItemEditError` with a `code` when an edit is refused.

| Function | Does |
|---|---|
| `itemMeshes`, `itemSprings`, `allTags` | what the editor lists |
| `setName`, `setWear({ type, slot, layer, fit, attach })`, `repin(item, bone)` | how it is worn (ITM-4) |
| `addState`, `updateState`, `removeState`, `moveState`, `stateMatrix`, `splitMesh`, `renameMesh` | states and the parts they show (ITM-5); `show` names parts by node name (#44) |
| `partsShown(item, state)`, `setPartShown(item, state, node, shown)` | which parts a state shows, by VRMXW §8's rule; one part shown or hidden in one state, every state's list rewritten |
| `setTags`, `setMeta`, `setListing`, `setOrigin` | tags, licence, where it was obtained, how it was made (ITM-7 to ITM-9) |
| `addClip`, `removeClip`, `setSets` | the motions it brings (ITM-6) |
| `setSpring` | a chain's stiffness, weight and drag |
| `saveItem(item, { spec })`, `duplicateAsNew`, `itemChanged` | the next revision, checked; a new item (ITM-10, ITM-12) |
| `plainModelInfo`, `autoPlace`, `bindToSpec`, `makeWearable`, `specLandmarks` | a plain model in four steps (ITM-3) |

**Lower levels**: `writeZip`, `scanZip`, `readZip`, `inflateEntry` (`src/zip.js`); `parseGlb`,
`buildGlb`, `readAccessor` (`src/glb.js`, bounds-checked); `readCharacterDb`, `writeCharacterDb`,
`openDatabase` (`src/database.js`); `measureVrm`, `measureBody` (`src/measure/`); `sha256`.

**Node only** (`@xocialize/vrmxa-core/node`): `readFolder`, `writeFolder` (the open form on disk;
links and open database journals refused; nothing written outside the folder), `findSpecDir`.

## Animation sets and clip correction (phase 6, `src/anim/`)

`@xocialize/vrmxa-core/anim`. Plain JavaScript, no three.js except to read FBX.

| File | What |
|---|---|
| `clip.js` | A `.vrma` read into a **dense clip**: every track sampled on whole frames, rotations turned into normalized pose data by the player's own rule (three-vrm-animation 3.5.5: `Wp · q · W⁻¹` with the nodes' rest world rotations; the hips' translation through its parent), expressions (X translation of their nodes) and gaze. `writeVrma` writes one back: the clip's own skeleton at identity rotations, LINEAR samplers, expression nodes, a lookAt node. Round trip ≤ 4e-7 |
| `rig.js` | The figure a clip plays on: every humanoid bone's T-pose place, the hips height a player scales the track by (`scaleHeight`), how far the figure is raised over it (`rootOffset`: the body's own ground lift and shoes, as the stage puts them above the hips). `rigFromVrm` (a player loading that VRM), `makeRig` (the stage's live figure), `withLift`. `poseAt` is forward kinematics on the normalized bones; sole points are the converter's (the floor point under the ankle or the toe joint in the T-pose, turning with the foot) |
| `analyse.js` | What both the checker and the corrections read: per frame soles, hips, facing (square to the hip line), standing (hips ≥ 65 % of their height); contact spans (a foot within 1 cm of the floor while she stands) and how far the weight-bearing point slides in each; the treadmill test (in-place feet moving together: ground speed); the seam (gap, and the wrap's second difference against the clip's 95th percentile); travel |
| `check.js` | **The clip checker** (ANI-13): feet under the floor, floor set for bare feet (each planted step on the figure as dressed), feet sliding, ground speed missing or off, travel in an in-place clip, the seam, facing at the first key and over a cycle, a playback rate only in the record. Each problem has its numbers and its tool (`{ kind, label, params }`); what is fine is listed too. Thresholds in `CHECK`. It finds `assets/motions/kimodo/ISSUES.md` M1–M9 (M3 partly and M4, M8 from the clip's record, which `starter.js` keeps as hints) |
| `correct.js` | **Corrections** (ANI-9 to ANI-12), each plain JSON, replayed onto the original in order: `trim`, `speed`, `turn`, `loop` (start frame or the frame facing ahead, a seam blend that matches the motion's speed at both ends), `ground` (hips set for the figure as dressed, then each planted step's foot put on the floor), `pinFoot` (on the floor or where it stands, eased, the leg solved, the knee keeping its plane and the foot its turn), `lockFeet` (every sliding step held by its weight-bearing point; a step across a loop's seam counts once), `travel` (`remove`, measuring ground speed; or `fromFeet`, travelling as the planted feet show), `groundSpeed`, `offset` (any bones or groups, fingers included, over the clip or a range, eased), `pose` (keyed offsets), `thin`, `expression`, `gaze`. Ops that solve on a figure carry it (`figureOf`) |
| `fix.js` | `suggestCorrections` (the tools for a check's problems, ordered so they don't undo each other) and `autoCorrect` (check, correct, check again) |
| `sets.js` | `activeSets`, `resolveSlots` (§8.3: highest priority, the character's own before an item's, then the one listed first, D34; the default last), `pickClip` (by weight) |
| `motion.js` | The operations on a bundle: `addClip`, `addStarterClips`, `setClipDetails`, `removeClip` (the removal rule of D34), `flattenClip`, `correctClip` (the original kept, the corrected clip played by the sets with `derivedFrom`, `edit`, `rate` and `groundedFor`, a brought set made the character's when its clip is corrected), `migrateCorrections`, `createSet`, `updateSet` (clears `from`, ANI-6), `setSlot`, `removeSet`, `equippedState`, `motionPlan`. Each checks the animations document with the checker's own rules (and C7) before writing; undo is `closetSnapshot` |
| `bring.js`, `bvh.js`, `fbx.js` | `importMotion`: `.vrma` as it is, `.bvh` by the vrm skill's converter (copied, its CLI left out), Mixamo `.fbx` by three's FBXLoader retargeted with `Wp · q · W⁻¹` |
| `starter.js` | The starter clips' records → `animations.json` details and checker hints; `STARTER_SETS` (Default; In heels, `footwear:heels`; Fists up, `held:fists`) |

**Corrected clips (VRMXA 0.31 §8.1, §8.4, D34).** A corrected clip is a clip of its own, played by the sets in its
original's place. Its record names the original (`derivedFrom`) and its edit document (`edit`:
`animations/edits/<its sha12>.json`, format `vrmxa-motion-edit` version 1, holding the list of corrections, each
with the figure it solved on). The original stays in `clips` while an edit document refers to it: removing an
original takes its corrected clips and their edit documents with it, and `flattenClip` (`vrmxa motion … keep-fixed`)
drops an edit document so the original may go alone, `derivedFrom` staying as where the clip came from. A clip's own
playback speed is `rate` (a slot's `rate` multiplies it; the speed correction with `bake` puts it into the keys and
sets it to 1). A clip grounded for a figure records `groundedFor: { base, lift, edits }` (the base's sha256, how far
the figure stands above its bare soles: its shoes' lift plus the body's own measured lift, `lengths.lift`, never its
hips over Spec's, since other legs are the edit document's part; the edit document's sha256 or null), which the checker compares with the
character as dressed. What a starter clip's record says that no field holds (a seam the converter blended, travel it
removed) stays on the original's record as `x-xocialize.hints`. Bundles written before 0.31 kept corrections in
`animations/x-xocialize.corrections.json`: `migrateCorrections` moves them into the fields, and every operation, the
CLI and the app's save call it first. The checker validates `rate`, `derivedFrom`, `edit` (the file exists, its format
and version, its original in `clips`) and `groundedFor`.

Measured (Node, M5 Max): checking all 30 starter clips 0.13 s; correcting all 30 with what the checker proposes
0.3 s (2–31 ms a clip). Every starter clip passes the checker after correction, on Spec and in 3.1 cm boots (test);
numbers before and after in `Docs/trials/motion-correction/REPORT.md`.

## Details, licences, voices and persona (phase 7)

Three modules, each exported on its own (`@xocialize/vrmxa-core/character`, `/voice`, `/persona`), each operation all or
nothing on a bundle read by `readBundle`, the rest of the bundle kept byte for byte (§2 rule 5).

**`src/character/`**
- `terms.js`: a licence block in VRM's terms read in plain words (`termsOf`, `licenceLine`), VRM's most restricted values
  (`RESTRICTED`, what an absent field means) and each permission's order from strict to loose (`rank`, `stricter`).
- `details.js`: `detailsOf` (avatar.vrm's `VRMC_vrm.meta`, the origin from character.sqlite's `listing`, whether the
  permissions were chosen, the limits, what is already looser); `setDetails` (edits the meta in the model's JSON, the binary
  chunk untouched; the manifest's title and author follow; refuses a permission looser than the base or a worn piece allows,
  naming it, §5.3); `setListing` (no price); `newCharacterMeta` (LIC-3: every permission at its strictest);
  `characterSnapshot` / `restoreCharacter` for undo; `permissionsState` / `effectiveMeta` (LIC-3: Spec's permissions never
  chosen count as nothing allowed; a file's own are kept); `tighteningFor` / `tightenPermissions` (VRMXA 0.32 §5.3, D35:
  a piece put on tightens what it doesn't allow, recorded per piece) and `looseningOffer` / `loosenPermissions` (offered
  after take-off, never done on its own); `partsOf` (the worn pieces, from the closet). `closet/avatar.js characterMeta` carries the details whole into every
  avatar.vrm drawn after (`bakeAvatar(…, { metaMode: 'replace' })`), so a save no longer goes back to Spec's meta.
- `honour.js`: `questionsBeforeWearing` / `termsToAsk` (HON-1: a piece whose maker doesn't allow changes or passing it on;
  absent terms are VRM's defaults; plus `tighteningQuestions`, what wearing it would tighten, told every time, D35), `answerSetting` (the answer kept as the setting `x-xocialize.honoured.<id>`),
  `credits` (HON-4), `shareReport` / `vrmShareReport` (HON-2: voices and item files that may not be passed on, worn pieces
  that may not be passed on changed), `licenceTable` (LIC-5).
- `export.js`: `exportVrm` (CHR-6: avatar.vrm for the person, drawn again without what may not be passed on for someone
  else), `exportItem` (EXP-3), `shareCopy` (EXP-2: a copy with a new `fileId`, and a new `id` on request, what may not be
  passed on left out and said, avatar.vrm and the thumbnail drawn again when a worn piece comes off, the person's licence
  answers dropped), `vrmLeavesOut` (EXP-5).
- `thumbnail.js`: `drawThumbnail(vrmBytes, { size })`, a character's thumbnail drawn from its avatar.vrm in plain
  JavaScript with no GPU, the same in Node and a browser: the stage's bust framing (`bustCamera`, `BUST`), base colour,
  textures (PNG), alpha modes, skin and morph weights at rest, MToon's lit and shade colours; no outlines or rim light.
  `shareCopy` uses it (or the caller's `drawThumbnail`); when it gives nothing, the copy has no thumbnail, never the old
  one. Each export is checked
  (`checkBundle`, `checkModel`, `checkItem`) and refused with the reasons when it fails (EXP-4).

**`src/voice/`**: `wav.js` reads WAV (PCM 8–32 bit, float) and FLAC's facts, writes 16-bit mono at the clip's own rate
(never resampled), `standardClip` (kept byte for byte when already standard), `clipWarnings` (3–20 s, 24 kHz). `voices.js`:
`addVoice`, `updateVoice`, `addClip`, `removeClip`, `setPrimaryClip`, `setDefaultVoice`, `removeVoice`, `voiceSummaries`.
A new voice's licence starts at the most restricted, every permission stated (VOI-4); a designed voice keeps model,
version, description, seed, words and params (VOI-3); a real person's voice is refused without recorded consent: who, that
they agreed, when, to what (HON-3). An imported voice keeps its `source`; a designed voice records `madeWith` (the models and their stated terms, no
local paths: VRMXA 0.32 §9.2, D35), and `credits` shows any notice or attribution. A clip's licence may be a block in
VRM's terms (`anim.clipLicenceProblem`; §8.4): honoured by `shareReport` and `credits`, text shown as it is.

**`src/persona/`**: `persona.js` (`personaOf`, `setPersona`, the exchange form `vrmxa-persona`): §10.1's fields only;
app-side fields (backstory, scenes, levels, framing) refused with where they belong (§10.2). `cards.js`: Character Card V1,
V2 and V3, JSON or PNG (`ccv3` preferred, `chara`), divided as §10.3 says; app-side fields returned apart and never written
(SPEC-QUESTIONS #72); `personaToCard` (V2 or V3) and `cardPng`. `memory.js`: the memory guard (§11), refusing keys that
name memory, chats or a person's facts, and conversation-shaped setting values.

CLI: `vrmxa details`, `licence`, `credits`, `export`, `share`, `voice`, `persona` (below). Tests: `character.test.mjs`,
`voice.test.mjs`, `persona.test.mjs` (with the memory test), `phase7-cli.test.mjs`. Samples for them and the hand test:
`scripts/make-phase7-samples.mjs` (the Borrowed hat, synthetic hums, a test card).

## The specification's schemas, test files and conformance kit (phase 8)

Since phase 8 the checker also checks every manifest, section document, persona row, motion edit document and
`extras.vrmxaPieces` against the specification's **JSON Schemas** (`VRMXA_Specification/schemas/`, 2020-12), and every
finding names the **rule** it breaks and the **section** that states it (`{ severity, where, code, rule, section,
message }`; `src/rules.js` for the library's own codes, the schemas' `x-rule` and `x-section` for theirs). A schema
finding that repeats a rule's finding at the same place is left out.

| Where | What |
|---|---|
| `src/schema/` | the schemas as one module (`schemas.js`, generated) and `checkDocument(doc, role)` |
| `src/spec/` | the specification's `tools/check/lib/*.js`, byte for byte: `validate.js` (the schema checker; browsers and Node), `check.js` and `zip.js` (the specification's own checker), `conformance.js` (the kit's runner) |
| `src/node/conformance.js` | the reference's own run of every case of the kit (`referenceOutputs`) |
| `src/node/spec-check.js` | the specification's checker over the published schemas, bases and spec.vrm (Node) |
| `scripts/sync-schemas.mjs` | copies `schemas/` and `tools/check/lib/` from the specification; `--check` fails when the copies differ |
| `scripts/make-spec-fixtures.mjs` | writes the specification's `fixtures/` (and `expected.json`), repeatably, from spec.vrm and generated art; the full character is built through the library's operations |
| `scripts/make-conformance.mjs` | writes the kit's `expected/` from the reference's own output |

The validator is `@cfworker/json-schema` 4.1.1 (MIT), pinned: it interprets schemas (no code generation), so it runs in
the app's page under a strict content security policy as well as in Node. Tests: `schema.test.mjs`,
`spec-fixtures.test.mjs` (the fixtures regenerated and compared with the specification's byte for byte; both checkers on
every one), `conformance.test.mjs` (the reference passes its own kit; broken outputs fail the case they break).

## What each module implements

| Module | Specification |
|---|---|
| `src/zip.js` | VRMXA §3.2 (ZIP rules), §3.5 entry names and sizes; VRMXW §3 "Repeatable" |
| `src/container.js` | VRMXA §3.1 (packed and open), §3.3 (layout order), §4 `files`; VRMXW §3 order |
| `src/glb.js` | §3.5 "Models": self-contained, accessors and views inside their buffer |
| `src/database.js` | §3.4, §3.5 "The database", §12 (schema 1, `application_id`, the four tables) |
| `src/vrmxa.js` | §1 (versions 2 to 4), §2 rules 4, 5 and 8, §4 (manifest, `avatar.of`), §4.1 (two identifiers), §5.2, §5.3 |
| `src/vrmxw.js` | VRMXW §3, §4, §9, §10, §11, §12 (the closet entry), §14 (bare GLBs) |
| `src/item-writer.js` | VRMXW §2, §5 (worn and pinned models, springs), §16 item 2 |
| `src/checker.js` | VRMXA §3.5, §4, §5.1 (bases, species), §6.1, §6.2, §7.4, §7.5, §8.4, §9.2, §9.3; VRMXW §13; CLOSET.md §2 (C1 to C5, C7, C8) |
| `src/measure/` | FITTING.md §4 (the measurer, brought in unchanged) |
| `src/edit/document.js` | EDITS.md §1 (reading rules, versions), §2, §3 (keys and ranges), §4 (the 17 sliders), §5 (`items` not written), §6 (limits) |
| `src/edit/body.js`, `face.js`, `headShape.js` | EDITS.md §3.3–3.6 and §4: landmarks, `deformPositions`, head shapes, `bakeBody` |
| `src/edit/pixels.js`, `png.js` | EDITS.md §3.2 (Overlay hair colour), §3.7 (the blush), §6 (the strand texture); PRD REF-10 |
| `src/edit/bake.js`, `merge.js`, `hairItem.js` | VRMXA §5.2 (`avatar.vrm`), §6 (hair pieces); EDITS.md §6 (drawn hair in the file) |
| `src/edit/measure.js` | VRMXA §6, FITTING.md §4.5 (`of`) |
| `src/edit/three/live.js` | PRD APP-6 (the same edits, live), CLO-7 (fine-tuning, live) |
| `src/closet/ops.js` | CLOSET.md §2 (C1 to C5, C7), §3, §5; VRMXA §7.2 (slots), §7.3, §7.4; VRMXW §9, §12 |
| `src/closet/fit.js`, `avatar.js` | CLOSET.md §4 (items 2 to 11); VRMXA §5.2, §7.5; VRMXW §7, §7.1, §8; FITTING.md §5.5 (layer order) |
| `src/fit/` | FITTING.md §4.1 (cuts), §5.1–§5.7, §7, §8, §9 (estimated stations, A-pose); VRMXW §7, §8.1 (morphs); CLOSET.md §4 items 3, 4, 7 |
| `src/import/vrm0.js` | VRMXA §13.1 (VRM 1.0 only; 0.x converted on the way in); PRD IMP-11 |
| `src/import/source.js`, `session.js` | VRMXW §6 (types), §11 (licence), §14 (bringing things in); PRD §8.1 |
| `src/import/onSpec.js` | VRMXW §5.3 rule 4, §7.1 (the lift); FITTING.md §7 (the bones' move, before Spec-fit); CLOSET.md §4 |
| `src/item/edit.js` | VRMXW §3 (revision, duplicate), §4, §5.4, §8, §9, §11, §13 |
| `src/item/wearable.js` | VRMXW §14, last row (four steps) |
| `src/anim/` | VRMXA 0.31 §8.1 (clips, corrected clips, the floor for one figure), §8.2 (sets, slots, weights, the default fills idle), §8.3 (tags, the equipped state, priority, brought sets, the one listed first), §8.4 (`animations.json`: `rate`, `derivedFrom`, `edit`, `groundedFor`), D34; VRMXW §9; CLOSET.md C7; VRMC_vrm_animation 1.0 |
| `src/vocab.js`, `src/data/bases.js` | VRM 1.0 bones and meta values; VRMXW §6 types; VRMXA §7.2 slots, §8.2 animation slots; `assets/spec/bases.json` |

The checker does not check C6 (that `avatar.vrm` shows the saved look: that needs the fitting
code), VRMXW §13's "No change on Spec" by wearing the item (it compares the bind matrices instead),
or the colours and ranges inside the edit document beyond `body`.

## Dependencies

| Package | Version | Why |
|---|---|---|
| `fflate` | 0.8.3 (exact) | deflate in plain JavaScript. The browser's `CompressionStream` was not used for writing: each browser and Node link their own zlib, so the same input is not guaranteed the same bytes. fflate gives the same bytes everywhere. 0.8.2 had an advisory (a zip64 loop in `unzipSync`, which this library doesn't call); 0.8.3 has none |
| `three` | 0.187.0, a peer dependency (optional) and a development one | only `edit/three` (the live view) uses it, as provided (REF-8) |
| `sql.js` | 1.15.2 (exact) | SQLite compiled to WebAssembly: one engine for browser and Node, with no file system and no extension loading, which suits a file from a stranger. 1.16.0 (six days old) was passed over for one a few weeks old. The WebAssembly file is 685 KB |
| `@modelcontextprotocol/sdk` | 1.32.2 (exact; VRMXG's pin) | `vrmxa mcp` only (`src/mcp/server.js`, Node). Nothing the page imports uses it |

Nothing else for the library itself. Hashing is Web Crypto (`crypto.subtle`), present in browsers and in Node.

## The tool

```
node bin/vrmxa.mjs inspect  <file|folder>             what is in it
node bin/vrmxa.mjs validate <file|folder>             exit 0 when it passes, 1 when it doesn't
node bin/vrmxa.mjs pack     <folder> <out>            pack an open folder
node bin/vrmxa.mjs unpack   <file> <folder>           check, then unpack byte for byte
node bin/vrmxa.mjs upgrade  <old.vrmxa> <out.vrmxa>   bring version 2 to 4 forward
node bin/vrmxa.mjs measure  <model.vrm>               measure a body
node bin/vrmxa.mjs import   <model.vrm>               what the importer finds (terms, pieces, groups, lift, head)
node bin/vrmxa.mjs import   <model.vrm> <folder> --approve all|g1,g2 [--merge g5+g3] [--name g1=Name] [--type g2=coat] [--tags g3=footwear:heels]
                            [--skip g4] [--doc import.json] [--listing hub.json] [--into char.vrmxa --out out.vrmxa [--wear]]
node bin/vrmxa.mjs edits    <file.vrmxa>              the edit document: stored, applied, ignored
node bin/vrmxa.mjs apply-edits <file.vrmxa> <edits.json> <out.vrmxa>
                                                      set the edit document; write avatar.vrm and the measurements again
node bin/vrmxa.mjs bake     <file.vrmxa> <out.vrm>    Spec with the edits, the hair piece and the worn items, as a plain VRM 1.0
node bin/vrmxa.mjs fit      <model.vrm> [--json]        each garment's verdict: how it would transfer onto Spec (nothing written)
node bin/vrmxa.mjs fit      <file.vrmxa|item.vrmxw> [--body '{"bustSize":1}'] [--on char.vrmxa] [--sweep] [--out avatar.vrm]
                                                      Spec-fit what is worn to the body and print FITTING.md §8's checks;
                                                      --sweep: every Body slider at −1 and +1 (exit 1 when skin shows through)
node bin/vrmxa.mjs closet   <file.vrmxa>              the closet: items, what is worn, outfits
node bin/vrmxa.mjs closet   <file.vrmxa> <operation> … <out.vrmxa>
      add <item.vrmxw|model.glb> · put-on <item> [<state>] · take-off <item> · state <item> <state>
      fit <item> loose=… size=… up=… forward=… right=… auto=… ease=… · hair <item|none>
      outfit-apply <outfit> · outfit-save <name> · outfit-delete <outfit> · remove <item> [--take-off]
      update <item.vrmxw> · copy-out <item> <out.vrmxw> · refit <item> <source.vrm>   (<item>, <outfit>: an id or a name)
node bin/vrmxa.mjs clip     check <clip.vrma|.bvh|.fbx> [--loops true|false] [--in-place|--travel] [--lift <m>]
node bin/vrmxa.mjs clip     correct <clip> <out.vrma> --ops '[{"kind":"pinFoot",…}]' | --auto
node bin/vrmxa.mjs motion   <file.vrmxa>              clips (with corrections), sets, what each slot plays for what is worn
node bin/vrmxa.mjs motion   <file.vrmxa> check [<clip>|all] [--dressed]          exit 1 while something is to fix
node bin/vrmxa.mjs motion   <file.vrmxa> <operation> … <out.vrmxa>
      add <clip.vrma|.bvh|.fbx> [--name --loops --root --speed --licence --source] · starter [<kimodo folder>]
      details <clip> key=value… · remove <clip> · correct <clip|all> --ops '<json>' | --auto [--dressed]
      uncorrect <clip> · keep-fixed <clip> · set-new <name> [--requires a:b,c:d --priority N --default] · set <set> key=value…
      slot <set> <slot> <clip[*weight]>,…|- · set-remove <set>              (<clip>: a sha256, 12 digits of one, or a name)
node bin/vrmxa.mjs details  <file.vrmxa> [set key=value … <out.vrmxa>]   details, origin, permissions chosen, limits
      name= version= authors=A,B copyrightInformation= contactInformation= references=a,b licenseUrl= avatarPermission=
      commercialUsage= creditNotation= allowRedistribution=true modification= (usage flags) listing.url= listing.marketplace=
      listing.listing_id= ; key= (empty) removes an optional field
node bin/vrmxa.mjs licence  <file.vrmxa> [--items <item,…>]   whose each piece is, what it allows, what wearing would ask,
                                                      what a shared copy leaves out
node bin/vrmxa.mjs credits  <file.vrmxa>              the makers to credit
node bin/vrmxa.mjs export   <file.vrmxa> --vrm <out.vrm> [--share] | --item <item> <out.vrmxw>
node bin/vrmxa.mjs share    <file.vrmxa> <out.vrmxa> [--new-identity]
node bin/vrmxa.mjs voice    <file.vrmxa> [list|check]   voices, licences, consent, clips and their warnings
node bin/vrmxa.mjs voice    <file.vrmxa> import <clip.wav> --name N --transcript T [--language en] [--origin imported|recorded]
      [--style S] [--source S] [--real-person --speaker S --consent-date D --consent-scope S [--consent-record R]] <out.vrmxa>
node bin/vrmxa.mjs voice    <file.vrmxa> preset --engine kokoro-82m --preset af_heart [--name N] [--language en]
      [--meta key=value …] [--default] [--persona] <out.vrmxa>   a preset voice: the engine's own speaker, no clip (VRMXA §9,
                            D36); the engine id is the model's id in lower case; --persona names it as the persona's voice_id
node bin/vrmxa.mjs persona  <file.vrmxa> [show] | import <card.json|.png|persona.json> <out.vrmxa> [--app-fields <out.json>]
                            | export <out.json|.png> [--card-version v2|v3] [--app-fields <in.json>]
node bin/vrmxa.mjs fixtures [list|check] [--dir <fixtures>]   the specification's test files; check each behaves as expected.json says
node bin/vrmxa.mjs conformance <their-output-dir>     compare an app's output with the conformance kit, per case
node bin/vrmxa.mjs conformance run <out-dir> [--only id,id] · conformance cases
```

`apply-edits` and the closet operations keep the old thumbnail (no renderer; VRMXA §5.2). Since phase 3 they
fit the worn clothes into `avatar.vrm`, so `avatar.of.closet` is the real hash, never `null`.

Options: `--json` (one JSON object on stdout, for agents), `--spec <spec.vrm>` (found by itself when
the specification repository is beside this one), `--strict` (warnings fail too), `--force`.
Exit codes: 0 passed, 1 failed validation or refused, 2 bad usage or unreadable. `pack` and
`unpack` refuse to write a file that fails, and `unpack` never writes outside its folder. Text read
from a file (a persona, a name) is printed as the file's content.

## Tools for agents: `vrmxa mcp` (plan 0.2 A1–A3)

An MCP server over stdio (PRD MCP-1 as amended by AB-D-0266, MCP-10), modelled on VRMXG's (AB-R-1027):

```bash
claude mcp add vrmxa-studio -- node packages/vrmxa-core/bin/vrmxa.mjs mcp --app   # the running studio
node packages/vrmxa-core/bin/vrmxa.mjs mcp [<file.vrmxa>]                         # files, with the app closed
```

- **Seven generic tools**, the same for both targets: `status`, `read` (an area as data), `commands` (what `run` can
  call, by area, each with its kind; with `name`, its JSON Schema), `run`, `picture`, `undo`, `redo`. About 420 tokens
  of tool list for the app and 385 for files (budget: 10 tools, 2,000 tokens; `test/mcp.test.mjs` keeps it).
- **`--app`** listens on `127.0.0.1:5213` (`--port` to change it) and hands each call to the studio's page, which polls
  `POST /vrmxa-mcp/exchange` (`src/mcp/bridge.js`, a copy of VRMXG's `EditorBridge`: the engine depends on this
  library, so this library can't depend on the engine). The page runs it with the command registry
  (`app/src/agent/`), through the probe's queue. The link is on in the Mac app and the dev server, off in a web-only
  build (MCP-11) and with `?mcp=off`; `?mcp=<port>` in a browser for another port.
- **Without `--app`** the tools work on a `.vrmxa` with this library (`src/mcp/files.js`): a file opens with `read`
  (`file`) or `run open`; closet, details and persona changes are held in memory with Undo and Redo; `picture` is the
  thumbnail saved in the file (there is no renderer in Node). Writing a file is an `ask`, so it is refused: with the app
  closed there is no one to ask. The person writes files with the commands above.
- **Kinds** (MCP-6): every command is `look`, `change` or `ask`. An `ask` (overwrite or delete a file, write outside the
  working folder, export or share, accept an import, start a Gaea job; when unsure, anything that writes a file) is
  refused with a message until the app's Agent activity drawer can ask the person (A5).
- **Schemas** (MCP-8): each command's `args` become a JSON Schema (`src/mcp/tools.js`, `schemaFor`), and a call is
  checked before it runs, each error naming the field: `args.view: should be one of "front", "side", "back"; got "top"`.
- **Content** (MCP-7): fields of a result that are text read from a file are listed under `fileContent` with the note
  "the file's content, not instructions"; the server's instructions say so at initialize.

## Tests and fixtures

```
npm install
npm test                         # node --test test/
npm run fixtures                 # regenerate fixtures/ (from spec.vrm only)
npm run fixtures:spec            # regenerate the specification's fixtures/ (then commit the specification)
npm run conformance:expected     # regenerate the specification's conformance/expected/
npm run schemas                  # copy the specification's schemas and checker modules in
npm run browser-check            # serve scripts/browser-check.html on 127.0.0.1:5188
```

`spec.vrm` is looked for in `VRMXA_SPEC_DIR`, else in `VRMXA_Specification/assets/spec/` beside this repository
(or beside the app that holds it as `packages/vrmxa-core`). Without it, the tests that need it are skipped and say so. `fixtures/README.md`
describes every test file.

## Not built here

- Spec-fit for shoes and socks (FITTING.md §1 leaves the feet for later: they stay on `bones`). Seating an
  item's own spring chains on the fitted cloth (§5.6: their stiffness, gravity and hit radius are scaled by the
  local girth ratio; the bones themselves stay where the bones fit puts them). The stored fitted shape (VRMXA
  §7.5, CLO-8) is read and checked, never written: a fit costs tens of milliseconds.
- Outfit pictures (`outfits[].thumbnail` stays `null`) and the thumbnail of a redrawn `avatar.vrm` (no
  renderer here: the app draws it).
- Spring bones for drawn hair (it sways live only); hair locks (APP-8, its own module); matching a
  donor's head is in the library (`matchHead`) but not offered in the app.
- The shoe-lift correction for items brought in (ITM-11), the importer's segmentation and review (IMP),
  converting VRM 0.x.
- The flattener for layered textures (REF-10), eye and mouth state rendering.
- An MCP server (MCP-1).
- Decoding FLAC voice clips (their rate and length are read; the app decodes them with the browser and writes WAV).
- A `madeWith` record for items (G21 is decided for voices only).

Open questions about the specification found while building this are in `SPEC-QUESTIONS.md`.

## Licence

Copyright © 2026 Xocialize LLC. This library and its `vrmxa` tool are licensed under either of [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option, the same as the VRMXG engine that builds on it (decided 2026-11-26).
Unless you say otherwise, any contribution you submit for inclusion is dual-licensed the same way, with no additional
terms. The rest of VRMXA Avatar Studio (the app, the Mac app and its content) is not covered by this licence.

What keeps its own terms:
- **Spec in the test files.** The `.vrmxa` bundles under `fixtures/` carry the base figure `spec.vrm` (as
  `avatar.vrm`, or `body.vrm` in the legacy file). It is licensed under the
  [VRM Public License 1.0](https://vrm.dev/licenses/1.0/), with the permissions in its own `meta`; see
  `VRMXA_Specification/assets/spec/README.md`. The items' models in `fixtures/` are made by `scripts/` and are covered
  by this library's licence.
- **The starter clips** (`assets/motions/kimodo/`, 30 `.vrma`) are modified copies of image-to-3dlab's preset motions
  (Apache-2.0), made with NVIDIA Kimodo. They keep their own licence and notice:
  `assets/motions/kimodo/LICENSE-Apache-2.0.txt` and `NOTICE.md`.
- **The specification's schemas and base list** (`src/schema/schemas.js`, `src/data/bases.js`) are copies of
  `VRMXA_Specification` files licensed under CC-BY-4.0 (© Xocialize LLC). The copies here may be used under this
  library's licence.
- **Dependencies** keep their own licences (all MIT: `@cfworker/json-schema`, `@modelcontextprotocol/sdk`, `fflate`,
  `sql.js`, and the optional peer `three`).
