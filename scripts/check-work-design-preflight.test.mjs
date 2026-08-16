// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { semanticRoot } from '../framework/project-cut/src/project-cut.mjs';
import {
  buildWorkDesignPolicy,
  workDesignAdvisoryBoundary,
} from '../framework/work-design-advisor/src/work-design-advisor.mjs';
import {
  WORK_DESIGN_PREFLIGHT_SCHEMA,
  buildAssignmentHistorySelectionRequest,
  buildAssignmentOutcomeHistory,
  runAssignmentPreflight,
  verifyAssignmentPreflight,
} from '../framework/work-design-preflight/src/work-design-preflight.mjs';
import {
  buildWorkHistoryCandidate,
  buildWorkHistoryIndexSnapshot,
  buildWorkHistorySelectionPolicy,
  selectWorkHistory,
} from '../framework/work-history-selector/src/work-history-selector.mjs';

const AS_OF = '2026-07-30T08:00:00Z';
const AUTHORITY_ROOT = semanticRoot({ authority: 'native-work-control' });
const SOURCE_ROOT = semanticRoot({ source: 'qualified-work-history' });
const SOURCE_CUT_ROOT = semanticRoot({ cut: 'work-design-history-index' });
const XINFA_ROOT = semanticRoot({ xinfa: 'work-design-current' });
const RECORD_SCHEMA = 'kungfu.assignment-orchestration.status/v1';
const RATIONALE_ROOT = semanticRoot({ rationale: 'explicit-human-choice' });
const { authority, humanOverride } = workDesignAdvisoryBoundary();

function workDefinition(seed = 'future-work') {
  return {
    assignment_id: seed,
    objective: 'Human-authorized final work definition',
    scope: { included: ['bounded-change'], excluded: ['automatic-execution'] },
    acceptance_criteria: ['capture remains paused and unclaimed'],
    safety_boundaries: ['advice remains non-authoritative'],
  };
}

function candidate() {
  return buildWorkHistoryCandidate({
    recordSchema: RECORD_SCHEMA,
    authority: { root: AUTHORITY_ROOT, status: 'current' },
    source: {
      id: 'native-work-history',
      root: SOURCE_ROOT,
      status: 'current',
      visibility: 'internal',
    },
    temporal: {
      availableAt: '2026-07-30T06:30:00Z',
      indexedAt: '2026-07-30T07:00:00Z',
      completedAt: '2026-07-30T06:00:00Z',
    },
    supersession: {
      status: 'active',
      at: null,
      replacementRoot: null,
    },
    invalidation: { status: 'valid', at: null, evidenceRoot: null },
    applicability: 'comparable',
    evidenceRoots: [semanticRoot({ evidence: 'qualified-delivery' })],
    ranking: { score: 80 },
  });
}

function selectionPolicy() {
  return buildWorkHistorySelectionPolicy({
    id: 'work-design-history-v1',
    version: 1,
    maxSelected: 8,
    recentWindowSeconds: 86400,
    maximumIndexAgeSeconds: 7200,
    allowedAuthorityRoots: [AUTHORITY_ROOT],
    allowedRecordSchemas: [RECORD_SCHEMA],
    allowedSourceIds: ['native-work-history'],
    allowedVisibilities: ['internal'],
  });
}

function designPolicy() {
  return buildWorkDesignPolicy({
    id: 'work-design-advisory-v1',
    version: 1,
    maxSlices: 3,
    maxTotalBudgetHours: 12,
    maxSliceBudgetHours: 6,
    allowedDeliveryClasses: ['native-proof-required'],
    requiredEvidenceKinds: ['review', 'test'],
  });
}

function proposal(insufficient = false, overrides = {}) {
  if (insufficient)
    return {
      authority,
      topology: 'none',
      slices: [],
      confidence: 'unknown',
      gapIds: [],
      humanOverride,
    };
  return {
    authority,
    topology: 'single',
    slices: [
      {
        id: 'implementation',
        objectiveRoot: semanticRoot({ slice: 'implementation' }),
        dependsOn: [],
        budgetHours: 4,
        deliveryClass: 'native-proof-required',
        acceptance: [
          {
            id: 'work-design-contract',
            criterionRoot: semanticRoot({ acceptance: 'work-design-contract' }),
          },
        ],
        requiredEvidence: [
          {
            id: 'review',
            kind: 'review',
            requirementRoot: semanticRoot({ evidence: 'review' }),
          },
          {
            id: 'test',
            kind: 'test',
            requirementRoot: semanticRoot({ evidence: 'test' }),
          },
        ],
        continuation: {
          mode: 'reassess',
          conditionRoots: [semanticRoot({ continuation: 'implementation' })],
        },
      },
    ],
    confidence: overrides.confidence ?? 'high',
    gapIds: overrides.gapIds ?? [],
    humanOverride,
  };
}

