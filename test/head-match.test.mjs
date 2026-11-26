// Match a Donor Face (src/edit/headMatch.js): donors made from Spec itself with known Face Shape and Head
// Size values, written into a model by the library's own bake, then matched back onto Spec.
//
// Tolerances (slider units; the sliders run −1 … 1 or 0 … 1):
//   Head Width / Height / Depth and Head Size come back within 0.06 of the value set;
//   Forehead, Cheekbone Width, Jaw Size, Chin Slim and Chin Tip within 0.12;
//   sliders the donor never set stay within 0.2 of their default;
//   the match closes at least 90 % of the gap between the heads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, buildGlb } from '../src/glb.js';
import { newEdits, setEdits, bakeAvatar, HEAD_TUNES } from '../src/edit/index.js';
import {
  MATCH_SECTIONS, MATCH_KEYS, DEFAULT_SECTIONS, matchHead, scanMatchHead, readDonor, donorHead, donorHeadFromBytes, alignHead,
} from '../src/edit/headMatch.js';
import { specVrm, noSpec } from './helpers.mjs';

const TOL = { proportions: 0.06, size: 0.06, local: 0.12, unset: 0.2 };
const PROPORTIONS = new Set(['headWidth', 'headHeight', 'headDepth']);
const DEF = Object.fromEntries(HEAD_TUNES.map((t) => [t.key, t.def ?? 0]));

let SPEC = null, BASE = null;
const spec = () => (SPEC ??= specVrm());
const base = () => (BASE ??= (() => { const g = parseGlb(spec()); return scanMatchHead(g.json, g.bin); })());
// a donor: Spec with these edits written into its model → its bytes
const donorBytes = (edits) => bakeAvatar(spec(), setEdits(newEdits(), Object.entries(edits)), {}).bytes;
const scan = (bytes) => { const g = parseGlb(bytes); return scanMatchHead(g.json, g.bin); };

function checkRecovered(r, edits, t) {
  const set = Object.fromEntries(Object.entries(edits).filter(([k]) => k.startsWith('face.shapes.')).map(([k, v]) => [k.slice(12), v]));
  t.diagnostic(`set ${JSON.stringify(edits)} → ${JSON.stringify(r.shapes)} headSize ${r.headSize}; ${r.before.toFixed(3)} → ${r.after.toFixed(3)} mm`);
  for (const k of r.keys) {
    if (r.held[k]) continue;
    const got = r.shapes[k] ?? DEF[k];
    if (k in set) {
      const tol = PROPORTIONS.has(k) ? TOL.proportions : TOL.local;
      assert.ok(Math.abs(got - set[k]) <= tol, `${k}: set ${set[k]}, matched ${got} (tolerance ${tol})`);
    } else assert.ok(Math.abs(got - DEF[k]) <= TOL.unset, `${k}: not set, matched ${got}`);
  }
  if (r.headSize !== null) {
    const want = edits['body.headSize'] ?? 0;
    assert.ok(Math.abs(r.headSize - want) <= TOL.size, `head size: set ${want}, matched ${r.headSize}`);
  }
  assert.ok(r.after <= 0.1 * r.before, `the match closes the gap: ${r.before} → ${r.after} mm`);
}

test('the match sections cover every Face Shape slider once, with reasons in their grouping', () => {
  const tuned = HEAD_TUNES.map((t) => t.key).sort();
  assert.deepEqual([...MATCH_KEYS].sort(), tuned, 'every head slider is in one section, and only head sliders');
  assert.equal(new Set(MATCH_KEYS).size, MATCH_KEYS.length);
  assert.ok(MATCH_SECTIONS.some((s) => s.size && s.keys.length === 0), 'Head Size (Body page) is its own section');
  assert.deepEqual(DEFAULT_SECTIONS, ['proportions', 'size', 'forehead', 'cheekbones', 'jaw']);
  for (const s of MATCH_SECTIONS) assert.ok(s.id && s.label && Array.isArray(s.keys));
});

test('Spec matched to itself moves nothing and aligns exactly', { skip: noSpec }, () => {
  const r = matchHead(base(), base());
  assert.deepEqual(r.shapes, {});
  assert.equal(r.headSize, 0);
  assert.equal(r.after, 0);
  assert.equal(r.method, 'aligned');
  assert.equal(r.align.s, 1);
  assert.equal(r.align.sin, 0);
});

test('a donor with wider head, larger jaw and longer chin comes back within tolerance', { skip: noSpec }, (t) => {
  const edits = { 'face.shapes.headWidth': 0.5, 'face.shapes.jawSize': 0.6, 'face.shapes.chinLength': 0.3 };
  const r = matchHead(base(), scan(donorBytes(edits)));
  checkRecovered(r, edits, t);
  // a face-shape edit moves no bone: the alignment is (nearly) the identity
  assert.ok(Math.abs(r.align.s - 1) < 0.002 && Math.abs(r.align.sin) < 1e-3, JSON.stringify(r.align));
});

