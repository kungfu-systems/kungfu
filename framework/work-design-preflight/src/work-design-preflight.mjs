// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { semanticRoot } from '../../project-cut/src/project-cut.mjs';
import {
  WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA,
  buildOutcomeInformedEstimate,
  buildWorkDesignAdvice,
  buildWorkDesignDisposition,
  verifyOutcomeInformedEstimate,
  verifyWorkDesignAdvice,
  verifyWorkDesignDisposition,
} from '../../work-design-advisor/src/work-design-advisor.mjs';
import {
  buildWorkHistoryCandidate,
  buildWorkHistoryIndexSnapshot,
  buildWorkHistorySelectionPolicy,
  selectWorkHistory,
  verifyWorkHistorySelectionManifest,
} from '../../work-history-selector/src/work-history-selector.mjs';

export const WORK_DESIGN_PREFLIGHT_REQUEST_SCHEMA =
  'kungfu.work-design.preflight-request/v1';
export const WORK_DESIGN_PREFLIGHT_SCHEMA = 'kungfu.work-design.preflight/v1';

const ACTIONS = new Set([
  'accepted',
  'adapted',
  'overridden',
  'insufficient-history',
]);
const AVAILABILITY = new Set(['available', 'timeout', 'unavailable']);
const ROOT = /^sha256:[0-9a-f]{64}$/u;
const FEDERATED_QUERY_SCHEMA = 'kungfu.workspace-federation.query/v1';
const FEDERATED_PROOF_SCHEMA = 'kungfu.workspace-federation.query-proof/v1';
const SEALED_WORK_SCHEMA =
  'kungfu.assignment-orchestration.sealed-work-coordinate/v1';
const FEDERATED_SOURCE_ID = 'kungfu.workspace-federation.sealed-work-index';
const HISTORY_SOURCE_SCHEMA = 'kungfu.work-design.history-source/v1';
const OUTCOME_HISTORY_SCHEMA = 'kungfu.work-design.outcome-history/v1';
const OUTCOME_BINDING_SCHEMA =
  'kungfu.assignment-orchestration.work-design-outcome-binding/v1';
const OUTCOME_SCHEMA = 'kungfu.work-design.outcome/v1';
const POLICY_DISPOSITION_SCHEMA = 'kungfu.work-design.policy-disposition/v1';

const AUTO_ADOPTION_POLICY_PREIMAGE = Object.freeze({
  schema: 'kungfu.work-design.auto-adoption-policy/v1',
  id: 'verified-history-within-authorized-boundary',
  version: 1,
  minimumConfidence: 'medium',
  allowedGapIds: ['global-work-partial'],
  requiresAdviceStatus: 'ready',
  requiresHistoryStatus: 'complete',
  requiresSelectedHistory: true,
  requiresVerifiedAdvice: true,
  preservesWorkDefinition: true,
  escalationOutcome: 'human-decision-required',
});
const AUTO_ADOPTION_POLICY = Object.freeze({
  ...AUTO_ADOPTION_POLICY_PREIMAGE,
  policyRoot: semanticRoot(AUTO_ADOPTION_POLICY_PREIMAGE),
});
const CONFIDENCE_ORDER = new Map([
  ['unknown', 0],
  ['low', 1],
  ['medium', 2],
  ['high', 3],
]);

const AUTHORITY = Object.freeze({
  mode: 'capture-preflight-only',
  fact: false,
  episode: false,
  assignment: false,
  workControl: false,
  capture: false,
  claim: false,
  dispatch: false,
  execute: false,
  approve: false,
  merge: false,
  close: false,
});

