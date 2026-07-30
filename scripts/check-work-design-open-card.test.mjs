// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRoot } from '../framework/project-cut/src/project-cut.mjs';
import {
  buildWorkDesignPolicy,
  workDesignAdvisoryBoundary,
} from '../framework/work-design-advisor/src/work-design-advisor.mjs';
import {
  runOpenCardPreflight,
  verifyOpenCardPreflight,
} from '../framework/work-design-open-card/src/work-design-open-card.mjs';
import {
  buildWorkHistoryCandidate,
  buildWorkHistoryIndexSnapshot,
  buildWorkHistorySelectionPolicy,
} from '../framework/work-history-selector/src/work-history-selector.mjs';

const AS_OF = '2026-07-30T08:00:00Z';
const AUTHORITY_ROOT = semanticRoot({ authority: 'native-work-control' });
const SOURCE_ROOT = semanticRoot({ source: 'qualified-work-history' });
const SOURCE_CUT_ROOT = semanticRoot({ cut: 'open-card-history-index' });
const XINFA_ROOT = semanticRoot({ xinfa: 'open-card-current' });
const RECORD_SCHEMA = 'kungfu.assignment-orchestration.status/v1';
const RATIONALE_ROOT = semanticRoot({ rationale: 'explicit-human-choice' });
const { authority, humanOverride } = workDesignAdvisoryBoundary();

function workDefinition(seed = 'future-work') {
  return {
    goal_id: seed,
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
    id: 'open-card-history-v1',
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
    id: 'open-card-advisory-v1',
    version: 1,
    maxSlices: 3,
    maxTotalBudgetHours: 12,
    maxSliceBudgetHours: 6,
    allowedDeliveryClasses: ['native-proof-required'],
    requiredEvidenceKinds: ['review', 'test'],
  });
}

function proposal(insufficient = false) {
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
            id: 'open-card-contract',
            criterionRoot: semanticRoot({ acceptance: 'open-card-contract' }),
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
    confidence: 'high',
    gapIds: [],
    humanOverride,
  };
}

function request(action, overrides = {}) {
  const humanWorkDefinition = workDefinition(overrides.seed);
  const humanWorkDefinitionRoot = semanticRoot(humanWorkDefinition);
  const insufficient = overrides.insufficient === true;
  return {
    schema: 'kungfu.work-design.open-card-preflight-request/v1',
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
      proposal: proposal(insufficient),
    },
    disposition: {
      action,
      decisionAuthority: 'human',
      rationaleRoot: RATIONALE_ROOT,
      ...(overrides.expectedAdviceRoot
        ? { expectedAdviceRoot: overrides.expectedAdviceRoot }
        : {}),
    },
    availability: {
      selector: 'available',
      advisor: overrides.advisor ?? 'available',
    },
  };
}

function assertCaptureBoundary(result) {
  assert.equal(verifyOpenCardPreflight(result).ok, true);
  assert.deepEqual(result.cardState, {
    captureOnly: true,
    pointerOnly: true,
    status: 'paused',
    claimed: false,
    dispatched: false,
  });
  assert.equal(result.authority.capture, false);
  assert.equal(result.authority.claim, false);
  assert.equal(result.authority.execute, false);
  assert.equal(result.authority.merge, false);
  assert.equal(result.authority.close, false);
  assert.equal(result.humanAuthorization.authority, 'human');
  assert.equal(result.humanAuthorization.preserved, true);
}

for (const action of ['accepted', 'adapted', 'overridden']) {
  test(`${action} preserves the human disposition and exact advice root`, () => {
    const input = request(action);
    const result = runOpenCardPreflight(input);
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
  const result = runOpenCardPreflight(input);
  assertCaptureBoundary(result);
  assert.equal(result.disposition.action, 'insufficient-history');
  assert.equal(result.disposition.adviceRoot, result.advice.advice.adviceRoot);
  assert.equal(result.advice.advice.status, 'insufficient-history');
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.fallback.reason, 'insufficient-history');
});

test('stale-manifest explicitly falls back without invoking unsafe advice', () => {
  const stale = buildWorkHistoryIndexSnapshot({
    capturedAt: '2026-07-29T01:00:00Z',
    sourceCutRoot: SOURCE_CUT_ROOT,
  });
  const result = runOpenCardPreflight(
    request('accepted', { indexSnapshot: stale }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'manual-capture');
  assert.equal(result.fallback.reason, 'stale-manifest');
  assert.equal(result.advice, null);
  assert.equal(result.adoption.adopted, false);
});

test('root-mismatch explicitly rejects adoption and preserves manual capture', () => {
  const result = runOpenCardPreflight(
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
  const result = runOpenCardPreflight(
    request('accepted', { advisor: 'unavailable' }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.fallback.reason, 'advisor-unavailable');
  assert.equal(result.advice, null);
  assert.equal(result.adoption.adopted, false);
  assert.equal(result.fallback.silentAdoption, false);
});
