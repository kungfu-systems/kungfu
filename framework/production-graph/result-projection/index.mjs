#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalJson,
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
const FIXTURE_ROOT = path.join(
  ROOT,
  'docs/shifu/examples/production-graph/result-projection',
);
const INVALID_FIXTURE_ROOT = path.join(FIXTURE_ROOT, 'invalid');

const AUTHORITY_BOUNDARY = Object.freeze({
  projectionOnly: true,
  canonicalCutClaimed: false,
  buildchainEvidenceClaimed: false,
  kfdClaimed: false,
  artifactStorageClaimed: false,
  publishingClaimed: false,
  signingClaimed: false,
  releaseCutClaimed: false,
});

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureFiles(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.fixture.json'))
    .sort()
    .map((name) => path.join(directory, name));
}

function assertSchema(label, validate, value) {
  if (!validate(value)) {
    const error = new Error(
      `${label} schema invalid: ${JSON.stringify(validate.errors || [])}`,
    );
    error.code = 'schema-invalid';
    throw error;
  }
}

function assertRooted(label, value, field) {
  if (!value?.[field] || rooted(value, field)[field] !== value[field]) {
    const error = new Error(`${label} ${field} mismatch`);
    error.code = 'root-mismatch';
    throw error;
  }
}

function assertSame(label, actual, expected, code = 'binding-mismatch') {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    const error = new Error(`${label} mismatch`);
    error.code = code;
    throw error;
  }
}

function unique(values) {
  return [...new Set(values)];
}

function expectedTerminalStatus(nodeResults) {
  for (const state of ['cancelled', 'timed-out', 'failed']) {
    if (nodeResults.some((result) => result.state === state)) return state;
  }
  return 'qualified';
}

export function verifyTerminalExecutionReceipt(receipt, validators) {
  assertSchema(
    'Production Graph local execution receipt',
    validators.localExecutionReceipt,
    receipt,
  );
  assertRooted(
    'Production Graph local execution receipt',
    receipt,
    'receiptRoot',
  );

  const nodeIds = receipt.nodeResults.map(({ nodeId }) => nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    const error = new Error('terminal receipt repeats a node result');
    error.code = 'duplicate-node-result';
    throw error;
  }
  assertSame(
    'terminal receipt started node positions',
    receipt.startedNodeIds,
    receipt.nodeResults
      .filter(({ started }) => started)
      .map(({ nodeId }) => nodeId),
    'position-mismatch',
  );
  assertSame(
    'terminal receipt skipped node positions',
    receipt.skippedNodeIds,
    receipt.nodeResults
      .filter(({ state }) => state === 'skipped')
      .map(({ nodeId }) => nodeId),
    'position-mismatch',
  );
  const expectedFailures = unique(
    receipt.nodeResults.map(({ failureRoot }) => failureRoot).filter(Boolean),
  );
  assertSame(
    'terminal receipt failure roots',
    receipt.failureRoots,
    expectedFailures,
    'failure-mismatch',
  );
  for (const result of receipt.nodeResults) {
    const succeeded = result.state === 'succeeded';
    if (succeeded !== Boolean(result.outputRoot)) {
      const error = new Error(
        `terminal receipt node ${result.nodeId} output digest does not match its state`,
      );
      error.code = 'output-digest-mismatch';
      throw error;
    }
    if (succeeded === Boolean(result.failureRoot)) {
      const error = new Error(
        `terminal receipt node ${result.nodeId} failure root does not match its state`,
      );
      error.code = 'failure-mismatch';
      throw error;
    }
    if (!receipt.retainedEvidenceRoots.includes(result.evidenceRoot)) {
      const error = new Error(
        `terminal receipt omits evidence for node ${result.nodeId}`,
      );
      error.code = 'missing-evidence';
      throw error;
    }
  }
  const expectedStatus =
    receipt.status === 'cancelled' &&
    receipt.nodeResults.every(({ state }) => state === 'skipped')
      ? 'cancelled'
      : expectedTerminalStatus(receipt.nodeResults);
  if (receipt.status !== expectedStatus) {
    const error = new Error(
      'terminal receipt status does not match node results',
    );
    error.code = 'outcome-mismatch';
    throw error;
  }
  return receipt;
}

