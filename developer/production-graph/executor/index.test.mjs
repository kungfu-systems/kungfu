// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createExecutionAdmissionDecision } from '../admission/index.mjs';
import {
  checkProductionGraphContract,
  materializeExecutionAdmissionFixture,
} from '../check.mjs';
import {
  contractRoot,
  createPlan,
  fileRoot,
  loadFixture,
  rooted,
  semanticRoot,
} from '../contract.mjs';
import { runLocalProductionGraph } from './index.mjs';

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
const ADMISSION_FIXTURE =
  'docs/shifu/examples/production-graph/admission/admitted.fixture.json';

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function node(id, task, dependencies = [], recovery = 'retry-node') {
  return {
    id,
    authorityRefs: [{ authority: 'layers', id: 'core-native-qualification' }],
    dependencies,
    executor: {
      entrypoint: './shifu',
      task,
      executionOwnedBy: 'external-orchestrator',
      invokedByVerifier: false,
    },
    inputs: [],
    outputs: [{ id: `${id}-output`, kind: 'artifact', root: null }],
    events: [
      'planned',
      'started',
      'succeeded',
      'failed',
      'cancelled',
      'timed-out',
      'skipped',
    ],
    exit: {
      successCodes: [0],
      timeoutSeconds: 5,
      failureIsNonQualifying: true,
      cancellationIsNonQualifying: true,
    },
    failure: {
      owner: 'fixture-owner',
      retainedEvidence: ['fixture-output'],
    },
    recovery: {
      strategy: recovery,
      nextAction:
        recovery === 'stop'
          ? 'inspect retained fixture evidence'
          : 'request a new admitted fixture run',
    },
    nextAction: 'inspect the fixture result',
  };
}

async function admittedInput(
  nodes,
  allowedTasks = null,
  taskEnvironment = null,
) {
  const source = {
    repository: 'https://github.com/kungfu-systems/kungfu.git',
    revision: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
  };
  const authorityReferences = {
    layers: fileRoot(
      path.join(ROOT, 'framework/core/architecture/layers.json'),
    ),
    buildCapabilities: fileRoot(
      path.join(ROOT, 'framework/core/architecture/build-capabilities.json'),
    ),
  };
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: 'local-executor-fixture',
      contractRoot: contractRoot(ROOT),
      source,
      authorityReferences,
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: semanticRoot({ fixture: 'local-executor-selection' }),
        otherInputs: [],
      },
      intent: {
        mode: 'describe-only',
        summary: 'Describe fixture-safe local executor coverage',
        requestedOutputs: nodes.map(({ id }) => `${id}-output`),
        sideEffects: false,
      },
      nodes,
      nextAction: 'inspect the deterministic local execution receipt',
    },
    'graphRoot',
  );
  const plan = createPlan(graph);
  const executorPolicy = rooted(
    {
      schema: 'shifu.production-graph-local-executor-policy/v0',
      policyId: 'fixture-safe-local-v0',
      concurrency: 1,
      allowedTasks: [
        ...new Set(allowedTasks || nodes.map(({ executor }) => executor.task)),
      ].sort(),
      ...(taskEnvironment ? { taskEnvironment } : {}),
      maxOutputBytes: 65536,
    },
    'executorPolicyRoot',
  );
  const spec = structuredClone(loadFixture(ROOT, ADMISSION_FIXTURE).request);
  spec.executorPolicyRoot = executorPolicy.executorPolicyRoot;
  const executionAdmissionRequest = materializeExecutionAdmissionFixture(
    graph,
    plan,
    spec,
  );
  const executionAdmissionDecision = (
    await createExecutionAdmissionDecision(executionAdmissionRequest, {
      root: ROOT,
      expected: {
        contractRoot: graph.contractRoot,
        graphRoot: graph.graphRoot,
        planRoot: plan.planRoot,
        sourceRevision: source.revision,
        sourceTree: source.tree,
        authorityReferences,
        xinfaSelectionRoot: graph.semanticImpact.selectionRoot,
        executorPolicyRoot: executorPolicy.executorPolicyRoot,
      },
    })
  ).decision;
  assert.equal(executionAdmissionDecision.status, 'admitted');
  return {
    input: {
      graph,
      plan,
      verificationReceipt: await checkProductionGraphContract(),
      executionAdmissionRequest,
      executionAdmissionDecision,
      executorPolicy,
    },
    source: { ...source, dirty: false },
  };
}