const OPERATION = Object.freeze({
  phase: 'pre-capture',
  mutates: false,
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function canonicalTimestamp(value, at) {
  const timestamp = new Date(String(value ?? ''));
  if (!Number.isFinite(timestamp.getTime()))
    throw new Error(`${at} must be an ISO-8601 timestamp`);
  return timestamp.toISOString();
}

function requireRoot(value, at) {
  if (!ROOT.test(String(value ?? '')))
    throw new Error(`${at} must be a sha256 root`);
  return value;
}

function sortedRoots(values) {
  return [...new Set(values)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

function rooted(value, rootKey) {
  if (!isObject(value) || !ROOT.test(String(value[rootKey] ?? '')))
    return false;
  const { [rootKey]: _root, ...preimage } = value;
  return semanticRoot(preimage) === value[rootKey];
}

function outcomeRecord(binding, asOf) {
  if (
    !isObject(binding) ||
    binding.schema !== OUTCOME_BINDING_SCHEMA ||
    !rooted(binding, 'binding_root')
  )
    throw new Error('outcome binding root mismatch');
  const outcome = binding.outcome;
  if (
    !isObject(outcome) ||
    outcome.schema !== OUTCOME_SCHEMA ||
    !rooted(outcome, 'outcomeRoot') ||
    !rooted(outcome.cohort, 'cohortRoot') ||
    !rooted(outcome.coverage, 'coverageRoot')
  )
    throw new Error('nested outcome root mismatch');
  for (const root of [
    binding.workspace_identity_root,
    binding.settled_state_root,
    binding.state_query_proof_root,
    outcome.evidence?.settledStateRoot,
    outcome.evidence?.queryProofRoot,
  ])
    requireRoot(root, 'outcome binding root');
  if (
    binding.settled_state_root !== outcome.evidence.settledStateRoot ||
    binding.state_query_proof_root !== outcome.evidence.queryProofRoot ||
    binding.assignment_subject !== `kungfu:${outcome.assignmentId}`
  )
    throw new Error('outcome binding does not match settled Work evidence');
  const outcomeAsOf = canonicalTimestamp(outcome.asOf, 'outcome.asOf');
  if (Date.parse(outcomeAsOf) > Date.parse(asOf))
    throw new Error(
      'outcome is from the future relative to the declared as-of',
    );
  const waits = outcome.window?.excludedWaitSeconds;
  const waitNames = [
    'ci-queue',
    'external-review',
    'human-decision',
    'platform-approval',
  ];
  if (
    !isObject(waits) ||
    waitNames.some(
      (name) => !Number.isSafeInteger(waits[name]) || waits[name] < 0,
    )
  )
    throw new Error('outcome excluded waits are invalid');
  if (
    !Number.isSafeInteger(outcome.window?.attributableActiveSeconds) ||
    outcome.window.attributableActiveSeconds < 0
  )
    throw new Error('outcome attributable active time is invalid');
  const rework = outcome.metrics?.rework;
  if (
    !isObject(rework) ||
    !['qualified', 'unknown'].includes(rework.status) ||
    (rework.count !== null &&
      (!Number.isSafeInteger(rework.count) || rework.count < 0))
  )
    throw new Error('outcome rework signal is invalid');
  const preimage = {
    schema: WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA,
    assignmentSubject: binding.assignment_subject,
    workspaceIdentityRoot: binding.workspace_identity_root,
    settledStateRoot: binding.settled_state_root,
    bindingRoot: binding.binding_root,
    outcomeRoot: outcome.outcomeRoot,
    coverageRoot: outcome.coverage.coverageRoot,
    cohortRoot: outcome.cohort.cohortRoot,
    outcomeAsOf,
    coverageComplete: outcome.coverage.complete === true,
    attributableActiveSeconds: outcome.window.attributableActiveSeconds,
    excludedWaitSeconds: Object.fromEntries(
      waitNames.map((name) => [name, waits[name]]),
    ),
    rework: {
      status: rework.status,
      count: rework.status === 'qualified' ? rework.count : null,
    },
    sourceEvidenceRoots: sortedRoots(
      outcome.evidence.sourceEvidenceRoots ?? [],
    ),
  };
  return { ...preimage, recordRoot: semanticRoot(preimage) };
}

export function buildAssignmentOutcomeHistory({
  query,
  asOf,
  targetCohortRoot,
}) {
  if (!isObject(query) || query.schema !== FEDERATED_QUERY_SCHEMA)
    throw new Error(`history query must use ${FEDERATED_QUERY_SCHEMA}`);
  if (query.verification?.ok !== true || query.aggregate?.proof_ok !== true)
    throw new Error('history query proof did not verify');
  const source = query.global_work?.outcome_history;
  if (
    !isObject(source) ||
    source.schema !==
      'kungfu.workspace-federation.work-design-outcome-history/v1' ||
    !rooted(source, 'history_root')
  )
    throw new Error('global Work outcome history root mismatch');
  const canonicalAsOf = canonicalTimestamp(asOf, 'asOf');
  requireRoot(targetCohortRoot, 'targetCohortRoot');
  const recordsByState = new Map();
  const conflictedStateRoots = new Set();
  const issues = [...(source.issues ?? [])];
  for (const binding of source.bindings ?? []) {
    try {
      const record = outcomeRecord(binding, canonicalAsOf);
      if (conflictedStateRoots.has(record.settledStateRoot)) continue;
      const existing = recordsByState.get(record.settledStateRoot);
      if (existing && existing.recordRoot !== record.recordRoot) {
        recordsByState.delete(record.settledStateRoot);
        conflictedStateRoots.add(record.settledStateRoot);
        issues.push({
          code: 'conflicting-outcome-records',
          settledStateRoot: record.settledStateRoot,
          recordRoots: sortedRoots([existing.recordRoot, record.recordRoot]),
        });
      } else if (!existing) recordsByState.set(record.settledStateRoot, record);
    } catch (error) {
      issues.push({
        code: 'outcome-record-unqualified',
        bindingRoot: binding?.binding_root ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const coverage = source.coverage ?? {};
  const normalizedCoverage = {
    uniqueSettledStateCount: Number(coverage.unique_settled_state_count ?? 0),
    uniqueAssignmentCount: Number(coverage.unique_assignment_count ?? 0),
    complete: Number(coverage.complete ?? 0),
    partial: Number(coverage.partial ?? 0),
    sealedOnlyUnknown: Number(coverage.sealed_only_unknown ?? 0),
    unqualifiedStateCount: Number(coverage.unqualified_state_count ?? 0),
  };
  if (
    Object.values(normalizedCoverage).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    throw new Error('global Work outcome coverage is invalid');
  const preimage = {
    schema: OUTCOME_HISTORY_SCHEMA,
    asOf: canonicalAsOf,
    queryProofRoot: requireRoot(query.proof?.proof_root, 'query proof root'),
    globalWorkProjectionRoot: requireRoot(
      query.proof?.global_work_projection_root,
      'global Work projection root',
    ),
    targetCohortRoot,
    records: [...recordsByState.values()].sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.settledStateRoot, 'utf8'),
        Buffer.from(right.settledStateRoot, 'utf8'),
      ),
    ),
    issues: issues.sort((left, right) =>
      Buffer.compare(
        Buffer.from(semanticRoot(left), 'utf8'),
        Buffer.from(semanticRoot(right), 'utf8'),
      ),
    ),
    coverage: normalizedCoverage,
  };
  return { ...preimage, sourceRoot: semanticRoot(preimage) };
}

/**
 * Compile Selector input only from a verified installed global Work query.
 * The compiler never reads Assignment payload bodies and never infers success
 * from mutable labels: only portable, settled sealed-work coordinates enter.
 */
export function buildAssignmentHistorySelectionRequest({
  query,
  objectiveRoot,
  xinfaRoot,
  asOf,
  maxSelected = null,
  maximumIndexAgeSeconds = 300,
  outcomeHistory = null,
}) {
  if (!isObject(query) || query.schema !== FEDERATED_QUERY_SCHEMA)
    throw new Error(`history query must use ${FEDERATED_QUERY_SCHEMA}`);
  if (query.authority !== 'component-workspace-authorities')
    throw new Error(
      'history query authority is not component workspace authority',
    );
  if (query.verification?.ok !== true || query.aggregate?.proof_ok !== true)
    throw new Error('history query proof did not verify');
  if (
    query.aggregate?.writes !== 0 ||
    !Array.isArray(query.writes) ||
    query.writes.length !== 0
  )
    throw new Error('history query is not read-only');
  if (!isObject(query.proof) || query.proof.schema !== FEDERATED_PROOF_SCHEMA)
    throw new Error(`history query proof must use ${FEDERATED_PROOF_SCHEMA}`);
  const sourceCutRoot = requireRoot(
    query.proof.proof_root,
    '$.proof.proof_root',
  );
  requireRoot(
    query.proof.global_work_projection_root,
    '$.proof.global_work_projection_root',
  );
  requireRoot(objectiveRoot, 'objectiveRoot');
  requireRoot(xinfaRoot, 'xinfaRoot');
  const canonicalAsOf = canonicalTimestamp(asOf, 'asOf');
  if (!Array.isArray(query.components))
    throw new Error('history query components must be an array');

  if (outcomeHistory !== null && !rooted(outcomeHistory, 'sourceRoot'))
    throw new Error('work-design outcome history root mismatch');
  const outcomeByState = new Map(
    (outcomeHistory?.records ?? []).map((record) => [
      record.settledStateRoot,
      record,
    ]),
  );

  const candidatesByStateRoot = new Map();
  const authorityRoots = new Set();
  const observedAt = [];
  for (const [componentIndex, component] of query.components.entries()) {
    if (!isObject(component)) continue;
    if (
      component.availability !== 'available' ||
      component.compatibility?.state !== 'compatible' ||
      component.stale === true
    )
      continue;
    const indexedAt = canonicalTimestamp(
      component.observed_at,
      `$.components[${componentIndex}].observed_at`,
    );
    observedAt.push(indexedAt);
    const componentCutRoot = requireRoot(
      component.cut_root,
      `$.components[${componentIndex}].cut_root`,
    );
    const componentProofRoot = requireRoot(
      component.query_proof_root,
      `$.components[${componentIndex}].query_proof_root`,
    );
    for (const [stateIndex, state] of (
      component.retained_assignment_states ?? []
    ).entries()) {
      const at = `$.components[${componentIndex}].retained_assignment_states[${stateIndex}]`;
      if (
        !isObject(state) ||
        state.schema !== SEALED_WORK_SCHEMA ||
        state.settled !== true ||
        state.phase !== 'continuation-decided'
      )
        continue;
      const authorityRoot = requireRoot(
        state.workspace_identity_root,
        `${at}.workspace_identity_root`,
      );
      const stateRoot = requireRoot(state.state_root, `${at}.state_root`);
      const stateProofRoot = requireRoot(
        state.query_proof_root,
        `${at}.query_proof_root`,
      );
      authorityRoots.add(authorityRoot);
      const outcome = outcomeByState.get(stateRoot);
      const comparable =
        outcome !== undefined &&
        outcome.coverageComplete === true &&
        outcome.cohortRoot === outcomeHistory?.targetCohortRoot;
      const candidate = buildWorkHistoryCandidate({
        recordSchema: SEALED_WORK_SCHEMA,
        authority: { root: authorityRoot, status: 'current' },
        source: {
          id: FEDERATED_SOURCE_ID,
          root: stateRoot,
          status: 'current',
          visibility: 'internal',
        },
        temporal: {
          availableAt: indexedAt,
          indexedAt,
          // A sealed settled state was complete no later than this verified
          // observation; using the observation is conservative for as-of gates.
          completedAt: indexedAt,
        },
        supersession: { status: 'active', at: null, replacementRoot: null },
        invalidation: { status: 'valid', at: null, evidenceRoot: null },
        applicability: comparable ? 'comparable' : 'precedent',
        evidenceRoots: sortedRoots([
          componentCutRoot,
          componentProofRoot,
          stateProofRoot,
          stateRoot,
          ...(outcome
            ? [
                outcome.bindingRoot,
                outcome.outcomeRoot,
                outcome.coverageRoot,
                outcome.cohortRoot,
                ...outcome.sourceEvidenceRoots,
              ]
            : []),
        ]),
        ranking: {
          score: comparable
            ? 100 + Math.min(99, outcome.sourceEvidenceRoots.length)
            : outcome
              ? 10
              : 1,
        },
      });
      const existing = candidatesByStateRoot.get(stateRoot);
      if (
        existing === undefined ||
        candidate.temporal.indexedAt > existing.temporal.indexedAt ||
        (candidate.temporal.indexedAt === existing.temporal.indexedAt &&
          candidate.candidateRoot < existing.candidateRoot)
      )
        candidatesByStateRoot.set(stateRoot, candidate);
    }
  }
  if (observedAt.length === 0)
    throw new Error(
      'history query has no current compatible component observation',
    );
  const capturedAt = observedAt.sort().at(-1);
  const candidates = [...candidatesByStateRoot.values()].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.candidateRoot, 'utf8'),
      Buffer.from(right.candidateRoot, 'utf8'),
    ),
  );
  const policy = buildWorkHistorySelectionPolicy({
    id: 'work-design-native-sealed-work-v1',
    version: 1,
    maxSelected:
      maxSelected ??
      (ROOT.test(String(outcomeHistory?.targetCohortRoot ?? '')) ? 64 : 8),
    recentWindowSeconds: 60 * 60 * 24 * 365,
    maximumIndexAgeSeconds,
    allowedAuthorityRoots: sortedRoots([...authorityRoots]),
    allowedRecordSchemas: [SEALED_WORK_SCHEMA],
    allowedSourceIds: [FEDERATED_SOURCE_ID],
    allowedVisibilities: ['internal'],
  });
  return {
    schema: 'kungfu.work-history.selection-request/v1',
    objectiveRoot,
    xinfaRoot,
    asOf: canonicalAsOf,
    indexSnapshot: buildWorkHistoryIndexSnapshot({ capturedAt, sourceCutRoot }),
    policy,
    candidates,
  };
}

export function buildAssignmentHistorySource(query) {
  if (!isObject(query) || query.schema !== FEDERATED_QUERY_SCHEMA)
    throw new Error(`history query must use ${FEDERATED_QUERY_SCHEMA}`);
  const preimage = {
    schema: HISTORY_SOURCE_SCHEMA,
    queryProofRoot: requireRoot(query.proof?.proof_root, '$.proof.proof_root'),
    globalWorkProjectionRoot: requireRoot(
      query.proof?.global_work_projection_root,
      '$.proof.global_work_projection_root',
    ),
    proofOk:
      query.verification?.ok === true && query.aggregate?.proof_ok === true,
    complete: query.aggregate?.complete === true,
    state: String(query.aggregate?.state ?? 'unknown'),
    componentCount: Number(query.aggregate?.component_count ?? 0),
    unavailableComponentCount: Number(
      query.aggregate?.unavailable_component_count ?? 0,
    ),
    unresolvedReferenceCount: Number(
      query.aggregate?.unresolved_reference_count ?? 0,
    ),
    writes: Number(query.aggregate?.writes ?? -1),
  };
  if (!preimage.proofOk || preimage.writes !== 0)
    throw new Error('history query source coverage did not verify read-only');
  for (const field of [
    'componentCount',
    'unavailableComponentCount',
    'unresolvedReferenceCount',
  ])
    if (!Number.isSafeInteger(preimage[field]) || preimage[field] < 0)
      throw new Error(`history query ${field} is invalid`);
  return { ...preimage, sourceRoot: semanticRoot(preimage) };
}

function expectedAdviceInput(request, history) {
  return {
    intent: {
      kind: 'assignment-request',
      root: request.humanWorkDefinitionRoot,
    },
    history,
    xinfaRoot: request.adviceRequest.xinfaRoot,
    asOf: request.adviceRequest.asOf,
    policy: request.adviceRequest.policy,
  };
}

function fallback(request, reason, diagnostics, partial = {}) {
  const humanWorkDefinitionRoot = ROOT.test(
    String(request?.humanWorkDefinitionRoot ?? ''),
  )
    ? request.humanWorkDefinitionRoot
    : null;
  const preimage = {
    schema: WORK_DESIGN_PREFLIGHT_SCHEMA,
    ok: true,
    outcome: 'manual-capture',
    humanAuthorization: {
      authority: 'human',
      finalWorkDefinitionRoot: humanWorkDefinitionRoot,
      preserved: humanWorkDefinitionRoot !== null,
    },
    history: partial.history ?? null,
    advice: partial.advice ?? null,
    disposition: partial.disposition ?? null,
    adoption: {
      adopted: false,
      adviceRoot: partial.advice?.advice?.adviceRoot ?? null,
    },
    fallback: {
      explicit: true,
      reason,
      silentAdoption: false,
      diagnostics,
    },
    operation: { ...OPERATION },
    authority: { ...AUTHORITY },
  };
  return { ...preimage, preflightRoot: semanticRoot(preimage) };
}

function autoAdoptionEscalations(advice, historyBinding) {
  const reasons = new Set();
  if (advice.status !== AUTO_ADOPTION_POLICY.requiresAdviceStatus)
    reasons.add('advice-not-ready');
  if (historyBinding.status !== AUTO_ADOPTION_POLICY.requiresHistoryStatus)
    reasons.add('history-not-complete');
  if (historyBinding.selectedCount < 1) reasons.add('no-selected-history');
  if (
    (CONFIDENCE_ORDER.get(advice.confidence) ?? -1) <
    CONFIDENCE_ORDER.get(AUTO_ADOPTION_POLICY.minimumConfidence)
  )
    reasons.add('confidence-below-policy');
  for (const gapId of advice.gapIds)
    if (!AUTO_ADOPTION_POLICY.allowedGapIds.includes(gapId))
      reasons.add(`unresolved-gap:${gapId}`);
  return [...reasons].sort();
}

function buildPolicyDisposition(request, advice, historyBinding) {
  const evaluation = {
    eligible: true,
    historyStatus: historyBinding.status,
    selectedCount: historyBinding.selectedCount,
    confidence: advice.confidence,
    gapIds: advice.gapIds,
    escalationReasons: [],
  };
  const rationaleRoot = semanticRoot({
    schema: 'kungfu.work-design.policy-rationale/v1',
    policyRoot: AUTO_ADOPTION_POLICY.policyRoot,
    adviceRoot: advice.adviceRoot,
    intentRoot: request.humanWorkDefinitionRoot,
    evaluation,
  });
  const preimage = {
    schema: POLICY_DISPOSITION_SCHEMA,
    adviceRoot: advice.adviceRoot,
    intentRoot: request.humanWorkDefinitionRoot,
    action: 'policy-accepted',
    rationaleRoot,
    resultingAdviceRoot: advice.adviceRoot,
    policyRoot: AUTO_ADOPTION_POLICY.policyRoot,
    evaluation,
    authority: {
      mode: 'policy-disposition-record',
      assignmentAuthority: false,
      workControlAuthority: false,
      mutatesOriginalAdvice: false,
      mutatesUserIntent: false,
    },
  };
  return { ...preimage, dispositionRoot: semanticRoot(preimage) };
}

function humanDecisionRequired(request, history, advice, reasons) {
  const preimage = {
    schema: WORK_DESIGN_PREFLIGHT_SCHEMA,
    ok: true,
    outcome: 'human-decision-required',
    humanAuthorization: {
      authority: 'human',
      finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
      preserved: true,
    },
    history,
    advice,
    disposition: null,
    adoption: {
      adopted: false,
      adviceRoot: advice.advice.adviceRoot,
    },
    escalation: {
      required: true,
      policyRoot: AUTO_ADOPTION_POLICY.policyRoot,
      reasons,
    },
    fallback: null,
    operation: { ...OPERATION },
    authority: { ...AUTHORITY },
  };
  return { ...preimage, preflightRoot: semanticRoot(preimage) };
}

function validateEnvelope(request) {
  const diagnostics = [];
  if (!isObject(request))
    return [diagnostic('invalid-type', '$', 'request must be an object')];
  if (request.schema !== WORK_DESIGN_PREFLIGHT_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported request schema'),
    );
  if (!isObject(request.humanWorkDefinition))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.humanWorkDefinition',
        'human work definition must be an object',
      ),
    );
  if (!ROOT.test(String(request.humanWorkDefinitionRoot ?? '')))
    diagnostics.push(
      diagnostic(
        'invalid-root',
        '$.humanWorkDefinitionRoot',
        'human work definition root is required',
      ),
    );
  else if (
    isObject(request.humanWorkDefinition) &&
    semanticRoot(request.humanWorkDefinition) !==
      request.humanWorkDefinitionRoot
  )
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        '$.humanWorkDefinitionRoot',
        'human work definition root differs from its canonical preimage',
      ),
    );
  if (!isObject(request.selectionRequest))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.selectionRequest',
        'selection request must be an object',
      ),
    );
  else if (
    request.selectionRequest.objectiveRoot !== request.humanWorkDefinitionRoot
  )
    diagnostics.push(
      diagnostic(
        'intent-root-mismatch',
        '$.selectionRequest.objectiveRoot',
        'selector objective must bind the final human work definition root',
      ),
    );
  if (!isObject(request.adviceRequest))
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.adviceRequest',
        'advice request input must be an object',
      ),
    );
  if (request.disposition !== undefined) {
    if (!isObject(request.disposition)) {
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.disposition',
          'explicit human disposition must be an object',
        ),
      );
      return diagnostics;
    }
    if (!ACTIONS.has(request.disposition.action))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          '$.disposition.action',
          'unsupported human disposition',
        ),
      );
    if (request.disposition.decisionAuthority !== 'human')
      diagnostics.push(
        diagnostic(
          'human-authority-required',
          '$.disposition.decisionAuthority',
          'the final disposition must be human-authorized',
        ),
      );
    if (!ROOT.test(String(request.disposition.rationaleRoot ?? '')))
      diagnostics.push(
        diagnostic(
          'invalid-root',
          '$.disposition.rationaleRoot',
          'human disposition rationale root is required',
        ),
      );
  }
  if (request.historySource !== undefined) {
    if (
      !isObject(request.historySource) ||
      request.historySource.schema !== HISTORY_SOURCE_SCHEMA ||
      semanticRoot(
        Object.fromEntries(
          Object.entries(request.historySource).filter(
            ([key]) => key !== 'sourceRoot',
          ),
        ),
      ) !== request.historySource.sourceRoot ||
      request.historySource.proofOk !== true ||
      request.historySource.writes !== 0
    )
      diagnostics.push(
        diagnostic(
          'history-source-invalid',
          '$.historySource',
          'history source coverage must be rooted, verified, and read-only',
        ),
      );
  }
  if (
    request.outcomeHistory !== undefined &&
    (!isObject(request.outcomeHistory) ||
      request.outcomeHistory.schema !== OUTCOME_HISTORY_SCHEMA ||
      !rooted(request.outcomeHistory, 'sourceRoot'))
  )
    diagnostics.push(
      diagnostic(
        'outcome-history-invalid',
        '$.outcomeHistory',
        'outcome history must be an exact rooted global Work projection',
      ),
    );
  const availability = request.availability ?? {};
  for (const name of ['selector', 'advisor']) {
    if (!AVAILABILITY.has(availability[name] ?? 'available'))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          `$.availability.${name}`,
          'availability must be available, timeout, or unavailable',
        ),
      );
  }
  return diagnostics;
}