function completenessFor(receipt, outputs) {
  const missingOutputNodeIds = receipt.nodeResults
    .filter(({ outputRoot }) => !outputRoot)
    .map(({ nodeId }) => nodeId);
  const complete =
    receipt.status === 'qualified' && missingOutputNodeIds.length === 0;
  return {
    status: complete ? 'complete' : outputs.length ? 'partial' : 'none',
    complete,
    expectedNodeCount: receipt.nodeResults.length,
    settledNodeCount: receipt.nodeResults.length,
    startedNodeCount: receipt.startedNodeIds.length,
    outputCount: outputs.length,
    skippedNodeIds: receipt.skippedNodeIds,
    missingOutputNodeIds,
  };
}

export async function settleBuildResult(
  executionReceipt,
  { validators = null } = {},
) {
  const checks = validators || (await schemaValidators(ROOT));
  const receipt = verifyTerminalExecutionReceipt(executionReceipt, checks);
  const outputs = receipt.nodeResults.flatMap((result, index) =>
    result.outputRoot
      ? [
          {
            position: {
              kind: 'production-graph-node-result',
              index,
              nodeId: result.nodeId,
            },
            kind: 'production-graph-observed-output',
            digest: result.outputRoot,
            provenance: {
              executionReceiptRoot: receipt.receiptRoot,
              evidenceRoot: result.evidenceRoot,
            },
          },
        ]
      : [],
  );
  const failed = receipt.nodeResults.filter(
    ({ state }) => state !== 'succeeded',
  );
  const cancelled = receipt.nodeResults.filter(
    ({ state }) => state === 'cancelled',
  );
  const completeness = completenessFor(receipt, outputs);
  const failure = {
    observed: failed.length > 0,
    nodeIds: failed.map(({ nodeId }) => nodeId),
    roots: receipt.failureRoots,
  };
  const cancellation = {
    observed: receipt.status === 'cancelled',
    nodeIds: cancelled.map(({ nodeId }) => nodeId),
  };
  const projection = rooted(
    {
      schema: 'shifu.production-graph-build-result/v0',
      authority: 'shifu.projection-only',
      outcome: receipt.status,
      source: {
        revision: receipt.sourceRevision,
        tree: receipt.sourceTree,
      },
      bindings: {
        contractRoot: receipt.contractRoot,
        graphRoot: receipt.graphRoot,
        planRoot: receipt.planRoot,
        executorPolicyRoot: receipt.executorPolicyRoot,
        executionAdmissionRequestRoot: receipt.executionAdmissionRequestRoot,
        executionAdmissionDecisionRoot: receipt.executionAdmissionDecisionRoot,
        executionReceiptRoot: receipt.receiptRoot,
        idempotencyRoot: receipt.idempotencyRoot,
        eventRoots: receipt.eventRoots,
      },
      outputs,
      retainedEvidenceRoots: receipt.retainedEvidenceRoots,
      completeness,
      failure,
      cancellation,
      nextAction: receipt.nextAction,
      authorityBoundary: AUTHORITY_BOUNDARY,
    },
    'projectionRoot',
  );
  const settlementReceipt = rooted(
    {
      schema: 'shifu.production-graph-build-result-settlement-receipt/v0',
      status: 'settled',
      outcome: projection.outcome,
      executionReceiptRoot: receipt.receiptRoot,
      projectionRoot: projection.projectionRoot,
      outputDigests: outputs.map(({ digest }) => digest),
      provenanceRoot: semanticRoot(outputs.map(({ provenance }) => provenance)),
      completenessRoot: semanticRoot(completeness),
      failureRoot: semanticRoot(failure),
      cancellationRoot: semanticRoot(cancellation),
      authorityBoundaryRoot: semanticRoot(AUTHORITY_BOUNDARY),
    },
    'receiptRoot',
  );
  verifyBuildResultBundle(
    { executionReceipt: receipt, projection, settlementReceipt },
    { validators: checks },
  );
  return { projection, settlementReceipt };
}

