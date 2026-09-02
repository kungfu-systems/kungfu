// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { canonicalJson, semanticRoot } from '../../project-cut/index.mjs';

export * from './work-design-policy-replay.mjs';

export const WORK_DESIGN_OUTCOME_REQUEST_SCHEMA =
  'kungfu.work-design.outcome-compilation-request/v1';
export const WORK_DESIGN_OUTCOME_SCHEMA = 'kungfu.work-design.outcome/v1';
export const WORK_DESIGN_FEEDBACK_STATUS_SCHEMA =
  'kungfu.work-design.feedback-status/v1';
export const WORK_DESIGN_ACTIVATION_ENVELOPE_SCHEMA =
  'kungfu.work-design.activation-envelope/v1';
export const WORK_DESIGN_POLICY_STATE_SCHEMA =
  'kungfu.work-design.policy-state/v1';
export const WORK_DESIGN_POLICY_DECISION_SCHEMA =
  'kungfu.work-design.policy-decision/v1';
export const WORK_DESIGN_MONITORING_SCHEMA =
  'kungfu.work-design.policy-monitoring/v1';
export const WORK_DESIGN_FEEDBACK_INSPECTION_SCHEMA =
  'kungfu.work-design.feedback-inspection/v1';
export const WORK_DESIGN_PROSPECTIVE_OUTCOME_BINDING_SCHEMA =
  'kungfu.work-design.prospective-outcome-binding/v1';

export const MINIMUM_SHADOW_SAMPLES = 10;
export const MINIMUM_DEFAULT_PROMOTION_SAMPLES = 30;

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const DELIVERY_CLASSES = new Set([
  'cross-platform',
  'native-proof-required',
  'non-native-fast',
  'release',
]);
const WAIT_CLASSES = new Set([
  'ci-queue',
  'external-review',
  'human-decision',
  'platform-approval',
]);
const REWORK_KINDS = new Set(['acceptance-reopen', 'corrective-successor']);
const ASSESSMENT_VERDICTS = new Set(['fit', 'unfit', 'uncertain']);
const METRIC_NAMES = [
  'acceptanceFailure',
  'dependencyCorrection',
  'rework',
  'timeout',
];
const OUTCOME_AUTHORITY = Object.freeze({
  mode: 'settled-work-observation',
  factAuthority: false,
  episodeAuthority: false,
  assignmentAuthority: false,
  workControlAuthority: false,
  policyAuthority: false,
  mayMutate: false,
});
const STATUS_AUTHORITY = Object.freeze({
  mode: 'read-only-projection',
  policyAuthority: false,
  workControlAuthority: false,
  mayMutate: false,
});
const DECISION_AUTHORITY = Object.freeze({
  mode: 'native-bounded-policy-envelope',
  objectiveAuthority: false,
  scopeAuthority: false,
  acceptanceAuthority: false,
  safetyBoundaryAuthority: false,
  workControlAuthority: false,
  repositoryAuthority: false,
});

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, at, diagnostics) {
  if (!isObject(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected object'));
    return false;
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const wanted = [...expected].sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    diagnostics.push(
      diagnostic('object-shape-mismatch', at, 'object keys differ'),
    );
    return false;
  }
  return true;
}

function requireRoot(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !ROOT.test(value))
    diagnostics.push(diagnostic('invalid-root', at, 'expected SHA-256 root'));
}

function requireId(value, at, diagnostics) {
  if (typeof value !== 'string' || !ID.test(value))
    diagnostics.push(
      diagnostic('invalid-id', at, 'expected stable identifier'),
    );
}

function requireTimestamp(value, at, diagnostics) {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    diagnostics.push(
      diagnostic('invalid-timestamp', at, 'expected canonical UTC timestamp'),
    );
}

function requireInteger(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value) || value < 0)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-negative safe integer'),
    );
}

function sortedUnique(values, at, diagnostics, validator) {
  if (!Array.isArray(values)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected array'));
    return [];
  }
  values.forEach((value, index) =>
    validator(value, `${at}[${index}]`, diagnostics),
  );
  if (
    new Set(values).size !== values.length ||
    canonicalJson(values) !== canonicalJson([...values].sort(compareUtf8))
  )
    diagnostics.push(
      diagnostic(
        'non-canonical-set',
        at,
        'values must be UTF-8 sorted and unique',
      ),
    );
  return values;
}

function rooted(value, rootKey, at, diagnostics) {
  requireRoot(value?.[rootKey], `${at}.${rootKey}`, diagnostics);
  if (isObject(value) && ROOT.test(String(value[rootKey] ?? ''))) {
    const preimage = { ...value };
    delete preimage[rootKey];
    if (semanticRoot(preimage) !== value[rootKey])
      diagnostics.push(
        diagnostic(
          'root-mismatch',
          `${at}.${rootKey}`,
          'root differs from canonical semantic preimage',
        ),
      );
  }
}

function intervalSeconds(interval) {
  return Math.floor(
    (Date.parse(interval.end) - Date.parse(interval.start)) / 1000,
  );
}

