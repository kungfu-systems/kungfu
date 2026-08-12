// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  rooted,
  schemaValidators,
  semanticRoot,
  verifyBundle,
} from './contract.mjs';
import {
  createProductionGraphFeedback,
  renderProductionGraphFeedback,
} from './feedback/index.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;
const QUALIFIED = 'docs/shifu/examples/production-graph/qualified.fixture.json';
const FEEDBACK_FIXTURE_ROOT = path.join(
  ROOT,
  'docs',
  'shifu',
  'examples',
  'production-graph',
  'feedback',
);

function feedbackScenario(id) {
  return JSON.parse(
    fs.readFileSync(
      path.join(FEEDBACK_FIXTURE_ROOT, `${id}.fixture.json`),
      'utf8',
    ),
  );
}

function feedbackInputFor(spec) {
  const source = loadFixture(ROOT, QUALIFIED);
  const fixture = structuredClone(source);
  fixture.fixtureId = spec.id;
  fixture.outcome = {
    status: spec.outcome,
    ...(spec.terminalNodeId ? { terminalNodeId: spec.terminalNodeId } : {}),
  };
  if (spec.recoveryStrategy) {
    const node = fixture.graph.nodes.find(
      ({ id }) => id === spec.terminalNodeId,
    );
    node.recovery.strategy = spec.recoveryStrategy;
  }
  if (spec.executorTask)
    fixture.graph.nodes[0].executor.task = spec.executorTask;
  const bundle = materializeFixture(fixture, ROOT);
  const currentPlan = {
    schema: 'example.external-plan/v1',
    graphRoot: bundle.graph.graphRoot,
  };
  const currentReceipt =
    spec.outcome === 'cancelled'
      ? null
      : {
          schema: 'example.external-receipt/v1',
          status: spec.outcome === 'qualified' ? 'passed' : 'failed',
          toolchain: { runner: 'project-independent-fixture' },
          privatePayload: 'DO_NOT_RENDER',
        };
  const currentPlanRoot = semanticRoot(currentPlan);
  const currentReceiptRoot = currentReceipt
    ? semanticRoot(currentReceipt)
    : null;
  const toolchainRoot = currentReceipt
    ? semanticRoot(currentReceipt.toolchain)
    : null;
  const receipt = rooted(
    {
      ...bundle.receipt,
      outputRoots: currentReceiptRoot ? [currentReceiptRoot] : [],
      retainedEvidenceRoots: [
        ...bundle.receipt.retainedEvidenceRoots,
        currentPlanRoot,
        ...(currentReceiptRoot ? [currentReceiptRoot] : []),
        ...(toolchainRoot ? [toolchainRoot] : []),
      ],
    },
    'receiptRoot',
  );
  const classification =
    spec.outcome === 'qualified'
      ? 'matched-success'
      : spec.outcome === 'cancelled'
        ? 'matched-cancellation'
        : 'matched-failure';
  const shadowReceipt = rooted(
    {
      schema: 'kungfu.core-affected-production-graph-shadow-receipt/v0',
      status: spec.outcome,
      sourceRevision: bundle.graph.source.revision,
      contractRoot: bundle.graph.contractRoot,
      compilerRoot: semanticRoot({ fixture: 'compiler' }),
      verifierRoot: semanticRoot({ fixture: 'verifier' }),
      verificationReceiptRoot: semanticRoot({ fixture: 'verification' }),
      executionAdmissionRequestRoot: semanticRoot({
        fixture: 'execution-admission-request',
      }),
      executionAdmissionDecisionRoot: semanticRoot({
        fixture: 'execution-admission-decision',
      }),
      workRefRoot: semanticRoot({ fixture: 'work-ref' }),
      workVerificationRoot: semanticRoot({ fixture: 'work-verification' }),
      authorizationEvidenceRoots: [
        semanticRoot({ fixture: 'authorization-evidence' }),
      ],
      authorizationVerificationRoot: semanticRoot({
        fixture: 'authorization-verification',
      }),
      executionAdmissionExpiresAt: '2099-01-01T00:00:00Z',
      graphRoot: bundle.graph.graphRoot,
      graphPlanRoot: bundle.plan.planRoot,
      xinfaSelectionRoot: bundle.graph.semanticImpact.selectionRoot,
      currentPlanRoot,
      toolchainRoot,
      eventRoots: bundle.events.map(({ eventRoot }) => eventRoot),
      outputRoots: receipt.outputRoots,
      currentReceiptRoot,
      graphReceiptRoot: receipt.receiptRoot,
      exitStatus: spec.outcome === 'qualified' ? 0 : 7,
      signal: spec.outcome === 'cancelled' ? 'SIGTERM' : null,
      parity: { status: 'pass', classification, issues: [] },
      artifacts: {
        executionAdmissionRequest: '/tmp/execution-admission-request.json',
        executionAdmissionDecision: '/tmp/execution-admission-decision.json',
        events: '/tmp/events.jsonl',
        graphReceipt: '/tmp/graph-receipt.json',
        currentPlan: '/tmp/current-plan.json',
        currentReceipt: '/tmp/current-receipt.json',
        failure: '/tmp/failure.json',
        recovery: '/tmp/recovery.json',
      },
    },
    'receiptRoot',
  );
  return {
    input: {
      graph: bundle.graph,
      plan: bundle.plan,
      events: bundle.events,
      receipt,
      failure: bundle.failure,
      recovery: bundle.recovery,
      shadowReceipt,
      currentPlan,
      currentReceipt,
    },
    observed: {
      source: bundle.graph.source,
      authorityReferences: bundle.graph.authorityReferences,
      xinfaSelectionRoot: bundle.graph.semanticImpact.selectionRoot,
      toolchainRoot,
    },
  };
}

