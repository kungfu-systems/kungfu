#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
  contractRoot,
  createPlan,
  rooted,
  schemaValidators,
} from '../../contract.mjs';
import {
  executeBoundedCommand,
  runLocalProductionGraph,
} from '../../executor/index.mjs';
import {
  authoritativeBuildCoreRoute,
  checkCoreProductionSubgraphContract,
  compileCoreProductionSubgraph,
  createCoreProductionSubgraphRequest,
  observeCoreProductionBindings,
} from '../index.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const STAGE_IDS = Object.freeze([
  'dependency-bootstrap',
  'native-build',
  'artifact-stage',
]);
const STAGE_TASKS = Object.freeze(
  STAGE_IDS.map((id) => `core-production-subgraph:${id}`),
);
const ENVIRONMENT = Object.freeze({ KUNGFU_BUILD_PROFILE: 'journal' });
const EVENTS = Object.freeze([
  'planned',
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'timed-out',
  'skipped',
]);
const require = createRequire(import.meta.url);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertSame(label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function assertRooted(label, value, field) {
  if (!value?.[field] || rooted(value, field)[field] !== value[field]) {
    throw new Error(`${label} ${field} mismatch`);
  }
}

function referenceKind(kind) {
  return {
    source: 'source',
    toolchain: 'toolchain',
    'build-profile': 'authority',
    authority: 'authority',
    'semantic-selection': 'evidence',
    'stage-output': 'artifact',
  }[kind];
}

function executionNode(stage, typedPlan, coreVerificationReceipt) {
  const step = typedPlan.steps.find(({ nodeId }) => nodeId === stage.id);
  const evidenceInputs = [
    {
      id: 'core-subgraph',
      kind: 'evidence',
      root: typedPlan.subgraphRoot,
    },
    {
      id: 'core-subgraph-plan',
      kind: 'evidence',
      root: typedPlan.planRoot,
    },
    {
      id: 'core-subgraph-verification',
      kind: 'evidence',
      root: coreVerificationReceipt.receiptRoot,
    },
  ];
  return {
    id: stage.id,
    authorityRefs: [
      { authority: 'layers', id: 'core-native-qualification' },
      { authority: 'build-capabilities', id: 'journal' },
    ],
    dependencies: [...stage.dependencies],
    executor: {
      entrypoint: './shifu core-production-subgraph:execute',
      task: `core-production-subgraph:${stage.id}`,
      executionOwnedBy: 'external-orchestrator',
      invokedByVerifier: false,
    },
    inputs: [
      ...stage.inputs.map((input) => ({
        id: input.id,
        kind: referenceKind(input.kind),
        root: input.root,
      })),
      ...evidenceInputs,
    ].sort((left, right) => left.id.localeCompare(right.id)),
    outputs: stage.outputs.map((output) => ({
      id: output.id,
      kind: 'artifact',
      root: output.root,
    })),
    events: [...EVENTS],
    exit: {
      successCodes: [0],
      timeoutSeconds: 3600,
      failureIsNonQualifying: true,
      cancellationIsNonQualifying: true,
    },
    failure: {
      owner: 'core-build-toolchain',
      retainedEvidence: [...step.outputIds],
    },
    recovery: {
      strategy: 'stop',
      nextAction:
        'inspect retained Core stage evidence and request a new admission',
    },
    nextAction: `inspect the admitted ${stage.id} result`,
  };
}

export function createCoreStageExecutionGraph(
  coreSubgraph,
  corePlan,
  coreVerificationReceipt,
  { root = ROOT } = {},
) {
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: `${coreSubgraph.subgraphId}-stage-execution`,
      contractRoot: contractRoot(root),
      source: {
        repository: coreSubgraph.source.repository,
        revision: coreSubgraph.source.revision,
        tree: coreSubgraph.source.tree,
      },
      authorityReferences: {
        layers: coreSubgraph.bindings.layersRoot,
        buildCapabilities: coreSubgraph.bindings.buildCapabilitiesRoot,
      },
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: coreSubgraph.bindings.xinfaSelectionRoot,
        otherInputs: [],
      },
      intent: {
        mode: 'describe-only',
        summary: 'Execute the exact admitted journal Core stage slice',
        requestedOutputs: coreSubgraph.nodes.flatMap((node) =>
          node.outputs.map(({ id }) => id),
        ),
        sideEffects: false,
      },
      nodes: coreSubgraph.nodes.map((stage) =>
        executionNode(stage, corePlan, coreVerificationReceipt),
      ),
      nextAction: 'inspect the bounded Core stage execution receipt',
    },
    'graphRoot',
  );
  return { graph, plan: createPlan(graph) };
}

