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
  OPEN_CARD_PREFLIGHT_SCHEMA,
  buildOpenCardHistorySelectionRequest,
  runOpenCardPreflight,
  verifyOpenCardPreflight,
} from '../framework/work-design-open-card/src/work-design-open-card.mjs';
import {
  buildWorkHistoryCandidate,
  buildWorkHistoryIndexSnapshot,
  buildWorkHistorySelectionPolicy,
  selectWorkHistory,
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

function globalWorkQuery() {
  const componentCutRoot = semanticRoot({ cut: 'component-work' });
  const componentProofRoot = semanticRoot({ proof: 'component-work' });
  const stateRoot = semanticRoot({ state: 'settled-work' });
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
        retained_assignment_states: [
          {
            schema: 'kungfu.assignment-orchestration.sealed-work-coordinate/v1',
            assignment_subject: 'kungfu:settled-precedent',
            workspace_identity_root: AUTHORITY_ROOT,
            state_root: stateRoot,
            query_proof_root: componentProofRoot,
            phase: 'continuation-decided',
            settled: true,
            storage_kind: 'git-common-dir',
          },
        ],
      },
    ],
    proof: {
      schema: 'kungfu.workspace-federation.query-proof/v1',
      proof_root: semanticRoot({ proof: 'global-work' }),
      global_work_projection_root: semanticRoot({ projection: 'global-work' }),
    },
    verification: { ok: true },
    writes: [],
  };
}

test('native global Work query compiles settled sealed coordinates into selector input', () => {
  const selectionRequest = buildOpenCardHistorySelectionRequest({
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
  const selectionRequest = buildOpenCardHistorySelectionRequest({
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

test('history compilation fails closed when the installed Work proof is invalid', () => {
  const query = globalWorkQuery();
  query.verification.ok = false;
  assert.throws(
    () =>
      buildOpenCardHistorySelectionRequest({
        query,
        objectiveRoot: semanticRoot(workDefinition()),
        xinfaRoot: XINFA_ROOT,
        asOf: AS_OF,
      }),
    /history query proof did not verify/u,
  );
});

test('Shifu dispatches open-card preflight without package lifecycle bootstrap', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-open-card-preflight-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json');
  const history = path.join(directory, 'history.json');
  fs.writeFileSync(input, `${JSON.stringify(request())}\n`);
  fs.writeFileSync(history, `${JSON.stringify(globalWorkQuery())}\n`);
  const result = spawnSync(
    path.resolve('shifu'),
    [
      'work-design:open-card-preflight',
      '--input',
      input,
      '--history-query',
      history,
    ],
    { cwd: path.resolve('.'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preflight = JSON.parse(result.stdout);
  assert.equal(preflight.schema, OPEN_CARD_PREFLIGHT_SCHEMA);
  assert.equal(preflight.history.source.complete, false);
  assert.ok(preflight.advice.advice.gapIds.includes('global-work-partial'));
  assert.equal(preflight.outcome, 'advisory-auto-adopted');
  assert.equal(preflight.adoption.mode, 'policy-auto-adopted');
  assert.equal(preflight.disposition.action, 'policy-accepted');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /pnpm|install/u);
});

test('verified bounded advice auto-adopts without a human disposition', () => {
  const input = request();
  const result = runOpenCardPreflight(input);
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

test('insufficient history requires a human decision when no disposition exists', () => {
  const result = runOpenCardPreflight(
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
  const result = runOpenCardPreflight(
    request(undefined, { confidence: 'low' }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'human-decision-required');
  assert.deepEqual(result.escalation.reasons, ['confidence-below-policy']);
});

test('an unapproved advice gap requires a human decision', () => {
  const result = runOpenCardPreflight(
    request(undefined, { gapIds: ['requires-human-judgment'] }),
  );
  assertCaptureBoundary(result);
  assert.equal(result.outcome, 'human-decision-required');
  assert.deepEqual(result.escalation.reasons, [
    'unresolved-gap:requires-human-judgment',
  ]);
});

test('policy disposition tampering fails preflight verification', () => {
  const result = runOpenCardPreflight(request());
  result.disposition.evaluation.selectedCount += 1;
  assert.deepEqual(verifyOpenCardPreflight(result), {
    ok: false,
    reason: 'preflight-root-mismatch',
  });
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
