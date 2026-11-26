// Samples for phase 7's tests and hand-test rows (PRD VOI, PER, HON), written repeatably:
//   fixtures/items/borrowed-hat.vrmxw  the pinned hat with a maker who allows no changes and no passing on (HON-1, HON-2)
//   fixtures/voice/hum-6s.wav          a synthetic hum, 6 s at 24 kHz, 16-bit mono: a reference clip that is no one's voice
//   fixtures/voice/hum-2s.wav          the same, 2 s: a clip under 3 s (VOI-2's warning)
//   fixtures/cards/mira-card.json      a Character Card V2 with core and app-side fields (PER-3)
// Never a person's voice: the sounds are tones made here.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readItem, writeItem } from '../src/index.js';
import { encodeWav16 } from '../src/voice/index.js';

// make-fixtures.mjs runs this into its output folder (after the pinned hat is written there); run alone, into fixtures/
const outArg = process.argv.indexOf('--out');
const FIX = outArg > 0 ? process.argv[outArg + 1] : join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const hum = (seconds, rate = 24000) => {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.05, (seconds - t) / 0.05); // no click at either end
    s[i] = env * (0.3 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 360 * t) + 0.05 * Math.sin(2 * Math.PI * 540 * t)) * (0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * t));
  }
  return encodeWav16(s, rate);
};

const hat = await readItem(new Uint8Array(readFileSync(join(FIX, 'items/pinned-hat.vrmxw'))));
hat.manifest.id = '6b1f6c1e-2f43-4a52-9d6c-4f8a3e1d0b77';
hat.manifest.name = 'Borrowed hat';
hat.manifest.revision = 1;
hat.manifest.meta = { authors: ['Another Maker'], licenseUrl: 'https://example.com/licence/borrowed-hat', commercialUsage: 'personalNonProfit', creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' };
writeFileSync(join(FIX, 'items/borrowed-hat.vrmxw'), await writeItem(hat));
mkdirSync(join(FIX, 'voice'), { recursive: true });
writeFileSync(join(FIX, 'voice/hum-6s.wav'), hum(6));
writeFileSync(join(FIX, 'voice/hum-2s.wav'), hum(2));
mkdirSync(join(FIX, 'cards'), { recursive: true });
writeFileSync(join(FIX, 'cards/mira-card.json'), `${JSON.stringify({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Mira', description: 'Short and quick, with ink on her fingers and a map case on her back.',
    personality: 'Curious, plain-spoken and stubborn about directions.',
    scenario: 'You meet Mira at the edge of the old city, lost again.', first_mes: 'You look like you know where you are. Do you?',
    mes_example: "<START>\n{{user}}: Lost again?\n{{char}}: Never. Exploring.\n<START>\n{{user}}: What's in the case?\nMira: Maps. Most of them wrong.",
    creator_notes: 'Works best with slow scenes.', system_prompt: 'Stay in character.', post_history_instructions: 'Keep replies short.',
    alternate_greetings: ['Evening. Seen a river?'],
    character_book: { entries: [{ keys: ['old city'], content: 'The old city floods every spring.', extensions: {}, enabled: true, insertion_order: 0 }], extensions: {} },
    tags: ['cartographer', 'fantasy'], creator: 'Xocialize LLC', character_version: '1.0', extensions: {},
  },
}, null, 2)}\n`);
if (!process.argv.includes('--quiet')) console.log('phase 7 samples written');
