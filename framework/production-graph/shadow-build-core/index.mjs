#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson, rooted, semanticRoot } from '../contract.mjs';
import {
  runLocalProductionGraph,
  verifyLocalExecutionInput,
} from '../executor/index.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const COMMAND = Object.freeze(['./shifu', 'build:core']);
const ENVIRONMENT = Object.freeze({ KUNGFU_BUILD_PROFILE: 'journal' });

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function bufferCollector(limit) {
  const chunks = [];
  let size = 0;
  let exceeded = false;
  return {
    append(chunk) {
      if (exceeded) return;
      const bytes = Buffer.from(chunk);
      if (size + bytes.length > limit) exceeded = true;
      else {
        chunks.push(bytes);
        size += bytes.length;
      }
    },
    value: () => Buffer.concat(chunks).toString('utf8'),
    get exceeded() {
      return exceeded;
    },
  };
}

async function executeAuthoritative({ root, node, policy, signal }) {
  const stdout = bufferCollector(policy.maxOutputBytes);
  const stderr = bufferCollector(policy.maxOutputBytes);
  const child = spawn(path.join(root, 'shifu'), ['build:core'], {
    cwd: root,
    env: { ...process.env, ...ENVIRONMENT },
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
  signal?.addEventListener('abort', stop, { once: true });
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
        }),
      );
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function executionState(result) {
  if (result.timedOut) return 'timed-out';
  if (result.cancelled || result.signal) return 'cancelled';
  return result.exitCode === 0 && !result.outputExceeded
    ? 'succeeded'
    : 'failed';
}

function laneEvidence(nodeId, result) {
  const state = executionState(result);
  const stdoutRoot = semanticRoot(result.stdout || '');
  const stderrRoot = semanticRoot(result.stderr || '');
  const body = {
    command: [...COMMAND],
    environment: { ...ENVIRONMENT },
    state,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: Boolean(result.timedOut),
    cancelled: Boolean(result.cancelled),
    outputExceeded: Boolean(result.outputExceeded),
    stdoutRoot,
    stderrRoot,
    outputRoot: semanticRoot({
      nodeId,
      state,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutRoot,
      stderrRoot,
    }),
  };
  return { ...body, evidenceRoot: semanticRoot(body) };
}

function item(dimension, classification, detail) {
  return { dimension, classification, detail };
}

export function classifyBuildCoreShadow(authoritative, graph) {
  const classifications = [
    item(
      'source',
      'parity',
      'Both lanes use the exact admitted source revision and tree.',
    ),
    item(
      'authority',
      'parity',
      'Both lanes retain the exact admitted project authority roots.',
    ),
    item(
      'graph',
      'parity',
      'The graph lane executes the exact admitted one-node graph.',
    ),
    item(
      'plan',
      'parity',
      'The graph lane executes the exact compiled one-step plan.',
    ),
    item(
      'admission',
      'parity',
      'Both lanes are bounded by the same live execution admission.',
    ),
    item(
      'command',
      canonicalJson(authoritative.command) === canonicalJson(graph.command)
        ? 'parity'
        : 'executor-drift',
      'Compared exact argv for the authoritative and graph lanes.',
    ),
    item(
      'environment',
      canonicalJson(authoritative.environment) ===
        canonicalJson(graph.environment)
        ? 'parity'
        : 'executor-drift',
      'Compared the bounded task environment for both lanes.',
    ),
  ];
  const unsafe =
    authoritative.outputExceeded ||
    graph.outputExceeded ||
    authoritative.timedOut ||
    graph.timedOut ||
    authoritative.cancelled ||
    graph.cancelled;
  classifications.push(
    item(
      'exit',
      unsafe
        ? 'blocker'
        : authoritative.exitCode === graph.exitCode
          ? authoritative.exitCode === 0
            ? 'parity'
            : 'blocker'
          : 'executor-drift',
      'Compared exit codes, signals, timeout, cancellation, and output bounds.',
    ),
  );
  const outputEqual =
    authoritative.stdoutRoot === graph.stdoutRoot &&
    authoritative.stderrRoot === graph.stderrRoot;
  classifications.push(
    item(
      'output',
      unsafe
        ? 'blocker'
        : authoritative.exitCode !== graph.exitCode
          ? 'executor-drift'
          : outputEqual
            ? 'parity'
            : authoritative.exitCode === 0 && graph.exitCode === 0
              ? 'explainable-nondeterminism'
              : 'executor-drift',
      outputEqual
        ? 'Exact stdout and stderr roots match.'
        : 'Exact output roots are retained; successful build progress may differ because of cache state and elapsed-time reporting.',
    ),
    item(
      'receipt',
      graph.evidenceRoot && graph.state === 'succeeded' ? 'parity' : 'blocker',
      'The local executor retained a rooted node evidence record and receipt.',
    ),
  );
  return classifications;
}

