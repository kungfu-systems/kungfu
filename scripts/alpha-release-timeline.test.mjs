// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { createAlphaCacheEvidence } from './alpha-cache-evidence.mjs';
import {
  aggregatePlatformReceipts,
  buildPlatformReceipt,
  sourceBinding,
} from './alpha-promotion-preflight.mjs';
import {
  alphaReleaseDigest,
  createAlphaReleaseTimeline,
  summarizeAlphaReleaseSlo,
  verifyAlphaReleaseTimeline,
} from './alpha-release-timeline.mjs';

const ROOT = process.cwd();
const CONTRACT = JSON.parse(
  fs.readFileSync(
    'docs/qualification/alpha-release-latency.contract.json',
    'utf8',
  ),
);
const SOURCE = sourceBinding(ROOT);
const GENERATED_AT = '2026-07-26T01:00:00.000Z';

function preflight() {
  return aggregatePlatformReceipts({
    root: ROOT,
    generatedAt: GENERATED_AT,
    receipts: ['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'].map(
      (platform) =>
        buildPlatformReceipt({
          root: ROOT,
          platform,
          generatedAt: GENERATED_AT,
        }),
    ),
  });
}

function cacheEvidence(preflightReceipt) {
  const unavailable = (unit) => ({
    status: 'unavailable',
    unit,
    value: null,
    source: 'fixture-provider',
    reason: 'fixture provider does not expose this metric',
    evidenceRoot: `sha256:${'8'.repeat(64)}`,
  });
  const notApplicable = (unit) => ({
    status: 'not-applicable',
    unit,
    value: null,
    source: null,
    reason: 'operation does not apply',
    evidenceRoot: null,
  });
  const sets = preflightReceipt.platforms.map(({ platform }) => {
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
          sourceCommit: SOURCE.sourceCommit,
          sourceTree: SOURCE.sourceTree,
          runtimeCommit: '9'.repeat(40),
          dependencyLockRoot: preflightReceipt.binding.dependencyLockRoot,
          toolchainRoot: preflightReceipt.binding.toolchainRoot,
          policyRoot: preflightReceipt.binding.policyRoot,
          cacheProfileRoot: `sha256:${'7'.repeat(64)}`,
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
          root: `sha256:${'6'.repeat(64)}`,
          locator: 'fixture/diagnostics.json',
        },
      };
      return { ...body, receiptRoot: alphaReleaseDigest(body) };
    });
    const body = {
      schema: 'buildchain.cache-evidence-set/v1',
      repository: 'kungfu-systems/kungfu',
      sourceCommit: SOURCE.sourceCommit,
      sourceTree: SOURCE.sourceTree,
      runtimeCommit: '9'.repeat(40),
      platform,
      operations,
    };
    return { ...body, evidenceRoot: alphaReleaseDigest(body) };
  });
  return createAlphaCacheEvidence({ preflightReceipt, sets });
}

function run(id, createdAt, startedAt, updatedAt, name, steps = []) {
  return {
    id,
    run_attempt: 1,
    conclusion: 'success',
    created_at: createdAt,
    run_started_at: startedAt,
    updated_at: updatedAt,
    jobs: [
      {
        name,
        conclusion: 'success',
        started_at: startedAt,
        completed_at: updatedAt,
        steps,
      },
    ],
  };
}

function controller(status = 'passed') {
  const body = {
    contract: 'buildchain.controller-evidence/v1',
    kind: 'receipt',
    controller: { id: 'release-candidate-promotion' },
    status,
    qualifying: status === 'passed',
  };
  return { ...body, digest: alphaReleaseDigest(body) };
}

