// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { semanticRoot } from '@kungfu-tech/work/project-cut';
import {
  MINIMUM_DEFAULT_PROMOTION_SAMPLES,
  WORK_DESIGN_REPLAY_REQUEST_SCHEMA,
  buildWorkDesignActivationEnvelope,
  buildWorkDesignMonitoring,
  buildWorkDesignPolicyState,
  buildWorkDesignPromotionArtifact,
  buildWorkDesignReplayCohort,
  buildWorkDesignReplayPolicy,
  buildWorkDesignReplaySample,
  compileOutcomeReplaySample,
  compileProspectiveOutcomeBinding,
  compileWorkDesignOutcome,
  decideWorkDesignActivation,
  decideWorkDesignCanary,
  evaluateWorkDesignShadow,
  inspectWorkDesignFeedback,
  replayWorkDesignPolicy,
  transitionWorkDesignPolicyState,
  verifyWorkDesignOutcome,
  verifyWorkDesignPromotionArtifact,
  verifyWorkDesignReplayReport,
  workDesignReplayAuthorityBoundary,
} from '@kungfu-tech/work/work-design-policy-replay';
import { checkWorkDesignPolicyReplayContract } from '@kungfu-tech/work/work-design-policy-replay/tooling/work-design-policy-replay-contract';

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

function rootedStub(rootKey, value) {
  return { ...value, [rootKey]: semanticRoot(value) };
}

test('contract roots, schemas, promotion floor, and non-authority are welded', () => {
  const checked = checkWorkDesignPolicyReplayContract();
  assert.equal(checked.schemaFiles, 12);
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

function outcomeRequest(id = 'outcome-001', overrides = {}) {
  const request = {
    schema: 'kungfu.work-design.outcome-compilation-request/v1',
    asOf: '2026-07-31T14:00:00Z',
    work: {
      assignmentId: id,
      workDefinitionRoot: semanticRoot({ id, work: 1 }),
      adviceRoot: semanticRoot({ id, advice: 1 }),
      policyRoot: baselinePolicy.policyRoot,
      deliveryClass: 'native-proof-required',
      workClass: 'bounded-protocol',
      repositoryClass: 'kungfu-core',
      plannedBudgetSeconds: 5400,
      admittedAt: '2026-07-31T09:00:00Z',
      settledAt: '2026-07-31T13:00:00Z',
      settledState: {
        schema: 'kungfu.assignment-orchestration.sealed-work-coordinate/v1',
        stateRoot: semanticRoot({ id, state: 1 }),
        queryProofRoot: semanticRoot({ id, query: 1 }),
        phase: 'continuation-decided',
        settled: true,
      },
    },
    activeIntervals: [
      {
        start: '2026-07-31T09:00:00Z',
        end: '2026-07-31T10:00:00Z',
        evidenceRoot: semanticRoot({ id, active: 1 }),
      },
      {
        start: '2026-07-31T11:00:00Z',
        end: '2026-07-31T12:00:00Z',
        evidenceRoot: semanticRoot({ id, active: 2 }),
      },
    ],
    excludedWaits: [
      {
        class: 'external-review',
        start: '2026-07-31T10:00:00Z',
        end: '2026-07-31T11:00:00Z',
        evidenceRoot: semanticRoot({ id, wait: 1 }),
      },
    ],
    reworkEvents: [
      {
        kind: 'acceptance-reopen',
        observedAt: '2026-07-31T12:10:00Z',
        evidenceRoot: semanticRoot({ id, reopen: 1 }),
      },
    ],
    dependencyRevisions: [
      {
        observedAt: '2026-07-31T09:30:00Z',
        previousGraphRoot: semanticRoot({ id, graph: 1 }),
        nextGraphRoot: semanticRoot({ id, graph: 2 }),
        evidenceRoot: semanticRoot({ id, revision: 1 }),
      },
    ],
    acceptanceAssessments: [
      {
        observedAt: '2026-07-31T12:30:00Z',
        verdict: 'unfit',
        evidenceRoot: semanticRoot({ id, assessment: 1 }),
      },
    ],
    completeness: {
      timing: true,
      rework: true,
      dependency: true,
      acceptance: true,
    },
    sourceEvidenceRoots: [semanticRoot({ id, evidence: 1 })],
  };
  return { ...request, ...overrides };
}

function compiledOutcome(id = 'outcome-001', overrides = {}) {
  const result = compileWorkDesignOutcome(outcomeRequest(id, overrides));
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  return result.outcome;
}

test('the build-free Shifu CLI compiles a rooted outcome', (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'POSIX launcher smoke is covered separately from the Windows route contract',
    );
    return;
  }
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-design-feedback-'),
  );
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, 'outcome-request.json');
  fs.writeFileSync(input, `${JSON.stringify(outcomeRequest('cli-outcome'))}\n`);
  const result = spawnSync(
    './shifu',
    ['work-design:feedback', 'compile', '--input', input],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const compiled = JSON.parse(result.stdout);
  assert.equal(compiled.ok, true);
  assert.equal(verifyWorkDesignOutcome(compiled.outcome).ok, true);
});