export function createCoreStageExecutorPolicy() {
  return rooted(
    {
      schema: 'shifu.production-graph-local-executor-policy/v0',
      policyId: 'core-production-subgraph-journal-v0',
      concurrency: 1,
      allowedTasks: [...STAGE_TASKS].sort(),
      taskEnvironment: ENVIRONMENT,
      maxOutputBytes: 1048576,
    },
    'executorPolicyRoot',
  );
}

async function verifyCoreStageInput(
  input,
  { root, validators, trustedCoreVerificationReceipt },
) {
  for (const [label, validate, value] of [
    [
      'Core Production Subgraph',
      validators.coreProductionSubgraph,
      input.coreSubgraph,
    ],
    [
      'Core Production Subgraph plan',
      validators.coreProductionSubgraphPlan,
      input.corePlan,
    ],
    [
      'Core Production Subgraph verification receipt',
      validators.coreProductionSubgraphVerificationReceipt,
      input.coreVerificationReceipt,
    ],
  ]) {
    if (!validate(value)) {
      throw new Error(
        `${label} schema invalid: ${JSON.stringify(validate.errors || [])}`,
      );
    }
  }
  assertRooted('Core Production Subgraph', input.coreSubgraph, 'subgraphRoot');
  assertRooted('Core Production Subgraph plan', input.corePlan, 'planRoot');
  assertRooted(
    'Core Production Subgraph verification receipt',
    input.coreVerificationReceipt,
    'receiptRoot',
  );
  assertSame(
    'Core Production Subgraph trusted verification receipt',
    input.coreVerificationReceipt,
    trustedCoreVerificationReceipt,
  );
  const observed = observeCoreProductionBindings(root);
  const expected = await compileCoreProductionSubgraph(
    createCoreProductionSubgraphRequest(
      {
        subgraphId: input.coreSubgraph.subgraphId,
        xinfaSelectionRoot: input.coreSubgraph.bindings.xinfaSelectionRoot,
        xinfaVerificationRoot: input.coreVerificationReceipt.receiptRoot,
      },
      { root, observed },
    ),
    { root, observed, validators },
  );
  assertSame('Core Production Subgraph', input.coreSubgraph, expected.subgraph);
  assertSame('Core Production Subgraph plan', input.corePlan, expected.plan);
  if (
    input.coreVerificationReceipt.authoritativeRouteRoot !==
    authoritativeBuildCoreRoute(root).routeRoot
  ) {
    throw new Error(
      'Core Production Subgraph authoritative build:core route drifted',
    );
  }
  const projected = createCoreStageExecutionGraph(
    input.coreSubgraph,
    input.corePlan,
    input.coreVerificationReceipt,
    { root },
  );
  assertSame('Core stage execution graph', input.graph, projected.graph);
  assertSame('Core stage execution plan', input.plan, projected.plan);
  assertSame(
    'Core stage executor policy',
    input.executorPolicy,
    createCoreStageExecutorPolicy(),
  );
}

export async function executeCoreProductionStage(options) {
  const handler = path.join(
    options.root,
    'developer/production-graph/core-subgraph/stage-executor/index.mjs',
  );
  return executeBoundedCommand({
    ...options,
    command: [process.execPath, handler, '--internal-stage', options.node.id],
    environment: {
      SHIFU_CORE_SUBGRAPH_STAGE_EXECUTION: 'admitted-v0',
      SHIFU_PRODUCTION_GRAPH_EXECUTOR_POLICY_ROOT:
        options.policy.executorPolicyRoot,
      SHIFU_PRODUCTION_GRAPH_NODE_ID: options.node.id,
    },
  });
}

