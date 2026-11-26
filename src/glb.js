// GLB (binary glTF 2.0) parse and build, and accessor reading, without trusting the file.
//
// Every length, offset and index is checked against the file before it is read (VRMXA §3.5, "Models"), so a hostile model
// gives an error instead of reading outside its buffer.

import { arrayBufferOf, asBytes, concat, utf8 } from './bytes.js';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const COMPONENT_ARRAYS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
export const NUM_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export class GltfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GltfError';
  }
}

/** True when the bytes start with the GLB magic ("glTF"). */
export function isGlb(bytes) {
  const u8 = asBytes(bytes);
  return u8.length >= 12 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46;
}

/**
 * Parse a GLB → { json, bin } (bin: a Uint8Array view of the BIN chunk, empty when there is none).
 * Throws GltfError on anything malformed.
 */
export function parseGlb(bytes) {
  const u8 = asBytes(bytes);
  if (u8.length < 20) throw new GltfError('not a GLB: too short');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC) throw new GltfError('not a GLB (no "glTF" magic)');
  if (dv.getUint32(4, true) !== 2) throw new GltfError(`GLB container version ${dv.getUint32(4, true)}; only version 2 is glTF 2.0`);
  const total = dv.getUint32(8, true);
  if (total !== u8.length) throw new GltfError(`the GLB header gives a length of ${total} bytes but the file has ${u8.length}`);
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new GltfError('the first GLB chunk is not JSON');
  if (20 + jsonLen > u8.length) throw new GltfError('the JSON chunk runs past the end of the file');
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(20, 20 + jsonLen)));
  } catch (err) {
    throw new GltfError(`the JSON chunk is not valid JSON (${err.message})`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new GltfError('the JSON chunk is not an object');
  let bin = new Uint8Array(0);
  let at = 20 + jsonLen;
  // chunks are 4-byte aligned; read the BIN chunk if present, skip unknown ones
  while (at + 8 <= u8.length) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    if (at + 8 + len > u8.length) throw new GltfError('a GLB chunk runs past the end of the file');
    if (type === CHUNK_BIN) {
      if (bin.length) throw new GltfError('the GLB has two BIN chunks');
      bin = u8.subarray(at + 8, at + 8 + len);
    }
    at += 8 + len;
  }
  return { json, bin };
}

/** Build a GLB from a glTF JSON object and its binary chunk. Deterministic. */
export function buildGlb(json, bin = new Uint8Array(0)) {
  let jsonBytes = utf8(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad);
    padded.set(jsonBytes);
    padded.fill(0x20, jsonBytes.length); // the JSON chunk pads with spaces
    jsonBytes = padded;
  }
  const hasBin = bin.length > 0;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + (hasBin ? 8 + bin.length + binPad : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  if (hasBin) {
    dv.setUint32(20 + jsonBytes.length, bin.length + binPad, true);
    dv.setUint32(24 + jsonBytes.length, CHUNK_BIN, true);
    out.set(bin, 28 + jsonBytes.length);
  }
  return out;
}

const isIndex = (v, arr) => Number.isInteger(v) && v >= 0 && Array.isArray(arr) && v < arr.length;

/**
 * The byte range of a bufferView inside the BIN chunk → { start, end, stride } (offsets into bin).
 * Throws GltfError when the view or its buffer is not inside this file.
 */