test('a donor with a bigger head (Body page) and its own forehead, cheekbones, depth and chin: head size from face height', { skip: noSpec }, (t) => {
  const edits = { 'body.headSize': 0.4, 'face.shapes.headDepth': -0.5, 'face.shapes.forehead': 0.5, 'face.shapes.cheekbone': -0.4, 'face.shapes.chinSlim': 0.5 };
  const r = matchHead(base(), scan(donorBytes(edits)));
  checkRecovered(r, edits, t);
  assert.ok(Math.abs(r.sizeRatio - 1.06) < 0.005, `size ratio ${r.sizeRatio}`);
  // the head was scaled 6 % about the head joint: the alignment's scale is its inverse
  assert.ok(Math.abs(r.align.s - 1 / 1.06) < 0.003, `alignment scale ${r.align.s}`);
  assert.deepEqual(Object.keys(r.held), ['headHeight']);
});

test('a longer chin alone is read as a chin, not as a bigger head', { skip: noSpec }, (t) => {
  const edits = { 'face.shapes.chinLength': -0.6 };
  const r = matchHead(base(), scan(donorBytes(edits)));
  checkRecovered(r, edits, t);
  assert.ok(Math.abs(r.headSize) < 0.03, `head size ${r.headSize}`);
});

test('without the Head size section, Head Height is matched', { skip: noSpec }, (t) => {
  const edits = { 'face.shapes.headHeight': 0.5, 'face.shapes.headWidth': -0.3 };
  const r = matchHead(base(), scan(donorBytes(edits)), ['proportions', 'forehead', 'cheekbones', 'jaw']);
  assert.equal(r.headSize, null);
  assert.deepEqual(r.held, {});
  checkRecovered(r, edits, t);
});

test('a donor not named the VRoid way: named another tool\'s way, and named meaninglessly (found by shape against Spec)', { skip: noSpec }, async (t) => {
  const edits = { 'face.shapes.headWidth': 0.5, 'face.shapes.jawSize': 0.6, 'face.shapes.chinLength': 0.3 };
  const bytes = donorBytes(edits);
  // another tool's names: the library's name guesses find the parts
  const OTHER = { FaceMouth: 'Mouth', EyeIris: 'Eye_Iris', EyeHighlight: 'Eye_Hilight', Face: 'Skin_Face', EyeWhite: 'Eye_White', FaceBrow: 'Brow', FaceEyeline: 'Eyeline', Body: 'Skin_Body', FaceEyelash: 'Eyelash' };
  const renamed = (namer) => {
    const g = parseGlb(bytes);
    g.json.materials.forEach((m, i) => { m.name = namer(m.name, i); });
    g.json.meshes.forEach((m, i) => { m.name = `Mesh${i}`; });
    g.json.nodes.forEach((n, i) => { if (n.mesh != null) n.name = `Node${i}`; });
    return buildGlb(g.json, g.bin);
  };
  const other = renamed((name) => OTHER[/_([A-Za-z]+)_\d\d_[A-Z]+/.exec(name)[1]]);
  const d1 = await readDonor(other);
  assert.equal(d1.vroid, false);
  const h1 = donorHead(d1.json, d1.bin, d1.parts);
  assert.ok(h1, 'scanned by the guessed parts');
  checkRecovered(matchHead(base(), h1), edits, t);
  // meaningless names: the parts are found by their shape against Spec
  const g = parseGlb(spec());
  const plain = renamed((name, i) => `mat.${String(i).padStart(3, '0')}`);
  const d2 = await readDonor(plain, { base: g });
  assert.deepEqual(d2.parts.filter((p) => p.role !== 'ignore').map((p) => [p.material, p.role]).sort(), [[1, 'eyes'], [3, 'face'], [7, 'body']]);
  const h2 = await donorHeadFromBytes(plain, null, { base: g });
  checkRecovered(matchHead(base(), h2), edits, t);
});

test('the match is deterministic: the same donor gives the same result, byte for byte', { skip: noSpec }, () => {
  const bytes = donorBytes({ 'body.headSize': -0.3, 'face.shapes.headWidth': 0.4, 'face.shapes.forehead': -0.5, 'face.shapes.chinSlim': 0.3 });
  const run = () => {
    const g = parseGlb(spec());
    const b = scanMatchHead(g.json, g.bin), d = scan(bytes);
    return JSON.stringify({ r: matchHead(b, d), R: Array.from(d.R), align: alignHead(b, d) });
  };
  const a = run(), b = run();
  assert.equal(a, b);
});

test('through the package\'s edit entry: Spec\'s head read for matching, and plain scanned heads mixed with it', { skip: noSpec }, async (t) => {
  const E = await import('../src/edit/index.js');
  for (const k of ['scanMatchHead', 'alignHead', 'faceHeight', 'matchHead', 'donorHeadFromBytes', 'readDonor']) assert.equal(typeof E[k], 'function', k);
  const g = parseGlb(spec());
  const rich = E.scanMatchHead(g.json, g.bin), plain = E.faceLandmarks(g.json, g.bin).head;
  // a plain head on either side: compared in its own frame, against the same reference on both sides
  for (const [a, b] of [[rich, plain], [plain, rich]]) {
    const r = E.matchHead(a, b);
    assert.equal(r.method, 'own-frame');
    assert.deepEqual(r.shapes, {});
    assert.equal(r.headSize, 0);
  }
  // a donor read from bytes, matched against Spec read the same way
  const edits = { 'face.shapes.headWidth': 0.5, 'face.shapes.jawSize': 0.6, 'face.shapes.chinLength': 0.3 };
  const r = E.matchHead(rich, await E.donorHeadFromBytes(donorBytes(edits)));
  assert.equal(r.method, 'aligned');
  checkRecovered(r, edits, t);
});
