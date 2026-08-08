// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkProductionGraphContract } from './check.mjs';
import { compileProductionGraph } from './compiler/index.mjs';
import {
  POLYGLOT_COMPILE_REQUEST,
  POLYGLOT_SOURCE,
} from './compiler/polyglot.fixture.mjs';
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

test('compiler deterministically projects the polyglot production path', async () => {
  const request = structuredClone(POLYGLOT_COMPILE_REQUEST);
  const first = await compileProductionGraph(request, {
    root: ROOT,
    source: POLYGLOT_SOURCE,
  });
  const reordered = structuredClone(request);
  reordered.nodes.reverse();
  for (const node of reordered.nodes) {
    node.authorityRefs.reverse();
    node.dependencies.reverse();
    node.events.reverse();
    node.inputs.reverse();
    node.outputs.reverse();
    node.exit.successCodes.reverse();
    node.failure.retainedEvidence.reverse();
  }
  const second = await compileProductionGraph(reordered, {
    root: ROOT,
    source: POLYGLOT_SOURCE,
  });
  assert.equal(first.graph.graphRoot, second.graph.graphRoot);
  assert.equal(first.plan.planRoot, second.plan.planRoot);
  assert.deepEqual(first, second);

  const tasks = new Set(first.graph.nodes.map(({ executor }) => executor.task));
  for (const task of [
    'xinfa:build',
    'build',
    'build:core',
    'freeze',
    'core:affected:configure',
    'core:affected',
    'pack:core-platform',
    'build:extensions',
    'build:cli',
    'build:app',
    'product',
    'release:qualify:core-platform',
  ]) {
    assert.ok(tasks.has(task), `missing polyglot executor reference ${task}`);
  }
  const references = new Set(
    first.graph.nodes.flatMap(({ authorityRefs }) =>
      authorityRefs.map(({ authority, id }) => `${authority}:${id}`),
    ),
  );
  for (const reference of [
    'build-capabilities:journal-core',
    'build-capabilities:full',
    'build-capabilities:cxx',
    'build-capabilities:file-storage',
    'build-capabilities:sqlite-projection',
    'build-capabilities:fmt',
    'build-capabilities:kungfu_composition',
    'layers:core-composition-bindings',
    'layers:kungfu_composition',
  ]) {
    assert.ok(
      references.has(reference),
      `missing authority reference ${reference}`,
    );
  }
  for (const [index, nodeId] of first.plan.orderedNodeIds.entries()) {
    const step = first.plan.steps[index];
    assert.equal(step.nodeId, nodeId);
    for (const dependency of step.dependsOn) {
      assert.ok(first.plan.orderedNodeIds.indexOf(dependency) < index);
    }
    assert.equal(step.executor.executionOwnedBy, 'external-orchestrator');
    assert.equal(step.executor.invokedByVerifier, false);
  }
  for (const input of first.graph.nodes.flatMap(({ inputs }) => inputs)) {
    assert.match(input.root, /^sha256:[0-9a-f]{64}$/u);
  }
});

test('compiler fails closed on source, authority, and Xinfa drift', async () => {
  const rejects = async (mutate, code, options = {}) => {
    const request = structuredClone(POLYGLOT_COMPILE_REQUEST);
    mutate(request);
    await assert.rejects(
      compileProductionGraph(request, {
        root: ROOT,
        source: POLYGLOT_SOURCE,
        ...options,
      }),
      (error) => error?.code === code,
    );
  };
  await rejects((request) => {
    request.semanticImpact = {};
  }, 'unknown-or-missing-field');
  await rejects((request) => {
    request.xinfaVerification.sourceRevision = '3'.repeat(40);
  }, 'xinfa-selection-stale');
  await rejects((request) => {
    request.semanticImpact.selectionRoot = `sha256:${'ee'.repeat(32)}`;
  }, 'xinfa-selection-root-mismatch');
  await rejects((request) => {
    request.semanticImpact.changedPaths = ['framework/core/CMakeLists.txt'];
  }, 'unknown-or-missing-field');
  await rejects((request) => {
    request.authorityReferences.layers = `sha256:${'ff'.repeat(32)}`;
  }, 'authority-root-drift');
  await rejects(() => undefined, 'source-drift', {
    source: { ...POLYGLOT_SOURCE, revision: '4'.repeat(40) },
  });
  await rejects((request) => {
    request.nodes[0].authorityRefs[0].id = 'manual-substitution';
  }, 'unknown-authority-reference');
  await rejects((request) => {
    request.xinfaVerification.status = 'pending';
  }, 'xinfa-selection-unverified');
  await rejects((request) => {
    request.nodes[0].inputs[0].root = null;
  }, 'unrooted-compiler-input');
});
