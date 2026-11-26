// The package's copy of bases.json matches the specification's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import bases from '../src/data/bases.js';
import { SPEC_DIR, noSpec } from './helpers.mjs';

test('src/data/bases.js is the specification\'s assets/spec/bases.json', { skip: noSpec || (!existsSync(join(SPEC_DIR, 'bases.json')) && 'no bases.json') }, () => {
  assert.deepEqual(bases, JSON.parse(readFileSync(join(SPEC_DIR, 'bases.json'), 'utf8')));
});