export function verifyBuildResultBundle(
  bundle,
  { validators, expectedExecutionReceiptRoot = '' },
) {
  const { executionReceipt, projection, settlementReceipt } = bundle;
  verifyTerminalExecutionReceipt(executionReceipt, validators);
  assertSchema(
    'Production Graph build-result projection',
    validators.buildResult,
    projection,
  );
  assertSchema(
    'Production Graph build-result settlement receipt',
    validators.buildResultSettlementReceipt,
    settlementReceipt,
  );
  assertRooted(
    'Production Graph build-result projection',
    projection,
    'projectionRoot',
  );
  assertRooted(
    'Production Graph build-result settlement receipt',
    settlementReceipt,
    'receiptRoot',
  );
  if (
    expectedExecutionReceiptRoot &&
    executionReceipt.receiptRoot !== expectedExecutionReceiptRoot
  ) {
    const error = new Error(
      'terminal execution receipt drifted from the expected run',
    );
    error.code = 'execution-receipt-drift';
    throw error;
  }
  const expected = {
    source: {
      revision: executionReceipt.sourceRevision,
      tree: executionReceipt.sourceTree,
    },
    bindings: {
      contractRoot: executionReceipt.contractRoot,
      graphRoot: executionReceipt.graphRoot,
      planRoot: executionReceipt.planRoot,
      executorPolicyRoot: executionReceipt.executorPolicyRoot,
      executionAdmissionRequestRoot:
        executionReceipt.executionAdmissionRequestRoot,
      executionAdmissionDecisionRoot:
        executionReceipt.executionAdmissionDecisionRoot,
      executionReceiptRoot: executionReceipt.receiptRoot,
      idempotencyRoot: executionReceipt.idempotencyRoot,
      eventRoots: executionReceipt.eventRoots,
    },
  };
  assertSame(
    'build-result source',
    projection.source,
    expected.source,
    'source-drift',
  );
  assertSame(
    'build-result execution bindings',
    projection.bindings,
    expected.bindings,
    'execution-receipt-mismatch',
  );
  const expectedOutputs = executionReceipt.nodeResults.flatMap(
    (result, index) =>
      result.outputRoot
        ? [
            {
              position: {
                kind: 'production-graph-node-result',
                index,
                nodeId: result.nodeId,
              },
              kind: 'production-graph-observed-output',
              digest: result.outputRoot,
              provenance: {
                executionReceiptRoot: executionReceipt.receiptRoot,
                evidenceRoot: result.evidenceRoot,
              },
            },
          ]
        : [],
  );
  assertSame(
    'build-result outputs',
    projection.outputs,
    expectedOutputs,
    'output-digest-mismatch',
  );
  assertSame(
    'build-result retained evidence',
    projection.retainedEvidenceRoots,
    executionReceipt.retainedEvidenceRoots,
    'retained-evidence-mismatch',
  );
  assertSame(
    'build-result completeness',
    projection.completeness,
    completenessFor(executionReceipt, expectedOutputs),
    'completeness-mismatch',
  );
  const expectedFailed = executionReceipt.nodeResults.filter(
    ({ state }) => state !== 'succeeded',
  );
  assertSame(
    'build-result failure',
    projection.failure,
    {
      observed: expectedFailed.length > 0,
      nodeIds: expectedFailed.map(({ nodeId }) => nodeId),
      roots: executionReceipt.failureRoots,
    },
    'failure-mismatch',
  );
  assertSame(
    'build-result cancellation',
    projection.cancellation,
    {
      observed: executionReceipt.status === 'cancelled',
      nodeIds: executionReceipt.nodeResults
        .filter(({ state }) => state === 'cancelled')
        .map(({ nodeId }) => nodeId),
    },
    'cancellation-mismatch',
  );
  if (projection.nextAction !== executionReceipt.nextAction) {
    const error = new Error(
      'build-result next action drifted from the terminal receipt',
    );
    error.code = 'next-action-mismatch';
    throw error;
  }
  if (projection.outcome !== executionReceipt.status) {
    const error = new Error(
      'build-result outcome drifted from the terminal receipt',
    );
    error.code = 'outcome-mismatch';
    throw error;
  }
  assertSame(
    'build-result authority boundary',
    projection.authorityBoundary,
    AUTHORITY_BOUNDARY,
    'authority-boundary-drift',
  );
  const expectedSettlement = rooted(
    {
      schema: 'shifu.production-graph-build-result-settlement-receipt/v0',
      status: 'settled',
      outcome: projection.outcome,
      executionReceiptRoot: executionReceipt.receiptRoot,
      projectionRoot: projection.projectionRoot,
      outputDigests: projection.outputs.map(({ digest }) => digest),
      provenanceRoot: semanticRoot(
        projection.outputs.map(({ provenance }) => provenance),
      ),
      completenessRoot: semanticRoot(projection.completeness),
      failureRoot: semanticRoot(projection.failure),
      cancellationRoot: semanticRoot(projection.cancellation),
      authorityBoundaryRoot: semanticRoot(projection.authorityBoundary),
    },
    'receiptRoot',
  );
  assertSame(
    'build-result settlement receipt',
    settlementReceipt,
    expectedSettlement,
    'settlement-receipt-mismatch',
  );
  return true;
}

