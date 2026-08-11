// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { schemaValidators, semanticRoot } from '../contract.mjs';
import {
  checkBuildResultContract,
  settleBuildResult,
  verifyBuildResultBundle,
} from './index.mjs';

const ROOT = new URL('../../..', import.meta.url).pathname;

function root(kind) {
  return semanticRoot({ fixture: 'direct-build-result-test', kind });
}

function executionReceipt() {
  const result = {
    nodeId: 'build-core',
    state: 'succeeded',
    started: true,
    exitCode: 0,
    signal: null,
    outputRoot: root('output'),
    failureRoot: null,
    evidenceRoot: root('evidence'),
    retryEligible: false,
  };
  const body = {
    schema: 'shifu.production-graph-local-execution-receipt/v0',
    status: 'qualified',
    contractRoot: root('contract'),
    graphRoot: root('graph'),
    planRoot: root('plan'),
    sourceRevision: '1111111111111111111111111111111111111111',
    sourceTree: '2222222222222222222222222222222222222222',
    executorPolicyRoot: root('policy'),
    executionAdmissionRequestRoot: root('request'),
    executionAdmissionDecisionRoot: root('decision'),
    executionAdmissionExpiresAt: '2026-08-11T00:00:00Z',
    idempotencyRoot: root('idempotency'),
    concurrency: 1,
    startedNodeIds: ['build-core'],
    skippedNodeIds: [],
    nodeResults: [result],
    eventRoots: [root('event-started'), root('event-succeeded')],
    failureRoots: [],
    retainedEvidenceRoots: [
      root('request'),
      root('decision'),
      root('policy'),
      root('evidence'),
    ],
    nextAction: 'submit the projection to the canonical Build Cut authority',
  };
  return { ...body, receiptRoot: semanticRoot(body) };
}

test('one exact terminal run settles to one deterministic projection and receipt', async () => {
  const validators = await schemaValidators(ROOT);
  const terminal = executionReceipt();
  const first = await settleBuildResult(terminal, { validators });
  const second = await settleBuildResult(terminal, { validators });
  assert.deepEqual(second, first);
  assert.equal(first.projection.completeness.complete, true);
  assert.equal(first.projection.outputs[0].digest, root('output'));
  assert.equal(first.projection.authorityBoundary.canonicalCutClaimed, false);
  assert.equal(first.projection.authorityBoundary.releaseCutClaimed, false);
  assert.equal(
    verifyBuildResultBundle(
      { executionReceipt: terminal, ...first },
      { validators, expectedExecutionReceiptRoot: terminal.receiptRoot },
    ),
    true,
  );
});

test('checked fixtures cover success, partial output, failure, cancellation, and invalid bindings', async () => {
  assert.match(await checkBuildResultContract(), /^sha256:[0-9a-f]{64}$/u);
});

test('CLI writes one verified projection bundle for the exact terminal receipt', async (t) => {
  const validators = await schemaValidators(ROOT);
  const terminal = executionReceipt();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'production-graph-build-result-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, 'execution-receipt.json');
  const outputDir = path.join(directory, 'settled');
  fs.writeFileSync(receiptPath, `${JSON.stringify(terminal, null, 2)}\n`);

  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('./index.mjs', import.meta.url)),
      '--execution-receipt',
      receiptPath,
      '--output-dir',
      outputDir,
      '--expected-receipt-root',
      terminal.receiptRoot,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);

  const projection = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'build-result.json'), 'utf8'),
  );
  const settlementReceipt = JSON.parse(
    fs.readFileSync(path.join(outputDir, 'settlement-receipt.json'), 'utf8'),
  );
  assert.equal(
    verifyBuildResultBundle(
      { executionReceipt: terminal, projection, settlementReceipt },
      {
        validators,
        expectedExecutionReceiptRoot: terminal.receiptRoot,
      },
    ),
    true,
  );
});