test('settled outcomes compile deterministically with exact metric attribution', () => {
  const request = outcomeRequest();
  const first = compileWorkDesignOutcome(request);
  const second = compileWorkDesignOutcome(structuredClone(request));
  assert.deepEqual(second, first);
  assert.equal(first.ok, true);
  assert.equal(first.outcome.window.attributableActiveSeconds, 7200);
  assert.equal(
    first.outcome.window.excludedWaitSeconds['external-review'],
    3600,
  );
  assert.deepEqual(first.outcome.metrics.timeout, {
    status: 'qualified',
    plannedBudgetSeconds: 5400,
    attributableActiveSeconds: 7200,
    overrunSeconds: 1800,
    exceeded: true,
  });
  assert.equal(first.outcome.metrics.rework.count, 1);
  assert.equal(first.outcome.metrics.dependencyCorrection.count, 1);
  assert.equal(first.outcome.metrics.acceptanceFailure.count, 1);
  assert.equal(first.outcome.coverage.complete, true);
  assert.equal(verifyWorkDesignOutcome(first.outcome).ok, true);
});

test('legacy missing evidence remains unknown and as_of or attribution inference fails closed', () => {
  const request = outcomeRequest('legacy');
  request.completeness = {
    timing: false,
    rework: false,
    dependency: false,
    acceptance: false,
  };
  request.work.plannedBudgetSeconds = null;
  const legacy = compileWorkDesignOutcome(request);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.outcome.coverage.complete, false);
  assert.deepEqual(legacy.outcome.coverage.unknownMetrics, [
    'acceptanceFailure',
    'dependencyCorrection',
    'rework',
    'timeout',
  ]);
  assert.equal(legacy.outcome.metrics.timeout.exceeded, null);

  const leaked = outcomeRequest('leaked');
  leaked.acceptanceAssessments[0].observedAt = '2026-08-01T00:00:00Z';
  assert.ok(
    diagnosticCodes(compileWorkDesignOutcome(leaked)).includes('as-of-leakage'),
  );
  const commitCount = outcomeRequest('commit-count');
  commitCount.reworkEvents[0].kind = 'commit';
  assert.ok(
    diagnosticCodes(compileWorkDesignOutcome(commitCount)).includes(
      'invalid-rework-event',
    ),
  );
  const preAdmission = outcomeRequest('pre-admission');
  preAdmission.dependencyRevisions[0].observedAt = '2026-07-31T08:00:00Z';
  assert.ok(
    diagnosticCodes(compileWorkDesignOutcome(preAdmission)).includes(
      'pre-admission-dependency-change',
    ),
  );
});

