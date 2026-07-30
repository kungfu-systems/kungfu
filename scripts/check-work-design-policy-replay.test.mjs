// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRoot } from '../framework/project-cut/src/project-cut.mjs';
import {
  MINIMUM_DEFAULT_PROMOTION_SAMPLES,
  WORK_DESIGN_REPLAY_REQUEST_SCHEMA,
  buildWorkDesignPromotionArtifact,
  buildWorkDesignReplayCohort,
  buildWorkDesignReplayPolicy,
  buildWorkDesignReplaySample,
  replayWorkDesignPolicy,
  verifyWorkDesignPromotionArtifact,
  verifyWorkDesignReplayReport,
  workDesignReplayAuthorityBoundary,
} from '../framework/work-design-policy-replay/src/work-design-policy-replay.mjs';
import { checkWorkDesignPolicyReplayContract } from '../framework/work-design-policy-replay/tooling/work-design-policy-replay-contract.mjs';

const AS_OF = '2026-07-29T12:00:00Z';
const baselinePolicy = buildWorkDesignReplayPolicy({
  id: 'work-design-default',
  version: 1,
  advisorPolicyRoot: semanticRoot({ advisor: 'v1' }),
  maximumRegressionRateBps: 0,
});
const candidatePolicy = buildWorkDesignReplayPolicy({
  id: 'work-design-default',
  version: 2,
  advisorPolicyRoot: semanticRoot({ advisor: 'v2' }),
  maximumRegressionRateBps: 0,
});

function evaluation(policyRoot, id, variant = 'same') {
  return {
    policyRoot,
    selectionRoot: semanticRoot({ id, dimension: 'selection', variant }),
    adviceRoot: semanticRoot({ id, dimension: 'advice', variant }),
    dispositionRoot: semanticRoot({ id, dimension: 'disposition', variant }),
    outcomeRoot: semanticRoot({ id, dimension: 'outcome', variant }),
    coverageRoot: semanticRoot({ id, dimension: 'coverage', variant }),
  };
}

function sample(id, options = {}) {
  const baseline = evaluation(baselinePolicy.policyRoot, id);
  const candidate = evaluation(
    candidatePolicy.policyRoot,
    id,
    options.changed ? 'candidate' : 'same',
  );
  return buildWorkDesignReplaySample({
    id,
    qualifiedAt: options.qualifiedAt ?? '2026-07-29T11:00:00Z',
    qualificationRoot: semanticRoot({ id, qualification: 'complete' }),
    baseline,
    candidate,
    drift: {
      classification:
        options.classification ?? (options.changed ? 'expected' : 'none'),
      evidenceRoot: semanticRoot({ id, drift: 'reviewed' }),
    },
  });
}

function request(samples, overrides = {}) {
  const cohort = buildWorkDesignReplayCohort({ asOf: AS_OF, samples });
  return {
    schema: WORK_DESIGN_REPLAY_REQUEST_SCHEMA,
    asOf: AS_OF,
    cohort,
    expectedCohortRoot: cohort.cohortRoot,
    baselinePolicy,
    candidatePolicy,
    ...overrides,
  };
}

function diagnosticCodes(result) {
  return result.diagnostics.map(({ code }) => code);
}

