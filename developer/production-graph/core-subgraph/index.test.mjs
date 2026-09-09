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
import { loadFixture } from '../contract.mjs';
import { localExecutionIdempotencyRoot } from '../executor/index.mjs';
import {
  authoritativeBuildCoreRoute,
  checkCoreProductionSubgraphContract,
  compileCoreProductionSubgraph,
  createCoreProductionSubgraphRequest,
  observeCoreProductionBindings,
} from './index.mjs';
import {
  createCoreStageExecutionGraph,
  createCoreStageExecutorPolicy,
  runCoreProductionSubgraph,
  runInternalCoreProductionStage,
} from './stage-executor/index.mjs';

const ROOT = new URL('../../..', import.meta.url).pathname;
const XINFA_SELECTION_ROOT = `sha256:${'cc'.repeat(32)}`;
const XINFA_VERIFICATION_ROOT = `sha256:${'dd'.repeat(32)}`;
const ADMISSION_FIXTURE =
  'docs/shifu/examples/production-graph/admission/admitted.fixture.json';

function request() {
  return createCoreProductionSubgraphRequest(
    {
      subgraphId: 'project-independent-core-journal',
      xinfaSelectionRoot: XINFA_SELECTION_ROOT,
      xinfaVerificationRoot: XINFA_VERIFICATION_ROOT,
    },
    { root: ROOT },
  );
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function temporaryOutput(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-core-stage-executor-test-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function successResult(nodeId) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    stdout: `${nodeId} succeeded\n`,
    stderr: '',
    outputExceeded: false,
    command: [
      process.execPath,
      'stage-executor.mjs',
      '--internal-stage',
      nodeId,
    ],
    environment: {
      KUNGFU_BUILD_PROFILE: 'journal',
      SHIFU_CORE_SUBGRAPH_STAGE_EXECUTION: 'admitted-v0',
      SHIFU_PRODUCTION_GRAPH_NODE_ID: nodeId,
    },
  };
}

async function admittedStageInput() {
  const core = await compileCoreProductionSubgraph(request(), { root: ROOT });
  const coreVerificationReceipt = await checkCoreProductionSubgraphContract({
    root: ROOT,
  });
  const execution = createCoreStageExecutionGraph(
    core.subgraph,
    core.plan,
    coreVerificationReceipt,
    { root: ROOT },
  );
  const executorPolicy = createCoreStageExecutorPolicy();
  const spec = structuredClone(loadFixture(ROOT, ADMISSION_FIXTURE).request);
  spec.executorPolicyRoot = executorPolicy.executorPolicyRoot;
  const executionAdmissionRequest = materializeExecutionAdmissionFixture(
    execution.graph,
    execution.plan,
    spec,
  );
  const executionAdmissionDecision = (
    await createExecutionAdmissionDecision(executionAdmissionRequest, {
      root: ROOT,
      expected: {
        contractRoot: execution.graph.contractRoot,
        graphRoot: execution.graph.graphRoot,
        planRoot: execution.plan.planRoot,
        sourceRevision: execution.graph.source.revision,
        sourceTree: execution.graph.source.tree,
        authorityReferences: execution.graph.authorityReferences,
        xinfaSelectionRoot: execution.graph.semanticImpact.selectionRoot,
        executorPolicyRoot: executorPolicy.executorPolicyRoot,
      },
    })
  ).decision;
  assert.equal(executionAdmissionDecision.status, 'admitted');
  return {
    input: {
      coreSubgraph: core.subgraph,
      corePlan: core.plan,
      coreVerificationReceipt,
      graph: execution.graph,
      plan: execution.plan,
      verificationReceipt: await checkProductionGraphContract(),
      executionAdmissionRequest,
      executionAdmissionDecision,
      executorPolicy,
    },
    source: {
      revision: git('rev-parse', 'HEAD'),
      tree: git('rev-parse', 'HEAD^{tree}'),
      dirty: false,
    },
  };
}

function stageRunOptions(fixture, outputDir, stageDelegate) {
  return {
    root: ROOT,
    outputDir,
    observedAt: fixture.input.executionAdmissionRequest.observedAt,
    trustedCoreVerificationReceipt: fixture.input.coreVerificationReceipt,
    trustedVerificationReceipt: fixture.input.verificationReceipt,
    source: fixture.source,
    stageDelegate,
  };
}