test('outcomes compile directly into the existing rooted replay sample path', () => {
  const outcome = compiledOutcome('replay-outcome');
  const result = compileOutcomeReplaySample({
    outcome,
    qualifiedAt: '2026-07-31T14:00:00Z',
    baseline: evaluation(baselinePolicy.policyRoot, 'replay-outcome'),
    candidate: evaluation(candidatePolicy.policyRoot, 'replay-outcome'),
    drift: {
      classification: 'none',
      evidenceRoot: semanticRoot({ replay: 'reviewed' }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.sample.baseline.outcomeRoot, outcome.outcomeRoot);
  assert.equal(
    result.sample.candidate.coverageRoot,
    outcome.coverage.coverageRoot,
  );
  assert.match(result.sample.sampleRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('prospective binding conserves active classes and keeps waits excluded', () => {
  const outcome = compiledOutcome('prospective-outcome');
  const openingPreimage = {
    schema: 'kungfu.work-design.opening-estimate-binding/v1',
    assignmentId: outcome.assignmentId,
    asOf: '2026-07-31T09:00:00Z',
    workDefinitionRoot: outcome.bindings.workDefinitionRoot,
    adviceRoot: outcome.bindings.adviceRoot,
    estimateRoot: semanticRoot({ estimate: 'prospective' }),
    targetCohortRoot: outcome.cohort.cohortRoot,
    guidance: {
      phase: 'observation-only',
      defaultPolicyInfluence: false,
    },
    authority: {
      mode: 'opening-observation-only',
      assignmentAuthority: false,
      finalWorkDefinitionAuthority: false,
      mayMutate: false,
    },
  };
  const openingEstimate = {
    ...openingPreimage,
    openingEstimateRoot: semanticRoot(openingPreimage),
  };
  const activeSegments = [
    {
      class: 'implementation-debug',
      seconds: 6000,
      evidenceRoot: semanticRoot({ activity: 'implementation' }),
    },
    {
      class: 'local-validation',
      seconds: 1200,
      evidenceRoot: semanticRoot({ activity: 'validation' }),
    },
  ];
  const result = compileProspectiveOutcomeBinding({
    openingEstimate,
    outcome,
    activeSegments,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.binding.activeEngineeringSeconds, {
    'implementation-debug': 6000,
    'local-validation': 1200,
  });
  assert.equal(result.binding.excludedWaitSeconds['external-review'], 3600);
  assert.equal(result.binding.authority.assignmentAuthority, false);

  const mismatch = compileProspectiveOutcomeBinding({
    openingEstimate,
    outcome,
    activeSegments: [
      { ...activeSegments[0], seconds: 5999 },
      activeSegments[1],
    ],
  });
  assert.equal(mismatch.ok, false);
  assert.ok(
    mismatch.diagnostics.some(
      ({ code }) => code === 'active-attribution-mismatch',
    ),
  );
});

test('shadow thresholds are exact at 9, 10, 29, and 30 per comparable cohort', () => {
  const seed = compiledOutcome('shadow-seed');
  const cohortRoot = seed.cohort.cohortRoot;
  const replayReport = rootedStub('reportRoot', {
    defaultPromotionEligible: true,
  });
  const statuses = new Map();
  for (const count of [9, 10, 29, 30]) {
    const outcomes = Array.from({ length: count }, (_, index) =>
      compiledOutcome(`shadow-${count}-${String(index).padStart(2, '0')}`),
    );
    const result = evaluateWorkDesignShadow({
      asOf: '2026-07-31T14:00:00Z',
      replayReport,
      activePolicyRoot: baselinePolicy.policyRoot,
      candidatePolicyRoot: candidatePolicy.policyRoot,
      requiredCohortRoots: [cohortRoot],
      outcomes,
    });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    statuses.set(count, result.status);
  }
  assert.equal(statuses.get(9).phase, 'observation-only');
  assert.equal(statuses.get(10).phase, 'tentative-trend');
  assert.equal(statuses.get(29).phase, 'tentative-trend');
  assert.equal(statuses.get(30).phase, 'promotion-eligible');
  assert.equal(statuses.get(29).defaultPromotionEligible, false);
  assert.equal(statuses.get(30).defaultPromotionEligible, true);
});

test('aggregate volume cannot conceal one under-sampled comparable cohort', () => {
  const first = compiledOutcome('cohort-a');
  const secondRequest = outcomeRequest('cohort-b');
  secondRequest.work.workClass = 'release-work';
  const second = compileWorkDesignOutcome(secondRequest).outcome;
  const outcomes = [
    ...Array.from({ length: 30 }, (_, index) =>
      compiledOutcome(`cohort-a-${index}`),
    ),
    ...Array.from({ length: 29 }, (_, index) => {
      const request = outcomeRequest(`cohort-b-${index}`);
      request.work.workClass = 'release-work';
      return compileWorkDesignOutcome(request).outcome;
    }),
  ];
  const replayReport = rootedStub('reportRoot', {
    defaultPromotionEligible: true,
  });
  const result = evaluateWorkDesignShadow({
    asOf: '2026-07-31T14:00:00Z',
    replayReport,
    activePolicyRoot: baselinePolicy.policyRoot,
    candidatePolicyRoot: candidatePolicy.policyRoot,
    requiredCohortRoots: [
      first.cohort.cohortRoot,
      second.cohort.cohortRoot,
    ].sort(),
    outcomes,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status.phase, 'tentative-trend');
  assert.equal(result.status.defaultPromotionEligible, false);
  assert.ok(
    result.status.blockingReasons.includes(
      `cohort-below-30:${second.cohort.cohortRoot}`,
    ),
  );
});

test('bounded activation canaries automatically, fences concurrency, and rolls back exactly', () => {
  const outcome = compiledOutcome('activation-seed');
  const replayReport = rootedStub('reportRoot', {
    defaultPromotionEligible: true,
  });
  const outcomes = Array.from({ length: 30 }, (_, index) =>
    compiledOutcome(`activation-${String(index).padStart(2, '0')}`),
  );
  const shadowStatus = evaluateWorkDesignShadow({
    asOf: '2026-07-31T14:00:00Z',
    replayReport,
    activePolicyRoot: baselinePolicy.policyRoot,
    candidatePolicyRoot: candidatePolicy.policyRoot,
    requiredCohortRoots: [outcome.cohort.cohortRoot],
    outcomes,
  }).status;
  const envelope = buildWorkDesignActivationEnvelope({
    id: 'work-design-default-activation',
    version: 1,
    activePolicyRoot: baselinePolicy.policyRoot,
    allowedParameterPaths: ['maximumRegressionRateBps'],
    requiredCohortRoots: [outcome.cohort.cohortRoot],
    maximumRegressionRateBps: 0,
  });
  const initial = buildWorkDesignPolicyState({
    activePolicyRoot: baselinePolicy.policyRoot,
  });
  const activation = decideWorkDesignActivation({
    observedAt: '2026-07-31T14:00:00Z',
    state: initial,
    envelope,
    promotionArtifact: rootedStub('promotionRoot', {
      activePolicyRoot: baselinePolicy.policyRoot,
      eligibility: { eligible: true },
    }),
    shadowStatus,
    candidatePolicyRoot: candidatePolicy.policyRoot,
    changedParameterPaths: ['maximumRegressionRateBps'],
    evidenceRoots: [shadowStatus.statusRoot],
  });
  assert.equal(activation.action, 'start-canary');
  const canary = transitionWorkDesignPolicyState(initial, activation);
  assert.equal(canary.ok, true);
  assert.equal(canary.state.phase, 'canary');
  const stale = transitionWorkDesignPolicyState(canary.state, activation);
  assert.equal(stale.ok, false);
  assert.ok(diagnosticCodes(stale).includes('stale-decision'));

  const qualifiedMonitoring = buildWorkDesignMonitoring({
    observedAt: '2026-07-31T14:30:00Z',
    policyRoot: candidatePolicy.policyRoot,
    qualifiedSampleCount: 10,
    regressionRateBps: 0,
    evidenceRoots: [semanticRoot({ canary: 'qualified' })],
  });
  const promotion = decideWorkDesignCanary({
    observedAt: qualifiedMonitoring.observedAt,
    state: canary.state,
    envelope,
    monitoring: qualifiedMonitoring,
    evidenceRoots: [qualifiedMonitoring.monitoringRoot],
  });
  assert.equal(promotion.action, 'promote');
  const promoted = transitionWorkDesignPolicyState(canary.state, promotion);
  assert.equal(promoted.ok, true);
  assert.equal(promoted.state.activePolicyRoot, candidatePolicy.policyRoot);
  assert.deepEqual(
    transitionWorkDesignPolicyState(canary.state, promotion),
    promoted,
    'the rooted reducer reconstructs the same successor after restart',
  );

  const monitoring = buildWorkDesignMonitoring({
    observedAt: '2026-07-31T15:00:00Z',
    policyRoot: candidatePolicy.policyRoot,
    qualifiedSampleCount: 10,
    regressionRateBps: 1,
    evidenceRoots: [semanticRoot({ canary: 'regressed' })],
  });
  const rollback = decideWorkDesignCanary({
    observedAt: '2026-07-31T15:00:00Z',
    state: canary.state,
    envelope,
    monitoring,
    evidenceRoots: [monitoring.monitoringRoot],
  });
  assert.equal(rollback.action, 'rollback');
  assert.equal(rollback.toPolicyRoot, baselinePolicy.policyRoot);
  const restored = transitionWorkDesignPolicyState(canary.state, rollback);
  assert.equal(restored.ok, true);
  assert.equal(restored.state.activePolicyRoot, baselinePolicy.policyRoot);
  assert.equal(restored.state.rollbackRoot, rollback.decisionRoot);
  const view = inspectWorkDesignFeedback({
    state: restored.state,
    shadowStatus,
    monitoring,
  });
  assert.equal(view.ok, true);
  assert.equal(view.inspection.authority.mayMutate, false);
  assert.equal(view.inspection.rollbackRoot, rollback.decisionRoot);
});

test('a promoted policy remains monitored and restores the exact previous root', () => {
  const envelope = buildWorkDesignActivationEnvelope({
    id: 'post-promotion-monitoring',
    version: 1,
    activePolicyRoot: baselinePolicy.policyRoot,
    allowedParameterPaths: ['maximumRegressionRateBps'],
    requiredCohortRoots: [semanticRoot({ cohort: 'post-promotion' })],
    maximumRegressionRateBps: 0,
  });
  const promoted = buildWorkDesignPolicyState({
    version: 3,
    activePolicyRoot: candidatePolicy.policyRoot,
    previousPolicyRoot: baselinePolicy.policyRoot,
    phase: 'promoted',
    activationRoot: semanticRoot({ activation: 'candidate' }),
  });
  const monitoring = buildWorkDesignMonitoring({
    observedAt: '2026-07-31T16:00:00Z',
    policyRoot: candidatePolicy.policyRoot,
    qualifiedSampleCount: 30,
    regressionRateBps: 1,
    evidenceRoots: [semanticRoot({ monitoring: 'post-promotion-regression' })],
  });
  const rollback = decideWorkDesignCanary({
    observedAt: monitoring.observedAt,
    state: promoted,
    envelope,
    monitoring,
    evidenceRoots: [monitoring.monitoringRoot],
  });
  assert.equal(rollback.action, 'rollback');
  assert.equal(rollback.toPolicyRoot, baselinePolicy.policyRoot);
  const restored = transitionWorkDesignPolicyState(promoted, rollback);
  assert.equal(restored.ok, true, JSON.stringify(restored.diagnostics));
  assert.equal(restored.state.activePolicyRoot, baselinePolicy.policyRoot);
});

test('semantic expansion returns human-decision-required without state mutation', () => {
  const state = buildWorkDesignPolicyState({
    activePolicyRoot: baselinePolicy.policyRoot,
  });
  const envelope = buildWorkDesignActivationEnvelope({
    id: 'bounded',
    version: 1,
    activePolicyRoot: baselinePolicy.policyRoot,
    allowedParameterPaths: ['maximumRegressionRateBps'],
    requiredCohortRoots: [semanticRoot({ cohort: 'one' })],
    maximumRegressionRateBps: 0,
  });
  const result = decideWorkDesignActivation({
    observedAt: '2026-07-31T14:00:00Z',
    state,
    envelope,
    promotionArtifact: rootedStub('promotionRoot', {
      activePolicyRoot: baselinePolicy.policyRoot,
      eligibility: { eligible: true },
    }),
    shadowStatus: rootedStub('statusRoot', {
      defaultPromotionEligible: true,
      candidatePolicyRoot: candidatePolicy.policyRoot,
    }),
    candidatePolicyRoot: candidatePolicy.policyRoot,
    changedParameterPaths: ['objective'],
    evidenceRoots: [],
  });
  assert.equal(result.status, 'human-decision-required');
  assert.equal(result.action, 'none');
  assert.equal(transitionWorkDesignPolicyState(state, result).ok, false);
});

test('root tampering blocks activation, monitoring, status, and state transition', () => {
  const state = buildWorkDesignPolicyState({
    activePolicyRoot: baselinePolicy.policyRoot,
  });
  const envelope = buildWorkDesignActivationEnvelope({
    id: 'tamper-check',
    version: 1,
    activePolicyRoot: baselinePolicy.policyRoot,
    allowedParameterPaths: ['maximumRegressionRateBps'],
    requiredCohortRoots: [semanticRoot({ cohort: 'tamper' })],
    maximumRegressionRateBps: 0,
  });
  const tamperedEnvelope = {
    ...envelope,
    allowedParameterPaths: ['objective'],
  };
  const activation = decideWorkDesignActivation({
    observedAt: '2026-07-31T17:00:00Z',
    state,
    envelope: tamperedEnvelope,
    promotionArtifact: rootedStub('promotionRoot', {
      activePolicyRoot: baselinePolicy.policyRoot,
      eligibility: { eligible: true },
    }),
    shadowStatus: rootedStub('statusRoot', {
      defaultPromotionEligible: true,
      candidatePolicyRoot: candidatePolicy.policyRoot,
    }),
    candidatePolicyRoot: candidatePolicy.policyRoot,
    changedParameterPaths: ['objective'],
    evidenceRoots: [],
  });
  assert.equal(activation.reason, 'invalid-activation-proof');

  const monitoring = buildWorkDesignMonitoring({
    observedAt: '2026-07-31T17:01:00Z',
    policyRoot: candidatePolicy.policyRoot,
    qualifiedSampleCount: 10,
    regressionRateBps: 0,
    evidenceRoots: [],
  });
  monitoring.qualifiedSampleCount = 11;
  assert.equal(
    decideWorkDesignCanary({
      observedAt: monitoring.observedAt,
      state,
      envelope,
      monitoring,
      evidenceRoots: [],
    }).reason,
    'invalid-monitoring-proof',
  );
  assert.equal(
    inspectWorkDesignFeedback({ state: { ...state, version: 2 } }).ok,
    false,
  );

  const escalated = rootedStub('decisionRoot', {
    schema: 'kungfu.work-design.policy-decision/v1',
    observedAt: '2026-07-31T17:02:00Z',
    expectedStateRoot: state.stateRoot,
    envelopeRoot: envelope.envelopeRoot,
    action: 'start-canary',
    status: 'authorized',
    reason: 'tampered-authority',
    fromPolicyRoot: baselinePolicy.policyRoot,
    toPolicyRoot: candidatePolicy.policyRoot,
    evidenceRoots: [],
    authority: { mode: 'unbounded' },
  });
  assert.ok(
    diagnosticCodes(transitionWorkDesignPolicyState(state, escalated)).includes(
      'authority-escalation',
    ),
  );
});