async function feedbackFor(id) {
  const spec = feedbackScenario(id);
  const fixture = feedbackInputFor(spec);
  if (spec.mutation === 'missing-failure') {
    fixture.input.failure = null;
    fixture.input.recovery = null;
  } else if (spec.mutation === 'source-drift') {
    fixture.observed.source = {
      ...fixture.observed.source,
      revision: '9'.repeat(40),
    };
  } else if (spec.mutation === 'authority-drift') {
    fixture.observed.authorityReferences = {
      ...fixture.observed.authorityReferences,
      layers: `sha256:${'9'.repeat(64)}`,
    };
  }
  const feedback = await createProductionGraphFeedback(fixture.input, {
    observed: fixture.observed,
    root: ROOT,
  });
  assert.equal(feedback.state, spec.expectedState);
  return { spec, fixture, feedback };
}

test('Production Graph contract emits one source-bound protected-CI receipt', async () => {
  const receipt = await checkProductionGraphContract();
  assert.equal(receipt.status, 'qualified');
  assert.equal(receipt.validFixtureCount, 3);
  assert.equal(receipt.invalidFixtureCount, 8);
  assert.match(receipt.executionAdmissionReceiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(
    receipt.coreProductionSubgraphReceiptRoot,
    /^sha256:[0-9a-f]{64}$/u,
  );
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
    'schedule',
    'approve',
    'merge',
    'close',
  ]);
  assert.equal(contract.verification.executesNodes, false);
  assert.equal(contract.executionAdmission.nodesStartedByAdmission, false);
  assert.equal(contract.executionAdmission.authorityMutations, false);
  assert.equal(contract.localExecutor.concurrency, 1);
  assert.equal(contract.localExecutor.schedulerAuthority, false);
  assert.equal(contract.localExecutor.workAuthorityMutations, false);
  assert.equal(contract.localExecutor.replayStartsNodes, false);
  for (const authority of [
    'assignment',
    'work-control',
    'warrant',
    'approval',
    'merge-authority',
    'close-authority',
  ]) {
    assert.ok(
      contract.executionAdmission.shifuForbiddenAuthority.includes(
        `mint-${authority}`,
      ),
    );
    assert.ok(
      contract.executionAdmission.shifuForbiddenAuthority.includes(
        `mutate-${authority}`,
      ),
    );
  }
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

test('feedback schema exposes a complete side-effect-free readback', async () => {
  const { feedback } = await feedbackFor('success');
  assert.equal(feedback.state, 'complete');
  assert.equal(feedback.exitCode, 0);
  assert.equal(feedback.sideEffects, false);
  assert.equal(feedback.diagnostics.length, 0);
  assert.equal(feedback.nodes.length, 3);
  const validators = await schemaValidators(ROOT);
  assert.equal(
    validators.feedback(feedback),
    true,
    JSON.stringify(validators.feedback.errors),
  );
});

test('failure can be resume eligible or require a fresh graph', async () => {
  const resumable = await feedbackFor('failure');
  assert.equal(resumable.feedback.state, 'resume-eligible');
  assert.equal(resumable.feedback.recovery.eligible, true);
  assert.equal(
    resumable.feedback.failure.owner,
    'architecture-qualification-owner',
  );

  const restart = await feedbackFor('restart');
  assert.equal(restart.feedback.state, 'restart-required');
  assert.equal(restart.feedback.recovery.eligible, false);
});

test('cancellation requires restart without inventing a current receipt', async () => {
  const { feedback } = await feedbackFor('cancellation');
  assert.equal(feedback.state, 'restart-required');
  assert.equal(feedback.receipts.currentReceiptRoot, null);
  assert.equal(feedback.recovery.eligible, false);
});

test('missing evidence remains an externally blocked inspect decision', async () => {
  const { feedback } = await feedbackFor('missing-evidence');
  assert.equal(feedback.state, 'inspect');
  assert.equal(feedback.recovery.externallyBlocked, true);
  assert.ok(
    feedback.diagnostics.some(({ code }) => code === 'missing-evidence'),
  );
});

test('source and project authority drift fail closed', async () => {
  for (const id of ['source-drift', 'authority-drift']) {
    const { feedback } = await feedbackFor(id);
    assert.equal(feedback.state, 'blocked-by-drift');
    assert.equal(feedback.exitCode, 2);
  }
});

test('graph, selection, plan, toolchain, and retained output drift fail closed', async () => {
  const mutations = [
    (fixture) => {
      fixture.input.shadowReceipt.graphRoot = `sha256:${'8'.repeat(64)}`;
    },
    (fixture) => {
      fixture.input.shadowReceipt.xinfaSelectionRoot = `sha256:${'8'.repeat(64)}`;
    },
    (fixture) => {
      fixture.input.shadowReceipt.graphPlanRoot = `sha256:${'8'.repeat(64)}`;
    },
    (fixture) => {
      fixture.observed.toolchainRoot = `sha256:${'8'.repeat(64)}`;
    },
    (fixture) => {
      fixture.input.shadowReceipt.outputRoots = [`sha256:${'8'.repeat(64)}`];
    },
  ];
  for (const mutate of mutations) {
    const fixture = feedbackInputFor(feedbackScenario('success'));
    mutate(fixture);
    const feedback = await createProductionGraphFeedback(fixture.input, {
      observed: fixture.observed,
      root: ROOT,
    });
    assert.equal(feedback.state, 'blocked-by-drift');
    assert.equal(feedback.exitCode, 2);
  }
});

test('project-independent consumer does not depend on core:affected semantics', async () => {
  const { feedback } = await feedbackFor('project-independent');
  assert.equal(feedback.state, 'complete');
  assert.equal(feedback.nodes[0].executor.task, 'cargo:test');
});

test('human and JSON projections expose the same material facts without bodies', async () => {
  const { feedback } = await feedbackFor('failure');
  const rendered = renderProductionGraphFeedback(feedback);
  for (const value of [
    feedback.state,
    feedback.source.revision,
    feedback.graph.graphRoot,
    feedback.graph.xinfaSelectionRoot,
    feedback.failure.nodeId,
    feedback.failure.owner,
    feedback.parity.classification,
    feedback.nextAction,
  ]) {
    assert.ok(rendered.includes(String(value)), `missing ${value}`);
  }
  assert.equal(rendered.includes('DO_NOT_RENDER'), false);
});
