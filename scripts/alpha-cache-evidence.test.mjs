// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAlphaCacheEvidence,
  digest,
  verifyAlphaCacheEvidence,
} from './alpha-cache-evidence.mjs';

const PLATFORMS = ['linux-x64', 'macos-arm64', 'windows-x64'];
const BINDING = {
  sourceCommit: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  workflowRoot: `sha256:${'1'.repeat(64)}`,
  gateRoot: `sha256:${'2'.repeat(64)}`,
  dependencyLockRoot: `sha256:${'3'.repeat(64)}`,
  toolchainRoot: `sha256:${'4'.repeat(64)}`,
  policyRoot: `sha256:${'5'.repeat(64)}`,
};

const unavailable = (unit) => ({
  status: 'unavailable',
  unit,
  value: null,
  source: 'provider',
  reason: 'provider did not expose this metric',
  evidenceRoot: `sha256:${'6'.repeat(64)}`,
});
const observed = (unit, value) => ({
  status: 'observed',
  unit,
  value,
  source: 'provider',
  reason: null,
  evidenceRoot: `sha256:${'7'.repeat(64)}`,
});
const notApplicable = (unit) => ({
  status: 'not-applicable',
  unit,
  value: null,
  source: null,
  reason: 'operation does not apply',
  evidenceRoot: null,
});

function operation(platform, kind) {
  const body = {
    schema: 'buildchain.cache-operation-receipt/v1',
    operationId: `${kind}:${platform}`,
    operation: 'restore',
    provider: kind === 'compiler-cache' ? 'ccache' : 'git-mirror-url',
    producer: 'producer',
    platform,
    cacheKey: `cache-${platform}-${kind}`,
    cacheRoot: `root-${platform}-${kind}`,
    outcome: 'hit',
    bindings: {
      sourceCommit: BINDING.sourceCommit,
      sourceTree: BINDING.sourceTree,
      runtimeCommit: 'c'.repeat(40),
      dependencyLockRoot: BINDING.dependencyLockRoot,
      toolchainRoot: BINDING.toolchainRoot,
      policyRoot: BINDING.policyRoot,
      cacheProfileRoot: `sha256:${'8'.repeat(64)}`,
    },
    metrics: {
      lookupDuration: observed('ms', 10),
      restoreDuration: observed('ms', 20),
      saveDuration: notApplicable('ms'),
      restoredBytes: observed('bytes', 1024),
      writtenBytes: notApplicable('bytes'),
      savedTime: unavailable('ms'),
    },
    evidence: {
      kind,
      root: `sha256:${'9'.repeat(64)}`,
      locator: 'diagnostics.json',
    },
  };
  return { ...body, receiptRoot: digest(body) };
}

function set(platform) {
  const body = {
    schema: 'buildchain.cache-evidence-set/v1',
    repository: 'kungfu-systems/kungfu',
    sourceCommit: BINDING.sourceCommit,
    sourceTree: BINDING.sourceTree,
    runtimeCommit: 'c'.repeat(40),
    platform,
    operations: [
      operation(platform, 'compiler-cache'),
      operation(platform, 'source-checkout'),
    ],
  };
  return { ...body, evidenceRoot: digest(body) };
}

function preflight() {
  return {
    schema: 'kungfu.alpha-promotion-preflight-receipt/v1',
    kind: 'aggregate',
    receiptRoot: `sha256:${'d'.repeat(64)}`,
    binding: BINDING,
    platforms: PLATFORMS.map((platform, index) => ({
      platform,
      receiptRoot: `sha256:${String(index + 1).repeat(64)}`,
    })),
  };
}

test('Alpha cache evidence binds three platform sets to preflight roots', () => {
  const receipt = createAlphaCacheEvidence({
    preflightReceipt: preflight(),
    sets: PLATFORMS.map(set),
  });
  assert.equal(receipt.summary.outcomes.hit, 6);
  assert.equal(receipt.summary.metrics.restoredBytes.observedTotal, 6144);
  assert.equal(receipt.summary.metrics.savedTime.observedTotal, null);
  assert.equal(
    verifyAlphaCacheEvidence({
      evidence: receipt,
      preflightReceipt: preflight(),
    }),
    receipt,
  );
});

test('cross-toolchain reuse and poisoned cache evidence fail closed', () => {
  const crossToolchain = PLATFORMS.map(set);
  crossToolchain[0].operations[0].bindings.toolchainRoot = `sha256:${'e'.repeat(64)}`;
  const { receiptRoot: staleOperationRoot, ...operationBody } =
    crossToolchain[0].operations[0];
  crossToolchain[0].operations[0].receiptRoot = digest(operationBody);
  const { evidenceRoot: ignored, ...body } = crossToolchain[0];
  crossToolchain[0].evidenceRoot = digest(body);
  assert.throws(
    () =>
      createAlphaCacheEvidence({
        preflightReceipt: preflight(),
        sets: crossToolchain,
      }),
    /toolchainRoot is missing or incompatible/u,
  );
  const poisoned = PLATFORMS.map(set);
  poisoned[1].operations[1].outcome = 'poisoned';
  const { receiptRoot: staleRoot, ...poisonedOperationBody } =
    poisoned[1].operations[1];
  poisoned[1].operations[1].receiptRoot = digest(poisonedOperationBody);
  const { evidenceRoot: staleSetRoot, ...setBody } = poisoned[1];
  poisoned[1].evidenceRoot = digest(setBody);
  assert.throws(
    () =>
      createAlphaCacheEvidence({
        preflightReceipt: preflight(),
        sets: poisoned,
      }),
    /cache evidence is poisoned/u,
  );
});

test('forged saved time and byte mutations fail before aggregation', () => {
  const forged = PLATFORMS.map(set);
  forged[2].operations[0].metrics.savedTime = {
    status: 'observed',
    unit: 'ms',
    value: 50_000,
    source: 'step-name-inference',
    evidenceRoot: `sha256:${'f'.repeat(64)}`,
  };
  const { receiptRoot: ignored, ...body } = forged[2].operations[0];
  forged[2].operations[0].receiptRoot = digest(body);
  const { evidenceRoot: stale, ...setBody } = forged[2];
  forged[2].evidenceRoot = digest(setBody);
  assert.throws(
    () =>
      createAlphaCacheEvidence({
        preflightReceipt: preflight(),
        sets: forged,
      }),
    /saved time is not backed by producer evidence/u,
  );
  const tampered = createAlphaCacheEvidence({
    preflightReceipt: preflight(),
    sets: PLATFORMS.map(set),
  });
  tampered.summary.metrics.restoredBytes.observedTotal += 1;
  assert.throws(
    () =>
      verifyAlphaCacheEvidence({
        evidence: tampered,
        preflightReceipt: preflight(),
      }),
    /root or normalization drifted/u,
  );
});
