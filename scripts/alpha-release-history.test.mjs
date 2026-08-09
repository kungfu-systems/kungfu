// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAlphaCacheEvidence } from './alpha-cache-evidence.mjs';
import {
  appendAlphaReleaseHistory,
  digest,
  initializeAlphaReleaseHistory,
  verifyAlphaReleaseHistory,
} from './alpha-release-history.mjs';

const PLATFORMS = ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'];

function cacheEvidence(candidate) {
  const binding = {
    sourceCommit: candidate.sourceCommit,
    sourceTree: candidate.sourceTree,
    workflowRoot: `sha256:${'2'.repeat(64)}`,
    gateRoot: `sha256:${'3'.repeat(64)}`,
    dependencyLockRoot: `sha256:${'4'.repeat(64)}`,
    toolchainRoot: `sha256:${'5'.repeat(64)}`,
    policyRoot: `sha256:${'6'.repeat(64)}`,
  };
  const unavailable = (unit) => ({
    status: 'unavailable',
    unit,
    value: null,
    source: 'fixture-provider',
    reason: 'fixture provider does not expose this metric',
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
  const sets = PLATFORMS.map((platform) => {
    const operations = ['compiler-cache', 'source-checkout'].map((kind) => {
      const body = {
        schema: 'buildchain.cache-operation-receipt/v1',
        operationId: `${kind}:${platform}`,
        operation: 'restore',
        provider: 'fixture-provider',
        producer: 'fixture-producer',
        platform,
        cacheKey: `fixture-${kind}-${platform}`,
        cacheRoot: `fixture-root-${kind}-${platform}`,
        outcome: 'unavailable',
        bindings: {
          sourceCommit: candidate.sourceCommit,
          sourceTree: candidate.sourceTree,
          runtimeCommit: '8'.repeat(40),
          dependencyLockRoot: binding.dependencyLockRoot,
          toolchainRoot: binding.toolchainRoot,
          policyRoot: binding.policyRoot,
          cacheProfileRoot: `sha256:${'9'.repeat(64)}`,
        },
        metrics: {
          lookupDuration: unavailable('ms'),
          restoreDuration: unavailable('ms'),
          saveDuration: notApplicable('ms'),
          restoredBytes: unavailable('bytes'),
          writtenBytes: notApplicable('bytes'),
          savedTime: unavailable('ms'),
        },
        evidence: {
          kind,
          root: `sha256:${'a'.repeat(64)}`,
          locator: 'fixture/diagnostics.json',
        },
      };
      return { ...body, receiptRoot: digest(body) };
    });
    const body = {
      schema: 'buildchain.cache-evidence-set/v1',
      repository: 'kungfu-systems/kungfu',
      sourceCommit: candidate.sourceCommit,
      sourceTree: candidate.sourceTree,
      runtimeCommit: '8'.repeat(40),
      platform,
      operations,
    };
    return { ...body, evidenceRoot: digest(body) };
  });
  return createAlphaCacheEvidence({
    preflightReceipt: {
      schema: 'kungfu.alpha-promotion-preflight-receipt/v1',
      kind: 'aggregate',
      receiptRoot: candidate.preflightReceiptRoot,
      binding,
      platforms: PLATFORMS.map((platform, index) => ({
        platform,
        receiptRoot: `sha256:${String(index + 1).repeat(64)}`,
      })),
    },
    sets,
  });
}

function contract() {
  return {
    schema: 'kungfu.alpha-release-latency-contract/v1',
    status: 'active',
    candidate: {
      promotionRule: 'exact-candidate-or-tree-equivalent-channel-merge',
      artifactRule: 'build-once-content-addressed-promote-many',
    },
    phaseBudgetsSeconds: {},
    slo: {
      minimumRealSamples: 5,
      controllableP50Seconds: 1800,
      fullPathP90Seconds: 7200,
      lowSampleVerdict: 'insufficient-real-samples',
    },
  };
}

function timeline(value, index = 1) {
  const source = String(index).padStart(40, 'a').slice(-40);
  const promotion = String(index).padStart(40, 'b').slice(-40);
  const body = {
    schema: 'kungfu.alpha-release-timeline-receipt/v1',
    status: 'observed',
    mode: 'release',
    generatedAt: '2026-07-26T00:00:00.000Z',
    contract: {
      schema: value.schema,
      digest: digest(value),
    },
    candidate: {
      sourceCommit: source,
      sourceTree: 'c'.repeat(40),
      promotionCommit: promotion,
      promotionTree: 'c'.repeat(40),
      promotionRule: value.candidate.promotionRule,
      preflightReceiptRoot: `sha256:${'d'.repeat(64)}`,
      binding: {},
    },
    artifactLineage: {
      rule: value.candidate.artifactRule,
      releaseCandidateArtifact: `kungfu-release-candidate-${source}`,
      promotionControllerReceiptDigest: `sha256:${'e'.repeat(64)}`,
      publication: {
        evidenceDigest: `sha256:${'f'.repeat(64)}`,
        payloadRoot: `sha256:${'1'.repeat(64)}`,
        publicUrl: 'https://example.invalid/release',
      },
    },
    cacheEvidence: null,
    timing: {
      candidateCutAt: '2026-07-26T00:00:00.000Z',
      publicReadbackCompletedAt: '2026-07-26T00:10:00.000Z',
      rehearsalCompletedAt: '',
      fullPathMs: 600_000,
      controllableMs: 500_000,
      externalQueueMs: 100_000,
      retries: 0,
      runs: [],
      externalSideEffects: [],
      cacheObservations: [],
    },
    budgets: value.phaseBudgetsSeconds,
    slo: {
      eligibleRealSample: true,
      controllableTargetMs: 1_800_000,
      fullPathTargetMs: 7_200_000,
      controllableStatus: 'within-target',
      fullPathStatus: 'within-target',
      sampleVerdict: 'eligible-real-sample',
    },
  };
  body.cacheEvidence = cacheEvidence(body.candidate);
  return { ...body, receiptRoot: digest(body) };
}

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-alpha-history-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('durable history appends content-addressed receipts and SLO snapshots', (t) => {
  const history = fixture(t);
  const value = contract();
  const initialized = initializeAlphaReleaseHistory({
    history,
    contract: value,
  });
  assert.equal(initialized.entryCount, 0);
  const first = appendAlphaReleaseHistory({
    history,
    contract: value,
    timelineReceipt: timeline(value, 1),
  });
  const second = appendAlphaReleaseHistory({
    history,
    contract: value,
    timelineReceipt: timeline(value, 2),
  });
  assert.equal(first.status, 'appended');
  assert.equal(second.entryCount, 2);
  const verified = verifyAlphaReleaseHistory({
    history,
    contract: value,
  });
  assert.equal(verified.manifest.entryCount, 2);
  assert.equal(verified.compatibleCount, 2);
  assert.equal(verified.receipts.length, 2);
});

test('exact replay is classified without extending the chain', (t) => {
  const history = fixture(t);
  const value = contract();
  const receipt = timeline(value, 1);
  appendAlphaReleaseHistory({
    history,
    contract: value,
    timelineReceipt: receipt,
  });
  const replay = appendAlphaReleaseHistory({
    history,
    contract: value,
    timelineReceipt: receipt,
  });
  assert.equal(replay.status, 'replay');
  assert.equal(replay.entryCount, 1);
});

test('identity substitution, rehearsals, and partial history fail closed', (t) => {
  const history = fixture(t);
  const value = contract();
  const receipt = timeline(value, 1);
  appendAlphaReleaseHistory({
    history,
    contract: value,
    timelineReceipt: receipt,
  });
  const substituted = structuredClone(receipt);
  substituted.timing.fullPathMs += 1;
  const { receiptRoot: ignored, ...body } = substituted;
  substituted.receiptRoot = digest(body);
  assert.throws(
    () =>
      appendAlphaReleaseHistory({
        history,
        contract: value,
        timelineReceipt: substituted,
      }),
    /substituted timeline evidence/u,
  );
  const rehearsal = timeline(value, 2);
  rehearsal.mode = 'rehearsal';
  rehearsal.slo.eligibleRealSample = false;
  const { receiptRoot: stale, ...rehearsalBody } = rehearsal;
  rehearsal.receiptRoot = digest(rehearsalBody);
  assert.throws(
    () =>
      appendAlphaReleaseHistory({
        history,
        contract: value,
        timelineReceipt: rehearsal,
      }),
    /only eligible real releases/u,
  );
  const entryFile = fs
    .readdirSync(path.join(history, 'entries'))
    .find((file) => file.startsWith('00000001-'));
  const entry = JSON.parse(
    fs.readFileSync(path.join(history, 'entries', entryFile), 'utf8'),
  );
  const object = path.join(
    history,
    'objects',
    'sha256',
    `${entry.timelineObjectRoot.slice(7)}.json`,
  );
  fs.writeFileSync(object, '{}\n');
  assert.throws(
    () => verifyAlphaReleaseHistory({ history, contract: value }),
    /object root mismatch|entry root mismatch|identity drift/u,
  );
});

test('older contract roots remain classified as incompatible, not rewritten', (t) => {
  const history = fixture(t);
  const original = contract();
  appendAlphaReleaseHistory({
    history,
    contract: original,
    timelineReceipt: timeline(original, 1),
  });
  const next = structuredClone(original);
  next.slo.controllableP50Seconds = 1700;
  const verified = verifyAlphaReleaseHistory({ history, contract: next });
  assert.equal(verified.compatibleCount, 0);
  assert.equal(verified.incompatibleCount, 1);
  assert.equal(verified.receipts.length, 1);
  assert.equal(verified.compatibleReceipts.length, 0);
  const appended = appendAlphaReleaseHistory({
    history,
    contract: next,
    timelineReceipt: timeline(next, 2),
  });
  assert.equal(appended.entryCount, 2);
});