function boundedRunDir(requested, idempotencyRoot, root) {
  const base = path.resolve(
    requested || path.join(os.tmpdir(), 'kungfu-build-core-graph-shadow'),
  );
  const temporary = path.resolve(os.tmpdir());
  const relative = path.relative(temporary, base);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'build:core shadow artifacts must use a bounded OS temporary root',
    );
  }
  const repository = path.resolve(root);
  if (base === repository || base.startsWith(`${repository}${path.sep}`)) {
    throw new Error(
      'build:core shadow artifacts cannot be written into the repository',
    );
  }
  return path.join(base, idempotencyRoot.slice('sha256:'.length));
}

function verifyStored(receipt, admitted) {
  const validate = admitted.validators.buildCoreShadowReceipt;
  if (!validate(receipt)) {
    throw new Error(
      `stored build:core shadow receipt schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
  }
  if (rooted(receipt, 'receiptRoot').receiptRoot !== receipt.receiptRoot) {
    throw new Error('stored build:core shadow receipt root mismatch');
  }
  for (const [field, expected] of [
    ['sourceRevision', admitted.graph.source.revision],
    ['sourceTree', admitted.graph.source.tree],
    ['graphRoot', admitted.graph.graphRoot],
    ['planRoot', admitted.plan.planRoot],
    ['executorPolicyRoot', admitted.executorPolicy.executorPolicyRoot],
    [
      'executionAdmissionRequestRoot',
      admitted.executionAdmissionRequest.requestRoot,
    ],
    [
      'executionAdmissionDecisionRoot',
      admitted.executionAdmissionDecision.decisionRoot,
    ],
  ]) {
    if (receipt[field] !== expected)
      throw new Error(`stored build:core shadow receipt ${field} mismatch`);
  }
}

export async function runBuildCoreShadow(
  input,
  {
    root = ROOT,
    outputDir = '',
    observedAt = new Date().toISOString(),
    trustedVerificationReceipt = input.verificationReceipt,
    validators = null,
    source = null,
    authoritativeDelegate = executeAuthoritative,
    graphDelegate = runLocalProductionGraph,
    signal = null,
  } = {},
) {
  const admitted = await verifyLocalExecutionInput(input, {
    root,
    validators,
    trustedVerificationReceipt,
    source,
  });
  const node = admitted.graph.nodes[0];
  if (
    admitted.graph.nodes.length !== 1 ||
    node.dependencies.length !== 0 ||
    node.executor.task !== 'build:core' ||
    canonicalJson(admitted.executorPolicy.taskEnvironment) !==
      canonicalJson(ENVIRONMENT)
  ) {
    throw new Error(
      'build:core shadow requires exactly one dependency-free journal node',
    );
  }
  const idempotencyRoot = semanticRoot({
    schema: 'kungfu.build-core-production-graph-shadow-idempotency/v0',
    localExecutionIdempotencyRoot: admitted.idempotencyRoot,
    command: COMMAND,
    environment: ENVIRONMENT,
  });
  const runDir = boundedRunDir(outputDir, idempotencyRoot, root);
  const receiptPath = path.join(runDir, 'receipt.json');
  if (fs.existsSync(receiptPath)) {
    const receipt = readJson(receiptPath);
    verifyStored(receipt, admitted);
    return { receipt, receiptPath, runDir, replayed: true };
  }
  if (fs.existsSync(runDir)) {
    throw new Error(
      'incomplete prior build:core shadow requires explicit inspection',
    );
  }
  const observed = Date.parse(observedAt);
  if (
    !Number.isFinite(observed) ||
    Date.parse(admitted.executionAdmissionRequest.observedAt) > observed ||
    Date.parse(admitted.executionAdmissionDecision.expiresAt) <= observed
  ) {
    throw new Error(
      'build:core shadow execution admission is invalid or expired',
    );
  }
  fs.mkdirSync(runDir, { recursive: true });
  const authoritativeResult = await authoritativeDelegate({
    root,
    node,
    policy: admitted.executorPolicy,
    signal,
  });
  const authoritativeEvidence = laneEvidence(node.id, authoritativeResult);
  fs.writeFileSync(
    path.join(runDir, 'authoritative.stdout.log'),
    authoritativeResult.stdout || '',
  );
  fs.writeFileSync(
    path.join(runDir, 'authoritative.stderr.log'),
    authoritativeResult.stderr || '',
  );
  writeJson(
    path.join(runDir, 'authoritative.evidence.json'),
    authoritativeEvidence,
  );

  const local = await graphDelegate(input, {
    root,
    outputDir: path.join(runDir, 'graph'),
    observedAt,
    trustedVerificationReceipt,
    validators: admitted.validators,
    source: admitted.source,
    signal,
  });
  const rawGraphEvidence = readJson(
    path.join(local.runDir, `${node.id}.evidence.json`),
  );
  const graphEvidence = Object.fromEntries(
    [
      'command',
      'environment',
      'state',
      'exitCode',
      'signal',
      'timedOut',
      'cancelled',
      'outputExceeded',
      'stdoutRoot',
      'stderrRoot',
      'outputRoot',
      'evidenceRoot',
    ].map((field) => [field, rawGraphEvidence[field]]),
  );
  const classifications = classifyBuildCoreShadow(
    authoritativeEvidence,
    graphEvidence,
  );
  const nonQualifying = classifications.some(({ classification }) =>
    ['authority-drift', 'source-drift', 'executor-drift', 'blocker'].includes(
      classification,
    ),
  );
  const receipt = rooted(
    {
      schema: 'kungfu.build-core-production-graph-shadow-receipt/v0',
      status: nonQualifying ? 'non-qualifying' : 'qualified',
      sourceRevision: admitted.graph.source.revision,
      sourceTree: admitted.graph.source.tree,
      contractRoot: admitted.graph.contractRoot,
      verificationReceiptRoot: admitted.verificationReceipt.receiptRoot,
      graphRoot: admitted.graph.graphRoot,
      planRoot: admitted.plan.planRoot,
      executorPolicyRoot: admitted.executorPolicy.executorPolicyRoot,
      executionAdmissionRequestRoot:
        admitted.executionAdmissionRequest.requestRoot,
      executionAdmissionDecisionRoot:
        admitted.executionAdmissionDecision.decisionRoot,
      executionAdmissionExpiresAt:
        admitted.executionAdmissionDecision.expiresAt,
      idempotencyRoot,
      authoritativeEvidence,
      graphEvidence,
      localExecutionReceiptRoot: local.receipt.receiptRoot,
      eventRoots: local.receipt.eventRoots,
      failureRoots: local.receipt.failureRoots,
      classifications,
      retainedEvidenceRoots: [
        ...new Set([
          admitted.executionAdmissionRequest.requestRoot,
          admitted.executionAdmissionDecision.decisionRoot,
          authoritativeEvidence.evidenceRoot,
          graphEvidence.evidenceRoot,
          local.receipt.receiptRoot,
          ...local.receipt.retainedEvidenceRoots,
        ]),
      ],
      nextAction: nonQualifying
        ? 'inspect retained shadow evidence before requesting a new admission'
        : 'use this additive shadow receipt as Wave 1 build:core parity evidence',
    },
    'receiptRoot',
  );
  const validate = admitted.validators.buildCoreShadowReceipt;
  if (!validate(receipt)) {
    throw new Error(
      `build:core shadow receipt schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
  }
  writeJson(receiptPath, receipt);
  return { receipt, receiptPath, runDir, replayed: false };
}

function parseArgs(argv) {
  const options = { execute: false, outputDir: '' };
  const fields = new Set([
    'graph',
    'plan',
    'verification-receipt',
    'execution-admission-request',
    'execution-admission-decision',
    'executor-policy',
    'output-dir',
  ]);
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
    throw new Error('--execute is required for build:core shadow execution');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = {
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
  const verifier = await import('../check.mjs');
  const trustedVerificationReceipt =
    await verifier.checkProductionGraphContract();
  const result = await runBuildCoreShadow(input, {
    outputDir: options['output-dir'] || '',
    trustedVerificationReceipt,
  });
  console.log(
    `[build-core-graph-shadow] receipt=${result.receiptPath} replayed=${result.replayed}`,
  );
  if (result.receipt.status !== 'qualified') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[build-core-graph-shadow] ${error.message}`);
    process.exitCode = 1;
  });
}