function temporaryOutput(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-production-graph-executor-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function successResult() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: 'fixture success\n',
    stderr: '',
    outputExceeded: false,
  };
}

test('default process executor starts one allowlisted fixture once and replays the exact receipt', async (t) => {
  const fixture = await admittedInput([
    node('one', 'production-graph:fixture:success'),
  ]);
  const outputDir = temporaryOutput(t);
  const first = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir,
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
  });
  const second = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir,
    observedAt: '2100-01-01T00:00:00Z',
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
  });
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.receipt, first.receipt);
  assert.equal(first.receipt.status, 'qualified');
  assert.deepEqual(first.receipt.startedNodeIds, ['one']);
  assert.equal(
    fs.readFileSync(path.join(first.runDir, 'one.counter'), 'utf8'),
    'one\n',
  );
});

test('ready nodes execute in deterministic dependency order with concurrency one', async (t) => {
  const fixture = await admittedInput([
    node('prepare', 'production-graph:fixture:success'),
    node('consume', 'production-graph:fixture:success', ['prepare']),
  ]);
  const calls = [];
  const result = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir: temporaryOutput(t),
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
    delegate: async ({ node: current }) => {
      calls.push(current.id);
      return successResult();
    },
  });
  assert.deepEqual(calls, ['prepare', 'consume']);
  assert.deepEqual(
    result.receipt.nodeResults.map(({ nodeId, state }) => [nodeId, state]),
    [
      ['prepare', 'succeeded'],
      ['consume', 'succeeded'],
    ],
  );
  assert.equal(result.receipt.concurrency, 1);
});

test('one build:core node is admitted only as the bounded journal slice', async (t) => {
  const fixture = await admittedInput(
    [node('build-core-journal', 'build:core')],
    null,
    { KUNGFU_BUILD_PROFILE: 'journal' },
  );
  const calls = [];
  const result = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir: temporaryOutput(t),
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
    delegate: async ({ node: current, policy }) => {
      calls.push({
        nodeId: current.id,
        environment: policy.taskEnvironment,
      });
      return successResult();
    },
  });
  assert.deepEqual(calls, [
    {
      nodeId: 'build-core-journal',
      environment: { KUNGFU_BUILD_PROFILE: 'journal' },
    },
  ]);
  assert.equal(result.receipt.status, 'qualified');
  const evidence = JSON.parse(
    fs.readFileSync(
      path.join(result.runDir, 'build-core-journal.evidence.json'),
      'utf8',
    ),
  );
  assert.deepEqual(evidence.command, ['./shifu', 'build:core']);
  assert.deepEqual(evidence.environment, {
    KUNGFU_BUILD_PROFILE: 'journal',
  });
});

test('build:core policy rejects missing environment and wider task sets', async () => {
  for (const fixture of [
    await admittedInput([node('build-core-journal', 'build:core')]),
    await admittedInput(
      [node('fixture', 'production-graph:fixture:success')],
      null,
      { KUNGFU_BUILD_PROFILE: 'journal' },
    ),
    await admittedInput(
      [
        node('build-core-journal', 'build:core'),
        node('fixture', 'production-graph:fixture:success'),
      ],
      null,
      { KUNGFU_BUILD_PROFILE: 'journal' },
    ),
  ]) {
    await assert.rejects(
      runLocalProductionGraph(fixture.input, {
        root: ROOT,
        trustedVerificationReceipt: fixture.input.verificationReceipt,
        source: fixture.source,
        delegate: async () => successResult(),
      }),
      /local executor policy schema invalid|bounded journal slice/u,
    );
  }
});