export function runAssignmentPreflight(request) {
  const envelopeDiagnostics = validateEnvelope(request);
  if (envelopeDiagnostics.length > 0)
    return fallback(request, 'protocol-invalid', envelopeDiagnostics);

  const selectorAvailability = request.availability?.selector ?? 'available';
  if (selectorAvailability !== 'available')
    return fallback(request, `selector-${selectorAvailability}`, []);

  const selected = selectWorkHistory(request.selectionRequest);
  if (!selected.ok)
    return fallback(request, 'selector-failed', selected.diagnostics);
  const selectionVerification = verifyWorkHistorySelectionManifest(
    selected.manifest,
  );
  const history = {
    manifest: selected.manifest,
    verification: selectionVerification,
    verificationRoot: semanticRoot(selectionVerification),
    source: request.historySource ?? null,
    outcomeHistory: request.outcomeHistory ?? null,
  };
  if (!selectionVerification.ok)
    return fallback(
      request,
      'selection-root-mismatch',
      selectionVerification.diagnostics,
      { history },
    );
  if (
    selected.manifest.status !== 'complete' &&
    selected.manifest.coverage.gaps.includes('stale-index-snapshot')
  )
    return fallback(request, 'stale-manifest', [], { history });
  if ((request.outcomeHistory?.issues ?? []).length > 0)
    return fallback(request, 'outcome-history-unqualified', [], { history });

  const advisorAvailability = request.availability?.advisor ?? 'available';
  if (advisorAvailability !== 'available')
    return fallback(request, `advisor-${advisorAvailability}`, [], {
      history,
    });

  const sourcePartial = request.historySource?.complete === false;
  const historyBinding = {
    selectionRoot: selected.manifest.selectionRoot,
    verificationRoot: history.verificationRoot,
    status: selected.manifest.status,
    selectedCount: selected.manifest.coverage.includedCount,
    confidence: sourcePartial
      ? 'medium'
      : selected.manifest.coverage.confidence,
    gapIds: [
      ...new Set([
        ...selected.manifest.coverage.gaps,
        ...(sourcePartial ? ['global-work-partial'] : []),
      ]),
    ].sort(),
  };
  const expectedInput = expectedAdviceInput(request, historyBinding);
  const adviceRequest = {
    schema: 'kungfu.work-design.advice-request/v1',
    ...expectedInput,
    proposal: request.adviceRequest.proposal,
  };
  const advised = buildWorkDesignAdvice(adviceRequest);
  if (!advised.ok)
    return fallback(request, 'advisor-failed', advised.diagnostics, {
      history,
    });
  const adviceVerification = verifyWorkDesignAdvice(
    advised.advice,
    expectedInput,
  );
  const estimated = request.outcomeHistory
    ? buildOutcomeInformedEstimate({
        asOf: request.outcomeHistory.asOf,
        sourceRoot: request.outcomeHistory.sourceRoot,
        queryProofRoot: request.outcomeHistory.queryProofRoot,
        globalWorkProjectionRoot:
          request.outcomeHistory.globalWorkProjectionRoot,
        targetCohortRoot: request.outcomeHistory.targetCohortRoot,
        selectedStateRoots: sortedRoots(
          selected.manifest.included.map(
            (entry) => entry.sourceReference.sourceRoot,
          ),
        ),
        records: request.outcomeHistory.records,
        coverage: request.outcomeHistory.coverage,
      })
    : { ok: true, estimate: null, diagnostics: [] };
  if (!estimated.ok)
    return fallback(request, 'advisor-failed', estimated.diagnostics, {
      history,
    });
  const estimateVerification = estimated.estimate
    ? verifyOutcomeInformedEstimate(estimated.estimate)
    : null;
  if (estimateVerification?.ok === false)
    return fallback(
      request,
      'advice-root-mismatch',
      estimateVerification.diagnostics,
      { history },
    );
  const advice = {
    advice: advised.advice,
    verification: adviceVerification,
    estimation: estimated.estimate
      ? { estimate: estimated.estimate, verification: estimateVerification }
      : null,
  };
  if (!adviceVerification.ok)
    return fallback(
      request,
      'advice-root-mismatch',
      adviceVerification.diagnostics,
      { history, advice },
    );
  if (
    ROOT.test(String(request.disposition?.expectedAdviceRoot ?? '')) &&
    request.disposition.expectedAdviceRoot !== advised.advice.adviceRoot
  )
    return fallback(
      request,
      'advice-root-mismatch',
      [
        diagnostic(
          'exact-advice-root-mismatch',
          '$.disposition.expectedAdviceRoot',
          'human disposition names a different advice root',
        ),
      ],
      { history, advice },
    );

  if (request.disposition === undefined) {
    const escalationReasons = autoAdoptionEscalations(
      advised.advice,
      historyBinding,
    );
    if (escalationReasons.length > 0)
      return humanDecisionRequired(request, history, advice, escalationReasons);
    const disposition = buildPolicyDisposition(
      request,
      advised.advice,
      historyBinding,
    );
    const preimage = {
      schema: WORK_DESIGN_PREFLIGHT_SCHEMA,
      ok: true,
      outcome: 'advisory-auto-adopted',
      humanAuthorization: {
        authority: 'human',
        finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
        preserved: true,
      },
      history,
      advice,
      disposition,
      adoption: {
        adopted: true,
        adviceRoot: advised.advice.adviceRoot,
        mode: 'policy-auto-adopted',
        policyRoot: AUTO_ADOPTION_POLICY.policyRoot,
      },
      escalation: null,
      fallback: null,
      operation: { ...OPERATION },
      authority: { ...AUTHORITY },
    };
    return { ...preimage, preflightRoot: semanticRoot(preimage) };
  }

  if (
    advised.advice.status === 'insufficient-history' &&
    request.disposition.action !== 'insufficient-history'
  )
    return fallback(
      request,
      'disposition-status-mismatch',
      [
        diagnostic(
          'disposition-status-mismatch',
          '$.disposition.action',
          'insufficient history requires an insufficient-history disposition',
        ),
      ],
      { history, advice },
    );

  const resultingAdviceRoot =
    request.disposition.action === 'accepted'
      ? advised.advice.adviceRoot
      : request.disposition.action === 'insufficient-history'
        ? null
        : semanticRoot({
            action: request.disposition.action,
            adviceRoot: advised.advice.adviceRoot,
            finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
          });
  const dispositionResult = buildWorkDesignDisposition({
    adviceRoot: advised.advice.adviceRoot,
    intentRoot: request.humanWorkDefinitionRoot,
    action: request.disposition.action,
    rationaleRoot: request.disposition.rationaleRoot,
    resultingAdviceRoot,
  });
  if (!dispositionResult.ok)
    return fallback(
      request,
      'disposition-invalid',
      dispositionResult.diagnostics,
      { history, advice },
    );
  const dispositionVerification = verifyWorkDesignDisposition(
    dispositionResult.disposition,
  );
  if (!dispositionVerification.ok)
    return fallback(
      request,
      'disposition-root-mismatch',
      dispositionVerification.diagnostics,
      { history, advice, disposition: dispositionResult.disposition },
    );

  const isManual =
    request.disposition.action === 'overridden' ||
    request.disposition.action === 'insufficient-history';
  const preimage = {
    schema: WORK_DESIGN_PREFLIGHT_SCHEMA,
    ok: true,
    outcome: isManual ? 'manual-capture' : 'advisory-disposition',
    humanAuthorization: {
      authority: 'human',
      finalWorkDefinitionRoot: request.humanWorkDefinitionRoot,
      preserved: true,
    },
    history,
    advice,
    disposition: dispositionResult.disposition,
    adoption: {
      adopted: ['accepted', 'adapted'].includes(request.disposition.action),
      adviceRoot: advised.advice.adviceRoot,
    },
    fallback: isManual
      ? {
          explicit: true,
          reason: request.disposition.action,
          silentAdoption: false,
          diagnostics: [],
        }
      : null,
    operation: { ...OPERATION },
    authority: { ...AUTHORITY },
  };
  return { ...preimage, preflightRoot: semanticRoot(preimage) };
}

