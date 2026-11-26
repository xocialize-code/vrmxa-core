// vrmxa details, licence, credits, export, share, voice and persona: phase 7's levers from the command line, for agents
// (PRD §16.1 MCP-10: "Characters: read and set details and licence; validate; export a VRM"; "Voice and persona").
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, FIX, noSpec } from './helpers.mjs';
import { tone } from './tone.mjs';

const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'bin/vrmxa.mjs'), ...args], { encoding: 'utf8' });
const json = (r) => JSON.parse(r.stdout);

test('details, voices, persona, licences, credits, export and share from the command line', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-p7-'));
  const f = (n) => join(dir, n);
  try {
    const full = join(FIX, 'characters/full.vrmxa');
    let r = run('details', full, 'set', 'name=Mira Vale', 'version=1.2', 'authors=Xocialize LLC,A. Maker', 'contactInformation=studio@example.com', 'listing.marketplace=Booth', f('a.vrmxa'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(json(r).result.meta.name, 'Mira Vale');
    assert.deepEqual(json(r).result.meta.authors, ['Xocialize LLC', 'A. Maker']);
    assert.equal(json(r).result.listing.marketplace, 'Booth');
    assert.equal(run('details', f('a.vrmxa'), 'set', 'commercialUsage=gratis', f('x.vrmxa')).status, 1);

    writeFileSync(f('hum.wav'), tone(6, 24000));
    r = run('voice', f('a.vrmxa'), 'import', f('hum.wav'), '--name', 'Real take', '--transcript', 'A test tone, not speech.', '--real-person', '--speaker', 'Sam Example', f('x.vrmxa'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /consent recorded/);
    r = run('voice', f('a.vrmxa'), 'import', f('hum.wav'), '--name', 'Real take', '--transcript', 'A test tone, not speech.', '--real-person', '--speaker', 'Sam Example',
      '--consent-date', '2026-11-17', '--consent-scope', 'This character only. Not to be passed on.', f('b.vrmxa'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run('voice', f('b.vrmxa'), 'check', '--json');
    assert.equal(r.status, 0);
    const take = json(r).voices.find((v) => v.name === 'Real take');
    assert.equal(take.realPerson, true);
    assert.equal(take.shareable, false);
    assert.equal(take.meta.avatarPermission, 'onlyAuthor');

    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Mira', description: 'Ink on her fingers.', personality: 'Curious.', scenario: 'At the map shop.', first_mes: 'Lost?', mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello.', tags: [], creator: 'Card Maker', character_version: '1', extensions: {} } };
    writeFileSync(f('card.json'), JSON.stringify(card));
    r = run('persona', f('b.vrmxa'), 'import', f('card.json'), f('c.vrmxa'), '--app-fields', f('app.json'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(json(r).result.appSide.sort(), ['first_mes', 'scenario']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(f('app.json'), 'utf8')).fields).sort(), ['first_mes', 'scenario']);
    r = run('persona', f('c.vrmxa'), 'export', f('out.json'), '--app-fields', f('app.json'), '--json');
    assert.equal(r.status, 0);
    assert.equal(json(r).card.data.scenario, 'At the map shop.');
    assert.equal(json(r).card.data.mes_example, '<START>\n{{user}}: Hi\n{{char}}: Hello.');
    assert.equal(run('persona', f('c.vrmxa'), 'export', f('out.png')).status, 0);
    assert.equal(json(run('persona', f('c.vrmxa'), '--json')).persona.description, 'Ink on her fingers.');
    // the exchange form (VRMXA §10.1) sets every core field, the expressions included; a stray field is refused
    writeFileSync(f('hana.persona.json'), JSON.stringify({ format: 'vrmxa-persona', version: 1, name: 'Hana', summary: 'Runs the cafe.', traits: ['warm'], languages: ['en'], rest_expression: 'relaxed', allowed_expressions: ['happy', 'relaxed', 'surprised'], examples: [{ user: 'Busy?', character: 'Always.' }] }));
    r = run('persona', f('c.vrmxa'), 'import', f('hana.persona.json'), f('d.vrmxa'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const hana = json(run('persona', f('d.vrmxa'), '--json')).persona;
    assert.deepEqual(hana.allowed_expressions, ['happy', 'relaxed', 'surprised']);
    assert.equal(hana.rest_expression, 'relaxed');
    assert.equal(hana.examples.length, 1);
    writeFileSync(f('bad.persona.json'), JSON.stringify({ format: 'vrmxa-persona', version: 1, name: 'Hana', scenario: 'At the cafe.' }));
    assert.equal(run('persona', f('c.vrmxa'), 'import', f('bad.persona.json'), f('x.vrmxa')).status, 1);

    r = run('licence', f('c.vrmxa'), '--json');
    assert.equal(r.status, 0);
    assert.ok(json(r).share.voices.some((v) => v.name === 'Real take'));
    r = run('credits', f('c.vrmxa'), '--json');
    assert.ok(json(r).makers.some((m) => m.pieces.some((p) => p.name === 'Real take')));

    r = run('share', f('c.vrmxa'), f('shared.vrmxa'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(json(r).sameCharacter, true);
    assert.ok(json(r).notes.some((n) => /"Real take" is left out/.test(n)));
    assert.equal(run('validate', f('shared.vrmxa')).status, 0);
    assert.ok(!json(run('voice', f('shared.vrmxa'), '--json')).voices.some((v) => v.name === 'Real take'));
    r = run('share', f('c.vrmxa'), f('fresh.vrmxa'), '--new-identity', '--json');
    assert.equal(json(r).sameCharacter, false);

    r = run('export', f('c.vrmxa'), '--vrm', f('mira.vrm'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(json(r).carries.some((l) => /No voice/.test(l)));
    r = run('export', f('c.vrmxa'), '--item', 'Fixture top', f('top.vrmxw'));
    assert.equal(r.status, 0);
    assert.equal(run('validate', f('top.vrmxw')).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI asks for --accept-terms before wearing a piece that forbids it, refuses a recording no one vouched for, and credits a speaker (HON-1, HON-3)', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-p7b-'));
  const f = (n) => join(dir, n);
  try {
    const min = join(FIX, 'characters/minimal.vrmxa');
    assert.equal(run('closet', min, 'add', join(FIX, 'items/borrowed-hat.vrmxw'), f('a.vrmxa')).status, 0);
    let r = run('closet', f('a.vrmxa'), 'put-on', 'Borrowed hat', f('b.vrmxa'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"Borrowed hat": Another Maker doesn't allow changes/);
    assert.match(r.stderr, /--accept-terms/);
    r = run('closet', f('a.vrmxa'), 'put-on', 'Borrowed hat', f('b.vrmxa'), '--accept-terms', '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // answered once: taking it off and on again needs no flag (outfit-apply, hair and import --wear go through the same check)
    assert.equal(run('closet', f('b.vrmxa'), 'take-off', 'Borrowed hat', f('c.vrmxa')).status, 0);
    assert.equal(run('closet', f('c.vrmxa'), 'put-on', 'Borrowed hat', f('d.vrmxa')).status, 0);
    // put-on wrote her permissions as shown (Spec's never chosen: nothing allowed), tightened for the hat (D35): nothing
    // claims more than its parts, so validate has nothing to warn about (files written before D35 still get details.looser)
    r = run('validate', f('b.vrmxa'), '--json');
    assert.ok(!JSON.parse(r.stdout).problems.some((p) => p.code === 'details.looser'));
    writeFileSync(f('hum.wav'), tone(6, 24000));
    r = run('voice', f('a.vrmxa'), 'import', f('hum.wav'), '--origin', 'recorded', '--name', 'Take', '--transcript', 'A hum.', f('v.vrmxa'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a recording is a real person's voice/);
    assert.equal(run('voice', f('a.vrmxa'), 'import', f('hum.wav'), '--origin', 'recorded', '--no-real-person', '--name', 'Take', '--transcript', 'A hum.', f('v.vrmxa')).status, 0);
    r = run('voice', f('a.vrmxa'), 'import', f('hum.wav'), '--real-person', '--speaker', 'Sam Example', '--consent-date', '2026-11-17', '--consent-scope', 'This character only.', '--name', 'Take', '--transcript', 'A hum.', f('w.vrmxa'));
    assert.equal(r.status, 0, r.stderr);
    const v = JSON.parse(run('voice', f('w.vrmxa'), '--json').stdout).voices.find((x) => x.name === 'Take');
    assert.deepEqual(v.meta.authors, ['Sam Example']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI tightens on put-on with --accept-terms, lists it, and reports what could be loosened on take-off (VRMXA §5.3, D35)', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-p7c-'));
  const f = (n) => join(dir, n);
  try {
    assert.equal(run('closet', join(FIX, 'characters/full.vrmxa'), 'add', join(FIX, 'items/borrowed-hat.vrmxw'), f('a.vrmxa')).status, 0);
    assert.equal(run('details', f('a.vrmxa'), 'set', 'allowRedistribution=true', 'commercialUsage=corporation', f('b.vrmxa')).status, 0);
    let r = run('closet', f('b.vrmxa'), 'put-on', 'Borrowed hat', f('c.vrmxa'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /permissions are tightened: "May be passed on" becomes "May not be passed on"/);
    r = run('closet', f('b.vrmxa'), 'put-on', 'Borrowed hat', f('c.vrmxa'), '--accept-terms', '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).tightened.map((t) => t.key).sort(), ['allowRedistribution', 'commercialUsage']);
    assert.ok(!JSON.parse(run('validate', f('c.vrmxa'), '--json').stdout).problems.some((p) => p.code === 'details.looser'));
    r = run('closet', f('c.vrmxa'), 'take-off', 'Borrowed hat', f('d.vrmxa'), '--json');
    assert.deepEqual(JSON.parse(r.stdout).couldLoosen.map((l) => l.key).sort(), ['allowRedistribution', 'commercialUsage']);
    assert.equal(JSON.parse(run('details', f('d.vrmxa'), '--json').stdout).meta.allowRedistribution, false, 'nothing loosened on its own');
    r = run('motion', f('d.vrmxa'), 'details', 'Idle, breathing', 'licence={"authors":["Motion Maker"],"licenseUrl":"https://example.com/m","allowRedistribution":true}', f('e.vrmxa'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(JSON.parse(run('licence', f('e.vrmxa'), '--json').stdout).table.clips[0].block);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a preset voice from the command line: an engine\'s own speaker, no clip, named as the persona\'s voice_id (VRMXA §9, D36, AB-A-0323)', { skip: noSpec }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'vrmxa-preset-'));
  const f = (n) => join(dir, n);
  try {
    const full = join(FIX, 'characters/full.vrmxa');
    let r = run('voice', full, 'preset', '--engine', 'kokoro-82m', '--preset', 'af_bella', '--name', 'Mira (Kokoro)', '--default', '--persona',
      '--meta', 'avatarPermission=everyone', '--meta', 'commercialUsage=corporation', '--meta', 'creditNotation=unnecessary',
      '--meta', 'allowRedistribution=true', '--meta', 'modification=allowModificationRedistribution', f('p.vrmxa'), '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(json(r).problems.filter((p) => p.level === 'error').length, 0);
    const v = json(run('voice', f('p.vrmxa'), '--json')).voices.find((x) => x.name === 'Mira (Kokoro)');
    assert.ok(v, 'the preset voice is listed');
    assert.equal(v.origin, 'preset');
    assert.equal(v.realPerson, false);
    assert.equal(v.clips.length, 0, 'a preset voice has no clip');
    assert.equal(v.default, true, '--default makes it the default voice');
    assert.equal(json(run('persona', f('p.vrmxa'), '--json')).persona.voice_id, v.id, '--persona names it as the persona\'s voice_id');
    assert.ok(json(run('voice', f('p.vrmxa'), '--json')).voices.length >= 2, 'Mira keeps her own voice');
    // as written (§9: engines.<id>.preset, no clips, the licence loosened as asked)
    const doc = JSON.parse(spawnSync('unzip', ['-p', f('p.vrmxa'), 'voice/voices.json'], { encoding: 'utf8' }).stdout);
    const w = doc.voices.find((x) => x.id === v.id);
    assert.deepEqual(w.engines, { 'kokoro-82m': { preset: 'af_bella' } });
    assert.deepEqual(w.clips, []);
    assert.equal(doc.default, v.id);
    assert.equal(w.meta.commercialUsage, 'corporation');
    assert.equal(w.meta.allowRedistribution, true);
    assert.equal(w.meta.allowExcessivelyViolentUsage, false, 'what --meta doesn\'t name stays at its strictest');
    assert.equal(run('validate', f('p.vrmxa')).status, 0); // the fixture's own avatar and measurements notes keep --strict off here
    // refused: no engine or preset, an engine id that isn't a lower-case model id
    assert.equal(run('voice', full, 'preset', '--preset', 'af_bella', f('x.vrmxa')).status, 2);
    assert.equal(run('voice', full, 'preset', '--engine', 'Kokoro 82M', '--preset', 'af_bella', f('x.vrmxa')).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
