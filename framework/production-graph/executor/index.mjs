#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createExecutionAdmissionDecision } from '../admission/index.mjs';
import {
  canonicalJson,
  contractRoot,
  createPlan,
  fileRoot,
  rooted,
  schemaValidators,
  semanticRoot,
} from '../contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});
const BUILD_CORE_TASK = 'build:core';
const BUILD_CORE_ENVIRONMENT = Object.freeze({
  KUNGFU_BUILD_PROFILE: 'journal',
});
const CORE_STAGE_IDS = Object.freeze([
  'dependency-bootstrap',
  'native-build',
  'artifact-stage',
]);
const CORE_STAGE_TASKS = Object.freeze(
  CORE_STAGE_IDS.map((id) => `core-production-subgraph:${id}`),
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`;
  writeJson(temporary, value);
  fs.renameSync(temporary, file);
}

function git(root, ...args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function currentSource(root) {
  return {
    revision: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    dirty: git(root, 'status', '--porcelain').length > 0,
  };
}

function currentAuthority(root) {
  return Object.fromEntries(
    Object.entries(AUTHORITY_PATHS).map(([kind, relative]) => [
      kind,
      fileRoot(path.join(root, relative)),
    ]),
  );
}

function assertSchema(label, validate, value) {
  if (!validate(value)) {
    throw new Error(
      `${label} schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
  }
}

function assertRooted(label, value, field) {
  if (!value?.[field] || rooted(value, field)[field] !== value[field]) {
    throw new Error(`${label} ${field} mismatch`);
  }
}

function assertSame(label, actual, expected) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function unique(values) {
  return [...new Set(values)];
}

function expectedAdmission(input) {
  return {
    contractRoot: input.graph.contractRoot,
    graphRoot: input.graph.graphRoot,
    planRoot: input.plan.planRoot,
    sourceRevision: input.graph.source.revision,
    sourceTree: input.graph.source.tree,
    authorityReferences: input.graph.authorityReferences,
    xinfaSelectionRoot: input.graph.semanticImpact.selectionRoot,
    executorPolicyRoot: input.executorPolicy.executorPolicyRoot,
  };
}

export function localExecutionIdempotencyRoot(input) {
  return semanticRoot({
    schema: 'shifu.production-graph-local-execution-idempotency/v0',
    sourceRevision: input.graph.source.revision,
    sourceTree: input.graph.source.tree,
    graphRoot: input.graph.graphRoot,
    planRoot: input.plan.planRoot,
    executorPolicyRoot: input.executorPolicy.executorPolicyRoot,
    executionAdmissionRequestRoot: input.executionAdmissionRequest.requestRoot,
    executionAdmissionDecisionRoot:
      input.executionAdmissionDecision.decisionRoot,
    intendedNodeIds: input.plan.orderedNodeIds,
  });
}

