// A VRM brought into the importer (PRD §8.1, IMP-1 to IMP-7, IMP-11): read as untrusted, converted from 0.x
// when it is one, never changed, and described as pieces with a first grouping and a proposed type for each.
//
// The grouping: VRoid-style material names first, as exported files carry them (`*_CLOTH` by part, `*_HAIR`,
//   the face, eye and skin parts), and for anything else the humanoid bones a piece weights (the
//   redirect-aware rule), bucketed by body region, with material names kept only as hints. A VRoid garment is
//   grouped by its part *and* its item number
//   (N00_007_01_Tops and N00_002_03_Tops are two garments); the face, eyes and body are pieces that are listed
//   but can never be grouped for import (IMP-5); each group is given a proposed type, slot and kind from
//   VRMXW §6 (IMP-7); nothing is extracted here.

import { checkModel } from '../checker.js';
import { parseGlb, buildGlb, readAccessor } from '../glb.js';
import { sha256 } from '../hash.js';
import { clone } from '../bytes.js';
import { humanoidOf, metaFromVrm } from '../item-writer.js';
import { ITEM_TYPES, META_ENUMS } from '../vocab.js';
import { RefusedError } from '../vrmxw.js';
import { isVrm0, convertVrm0 } from './vrm0.js';
import { parents } from '../math.js';

// ---- reading pieces -----------------------------------------------------------------------------------

const ROLE_KEYWORDS = [
  ['hair', /hair|maegami|kemomimi|bang|ponytail|twintail|ahoge/i],
  ['face', /face|eyelash|eyeline|brow|matsuge|mayu|mouth|tooth|teeth|tongue|kouzetsu/i],
  ['eye', /eye(?!lash|line)|iris|pupil|hitomi|highlight|shirome|hoshime/i],
  ['cloth', /cloth|tops|bottoms|onepiece|shoes|socks|inner|jacket|coat|pants|skirt|glove|costume|wear|dress|apron|choker|headdress|belt|boot|accessory|ribbon|hat|cap/i],
  ['skin', /body|skin|hada|karada/i],
];
const NEVER = new Set(['skin', 'face', 'eye']);

/** The VRoid material taxonomy: "N00_007_01_Tops_01_CLOTH_02" → { kind: 'CLOTH', part: 'Tops', item: '007_01' }. */
export function vroidName(name = '') {
  const clean = name.replace(/\s*\(Instance\)/gi, '').trim();
  const m = clean.match(/^(?:[FMN]00_)?(\d{3})_(?:(\d{2})_)?([A-Za-z]+)_(\d{2})_(CLOTH|HAIR|SKIN|FACE|EYE)(?:_(\d+))?/);
  if (m) return { kind: m[5], part: m[3], item: m[2] ? `${m[1]}_${m[2]}` : m[1], piece: m[6] ? Number(m[6]) : null };
  const k = clean.toUpperCase().match(/_(CLOTH|HAIR|SKIN|FACE|EYE)\b/);
  if (!k) return null;
  const toks = clean.split('_').filter(Boolean);
  const i = toks.map((t) => t.toUpperCase()).indexOf(k[1]);
  let part = null;
  for (let j = i - 1; j >= 0; j--) if (!/^\d+$/.test(toks[j])) { part = toks[j]; break; }
  return { kind: k[1], part, item: null, piece: null };
}

const HUMAN_REGION = [[/eye|jaw|head|neck/i, 'head'], [/hips|spine|chest/i, 'torso'], [/shoulder|arm|hand|thumb|index|middle|ring|little/i, 'arm'], [/foot|toes/i, 'foot'], [/leg/i, 'leg']];
export const regionOf = (bone) => (HUMAN_REGION.find(([re]) => re.test(bone || ''))?.[1]) || 'other';

const HINT_STOP = new Set(['material', 'lambert', 'blinn', 'phong', 'mat', 'mtoon', 'instance', 'front', 'back', 'side', 'fabric', 'color', 'colour', 'col', 'tex', 'texture', 'default', 'standard', 'base', 'new', 'surface', 'shader', 'main', 'obj', 'mesh', 'group', 'layer', 'copy', 'cloth']);
/** A word from a material name worth showing (SheepHorn, MagicBook); null for pipeline noise (Material.001, lambert2). */
export function nameHint(name, skip = null) {
  for (const tok of (name || '').replace(/\(Instance\)/gi, ' ').split(/[^A-Za-z0-9]+/)) {
    if (!/^[A-Za-z]{3,}$/.test(tok) || HINT_STOP.has(tok.toLowerCase()) || /^[FMN]00$/.test(tok) || (skip && tok === skip)) continue;
    return tok.slice(0, 24);
  }
  return null;
}