test('journal Core subgraph compiles to one exact three-stage plan', async () => {
  const compiled = await compileCoreProductionSubgraph(request(), {
    root: ROOT,
  });
  assert.deepEqual(compiled.plan.orderedNodeIds, [
    'dependency-bootstrap',
    'native-build',
    'artifact-stage',
  ]);
  assert.deepEqual(
    compiled.subgraph.nodes.map(({ responsibility }) => responsibility),
    [
      'resolve-and-materialize-native-dependencies',
      'compile-native-core',
      'stage-runtime-artifacts',
    ],
  );
  assert.deepEqual(compiled.subgraph.executionBoundary.command, [
    './shifu',
    'build:core',
  ]);
  assert.deepEqual(compiled.subgraph.executionBoundary.environment, {
    KUNGFU_BUILD_PROFILE: 'journal',
  });
  assert.equal(
    compiled.subgraph.executionBoundary.stagesDirectlyInvocable,
    false,
  );
  assert.equal(
    compiled.subgraph.executionBoundary.compilerExecutesStages,
    false,
  );
  assert.equal(compiled.subgraph.intent.sideEffects, false);
  for (const step of compiled.plan.steps) {
    assert.equal(step.directlyInvocable, false);
  }
});

test('request and reference ordering do not change compiled roots', async () => {
  const firstRequest = request();
  const reordered = structuredClone(firstRequest);
  reordered.stages.reverse();
  for (const stage of reordered.stages) {
    stage.dependencies.reverse();
    stage.inputs.reverse();
    stage.outputs.reverse();
  }
  const first = await compileCoreProductionSubgraph(firstRequest, {
    root: ROOT,
  });
  const second = await compileCoreProductionSubgraph(reordered, {
    root: ROOT,
  });
  assert.equal(first.subgraph.subgraphRoot, second.subgraph.subgraphRoot);
  assert.equal(first.plan.planRoot, second.plan.planRoot);
  assert.deepEqual(first, second);
});

test('each downstream stage consumes the exact upstream declaration root', async () => {
  const { subgraph } = await compileCoreProductionSubgraph(request(), {
    root: ROOT,
  });
  const byId = new Map(subgraph.nodes.map((node) => [node.id, node]));
  const dependencies = byId.get('dependency-bootstrap').outputs[0];
  const native = byId.get('native-build');
  assert.deepEqual(
    native.inputs.find(({ id }) => id === dependencies.id),
    dependencies,
  );
  const nativeArtifacts = native.outputs[0];
  assert.deepEqual(
    byId
      .get('artifact-stage')
      .inputs.find(({ id }) => id === nativeArtifacts.id),
    nativeArtifacts,
  );
});