function request(action, overrides = {}) {
  const humanWorkDefinition = workDefinition(overrides.seed);
  const humanWorkDefinitionRoot = semanticRoot(humanWorkDefinition);
  const insufficient = overrides.insufficient === true;
  return {
    schema: 'kungfu.work-design.preflight-request/v1',
    humanWorkDefinition,
    humanWorkDefinitionRoot,
    selectionRequest: {
      schema: 'kungfu.work-history.selection-request/v1',
      objectiveRoot: humanWorkDefinitionRoot,
      xinfaRoot: XINFA_ROOT,
      asOf: AS_OF,
      indexSnapshot:
        overrides.indexSnapshot ??
        buildWorkHistoryIndexSnapshot({
          capturedAt: '2026-07-30T07:30:00Z',
          sourceCutRoot: SOURCE_CUT_ROOT,
        }),
      policy: selectionPolicy(),
      candidates: insufficient ? [] : [candidate()],
    },
    adviceRequest: {
      xinfaRoot: XINFA_ROOT,
      asOf: AS_OF,
      policy: designPolicy(),
      proposal: proposal(insufficient, overrides),
    },
    availability: {
      selector: 'available',
      advisor: overrides.advisor ?? 'available',
    },
    ...(action === undefined
      ? {}
      : {
          disposition: {
            action,
            decisionAuthority: 'human',
            rationaleRoot: RATIONALE_ROOT,
            ...(overrides.expectedAdviceRoot
              ? { expectedAdviceRoot: overrides.expectedAdviceRoot }
              : {}),
          },
        }),
  };
}

function assertCaptureBoundary(result) {
  assert.equal(verifyAssignmentPreflight(result).ok, true);
  assert.deepEqual(result.operation, {
    phase: 'pre-capture',
    mutates: false,
  });
  assert.equal(result.authority.capture, false);
  assert.equal(result.authority.claim, false);
  assert.equal(result.authority.execute, false);
  assert.equal(result.authority.merge, false);
  assert.equal(result.authority.close, false);
  assert.equal(result.humanAuthorization.authority, 'human');
  assert.equal(result.humanAuthorization.preserved, true);
}

function globalOutcomeBinding(state, index) {
  const cohortBody = {
    deliveryClass: 'native-proof-required',
    workClass: 'control-plane',
    repositoryClass: 'kungfu',
  };
  const coverageBody = {
    qualifiedMetrics: [
      'acceptanceFailure',
      'dependencyCorrection',
      'rework',
      'timeout',
    ],
    unknownMetrics: [],
    complete: true,
  };
  const outcomeBody = {
    schema: 'kungfu.work-design.outcome/v1',
    assignmentId: state.assignment_subject.replace(/^kungfu:/u, ''),
    asOf: '2026-07-30T07:30:00Z',
    bindings: {
      workDefinitionRoot: semanticRoot({ workDefinition: index }),
      adviceRoot: semanticRoot({ advice: index }),
      policyRoot: semanticRoot({ policy: index }),
    },
    cohort: { ...cohortBody, cohortRoot: semanticRoot(cohortBody) },
    window: {
      admittedAt: '2026-07-30T05:00:00Z',
      settledAt: '2026-07-30T07:00:00Z',
      attributableActiveSeconds: index * 100,
      excludedWaitSeconds: {
        'ci-queue': 10,
        'external-review': 20,
        'human-decision': 30,
        'platform-approval': 40,
      },
    },
    metrics: {
      acceptanceFailure: { status: 'qualified', count: 0 },
      dependencyCorrection: { status: 'qualified', count: 0 },
      rework: { status: 'qualified', count: index % 2 },
      timeout: { status: 'qualified', exceeded: false },
    },
    coverage: {
      ...coverageBody,
      coverageRoot: semanticRoot(coverageBody),
    },
    evidence: {
      settledStateRoot: state.state_root,
      queryProofRoot: state.query_proof_root,
      sourceEvidenceRoots: [semanticRoot({ outcomeEvidence: index })],
    },
    authority: {
      mode: 'settled-work-observation',
      factAuthority: false,
      episodeAuthority: false,
      assignmentAuthority: false,
      workControlAuthority: false,
      policyAuthority: false,
      mayMutate: false,
    },
  };
  const outcome = { ...outcomeBody, outcomeRoot: semanticRoot(outcomeBody) };
  const bindingBody = {
    schema: 'kungfu.assignment-orchestration.work-design-outcome-binding/v1',
    assignment_subject: state.assignment_subject,
    workspace_identity_root: state.workspace_identity_root,
    settled_state_root: state.state_root,
    state_query_proof_root: state.query_proof_root,
    opening_estimate_root: null,
    published_at: '2026-07-30T07:40:00Z',
    outcome,
  };
  return { ...bindingBody, binding_root: semanticRoot(bindingBody) };
}