export function verifyAssignmentPreflight(result) {
  if (!isObject(result) || result.schema !== WORK_DESIGN_PREFLIGHT_SCHEMA)
    return { ok: false, reason: 'unsupported-preflight-schema' };
  const { preflightRoot, ...preimage } = result;
  if (semanticRoot(preimage) !== preflightRoot)
    return { ok: false, reason: 'preflight-root-mismatch' };
  if (
    JSON.stringify(result.authority) !== JSON.stringify(AUTHORITY) ||
    JSON.stringify(result.operation) !== JSON.stringify(OPERATION)
  )
    return { ok: false, reason: 'authority-boundary-mismatch' };
  if (
    result.humanAuthorization?.authority !== 'human' ||
    result.humanAuthorization?.preserved !== true ||
    !ROOT.test(String(result.humanAuthorization?.finalWorkDefinitionRoot ?? ''))
  )
    return { ok: false, reason: 'human-authorization-missing' };
  if (
    result.adoption?.adopted === true &&
    (!ROOT.test(String(result.adoption.adviceRoot ?? '')) ||
      result.advice?.advice?.adviceRoot !== result.adoption.adviceRoot)
  )
    return { ok: false, reason: 'adopted-advice-root-mismatch' };
  if (
    result.advice?.estimation !== null &&
    result.advice?.estimation !== undefined &&
    (verifyOutcomeInformedEstimate(result.advice.estimation.estimate).ok !==
      true ||
      result.advice.estimation.verification?.ok !== true)
  )
    return { ok: false, reason: 'outcome-estimate-root-mismatch' };
  if (
    result.outcome === 'advisory-auto-adopted' &&
    result.adoption?.mode !== 'policy-auto-adopted'
  )
    return { ok: false, reason: 'auto-adoption-mode-missing' };
  if (result.adoption?.mode === 'policy-auto-adopted') {
    const disposition = result.disposition;
    if (
      result.outcome !== 'advisory-auto-adopted' ||
      result.adoption.adopted !== true ||
      result.adoption.policyRoot !== AUTO_ADOPTION_POLICY.policyRoot ||
      result.escalation !== null ||
      result.fallback !== null ||
      !isObject(disposition) ||
      disposition.schema !== POLICY_DISPOSITION_SCHEMA ||
      disposition.action !== 'policy-accepted' ||
      disposition.policyRoot !== AUTO_ADOPTION_POLICY.policyRoot ||
      disposition.adviceRoot !== result.adoption.adviceRoot ||
      disposition.intentRoot !==
        result.humanAuthorization.finalWorkDefinitionRoot ||
      disposition.resultingAdviceRoot !== result.adoption.adviceRoot ||
      disposition.evaluation?.eligible !== true ||
      disposition.evaluation?.escalationReasons?.length !== 0
    )
      return { ok: false, reason: 'policy-disposition-invalid' };
    const { dispositionRoot, ...dispositionPreimage } = disposition;
    if (semanticRoot(dispositionPreimage) !== dispositionRoot)
      return { ok: false, reason: 'policy-disposition-root-mismatch' };
  }
  if (
    result.outcome === 'human-decision-required' &&
    (result.escalation?.required !== true ||
      result.escalation?.policyRoot !== AUTO_ADOPTION_POLICY.policyRoot ||
      !Array.isArray(result.escalation?.reasons) ||
      result.escalation.reasons.length === 0 ||
      result.adoption?.adopted !== false ||
      result.disposition !== null ||
      result.fallback !== null)
  )
    return { ok: false, reason: 'human-escalation-invalid' };
  return { ok: true, reason: null };
}

export function workDesignAuthorityBoundary() {
  return { authority: { ...AUTHORITY }, operation: { ...OPERATION } };
}

export function workDesignAutoAdoptionPolicy() {
  return structuredClone(AUTO_ADOPTION_POLICY);
}