function pieceRole(matName, meshName, hasTargets, vroid) {
  if (vroid) {
    if (vroid.kind === 'CLOTH') return 'cloth';
    if (vroid.kind === 'HAIR') return 'hair';
    if (vroid.kind === 'FACE') return 'face';
    if (vroid.kind === 'EYE') return 'eye';
    if (vroid.kind === 'SKIN') return hasTargets ? 'face' : 'skin';
  }
  for (const [role, re] of ROLE_KEYWORDS) if (re.test(matName)) return role === 'face' && !hasTargets ? 'other' : role;
  for (const [role, re] of ROLE_KEYWORDS) if (re.test(meshName)) return role === 'face' && !hasTargets ? 'other' : role;
  return 'other';
}

/** Every primitive of the model as a piece: its material, size, the bones it weights and what it seems to be. */
export function readPieces(json, bin) {
  const human = humanoidOf(json);
  const pOf = parents(json.nodes || []);
  const boneOfNode = human?.boneOfNode || new Map();
  const springNodes = new Set((json.extensions?.VRMC_springBone?.springs || []).flatMap((s) => (s.joints || []).map((j) => j.node)));
  const nearest = new Map();
  const humanAncestor = (n) => {
    if (nearest.has(n)) return nearest.get(n);
    let out = null;
    for (let c = n, k = 0; c !== undefined && k < 512; c = pOf.get(c), k++) if (boneOfNode.has(c)) { out = boneOfNode.get(c); break; }
    nearest.set(n, out);
    return out;
  };
  const cache = new Map();
  const read = (ai) => { if (!cache.has(ai)) cache.set(ai, readAccessor(json, bin, ai)); return cache.get(ai); };
  const pieces = [];
  (json.meshes || []).forEach((mesh, mi) => {
    const holder = (json.nodes || []).findIndex((n) => n.mesh === mi);
    const under = holder >= 0 ? humanAncestor(holder) : null; // the bone an unskinned mesh hangs from
    const skin = holder >= 0 && json.nodes[holder].skin !== undefined ? json.skins[json.nodes[holder].skin] : null;
    const hasTargets = (mesh.primitives || []).some((p) => p.targets?.length);
    (mesh.primitives || []).forEach((p, pi) => {
      const mat = p.material !== undefined ? json.materials?.[p.material]?.name || '' : '';
      const vroid = vroidName(mat);
      const idx = p.indices !== undefined ? read(p.indices) : null;
      const tris = idx ? Math.floor(idx.length / 3) : Math.floor((json.accessors[p.attributes.POSITION]?.count || 0) / 3);
      const bones = new Map();
      const springNames = new Set();
      if (skin && p.attributes?.JOINTS_0 !== undefined && p.attributes?.WEIGHTS_0 !== undefined) {
        const J = read(p.attributes.JOINTS_0), W = read(p.attributes.WEIGHTS_0);
        const used = idx ? new Set(idx) : null;
        const n = J.length / 4;
        for (let v = 0; v < n; v++) {
          if (used && !used.has(v)) continue;
          for (let k = 0; k < 4; k++) {
            const w = W[v * 4 + k];
            if (!(w > 0.05)) continue;
            const node = skin.joints[J[v * 4 + k]];
            if (node === undefined) continue;
            if (springNodes.has(node)) springNames.add(json.nodes[node]?.name || `node ${node}`);
            const b = humanAncestor(node);
            if (b) bones.set(b, (bones.get(b) || 0) + w);
          }
        }
      }
      // the piece's height range, from the vertices it uses (positions are in bind space for a skinned mesh)
      let minY = Infinity, maxY = -Infinity;
      const pos = read(p.attributes.POSITION);
      if (idx) for (const v of idx) { const y = pos[v * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
      else for (let v = 1; v < pos.length; v += 3) { if (pos[v] < minY) minY = pos[v]; if (pos[v] > maxY) maxY = pos[v]; }
      const role = pieceRole(mat, mesh.name || '', hasTargets, vroid);
      pieces.push({
        id: `${mi}/${pi}`, mesh: mi, prim: pi, material: mat, meshName: mesh.name || '',
        label: pieceLabel(mat, vroid, mesh.name, mi, pi), tris, skinned: !!skin, morphs: !!p.targets?.length,
        bones: [...bones.entries()].sort((a, b) => b[1] - a[1]).map(([b]) => b),
        weights: Object.fromEntries([...bones.entries()].map(([b, w]) => [b, Math.round(w * 10) / 10])), springs: springNames.size > 0, springNames: [...springNames].slice(0, 64),
        role, vroid, never: NEVER.has(role), minY: round(minY), maxY: round(maxY), under: skin ? null : under,
      });
    });
  });
  return pieces;
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

function pieceLabel(mat, vroid, meshName, mi, pi) {
  if (vroid?.part) return `${spaced(vroid.part)}${vroid.piece ? ` ${vroid.piece}` : ''}`;
  return nameHint(mat) || nameHint(meshName) || mat.replace(/\s*\(Instance\)/gi, '').slice(0, 32) || `Mesh ${mi}.${pi}`;
}
const spaced = (s) => s.replace(/([a-z])([A-Z])/g, '$1 $2');

/**
 * The donor body's own secondary bones: the non-humanoid joints the body's skin leans on (VRoid's bust, any other
 * soft-body bone). An item folds their weight into the humanoid ancestor instead of carrying them as its own chain
 * (VRMXW §5.3 rule 3; SPEC-QUESTIONS #41). → [node indices]
 */
export function bodySecondaryBones(json, bin, pieces) {
  const human = humanoidOf(json);
  const humanoid = new Set(human?.boneOfNode.keys() || []);
  const out = new Set();
  for (const p of pieces) {
    if (p.role !== 'skin') continue;
    const prim = json.meshes[p.mesh].primitives[p.prim];
    const holder = (json.nodes || []).findIndex((n) => n.mesh === p.mesh);
    const skin = holder >= 0 && json.nodes[holder].skin !== undefined ? json.skins[json.nodes[holder].skin] : null;
    if (!skin || prim.attributes?.JOINTS_0 === undefined) continue;
    const J = readAccessor(json, bin, prim.attributes.JOINTS_0), W = readAccessor(json, bin, prim.attributes.WEIGHTS_0);
    // only the body's own vertices: VRoid merges the body and the clothes into one mesh, sharing one accessor
    const used = prim.indices !== undefined ? new Set(readAccessor(json, bin, prim.indices)) : null;
    for (let v = 0; v < J.length / 4; v++) {
      if (used && !used.has(v)) continue;
      for (let k = 0; k < 4; k++) {
        if (!(W[v * 4 + k] > 0.05)) continue;
        const node = skin.joints[J[v * 4 + k]];
        if (node !== undefined && !humanoid.has(node)) out.add(node);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---- proposing groups and types --------------------------------------------------------------------------

// VRoid's clothing parts → an item type (VRMXW §6)
const PART_TYPE = { tops: 'top', top: 'top', bottom: 'pants', shoe: 'shoes', hair: 'hair', bottoms: 'pants', onepiece: 'dress', shoes: 'shoes', socks: 'socks', inner: 'socks', gloves: 'gloves', glove: 'gloves', coat: 'coat', outer: 'coat', jacket: 'coat', skirt: 'skirt', pants: 'pants', hat: 'hat', headdress: 'hat', accessory: null };
const TYPE_NAMES = { bodyAccessory: 'Accessory', top: 'Top', pants: 'Trousers', skirt: 'Skirt', dress: 'Dress', coat: 'Coat', socks: 'Socks', shoes: 'Shoes', gloves: 'Gloves', hair: 'Hair', hat: 'Hat', glasses: 'Glasses', earrings: 'Earrings', necklace: 'Necklace', back: 'Back piece', belt: 'Belt', tail: 'Tail', charm: 'Charm', handR: 'Right-hand prop', handL: 'Left-hand prop' };
/** The type of an accessory that is skinned rather than pinned (VRMXW §6 `bodyAccessory`, SPEC-QUESTIONS #38). */
export const WORN_ACCESSORY = 'bodyAccessory';
export const typeName = (t) => TYPE_NAMES[t] || t;

// what a type must follow: a top the body, a dress the body and the legs, shoes the feet
function bonesAgree(type, regions, bones) {
  const torso = regions.has('torso'), leg = regions.has('leg'), foot = regions.has('foot');
  switch (type) {
    case 'top': case 'coat': return torso;
    case 'dress': return torso && leg;
    case 'pants': case 'skirt': return bones.has('hips') && leg;
    case 'shoes': return foot;
    case 'socks': return foot || leg;
    case 'gloves': return regions.has('arm');
    default: return true;
  }
}

const PIN_BY_BONE = { head: 'hat', neck: 'necklace', upperChest: 'necklace', chest: 'necklace', hips: 'belt', spine: 'belt', rightHand: 'handR', leftHand: 'handL' };

/**
 * What a group seems to be (IMP-7): { type, slot, kind, attach, why }. The person confirms it.
 * groupPieces: the pieces of the group; springBones: names of the spring joints they weight (for skirts).
 */
export function proposeType(groupPieces) {
  const springNames = groupPieces.flatMap((p) => p.springNames || []);
  const bones = new Set(groupPieces.flatMap((p) => p.bones));
  // a region counts when it carries a real share of the weight (a stocking's trace on the hips doesn't)
  const share = new Map();
  let total = 0;
  for (const p of groupPieces) for (const [b, w] of Object.entries(p.weights || Object.fromEntries(p.bones.map((x) => [x, 1])))) {
    const r = regionOf(b);
    if (r === 'other') continue;
    share.set(r, (share.get(r) || 0) + w);
    total += w;
  }
  const regions = new Map([...share].filter(([, w]) => w >= 0.08 * total));
  const parts = groupPieces.map((p) => p.vroid?.part?.toLowerCase()).filter(Boolean);
  const anySprings = groupPieces.some((p) => p.springs);
  let type = null, why = '';
  if (groupPieces.some((p) => p.role === 'hair')) { type = 'hair'; why = 'its material says hair'; }
  else if (parts.length) {
    const t = PART_TYPE[parts[0]];
    if (t) { type = t; why = `VRoid calls it ${spaced(groupPieces.find((p) => p.vroid?.part)?.vroid.part)}`; }
  }
  // VRoid's part names are not always what a garment is (Elena's "Onepiece" is a pair of stockings): the
  // bones it follows must agree, or the bones decide
  if (type && !bonesAgree(type, regions, bones)) { why = `VRoid calls it ${spaced(groupPieces.find((p) => p.vroid?.part)?.vroid.part || type)}, but it doesn't follow the bones a ${typeName(type).toLowerCase()} would`; type = null; }
  const legs = bones.has('leftUpperLeg') || bones.has('rightUpperLeg');
  if (type === 'top' && legs && bones.has('hips') && regions.has('leg') && springNames.some((n) => /skirt/i.test(n))) { type = 'dress'; why += ', and it has a skirt, so it is proposed as a one-piece'; }
  if (type === 'pants' && (springNames.some((n) => /skirt/i.test(n)) || (!bones.has('leftLowerLeg') && !bones.has('rightLowerLeg') && anySprings))) { type = 'skirt'; why += ', and it swings like a skirt'; }
  if (!type) {
    const only = (...rs) => [...regions.keys()].every((r) => rs.includes(r)) && regions.size > 0;
    const was = why ? `${why}; ` : '';
    if (only('foot', 'leg') && regions.has('foot')) { type = Math.min(...groupPieces.map((p) => p.minY ?? 1)) < 0.03 ? 'shoes' : 'socks'; why = `${was}it covers the feet`; }
    else if (only('arm') && [...bones].some((b) => /Hand|Thumb|Index|Middle|Ring|Little/.test(b))) { type = 'gloves'; why = 'it covers the hands'; }
    else if (regions.has('torso') && (regions.has('leg')) && regions.size >= 2 && bones.size >= 6) { type = 'dress'; why = 'it covers the body and the legs'; }
    else if (regions.has('torso') && bones.size >= 3 && !regions.has('leg')) { type = 'top'; why = 'it covers the body'; }
    else if (only('leg', 'torso') && regions.has('leg') && regions.has('torso')) { type = 'pants'; why = `${was}it covers the hips and the legs`; }
    else if (only('leg', 'foot')) { type = 'socks'; why = `${was}it covers the legs only`; }
  }
  if (!type && groupPieces.some((p) => !p.skinned)) {
    const bone = groupPieces.find((p) => p.under)?.under || null;
    if (bone) {
      const t = PIN_BY_BONE[bone] || (regionOf(bone) === 'head' ? 'hat' : 'charm');
      return { type: t, slot: 'accessory', kind: 'pin', attach: bone, why: `it is not skinned and hangs from the ${bone.replace(/([A-Z])/g, ' $1').toLowerCase()}, so it is pinned there` };
    }
    return { type: 'charm', slot: 'accessory', kind: 'pin', attach: 'hips', why: 'it is not skinned, so it can only be pinned: choose its bone' };
  }
  if (!type) {
    // an accessory: pinned to one bone when it is rigid there, else worn (skinned)
    const human = [...bones];
    if (human.length === 1 && !anySprings) {
      const bone = human[0];
      type = PIN_BY_BONE[bone] || (regionOf(bone) === 'head' ? 'hat' : 'charm');
      return { type, slot: 'accessory', kind: 'pin', attach: bone, why: `it follows one bone (${bone})` };
    }
    return { type: WORN_ACCESSORY, slot: 'accessory', kind: 'worn', attach: null, why: human.length ? `it follows ${human.length} bones${anySprings ? ' and swings' : ''}` : 'nothing else fits' };
  }
  const t = ITEM_TYPES[type];
  return { type, slot: t.slot, kind: t.kind, attach: t.kind === 'pin' ? t.bone : null, why };
}

/** The fit rule an item of this type takes (VRMXW §6, §7). */
export function fitFor(type) {
  return clone(ITEM_TYPES[type]?.fit || { method: 'bones' });
}

/**
 * The first grouping (IMP-6 starts from it): VRoid's taxonomy, then the bones. The face, eyes and body are
 * left out of every group (IMP-5). → [{ id, name, pieces: [ids], type, slot, kind, attach, layer, why }]
 */
export function proposeGroups(pieces, json) {
  void json;
  const groups = [];
  const byKey = new Map();
  const add = (key, name, piece) => {
    if (!byKey.has(key)) { const g = { key, name, pieces: [] }; byKey.set(key, g); groups.push(g); }
    byKey.get(key).pieces.push(piece);
  };
  const loose = [];
  for (const p of pieces) {
    if (p.never) continue;
    if (p.role === 'hair') add('hair', 'Hair', p);
    else if (p.role === 'cloth' && p.vroid) add(`cloth:${(p.vroid.part || 'piece').toLowerCase()}:${p.vroid.item || ''}`, spaced(p.vroid.part || 'Piece'), p);
    else loose.push(p);
  }
  // a first word every loose material shares ("Fixture_…", "Avatar_…") says nothing about the piece
  const firsts = new Set(loose.map((p) => (p.material.match(/^[A-Za-z]{3,}/) || [''])[0]));
  const skip = firsts.size === 1 && loose.length > 1 ? [...firsts][0] : null;
  // anything else: by the body region its bones cover, keeping a real name as a hint (detectItems' rescue)
  for (const p of loose) {
    if (!p.skinned) { // a prop: one group for each bone it hangs from and each name
      const hint = nameHint(p.material, skip) || nameHint(p.meshName, skip);
      add(`prop:${p.under || 'none'}:${(hint || '').toLowerCase()}`, hint ? spaced(hint) : p.under ? `On the ${p.under.replace(/([A-Z])/g, ' $1').toLowerCase()}` : 'Prop', p);
      continue;
    }
    const regions = new Map();
    for (const b of p.bones) { const r = regionOf(b); if (r !== 'other') regions.set(r, (regions.get(r) || 0) + 1); }
    const tier = p.bones.length >= 3 ? 'garment' : p.bones.length ? 'accessory' : 'prop';
    const region = regions.has('torso') && regions.size >= 2 && p.bones.length >= 6 ? 'full' : [...regions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'other';
    const hint = p.role === 'cloth' || tier === 'accessory' ? nameHint(p.material, skip) || nameHint(p.meshName, skip) : null;
    const key = tier === 'accessory' && hint ? `acc:${hint.toLowerCase()}` : `${tier}:${region}`;
    add(key, hint || REGION_NAME[region] || 'Piece', p);
  }
  // number repeated names (two VRoid tops become "Tops" and "Tops 2")
  const seen = new Map();
  for (const g of groups) {
    const n = (seen.get(g.name) || 0) + 1;
    seen.set(g.name, n);
    if (n > 1) g.name = `${g.name} ${n}`;
  }
  const out = groups.map((g, i) => {
    const proposal = proposeType(g.pieces);
    return { id: `g${i + 1}`, name: g.name, pieces: g.pieces.map((p) => p.id), ...proposal, layer: 0 };
  });
  // two tops: the larger is proposed as the coat worn over the other (one item per slot, VRMXA §7.2)
  // the source wears them all together, so a top worn with a one-piece is proposed as the coat over it
  const tops = out.filter((g) => g.type === 'top');
  if (tops.length && out.some((g) => g.type === 'dress')) {
    for (const g of tops) Object.assign(g, { type: 'coat', slot: 'outer', layer: 1, why: `${g.why}; worn over the one-piece, so proposed as a coat` });
  } else if (tops.length > 1) {
    const size = (g) => pieces.filter((p) => g.pieces.includes(p.id)).reduce((a, p) => a + p.tris, 0);
    tops.sort((a, b) => size(b) - size(a));
    Object.assign(tops[0], { type: 'coat', slot: 'outer', layer: 1, why: `${tops[0].why}; the larger of ${tops.length} tops, so proposed as the one worn over` });
  }
  return out;
}
const REGION_NAME = { head: 'Head piece', torso: 'Top', arm: 'Sleeves', leg: 'Legwear', foot: 'Footwear', full: 'Outfit', other: 'Piece' };

// ---- the source -----------------------------------------------------------------------------------------

/** What the maker allows, in plain words, from a VRM 1.0 meta (IMP-4 shows these before anything else). */
export function termsOf(meta = {}) {
  const mod = meta.modification || 'prohibited';
  const terms = [
    { key: 'modification', ok: mod !== 'prohibited', text: mod === 'allowModificationRedistribution' ? 'Changes allowed, and sharing the changed pieces' : mod === 'allowModification' ? 'Changes allowed, not sharing them' : 'No changes allowed' },
    { key: 'redistribution', ok: meta.allowRedistribution === true, text: meta.allowRedistribution === true ? 'Passing it on is allowed' : 'Passing it on is not allowed' },
    { key: 'commercial', ok: meta.commercialUsage === 'corporation' || meta.commercialUsage === 'personalProfit', text: meta.commercialUsage === 'corporation' ? 'Commercial use by a company' : meta.commercialUsage === 'personalProfit' ? 'Commercial use by a person' : 'Not for commercial use' },
    { key: 'credit', ok: meta.creditNotation === 'unnecessary', text: meta.creditNotation === 'unnecessary' ? 'No credit needed' : 'Credit the maker' },
  ];
  return { terms, allowsChanges: mod !== 'prohibited', allowsPassingOn: meta.allowRedistribution === true };
}

// for each permission, how strict each value is (higher is stricter)
const STRICT = {
  commercialUsage: { corporation: 0, personalProfit: 1, personalNonProfit: 2 },
  creditNotation: { unnecessary: 0, required: 1 },
  modification: { allowModificationRedistribution: 0, allowModification: 1, prohibited: 2 },
  avatarPermission: { everyone: 0, onlySeparatelyLicensedPerson: 1, onlyAuthor: 2 },
};
const FLAGS = ['allowRedistribution', 'allowExcessivelyViolentUsage', 'allowExcessivelySexualUsage', 'allowPoliticalOrReligiousUsage', 'allowAntisocialOrHateUsage'];

/** Two licence blocks combined, keeping the stricter of each permission (never weakening one: LIC-4). */
export function stricterMeta(a, b) {
  if (!b) return clone(a);
  const out = clone(a);
  for (const [k, rank] of Object.entries(STRICT)) {
    const va = a?.[k], vb = b[k];
    if (vb === undefined || !(vb in rank)) continue;
    if (va === undefined || !(va in rank) || rank[vb] > rank[va]) out[k] = vb;
  }
  for (const k of FLAGS) if (b[k] === false && out[k] !== false) out[k] = false;
  return out;
}

/**
 * A VRoid Hub listing (the API's model JSON, as the dataset keeps beside each file) → { url, marketplace, id,
 * terms } with the listing's licence in VRM 1.0's words. Returns null when it is not one.
 */
export function listingFromVroidHub(j) {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string') return null;
  const lic = j.license || {};
  const terms = {};
  if (lic.modification) terms.modification = lic.modification === 'allow' ? (lic.redistribution === 'allow' ? 'allowModificationRedistribution' : 'allowModification') : 'prohibited';
  if (lic.redistribution) terms.allowRedistribution = lic.redistribution === 'allow';
  if (lic.credit) terms.creditNotation = lic.credit === 'unnecessary' ? 'unnecessary' : 'required';
  if (lic.corporate_commercial_use === 'allow') terms.commercialUsage = 'corporation';
  else if (lic.personal_commercial_use === 'profit') terms.commercialUsage = 'personalProfit';
  else if (lic.personal_commercial_use) terms.commercialUsage = 'personalNonProfit';
  if (lic.sexual_expression) terms.allowExcessivelySexualUsage = lic.sexual_expression === 'allow';
  if (lic.violent_expression) terms.allowExcessivelyViolentUsage = lic.violent_expression === 'allow';
  const charId = j.character?.id;
  return {
    url: charId ? `https://hub.vroid.com/characters/${charId}/models/${j.id}` : `https://hub.vroid.com/models/${j.id}`,
    marketplace: 'VRoid Hub',
    id: j.id,
    terms,
    maker: j.character?.user?.name || null,
  };
}

/**
 * Open a VRM for the importer. The bytes are checked as untrusted (CHR-9) and never changed; a 0.x model is
 * converted to 1.0 on a copy (IMP-11). Throws RefusedError for a file that breaks a rule.
 *   opts: { fileName, listing ({ url, marketplace, id, terms? }) }
 * → { file, size, sha256, vrm: '0.x' | '1.0', conversion (notes) | null, json, bin, glb (the 1.0 model),
 *     title, meta (the licence block items will carry), terms, listing, pieces, groups (proposed) }
 */
export async function openSource(bytes, { fileName = 'model.vrm', listing = null, maxTextureSize } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const hash = await sha256(u8);
  const first = checkModel(u8, { kind: 'vrm', where: fileName, maxTextureSize });
  const errors = first.problems.filter((p) => p.severity === 'error' && p.code !== 'model.vrm0');
  if (errors.length) throw new RefusedError(fileName, first.problems);
  let { json, bin } = parseGlb(u8);
  let vrm = '1.0', conversion = null, glb = u8;
  if (isVrm0(json)) {
    const c = convertVrm0(json, bin, { name: fileName.replace(/\.[^.]+$/, '') });
    vrm = '0.x';
    conversion = { notes: c.notes, mtoon: c.mtoon, springs: c.springs };
    json = c.json; bin = c.bin;
    glb = buildGlb(json, bin);
    const again = checkModel(glb, { kind: 'vrm', where: `${fileName} (converted)`, maxTextureSize });
    if (again.problems.some((p) => p.severity === 'error')) throw new RefusedError(`${fileName} (converted to VRM 1.0)`, again.problems);
  }
  const human = humanoidOf(json);
  if (!human || human.nodeOfBone.hips === undefined) throw new RefusedError(fileName, [{ severity: 'error', where: fileName, code: 'import.no-humanoid', message: 'has no humanoid skeleton, so nothing in it can be fitted to Spec' }]);
  let meta = metaFromVrm(json) || { authors: ['unknown'], licenseUrl: '' };
  if (!Array.isArray(meta.authors) || !meta.authors.length) meta.authors = ['unknown'];
  for (const [k, vals] of Object.entries(META_ENUMS)) if (meta[k] !== undefined && !vals.includes(meta[k])) delete meta[k];
  if (listing?.terms) meta = stricterMeta(meta, listing.terms);
  // a 0.x file often names no author; the listing's publisher is the maker then (and the item says so)
  let makerFrom = 'file';
  if ((!meta.authors.length || meta.authors.every((a) => !a || a === 'unknown')) && listing?.maker) { meta.authors = [String(listing.maker)]; makerFrom = 'listing'; }
  const pieces = readPieces(json, bin);
  return {
    file: fileName, size: u8.length, sha256: hash, vrm, conversion, json, bin, glb,
    title: json.extensions?.VRMC_vrm?.meta?.name || fileName.replace(/\.[^.]+$/, ''),
    meta, makerFrom, ...termsOf(meta),
    listing: listing ? { url: listing.url ?? null, marketplace: listing.marketplace ?? null, id: listing.id ?? null } : null,
    pieces, groups: proposeGroups(pieces, json), bodyBones: bodySecondaryBones(json, bin, pieces),
  };
}