function globalWorkQuery({ outcomeCount = 0, partialCount = 0 } = {}) {
  const componentCutRoot = semanticRoot({ cut: 'component-work' });
  const componentProofRoot = semanticRoot({ proof: 'component-work' });
  const stateCount = Math.max(1, outcomeCount + partialCount);
  const states = Array.from({ length: stateCount }, (_, index) => ({
    schema: 'kungfu.assignment-orchestration.sealed-work-coordinate/v1',
    assignment_subject: `kungfu:settled-precedent-${index + 1}`,
    workspace_identity_root: AUTHORITY_ROOT,
    state_root: semanticRoot({ state: `settled-work-${index + 1}` }),
    query_proof_root: componentProofRoot,
    phase: 'continuation-decided',
    settled: true,
    storage_kind: 'git-common-dir',
  }));
  const bindings = states
    .slice(0, outcomeCount + partialCount)
    .map((state, index) => {
      const binding = globalOutcomeBinding(state, index + 1);
      if (index < outcomeCount) return binding;
      const outcome = structuredClone(binding.outcome);
      const coverageBody = {
        qualifiedMetrics: ['rework'],
        unknownMetrics: [
          'acceptanceFailure',
          'dependencyCorrection',
          'timeout',
        ],
        complete: false,
      };
      outcome.coverage = {
        ...coverageBody,
        coverageRoot: semanticRoot(coverageBody),
      };
      const { outcomeRoot: _outcomeRoot, ...outcomePreimage } = outcome;
      outcome.outcomeRoot = semanticRoot(outcomePreimage);
      const { binding_root: _bindingRoot, ...bindingPreimage } = binding;
      bindingPreimage.outcome = outcome;
      return {
        ...bindingPreimage,
        binding_root: semanticRoot(bindingPreimage),
      };
    });
  const outcomeHistoryBody = {
    schema: 'kungfu.workspace-federation.work-design-outcome-history/v1',
    bindings,
    issues: [],
    coverage: {
      unique_settled_state_count: states.length,
      unique_assignment_count: states.length,
      complete: outcomeCount,
      partial: partialCount,
      sealed_only_unknown: states.length - bindings.length,
      unqualified_state_count: 0,
    },
    writes: 0,
  };
  const outcomeHistory = {
    ...outcomeHistoryBody,
    history_root: semanticRoot(outcomeHistoryBody),
  };
  return {
    schema: 'kungfu.workspace-federation.query/v1',
    scope: 'all',
    authority: 'component-workspace-authorities',
    aggregate: {
      proof_ok: true,
      complete: false,
      state: 'partial',
      component_count: 2,
      unavailable_component_count: 1,
      unresolved_reference_count: 0,
      writes: 0,
    },
    components: [
      {
        availability: 'available',
        compatibility: { state: 'compatible' },
        stale: false,
        observed_at: '2026-07-30T07:59:30Z',
        cut_root: componentCutRoot,
        query_proof_root: componentProofRoot,
        retained_assignment_states: states,
      },
    ],
    global_work: { outcome_history: outcomeHistory },
    proof: {
      schema: 'kungfu.workspace-federation.query-proof/v1',
      proof_root: semanticRoot({ proof: 'global-work' }),
      global_work_projection_root: semanticRoot({ projection: 'global-work' }),
    },
    verification: { ok: true },
    writes: [],
  };
}

