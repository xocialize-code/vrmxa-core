// A synthetic test sound: never a person's voice.
import { encodeWav16 } from '../src/voice/index.js';

/** A synthetic tone (a hum with two overtones), `seconds` long at `rate`, as 16-bit mono WAV, or stereo float with `float`. */
export function tone(seconds, rate, { float = false, channels = 1 } = {}) {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / rate; s[i] = 0.3 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t) + 0.05 * Math.sin(2 * Math.PI * 540 * t); }
  if (!float && channels === 1) return encodeWav16(s, rate);
  // a float WAV with `channels` channels
  const bytes = 4 * channels;
  const buf = new ArrayBuffer(44 + n * bytes);
  const dv = new DataView(buf);
  const w = (o, x) => { for (let i = 0; i < x.length; i++) dv.setUint8(o + i, x.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * bytes, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); dv.setUint16(22, channels, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * bytes, true);
  dv.setUint16(32, bytes, true); dv.setUint16(34, 32, true); w(36, 'data'); dv.setUint32(40, n * bytes, true);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) dv.setFloat32(44 + (i * channels + c) * 4, s[i] * (c ? 0.5 : 1), true);
  return new Uint8Array(buf);
}