test('retry-ineligible failure skips its dependency without a second spawn', async (t) => {
  const fixture = await admittedInput([
    node('fail', 'production-graph:fixture:failure', [], 'stop'),
    node('dependent', 'production-graph:fixture:success', ['fail']),
  ]);
  const calls = [];
  const result = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir: temporaryOutput(t),
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
    delegate: async ({ node: current }) => {
      calls.push(current.id);
      return { ...successResult(), exitCode: 7, stderr: 'fixture failure\n' };
    },
  });
  assert.deepEqual(calls, ['fail']);
  assert.equal(result.receipt.status, 'failed');
  assert.deepEqual(result.receipt.skippedNodeIds, ['dependent']);
  assert.equal(result.receipt.nodeResults[0].retryEligible, false);
  assert.deepEqual(
    result.receipt.nodeResults.map(({ state, started }) => [state, started]),
    [
      ['failed', true],
      ['skipped', false],
    ],
  );
});

test('timeout and cancellation settle deterministically and never start later nodes', async (t) => {
  for (const scenario of [
    {
      id: 'timeout',
      execution: {
        ...successResult(),
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
      },
      status: 'timed-out',
    },
    {
      id: 'cancel',
      execution: {
        ...successResult(),
        exitCode: null,
        signal: 'SIGTERM',
        cancelled: true,
      },
      status: 'cancelled',
    },
  ]) {
    const fixture = await admittedInput([
      node(`${scenario.id}-one`, 'production-graph:fixture:delay'),
      node(`${scenario.id}-two`, 'production-graph:fixture:success'),
    ]);
    const calls = [];
    const result = await runLocalProductionGraph(fixture.input, {
      root: ROOT,
      outputDir: temporaryOutput(t),
      observedAt: fixture.input.executionAdmissionRequest.observedAt,
      trustedVerificationReceipt: fixture.input.verificationReceipt,
      source: fixture.source,
      delegate: async ({ node: current }) => {
        calls.push(current.id);
        return scenario.execution;
      },
    });
    assert.deepEqual(calls, [`${scenario.id}-one`]);
    assert.equal(result.receipt.status, scenario.status);
    assert.deepEqual(result.receipt.skippedNodeIds, [`${scenario.id}-two`]);
  }
});

test('pre-start cancellation skips every node and remains non-qualifying', async (t) => {
  const fixture = await admittedInput([
    node('cancelled-one', 'production-graph:fixture:success'),
    node('cancelled-two', 'production-graph:fixture:success'),
  ]);
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runLocalProductionGraph(fixture.input, {
    root: ROOT,
    outputDir: temporaryOutput(t),
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
    signal: controller.signal,
    delegate: async () => {
      calls += 1;
      return successResult();
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.receipt.status, 'cancelled');
  assert.deepEqual(result.receipt.startedNodeIds, []);
  assert.deepEqual(result.receipt.skippedNodeIds, [
    'cancelled-one',
    'cancelled-two',
  ]);
});

test('invalid or expired admission starts zero nodes', async (t) => {
  const fixture = await admittedInput([
    node('guarded', 'production-graph:fixture:success'),
  ]);
  const replayed = structuredClone(fixture.input);
  replayed.executionAdmissionRequest.authorization.replayState = 'consumed';
  replayed.executionAdmissionRequest.authorization = rooted(
    replayed.executionAdmissionRequest.authorization,
    'verificationRoot',
  );
  replayed.executionAdmissionRequest = rooted(
    replayed.executionAdmissionRequest,
    'requestRoot',
  );
  let calls = 0;
  await assert.rejects(
    runLocalProductionGraph(replayed, {
      root: ROOT,
      outputDir: temporaryOutput(t),
      trustedVerificationReceipt: fixture.input.verificationReceipt,
      source: fixture.source,
      delegate: async () => {
        calls += 1;
        return successResult();
      },
    }),
    /execution admission rejected|execution admission decision mismatch/u,
  );
  await assert.rejects(
    runLocalProductionGraph(fixture.input, {
      root: ROOT,
      outputDir: temporaryOutput(t),
      observedAt: '2100-01-01T00:00:00Z',
      trustedVerificationReceipt: fixture.input.verificationReceipt,
      source: fixture.source,
      delegate: async () => {
        calls += 1;
        return successResult();
      },
    }),
    /execution admission is expired/u,
  );
  assert.equal(calls, 0);
});