function outcomeInformedRequest({ outcomeCount, partialCount = 0 }) {
  const query = globalWorkQuery({ outcomeCount, partialCount });
  const targetCohortRoot =
    query.global_work.outcome_history.bindings[0].outcome.cohort.cohortRoot;
  const outcomeHistory = buildAssignmentOutcomeHistory({
    query,
    asOf: AS_OF,
    targetCohortRoot,
  });
  const input = request();
  input.outcomeHistory = outcomeHistory;
  input.selectionRequest = buildAssignmentHistorySelectionRequest({
    query,
    objectiveRoot: input.humanWorkDefinitionRoot,
    xinfaRoot: XINFA_ROOT,
    asOf: AS_OF,
    outcomeHistory,
  });
  return { input, query, outcomeHistory };
}

test('native global Work query compiles settled sealed coordinates into selector input', () => {
  const selectionRequest = buildAssignmentHistorySelectionRequest({
    query: globalWorkQuery(),
    objectiveRoot: semanticRoot(workDefinition()),
    xinfaRoot: XINFA_ROOT,
    asOf: AS_OF,
  });
  assert.equal(selectionRequest.candidates.length, 1);
  assert.equal(
    selectionRequest.candidates[0].recordSchema,
    'kungfu.assignment-orchestration.sealed-work-coordinate/v1',
  );
  assert.equal(
    selectionRequest.candidates[0].source.id,
    'kungfu.workspace-federation.sealed-work-index',
  );
  const selected = selectWorkHistory(selectionRequest);
  assert.equal(selected.ok, true);
  assert.equal(selected.manifest.status, 'complete');
  assert.equal(selected.manifest.coverage.includedCount, 1);
});

test('history compilation deduplicates replica observations by sealed state root', () => {
  const query = globalWorkQuery();
  query.components.push({
    ...structuredClone(query.components[0]),
    observed_at: '2026-07-30T07:59:40Z',
  });
  const selectionRequest = buildAssignmentHistorySelectionRequest({
    query,
    objectiveRoot: semanticRoot(workDefinition()),
    xinfaRoot: XINFA_ROOT,
    asOf: AS_OF,
  });
  assert.equal(selectionRequest.candidates.length, 1);
  assert.equal(
    selectionRequest.candidates[0].temporal.indexedAt,
    '2026-07-30T07:59:40.000Z',
  );
});

test('work-design invokes rooted outcome estimation before preserving human authority', () => {
  const { input, outcomeHistory } = outcomeInformedRequest({
    outcomeCount: 10,
    partialCount: 1,
  });
  const result = runAssignmentPreflight(input);
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'advisory-auto-adopted');
  assert.equal(
    result.history.outcomeHistory.sourceRoot,
    outcomeHistory.sourceRoot,
  );
  const estimate = result.advice.estimation.estimate;
  assert.equal(estimate.comparability.qualifiedSampleCount, 10);
  assert.deepEqual(estimate.attributableActiveSeconds, {
    p50: 500,
    p80: 800,
    minimum: 100,
    maximum: 1000,
  });
  assert.deepEqual(estimate.excludedWaitTotals, {
    'ci-queue': 100,
    'external-review': 200,
    'human-decision': 300,
    'platform-approval': 400,
  });
  assert.equal(estimate.guidance.phase, 'tentative-trend');
  assert.equal(estimate.guidance.recommendedBudgetSeconds, 800);
  assert.equal(estimate.guidance.defaultPolicyInfluence, false);
  assert.equal(
    result.humanAuthorization.finalWorkDefinitionRoot,
    input.humanWorkDefinitionRoot,
  );
});

