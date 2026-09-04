// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRoot } from '../framework/work/project-cut/index.mjs';
import {
  WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA,
  buildOpeningEstimateBinding,
  buildOutcomeInformedEstimate,
  buildWorkDesignAdvice,
  buildWorkDesignDisposition,
  buildWorkDesignPolicy,
  verifyOutcomeInformedEstimate,
  verifyWorkDesignAdvice,
  verifyWorkDesignDisposition,
  workDesignAdvisoryBoundary,
} from '../framework/work/work-design-advisor/src/work-design-advisor.mjs';
import { checkWorkDesignAdvisorContract } from '../framework/work/work-design-advisor/tooling/work-design-advisor-contract.mjs';

const AS_OF = '2026-07-29T10:00:00Z';
const INTENT_ROOT = semanticRoot({ objective: 'bounded-advisory-work-design' });
const SELECTION_ROOT = semanticRoot({ history: 'selection' });
const HISTORY_VERIFICATION_ROOT = semanticRoot({
  history: 'selection-verification',
});
const XINFA_ROOT = semanticRoot({ xinfa: 'current' });
const { authority, humanOverride } = workDesignAdvisoryBoundary();

function evidence(prefix) {
  return [
    {
      id: `${prefix}-review`,
      kind: 'review',
      requirementRoot: semanticRoot({ evidence: prefix, kind: 'review' }),
    },
    {
      id: `${prefix}-test`,
      kind: 'test',
      requirementRoot: semanticRoot({ evidence: prefix, kind: 'test' }),
    },
  ];
}

function acceptance(prefix) {
  return [
    {
      id: `${prefix}-acceptance`,
      criterionRoot: semanticRoot({ acceptance: prefix }),
    },
  ];
}

function slice(id, dependsOn = [], budgetHours = 4) {
  return {
    id,
    objectiveRoot: semanticRoot({ slice: id }),
    dependsOn,
    budgetHours,
    deliveryClass: 'native-proof-required',
    acceptance: acceptance(id),
    requiredEvidence: evidence(id),
    continuation: {
      mode: 'reassess',
      conditionRoots: [semanticRoot({ continuation: id })],
    },
  };
}

function policy(overrides = {}) {
  return buildWorkDesignPolicy({
    id: 'work-design-advisory-v1',
    version: 1,
    maxSlices: 4,
    maxTotalBudgetHours: 12,
    maxSliceBudgetHours: 6,
    allowedDeliveryClasses: ['native-proof-required'],
    requiredEvidenceKinds: ['review', 'test'],
    ...overrides,
  });
}

function request(overrides = {}) {
  const base = {
    schema: 'kungfu.work-design.advice-request/v1',
    intent: { kind: 'objective', root: INTENT_ROOT },
    history: {
      selectionRoot: SELECTION_ROOT,
      verificationRoot: HISTORY_VERIFICATION_ROOT,
      status: 'complete',
      selectedCount: 4,
      confidence: 'high',
      gapIds: [],
    },
    xinfaRoot: XINFA_ROOT,
    asOf: AS_OF,
    policy: policy(),
    proposal: {
      authority: { ...authority },
      topology: 'dag',
      slices: [slice('foundation'), slice('integration', ['foundation'])],
      confidence: 'high',
      gapIds: [],
      humanOverride: { ...humanOverride },
    },
  };
  return {
    ...base,
    ...overrides,
    history: { ...base.history, ...overrides.history },
    proposal: { ...base.proposal, ...overrides.proposal },
  };
}

function expectedInput(value) {
  return {
    intent: value.intent,
    history: value.history,
    xinfaRoot: value.xinfaRoot,
    asOf: value.asOf,
    policy: value.policy,
  };
}

