// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateManifest,
  validateRepository,
} from './check-schema-authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'scripts/fixtures/schema-authority');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

test('valid typed view, opaque body, and foreign JSON edge are not authorities', () => {
  assert.deepEqual(validateManifest(fixture('valid')), []);
});

test('one semantic identity cannot have Hana and FlatBuffers owners', () => {
  assert.match(
    validateManifest(fixture('dual-owner')).join('\n'),
    /multiple schema owners/,
  );
});

test('JSON cannot become a core semantic service surface', () => {
  assert.match(
    validateManifest(fixture('json-core')).join('\n'),
    /JSON is not allowed/,
  );
});

test('projection route is exclusive to its schema owner', () => {
  const errors = validateManifest(fixture('wrong-projection')).join('\n');
  assert.match(errors, /hana must use hana-sqlite-orm/);
  assert.match(errors, /flatbuffers must use flatbuffers-bfbs/);
});

test('repository inventory matches production sources', () => {
  assert.deepEqual(validateRepository(ROOT), []);
});
