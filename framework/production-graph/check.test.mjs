// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProductionGraphContract } from './check.mjs';
import {
  applyFixtureMutation,
  canonicalJson,
  loadFixture,
  loadProductionGraphContract,
  materializeFixture,
  schemaValidators,
  semanticRoot,
  verifyBundle,
} from './contract.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const QUALIFIED = 'docs/shifu/examples/production-graph/qualified.fixture.json';

test('Production Graph contract emits one source-bound protected-CI receipt', async () => {
  const receipt = await checkProductionGraphContract();
  assert.equal(receipt.status, 'qualified');
  assert.equal(receipt.validFixtureCount, 3);
  assert.equal(receipt.invalidFixtureCount, 8);
  assert.equal(receipt.nodesExecuted, false);
  assert.equal(receipt.protectedGate, './shifu check:source');
  assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/u);

  const validators = await schemaValidators(ROOT);
  const unknownSchemaReceipt = structuredClone(receipt);
  unknownSchemaReceipt.schemaRoots.unknown = `sha256:${'f'.repeat(64)}`;
  assert.equal(validators.verificationReceipt(unknownSchemaReceipt), false);
});

test('canonical roots ignore object field order and preserve array order', () => {
  assert.equal(
    semanticRoot({ first: 1, second: { left: true, right: false } }),
    semanticRoot({ second: { right: false, left: true }, first: 1 }),
  );
  assert.notEqual(semanticRoot([1, 2]), semanticRoot([2, 1]));
  assert.equal(canonicalJson({ z: 1, a: 2 }), '{"a":2,"z":1}');
});

test('source, authority, dependency, and receipt drift fail closed', async () => {
  const fixture = loadFixture(ROOT, QUALIFIED);
  const base = materializeFixture(fixture, ROOT);
  for (const [mutation, expected] of [
    [
      {
        target: 'context',
        operation: 'set',
        path: ['source', 'revision'],
        value: '3'.repeat(40),
      },
      'source-drift',
    ],
    [
      {
        target: 'context',
        operation: 'set',
        path: ['authorityReferences', 'layers'],
        value: `sha256:${'f'.repeat(64)}`,
      },
      'authority-drift',
    ],
    [
      {
        target: 'graph',
        operation: 'set',
        path: ['nodes', 0, 'dependencies'],
        value: ['qualify-contract'],
      },
      'dependency-cycle',
    ],
    [
      {
        target: 'receipt',
        operation: 'set',
        path: ['planRoot'],
        value: `sha256:${'f'.repeat(64)}`,
      },
      'plan-receipt-mismatch',
    ],
  ]) {
    const changed = applyFixtureMutation(base, fixture.context, mutation);
    const result = await verifyBundle(changed.bundle, changed.context, {
      root: ROOT,
    });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some(({ code }) => code === expected));
  }
});

test('verifier has no Work Control mutation authority', () => {
  const contract = loadProductionGraphContract(ROOT);
  assert.deepEqual(contract.authorityBoundary.forbiddenOperations, [
    'capture',
    'claim',
    'dispatch',
    'execute',
    'approve',
    'merge',
    'close',
  ]);
  assert.equal(contract.verification.executesNodes, false);
});