function timelineRuns() {
  return {
    preflight: run(
      1,
      '2026-07-26T01:00:00.000Z',
      '2026-07-26T01:01:00.000Z',
      '2026-07-26T01:04:00.000Z',
      'Exact source preflight',
    ),
    candidate: run(
      2,
      '2026-07-26T01:05:00.000Z',
      '2026-07-26T01:07:00.000Z',
      '2026-07-26T01:32:00.000Z',
      'Build candidate',
      [
        {
          name: 'Restore exact toolchain cache',
          conclusion: 'success',
          started_at: '2026-07-26T01:07:00.000Z',
          completed_at: '2026-07-26T01:08:00.000Z',
        },
        {
          name: 'Sign and notarize exact macOS artifact',
          conclusion: 'success',
          started_at: '2026-07-26T01:25:00.000Z',
          completed_at: '2026-07-26T01:32:00.000Z',
        },
      ],
    ),
    promotion: run(
      3,
      '2026-07-26T01:33:00.000Z',
      '2026-07-26T01:34:00.000Z',
      '2026-07-26T01:47:00.000Z',
      'Promote release candidate',
      [
        {
          name: 'Commit publication authority and public readback',
          conclusion: 'success',
          started_at: '2026-07-26T01:42:00.000Z',
          completed_at: '2026-07-26T01:47:00.000Z',
        },
      ],
    ),
  };
}

function fixture(mode = 'release', overrides = {}) {
  const preflightReceipt = preflight();
  return createAlphaReleaseTimeline({
    contract: CONTRACT,
    preflightReceipt,
    sourceCommit: SOURCE.sourceCommit,
    sourceTree: SOURCE.sourceTree,
    promotionCommit: 'b'.repeat(40),
    promotionTree: SOURCE.sourceTree,
    runs: timelineRuns(),
    controllerReceipt: controller(),
    candidateArtifact: `kungfu-release-candidate-${SOURCE.sourceCommit}`,
    cacheEvidence: cacheEvidence(preflightReceipt),
    publication:
      mode === 'release'
        ? {
            evidenceDigest: `sha256:${'c'.repeat(64)}`,
            payloadRoot: `sha256:${'d'.repeat(64)}`,
            publicUrl:
              'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-installer-publication-bundle.json',
          }
        : {},
    mode,
    generatedAt: '2026-07-26T01:48:00.000Z',
    ...overrides,
  });
}

test('timeline accounts for queue, execution, structured cache, retries and side effects', () => {
  const receipt = fixture();
  assert.equal(
    verifyAlphaReleaseTimeline({ receipt, contract: CONTRACT }),
    receipt,
  );
  assert.equal(receipt.status, 'observed');
  assert.equal(receipt.timing.externalQueueMs, 4 * 60 * 1000);
  assert.equal(receipt.timing.retries, 0);
  assert.equal(receipt.cacheEvidence.summary.outcomes.unavailable, 8);
  assert.equal(
    receipt.timing.runs
      .flatMap(({ phases }) => phases)
      .some((phase) => Object.hasOwn(phase, 'cache')),
    false,
  );
  assert.deepEqual(
    [
      ...new Set(
        receipt.timing.externalSideEffects.map(
          (phase) => phase.externalSideEffect,
        ),
      ),
    ].sort(),
    ['notarization', 'public-readback'],
  );
  assert.equal(receipt.slo.eligibleRealSample, true);
});