function terminalReceiptFromFixture(fixture) {
  const nodeResults = fixture.nodes.map((node) => {
    const succeeded = node.state === 'succeeded';
    return {
      nodeId: node.id,
      state: node.state,
      started: node.started,
      exitCode: succeeded ? 0 : node.started ? 1 : null,
      signal: node.state === 'cancelled' ? 'SIGTERM' : null,
      outputRoot: succeeded
        ? semanticRoot({
            fixtureId: fixture.fixtureId,
            nodeId: node.id,
            kind: 'output',
          })
        : null,
      failureRoot: succeeded
        ? null
        : semanticRoot({
            fixtureId: fixture.fixtureId,
            nodeId: node.id,
            kind: 'failure',
          }),
      evidenceRoot: semanticRoot({
        fixtureId: fixture.fixtureId,
        nodeId: node.id,
        kind: 'evidence',
      }),
      retryEligible: Boolean(node.retryEligible),
    };
  });
  const status = fixture.outcome;
  const roots = (kind) => semanticRoot({ fixtureId: fixture.fixtureId, kind });
  return rooted(
    {
      schema: 'shifu.production-graph-local-execution-receipt/v0',
      status,
      contractRoot: roots('contract'),
      graphRoot: roots('graph'),
      planRoot: roots('plan'),
      sourceRevision: fixture.sourceRevision,
      sourceTree: fixture.sourceTree,
      executorPolicyRoot: roots('executor-policy'),
      executionAdmissionRequestRoot: roots('admission-request'),
      executionAdmissionDecisionRoot: roots('admission-decision'),
      executionAdmissionExpiresAt: '2026-08-11T00:00:00Z',
      idempotencyRoot: roots('idempotency'),
      concurrency: 1,
      startedNodeIds: nodeResults
        .filter(({ started }) => started)
        .map(({ nodeId }) => nodeId),
      skippedNodeIds: nodeResults
        .filter(({ state }) => state === 'skipped')
        .map(({ nodeId }) => nodeId),
      nodeResults,
      eventRoots: nodeResults.map(({ nodeId }, index) =>
        semanticRoot({
          fixtureId: fixture.fixtureId,
          nodeId,
          index,
          kind: 'event',
        }),
      ),
      failureRoots: unique(
        nodeResults.map(({ failureRoot }) => failureRoot).filter(Boolean),
      ),
      retainedEvidenceRoots: unique([
        roots('admission-request'),
        roots('admission-decision'),
        roots('executor-policy'),
        ...nodeResults.map(({ evidenceRoot }) => evidenceRoot),
      ]),
      nextAction: fixture.nextAction,
    },
    'receiptRoot',
  );
}