export function bufferViewRange(json, bin, bvi) {
  if (!isIndex(bvi, json.bufferViews)) throw new GltfError(`bufferView ${bvi} does not exist`);
  const bv = json.bufferViews[bvi];
  if (!isIndex(bv.buffer, json.buffers)) throw new GltfError(`bufferView ${bvi} names buffer ${bv.buffer}, which does not exist`);
  const buf = json.buffers[bv.buffer];
  if (bv.buffer !== 0 || buf.uri !== undefined) throw new GltfError(`bufferView ${bvi} is in a buffer outside the file`);
  const off = bv.byteOffset ?? 0;
  const len = bv.byteLength;
  if (!Number.isInteger(off) || off < 0 || !Number.isInteger(len) || len < 0) throw new GltfError(`bufferView ${bvi} has a bad offset or length`);
  if (!Number.isInteger(buf.byteLength) || buf.byteLength > bin.length) throw new GltfError(`buffer 0 claims ${buf.byteLength} bytes but the BIN chunk has ${bin.length}`);
  if (off + len > buf.byteLength) throw new GltfError(`bufferView ${bvi} runs past the end of its buffer`);
  const stride = bv.byteStride;
  if (stride !== undefined && (!Number.isInteger(stride) || stride < 4 || stride > 252 || stride % 4)) throw new GltfError(`bufferView ${bvi} has a bad byteStride`);
  return { start: off, end: off + len, stride };
}

/** Raw bytes of a bufferView (an embedded image, say). Checked. */
export function bufferViewBytes(json, bin, bvi) {
  const { start, end } = bufferViewRange(json, bin, bvi);
  return bin.subarray(start, end);
}

const DV_GET = {
  5120: (dv, o) => dv.getInt8(o),
  5121: (dv, o) => dv.getUint8(o),
  5122: (dv, o) => dv.getInt16(o, true),
  5123: (dv, o) => dv.getUint16(o, true),
  5125: (dv, o) => dv.getUint32(o, true),
  5126: (dv, o) => dv.getFloat32(o, true),
};

/** Check an accessor's shape and that it lies inside its buffer view. Throws GltfError. */
export function checkAccessor(json, bin, ai) {
  if (!isIndex(ai, json.accessors)) throw new GltfError(`accessor ${ai} does not exist`);
  const a = json.accessors[ai];
  const nc = NUM_COMPONENTS[a.type];
  const T = COMPONENT_ARRAYS[a.componentType];
  if (!nc) throw new GltfError(`accessor ${ai} has an unknown type "${a.type}"`);
  if (!T) throw new GltfError(`accessor ${ai} has an unknown componentType ${a.componentType}`);
  if (!Number.isInteger(a.count) || a.count < 0) throw new GltfError(`accessor ${ai} has a bad count`);
  const bpe = T.BYTES_PER_ELEMENT;
  if (a.bufferView !== undefined) {
    const { start, end, stride } = bufferViewRange(json, bin, a.bufferView);
    const off = a.byteOffset ?? 0;
    if (!Number.isInteger(off) || off < 0 || off % bpe) throw new GltfError(`accessor ${ai} has a bad byteOffset`);
    const elem = bpe * nc;
    const st = stride ?? elem;
    if (st < elem) throw new GltfError(`accessor ${ai}: its elements are wider than the view's stride`);
    const need = a.count === 0 ? 0 : off + st * (a.count - 1) + elem;
    if (start + need > end) throw new GltfError(`accessor ${ai} runs past the end of bufferView ${a.bufferView}`);
  }
  if (a.sparse) {
    const sp = a.sparse;
    if (!Number.isInteger(sp.count) || sp.count < 1 || sp.count > a.count) throw new GltfError(`accessor ${ai} has a bad sparse count`);
    const iT = COMPONENT_ARRAYS[sp.indices?.componentType];
    if (![5121, 5123, 5125].includes(sp.indices?.componentType)) throw new GltfError(`accessor ${ai} has bad sparse indices`);
    const ir = bufferViewRange(json, bin, sp.indices.bufferView);
    if (ir.start + (sp.indices.byteOffset ?? 0) + sp.count * iT.BYTES_PER_ELEMENT > ir.end) throw new GltfError(`accessor ${ai}: its sparse indices run past their view`);
    const vr = bufferViewRange(json, bin, sp.values?.bufferView);
    if (vr.start + (sp.values.byteOffset ?? 0) + sp.count * nc * bpe > vr.end) throw new GltfError(`accessor ${ai}: its sparse values run past their view`);
  }
  return a;
}