function validateIntervals(intervals, at, diagnostics, { wait = false } = {}) {
  if (!Array.isArray(intervals)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected interval array'));
    return;
  }
  let previousEnd = -1;
  for (const [index, interval] of intervals.entries()) {
    const fields = wait
      ? ['class', 'start', 'end', 'evidenceRoot']
      : ['start', 'end', 'evidenceRoot'];
    const path = `${at}[${index}]`;
    if (!exactKeys(interval, fields, path, diagnostics)) continue;
    if (wait && !WAIT_CLASSES.has(interval.class))
      diagnostics.push(
        diagnostic(
          'invalid-wait-class',
          `${path}.class`,
          'unsupported wait class',
        ),
      );
    requireTimestamp(interval.start, `${path}.start`, diagnostics);
    requireTimestamp(interval.end, `${path}.end`, diagnostics);
    requireRoot(interval.evidenceRoot, `${path}.evidenceRoot`, diagnostics);
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= end)
      diagnostics.push(
        diagnostic('invalid-interval', path, 'interval start must precede end'),
      );
    if (Number.isFinite(start) && start < previousEnd)
      diagnostics.push(
        diagnostic(
          'overlapping-intervals',
          path,
          'intervals must be sorted and non-overlapping',
        ),
      );
    if (Number.isFinite(end)) previousEnd = end;
  }
}