test('contract roots four schemas and keeps sample count out of advisory admission', () => {
  const result = checkWorkDesignAdvisorContract();
  assert.equal(result.schemaFiles, 4);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('builds deterministic rooted advice and an independent verification receipt', () => {
  const input = request();
  const first = buildWorkDesignAdvice(input);
  const second = buildWorkDesignAdvice(structuredClone(input));
  assert.equal(first.ok, true);
  assert.equal(first.advice.status, 'ready');
  assert.equal(first.advice.adviceRoot, second.advice.adviceRoot);
  assert.equal(first.advice.design.topology, 'dag');
  assert.deepEqual(
    first.advice.design.slices.map((entry) => entry.id),
    ['foundation', 'integration'],
  );
  assert.deepEqual(first.advice.authority, authority);
  assert.deepEqual(first.advice.humanOverride, humanOverride);

  const receipt = verifyWorkDesignAdvice(first.advice, expectedInput(input));
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.checks, {
    schemaValid: true,
    exactInputBinding: true,
    bounded: true,
    dependencyClosure: true,
    acceptanceCoverage: true,
    evidenceCoverage: true,
    authoritySafe: true,
  });
  assert.match(receipt.verificationRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    receipt.verificationRoot,
    verifyWorkDesignAdvice(first.advice, expectedInput(input)).verificationRoot,
  );
});

test('malformed and missing roots fail without emitting advice', () => {
  const malformed = request({ intent: { kind: 'objective', root: 'missing' } });
  const result = buildWorkDesignAdvice(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.advice, null);
  assert.ok(result.diagnostics.some((entry) => entry.path === '$.intent.root'));

  const extra = request();
  extra.proposal.unexpected = true;
  const extraResult = buildWorkDesignAdvice(extra);
  assert.equal(extraResult.ok, false);
  assert.ok(
    extraResult.diagnostics.some(
      (entry) => entry.code === 'object-shape-mismatch',
    ),
  );
});

test('dependency cycles and missing dependency closure fail deterministically', () => {
  const cycle = request({
    proposal: {
      slices: [
        slice('foundation', ['integration']),
        slice('integration', ['foundation']),
      ],
    },
  });
  const cycleResult = buildWorkDesignAdvice(cycle);
  assert.equal(cycleResult.ok, false);
  assert.ok(
    cycleResult.diagnostics.some((entry) => entry.code === 'dependency-cycle'),
  );

  const missing = request({
    proposal: {
      slices: [slice('foundation', ['absent'])],
      topology: 'single',
    },
  });
  const missingResult = buildWorkDesignAdvice(missing);
  assert.equal(missingResult.ok, false);
  assert.ok(
    missingResult.diagnostics.some(
      (entry) => entry.code === 'dependency-not-found',
    ),
  );
});

test('slice, topology, and total budgets are fail-closed', () => {
  const oversizedSlice = request({
    proposal: { slices: [slice('foundation', [], 7)], topology: 'single' },
  });
  assert.ok(
    buildWorkDesignAdvice(oversizedSlice).diagnostics.some(
      (entry) => entry.code === 'unbounded-slice',
    ),
  );

  const tooMany = request({
    policy: policy({ maxSlices: 1 }),
  });
  assert.ok(
    buildWorkDesignAdvice(tooMany).diagnostics.some(
      (entry) => entry.code === 'unbounded-topology',
    ),
  );

  const total = request({
    proposal: {
      slices: [slice('foundation', [], 6), slice('integration', [], 6)],
    },
    policy: policy({ maxTotalBudgetHours: 10 }),
  });
  assert.ok(
    buildWorkDesignAdvice(total).diagnostics.some(
      (entry) => entry.code === 'unbounded-total-budget',
    ),
  );
});

test('acceptance, evidence, and authority escalation are rejected', () => {
  const missingAcceptance = request();
  missingAcceptance.proposal.slices[0].acceptance = [];
  assert.ok(
    buildWorkDesignAdvice(missingAcceptance).diagnostics.some(
      (entry) => entry.code === 'acceptance-coverage-missing',
    ),
  );

  const unverifiableEvidence = request();
  unverifiableEvidence.proposal.slices[0].requiredEvidence =
    unverifiableEvidence.proposal.slices[0].requiredEvidence.filter(
      (entry) => entry.kind !== 'review',
    );
  assert.ok(
    buildWorkDesignAdvice(unverifiableEvidence).diagnostics.some(
      (entry) => entry.code === 'evidence-coverage-missing',
    ),
  );

  const escalation = request();
  escalation.proposal.authority.mayExecute = true;
  assert.ok(
    buildWorkDesignAdvice(escalation).diagnostics.some(
      (entry) => entry.code === 'authority-escalation',
    ),
  );
});

test('independent verifier detects exact binding and rerooted authority drift', () => {
  const input = request();
  const advice = buildWorkDesignAdvice(input).advice;
  const wrongInput = expectedInput(input);
  wrongInput.xinfaRoot = semanticRoot({ xinfa: 'wrong' });
  const bindingReceipt = verifyWorkDesignAdvice(advice, wrongInput);
  assert.equal(bindingReceipt.ok, false);
  assert.equal(bindingReceipt.checks.exactInputBinding, false);

  const escalation = structuredClone(advice);
  escalation.authority.mayClose = true;
  const { adviceRoot: _root, ...preimage } = escalation;
  escalation.adviceRoot = semanticRoot(preimage);
  const authorityReceipt = verifyWorkDesignAdvice(
    escalation,
    expectedInput(input),
  );
  assert.equal(authorityReceipt.ok, false);
  assert.equal(authorityReceipt.checks.authoritySafe, false);
});

test('insufficient history emits no slices without imposing a 30-sample gate', () => {
  const input = request({
    history: {
      status: 'incomplete',
      selectedCount: 0,
      confidence: 'unknown',
      gapIds: ['no-selected-candidates'],
    },
    proposal: { topology: 'none', slices: [] },
  });
  const result = buildWorkDesignAdvice(input);
  assert.equal(result.ok, true);
  assert.equal(result.advice.status, 'insufficient-history');
  assert.deepEqual(result.advice.design, { topology: 'none', slices: [] });
  assert.ok(result.advice.gapIds.includes('insufficient-history'));
  assert.equal(
    verifyWorkDesignAdvice(result.advice, expectedInput(input)).ok,
    true,
  );
});

test('one verified sample permits advisory mode without default-policy promotion', () => {
  const input = request({
    history: {
      status: 'complete',
      selectedCount: 1,
      confidence: 'low',
      gapIds: ['small-sample'],
    },
  });
  const result = buildWorkDesignAdvice(input);
  assert.equal(result.ok, true);
  assert.equal(result.advice.status, 'ready');
  assert.equal(result.advice.design.slices.length, 2);
  assert.ok(result.advice.gapIds.includes('small-sample'));
});

test('all dispositions preserve original advice and intent roots', () => {
  const adviceRoot = buildWorkDesignAdvice(request()).advice.adviceRoot;
  const rationaleRoot = semanticRoot({ rationale: 'human choice' });
  const changedRoot = semanticRoot({ advice: 'adapted' });
  const cases = [
    ['accepted', adviceRoot],
    ['adapted', changedRoot],
    ['overridden', changedRoot],
    ['insufficient-history', null],
  ];
  for (const [action, resultingAdviceRoot] of cases) {
    const result = buildWorkDesignDisposition({
      adviceRoot,
      intentRoot: INTENT_ROOT,
      action,
      rationaleRoot,
      resultingAdviceRoot,
    });
    assert.equal(result.ok, true);
    assert.equal(result.disposition.adviceRoot, adviceRoot);
    assert.equal(result.disposition.intentRoot, INTENT_ROOT);
    assert.equal(verifyWorkDesignDisposition(result.disposition).ok, true);
  }

  const erased = buildWorkDesignDisposition({
    adviceRoot,
    intentRoot: INTENT_ROOT,
    action: 'accepted',
    rationaleRoot,
    resultingAdviceRoot: changedRoot,
  });
  assert.equal(erased.ok, false);
  assert.ok(
    erased.diagnostics.some((entry) => entry.code === 'accepted-root-mismatch'),
  );
});

const ESTIMATE_COHORT_ROOT = semanticRoot({ cohort: 'exact-control-plane' });

function outcomeRecord(index) {
  const preimage = {
    schema: WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA,
    assignmentSubject: `kungfu:assignment-${String(index).padStart(2, '0')}`,
    workspaceIdentityRoot: semanticRoot({ workspace: index }),
    settledStateRoot: semanticRoot({ state: index }),
    bindingRoot: semanticRoot({ binding: index }),
    outcomeRoot: semanticRoot({ outcome: index }),
    coverageRoot: semanticRoot({ coverage: index }),
    cohortRoot: ESTIMATE_COHORT_ROOT,
    outcomeAsOf: '2026-07-29T09:00:00Z',
    coverageComplete: true,
    attributableActiveSeconds: index * 100,
    excludedWaitSeconds: {
      'ci-queue': 10,
      'external-review': 20,
      'human-decision': 30,
      'platform-approval': 40,
    },
    rework: { status: 'qualified', count: index % 3 === 0 ? 1 : 0 },
    sourceEvidenceRoots: [semanticRoot({ evidence: index })],
  };
  return { ...preimage, recordRoot: semanticRoot(preimage) };
}

function estimateFor(count) {
  const records = Array.from({ length: count }, (_, index) =>
    outcomeRecord(index + 1),
  );
  return buildOutcomeInformedEstimate({
    asOf: AS_OF,
    sourceRoot: semanticRoot({ source: 'global-outcome-history' }),
    queryProofRoot: semanticRoot({ proof: 'global-work' }),
    globalWorkProjectionRoot: semanticRoot({ projection: 'global-work' }),
    targetCohortRoot: ESTIMATE_COHORT_ROOT,
    selectedStateRoots: records.map((record) => record.settledStateRoot).sort(),
    records,
    coverage: {
      uniqueSettledStateCount: count + 2,
      uniqueAssignmentCount: count + 1,
      complete: count,
      partial: 1,
      sealedOnlyUnknown: 1,
      unqualifiedStateCount: 0,
    },
  });
}

test('outcome-informed estimates preserve exact 9, 10, 29, and 30 semantics', () => {
  const nine = estimateFor(9).estimate;
  const ten = estimateFor(10).estimate;
  const twentyNine = estimateFor(29).estimate;
  const thirty = estimateFor(30).estimate;

  assert.equal(nine.guidance.phase, 'observation-only');
  assert.equal(nine.guidance.recommendedBudgetSeconds, null);
  assert.equal(nine.guidance.existingConservativeBudgetPreserved, true);
  assert.equal(ten.guidance.phase, 'tentative-trend');
  assert.equal(ten.attributableActiveSeconds.p50, 500);
  assert.equal(ten.attributableActiveSeconds.p80, 800);
  assert.equal(ten.guidance.recommendedBudgetSeconds, 800);
  assert.equal(twentyNine.guidance.phase, 'tentative-trend');
  assert.equal(twentyNine.guidance.defaultPolicyInfluence, false);
  assert.equal(thirty.guidance.phase, 'replay-gated');
  assert.equal(thirty.guidance.requiresExistingReplayGates, true);
  assert.equal(thirty.guidance.defaultPolicyInfluence, false);
  assert.equal(thirty.excludedWaitTotals['ci-queue'], 300);
  assert.equal(verifyOutcomeInformedEstimate(thirty).ok, true);
});

test('zero qualified outcomes expose an exact fallback without inventing a budget', () => {
  const zero = estimateFor(0).estimate;
  assert.equal(zero.comparability.qualifiedSampleCount, 0);
  assert.deepEqual(zero.attributableActiveSeconds, {
    p50: null,
    p80: null,
    minimum: null,
    maximum: null,
  });
  assert.equal(zero.guidance.recommendedBudgetSeconds, null);
  assert.equal(zero.guidance.existingConservativeBudgetPreserved, true);
  assert.equal(
    zero.guidance.fallbackReason,
    'no-qualified-comparable-outcomes',
  );
  assert.equal(zero.confidence, 'unknown');
});

test('estimate roots fail closed and opening estimates preserve human authority', () => {
  const result = estimateFor(10);
  assert.equal(result.ok, true);
  const tampered = structuredClone(result.estimate);
  tampered.attributableActiveSeconds.p80 += 1;
  assert.equal(verifyOutcomeInformedEstimate(tampered).ok, false);

  const opening = buildOpeningEstimateBinding({
    assignmentId: 'assignment-opening-a',
    asOf: AS_OF,
    workDefinitionRoot: INTENT_ROOT,
    adviceRoot: semanticRoot({ advice: 'opening' }),
    estimate: result.estimate,
  });
  assert.equal(opening.ok, true);
  assert.equal(opening.binding.authority.finalWorkDefinitionAuthority, false);
  assert.equal(opening.binding.guidance.defaultPolicyInfluence, false);
  assert.match(opening.binding.openingEstimateRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('outcome estimate rejects as-of leakage, duplicate states, and root mismatch', () => {
  const base = estimateFor(2);
  assert.equal(base.ok, true);
  const first = outcomeRecord(1);
  const future = { ...outcomeRecord(2), outcomeAsOf: '2026-07-30T12:00:00Z' };
  future.recordRoot = semanticRoot(
    Object.fromEntries(
      Object.entries(future).filter(([key]) => key !== 'recordRoot'),
    ),
  );
  const invalid = buildOutcomeInformedEstimate({
    asOf: AS_OF,
    sourceRoot: semanticRoot({ source: 'invalid' }),
    queryProofRoot: semanticRoot({ proof: 'invalid' }),
    globalWorkProjectionRoot: semanticRoot({ projection: 'invalid' }),
    targetCohortRoot: ESTIMATE_COHORT_ROOT,
    selectedStateRoots: [first.settledStateRoot],
    records: [first, first, future],
    coverage: {
      uniqueSettledStateCount: 2,
      uniqueAssignmentCount: 2,
      complete: 2,
      partial: 0,
      sealedOnlyUnknown: 0,
      unqualifiedStateCount: 0,
    },
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.diagnostics.some(({ code }) => code === 'as-of-leakage'));
  assert.ok(
    invalid.diagnostics.some(({ code }) => code === 'duplicate-settled-state'),
  );

  const tamperedRecord = outcomeRecord(1);
  tamperedRecord.attributableActiveSeconds += 1;
  const mismatch = buildOutcomeInformedEstimate({
    asOf: AS_OF,
    sourceRoot: semanticRoot({ source: 'mismatch' }),
    queryProofRoot: semanticRoot({ proof: 'mismatch' }),
    globalWorkProjectionRoot: semanticRoot({ projection: 'mismatch' }),
    targetCohortRoot: ESTIMATE_COHORT_ROOT,
    selectedStateRoots: [tamperedRecord.settledStateRoot],
    records: [tamperedRecord],
    coverage: {
      uniqueSettledStateCount: 1,
      uniqueAssignmentCount: 1,
      complete: 1,
      partial: 0,
      sealedOnlyUnknown: 0,
      unqualifiedStateCount: 0,
    },
  });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.diagnostics.some(({ code }) => code === 'root-mismatch'));
});
