// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_ARTIFACT,
  CATALOG_SOURCE,
  buildPrimitiveCatalog,
  expectedOutputs,
  findGhostArtifacts,
  verifyPrimitivePromotion,
} from './generate-primitive-catalog.mjs';
import { primitiveScaffold } from './new-primitive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('catalog is a deterministic projection with nine required primitives', () => {
  const catalog = buildPrimitiveCatalog(ROOT);
  assert.match(catalog.catalogRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(catalog.primitives.map((entry) => entry.name).sort(), [
    'Action Geometry',
    'Assignment',
    'Cut',
    'Domain Profile',
    'Episode',
    'Fact',
    'Initiative',
    'Receipt',
    'Work',
  ]);
  assert.equal(
    expectedOutputs(ROOT).get(CATALOG_SOURCE),
    expectedOutputs(ROOT).get(CATALOG_ARTIFACT),
  );
});

test('ghost fixture is rejected by the declaration join', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'tests/fixtures/primitive-catalog/ghost-artifact.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    findGhostArtifacts(fixture.managedFiles, fixture.declaredArtifacts),
    fixture.expectedGhosts,
  );
});

test('admitted primitive without four-language and dogfood proof is denied', () => {
  const states = Object.fromEntries(
    ['cpp', 'python', 'node', 'rust'].map((language) => [
      language,
      { state: language === 'cpp' ? 'proved' : 'missing' },
    ]),
  );
  const evidence = Object.fromEntries(
    ['contract', 'vectors', 'invariants', 'dogfoodReceipts'].map((kind) => [
      kind,
      { state: kind === 'contract' ? 'present' : 'missing' },
    ]),
  );
  const issues = verifyPrimitivePromotion({
    id: 'negative-fixture',
    maturity: 'admitted',
    languageStates: states,
    promotionEvidence: evidence,
  });
  assert.ok(issues.includes('negative-fixture:missing-language-proof:rust'));
  assert.ok(
    issues.includes(
      'negative-fixture:missing-promotion-evidence:dogfoodReceipts',
    ),
  );
});

test('birth scaffold starts at the passport and makes no maturity claim', () => {
  const scaffold = primitiveScaffold({
    id: 'example-primitive',
    name: 'Example Primitive',
    layer: 'example',
    today: '2026-07-24',
  });
  const declaration = scaffold.passport.primitiveDeclarations[0];
  assert.equal(scaffold.passport.id, 'kungfu.primitive.example-primitive');
  assert.equal(declaration.maturity, 'incubating');
  assert.deepEqual(declaration.promotionEvidence.dogfoodReceipts, []);
  assert.deepEqual([...scaffold.files.keys()].sort(), [
    'framework/primitive/contracts/example-primitive.contract.json',
    'framework/primitive/operation-slots/example-primitive.json',
    'framework/primitive/sdk-slots/example-primitive.json',
    'tests/fixtures/primitive/example-primitive/vectors.json',
  ]);
});