test('contract roots, schemas, promotion floor, and non-authority are welded', () => {
  const checked = checkWorkDesignPolicyReplayContract();
  assert.equal(checked.schemaFiles, 4);
  assert.match(checked.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(MINIMUM_DEFAULT_PROMOTION_SAMPLES, 30);
  assert.deepEqual(workDesignReplayAuthorityBoundary(), {
    mode: 'offline-advisory',
    assignmentAuthority: false,
    workControlAuthority: false,
    repositoryAuthority: false,
    protectedBranchAuthority: false,
    activeDefaultPolicyAuthority: false,
    mayMutate: false,
  });
});

test('one qualified sample replays deterministically in advisory mode but cannot promote', () => {
  const replayRequest = request([sample('sample-001', { changed: true })]);
  const first = replayWorkDesignPolicy(replayRequest);
  const second = replayWorkDesignPolicy(structuredClone(replayRequest));
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(first.report.sampleCount, 1);
  assert.equal(first.report.advisoryModeEligible, true);
  assert.equal(first.report.defaultPromotionEligible, false);
  assert.equal(first.report.gates.sampleThresholdSatisfied, false);
  for (const dimension of [
    'selection',
    'advice',
    'disposition',
    'outcome',
    'coverage',
  ])
    assert.deepEqual(first.report.comparison[dimension], {
      changedCount: 1,
      sampleIds: ['sample-001'],
    });
  assert.equal(verifyWorkDesignReplayReport(first.report).ok, true);

  const promotion = buildWorkDesignPromotionArtifact({
    report: first.report,
    candidatePolicy,
    activePolicyRoot: baselinePolicy.policyRoot,
    rollbackPolicyRoot: baselinePolicy.policyRoot,
  });
  assert.equal(promotion.ok, true);
  assert.equal(promotion.artifact.eligibility.eligible, false);
  assert.equal(promotion.artifact.activation.activated, false);
  assert.equal(verifyWorkDesignPromotionArtifact(promotion.artifact).ok, true);
});

test('thirty exact qualified samples can produce an eligible but never activating candidate', () => {
  const samples = Array.from({ length: 30 }, (_, index) =>
    sample(`sample-${String(index + 1).padStart(3, '0')}`),
  );
  const result = replayWorkDesignPolicy(request(samples));
  assert.equal(result.ok, true);
  assert.equal(result.report.defaultPromotionEligible, true);
  assert.equal(result.report.gates.sampleThresholdSatisfied, true);
  const promotion = buildWorkDesignPromotionArtifact({
    report: result.report,
    candidatePolicy,
    activePolicyRoot: baselinePolicy.policyRoot,
    rollbackPolicyRoot: baselinePolicy.policyRoot,
  });
  assert.equal(promotion.ok, true);
  assert.equal(promotion.artifact.eligibility.eligible, true);
  assert.deepEqual(promotion.artifact.activation, {
    mode: 'separately-authorized-native-decision-required',
    targetPolicyRoot: candidatePolicy.policyRoot,
    activated: false,
  });
});

test('as_of leakage and exact cohort-root mismatch reject replay', () => {
  const leaked = request([
    sample('future', { qualifiedAt: '2026-07-30T00:00:00Z' }),
  ]);
  assert.ok(
    diagnosticCodes(replayWorkDesignPolicy(leaked)).includes('as-of-leakage'),
  );
  const mismatched = request([sample('sample-001')], {
    expectedCohortRoot: semanticRoot({ cohort: 'other' }),
  });
  assert.ok(
    diagnosticCodes(replayWorkDesignPolicy(mismatched)).includes(
      'cohort-root-mismatch',
    ),
  );
});

test('missing outcomes and policy drift reject replay without a report', () => {
  const missingOutcome = request([sample('sample-001')]);
  missingOutcome.cohort.samples[0].candidate.outcomeRoot = null;
  const { sampleRoot: _missingRoot, ...missingPreimage } =
    missingOutcome.cohort.samples[0];
  missingOutcome.cohort.samples[0].sampleRoot = semanticRoot(missingPreimage);
  const missing = replayWorkDesignPolicy(missingOutcome);
  assert.equal(missing.report, null);
  assert.ok(diagnosticCodes(missing).includes('invalid-root'));

  const drifted = request([sample('sample-001')]);
  drifted.cohort.samples[0].candidate.policyRoot = semanticRoot({
    policy: 'undeclared',
  });
  const { sampleRoot: _driftedRoot, ...preimage } = drifted.cohort.samples[0];
  drifted.cohort.samples[0].sampleRoot = semanticRoot(preimage);
  const drift = replayWorkDesignPolicy(drifted);
  assert.equal(drift.report, null);
  assert.ok(diagnosticCodes(drift).includes('policy-drift'));
});

test('unclassified drift and regressions fail promotion gates visibly', () => {
  const unclassified = replayWorkDesignPolicy(
    request([
      sample('sample-001', {
        changed: true,
        classification: 'unclassified',
      }),
    ]),
  );
  assert.equal(unclassified.ok, true);
  assert.equal(unclassified.report.gates.driftQualified, false);
  assert.equal(unclassified.report.defaultPromotionEligible, false);

  const regression = replayWorkDesignPolicy(
    request([
      sample('sample-001', {
        changed: true,
        classification: 'regression',
      }),
    ]),
  );
  assert.equal(regression.ok, true);
  assert.equal(regression.report.drift.regressionRateBps, 10000);
  assert.equal(regression.report.gates.regressionWithinThreshold, false);
  assert.equal(regression.report.defaultPromotionEligible, false);
});

test('rollback mismatch and authority escalation fail closed', () => {
  const replay = replayWorkDesignPolicy(request([sample('sample-001')]));
  const promotion = buildWorkDesignPromotionArtifact({
    report: replay.report,
    candidatePolicy,
    activePolicyRoot: baselinePolicy.policyRoot,
    rollbackPolicyRoot: semanticRoot({ policy: 'wrong-rollback' }),
  });
  assert.equal(promotion.ok, false);
  assert.equal(promotion.artifact.eligibility.rollbackVerified, false);
  assert.ok(diagnosticCodes(promotion).includes('rollback-root-mismatch'));

  const escalated = structuredClone(replay.report);
  escalated.authority.assignmentAuthority = true;
  const { reportRoot: _reportRoot, ...preimage } = escalated;
  escalated.reportRoot = semanticRoot(preimage);
  const verified = verifyWorkDesignReplayReport(escalated);
  assert.equal(verified.ok, false);
  assert.ok(diagnosticCodes(verified).includes('authority-escalation'));
});

test('rerooted report and promotion structure drift fail independent verification', () => {
  const replay = replayWorkDesignPolicy(
    request([sample('sample-001', { changed: true })]),
  );
  const report = structuredClone(replay.report);
  report.comparison.outcome.changedCount = 0;
  const { reportRoot: _reportRoot, ...reportPreimage } = report;
  report.reportRoot = semanticRoot(reportPreimage);
  const reportVerification = verifyWorkDesignReplayReport(report);
  assert.equal(reportVerification.ok, false);
  assert.ok(
    diagnosticCodes(reportVerification).includes('comparison-count-mismatch'),
  );

  const promotion = buildWorkDesignPromotionArtifact({
    report: replay.report,
    candidatePolicy,
    activePolicyRoot: baselinePolicy.policyRoot,
    rollbackPolicyRoot: baselinePolicy.policyRoot,
  }).artifact;
  promotion.unexpectedAuthority = true;
  const { promotionRoot: _promotionRoot, ...promotionPreimage } = promotion;
  promotion.promotionRoot = semanticRoot(promotionPreimage);
  const promotionVerification = verifyWorkDesignPromotionArtifact(promotion);
  assert.equal(promotionVerification.ok, false);
  assert.ok(
    diagnosticCodes(promotionVerification).includes('object-shape-mismatch'),
  );
});