export async function verifyLocalExecutionInput(
  input,
  {
    root = ROOT,
    validators = null,
    trustedVerificationReceipt = input.verificationReceipt,
    source = null,
  } = {},
) {
  const checks = validators || (await schemaValidators(root));
  for (const [label, validate, value] of [
    ['Production Graph', checks.graph, input.graph],
    ['Production Graph plan', checks.plan, input.plan],
    [
      'Production Graph verification receipt',
      checks.verificationReceipt,
      input.verificationReceipt,
    ],
    [
      'Production Graph execution admission request',
      checks.executionAdmissionRequest,
      input.executionAdmissionRequest,
    ],
    [
      'Production Graph execution admission decision',
      checks.executionAdmissionDecision,
      input.executionAdmissionDecision,
    ],
    [
      'Production Graph local executor policy',
      checks.localExecutorPolicy,
      input.executorPolicy,
    ],
  ]) {
    assertSchema(label, validate, value);
  }
  for (const [label, value, field] of [
    ['Production Graph', input.graph, 'graphRoot'],
    ['Production Graph plan', input.plan, 'planRoot'],
    [
      'Production Graph verification receipt',
      input.verificationReceipt,
      'receiptRoot',
    ],
    [
      'Production Graph execution admission request',
      input.executionAdmissionRequest,
      'requestRoot',
    ],
    [
      'Production Graph execution admission decision',
      input.executionAdmissionDecision,
      'decisionRoot',
    ],
    [
      'Production Graph local executor policy',
      input.executorPolicy,
      'executorPolicyRoot',
    ],
  ]) {
    assertRooted(label, value, field);
  }
  assertSame(
    'Production Graph verification receipt root',
    input.verificationReceipt,
    trustedVerificationReceipt,
  );

  const observed = source || currentSource(root);
  if (observed.dirty) {
    throw new Error(
      'Production Graph local execution requires a clean checkout',
    );
  }
  if (
    input.graph.source.revision !== observed.revision ||
    input.graph.source.tree !== observed.tree
  ) {
    throw new Error('Production Graph source is stale');
  }
  if (
    input.verificationReceipt.sourceRevision !== observed.revision ||
    input.verificationReceipt.nodesExecuted !== false
  ) {
    throw new Error('Production Graph verification receipt is stale or unsafe');
  }
  const currentContract = contractRoot(root);
  if (
    input.graph.contractRoot !== currentContract ||
    input.plan.contractRoot !== currentContract ||
    input.verificationReceipt.contractRoot !== currentContract
  ) {
    throw new Error('Production Graph contract root mismatch');
  }
  const authority = currentAuthority(root);
  assertSame(
    'Production Graph authority roots',
    input.graph.authorityReferences,
    authority,
  );
  assertSame(
    'Production Graph plan authority roots',
    input.plan.authorityReferences,
    authority,
  );
  assertSame(
    'Production Graph verification authority roots',
    input.verificationReceipt.authorityReferences,
    authority,
  );
  assertSame(
    'Production Graph compiled plan',
    input.plan,
    createPlan(input.graph),
  );
  assertSame(
    'Production Graph execution admission graph',
    input.executionAdmissionRequest.graph,
    input.graph,
  );
  assertSame(
    'Production Graph execution admission plan',
    input.executionAdmissionRequest.plan,
    input.plan,
  );
  if (
    input.executionAdmissionRequest.executorPolicyRoot !==
    input.executorPolicy.executorPolicyRoot
  ) {
    throw new Error('Production Graph executor policy root mismatch');
  }
  const sortedTasks = [...input.executorPolicy.allowedTasks].sort();
  assertSame(
    'Production Graph executor policy task order',
    input.executorPolicy.allowedTasks,
    sortedTasks,
  );
  const allowed = new Set(sortedTasks);
  const taskEnvironment = input.executorPolicy.taskEnvironment || {};
  if (
    allowed.has(BUILD_CORE_TASK) &&
    (input.graph.nodes.length !== 1 ||
      canonicalJson(taskEnvironment) !== canonicalJson(BUILD_CORE_ENVIRONMENT))
  ) {
    throw new Error(
      'Production Graph build:core execution is not the bounded journal slice',
    );
  }
  if (CORE_STAGE_TASKS.some((task) => allowed.has(task))) {
    const byId = new Map(input.graph.nodes.map((node) => [node.id, node]));
    const exactStages =
      input.graph.nodes.length === CORE_STAGE_IDS.length &&
      CORE_STAGE_IDS.every(
        (id, index) =>
          byId.get(id)?.executor.task === CORE_STAGE_TASKS[index] &&
          canonicalJson(byId.get(id)?.dependencies || []) ===
            canonicalJson(index === 0 ? [] : [CORE_STAGE_IDS[index - 1]]),
      );
    if (
      !exactStages ||
      canonicalJson(sortedTasks) !==
        canonicalJson([...CORE_STAGE_TASKS].sort()) ||
      canonicalJson(taskEnvironment) !== canonicalJson(BUILD_CORE_ENVIRONMENT)
    ) {
      throw new Error(
        'Production Graph Core stage execution is not the exact journal subgraph slice',
      );
    }
  }
  for (const node of input.graph.nodes) {
    const coreStage = CORE_STAGE_TASKS.includes(node.executor.task);
    if (
      node.executor.entrypoint !==
        (coreStage ? './shifu core-production-subgraph:execute' : './shifu') ||
      node.executor.executionOwnedBy !== 'external-orchestrator' ||
      node.executor.invokedByVerifier !== false ||
      !allowed.has(node.executor.task)
    ) {
      throw new Error(
        `Production Graph node ${node.id} is not allowed by the local executor policy`,
      );
    }
  }
  if (
    input.graph.intent.mode !== 'describe-only' ||
    input.graph.intent.sideEffects !== false
  ) {
    throw new Error(
      'Production Graph description cannot grant execution authority',
    );
  }
  const recomputed = await createExecutionAdmissionDecision(
    input.executionAdmissionRequest,
    { root, expected: expectedAdmission(input), validators: checks },
  );
  if (recomputed.decision.status !== 'admitted') {
    throw new Error(
      `Production Graph execution admission rejected: ${recomputed.verification.codes.join(', ')}`,
    );
  }
  assertSame(
    'Production Graph execution admission decision',
    input.executionAdmissionDecision,
    recomputed.decision,
  );
  if (
    input.executionAdmissionDecision.nodesStarted !== false ||
    input.executionAdmissionDecision.authorityMutations.length !== 0 ||
    canonicalJson(input.executionAdmissionDecision.intendedNodeIds) !==
      canonicalJson(input.plan.orderedNodeIds)
  ) {
    throw new Error('Production Graph execution admission is unsafe');
  }
  return {
    ...input,
    source: observed,
    validators: checks,
    idempotencyRoot: localExecutionIdempotencyRoot(input),
  };
}

