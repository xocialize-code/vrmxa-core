// Bringing motion in (PRD ANI-1): a .vrma as it is, a .bvh converted by the vrm skill's converter, a
// Mixamo .fbx retargeted (fbx.js). Each becomes .vrma bytes, a clip, details guessed from its keys, and a
// report of what was done (the BVH bone mapping and its warnings, for the person to read).

import { readVrma, writeVrma, isVrma } from './clip.js';
import { bvhToVrma } from './bvh.js';
import { readMixamoFbx } from './fbx.js';

/** 'vrma', 'bvh', 'fbx' or null, from the bytes (and the file name as a fallback). */
export function motionKind(bytes, fileName = '') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (isVrma(u8)) return 'vrma';
  const head = new TextDecoder().decode(u8.subarray(0, 64));
  if (/^\s*HIERARCHY/.test(head)) return 'bvh';
  if (head.startsWith('Kaydara FBX Binary') || /FBXHeaderExtension/.test(new TextDecoder().decode(u8.subarray(0, 2048)))) return 'fbx';
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  return ['vrma', 'bvh', 'fbx'].includes(ext) ? ext : null;
}

/**
 * → { kind, bytes (.vrma), clip, name, report: { source, converted, frames, fps, warnings, map } }
 * opts: { fps, bvh: options for bvhToVrma (tpose, map, inPlace, yaw, …) }
 */
export async function importMotion(input, fileName = 'motion', { fps = 30, bvh = {} } = {}) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = motionKind(u8, fileName);
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Motion';
  if (kind === 'vrma') {
    const clip = readVrma(u8, { name });
    return { kind, bytes: u8, clip, name: clip.name === 'Motion' ? name : clip.name, report: { source: fileName, converted: false, frames: clip.frames, fps: clip.fps, warnings: [] } };
  }
  if (kind === 'bvh') {
    const { glb, report } = bvhToVrma(new TextDecoder().decode(u8), { fps, ...bvh });
    const clip = readVrma(glb, { name });
    clip.name = name;
    const bytes = writeVrma(clip, { generator: 'VRMXA Avatar Studio (from BVH)', extras: { 'x-xocialize.source': { file: fileName, kind: 'bvh' } } });
    return { kind, bytes, clip, name, report: { source: fileName, converted: true, frames: clip.frames, fps: clip.fps, warnings: report?.warnings || [], map: report?.map || null } };
  }
  if (kind === 'fbx') {
    const clip = await readMixamoFbx(u8, { fps, name });
    const bytes = writeVrma(clip, { generator: 'VRMXA Avatar Studio (from Mixamo FBX)', extras: { 'x-xocialize.source': { file: fileName, kind: 'fbx' } } });
    return { kind, bytes, clip, name, report: { source: fileName, converted: true, frames: clip.frames, fps: clip.fps, warnings: Object.keys(clip.bones).length < 15 ? [`only ${Object.keys(clip.bones).length} bones were recognised as Mixamo's`] : [] } };
  }
  throw new Error(`${fileName} is not a motion this app reads (.vrma, .bvh or a Mixamo .fbx)`);
}