test('source, toolchain, profile, project authority, and Xinfa are exact roots', async () => {
  const observed = observeCoreProductionBindings(ROOT);
  const source = request();
  const cases = [
    [
      'source-root-mismatch',
      (value) => {
        value.source.root = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'authority-root-drift',
      (value) => {
        value.bindings.toolchainRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'profile-authority-mismatch',
      (value) => {
        value.bindings.buildProfile.root = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'authority-root-drift',
      (value) => {
        value.bindings.projectAuthorityRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
    [
      'xinfa-selection-root-mismatch',
      (value) => {
        value.xinfaVerification.selectionRoot = `sha256:${'e'.repeat(64)}`;
      },
    ],
  ];
  for (const [code, mutate] of cases) {
    const changed = structuredClone(source);
    mutate(changed);
    await assert.rejects(
      compileCoreProductionSubgraph(changed, { root: ROOT, observed }),
      (error) => error?.code === code,
    );
  }
});

test('verification receipt is describe-only and retains the current route', async () => {
  const receipt = await checkCoreProductionSubgraphContract({ root: ROOT });
  const route = authoritativeBuildCoreRoute(ROOT);
  assert.equal(receipt.status, 'qualified');
  assert.equal(receipt.validFixtureCount, 1);
  assert.equal(receipt.invalidFixtureCount, 7);
  assert.equal(receipt.authoritativeRouteRoot, route.routeRoot);
  assert.equal(receipt.nodesExecuted, false);
  assert.equal(receipt.currentRouteUnchanged, true);
});

test('typed stages project to one exact admitted journal slice', async () => {
  const fixture = await admittedStageInput();
  assert.deepEqual(fixture.input.plan.orderedNodeIds, [
    'dependency-bootstrap',
    'native-build',
    'artifact-stage',
  ]);
  assert.deepEqual(
    fixture.input.graph.nodes.map(({ executor }) => executor.task),
    [
      'core-production-subgraph:dependency-bootstrap',
      'core-production-subgraph:native-build',
      'core-production-subgraph:artifact-stage',
    ],
  );
  for (const node of fixture.input.graph.nodes) {
    assert.equal(
      node.inputs.find(({ id }) => id === 'toolchain').root,
      fixture.input.coreSubgraph.bindings.toolchainRoot,
    );
    assert.equal(
      node.inputs.find(({ id }) => id === 'core-subgraph-plan').root,
      fixture.input.corePlan.planRoot,
    );
  }
});

test('internal stage mode requires admitted bindings and delegates one exact stage', () => {
  assert.throws(
    () =>
      runInternalCoreProductionStage(['native-build'], {}, () => assert.fail()),
    /requires exact admitted executor bindings/u,
  );
  const calls = [];
  runInternalCoreProductionStage(
    ['native-build'],
    {
      KUNGFU_BUILD_PROFILE: 'journal',
      SHIFU_CORE_SUBGRAPH_STAGE_EXECUTION: 'admitted-v0',
      SHIFU_PRODUCTION_GRAPH_EXECUTOR_POLICY_ROOT: `sha256:${'ab'.repeat(32)}`,
      SHIFU_PRODUCTION_GRAPH_NODE_ID: 'native-build',
    },
    (stageId) => calls.push(stageId),
  );
  assert.deepEqual(calls, ['native-build']);
});

test('stages execute serially and exact replay starts no process', async (t) => {
  const fixture = await admittedStageInput();
  const calls = [];
  const delegate = async ({ node }) => {
    calls.push(node.id);
    return successResult(node.id);
  };
  const outputDir = temporaryOutput(t);
  const first = await runCoreProductionSubgraph(
    fixture.input,
    stageRunOptions(fixture, outputDir, delegate),
  );
  const second = await runCoreProductionSubgraph(fixture.input, {
    ...stageRunOptions(fixture, outputDir, delegate),
    observedAt: '2100-01-01T00:00:00Z',
  });
  assert.deepEqual(calls, [
    'dependency-bootstrap',
    'native-build',
    'artifact-stage',
  ]);
  assert.equal(first.receipt.status, 'qualified');
  assert.equal(first.receipt.concurrency, 1);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.receipt, first.receipt);
  const evidence = JSON.parse(
    fs.readFileSync(
      path.join(first.runDir, 'native-build.evidence.json'),
      'utf8',
    ),
  );
  assert.deepEqual(evidence.command.slice(-2), [
    '--internal-stage',
    'native-build',
  ]);
  assert.equal(evidence.environment.KUNGFU_BUILD_PROFILE, 'journal');
});

test('failure, timeout, and cancellation skip every dependent stage', async (t) => {
  for (const scenario of [
    { state: 'failed', exitCode: 7 },
    { state: 'timed-out', exitCode: null, signal: 'SIGTERM', timedOut: true },
    { state: 'cancelled', exitCode: null, signal: 'SIGTERM', cancelled: true },
  ]) {
    const fixture = await admittedStageInput();
    const calls = [];
    const result = await runCoreProductionSubgraph(
      fixture.input,
      stageRunOptions(
        fixture,
        path.join(temporaryOutput(t), scenario.state),
        async ({ node }) => {
          calls.push(node.id);
          return {
            ...successResult(node.id),
            exitCode: scenario.exitCode,
            signal: scenario.signal || null,
            timedOut: Boolean(scenario.timedOut),
            cancelled: Boolean(scenario.cancelled),
          };
        },
      ),
    );
    assert.deepEqual(calls, ['dependency-bootstrap']);
    assert.equal(result.receipt.status, scenario.state);
    assert.deepEqual(result.receipt.skippedNodeIds, [
      'native-build',
      'artifact-stage',
    ]);
  }
});

test('binding drift and incomplete prior execution fail before spawn', async (t) => {
  const fixture = await admittedStageInput();
  const mutations = [
    (input) => {
      input.coreSubgraph.source.revision = 'e'.repeat(40);
    },
    (input) => {
      input.coreSubgraph.bindings.toolchainRoot = `sha256:${'ee'.repeat(32)}`;
    },
    (input) => {
      input.coreVerificationReceipt.authoritativeRouteRoot = `sha256:${'ee'.repeat(32)}`;
    },
    (input) => {
      input.graph.nodes[0].executor.task =
        'core-production-subgraph:native-build';
    },
    (input) => {
      input.graph.nodes[0].executor.entrypoint = './shifu';
    },
    (input) => {
      input.executorPolicy.taskEnvironment.KUNGFU_BUILD_PROFILE = 'full';
    },
  ];
  let calls = 0;
  const delegate = async ({ node }) => {
    calls += 1;
    return successResult(node.id);
  };
  for (const mutate of mutations) {
    const drifted = structuredClone(fixture.input);
    mutate(drifted);
    await assert.rejects(
      runCoreProductionSubgraph(
        drifted,
        stageRunOptions(fixture, temporaryOutput(t), delegate),
      ),
      /mismatch|invalid|drift/u,
    );
  }
  const outputDir = temporaryOutput(t);
  fs.mkdirSync(
    path.join(
      outputDir,
      localExecutionIdempotencyRoot(fixture.input).slice('sha256:'.length),
    ),
    { recursive: true },
  );
  await assert.rejects(
    runCoreProductionSubgraph(
      fixture.input,
      stageRunOptions(fixture, outputDir, delegate),
    ),
    /incomplete prior local execution requires explicit inspection/u,
  );
  assert.equal(calls, 0);
});