function mutate(bundle, mutation) {
  const next = structuredClone(bundle);
  let parent = next[mutation.target];
  for (const key of mutation.path.slice(0, -1)) parent = parent[key];
  const key = mutation.path.at(-1);
  if (mutation.operation === 'delete') delete parent[key];
  else parent[key] = mutation.value;
  if (mutation.rerootProjection) {
    next.projection = rooted(next.projection, 'projectionRoot');
  }
  if (mutation.rerootSettlement) {
    next.settlementReceipt = rooted(next.settlementReceipt, 'receiptRoot');
  }
  return next;
}

export async function checkBuildResultContract({ validators = null } = {}) {
  const checks = validators || (await schemaValidators(ROOT));
  const valid = new Map();
  for (const file of fixtureFiles(FIXTURE_ROOT)) {
    const fixture = readJson(file);
    const executionReceipt = terminalReceiptFromFixture(fixture);
    const settled = await settleBuildResult(executionReceipt, {
      validators: checks,
    });
    verifyBuildResultBundle(
      { executionReceipt, ...settled },
      {
        validators: checks,
        expectedExecutionReceiptRoot: executionReceipt.receiptRoot,
      },
    );
    valid.set(fixture.fixtureId, { executionReceipt, ...settled });
  }
  assert.deepEqual(
    [...valid.keys()],
    [
      'build-result-cancellation',
      'build-result-failure',
      'build-result-partial-output',
      'build-result-success',
    ],
  );
  const observedCodes = new Set();
  for (const file of fixtureFiles(INVALID_FIXTURE_ROOT)) {
    const fixture = readJson(file);
    const base = valid.get(fixture.baseFixture);
    assert.ok(base, `${file}: unknown base fixture ${fixture.baseFixture}`);
    const changed = mutate(base, fixture.mutation);
    assert.throws(
      () =>
        verifyBuildResultBundle(changed, {
          validators: checks,
          expectedExecutionReceiptRoot:
            fixture.expectedExecutionReceiptRoot ||
            changed.executionReceipt.receiptRoot,
        }),
      (error) => {
        observedCodes.add(error.code);
        return error.code === fixture.expect;
      },
      file,
    );
  }
  assert.deepEqual([...observedCodes].sort(), [
    'completeness-mismatch',
    'execution-receipt-drift',
    'schema-invalid',
    'settlement-receipt-mismatch',
    'source-drift',
  ]);
  return semanticRoot({
    validProjectionRoots: [...valid.values()].map(
      ({ projection }) => projection.projectionRoot,
    ),
    invalidFixtureCount: fixtureFiles(INVALID_FIXTURE_ROOT).length,
    authorityBoundary: AUTHORITY_BOUNDARY,
  });
}

function parseArgs(argv) {
  const options = {
    executionReceipt: '',
    outputDir: '',
    expectedReceiptRoot: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execution-receipt')
      options.executionReceipt = argv[++index] || '';
    else if (arg === '--output-dir') options.outputDir = argv[++index] || '';
    else if (arg === '--expected-receipt-root')
      options.expectedReceiptRoot = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.executionReceipt)
    throw new Error('--execution-receipt is required');
  if (!options.outputDir) throw new Error('--output-dir is required');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const executionReceipt = readJson(path.resolve(options.executionReceipt));
  if (
    options.expectedReceiptRoot &&
    executionReceipt.receiptRoot !== options.expectedReceiptRoot
  ) {
    const error = new Error(
      'terminal execution receipt drifted from the expected run',
    );
    error.code = 'execution-receipt-drift';
    throw error;
  }
  const settled = await settleBuildResult(executionReceipt);
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  const projectionPath = path.join(outputDir, 'build-result.json');
  const receiptPath = path.join(outputDir, 'settlement-receipt.json');
  writeJson(projectionPath, settled.projection);
  writeJson(receiptPath, settled.settlementReceipt);
  console.log(
    `[production-graph-build-result] projection=${projectionPath} receipt=${receiptPath}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      `[production-graph-build-result] ${error.code || 'error'}: ${error.message}`,
    );
    process.exitCode = 1;
  });
}
