#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createExecutionAdmissionDecision } from '../admission/index.mjs';
import {
  checkProductionGraphContract,
  materializeExecutionAdmissionFixture,
} from '../check.mjs';
import {
  canonicalJson,
  contractRoot,
  createPlan,
  fileRoot,
  loadFixture,
  rooted,
  schemaValidators,
  semanticRoot,
} from '../contract.mjs';
import {
  runLocalProductionGraph,
  verifyLocalExecutionInput,
} from '../executor/index.mjs';
import {
  settleBuildResult,
  verifyBuildResultBundle,
} from '../result-projection/index.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const ADMISSION_FIXTURE =
  'docs/shifu/examples/production-graph/admission/admitted.fixture.json';
const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});
const AUTHORITY_BOUNDARY = Object.freeze({
  additiveShadowOnly: true,
  conformanceAdmissionOnly: true,
  approves: false,
  merges: false,
  publishes: false,
  releases: false,
  weakensChecks: false,
});
const EXACT_BINDING_FIELDS = Object.freeze([
  'sourceRoot',
  'contractRoot',
  'graphRoot',
  'planRoot',
  'verificationReceiptRoot',
  'executionAdmissionRequestRoot',
  'executionAdmissionDecisionRoot',
  'executorPolicyRoot',
  'nodeSetRoot',
  'eventSetRoot',
  'outputSetRoot',
  'executionReceiptRoot',
  'buildResultProjectionRoot',
  'buildResultSettlementReceiptRoot',
  'resultContractRoot',
]);
const ENVIRONMENT_FIELDS = Object.freeze([
  'platform',
  'architecture',
  'nodeVersion',
]);
const ROOT_DRIFT_CLASSIFICATION = Object.freeze({
  sourceRoot: 'source-drift',
  contractRoot: 'contract-drift',
  graphRoot: 'plan-drift',
  planRoot: 'plan-drift',
  verificationReceiptRoot: 'contract-drift',
  executionAdmissionRequestRoot: 'authority-drift',
  executionAdmissionDecisionRoot: 'authority-drift',
  executorPolicyRoot: 'toolchain-drift',
  nodeSetRoot: 'plan-drift',
  eventSetRoot: 'nondeterminism',
  outputSetRoot: 'output-drift',
  executionReceiptRoot: 'nondeterminism',
  buildResultProjectionRoot: 'output-drift',
  buildResultSettlementReceiptRoot: 'output-drift',
  resultContractRoot: 'contract-drift',
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function observedSource(root) {
  return {
    repository: 'https://github.com/kungfu-systems/kungfu.git',
    revision: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  };
}

function authorityReferences(root) {
  return Object.fromEntries(
    Object.entries(AUTHORITY_PATHS).map(([kind, relative]) => [
      kind,
      fileRoot(path.join(root, relative)),
    ]),
  );
}

function parityNode() {
  return {
    id: 'local-ci-parity-fixture',
    authorityRefs: [{ authority: 'layers', id: 'core-native-qualification' }],
    dependencies: [],
    executor: {
      entrypoint: './shifu',
      task: 'production-graph:fixture:success',
      executionOwnedBy: 'external-orchestrator',
      invokedByVerifier: false,
    },
    inputs: [],
    outputs: [{ id: 'local-ci-parity-output', kind: 'artifact', root: null }],
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
      owner: 'shifu-production-graph',
      retainedEvidence: ['local-ci-parity-output'],
    },
    recovery: {
      strategy: 'retry-node',
      nextAction: 'request a new exact conformance admission and replay',
    },
    nextAction: 'compare the retained protected-CI receipt locally',
  };
}

export async function createParityInput({ root = ROOT, source = null } = {}) {
  const observed = source || observedSource(root);
  const boundSource = {
    repository:
      observed.repository || 'https://github.com/kungfu-systems/kungfu.git',
    revision: observed.revision,
    tree: observed.tree,
  };
  const graph = rooted(
    {
      schema: 'shifu.production-graph/v0',
      graphId: 'local-ci-parity',
      contractRoot: contractRoot(root),
      source: boundSource,
      authorityReferences: authorityReferences(root),
      semanticImpact: {
        owner: 'xinfa',
        selectionRoot: semanticRoot({
          slice: 'production-graph-local-ci-parity',
          nodeIds: ['local-ci-parity-fixture'],
        }),
        otherInputs: [],
      },
      intent: {
        mode: 'describe-only',
        summary:
          'Describe one fixture-safe local and protected-CI parity slice',
        requestedOutputs: ['local-ci-parity-output'],
        sideEffects: false,
      },
      nodes: [parityNode()],
      nextAction: 'compare the retained protected-CI receipt locally',
    },
    'graphRoot',
  );
  const plan = createPlan(graph);
  const executorPolicy = rooted(
    {
      schema: 'shifu.production-graph-local-executor-policy/v0',
      policyId: 'local-ci-parity-fixture-safe-v0',
      concurrency: 1,
      allowedTasks: ['production-graph:fixture:success'],
      maxOutputBytes: 65536,
    },
    'executorPolicyRoot',
  );
  const spec = structuredClone(loadFixture(root, ADMISSION_FIXTURE).request);
  Object.assign(spec, {
    requestId: 'local-ci-parity-conformance',
    assignmentId: 'local-ci-parity-conformance',
    initiativeId: 'production-graph-wave-1-conformance',
    attemptId: 'local-ci-parity-conformance-attempt',
    actor: 'shifu-protected-ci-shadow',
    executorPolicyRoot: executorPolicy.executorPolicyRoot,
  });
  const executionAdmissionRequest = materializeExecutionAdmissionFixture(
    graph,
    plan,
    spec,
  );
  const executionAdmissionDecision = (
    await createExecutionAdmissionDecision(executionAdmissionRequest, {
      root,
      expected: {
        contractRoot: graph.contractRoot,
        graphRoot: graph.graphRoot,
        planRoot: plan.planRoot,
        sourceRevision: graph.source.revision,
        sourceTree: graph.source.tree,
        authorityReferences: graph.authorityReferences,
        xinfaSelectionRoot: graph.semanticImpact.selectionRoot,
        executorPolicyRoot: executorPolicy.executorPolicyRoot,
      },
    })
  ).decision;
  if (executionAdmissionDecision.status !== 'admitted') {
    throw new Error('local-CI conformance admission was rejected');
  }
  return {
    graph,
    plan,
    verificationReceipt: await checkProductionGraphContract(),
    executionAdmissionRequest,
    executionAdmissionDecision,
    executorPolicy,
  };
}

function resultContractRoot(input) {
  return semanticRoot({
    buildResultSchemaRoot: input.verificationReceipt.schemaRoots.buildResult,
    settlementReceiptSchemaRoot:
      input.verificationReceipt.schemaRoots.buildResultSettlementReceipt,
    parityReceiptSchemaRoot:
      input.verificationReceipt.schemaRoots.localCiParityReceipt,
    parityReportSchemaRoot:
      input.verificationReceipt.schemaRoots.localCiParityReport,
  });
}

function bindingsFor(input, executionReceipt, projection, settlementReceipt) {
  return {
    sourceRoot: semanticRoot(input.graph.source),
    contractRoot: input.graph.contractRoot,
    graphRoot: input.graph.graphRoot,
    planRoot: input.plan.planRoot,
    verificationReceiptRoot: input.verificationReceipt.receiptRoot,
    executionAdmissionRequestRoot: input.executionAdmissionRequest.requestRoot,
    executionAdmissionDecisionRoot:
      input.executionAdmissionDecision.decisionRoot,
    executorPolicyRoot: input.executorPolicy.executorPolicyRoot,
    nodeSetRoot: semanticRoot(input.plan.orderedNodeIds),
    eventSetRoot: semanticRoot(executionReceipt.eventRoots),
    outputSetRoot: semanticRoot(projection.outputs),
    executionReceiptRoot: executionReceipt.receiptRoot,
    buildResultProjectionRoot: projection.projectionRoot,
    buildResultSettlementReceiptRoot: settlementReceipt.receiptRoot,
    resultContractRoot: resultContractRoot(input),
  };
}

function environment() {
  return {
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    classification: 'declared-environment-variance',
  };
}

function assertRooted(document, field, label) {
  if (
    !document?.[field] ||
    rooted(document, field)[field] !== document[field]
  ) {
    throw new Error(`${label} ${field} mismatch`);
  }
}

function assertSame(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

export async function verifyParityArtifacts(
  artifactDir,
  { root = ROOT, source = null } = {},
) {
  const input = readJson(path.join(artifactDir, 'input.json'));
  const executionReceipt = readJson(
    path.join(artifactDir, 'execution-receipt.json'),
  );
  const projection = readJson(path.join(artifactDir, 'build-result.json'));
  const settlementReceipt = readJson(
    path.join(artifactDir, 'build-result-settlement-receipt.json'),
  );
  const laneReceipt = readJson(path.join(artifactDir, 'lane-receipt.json'));
  const validators = await schemaValidators(root);
  const validate = validators.localCiParityReceipt;
  if (!validate(laneReceipt)) {
    throw new Error(
      `local-CI parity receipt schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
  }
  assertRooted(laneReceipt, 'receiptRoot', 'local-CI parity receipt');
  assertSame(
    laneReceipt.authorityBoundary,
    AUTHORITY_BOUNDARY,
    'local-CI parity authority boundary',
  );
  await verifyLocalExecutionInput(input, {
    root,
    validators,
    trustedVerificationReceipt: input.verificationReceipt,
    source,
  });
  verifyBuildResultBundle(
    { executionReceipt, projection, settlementReceipt },
    {
      validators,
      expectedExecutionReceiptRoot: executionReceipt.receiptRoot,
    },
  );
  assertSame(
    laneReceipt.bindings,
    bindingsFor(input, executionReceipt, projection, settlementReceipt),
    'local-CI parity bindings',
  );
  return {
    input,
    executionReceipt,
    projection,
    settlementReceipt,
    laneReceipt,
  };
}

export async function runParityLane({
  lane,
  outputDir,
  root = ROOT,
  source = null,
  delegate = null,
  observedEnvironment = null,
} = {}) {
  if (!['local', 'protected-ci'].includes(lane)) {
    throw new Error('lane must be local or protected-ci');
  }
  if (!outputDir) throw new Error('outputDir is required');
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) {
    throw new Error('outputDir must be absent or empty');
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const input = await createParityInput({ root, source });
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-production-graph-local-ci-parity-'),
  );
  try {
    const execution = await runLocalProductionGraph(input, {
      root,
      outputDir: scratch,
      observedAt: input.executionAdmissionRequest.observedAt,
      trustedVerificationReceipt: input.verificationReceipt,
      source,
      ...(delegate ? { delegate } : {}),
    });
    const { projection, settlementReceipt } = await settleBuildResult(
      execution.receipt,
    );
    const laneReceipt = rooted(
      {
        schema: 'shifu.production-graph-local-ci-parity-receipt/v0',
        status: 'qualified',
        lane,
        bindings: bindingsFor(
          input,
          execution.receipt,
          projection,
          settlementReceipt,
        ),
        environment: observedEnvironment || environment(),
        authorityBoundary: AUTHORITY_BOUNDARY,
        nextAction:
          lane === 'protected-ci'
            ? 'download this artifact and replay it from the exact source locally'
            : 'compare this replay with the retained protected-CI artifact',
      },
      'receiptRoot',
    );
    writeJson(path.join(outputDir, 'input.json'), input);
    writeJson(
      path.join(outputDir, 'execution-receipt.json'),
      execution.receipt,
    );
    writeJson(path.join(outputDir, 'build-result.json'), projection);
    writeJson(
      path.join(outputDir, 'build-result-settlement-receipt.json'),
      settlementReceipt,
    );
    writeJson(path.join(outputDir, 'lane-receipt.json'), laneReceipt);
    fs.cpSync(execution.runDir, path.join(outputDir, 'execution'), {
      recursive: true,
    });
    await verifyParityArtifacts(outputDir, { root, source });
    return laneReceipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function compareParityArtifacts({
  protectedCiArtifactDir,
  localArtifactDir,
  outputFile,
  root = ROOT,
  source = null,
} = {}) {
  const protectedCi = await verifyParityArtifacts(protectedCiArtifactDir, {
    root,
    source,
  });
  const local = await verifyParityArtifacts(localArtifactDir, { root, source });
  if (protectedCi.laneReceipt.lane !== 'protected-ci') {
    throw new Error('comparison input is not a protected-CI lane receipt');
  }
  if (local.laneReceipt.lane !== 'local') {
    throw new Error('comparison input is not a local lane receipt');
  }
  const exactBindings = {};
  const rootDrift = [];
  for (const field of EXACT_BINDING_FIELDS) {
    const protectedCiRoot = protectedCi.laneReceipt.bindings[field];
    const localRoot = local.laneReceipt.bindings[field];
    if (protectedCiRoot === localRoot) exactBindings[field] = localRoot;
    else {
      rootDrift.push({
        dimension: field,
        classification: ROOT_DRIFT_CLASSIFICATION[field],
        protectedCi: protectedCiRoot,
        local: localRoot,
      });
    }
  }
  const environmentDrift = ENVIRONMENT_FIELDS.flatMap((dimension) => {
    const protectedCiValue = protectedCi.laneReceipt.environment[dimension];
    const localValue = local.laneReceipt.environment[dimension];
    const nodeMajor = (value) => String(value).replace(/^v/u, '').split('.')[0];
    const classification =
      dimension === 'nodeVersion' &&
      nodeMajor(protectedCiValue) !== nodeMajor(localValue)
        ? 'toolchain-drift'
        : 'declared-environment-variance';
    return protectedCiValue === localValue
      ? []
      : [
          {
            dimension,
            classification,
            protectedCi: protectedCiValue,
            local: localValue,
          },
        ];
  });
  const drift = [...rootDrift, ...environmentDrift];
  const blockingDrift = drift.filter(
    ({ classification }) => classification !== 'declared-environment-variance',
  );
  const status = blockingDrift.length ? 'blocked-by-drift' : 'parity';
  const report = rooted(
    {
      schema: 'shifu.production-graph-local-ci-parity-report/v0',
      status,
      protectedCiReceiptRoot: protectedCi.laneReceipt.receiptRoot,
      localReceiptRoot: local.laneReceipt.receiptRoot,
      exactBindings,
      drift,
      authorityBoundaryRoot: semanticRoot(AUTHORITY_BOUNDARY),
      nextAction: blockingDrift.length
        ? `inspect blocking drift: ${blockingDrift.map(({ dimension }) => dimension).join(', ')}`
        : 'retain this exact local and protected-CI parity report',
    },
    'reportRoot',
  );
  const validators = await schemaValidators(root);
  if (!validators.localCiParityReport(report)) {
    throw new Error(
      `local-CI parity report schema invalid: ${JSON.stringify(validators.localCiParityReport.errors || [])}`,
    );
  }
  if (outputFile) writeJson(outputFile, report);
  return report;
}

function parseArgs(argv) {
  const command = argv[0] || '';
  const options = { command, lane: '', outputDir: '', artifactDir: '' };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lane') options.lane = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--artifact-dir')
      options.artifactDir = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'run') {
    const receipt = await runParityLane({
      lane: options.lane,
      outputDir: path.resolve(options.outputDir),
    });
    console.log(
      `[production-graph-local-ci-parity] lane=${receipt.lane} receipt=${receipt.receiptRoot}`,
    );
    return;
  }
  if (options.command === 'verify') {
    const verified = await verifyParityArtifacts(
      path.resolve(options.artifactDir),
    );
    console.log(
      `[production-graph-local-ci-parity] verified=${verified.laneReceipt.receiptRoot}`,
    );
    return;
  }
  if (options.command === 'replay') {
    const localDir = path.resolve(options.outputDir, 'local');
    const reportFile = path.resolve(options.outputDir, 'parity-report.json');
    await runParityLane({ lane: 'local', outputDir: localDir });
    const report = await compareParityArtifacts({
      protectedCiArtifactDir: path.resolve(options.artifactDir),
      localArtifactDir: localDir,
      outputFile: reportFile,
    });
    console.log(
      `[production-graph-local-ci-parity] status=${report.status} report=${reportFile}`,
    );
    if (report.status !== 'parity') process.exitCode = 1;
    return;
  }
  throw new Error('expected run, verify, or replay');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[production-graph-local-ci-parity] ${error.message}`);
    process.exitCode = 1;
  });
}