function ensureLiveAdmission(admission, observedAt) {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) {
    throw new Error('Production Graph execution observation is invalid');
  }
  if (Date.parse(admission.expiresAt) <= observed) {
    throw new Error('Production Graph execution admission is expired');
  }
}

function boundedOutputRoot(requested, idempotencyRoot, root) {
  const base = path.resolve(
    requested ||
      path.join(os.tmpdir(), 'kungfu-production-graph-local-executor'),
  );
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, base);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'local executor artifacts must use a bounded OS temporary root',
    );
  }
  const repository = path.resolve(root);
  if (base === repository || base.startsWith(`${repository}${path.sep}`)) {
    throw new Error(
      'local executor artifacts cannot be written into the repository',
    );
  }
  return path.join(base, idempotencyRoot.slice('sha256:'.length));
}

function bufferCollector(limit) {
  const chunks = [];
  let size = 0;
  let exceeded = false;
  return {
    append(chunk) {
      if (exceeded) return;
      const bytes = Buffer.from(chunk);
      if (size + bytes.length > limit) {
        exceeded = true;
        return;
      }
      chunks.push(bytes);
      size += bytes.length;
    },
    value() {
      return Buffer.concat(chunks).toString('utf8');
    },
    get exceeded() {
      return exceeded;
    },
  };
}