test('timeline safely snapshots its still-running observer workflow', () => {
  const runs = timelineRuns();
  runs.promotion.conclusion = null;
  runs.promotion.status = 'in_progress';
  runs.promotion.updated_at = '2026-07-26T01:48:00.000Z';
  runs.promotion.jobs.push({
    name: 'Alpha release timeline',
    status: 'in_progress',
    conclusion: null,
    started_at: '2026-07-26T01:47:30.000Z',
    completed_at: null,
    steps: [],
  });
  const receipt = fixture('release', { runs });
  const promotion = receipt.timing.runs.find(
    (item) => item.label === 'alpha-promotion',
  );
  assert.deepEqual(promotion.snapshot, {
    observedConclusion: 'in_progress',
    observerJob: 'Alpha release timeline',
    observerStatus: 'in_progress',
    observerExcluded: true,
  });
  assert.equal(promotion.completedAt, '2026-07-26T01:47:00.000Z');
  assert.equal(
    promotion.phases.some((phase) => phase.name === 'Alpha release timeline'),
    false,
  );
  assert.equal(
    verifyAlphaReleaseTimeline({ receipt, contract: CONTRACT }),
    receipt,
  );

  const forged = structuredClone(receipt);
  forged.timing.runs.find(
    (item) => item.label === 'alpha-promotion',
  ).snapshot.observerJob = 'Forged release observer';
  const { receiptRoot: _oldRoot, ...forgedBody } = forged;
  forged.receiptRoot = alphaReleaseDigest(forgedBody);
  assert.throws(
    () => verifyAlphaReleaseTimeline({ receipt: forged, contract: CONTRACT }),
    /in-progress promotion snapshot is not observer-owned/u,
  );

  const injectedObserver = structuredClone(receipt);
  const injectedPromotion = injectedObserver.timing.runs.find(
    (item) => item.label === 'alpha-promotion',
  );
  injectedPromotion.phases.push({
    ...injectedPromotion.phases[0],
    name: 'Alpha release timeline',
  });
  const { receiptRoot: _injectedRoot, ...injectedBody } = injectedObserver;
  injectedObserver.receiptRoot = alphaReleaseDigest(injectedBody);
  assert.throws(
    () =>
      verifyAlphaReleaseTimeline({
        receipt: injectedObserver,
        contract: CONTRACT,
      }),
    /observer phase was not excluded/u,
  );
});

test('in-progress workflow snapshots fail closed without the exact observer', () => {
  const missingObserver = timelineRuns();
  missingObserver.promotion.conclusion = null;
  missingObserver.promotion.status = 'in_progress';
  assert.throws(
    () => fixture('release', { runs: missingObserver }),
    /in-progress snapshot is not owned by the timeline observer/u,
  );

  const unfinishedProducer = timelineRuns();
  unfinishedProducer.promotion.conclusion = null;
  unfinishedProducer.promotion.status = 'in_progress';
  unfinishedProducer.promotion.jobs[0].conclusion = null;
  unfinishedProducer.promotion.jobs[0].status = 'in_progress';
  unfinishedProducer.promotion.jobs.push({
    name: 'Alpha release timeline',
    status: 'in_progress',
    conclusion: null,
    started_at: '2026-07-26T01:47:30.000Z',
    completed_at: null,
    steps: [],
  });
  assert.throws(
    () => fixture('release', { runs: unfinishedProducer }),
    /producer job is not complete/u,
  );
});

test('rehearsal remains ineligible for real Alpha SLO', () => {
  const receipt = fixture('rehearsal');
  assert.equal(receipt.status, 'rehearsed');
  assert.equal(receipt.slo.eligibleRealSample, false);
  const report = summarizeAlphaReleaseSlo({
    receipts: [receipt],
    contract: CONTRACT,
  });
  assert.equal(report.sampleCount, 0);
  assert.equal(report.rehearsalCount, 1);
  assert.equal(report.verdict, 'insufficient-real-samples');
});