for (const [count, phase, budget] of [
  [9, 'observation-only', null],
  [10, 'tentative-trend', 800],
  [29, 'tentative-trend', 2400],
  [30, 'replay-gated', 2400],
]) {
  test(`${count} rooted outcomes retain the exact advisory promotion boundary`, () => {
    const { input } = outcomeInformedRequest({ outcomeCount: count });
    const result = runAssignmentPreflight(input);
    assertCaptureBoundary(result);
    const estimate = result.advice.estimation.estimate;
    assert.equal(estimate.comparability.qualifiedSampleCount, count);
    assert.equal(estimate.guidance.phase, phase);
    assert.equal(estimate.guidance.recommendedBudgetSeconds, budget);
    assert.equal(estimate.guidance.defaultPolicyInfluence, false);
    assert.equal(estimate.guidance.requiresExistingReplayGates, count >= 30);
  });
}

test('partial and legacy sealed outcomes remain explicit coverage unknowns', () => {
  const { outcomeHistory } = outcomeInformedRequest({
    outcomeCount: 1,
    partialCount: 1,
  });
  assert.deepEqual(outcomeHistory.coverage, {
    uniqueSettledStateCount: 2,
    uniqueAssignmentCount: 2,
    complete: 1,
    partial: 1,
    sealedOnlyUnknown: 0,
    unqualifiedStateCount: 0,
  });
  assert.equal(outcomeHistory.records.length, 2);
  assert.equal(
    outcomeHistory.records.filter((record) => record.coverageComplete).length,
    1,
  );
});

test('outcome root mismatch explicitly falls back to manual capture', () => {
  const query = globalWorkQuery({ outcomeCount: 1 });
  query.global_work.outcome_history.bindings[0].outcome.outcomeRoot =
    semanticRoot({ mismatched: true });
  const { history_root: _historyRoot, ...historyPreimage } =
    query.global_work.outcome_history;
  query.global_work.outcome_history.history_root =
    semanticRoot(historyPreimage);
  const targetCohortRoot =
    query.global_work.outcome_history.bindings[0].outcome.cohort.cohortRoot;
  const outcomeHistory = buildAssignmentOutcomeHistory({
    query,
    asOf: AS_OF,
    targetCohortRoot,
  });
  assert.equal(outcomeHistory.records.length, 0);
  assert.equal(outcomeHistory.issues[0].code, 'outcome-record-unqualified');
  const input = request('accepted');
  input.outcomeHistory = outcomeHistory;
  input.selectionRequest = buildAssignmentHistorySelectionRequest({
    query,
    objectiveRoot: input.humanWorkDefinitionRoot,
    xinfaRoot: XINFA_ROOT,
    asOf: AS_OF,
    outcomeHistory,
  });
  const result = runAssignmentPreflight(input);
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'manual-capture');
  assert.equal(result.fallback.reason, 'outcome-history-unqualified');
  assert.equal(result.advice, null);
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.fallback.silentAdoption, false);
});

test('history compilation fails closed when the installed Work proof is invalid', () => {
  const query = globalWorkQuery();
  query.verification.ok = false;
  assert.throws(
    () =>
      buildAssignmentHistorySelectionRequest({
        query,
        objectiveRoot: semanticRoot(workDefinition()),
        xinfaRoot: XINFA_ROOT,
        asOf: AS_OF,
      }),
    /history query proof did not verify/u,
  );
});

test('Shifu dispatches work-design preflight without package lifecycle bootstrap', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-work-design-preflight-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json');
  const history = path.join(directory, 'history.json');
  fs.writeFileSync(input, `${JSON.stringify(request())}\n`);
  fs.writeFileSync(history, `${JSON.stringify(globalWorkQuery())}\n`);
  const result = spawnSync(
    path.resolve('shifu'),
    ['work-design:preflight', '--input', input, '--history-query', history],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.schema, WORK_DESIGN_PREFLIGHT_SCHEMA);
  assert.equal(preflight.history.source.complete, false);
  assert.ok(preflight.advice.advice.gapIds.includes('global-work-partial'));
  assert.equal(preflight.outcome, 'advisory-auto-adopted');
  assert.equal(preflight.adoption.mode, 'policy-auto-adopted');
  assert.equal(preflight.disposition.action, 'policy-accepted');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /pnpm|install/u);
});