export async function executeBoundedCommand({
  root,
  node,
  policy,
  runDir,
  signal,
  command,
  environment = {},
}) {
  const stdout = bufferCollector(policy.maxOutputBytes);
  const stderr = bufferCollector(policy.maxOutputBytes);
  const counterPath = path.join(runDir, `${node.id}.counter`);
  const fixtureEnvironment = node.executor.task.startsWith(
    'production-graph:fixture:',
  )
    ? {
        SHIFU_PRODUCTION_GRAPH_NODE_ID: node.id,
        SHIFU_PRODUCTION_GRAPH_FIXTURE_COUNTER: counterPath,
      }
    : {};
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: {
      ...process.env,
      ...(policy.taskEnvironment || {}),
      ...fixtureEnvironment,
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  child.stdout.on('data', (chunk) => stdout.append(chunk));
  child.stderr.on('data', (chunk) => stderr.append(chunk));
  let timedOut = false;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    if (!child.killed) child.kill('SIGTERM');
  };
  if (signal) signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    if (!child.killed) child.kill('SIGTERM');
  }, node.exit.timeoutSeconds * 1000);
  try {
    return await new Promise((resolve) => {
      child.once('error', (error) =>
        resolve({
          exitCode: 1,
          signal: null,
          timedOut,
          cancelled,
          stdout: stdout.value(),
          stderr: `${stderr.value()}${error.message}`,
          outputExceeded: stdout.exceeded || stderr.exceeded,
          command,
          environment: {
            ...(policy.taskEnvironment || {}),
            ...environment,
          },
        }),
      );
      child.once('close', (exitCode, childSignal) =>
        resolve({
          exitCode,
          signal: childSignal,
          timedOut,
          cancelled,
          stdout: stdout.value(),
          stderr: stderr.value(),
          outputExceeded: stdout.exceeded || stderr.exceeded,
          command,
          environment: {
            ...(policy.taskEnvironment || {}),
            ...environment,
          },
        }),
      );
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', stop);
  }
}

async function executeNode(options) {
  return executeBoundedCommand({
    ...options,
    command: [path.join(options.root, 'shifu'), options.node.executor.task],
  });
}

function eventFor(admitted, node, sequence, state, outputRoots, failureRoot) {
  return rooted(
    {
      schema: 'shifu.production-graph-execution-event/v0',
      graphRoot: admitted.graph.graphRoot,
      planRoot: admitted.plan.planRoot,
      nodeId: node.id,
      sequence,
      state,
      executor: node.executor,
      sourceRevision: admitted.graph.source.revision,
      observedOutputRoots: outputRoots,
      failureRoot,
    },
    'eventRoot',
  );
}

function failureFor(
  admitted,
  node,
  classification,
  evidenceRoots,
  recoverable,
) {
  return rooted(
    {
      schema: 'shifu.production-graph-failure/v0',
      graphRoot: admitted.graph.graphRoot,
      planRoot: admitted.plan.planRoot,
      nodeId: node.id,
      classification,
      owner: node.failure.owner,
      evidenceRoots: unique(evidenceRoots),
      recoverable,
      nextAction: node.recovery.nextAction,
    },
    'failureRoot',
  );
}

function resultState(node, result) {
  if (result.outputExceeded) return 'failed';
  if (result.timedOut) return 'timed-out';
  if (result.cancelled || result.signal) return 'cancelled';
  return node.exit.successCodes.includes(result.exitCode)
    ? 'succeeded'
    : 'failed';
}

function receiptStatus(results) {
  for (const state of ['cancelled', 'timed-out', 'failed']) {
    if (results.some((result) => result.state === state)) return state;
  }
  return 'qualified';
}

function verifyStoredReceipt(receipt, admitted) {
  assertSchema(
    'Production Graph local execution receipt',
    admitted.validators.localExecutionReceipt,
    receipt,
  );
  assertRooted(
    'Production Graph local execution receipt',
    receipt,
    'receiptRoot',
  );
  for (const [field, expected] of [
    ['contractRoot', admitted.graph.contractRoot],
    ['graphRoot', admitted.graph.graphRoot],
    ['planRoot', admitted.plan.planRoot],
    ['sourceRevision', admitted.graph.source.revision],
    ['sourceTree', admitted.graph.source.tree],
    ['executorPolicyRoot', admitted.executorPolicy.executorPolicyRoot],
    [
      'executionAdmissionRequestRoot',
      admitted.executionAdmissionRequest.requestRoot,
    ],
    [
      'executionAdmissionDecisionRoot',
      admitted.executionAdmissionDecision.decisionRoot,
    ],
    ['idempotencyRoot', admitted.idempotencyRoot],
  ]) {
    if (receipt[field] !== expected) {
      throw new Error(`stored local execution receipt ${field} mismatch`);
    }
  }
}

export async function runLocalProductionGraph(
  input,
  {
    root = ROOT,
    outputDir = '',
    observedAt = new Date().toISOString(),
    trustedVerificationReceipt = input.verificationReceipt,
    validators = null,
    source = null,
    delegate = executeNode,
    signal = null,
  } = {},
) {
  const admitted = await verifyLocalExecutionInput(input, {
    root,
    validators,
    trustedVerificationReceipt,
    source,
  });
  const runDir = boundedOutputRoot(outputDir, admitted.idempotencyRoot, root);
  const receiptPath = path.join(runDir, 'receipt.json');
  if (fs.existsSync(receiptPath)) {
    const receipt = readJson(receiptPath);
    verifyStoredReceipt(receipt, admitted);
    return { receipt, receiptPath, runDir, replayed: true };
  }
  if (fs.existsSync(runDir)) {
    throw new Error(
      'incomplete prior local execution requires explicit inspection',
    );
  }
  ensureLiveAdmission(admitted.executionAdmissionDecision, observedAt);
  fs.mkdirSync(path.dirname(runDir), { recursive: true });
  fs.mkdirSync(runDir);

  const nodes = new Map(admitted.graph.nodes.map((node) => [node.id, node]));
  const events = [];
  const failures = [];
  const nodeResults = [];
  const byNode = new Map();
  let graphStopped = false;
  let graphCancelled = false;
  for (const step of admitted.plan.steps) {
    const node = nodes.get(step.nodeId);
    const dependencyResults = step.dependsOn.map((id) => byNode.get(id));
    const blocked = dependencyResults.some(
      (result) => !result || result.state !== 'succeeded',
    );
    if (graphStopped || blocked || signal?.aborted) {
      if (!graphStopped && !blocked && signal?.aborted) graphCancelled = true;
      const evidenceRoots = unique(
        dependencyResults
          .filter(Boolean)
          .flatMap((result) => [result.failureRoot, result.evidenceRoot])
          .filter(Boolean),
      );
      if (!evidenceRoots.length) {
        evidenceRoots.push(
          semanticRoot({
            graphRoot: admitted.graph.graphRoot,
            nodeId: node.id,
            reason: graphStopped || signal?.aborted ? 'stopped' : 'dependency',
          }),
        );
      }
      const failure = failureFor(
        admitted,
        node,
        'dependency-skipped',
        evidenceRoots,
        false,
      );
      failures.push(failure);
      const evidenceRoot = semanticRoot({
        nodeId: node.id,
        state: 'skipped',
        failureRoot: failure.failureRoot,
      });
      const result = {
        nodeId: node.id,
        state: 'skipped',
        started: false,
        exitCode: null,
        signal: null,
        outputRoot: null,
        failureRoot: failure.failureRoot,
        evidenceRoot,
        retryEligible: false,
      };
      nodeResults.push(result);
      byNode.set(node.id, result);
      events.push(
        eventFor(
          admitted,
          node,
          events.length,
          'skipped',
          [],
          failure.failureRoot,
        ),
      );
      continue;
    }

    events.push(eventFor(admitted, node, events.length, 'started', [], null));
    const execution = await delegate({
      root,
      node,
      policy: admitted.executorPolicy,
      runDir,
      signal,
    });
    const state = resultState(node, execution);
    if (state === 'cancelled' || state === 'timed-out') graphStopped = true;
    const outputRoot = semanticRoot({
      nodeId: node.id,
      state,
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdoutRoot: semanticRoot(execution.stdout || ''),
      stderrRoot: semanticRoot(execution.stderr || ''),
    });
    const stdoutRoot = semanticRoot(execution.stdout || '');
    const stderrRoot = semanticRoot(execution.stderr || '');
    const evidence = {
      schema: 'shifu.production-graph-node-execution-evidence/v0',
      graphRoot: admitted.graph.graphRoot,
      planRoot: admitted.plan.planRoot,
      nodeId: node.id,
      command: execution.command || ['./shifu', node.executor.task],
      environment: Object.fromEntries(
        Object.entries(
          execution.environment ||
            admitted.executorPolicy.taskEnvironment ||
            {},
        ).sort(([left], [right]) => left.localeCompare(right)),
      ),
      state,
      exitCode: execution.exitCode,
      signal: execution.signal,
      timedOut: Boolean(execution.timedOut),
      cancelled: Boolean(execution.cancelled),
      outputExceeded: Boolean(execution.outputExceeded),
      stdoutRoot,
      stderrRoot,
      outputRoot,
    };
    const evidenceRoot = semanticRoot(evidence);
    fs.writeFileSync(
      path.join(runDir, `${node.id}.stdout.log`),
      execution.stdout || '',
    );
    fs.writeFileSync(
      path.join(runDir, `${node.id}.stderr.log`),
      execution.stderr || '',
    );
    writeJson(path.join(runDir, `${node.id}.evidence.json`), {
      ...evidence,
      evidenceRoot,
    });
    const recoverable =
      state !== 'succeeded' && node.recovery.strategy !== 'stop';
    let failure = null;
    if (state !== 'succeeded') {
      const classification =
        state === 'timed-out'
          ? 'timed-out'
          : state === 'cancelled'
            ? 'cancelled'
            : execution.outputExceeded
              ? 'invalid-output'
              : 'executor-failed';
      failure = failureFor(
        admitted,
        node,
        classification,
        [evidenceRoot],
        recoverable,
      );
      failures.push(failure);
    }
    const result = {
      nodeId: node.id,
      state,
      started: true,
      exitCode: execution.exitCode,
      signal: execution.signal,
      outputRoot: state === 'succeeded' ? outputRoot : null,
      failureRoot: failure?.failureRoot || null,
      evidenceRoot,
      retryEligible: recoverable,
    };
    nodeResults.push(result);
    byNode.set(node.id, result);
    events.push(
      eventFor(
        admitted,
        node,
        events.length,
        state,
        state === 'succeeded' ? [outputRoot] : [],
        failure?.failureRoot || null,
      ),
    );
  }

  const status = graphCancelled ? 'cancelled' : receiptStatus(nodeResults);
  const retainedEvidenceRoots = unique([
    admitted.executionAdmissionRequest.requestRoot,
    admitted.executionAdmissionDecision.workRefRoot,
    admitted.executionAdmissionDecision.workVerificationRoot,
    ...admitted.executionAdmissionDecision.authorizationEvidenceRoots,
    admitted.executionAdmissionDecision.authorizationVerificationRoot,
    admitted.executionAdmissionDecision.decisionRoot,
    admitted.executorPolicy.executorPolicyRoot,
    ...nodeResults.map(({ evidenceRoot }) => evidenceRoot),
  ]);
  const receipt = rooted(
    {
      schema: 'shifu.production-graph-local-execution-receipt/v0',
      status,
      contractRoot: admitted.graph.contractRoot,
      graphRoot: admitted.graph.graphRoot,
      planRoot: admitted.plan.planRoot,
      sourceRevision: admitted.graph.source.revision,
      sourceTree: admitted.graph.source.tree,
      executorPolicyRoot: admitted.executorPolicy.executorPolicyRoot,
      executionAdmissionRequestRoot:
        admitted.executionAdmissionRequest.requestRoot,
      executionAdmissionDecisionRoot:
        admitted.executionAdmissionDecision.decisionRoot,
      executionAdmissionExpiresAt:
        admitted.executionAdmissionDecision.expiresAt,
      idempotencyRoot: admitted.idempotencyRoot,
      concurrency: 1,
      startedNodeIds: nodeResults
        .filter(({ started }) => started)
        .map(({ nodeId }) => nodeId),
      skippedNodeIds: nodeResults
        .filter(({ state }) => state === 'skipped')
        .map(({ nodeId }) => nodeId),
      nodeResults,
      eventRoots: events.map(({ eventRoot }) => eventRoot),
      failureRoots: failures.map(({ failureRoot }) => failureRoot),
      retainedEvidenceRoots,
      nextAction:
        status === 'qualified'
          ? admitted.graph.nextAction
          : failures[0]?.nextAction ||
            'inspect retained local execution evidence',
    },
    'receiptRoot',
  );
  verifyStoredReceipt(receipt, admitted);
  fs.writeFileSync(
    path.join(runDir, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  writeJson(path.join(runDir, 'failures.json'), failures);
  writeJsonAtomic(receiptPath, receipt);
  return { receipt, receiptPath, runDir, replayed: false };
}

function parseArgs(argv) {
  const options = {
    graph: '',
    plan: '',
    verificationReceipt: '',
    executionAdmissionRequest: '',
    executionAdmissionDecision: '',
    executorPolicy: '',
    outputDir: '',
    execute: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--graph') options.graph = argv[++index] || '';
    else if (arg === '--plan') options.plan = argv[++index] || '';
    else if (arg === '--verification-receipt')
      options.verificationReceipt = argv[++index] || '';
    else if (arg === '--execution-admission-request')
      options.executionAdmissionRequest = argv[++index] || '';
    else if (arg === '--execution-admission-decision')
      options.executionAdmissionDecision = argv[++index] || '';
    else if (arg === '--executor-policy')
      options.executorPolicy = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--execute') options.execute = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of [
    'graph',
    'plan',
    'verificationReceipt',
    'executionAdmissionRequest',
    'executionAdmissionDecision',
    'executorPolicy',
  ]) {
    if (!options[field]) {
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`)} is required`,
      );
    }
  }
  if (!options.execute) {
    throw new Error('--execute is required for bounded local execution');
  }
  return options;
}

async function runFixture(profile) {
  const nodeId = process.env.SHIFU_PRODUCTION_GRAPH_NODE_ID || 'unknown';
  const counter = process.env.SHIFU_PRODUCTION_GRAPH_FIXTURE_COUNTER || '';
  if (counter) fs.appendFileSync(counter, `${nodeId}\n`);
  if (profile === 'success') {
    console.log(JSON.stringify({ nodeId, status: 'succeeded' }));
  } else if (profile === 'failure') {
    console.error(JSON.stringify({ nodeId, status: 'failed' }));
    process.exitCode = 7;
  } else if (profile === 'delay') {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(JSON.stringify({ nodeId, status: 'succeeded-after-delay' }));
  } else {
    throw new Error(`unknown Production Graph fixture profile: ${profile}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--fixture') {
    await runFixture(argv[1] || '');
    return;
  }
  const options = parseArgs(argv);
  const input = {
    graph: readJson(path.resolve(options.graph)),
    plan: readJson(path.resolve(options.plan)),
    verificationReceipt: readJson(path.resolve(options.verificationReceipt)),
    executionAdmissionRequest: readJson(
      path.resolve(options.executionAdmissionRequest),
    ),
    executionAdmissionDecision: readJson(
      path.resolve(options.executionAdmissionDecision),
    ),
    executorPolicy: readJson(path.resolve(options.executorPolicy)),
  };
  const verifier = await import('../check.mjs');
  const trustedVerificationReceipt =
    await verifier.checkProductionGraphContract();
  const result = await runLocalProductionGraph(input, {
    outputDir: options.outputDir,
    trustedVerificationReceipt,
  });
  console.log(
    `[production-graph-local-executor] receipt=${result.receiptPath} replayed=${result.replayed}`,
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
    console.error(`[production-graph-local-executor] ${error.message}`);
    process.exitCode = 1;
  });
}
