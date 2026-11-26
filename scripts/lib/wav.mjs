// A repeatable 16-bit PCM mono WAV: a soft two-tone hum standing in for a voice clip.
export function wav(seconds, rate = 24000) {
  const n = Math.round(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  const dv = new DataView(out.buffer);
  const s = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); s(8, 'WAVE');
  s(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  s(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 8, (seconds - t) * 8) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    const v = env * (0.25 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}