test('verified bounded advice auto-adopts without a human disposition', () => {
  const input = request();
  const result = runAssignmentPreflight(input);
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'advisory-auto-adopted');
  assert.equal(result.disposition.action, 'policy-accepted');
  assert.equal(result.disposition.evaluation.eligible, true);
  assert.deepEqual(result.disposition.evaluation.escalationReasons, []);
  assert.equal(result.adoption.adopted, true);
  assert.equal(result.adoption.mode, 'policy-auto-adopted');
  assert.equal(
    result.humanAuthorization.finalWorkDefinitionRoot,
    input.humanWorkDefinitionRoot,
  );
});

for (const action of ['accepted', 'adapted', 'overridden']) {
  test(`${action} preserves the human disposition and exact advice root`, () => {
    const input = request(action);
    const result = runAssignmentPreflight(input);
    assertCaptureBoundary(result);
    assert.equal(result.disposition.action, action);
    assert.equal(
      result.disposition.adviceRoot,
      result.advice.advice.adviceRoot,
    );
    assert.equal(
      result.humanAuthorization.finalWorkDefinitionRoot,
      input.humanWorkDefinitionRoot,
    );
    assert.equal(result.adoption.adopted, action !== 'overridden');
    if (action === 'overridden') {
      assert.equal(result.outcome, 'manual-capture');
      assert.equal(result.fallback.reason, 'overridden');
    }
  });
}

test('insufficient-history records the human disposition and permits manual capture', () => {
  const input = request('insufficient-history', { insufficient: true });
  const result = runAssignmentPreflight(input);
  assertCaptureBoundary(result);
  assert.equal(result.disposition.action, 'insufficient-history');
  assert.equal(result.disposition.adviceRoot, result.advice.advice.adviceRoot);
  assert.equal(result.advice.advice.status, 'insufficient-history');
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.fallback.reason, 'insufficient-history');
});

test('insufficient history requires a human decision when no disposition exists', () => {
  const result = runAssignmentPreflight(
    request(undefined, { insufficient: true }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'human-decision-required');
  assert.equal(result.disposition, null);
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.escalation.required, true);
  assert.ok(result.escalation.reasons.includes('advice-not-ready'));
  assert.ok(result.escalation.reasons.includes('history-not-complete'));
  assert.ok(result.escalation.reasons.includes('no-selected-history'));
  assert.ok(result.escalation.reasons.includes('confidence-below-policy'));
});

test('low-confidence advice requires a human decision', () => {
  const result = runAssignmentPreflight(
    request(undefined, { confidence: 'low' }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'human-decision-required');
  assert.deepEqual(result.escalation.reasons, ['confidence-below-policy']);
});

test('an unapproved advice gap requires a human decision', () => {
  const result = runAssignmentPreflight(
    request(undefined, { gapIds: ['requires-human-judgment'] }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'human-decision-required');
  assert.deepEqual(result.escalation.reasons, [
    'unresolved-gap:requires-human-judgment',
  ]);
});

test('policy disposition tampering fails preflight verification', () => {
  const result = runAssignmentPreflight(request());
  result.disposition.evaluation.selectedCount += 1;
  assert.deepEqual(verifyAssignmentPreflight(result), {
    ok: false,
    reason: 'preflight-root-mismatch',
  });
});

test('stale-manifest explicitly falls back without invoking unsafe advice', () => {
  const stale = buildWorkHistoryIndexSnapshot({
    capturedAt: '2026-07-29T01:00:00Z',
    sourceCutRoot: SOURCE_CUT_ROOT,
  });
  const result = runAssignmentPreflight(
    request('accepted', { indexSnapshot: stale }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'manual-capture');
  assert.equal(result.fallback.reason, 'stale-manifest');
  assert.equal(result.advice, null);
  assert.equal(result.adoption.adopted, false);
});

test('root-mismatch explicitly rejects adoption and preserves manual capture', () => {
  const result = runAssignmentPreflight(
    request('accepted', {
      expectedAdviceRoot: semanticRoot({ advice: 'different' }),
    }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.fallback.reason, 'advice-root-mismatch');
  assert.equal(result.adoption.adopted, false);
  assert.match(result.advice.advice.adviceRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('advisor-unavailable explicitly falls back without silent adoption', () => {
  const result = runAssignmentPreflight(
    request('accepted', { advisor: 'unavailable' }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.fallback.reason, 'advisor-unavailable');
  assert.equal(result.advice, null);
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.fallback.silentAdoption, false);
});
