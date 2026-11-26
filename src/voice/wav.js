// WAV for reference clips (VRMXA §9.1, D8): WAV, 16-bit PCM, mono, at the source's own rate (never upsampled), 3 to
// 20 s. A clip that arrives in another WAV form (stereo, 24-bit, float) is mixed down and written as 16-bit at its own
// rate; nothing is resampled. FLAC is read by the app through the browser's decoder; this module reads its rate and
// length only.

const ascii = (u8, a, b) => String.fromCharCode(...u8.subarray(a, b));

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
  }
}

/** The facts of a WAV or FLAC file, or null when it is neither: { kind, format, channels, rate, bits, duration, frames } */
export function audioInfo(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 42 && ascii(u8, 0, 4) === 'fLaC') {
    // STREAMINFO is the first metadata block: rate 20 bits, channels 3, bits 5, total samples 36
    const b = u8.subarray(8 + 10, 8 + 18);
    const rate = (b[0] << 12) | (b[1] << 4) | (b[2] >> 4);
    const channels = ((b[2] >> 1) & 0x7) + 1;
    const bits = (((b[2] & 1) << 4) | (b[3] >> 4)) + 1;
    const frames = (b[3] & 0x0f) * 2 ** 32 + ((b[4] << 24) >>> 0) + (b[5] << 16) + (b[6] << 8) + b[7];
    return { kind: 'flac', format: null, channels, rate, bits, frames, duration: rate ? frames / rate : 0 };
  }
  const w = parseWav(u8, { data: false });
  return w ? { kind: 'wav', format: w.format, channels: w.channels, rate: w.rate, bits: w.bits, frames: w.frames, duration: w.duration } : null;
}

function parseWav(u8, { data = true } = {}) {
  if (u8.length < 12 || ascii(u8, 0, 4) !== 'RIFF' || ascii(u8, 8, 12) !== 'WAVE') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 12, fmt = null, dataAt = -1, dataLen = 0;
  while (p + 8 <= u8.length) {
    const id = ascii(u8, p, p + 4);
    const len = dv.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 24 <= u8.length) {
      let format = dv.getUint16(p + 8, true);
      if (format === 0xfffe && len >= 40) format = dv.getUint16(p + 8 + 24, true); // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes
      fmt = { format, channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    }
    if (id === 'data') { dataAt = p + 8; dataLen = Math.min(len, u8.length - p - 8); }
    p += 8 + len + (len & 1);
  }
  if (!fmt || dataAt < 0 || !fmt.channels || !fmt.rate || !fmt.bits) return null;
  const frameBytes = fmt.channels * (fmt.bits / 8);
  const frames = Math.floor(dataLen / frameBytes);
  return { ...fmt, frames, duration: frames / fmt.rate, dataAt, dataLen, ...(data ? { u8, dv } : {}) };
}

/** Decode a WAV (PCM 8, 16, 24 or 32 bit; float 32 or 64) → { rate, channels: [Float32Array], bits, format } */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const w = parseWav(u8);
  if (!w) throw new WavError('not a WAV file');
  if (![1, 3].includes(w.format)) throw new WavError(`WAV format ${w.format} is not PCM or float`);
  const { dv, dataAt, channels: n, bits, frames } = w;
  const step = bits / 8;
  const out = Array.from({ length: n }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < n; c++) {
      const o = dataAt + (f * n + c) * step;
      let v;
      if (w.format === 3) v = bits === 64 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bits === 8) v = (u8[o] - 128) / 128;
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) { const x = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); v = ((x << 8) >> 8) / 8388608; }
      else if (bits === 32) v = dv.getInt32(o, true) / 2147483648;
      else throw new WavError(`${bits}-bit PCM is not read`);
      out[c][f] = v;
    }
  }
  return { rate: w.rate, channels: out, bits, format: w.format };
}

/** Mono 16-bit PCM WAV bytes from samples (Float32Array in −1…1, or Int16Array) at `rate`. */
export function encodeWav16(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 2, true);
  if (samples instanceof Int16Array) for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, samples[i], true);
  else for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
  }
  return new Uint8Array(buf);
}

/** Mix channels down to one (the mean). */
export function mixDown(channels) {
  if (channels.length === 1) return channels[0];
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/**
 * A clip in the standard form (D8). A WAV already 16-bit PCM mono is kept byte for byte; another WAV is mixed down and
 * written 16-bit at its own rate. → { bytes, rate, duration, changed: [what was done] }
 */
export function standardClip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = audioInfo(u8);
  if (!info) throw new WavError('a reference clip must be a WAV file (16-bit PCM, mono); FLAC is read by the app');
  if (info.kind === 'flac') throw new WavError('a FLAC clip is decoded by the app and written as WAV (VRMXA §9.1: writers write WAV)');
  if (info.format === 1 && info.bits === 16 && info.channels === 1) return { bytes: u8, rate: info.rate, duration: info.duration, changed: [] };
  const d = decodeWav(u8);
  const changed = [];
  if (d.channels.length > 1) changed.push(`mixed down from ${d.channels.length} channels`);
  if (d.format === 3) changed.push(`converted from ${d.bits}-bit float`);
  else if (d.bits !== 16) changed.push(`converted from ${d.bits}-bit`);
  const out = encodeWav16(mixDown(d.channels), d.rate);
  return { bytes: out, rate: d.rate, duration: info.duration, changed };
}

/** What a clip's facts warn about (VOI-2, §9.1): length outside 3–20 s, rate under 24 kHz, not 16-bit mono. → [text] */
export function clipWarnings({ duration, rate, channels = 1, bits = 16 }) {
  const w = [];
  if (duration < 3) w.push(`${duration.toFixed(1)} s is shorter than 3 s: some engines refuse it, and a short clip clones poorly (VRMXA §9.1)`);
  else if (duration > 20) w.push(`${duration.toFixed(1)} s is longer than 20 s: some engines trim it, and AuK shares a 30 s budget with what it speaks (VRMXA §9.1)`);
  if (rate < 24000) w.push(`${rate} Hz is under 24 kHz: the standard is 24 kHz or higher, never upsampled (D8)`);
  if (channels !== 1 || bits !== 16) w.push('the standard is 16-bit PCM, mono (D8)');
  return w;
}
