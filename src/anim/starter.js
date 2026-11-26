// The starter clips (assets/motions/kimodo/: 30 .vrma converted from image-to-3dlab's presets, made with
// NVIDIA Kimodo; Apache-2.0 with its NOTICE): their records in clips.json turned into what a character's
// animations.json holds (VRMXA §8.4) and the hints the checker reads, and the sets they make.

/** clips.json's entry → { file, details (an animations.json clip record without file and sha256), hints }. */
export function starterRecord(entry, { listing = {} } = {}) {
  const loop = entry.passes?.loop;
  const details = {
    name: entry.label || entry.id,
    duration: entry.seconds ?? null,
    loops: !!entry.loop,
    rootMotion: entry.in_place ? 'inPlace' : 'travel',
    speed: null, // ground speed is not in the record (ISSUES.md M9): measured and recorded by a correction
    tracks: ['humanoid'],
    source: `${listing.source?.project || entry.source?.project || 'image-to-3dlab'} preset "${entry.id}", made with ${entry.made_with || 'NVIDIA Kimodo'} (assets/motions/kimodo)`,
    licence: entry.licence || listing.licence || null,
  };
  const hints = {};
  if (entry.speed && Math.abs(entry.speed - 1) > 1e-3 && !entry.passes?.speed_baked) hints.playbackRate = entry.speed;
  if (loop && loop.mode !== 'none' && loop.blend_frames) hints.loopBlend = { frames: loop.blend_frames, gapPercent: loop.seam_gap_percent };
  if (entry.in_place && entry.passes?.root_travel_removed_m) hints.travelRemoved = entry.passes.root_travel_removed_m;
  hints.id = entry.id;
  return { id: entry.id, file: entry.file, details, hints };
}

/**
 * The sets the starter clips make (VRMXA §8.2, §8.3): a default set filling the movement, posture,
 * gesture and emotion slots it has clips for, and two sets that follow what is worn (ANI-3): in heels
 * a lighter walk, and with fists up (gloves) a fighting stance. Clips are named by their starter id.
 */
export const STARTER_SETS = Object.freeze([
  {
    name: 'Default', default: true, priority: 0, requires: [],
    slots: {
      idle: [{ clip: 'idle', weight: 3 }, { clip: 'idle_restless', weight: 1 }],
      walk: [{ clip: 'walk' }], run: [{ clip: 'run_b' }], jump: [{ clip: 'jump' }],
      sit: [{ clip: 'sit_b' }], greet: [{ clip: 'wave_b' }], 'emote.happy': [{ clip: 'cheer' }],
      'x-xocialize.sprint': [{ clip: 'sprint' }], 'x-xocialize.sneak': [{ clip: 'sneak' }], 'x-xocialize.sneakLow': [{ clip: 'crouch_sneak' }],
      'x-xocialize.strafeLeft': [{ clip: 'strafe_left_b' }], 'x-xocialize.strafeRight': [{ clip: 'strafe_right' }],
      'x-xocialize.dance': [{ clip: 'dance', weight: 1 }, { clip: 'robot_dance', weight: 1 }],
      'x-xocialize.hit': [{ clip: 'hit_react' }], 'x-xocialize.fall': [{ clip: 'death' }, { clip: 'death_b' }, { clip: 'death_2' }, { clip: 'death_2_b' }],
      'x-xocialize.roll': [{ clip: 'roll' }], 'x-xocialize.zombie': [{ clip: 'zombie_walk' }],
    },
  },
  { name: 'In heels', default: false, priority: 10, requires: ['footwear:heels'], slots: { walk: [{ clip: 'walk_woman' }] } },
  {
    name: 'Fists up', default: false, priority: 10, requires: ['held:fists'],
    slots: { idle: [{ clip: 'fight_stance_b' }], use: [{ clip: 'punch', weight: 1 }, { clip: 'punch_b', weight: 1 }, { clip: 'one_two', weight: 1 }, { clip: 'punch_combo_b', weight: 1 }], 'x-xocialize.kick': [{ clip: 'kick' }] },
  },
]);
