# Test files

Made by `scripts/make-fixtures.mjs` from `spec.vrm` only (the base in
`VRMXA_Specification/assets/spec/`). No one's own model is used. Running the script again gives
the same bytes; `test/fixtures.test.mjs` checks that.

```
node scripts/make-fixtures.mjs            # writes this folder
```

## Items (`items/`)

The items are cut by the item writer (`src/item-writer.js`) out of Spec "dressed" in generated
clothes (`scripts/lib/dress.mjs`). Every one is fitted to the standard Spec and passes the checker,
including the bind check against `spec.vrm`.

| File | Kind | What it shows |
|---|---|---|
| `skinned-top.vrmxw` | worn, `top` | a skinned shell 6 mm off the measured torso; an MToon material with a texture; a ribbon down the back on three bones of its own, with a spring and a collider on the spine; a thumbnail; a listing |
| `fitted-top.vrmxw`, `fitted-trousers.vrmxw` | worn, `top` / `pants` | Spec's own skin pushed out 4 / 5 mm, skinned as the skin is with the bust bones folded into the chest (VRMXW §5.3 rule 3): garments for trying Spec-fit; by the bones the top lets Bust Size +1 through (9.5 % of the skin it covers), by Spec-fit 0 %. Made by `scripts/lib/fitted.mjs` |
| `pinned-hat.vrmxw` | pin, `hat` on `head` | a skinned source mesh cut as a pinned item: unskinned, a child of the head bone |
| `state-sword.vrmxw` | pin, `handR` on `rightHand` | two states: `held` (right hand) and `stowed` (upper chest, with a matrix); state tags |
| `animated-staff.vrmxw` | pin, `handL` on `leftHand` | brings a clip (`.vrma`) and a set that requires its own tag; carries a vendor extension with a file |
| `state-parts.vrmxw` | worn, `top` | the top with its ribbon split out into a part named `Ribbon`; states `tied` and `no ribbon` name the parts they show (VRMXW §8; SPEC-QUESTIONS #44) |

`legacy/show-by-index.vrmxw` is the same item as written before #44, its states naming parts by node index: it
passes with a note (`item.show-index`) and is read with names.

## Characters (`characters/`)

| File | What it holds |
|---|---|
| `minimal.vrmxa` | the least a bundle needs: manifest, `avatar.vrm` (Spec named "Minimal"), thumbnail. No sections, no database |
| `full.vrmxa` | "Mira": edits, measurements, eyes (a fill layer, a mask, a baked iris, a `squint` state), mouth (`pout` as offsets, `scowl` as shapes), a closet with the top and the sword both worn (the sword stowed) and an outfit, an idle clip in the default set, a designed voice with a WAV clip, and `character.sqlite` with a persona, two examples, a listing and a setting |

**What `full.vrmxa` does not show.** Its `avatar.vrm` is Spec with the character's name, not the
edited body wearing the top and the sword: writing the edits and the worn items into the model
needs the fitting code, which is phase 3. So `avatar.of` names only the base, and the checker warns
that `avatar.vrm` may not show the character as described (`bundle.avatar-stale`). Its
`measurements.json` is Spec's own, marked `"of": { "edits": null }`, so a reader knows to measure
again. Both are true statements about the file; they are not faults in the library. Since phase 3 the library can
fit (`src/closet/`): `redrawAvatar` gives the same file an `avatar.vrm` with the top and the stowed sword
in it and no stale warning (`test/closet-fit.test.mjs`). The fixture itself is left as it was, so it still
tests a reader meeting a stale avatar.

## An earlier bundle (`legacy/`)

`v4.vrmxa` is written in the version 4 layout the earlier tools used: `body.vrm` (Spec),
`edits.json` with a fit for the item in `items`, a bare-GLB item with `asset.extras.rig` and
`provenance`, and a motion (document plus `.vrma`). Opening it brings it forward to version 5.

## Hostile files (`hostile/`)

Each must be refused for the reason listed in `expected.json` (the codes the checker reports).

| File | What is wrong |
|---|---|
| `control.vrmxa` | nothing: the same small bundle without the fault, to show the others fail for their fault alone |
| `path-escape.vrmxa` | an entry named `../escape.txt` |
| `lying-hash.vrmxa` | the manifest declares a SHA-256 for `avatar.vrm` that isn't its own |
| `huge-entry.vrmxa` | 300 MB of zeros packed into 300 KB; refused before it is unpacked |
| `broken-db.vrmxa` | half a `character.sqlite` |
| `db-trigger.vrmxa` | a database with a trigger, which schema 1 doesn't allow |
| `item-external.vrmxw` | an item whose model loads a picture from the web, plus an entry its manifest doesn't list |

The hostile bundles carry a 2 KB stand-in VRM (`scripts/lib/minivrm.mjs`) instead of an 11 MB
avatar: they test the container, not the model.

## Phase 7 samples (`scripts/make-phase7-samples.mjs`, run by `make-fixtures.mjs`)

| File | What it is |
|---|---|
| `items/borrowed-hat.vrmxw` | The pinned hat with a maker ("Another Maker") who allows no changes and no passing on: asked about before it is worn (HON-1), left out of a shared copy (HON-2) |
| `voice/hum-6s.wav`, `voice/hum-2s.wav` | Synthetic hums, 24 kHz 16-bit mono, made by the script: reference clips that are no one's voice; the 2 s one is under VOI-2's 3 s |
| `cards/mira-card.json` | A Character Card V2 with core fields, example messages and app-side fields (scenario, greetings, a lorebook, prompts) (PER-3) |