/**
 * Decode accessor `ai` to a flat typed array of length count × components. Handles byteStride,
 * unaligned offsets and sparse accessors. Checked: throws GltfError rather than reading outside.
 */
export function readAccessor(json, bin, ai) {
  const a = checkAccessor(json, bin, ai);
  const nc = NUM_COMPONENTS[a.type];
  const T = COMPONENT_ARRAYS[a.componentType];
  const bpe = T.BYTES_PER_ELEMENT;
  const out = new T(a.count * nc);
  if (a.bufferView !== undefined) {
    const { start, stride } = bufferViewRange(json, bin, a.bufferView);
    const base = bin.byteOffset + start + (a.byteOffset ?? 0);
    const st = stride ?? bpe * nc;
    if (st === bpe * nc && base % bpe === 0) {
      out.set(new T(bin.buffer, base, a.count * nc));
    } else {
      const dv = new DataView(bin.buffer);
      const get = DV_GET[a.componentType];
      for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) out[i * nc + c] = get(dv, base + i * st + c * bpe);
    }
  }
  if (a.sparse) {
    const sp = a.sparse;
    const dv = new DataView(bin.buffer);
    const ir = bufferViewRange(json, bin, sp.indices.bufferView);
    const vr = bufferViewRange(json, bin, sp.values.bufferView);
    const iBase = bin.byteOffset + ir.start + (sp.indices.byteOffset ?? 0);
    const vBase = bin.byteOffset + vr.start + (sp.values.byteOffset ?? 0);
    const iGet = DV_GET[sp.indices.componentType];
    const iBpe = COMPONENT_ARRAYS[sp.indices.componentType].BYTES_PER_ELEMENT;
    const vGet = DV_GET[a.componentType];
    for (let k = 0; k < sp.count; k++) {
      const idx = iGet(dv, iBase + k * iBpe);
      if (idx >= a.count) throw new GltfError(`accessor ${ai}: a sparse index is out of range`);
      for (let c = 0; c < nc; c++) out[idx * nc + c] = vGet(dv, vBase + (k * nc + c) * bpe);
    }
  }
  return out;
}

/**
 * Collects the binary chunk for a new GLB: push bytes, get a bufferView index back. Every view is
 * 4-byte aligned. Used by the item writer.
 */
export class BinWriter {
  constructor(json) {
    this.json = json;
    this.parts = [];
    this.length = 0;
    json.bufferViews = json.bufferViews || [];
    json.accessors = json.accessors || [];
  }

  view(bytes, target) {
    const u8 = asBytes(bytes);
    const off = this.length;
    this.parts.push(u8);
    this.length += u8.length;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const bv = { buffer: 0, byteOffset: off, byteLength: u8.length };
    if (target) bv.target = target;
    this.json.bufferViews.push(bv);
    return this.json.bufferViews.length - 1;
  }

  accessor(typed, componentType, type, { target, minmax = false, count } = {}) {
    const nc = NUM_COMPONENTS[type];
    const n = count ?? typed.length / nc;
    const bv = this.view(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), target);
    const a = { bufferView: bv, componentType, count: n, type };
    if (minmax) {
      const mn = Array(nc).fill(Infinity);
      const mx = Array(nc).fill(-Infinity);
      for (let i = 0; i < n; i++)
        for (let c = 0; c < nc; c++) {
          const v = typed[i * nc + c];
          if (v < mn[c]) mn[c] = v;
          if (v > mx[c]) mx[c] = v;
        }
      a.min = mn.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0));
      a.max = mx.map((v) => (Number.isFinite(v) ? Math.fround(v) : 0));
    }
    this.json.accessors.push(a);
    return this.json.accessors.length - 1;
  }

  bytes() {
    return concat(this.parts);
  }
}

export { arrayBufferOf };
