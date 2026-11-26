# Notice: the Kimodo motion clips

The 30 `.vrma` files in this folder are **modified copies** of the preset motion clips of
image-to-3dlab (`image_to_3dlab/motions/`, version 0.5.10), converted on 2026-11-16.

## Where they come from

| | |
|---|---|
| Taken from | image-to-3dlab, <https://github.com/Bingeljell/image-to-3dlab>, Apache License 2.0 (copy in `LICENSE-Apache-2.0.txt`) |
| Made with | NVIDIA Kimodo, checkpoint `Kimodo-SOMA-RP-v1.1`, as each clip's record in `clips.json` states |
| Prompt, seed and take | kept per clip in `clips.json` |

## Notices carried from image-to-3dlab's NOTICE file

> image-to-3dlab
> Copyright 2026 Bingeljell and image-to-3dlab contributors
> https://github.com/Bingeljell/image-to-3dlab
>
> Licensed under the Apache License, Version 2.0 (see LICENSE).

> image_to_3dlab/motions/ holds animation clips made with NVIDIA Kimodo. Kimodo is
> licensed by NVIDIA Corporation under the NVIDIA Open Model License; NVIDIA claims
> no ownership of its outputs.

## What was changed

- Moved from NVIDIA's 77-joint SOMA skeleton onto VRM humanoid bones (52 bones, fingers included).
- Written as VRM Animation 1.0 (`.vrma`).
- Travel removed from the clips marked in place; looping clips trimmed or eased so they repeat.
- Hips raised where the soles of our base model, Spec, would go below the floor.

The converter is `tools/kimodo-to-vrma/`; `clips.json` records what was done to each clip.

## Credit line for an app that ships them

Some animations adapted from image-to-3dlab (https://github.com/Bingeljell/image-to-3dlab),
Apache-2.0, modified. Clips made with NVIDIA Kimodo, which is licensed by NVIDIA Corporation under
the NVIDIA Open Model License.

## What is not settled

That every clip was made with the checkpoint named is image-to-3dlab's own record; we did not make
them. The licence texts were read on 2026-11-16 (`Docs/REFERENCE-REPOS-REVIEW.md` §8). They do not
say who owns generated motion. This is a report of what the texts say, not legal advice.
