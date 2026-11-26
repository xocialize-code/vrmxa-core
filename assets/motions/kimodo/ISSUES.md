# Known issues in the starter motion clips

Found while converting the 30 clips on 2026-11-16. They are kept here as the working list of what
the animation editor must be able to correct (PRD ANI-9 to ANI-13). Each issue names the clips it
affects, what was measured, and the editor tool that fixes it.

The numbers are from the converter's own checks on Spec's skeleton (`clips.json`, and
`tools/kimodo-to-vrma/README.md`). **Nothing has been watched on a skinned, dressed character yet,**
so issues that only show on the body or clothes are listed as not yet looked for (M12).

## The issues

| # | Issue | Clips | Measured | Fixed in the editor by |
|---|---|---|---|---|
| **M1** | **Feet under the floor while sitting or lying.** Spec's thigh is 3 cm shorter and its shin 4 cm longer than the source skeleton's at the same height, so bent legs end up too low. | `sit_b`, `death`, `death_b`, `death_2`, `death_2_b`, `roll` | Lowest sole: −9.5, −7.0, −10.1, −0.7, −11.8, −10.0 cm | Pinning a foot to the floor over a range, with the leg solved to reach it (ANI-10) |
| **M2** | **Feet slide.** The clip wanders and turns, but is marked in place, so its travel was removed and the feet skate. | `idle_restless` | 0.76 m of travel removed; the source turns about 57° | Pinning a foot where it stands while it carries weight (ANI-10); or keeping the travel (ANI-11) |
| **M3** | **The loop is eased, not natural.** The clip ends in another pose than it starts, so its last keys were blended back to the first pose. | `idle` (last 8 keys), `idle_restless` (last 14) | Gap between last and first pose before blending: 5.8 % and 13.6 % | Choosing the cycle and the length of the blend, and watching it wrap (ANI-11) |
| **M4** | **Rougher seams on the fast cycles.** | `run_b`, `sprint` | Seam gap 6.9 % and 9.7 % | The same loop tool (ANI-11) |
| **M5** | **The clip does not start facing straight ahead.** Cycles were cut mid-stride. | `sprint` 7.0°, `walk` −6.3°, `zombie_walk` −6.1°, `crouch_sneak` −5.1°, `sneak` −4.5°, the strafes ±8.8° | Facing at the first key | Turning the whole clip, and choosing which frame a loop starts on (ANI-11) |
| **M6** | **The strafes are turned.** The body faces about 13° off on average across the cycle. That is how the clip was generated. | `strafe_left_b`, `strafe_right` | Mean facing over the cycle | Turning the whole clip (ANI-11) |
| **M7** | **Floor contact was set against Spec's bare feet.** The hips were raised wherever Spec's soles would go below the floor. On another body, or with shoes, the height is wrong. | all 30; largest lifts `death_b` 5.9, `death` 5.1, `death_2_b` 3.5, `kick` 3.4 cm | Hip lift baked into the keys | Grounding again against the character as dressed, shoes included (ANI-10) |
| **M8** | **Playback speed is not in the clip.** The source plays these faster than they are stored. | `punch`, `punch_b` (1.3×), `one_two` (1.5×) | Recorded as `speed`, not baked | Changing a clip's speed, and trimming (ANI-11) |
| **M9** | **Ground speed is not recorded** for clips whose travel was removed. An app needs it to move the character at the pace of the feet (ANI-4). | the 12 in-place clips | `root_travel_removed_m` is the travel over the whole source clip, not over the cycle that was kept; no speed is stored | Measuring ground speed when travel is removed, and storing it (ANI-11) |
| **M10** | **Thumbs are slightly off.** Their direction was corrected to VRM's rest pose; their roll was not. | all | 5.1° and 7.2° from the source's direction | An offset on a bone across the whole clip (ANI-12) |
| **M11** | **Some bones sit at a constant angle to the source.** Spec's joints are placed differently, so the same rotations give a different line: shoulder 21.7°, upper chest to neck 15°, neck 10°, foot 8.7°. Not an error in the conversion, and it may look fine. | all | Constant per bone | Judged on the dressed character; an offset on a bone if it looks wrong (ANI-12) |
| **M12** | **Not yet looked for: arms or hands passing through the body or clothes.** The source's own pass that keeps arms clear was not carried over. | unknown | Not measured | Previewing on the character as dressed (ANI-5), then an offset over the range (ANI-12) |
| **M13** | **A key on every bone at every frame.** 52 bones at 30 keys a second cannot be edited by hand. | all | 22 to 211 keys per clip | Corrections kept as a layer over the clip; thinning the keys where a person wants to edit them (ANI-12) |
| **M14** | **No face.** There are no expression or gaze tracks. | all | None in the files | Adding expression and gaze tracks to a clip (ANI-7) |
| **M15** | **Fingers barely move,** and the small shift at the knuckles was lost (the source's extra finger joints have no VRM bone). | all | A few degrees | Posing fingers over a range (ANI-12) |

## Two meanings to keep straight

- **`loop` in `clips.json`** means "repeats without a jump": the last key is the first pose. It is
  true for four clips the source marked as not looping (`idle`, `idle_restless`, `sprint`,
  `zombie_walk`). The source's own flag is `source.preset_loop`.
- **In place** means the travel was taken out so an app moves the character. The vertical bob is kept.

## What a checker would have found by itself

M1 to M9 were all found by measuring: sole height, travel, the gap at the seam, facing at the first
key. That is the case for the editor checking a clip when it is brought in and listing its problems
with numbers (ANI-13).