test('stale, cross-toolchain and source receipt reuse fail closed', () => {
  const receipt = preflight();
  assert.throws(
    () =>
      createAlphaReleaseTimeline({
        contract: CONTRACT,
        preflightReceipt: receipt,
        sourceCommit: 'f'.repeat(40),
        sourceTree: SOURCE.sourceTree,
        promotionCommit: 'b'.repeat(40),
        promotionTree: SOURCE.sourceTree,
        runs: {},
        controllerReceipt: controller(),
        candidateArtifact: 'candidate',
        mode: 'rehearsal',
        generatedAt: '2026-07-26T01:48:00.000Z',
      }),
    /sourceCommit mismatch/u,
  );
  const poisoned = structuredClone(receipt);
  poisoned.binding.toolchainRoot = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () =>
      createAlphaReleaseTimeline({
        contract: CONTRACT,
        preflightReceipt: poisoned,
        sourceCommit: SOURCE.sourceCommit,
        sourceTree: SOURCE.sourceTree,
        promotionCommit: 'b'.repeat(40),
        promotionTree: SOURCE.sourceTree,
        runs: {},
        controllerReceipt: controller(),
        candidateArtifact: 'candidate',
        mode: 'rehearsal',
        generatedAt: '2026-07-26T01:48:00.000Z',
      }),
    /receipt root mismatch/u,
  );
  assert.throws(
    () =>
      createAlphaReleaseTimeline({
        contract: CONTRACT,
        preflightReceipt: receipt,
        sourceCommit: SOURCE.sourceCommit,
        sourceTree: SOURCE.sourceTree,
        promotionCommit: 'b'.repeat(40),
        promotionTree: SOURCE.sourceTree,
        runs: {},
        controllerReceipt: controller(),
        candidateArtifact: 'candidate',
        mode: 'rehearsal',
        generatedAt: '2026-08-03T01:00:01.000Z',
      }),
    /receipt age/u,
  );
});

test('partial publication, failed controller and receipt substitution fail closed', () => {
  assert.throws(
    () =>
      createAlphaReleaseTimeline({
        contract: CONTRACT,
        preflightReceipt: preflight(),
        sourceCommit: SOURCE.sourceCommit,
        sourceTree: SOURCE.sourceTree,
        promotionCommit: 'b'.repeat(40),
        promotionTree: SOURCE.sourceTree,
        runs: {},
        controllerReceipt: controller('failed'),
        candidateArtifact: 'candidate',
        mode: 'release',
        generatedAt: '2026-07-26T01:48:00.000Z',
      }),
    /controller receipt is not qualifying/u,
  );
  const observed = fixture();
  observed.artifactLineage.publication.payloadRoot = '';
  assert.throws(
    () => verifyAlphaReleaseTimeline({ receipt: observed, contract: CONTRACT }),
    /timeline receipt root mismatch/u,
  );
  const replay = fixture();
  replay.artifactLineage.promotionControllerReceiptDigest =
    replay.candidate.preflightReceiptRoot;
  const { receiptRoot: _old, ...body } = replay;
  const forged = { ...body, receiptRoot: 'sha256:forged' };
  assert.throws(
    () => verifyAlphaReleaseTimeline({ receipt: forged, contract: CONTRACT }),
    /timeline receipt root mismatch/u,
  );
});

test('artifact substitution, failed signing, readback roots and replay fail closed', () => {
  assert.throws(
    () => fixture('release', { candidateArtifact: 'substituted-candidate' }),
    /artifact is not source-addressed/u,
  );
  const failedSigning = timelineRuns();
  failedSigning.candidate.jobs[0].steps[1].conclusion = 'failure';
  assert.throws(
    () => fixture('release', { runs: failedSigning }),
    /phase failed: Sign and notarize/u,
  );
  assert.throws(
    () =>
      fixture('release', {
        publication: {
          evidenceDigest: 'sha256:partial',
          payloadRoot: `sha256:${'d'.repeat(64)}`,
          publicUrl: 'https://example.invalid/readback',
        },
      }),
    /publication evidence digest must be an exact SHA-256 root/u,
  );
  assert.throws(
    () => fixture('release', { promotionTree: 'e'.repeat(40) }),
    /promotion tree does not match/u,
  );
  const replayReport = summarizeAlphaReleaseSlo({
    receipts: [fixture(), fixture()],
    contract: CONTRACT,
  });
  assert.equal(replayReport.sampleCount, 1);
  assert.equal(replayReport.replayCount, 1);
});

test('retry remains visible without becoming a second SLO sample', () => {
  const retried = timelineRuns();
  retried.promotion.run_attempt = 2;
  const receipt = fixture('release', { runs: retried });
  assert.equal(receipt.timing.retries, 1);
});
