// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateContractSchemaArtifactBindings,
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

test('every declared contract schema is frozen by the central artifact registry', () => {
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'framework/spec/contract/kungfu-contracts.registry.json'),
      'utf8',
    ),
  );
  const skillEntry = registry.contracts.find(
    (entry) => entry.surface === 'skill',
  );
  assert.ok(skillEntry);
  const contractsBySource = {
    [skillEntry.source]: JSON.parse(
      fs.readFileSync(path.join(ROOT, skillEntry.source), 'utf8'),
    ),
  };
  assert.deepEqual(
    validateContractSchemaArtifactBindings(registry, contractsBySource),
    [],
  );

  const incomplete = structuredClone(registry);
  const incompleteSkill = incomplete.contracts.find(
    (entry) => entry.surface === 'skill',
  );
  incompleteSkill.extraArtifacts = incompleteSkill.extraArtifacts.filter(
    (entry) => !entry.source.endsWith('skill-dependency-plan-v2.schema.json'),
  );
  assert.match(
    validateContractSchemaArtifactBindings(incomplete, contractsBySource).join(
      '\n',
    ),
    /schemaFiles\.dependencyPlanV2 is not frozen by registry extraArtifacts/u,
  );
});