export function runInternalCoreProductionStage(
  argv,
  environment = process.env,
  runner = null,
) {
  if (argv.length !== 1 || !STAGE_IDS.includes(argv[0])) {
    throw new Error('one exact Core Production Subgraph stage is required');
  }
  if (
    environment.KUNGFU_BUILD_PROFILE !== 'journal' ||
    environment.SHIFU_CORE_SUBGRAPH_STAGE_EXECUTION !== 'admitted-v0' ||
    !/^sha256:[0-9a-f]{64}$/u.test(
      environment.SHIFU_PRODUCTION_GRAPH_EXECUTOR_POLICY_ROOT || '',
    ) ||
    environment.SHIFU_PRODUCTION_GRAPH_NODE_ID !== argv[0]
  ) {
    throw new Error(
      'Core Production Subgraph stage requires exact admitted executor bindings',
    );
  }
  const runStage =
    runner ||
    require(path.join(ROOT, 'framework/core/.gyp/run-build.js'))
      .runProductionStage;
  runStage(argv[0]);
}

export async function runCoreProductionSubgraph(
  input,
  {
    root = ROOT,
    validators = null,
    trustedCoreVerificationReceipt = null,
    trustedVerificationReceipt = null,
    stageDelegate = executeCoreProductionStage,
    ...options
  } = {},
) {
  const checks = validators || (await schemaValidators(root));
  const trustedCoreReceipt =
    trustedCoreVerificationReceipt ||
    (await checkCoreProductionSubgraphContract({ root, validators: checks }));
  const trustedGraphReceipt =
    trustedVerificationReceipt ||
    (await import('../../check.mjs')).checkProductionGraphContract();
  await verifyCoreStageInput(input, {
    root,
    validators: checks,
    trustedCoreVerificationReceipt: trustedCoreReceipt,
  });
  return runLocalProductionGraph(input, {
    ...options,
    root,
    validators: checks,
    delegate: stageDelegate,
    trustedVerificationReceipt: await trustedGraphReceipt,
  });
}

function parseArgs(argv) {
  const fields = new Set([
    'core-subgraph',
    'core-plan',
    'core-verification-receipt',
    'graph',
    'plan',
    'verification-receipt',
    'execution-admission-request',
    'execution-admission-decision',
    'executor-policy',
    'output-dir',
  ]);
  const options = { execute: false, 'output-dir': '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg.startsWith('--') && fields.has(arg.slice(2))) {
      options[arg.slice(2)] = argv[++index] || '';
    } else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of [...fields].filter((field) => field !== 'output-dir')) {
    if (!options[field]) throw new Error(`--${field} is required`);
  }
  if (!options.execute)
    throw new Error('--execute is required for Core stage execution');
  return options;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--internal-stage') {
    runInternalCoreProductionStage(argv.slice(1));
    return;
  }
  const options = parseArgs(argv);
  const input = {
    coreSubgraph: readJson(path.resolve(options['core-subgraph'])),
    corePlan: readJson(path.resolve(options['core-plan'])),
    coreVerificationReceipt: readJson(
      path.resolve(options['core-verification-receipt']),
    ),
    graph: readJson(path.resolve(options.graph)),
    plan: readJson(path.resolve(options.plan)),
    verificationReceipt: readJson(
      path.resolve(options['verification-receipt']),
    ),
    executionAdmissionRequest: readJson(
      path.resolve(options['execution-admission-request']),
    ),
    executionAdmissionDecision: readJson(
      path.resolve(options['execution-admission-decision']),
    ),
    executorPolicy: readJson(path.resolve(options['executor-policy'])),
  };
  const result = await runCoreProductionSubgraph(input, {
    outputDir: options['output-dir'],
    trustedCoreVerificationReceipt: await checkCoreProductionSubgraphContract(),
  });
  console.log(
    `[core-production-subgraph-stage-executor] receipt=${result.receiptPath} replayed=${result.replayed}`,
  );
  if (result.receipt.status === 'cancelled') process.exitCode = 130;
  else if (result.receipt.status === 'timed-out') process.exitCode = 124;
  else if (result.receipt.status !== 'qualified') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[core-production-subgraph-stage-executor] ${error.message}`);
    process.exitCode = 1;
  });
}

export { ENVIRONMENT, STAGE_IDS, STAGE_TASKS };