function validateOutcomeRequest(request) {
  const diagnostics = [];
  if (
    !exactKeys(
      request,
      [
        'schema',
        'asOf',
        'work',
        'activeIntervals',
        'excludedWaits',
        'reworkEvents',
        'dependencyRevisions',
        'acceptanceAssessments',
        'completeness',
        'sourceEvidenceRoots',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (request.schema !== WORK_DESIGN_OUTCOME_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported outcome request'),
    );
  requireTimestamp(request.asOf, '$.asOf', diagnostics);
  if (
    exactKeys(
      request.work,
      [
        'assignmentId',
        'workDefinitionRoot',
        'adviceRoot',
        'policyRoot',
        'deliveryClass',
        'workClass',
        'repositoryClass',
        'plannedBudgetSeconds',
        'admittedAt',
        'settledAt',
        'settledState',
      ],
      '$.work',
      diagnostics,
    )
  ) {
    requireId(request.work.assignmentId, '$.work.assignmentId', diagnostics);
    requireId(request.work.workClass, '$.work.workClass', diagnostics);
    requireId(
      request.work.repositoryClass,
      '$.work.repositoryClass',
      diagnostics,
    );
    for (const key of ['workDefinitionRoot', 'adviceRoot', 'policyRoot'])
      requireRoot(request.work[key], `$.work.${key}`, diagnostics);
    if (!DELIVERY_CLASSES.has(request.work.deliveryClass))
      diagnostics.push(
        diagnostic(
          'invalid-delivery-class',
          '$.work.deliveryClass',
          'unsupported delivery class',
        ),
      );
    requireInteger(
      request.work.plannedBudgetSeconds,
      '$.work.plannedBudgetSeconds',
      diagnostics,
      true,
    );
    requireTimestamp(request.work.admittedAt, '$.work.admittedAt', diagnostics);
    requireTimestamp(request.work.settledAt, '$.work.settledAt', diagnostics);
    if (
      Date.parse(request.work.admittedAt) >= Date.parse(request.work.settledAt)
    )
      diagnostics.push(
        diagnostic(
          'invalid-work-window',
          '$.work',
          'admission must precede settlement',
        ),
      );
    if (Date.parse(request.work.settledAt) > Date.parse(request.asOf))
      diagnostics.push(
        diagnostic(
          'as-of-leakage',
          '$.work.settledAt',
          'settled Work was unavailable at the declared as_of cut',
        ),
      );
    if (
      exactKeys(
        request.work.settledState,
        ['schema', 'stateRoot', 'queryProofRoot', 'phase', 'settled'],
        '$.work.settledState',
        diagnostics,
      )
    ) {
      if (
        request.work.settledState.schema !==
          'kungfu.assignment-orchestration.sealed-work-coordinate/v1' ||
        request.work.settledState.phase !== 'continuation-decided' ||
        request.work.settledState.settled !== true
      )
        diagnostics.push(
          diagnostic(
            'unsettled-work',
            '$.work.settledState',
            'outcomes require portable continuation-decided Work',
          ),
        );
      requireRoot(
        request.work.settledState.stateRoot,
        '$.work.settledState.stateRoot',
        diagnostics,
      );
      requireRoot(
        request.work.settledState.queryProofRoot,
        '$.work.settledState.queryProofRoot',
        diagnostics,
      );
    }
  }
  validateIntervals(request.activeIntervals, '$.activeIntervals', diagnostics);
  validateIntervals(request.excludedWaits, '$.excludedWaits', diagnostics, {
    wait: true,
  });
  const observed = [
    ['reworkEvents', ['kind', 'observedAt', 'evidenceRoot']],
    [
      'dependencyRevisions',
      ['observedAt', 'previousGraphRoot', 'nextGraphRoot', 'evidenceRoot'],
    ],
    ['acceptanceAssessments', ['observedAt', 'verdict', 'evidenceRoot']],
  ];
  for (const [field, fields] of observed) {
    if (!Array.isArray(request[field])) {
      diagnostics.push(
        diagnostic('invalid-type', `$.${field}`, 'expected array'),
      );
      continue;
    }
    for (const [index, event] of request[field].entries()) {
      const at = `$.${field}[${index}]`;
      if (!exactKeys(event, fields, at, diagnostics)) continue;
      requireTimestamp(event.observedAt, `${at}.observedAt`, diagnostics);
      requireRoot(event.evidenceRoot, `${at}.evidenceRoot`, diagnostics);
      if (Date.parse(event.observedAt) > Date.parse(request.asOf))
        diagnostics.push(
          diagnostic(
            'as-of-leakage',
            `${at}.observedAt`,
            'evidence was unavailable at the declared as_of cut',
          ),
        );
      if (field === 'reworkEvents' && !REWORK_KINDS.has(event.kind))
        diagnostics.push(
          diagnostic(
            'invalid-rework-event',
            `${at}.kind`,
            'rework must be an acceptance reopen or corrective successor',
          ),
        );
      if (field === 'dependencyRevisions') {
        requireRoot(
          event.previousGraphRoot,
          `${at}.previousGraphRoot`,
          diagnostics,
        );
        requireRoot(event.nextGraphRoot, `${at}.nextGraphRoot`, diagnostics);
        if (event.previousGraphRoot === event.nextGraphRoot)
          diagnostics.push(
            diagnostic(
              'dependency-noop',
              at,
              'dependency correction must change the exact graph root',
            ),
          );
        if (
          Date.parse(event.observedAt) <= Date.parse(request.work?.admittedAt)
        )
          diagnostics.push(
            diagnostic(
              'pre-admission-dependency-change',
              `${at}.observedAt`,
              'only post-admission graph revisions are corrections',
            ),
          );
      }
      if (
        field === 'acceptanceAssessments' &&
        !ASSESSMENT_VERDICTS.has(event.verdict)
      )
        diagnostics.push(
          diagnostic(
            'invalid-assessment-verdict',
            `${at}.verdict`,
            'acceptance outcome requires a bounded assessment verdict',
          ),
        );
    }
  }
  if (
    exactKeys(
      request.completeness,
      ['timing', 'rework', 'dependency', 'acceptance'],
      '$.completeness',
      diagnostics,
    )
  )
    for (const key of ['timing', 'rework', 'dependency', 'acceptance'])
      if (typeof request.completeness[key] !== 'boolean')
        diagnostics.push(
          diagnostic(
            'invalid-type',
            `$.completeness.${key}`,
            'expected boolean evidence-completeness flag',
          ),
        );
  sortedUnique(
    request.sourceEvidenceRoots,
    '$.sourceEvidenceRoots',
    diagnostics,
    requireRoot,
  );
  const allIntervals = [
    ...(request.activeIntervals ?? []).map((row) => ({
      ...row,
      source: 'active',
    })),
    ...(request.excludedWaits ?? []).map((row) => ({ ...row, source: 'wait' })),
  ].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
  for (let index = 1; index < allIntervals.length; index += 1)
    if (
      Date.parse(allIntervals[index].start) <
      Date.parse(allIntervals[index - 1].end)
    )
      diagnostics.push(
        diagnostic(
          'attribution-overlap',
          '$.activeIntervals',
          'active time and excluded waits must not overlap',
        ),
      );
  return diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
}

function metric(status, values) {
  return status
    ? { status: 'qualified', ...values }
    : { status: 'unknown', ...values };
}

export function compileWorkDesignOutcome(request) {
  const diagnostics = validateOutcomeRequest(request);
  if (diagnostics.length > 0) return { ok: false, outcome: null, diagnostics };
  const cohortPreimage = {
    deliveryClass: request.work.deliveryClass,
    workClass: request.work.workClass,
    repositoryClass: request.work.repositoryClass,
  };
  const activeSeconds = request.activeIntervals.reduce(
    (total, interval) => total + intervalSeconds(interval),
    0,
  );
  const waitsByClass = Object.fromEntries(
    [...WAIT_CLASSES]
      .sort(compareUtf8)
      .map((name) => [
        name,
        request.excludedWaits
          .filter((interval) => interval.class === name)
          .reduce((total, interval) => total + intervalSeconds(interval), 0),
      ]),
  );
  const timingQualified =
    request.completeness.timing && request.work.plannedBudgetSeconds !== null;
  const timeout = metric(timingQualified, {
    plannedBudgetSeconds: timingQualified
      ? request.work.plannedBudgetSeconds
      : null,
    attributableActiveSeconds: timingQualified ? activeSeconds : null,
    overrunSeconds: timingQualified
      ? Math.max(0, activeSeconds - request.work.plannedBudgetSeconds)
      : null,
    exceeded: timingQualified
      ? activeSeconds > request.work.plannedBudgetSeconds
      : null,
  });
  const rework = metric(request.completeness.rework, {
    count: request.completeness.rework ? request.reworkEvents.length : null,
    eventRoots: request.completeness.rework
      ? request.reworkEvents
          .map((event) => event.evidenceRoot)
          .sort(compareUtf8)
      : [],
  });
  const dependencyCorrection = metric(request.completeness.dependency, {
    count: request.completeness.dependency
      ? request.dependencyRevisions.length
      : null,
    revisionRoots: request.completeness.dependency
      ? request.dependencyRevisions
          .map((event) => event.evidenceRoot)
          .sort(compareUtf8)
      : [],
  });
  const failedAssessments = request.acceptanceAssessments.filter(
    (assessment) => assessment.verdict === 'unfit',
  );
  const acceptanceFailure = metric(request.completeness.acceptance, {
    count: request.completeness.acceptance ? failedAssessments.length : null,
    assessmentRoots: request.completeness.acceptance
      ? request.acceptanceAssessments
          .map((assessment) => assessment.evidenceRoot)
          .sort(compareUtf8)
      : [],
  });
  const metrics = { acceptanceFailure, dependencyCorrection, rework, timeout };
  const qualifiedMetrics = METRIC_NAMES.filter(
    (name) => metrics[name].status === 'qualified',
  );
  const unknownMetrics = METRIC_NAMES.filter(
    (name) => metrics[name].status === 'unknown',
  );
  const coveragePreimage = {
    qualifiedMetrics,
    unknownMetrics,
    complete: unknownMetrics.length === 0,
  };
  const preimage = {
    schema: WORK_DESIGN_OUTCOME_SCHEMA,
    assignmentId: request.work.assignmentId,
    asOf: request.asOf,
    bindings: {
      workDefinitionRoot: request.work.workDefinitionRoot,
      adviceRoot: request.work.adviceRoot,
      policyRoot: request.work.policyRoot,
    },
    cohort: { ...cohortPreimage, cohortRoot: semanticRoot(cohortPreimage) },
    window: {
      admittedAt: request.work.admittedAt,
      settledAt: request.work.settledAt,
      attributableActiveSeconds: activeSeconds,
      excludedWaitSeconds: waitsByClass,
    },
    metrics,
    coverage: {
      ...coveragePreimage,
      coverageRoot: semanticRoot(coveragePreimage),
    },
    evidence: {
      settledStateRoot: request.work.settledState.stateRoot,
      queryProofRoot: request.work.settledState.queryProofRoot,
      sourceEvidenceRoots: request.sourceEvidenceRoots,
    },
    authority: { ...OUTCOME_AUTHORITY },
  };
  return {
    ok: true,
    outcome: { ...preimage, outcomeRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function verifyWorkDesignOutcome(outcome) {
  const diagnostics = [];
  if (
    !exactKeys(
      outcome,
      [
        'schema',
        'assignmentId',
        'asOf',
        'bindings',
        'cohort',
        'window',
        'metrics',
        'coverage',
        'evidence',
        'authority',
        'outcomeRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, diagnostics };
  if (outcome.schema !== WORK_DESIGN_OUTCOME_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported outcome schema'),
    );
  requireId(outcome.assignmentId, '$.assignmentId', diagnostics);
  requireTimestamp(outcome.asOf, '$.asOf', diagnostics);
  for (const key of ['workDefinitionRoot', 'adviceRoot', 'policyRoot'])
    requireRoot(outcome.bindings?.[key], `$.bindings.${key}`, diagnostics);
  rooted(outcome.cohort, 'cohortRoot', '$.cohort', diagnostics);
  rooted(outcome.coverage, 'coverageRoot', '$.coverage', diagnostics);
  for (const key of ['settledStateRoot', 'queryProofRoot'])
    requireRoot(outcome.evidence?.[key], `$.evidence.${key}`, diagnostics);
  if (canonicalJson(outcome.authority) !== canonicalJson(OUTCOME_AUTHORITY))
    diagnostics.push(
      diagnostic(
        'authority-escalation',
        '$.authority',
        'outcome observation cannot acquire authority',
      ),
    );
  rooted(outcome, 'outcomeRoot', '$', diagnostics);
  return { ok: diagnostics.length === 0, diagnostics };
}

export function compileProspectiveOutcomeBinding(input) {
  const outcomeVerification = verifyWorkDesignOutcome(input.outcome);
  if (!outcomeVerification.ok)
    return {
      ok: false,
      binding: null,
      diagnostics: outcomeVerification.diagnostics,
    };
  const diagnostics = [];
  const opening = input.openingEstimate;
  if (
    !opening ||
    opening.schema !== 'kungfu.work-design.opening-estimate-binding/v1' ||
    !ROOT.test(String(opening.openingEstimateRoot ?? ''))
  )
    diagnostics.push(
      diagnostic(
        'opening-estimate-invalid',
        '$.openingEstimate',
        'a rooted opening estimate binding is required',
      ),
    );
  else {
    const { openingEstimateRoot, ...preimage } = opening;
    if (semanticRoot(preimage) !== openingEstimateRoot)
      diagnostics.push(
        diagnostic(
          'root-mismatch',
          '$.openingEstimate.openingEstimateRoot',
          'opening estimate root differs from its canonical preimage',
        ),
      );
    if (opening.assignmentId !== input.outcome.assignmentId)
      diagnostics.push(
        diagnostic(
          'assignment-mismatch',
          '$.openingEstimate.assignmentId',
          'opening estimate and outcome must name the same Assignment',
        ),
      );
    if (opening.adviceRoot !== input.outcome.bindings.adviceRoot)
      diagnostics.push(
        diagnostic(
          'advice-root-mismatch',
          '$.openingEstimate.adviceRoot',
          'opening estimate and outcome must bind the same advice root',
        ),
      );
  }
  if (!Array.isArray(input.activeSegments))
    diagnostics.push(
      diagnostic('invalid-type', '$.activeSegments', 'expected array'),
    );
  const classes = new Set(['implementation-debug', 'local-validation']);
  const activity = { 'implementation-debug': 0, 'local-validation': 0 };
  const evidenceRoots = [];
  for (const [index, segment] of (input.activeSegments ?? []).entries()) {
    if (!classes.has(segment.class))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          `$.activeSegments[${index}].class`,
          'unsupported active engineering class',
        ),
      );
    if (!Number.isSafeInteger(segment.seconds) || segment.seconds < 0)
      diagnostics.push(
        diagnostic(
          'invalid-value',
          `$.activeSegments[${index}].seconds`,
          'active seconds must be a non-negative safe integer',
        ),
      );
    requireRoot(
      segment.evidenceRoot,
      `$.activeSegments[${index}].evidenceRoot`,
      diagnostics,
    );
    if (classes.has(segment.class) && Number.isSafeInteger(segment.seconds))
      activity[segment.class] += segment.seconds;
    if (ROOT.test(String(segment.evidenceRoot ?? '')))
      evidenceRoots.push(segment.evidenceRoot);
  }
  if (
    activity['implementation-debug'] + activity['local-validation'] !==
    input.outcome.window.attributableActiveSeconds
  )
    diagnostics.push(
      diagnostic(
        'active-attribution-mismatch',
        '$.activeSegments',
        'prospective active classes must exactly conserve attributable active time',
      ),
    );
  if (diagnostics.length > 0) return { ok: false, binding: null, diagnostics };
  const preimage = {
    schema: WORK_DESIGN_PROSPECTIVE_OUTCOME_BINDING_SCHEMA,
    assignmentId: input.outcome.assignmentId,
    openingEstimateRoot: opening.openingEstimateRoot,
    outcomeRoot: input.outcome.outcomeRoot,
    settledStateRoot: input.outcome.evidence.settledStateRoot,
    activeEngineeringSeconds: activity,
    excludedWaitSeconds: structuredClone(
      input.outcome.window.excludedWaitSeconds,
    ),
    evidenceRoots: [...new Set(evidenceRoots)].sort(compareUtf8),
    authority: {
      mode: 'prospective-outcome-observation',
      assignmentAuthority: false,
      workControlAuthority: false,
      policyAuthority: false,
      mayMutate: false,
    },
  };
  return {
    ok: true,
    binding: { ...preimage, prospectiveBindingRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function compileOutcomeReplaySample(input) {
  const verification = verifyWorkDesignOutcome(input.outcome);
  if (!verification.ok)
    return { ok: false, sample: null, diagnostics: verification.diagnostics };
  const preimage = {
    schema: 'kungfu.work-design.replay-sample/v1',
    id: input.outcome.assignmentId,
    qualifiedAt: input.qualifiedAt,
    qualificationRoot: semanticRoot({
      outcomeRoot: input.outcome.outcomeRoot,
      coverageRoot: input.outcome.coverage.coverageRoot,
      evidence: input.outcome.evidence,
    }),
    baseline: {
      ...structuredClone(input.baseline),
      outcomeRoot: input.outcome.outcomeRoot,
      coverageRoot: input.outcome.coverage.coverageRoot,
    },
    candidate: {
      ...structuredClone(input.candidate),
      outcomeRoot: input.outcome.outcomeRoot,
      coverageRoot: input.outcome.coverage.coverageRoot,
    },
    drift: structuredClone(input.drift),
  };
  return {
    ok: true,
    sample: { ...preimage, sampleRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

function shadowPhase(count) {
  if (count < MINIMUM_SHADOW_SAMPLES) return 'observation-only';
  if (count < MINIMUM_DEFAULT_PROMOTION_SAMPLES) return 'tentative-trend';
  return 'promotion-eligible';
}

export function evaluateWorkDesignShadow(input) {
  const diagnostics = [];
  requireTimestamp(input.asOf, '$.asOf', diagnostics);
  rooted(input.replayReport, 'reportRoot', '$.replayReport', diagnostics);
  requireRoot(input.activePolicyRoot, '$.activePolicyRoot', diagnostics);
  requireRoot(input.candidatePolicyRoot, '$.candidatePolicyRoot', diagnostics);
  const required = sortedUnique(
    input.requiredCohortRoots,
    '$.requiredCohortRoots',
    diagnostics,
    requireRoot,
  );
  if (!Array.isArray(input.outcomes))
    diagnostics.push(
      diagnostic('invalid-type', '$.outcomes', 'expected array'),
    );
  for (const [index, outcome] of (input.outcomes ?? []).entries())
    for (const row of verifyWorkDesignOutcome(outcome).diagnostics)
      diagnostics.push({
        ...row,
        path: `$.outcomes[${index}]${row.path.slice(1)}`,
      });
  if (diagnostics.length > 0) return { ok: false, status: null, diagnostics };
  const outcomes = input.outcomes.filter(
    (outcome) => Date.parse(outcome.asOf) <= Date.parse(input.asOf),
  );
  if (outcomes.length !== input.outcomes.length)
    return {
      ok: false,
      status: null,
      diagnostics: [
        diagnostic(
          'as-of-leakage',
          '$.outcomes',
          'one outcome was unavailable at the declared shadow cut',
        ),
      ],
    };
  const cohorts = required.map((cohortRoot) => {
    const members = outcomes.filter(
      (outcome) => outcome.cohort.cohortRoot === cohortRoot,
    );
    const qualified = members.filter((outcome) => outcome.coverage.complete);
    const unknownMetricCounts = Object.fromEntries(
      METRIC_NAMES.map((name) => [
        name,
        members.filter((outcome) => outcome.metrics[name].status === 'unknown')
          .length,
      ]),
    );
    return {
      cohortRoot,
      observedCount: members.length,
      qualifiedCount: qualified.length,
      phase: shadowPhase(qualified.length),
      unknownMetricCounts,
    };
  });
  const missing = outcomes
    .map((outcome) => outcome.cohort.cohortRoot)
    .filter((root) => !required.includes(root));
  if (missing.length > 0)
    return {
      ok: false,
      status: null,
      diagnostics: [
        diagnostic(
          'undeclared-cohort',
          '$.outcomes',
          'outcome belongs to a cohort outside the exact required set',
        ),
      ],
    };
  const blockingReasons = [];
  for (const cohort of cohorts) {
    if (cohort.qualifiedCount < MINIMUM_DEFAULT_PROMOTION_SAMPLES)
      blockingReasons.push(`cohort-below-30:${cohort.cohortRoot}`);
    if (Object.values(cohort.unknownMetricCounts).some((count) => count > 0))
      blockingReasons.push(`cohort-incomplete-evidence:${cohort.cohortRoot}`);
  }
  if (input.replayReport.defaultPromotionEligible !== true)
    blockingReasons.push('replay-not-promotion-eligible');
  blockingReasons.sort(compareUtf8);
  const overallPhase = cohorts.some(
    (cohort) => cohort.phase === 'observation-only',
  )
    ? 'observation-only'
    : cohorts.some((cohort) => cohort.phase === 'tentative-trend')
      ? 'tentative-trend'
      : 'promotion-eligible';
  const preimage = {
    schema: WORK_DESIGN_FEEDBACK_STATUS_SCHEMA,
    asOf: input.asOf,
    reportRoot: input.replayReport.reportRoot,
    activePolicyRoot: input.activePolicyRoot,
    candidatePolicyRoot: input.candidatePolicyRoot,
    cohorts,
    phase: overallPhase,
    defaultPromotionEligible:
      overallPhase === 'promotion-eligible' && blockingReasons.length === 0,
    blockingReasons,
    authority: { ...STATUS_AUTHORITY },
  };
  return {
    ok: true,
    status: { ...preimage, statusRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function buildWorkDesignActivationEnvelope(input) {
  const preimage = {
    schema: WORK_DESIGN_ACTIVATION_ENVELOPE_SCHEMA,
    id: input.id,
    version: input.version,
    activePolicyRoot: input.activePolicyRoot,
    allowedParameterPaths: [...input.allowedParameterPaths].sort(compareUtf8),
    requiredCohortRoots: [...input.requiredCohortRoots].sort(compareUtf8),
    minimumQualifiedSamples: MINIMUM_DEFAULT_PROMOTION_SAMPLES,
    minimumCanarySamples: MINIMUM_SHADOW_SAMPLES,
    maximumRegressionRateBps: input.maximumRegressionRateBps,
    authority: { ...DECISION_AUTHORITY },
  };
  return { ...preimage, envelopeRoot: semanticRoot(preimage) };
}

export function buildWorkDesignPolicyState(input) {
  const preimage = {
    schema: WORK_DESIGN_POLICY_STATE_SCHEMA,
    version: input.version ?? 1,
    activePolicyRoot: input.activePolicyRoot,
    previousPolicyRoot: input.previousPolicyRoot ?? null,
    candidatePolicyRoot: input.candidatePolicyRoot ?? null,
    phase: input.phase ?? 'stable',
    activationRoot: input.activationRoot ?? null,
    rollbackRoot: input.rollbackRoot ?? null,
  };
  return { ...preimage, stateRoot: semanticRoot(preimage) };
}

export function buildWorkDesignMonitoring(input) {
  const preimage = {
    schema: WORK_DESIGN_MONITORING_SCHEMA,
    observedAt: input.observedAt,
    policyRoot: input.policyRoot,
    qualifiedSampleCount: input.qualifiedSampleCount,
    regressionRateBps: input.regressionRateBps,
    evidenceRoots: [...input.evidenceRoots].sort(compareUtf8),
  };
  return { ...preimage, monitoringRoot: semanticRoot(preimage) };
}

function decision(input, action, status, reason) {
  const preimage = {
    schema: WORK_DESIGN_POLICY_DECISION_SCHEMA,
    observedAt: input.observedAt,
    expectedStateRoot: input.state.stateRoot,
    envelopeRoot: input.envelope.envelopeRoot,
    action,
    status,
    reason,
    fromPolicyRoot: input.state.activePolicyRoot,
    toPolicyRoot: input.candidatePolicyRoot ?? input.state.previousPolicyRoot,
    evidenceRoots: [...(input.evidenceRoots ?? [])].sort(compareUtf8),
    authority: { ...DECISION_AUTHORITY },
  };
  return { ...preimage, decisionRoot: semanticRoot(preimage) };
}

export function decideWorkDesignActivation(input) {
  const proofDiagnostics = [];
  rooted(input.state, 'stateRoot', '$.state', proofDiagnostics);
  rooted(input.envelope, 'envelopeRoot', '$.envelope', proofDiagnostics);
  rooted(
    input.promotionArtifact,
    'promotionRoot',
    '$.promotionArtifact',
    proofDiagnostics,
  );
  rooted(input.shadowStatus, 'statusRoot', '$.shadowStatus', proofDiagnostics);
  if (proofDiagnostics.length > 0)
    return decision(input, 'none', 'blocked', 'invalid-activation-proof');
  const changed = [...input.changedParameterPaths].sort(compareUtf8);
  const allowed = new Set(input.envelope.allowedParameterPaths);
  if (changed.some((path) => !allowed.has(path)))
    return decision(
      input,
      'none',
      'human-decision-required',
      'candidate-widens-preauthorized-parameter-envelope',
    );
  if (
    input.state.activePolicyRoot !== input.envelope.activePolicyRoot ||
    input.promotionArtifact.activePolicyRoot !== input.state.activePolicyRoot
  )
    return decision(input, 'none', 'blocked', 'stale-active-policy-root');
  if (
    input.promotionArtifact.eligibility?.eligible !== true ||
    input.shadowStatus.defaultPromotionEligible !== true ||
    input.shadowStatus.candidatePolicyRoot !== input.candidatePolicyRoot
  )
    return decision(input, 'none', 'blocked', 'promotion-gates-not-satisfied');
  return decision(
    input,
    'start-canary',
    'authorized',
    'within-bounded-envelope',
  );
}

export function decideWorkDesignCanary(input) {
  const monitoring = input.monitoring;
  const proofDiagnostics = [];
  rooted(input.state, 'stateRoot', '$.state', proofDiagnostics);
  rooted(input.envelope, 'envelopeRoot', '$.envelope', proofDiagnostics);
  rooted(monitoring, 'monitoringRoot', '$.monitoring', proofDiagnostics);
  if (proofDiagnostics.length > 0)
    return decision(input, 'none', 'blocked', 'invalid-monitoring-proof');
  const monitoredPolicyRoot =
    input.state.phase === 'promoted'
      ? input.state.activePolicyRoot
      : input.state.candidatePolicyRoot;
  if (monitoring.policyRoot !== monitoredPolicyRoot)
    return decision(input, 'none', 'blocked', 'stale-monitoring-policy-root');
  if (monitoring.regressionRateBps > input.envelope.maximumRegressionRateBps)
    return decision(
      { ...input, candidatePolicyRoot: input.state.previousPolicyRoot },
      'rollback',
      'authorized',
      'regression-threshold-crossed',
    );
  if (monitoring.qualifiedSampleCount < input.envelope.minimumCanarySamples)
    return decision(input, 'none', 'observe', 'canary-sample-floor-not-met');
  if (input.state.phase === 'promoted')
    return decision(
      input,
      'none',
      'observe',
      'promoted-policy-within-envelope',
    );
  return decision(
    { ...input, candidatePolicyRoot: input.state.candidatePolicyRoot },
    'promote',
    'authorized',
    'canary-qualified-within-envelope',
  );
}

export function transitionWorkDesignPolicyState(state, policyDecision) {
  const diagnostics = [];
  rooted(state, 'stateRoot', '$.state', diagnostics);
  rooted(policyDecision, 'decisionRoot', '$.decision', diagnostics);
  if (policyDecision.expectedStateRoot !== state.stateRoot)
    diagnostics.push(
      diagnostic(
        'stale-decision',
        '$.decision.expectedStateRoot',
        'policy state changed before decision application',
      ),
    );
  if (policyDecision.status !== 'authorized')
    diagnostics.push(
      diagnostic(
        'decision-not-authorized',
        '$.decision.status',
        'only an authorized native decision may transition policy state',
      ),
    );
  if (
    canonicalJson(policyDecision.authority) !==
    canonicalJson(DECISION_AUTHORITY)
  )
    diagnostics.push(
      diagnostic(
        'authority-escalation',
        '$.decision.authority',
        'policy transition cannot widen its native envelope authority',
      ),
    );
  if (diagnostics.length > 0) return { ok: false, state: null, diagnostics };
  let successor;
  if (policyDecision.action === 'start-canary') {
    if (!['stable', 'rolled-back', 'promoted'].includes(state.phase))
      return {
        ok: false,
        state: null,
        diagnostics: [
          diagnostic(
            'concurrent-promotion',
            '$.state.phase',
            'another canary is active',
          ),
        ],
      };
    successor = buildWorkDesignPolicyState({
      version: state.version + 1,
      activePolicyRoot: state.activePolicyRoot,
      previousPolicyRoot: state.activePolicyRoot,
      candidatePolicyRoot: policyDecision.toPolicyRoot,
      phase: 'canary',
      activationRoot: policyDecision.decisionRoot,
      rollbackRoot: null,
    });
  } else if (policyDecision.action === 'promote') {
    if (
      state.phase !== 'canary' ||
      policyDecision.toPolicyRoot !== state.candidatePolicyRoot
    )
      return {
        ok: false,
        state: null,
        diagnostics: [
          diagnostic(
            'invalid-promotion-state',
            '$.state',
            'promotion requires the exact active canary',
          ),
        ],
      };
    successor = buildWorkDesignPolicyState({
      version: state.version + 1,
      activePolicyRoot: state.candidatePolicyRoot,
      previousPolicyRoot: state.previousPolicyRoot,
      candidatePolicyRoot: null,
      phase: 'promoted',
      activationRoot: policyDecision.decisionRoot,
      rollbackRoot: null,
    });
  } else if (policyDecision.action === 'rollback') {
    if (
      !['canary', 'promoted'].includes(state.phase) ||
      policyDecision.toPolicyRoot !== state.previousPolicyRoot
    )
      return {
        ok: false,
        state: null,
        diagnostics: [
          diagnostic(
            'rollback-root-mismatch',
            '$.decision.toPolicyRoot',
            'rollback must restore the exact previous policy root',
          ),
        ],
      };
    successor = buildWorkDesignPolicyState({
      version: state.version + 1,
      activePolicyRoot: state.previousPolicyRoot,
      previousPolicyRoot: state.previousPolicyRoot,
      candidatePolicyRoot: null,
      phase: 'rolled-back',
      activationRoot: state.activationRoot,
      rollbackRoot: policyDecision.decisionRoot,
    });
  } else
    return {
      ok: false,
      state: null,
      diagnostics: [
        diagnostic(
          'invalid-decision-action',
          '$.decision.action',
          'decision has no state transition',
        ),
      ],
    };
  return { ok: true, state: successor, diagnostics: [] };
}

export function inspectWorkDesignFeedback(input) {
  const diagnostics = [];
  rooted(input.state, 'stateRoot', '$.state', diagnostics);
  if (input.shadowStatus)
    rooted(input.shadowStatus, 'statusRoot', '$.shadowStatus', diagnostics);
  if (input.monitoring)
    rooted(input.monitoring, 'monitoringRoot', '$.monitoring', diagnostics);
  if (diagnostics.length > 0)
    return { ok: false, inspection: null, diagnostics };
  const preimage = {
    schema: WORK_DESIGN_FEEDBACK_INSPECTION_SCHEMA,
    stateRoot: input.state.stateRoot,
    activePolicyRoot: input.state.activePolicyRoot,
    previousPolicyRoot: input.state.previousPolicyRoot,
    candidatePolicyRoot: input.state.candidatePolicyRoot,
    policyPhase: input.state.phase,
    shadowStatusRoot: input.shadowStatus?.statusRoot ?? null,
    shadowPhase: input.shadowStatus?.phase ?? null,
    cohortCoverage: input.shadowStatus?.cohorts ?? [],
    monitoringRoot: input.monitoring?.monitoringRoot ?? null,
    blockingReasons: input.shadowStatus?.blockingReasons ?? [],
    activationRoot: input.state.activationRoot,
    rollbackRoot: input.state.rollbackRoot,
    authority: { ...STATUS_AUTHORITY },
  };
  return {
    ok: true,
    inspection: { ...preimage, inspectionRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}
