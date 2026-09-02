// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { canonicalJson, semanticRoot } from '../../project-cut/index.mjs';

export const WORK_DESIGN_REQUEST_SCHEMA =
  'kungfu.work-design.advice-request/v1';
export const WORK_DESIGN_POLICY_SCHEMA = 'kungfu.work-design.policy/v1';
export const WORK_DESIGN_ADVICE_SCHEMA = 'kungfu.work-design.advice/v1';
export const WORK_DESIGN_VERIFICATION_SCHEMA =
  'kungfu.work-design.advice-verification/v1';
export const WORK_DESIGN_DISPOSITION_SCHEMA =
  'kungfu.work-design.disposition/v1';
export const WORK_DESIGN_OUTCOME_ESTIMATE_SCHEMA =
  'kungfu.work-design.outcome-informed-estimate/v1';
export const WORK_DESIGN_OPENING_ESTIMATE_SCHEMA =
  'kungfu.work-design.opening-estimate-binding/v1';
export const WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA =
  'kungfu.work-design.outcome-history-record/v1';

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const INTENT_KINDS = new Set(['objective', 'assignment-request']);
const HISTORY_STATUSES = new Set(['complete', 'incomplete']);
const CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low', 'unknown']);
const TOPOLOGIES = new Set(['none', 'single', 'dag']);
const CONTINUATION_MODES = new Set(['stop', 'continue', 'reassess']);
const ADVICE_STATUSES = new Set(['ready', 'insufficient-history']);
const DISPOSITIONS = new Set([
  'accepted',
  'adapted',
  'overridden',
  'insufficient-history',
]);
const ADVISORY_BOUNDARY = Object.freeze({
  mode: 'advisory-only',
  mayCapture: false,
  mayClaim: false,
  mayDispatch: false,
  mayExecute: false,
  mayApprove: false,
  mayMerge: false,
  mayClose: false,
  assignmentAuthority: false,
  workControlAuthority: false,
});
const HUMAN_OVERRIDE = Object.freeze({
  allowed: true,
  requiresDisposition: true,
  preservesOriginalAdvice: true,
  preservesUserIntent: true,
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
  const normalized = [...expected].sort(compareUtf8);
  if (canonicalJson(actual) !== canonicalJson(normalized)) {
    diagnostics.push(
      diagnostic('object-shape-mismatch', at, 'object keys differ'),
    );
    return false;
  }
  return true;
}

function requireText(value, at, diagnostics, pattern = null) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    (pattern !== null && !pattern.test(value))
  )
    diagnostics.push(diagnostic('invalid-value', at, 'invalid string value'));
}

function requireRoot(value, at, diagnostics, nullable = false) {
  if (nullable && value === null) return;
  requireText(value, at, diagnostics, ROOT);
}

function requireTimestamp(value, at, diagnostics) {
  requireText(value, at, diagnostics, TIMESTAMP);
  if (
    typeof value === 'string' &&
    (!TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value)))
  )
    diagnostics.push(
      diagnostic('invalid-timestamp', at, 'expected canonical UTC timestamp'),
    );
}

function requirePositiveInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 1)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected positive safe integer'),
    );
}

function requireNonNegativeInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 0)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-negative safe integer'),
    );
}

function requireEnum(value, allowed, at, diagnostics) {
  if (!allowed.has(value))
    diagnostics.push(diagnostic('invalid-value', at, 'unsupported value'));
}

function requireCanonicalTextSet(value, at, diagnostics, pattern = ID) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected array'));
    return;
  }
  value.forEach((entry, index) =>
    requireText(entry, `${at}[${index}]`, diagnostics, pattern),
  );
  const normalized = [...new Set(value)].sort(compareUtf8);
  if (canonicalJson(value) !== canonicalJson(normalized))
    diagnostics.push(
      diagnostic(
        'non-canonical-set',
        at,
        'values must be UTF-8 byte sorted and unique',
      ),
    );
}

function rootedPreimage(value, rootKey) {
  const { [rootKey]: _root, ...preimage } = value;
  return preimage;
}

function validateRooted(value, rootKey, at, diagnostics) {
  if (!isObject(value) || !ROOT.test(value[rootKey] ?? '')) return;
  if (semanticRoot(rootedPreimage(value, rootKey)) !== value[rootKey])
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        `${at}.${rootKey}`,
        'root differs from canonical semantic preimage',
      ),
    );
}

function validateAdvisoryBoundary(value, at, diagnostics) {
  if (!exactKeys(value, Object.keys(ADVISORY_BOUNDARY), at, diagnostics))
    return;
  if (canonicalJson(value) !== canonicalJson(ADVISORY_BOUNDARY))
    diagnostics.push(
      diagnostic(
        'authority-escalation',
        at,
        'advice cannot acquire Assignment or execution authority',
      ),
    );
}

function validateHumanOverride(value, at, diagnostics) {
  if (!exactKeys(value, Object.keys(HUMAN_OVERRIDE), at, diagnostics)) return;
  if (canonicalJson(value) !== canonicalJson(HUMAN_OVERRIDE))
    diagnostics.push(
      diagnostic(
        'human-override-disabled',
        at,
        'advice must preserve explicit human disposition and intent',
      ),
    );
}

function validatePolicy(value, at, diagnostics) {
  if (
    !exactKeys(
      value,
      [
        'schema',
        'id',
        'version',
        'maxSlices',
        'maxTotalBudgetHours',
        'maxSliceBudgetHours',
        'allowedDeliveryClasses',
        'requiredEvidenceKinds',
        'policyRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (value.schema !== WORK_DESIGN_POLICY_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', `${at}.schema`, 'unsupported policy'),
    );
  requireText(value.id, `${at}.id`, diagnostics, ID);
  requirePositiveInteger(value.version, `${at}.version`, diagnostics);
  requirePositiveInteger(value.maxSlices, `${at}.maxSlices`, diagnostics);
  requirePositiveInteger(
    value.maxTotalBudgetHours,
    `${at}.maxTotalBudgetHours`,
    diagnostics,
  );
  requirePositiveInteger(
    value.maxSliceBudgetHours,
    `${at}.maxSliceBudgetHours`,
    diagnostics,
  );
  requireCanonicalTextSet(
    value.allowedDeliveryClasses,
    `${at}.allowedDeliveryClasses`,
    diagnostics,
  );
  requireCanonicalTextSet(
    value.requiredEvidenceKinds,
    `${at}.requiredEvidenceKinds`,
    diagnostics,
  );
  if (value.allowedDeliveryClasses?.length === 0)
    diagnostics.push(
      diagnostic(
        'empty-delivery-policy',
        `${at}.allowedDeliveryClasses`,
        'at least one delivery class is required',
      ),
    );
  if (value.requiredEvidenceKinds?.length === 0)
    diagnostics.push(
      diagnostic(
        'unverifiable-evidence-policy',
        `${at}.requiredEvidenceKinds`,
        'at least one evidence kind is required',
      ),
    );
  requireRoot(value.policyRoot, `${at}.policyRoot`, diagnostics);
  validateRooted(value, 'policyRoot', at, diagnostics);
}

function validateCoverageEntries(value, at, diagnostics, kind) {
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('invalid-type', at, 'expected array'));
    return;
  }
  for (const [index, entry] of value.entries()) {
    const entryAt = `${at}[${index}]`;
    const keys =
      kind === 'acceptance'
        ? ['id', 'criterionRoot']
        : ['id', 'kind', 'requirementRoot'];
    if (!exactKeys(entry, keys, entryAt, diagnostics)) continue;
    requireText(entry.id, `${entryAt}.id`, diagnostics, ID);
    if (kind === 'acceptance')
      requireRoot(entry.criterionRoot, `${entryAt}.criterionRoot`, diagnostics);
    else {
      requireText(entry.kind, `${entryAt}.kind`, diagnostics, ID);
      requireRoot(
        entry.requirementRoot,
        `${entryAt}.requirementRoot`,
        diagnostics,
      );
    }
  }
  const sorted = [...value].sort((left, right) =>
    compareUtf8(left?.id ?? '', right?.id ?? ''),
  );
  if (
    canonicalJson(value) !== canonicalJson(sorted) ||
    new Set(value.map((entry) => entry?.id)).size !== value.length
  )
    diagnostics.push(
      diagnostic(
        'non-canonical-set',
        at,
        'entries must be id-sorted and unique',
      ),
    );
}

function validateSlice(slice, at, policy, diagnostics) {
  if (
    !exactKeys(
      slice,
      [
        'id',
        'objectiveRoot',
        'dependsOn',
        'budgetHours',
        'deliveryClass',
        'acceptance',
        'requiredEvidence',
        'continuation',
      ],
      at,
      diagnostics,
    )
  )
    return;
  requireText(slice.id, `${at}.id`, diagnostics, ID);
  requireRoot(slice.objectiveRoot, `${at}.objectiveRoot`, diagnostics);
  requireCanonicalTextSet(slice.dependsOn, `${at}.dependsOn`, diagnostics);
  requirePositiveInteger(slice.budgetHours, `${at}.budgetHours`, diagnostics);
  requireText(slice.deliveryClass, `${at}.deliveryClass`, diagnostics, ID);
  if (
    isObject(policy) &&
    Array.isArray(policy.allowedDeliveryClasses) &&
    !policy.allowedDeliveryClasses.includes(slice.deliveryClass)
  )
    diagnostics.push(
      diagnostic(
        'delivery-class-denied',
        `${at}.deliveryClass`,
        'delivery class is absent from policy',
      ),
    );
  if (
    Number.isSafeInteger(slice.budgetHours) &&
    Number.isSafeInteger(policy?.maxSliceBudgetHours) &&
    slice.budgetHours > policy.maxSliceBudgetHours
  )
    diagnostics.push(
      diagnostic(
        'unbounded-slice',
        `${at}.budgetHours`,
        'slice budget exceeds policy bound',
      ),
    );
  validateCoverageEntries(
    slice.acceptance,
    `${at}.acceptance`,
    diagnostics,
    'acceptance',
  );
  if (Array.isArray(slice.acceptance) && slice.acceptance.length === 0)
    diagnostics.push(
      diagnostic(
        'acceptance-coverage-missing',
        `${at}.acceptance`,
        'every slice requires acceptance coverage',
      ),
    );
  validateCoverageEntries(
    slice.requiredEvidence,
    `${at}.requiredEvidence`,
    diagnostics,
    'evidence',
  );
  const evidenceKinds = new Set(
    Array.isArray(slice.requiredEvidence)
      ? slice.requiredEvidence.map((entry) => entry?.kind)
      : [],
  );
  for (const evidenceKind of policy?.requiredEvidenceKinds ?? []) {
    if (!evidenceKinds.has(evidenceKind))
      diagnostics.push(
        diagnostic(
          'evidence-coverage-missing',
          `${at}.requiredEvidence`,
          `required evidence kind is missing: ${evidenceKind}`,
        ),
      );
  }
  if (
    exactKeys(
      slice.continuation,
      ['mode', 'conditionRoots'],
      `${at}.continuation`,
      diagnostics,
    )
  ) {
    requireEnum(
      slice.continuation.mode,
      CONTINUATION_MODES,
      `${at}.continuation.mode`,
      diagnostics,
    );
    requireCanonicalTextSet(
      slice.continuation.conditionRoots,
      `${at}.continuation.conditionRoots`,
      diagnostics,
      ROOT,
    );
  }
  if (slice.dependsOn?.includes(slice.id))
    diagnostics.push(
      diagnostic(
        'dependency-cycle',
        `${at}.dependsOn`,
        'slice cannot depend on itself',
      ),
    );
}

function topologyDiagnostics(
  topology,
  slices,
  policy,
  at = '$.proposal',
  allowNone = false,
) {
  const diagnostics = [];
  requireEnum(topology, TOPOLOGIES, `${at}.topology`, diagnostics);
  if (!Array.isArray(slices)) {
    diagnostics.push(
      diagnostic('invalid-type', `${at}.slices`, 'expected array'),
    );
    return diagnostics;
  }
  slices.forEach((slice, index) =>
    validateSlice(slice, `${at}.slices[${index}]`, policy, diagnostics),
  );
  const ids = slices.map((slice) => slice?.id);
  if (
    new Set(ids).size !== ids.length ||
    canonicalJson(ids) !== canonicalJson([...ids].sort(compareUtf8))
  )
    diagnostics.push(
      diagnostic(
        'non-canonical-slices',
        `${at}.slices`,
        'slices must be id-sorted and unique',
      ),
    );
  if (topology === 'none' && (!allowNone || slices.length !== 0))
    diagnostics.push(
      diagnostic(
        'topology-shape-mismatch',
        `${at}.slices`,
        'none topology is reserved for insufficient history and has no slices',
      ),
    );
  if (topology === 'single' && slices.length !== 1)
    diagnostics.push(
      diagnostic(
        'topology-shape-mismatch',
        `${at}.slices`,
        'single topology requires exactly one slice',
      ),
    );
  if (topology === 'dag' && slices.length === 0)
    diagnostics.push(
      diagnostic(
        'topology-shape-mismatch',
        `${at}.slices`,
        'dag topology requires at least one slice',
      ),
    );
  if (
    Number.isSafeInteger(policy?.maxSlices) &&
    slices.length > policy.maxSlices
  )
    diagnostics.push(
      diagnostic(
        'unbounded-topology',
        `${at}.slices`,
        'slice count exceeds policy bound',
      ),
    );
  const totalBudget = slices.reduce(
    (sum, slice) =>
      sum + (Number.isSafeInteger(slice?.budgetHours) ? slice.budgetHours : 0),
    0,
  );
  if (
    Number.isSafeInteger(policy?.maxTotalBudgetHours) &&
    totalBudget > policy.maxTotalBudgetHours
  )
    diagnostics.push(
      diagnostic(
        'unbounded-total-budget',
        `${at}.slices`,
        'total budget exceeds policy bound',
      ),
    );

  const byId = new Map(slices.map((slice) => [slice?.id, slice]));
  for (const [index, slice] of slices.entries()) {
    for (const dependency of slice?.dependsOn ?? []) {
      if (!byId.has(dependency))
        diagnostics.push(
          diagnostic(
            'dependency-not-found',
            `${at}.slices[${index}].dependsOn`,
            `dependency is not present: ${dependency}`,
          ),
        );
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id) || !byId.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if (ids.some((id) => visit(id)))
    diagnostics.push(
      diagnostic(
        'dependency-cycle',
        `${at}.slices`,
        'dependency graph contains a cycle',
      ),
    );
  return diagnostics;
}

function validateInputBinding(input, at, diagnostics) {
  if (
    !exactKeys(
      input,
      ['intent', 'history', 'xinfaRoot', 'asOf', 'policy'],
      at,
      diagnostics,
    )
  )
    return;
  if (exactKeys(input.intent, ['kind', 'root'], `${at}.intent`, diagnostics)) {
    requireEnum(
      input.intent.kind,
      INTENT_KINDS,
      `${at}.intent.kind`,
      diagnostics,
    );
    requireRoot(input.intent.root, `${at}.intent.root`, diagnostics);
  }
  if (
    exactKeys(
      input.history,
      [
        'selectionRoot',
        'verificationRoot',
        'status',
        'selectedCount',
        'confidence',
        'gapIds',
      ],
      `${at}.history`,
      diagnostics,
    )
  ) {
    requireRoot(
      input.history.selectionRoot,
      `${at}.history.selectionRoot`,
      diagnostics,
    );
    requireRoot(
      input.history.verificationRoot,
      `${at}.history.verificationRoot`,
      diagnostics,
    );
    requireEnum(
      input.history.status,
      HISTORY_STATUSES,
      `${at}.history.status`,
      diagnostics,
    );
    requireNonNegativeInteger(
      input.history.selectedCount,
      `${at}.history.selectedCount`,
      diagnostics,
    );
    requireEnum(
      input.history.confidence,
      CONFIDENCE_LEVELS,
      `${at}.history.confidence`,
      diagnostics,
    );
    requireCanonicalTextSet(
      input.history.gapIds,
      `${at}.history.gapIds`,
      diagnostics,
    );
  }
  requireRoot(input.xinfaRoot, `${at}.xinfaRoot`, diagnostics);
  requireTimestamp(input.asOf, `${at}.asOf`, diagnostics);
  validatePolicy(input.policy, `${at}.policy`, diagnostics);
}

function validateRequest(request) {
  const diagnostics = [];
  if (
    !exactKeys(
      request,
      [
        'schema',
        'intent',
        'history',
        'xinfaRoot',
        'asOf',
        'policy',
        'proposal',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (request.schema !== WORK_DESIGN_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported request schema'),
    );
  validateInputBinding(
    {
      intent: request.intent,
      history: request.history,
      xinfaRoot: request.xinfaRoot,
      asOf: request.asOf,
      policy: request.policy,
    },
    '$',
    diagnostics,
  );
  if (
    exactKeys(
      request.proposal,
      [
        'authority',
        'topology',
        'slices',
        'confidence',
        'gapIds',
        'humanOverride',
      ],
      '$.proposal',
      diagnostics,
    )
  ) {
    validateAdvisoryBoundary(
      request.proposal.authority,
      '$.proposal.authority',
      diagnostics,
    );
    requireEnum(
      request.proposal.confidence,
      CONFIDENCE_LEVELS,
      '$.proposal.confidence',
      diagnostics,
    );
    requireCanonicalTextSet(
      request.proposal.gapIds,
      '$.proposal.gapIds',
      diagnostics,
    );
    validateHumanOverride(
      request.proposal.humanOverride,
      '$.proposal.humanOverride',
      diagnostics,
    );
    const insufficientHistory =
      request.history?.status !== 'complete' ||
      request.history?.selectedCount === 0;
    diagnostics.push(
      ...topologyDiagnostics(
        request.proposal.topology,
        request.proposal.slices,
        request.policy,
        '$.proposal',
        insufficientHistory,
      ),
    );
    if (
      insufficientHistory &&
      (request.proposal.topology !== 'none' ||
        request.proposal.slices?.length !== 0)
    )
      diagnostics.push(
        diagnostic(
          'insufficient-history-proposal',
          '$.proposal',
          'insufficient history must not carry speculative work slices',
        ),
      );
  }
  return diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
}

function inputBindingFromRequest(request) {
  return {
    intent: request.intent,
    history: request.history,
    xinfaRoot: request.xinfaRoot,
    asOf: request.asOf,
    policy: request.policy,
  };
}

function adviceDiagnostics(advice, expectedInput = null) {
  const diagnostics = [];
  if (
    !exactKeys(
      advice,
      [
        'schema',
        'authority',
        'input',
        'inputRoot',
        'design',
        'confidence',
        'gapIds',
        'humanOverride',
        'status',
        'adviceRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (advice.schema !== WORK_DESIGN_ADVICE_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported advice schema'),
    );
  validateAdvisoryBoundary(advice.authority, '$.authority', diagnostics);
  validateInputBinding(advice.input, '$.input', diagnostics);
  requireRoot(advice.inputRoot, '$.inputRoot', diagnostics);
  if (
    isObject(advice.input) &&
    ROOT.test(advice.inputRoot ?? '') &&
    semanticRoot(advice.input) !== advice.inputRoot
  )
    diagnostics.push(
      diagnostic(
        'input-root-mismatch',
        '$.inputRoot',
        'input root differs from exact input binding',
      ),
    );
  if (
    expectedInput !== null &&
    canonicalJson(advice.input) !== canonicalJson(expectedInput)
  )
    diagnostics.push(
      diagnostic(
        'exact-input-binding-mismatch',
        '$.input',
        'advice input differs from expected objective/history/Xinfa/policy/as_of',
      ),
    );
  if (
    exactKeys(advice.design, ['topology', 'slices'], '$.design', diagnostics)
  ) {
    if (advice.status === 'insufficient-history') {
      if (
        advice.design.topology !== 'none' ||
        !Array.isArray(advice.design.slices) ||
        advice.design.slices.length !== 0
      )
        diagnostics.push(
          diagnostic(
            'insufficient-history-topology',
            '$.design',
            'insufficient history must not emit executable-looking slices',
          ),
        );
    } else {
      diagnostics.push(
        ...topologyDiagnostics(
          advice.design.topology,
          advice.design.slices,
          advice.input?.policy,
          '$.design',
        ),
      );
    }
  }
  requireEnum(
    advice.confidence,
    CONFIDENCE_LEVELS,
    '$.confidence',
    diagnostics,
  );
  requireCanonicalTextSet(advice.gapIds, '$.gapIds', diagnostics);
  validateHumanOverride(advice.humanOverride, '$.humanOverride', diagnostics);
  requireEnum(advice.status, ADVICE_STATUSES, '$.status', diagnostics);
  const historyInsufficient =
    advice.input?.history?.status !== 'complete' ||
    advice.input?.history?.selectedCount === 0;
  if (
    (historyInsufficient && advice.status !== 'insufficient-history') ||
    (!historyInsufficient && advice.status !== 'ready')
  )
    diagnostics.push(
      diagnostic(
        'history-status-mismatch',
        '$.status',
        'advice status differs from verified history availability',
      ),
    );
  requireRoot(advice.adviceRoot, '$.adviceRoot', diagnostics);
  validateRooted(advice, 'adviceRoot', '$', diagnostics);
  return diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
}

export function buildWorkDesignPolicy(input) {
  const preimage = {
    schema: WORK_DESIGN_POLICY_SCHEMA,
    id: input.id,
    version: input.version,
    maxSlices: input.maxSlices,
    maxTotalBudgetHours: input.maxTotalBudgetHours,
    maxSliceBudgetHours: input.maxSliceBudgetHours,
    allowedDeliveryClasses: [...new Set(input.allowedDeliveryClasses)].sort(
      compareUtf8,
    ),
    requiredEvidenceKinds: [...new Set(input.requiredEvidenceKinds)].sort(
      compareUtf8,
    ),
  };
  return { ...preimage, policyRoot: semanticRoot(preimage) };
}

export function buildWorkDesignAdvice(request) {
  const diagnostics = validateRequest(request);
  if (diagnostics.length > 0)
    return {
      ok: false,
      action: 'work-design-advise',
      advice: null,
      diagnostics,
    };
  const input = inputBindingFromRequest(request);
  const insufficientHistory =
    request.history.status !== 'complete' ||
    request.history.selectedCount === 0;
  const gapIds = [
    ...new Set([
      ...request.history.gapIds,
      ...request.proposal.gapIds,
      ...(insufficientHistory ? ['insufficient-history'] : []),
    ]),
  ].sort(compareUtf8);
  const preimage = {
    schema: WORK_DESIGN_ADVICE_SCHEMA,
    authority: { ...ADVISORY_BOUNDARY },
    input,
    inputRoot: semanticRoot(input),
    design: insufficientHistory
      ? { topology: 'none', slices: [] }
      : {
          topology: request.proposal.topology,
          slices: request.proposal.slices,
        },
    confidence: insufficientHistory
      ? request.history.confidence
      : request.proposal.confidence,
    gapIds,
    humanOverride: { ...HUMAN_OVERRIDE },
    status: insufficientHistory ? 'insufficient-history' : 'ready',
  };
  const advice = { ...preimage, adviceRoot: semanticRoot(preimage) };
  return {
    ok: true,
    action: 'work-design-advise',
    advice,
    diagnostics: [],
  };
}

export function verifyWorkDesignAdvice(advice, expectedInput = null) {
  const diagnostics = adviceDiagnostics(advice, expectedInput);
  const codes = new Set(diagnostics.map((entry) => entry.code));
  const checks = {
    schemaValid: ![
      'invalid-type',
      'invalid-value',
      'unknown-version',
      'object-shape-mismatch',
      'non-canonical-set',
      'root-mismatch',
      'input-root-mismatch',
    ].some((code) => codes.has(code)),
    exactInputBinding: !codes.has('exact-input-binding-mismatch'),
    bounded:
      !codes.has('unbounded-slice') &&
      !codes.has('unbounded-topology') &&
      !codes.has('unbounded-total-budget'),
    dependencyClosure:
      !codes.has('dependency-not-found') && !codes.has('dependency-cycle'),
    acceptanceCoverage: !codes.has('acceptance-coverage-missing'),
    evidenceCoverage:
      !codes.has('evidence-coverage-missing') &&
      !codes.has('unverifiable-evidence-policy'),
    authoritySafe:
      !codes.has('authority-escalation') &&
      !codes.has('human-override-disabled'),
  };
  const preimage = {
    schema: WORK_DESIGN_VERIFICATION_SCHEMA,
    adviceRoot: advice?.adviceRoot ?? null,
    inputRoot: advice?.inputRoot ?? null,
    checks,
    diagnostics,
    ok: diagnostics.length === 0,
  };
  return { ...preimage, verificationRoot: semanticRoot(preimage) };
}

export function buildWorkDesignDisposition(input) {
  const diagnostics = [];
  requireRoot(input.adviceRoot, '$.adviceRoot', diagnostics);
  requireRoot(input.intentRoot, '$.intentRoot', diagnostics);
  requireEnum(input.action, DISPOSITIONS, '$.action', diagnostics);
  requireRoot(input.rationaleRoot, '$.rationaleRoot', diagnostics);
  requireRoot(
    input.resultingAdviceRoot,
    '$.resultingAdviceRoot',
    diagnostics,
    input.action === 'insufficient-history',
  );
  if (
    input.action === 'accepted' &&
    input.resultingAdviceRoot !== input.adviceRoot
  )
    diagnostics.push(
      diagnostic(
        'accepted-root-mismatch',
        '$.resultingAdviceRoot',
        'accepted disposition must preserve the original advice root',
      ),
    );
  if (
    ['adapted', 'overridden'].includes(input.action) &&
    input.resultingAdviceRoot === input.adviceRoot
  )
    diagnostics.push(
      diagnostic(
        'changed-root-required',
        '$.resultingAdviceRoot',
        'adapted or overridden disposition requires a distinct resulting root',
      ),
    );
  if (
    input.action === 'insufficient-history' &&
    input.resultingAdviceRoot !== null
  )
    diagnostics.push(
      diagnostic(
        'insufficient-history-result',
        '$.resultingAdviceRoot',
        'insufficient-history disposition cannot name a resulting advice',
      ),
    );
  if (diagnostics.length > 0)
    return { ok: false, disposition: null, diagnostics };
  const preimage = {
    schema: WORK_DESIGN_DISPOSITION_SCHEMA,
    adviceRoot: input.adviceRoot,
    intentRoot: input.intentRoot,
    action: input.action,
    rationaleRoot: input.rationaleRoot,
    resultingAdviceRoot: input.resultingAdviceRoot,
    authority: {
      mode: 'human-disposition-record',
      assignmentAuthority: false,
      workControlAuthority: false,
      mutatesOriginalAdvice: false,
      mutatesUserIntent: false,
    },
  };
  return {
    ok: true,
    disposition: {
      ...preimage,
      dispositionRoot: semanticRoot(preimage),
    },
    diagnostics: [],
  };
}

export function verifyWorkDesignDisposition(disposition) {
  const diagnostics = [];
  if (
    !exactKeys(
      disposition,
      [
        'schema',
        'adviceRoot',
        'intentRoot',
        'action',
        'rationaleRoot',
        'resultingAdviceRoot',
        'authority',
        'dispositionRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, diagnostics };
  if (disposition.schema !== WORK_DESIGN_DISPOSITION_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported disposition schema',
      ),
    );
  const rebuilt = buildWorkDesignDisposition(disposition);
  diagnostics.push(...rebuilt.diagnostics);
  if (
    rebuilt.ok &&
    rebuilt.disposition.dispositionRoot !== disposition.dispositionRoot
  )
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        '$.dispositionRoot',
        'disposition root differs from canonical preimage',
      ),
    );
  return { ok: diagnostics.length === 0, diagnostics };
}

function validateOutcomeHistoryRecord(record, at, diagnostics) {
  if (
    !exactKeys(
      record,
      [
        'schema',
        'assignmentSubject',
        'workspaceIdentityRoot',
        'settledStateRoot',
        'bindingRoot',
        'outcomeRoot',
        'coverageRoot',
        'cohortRoot',
        'outcomeAsOf',
        'coverageComplete',
        'attributableActiveSeconds',
        'excludedWaitSeconds',
        'rework',
        'sourceEvidenceRoots',
        'recordRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (record.schema !== WORK_DESIGN_OUTCOME_HISTORY_RECORD_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        `${at}.schema`,
        'unsupported outcome record',
      ),
    );
  requireText(
    record.assignmentSubject,
    `${at}.assignmentSubject`,
    diagnostics,
    ID,
  );
  for (const field of [
    'workspaceIdentityRoot',
    'settledStateRoot',
    'bindingRoot',
    'outcomeRoot',
    'coverageRoot',
    'cohortRoot',
    'recordRoot',
  ])
    requireRoot(record[field], `${at}.${field}`, diagnostics);
  requireTimestamp(record.outcomeAsOf, `${at}.outcomeAsOf`, diagnostics);
  if (typeof record.coverageComplete !== 'boolean')
    diagnostics.push(
      diagnostic(
        'invalid-type',
        `${at}.coverageComplete`,
        'expected boolean coverage state',
      ),
    );
  requireNonNegativeInteger(
    record.attributableActiveSeconds,
    `${at}.attributableActiveSeconds`,
    diagnostics,
  );
  if (
    exactKeys(
      record.excludedWaitSeconds,
      ['ci-queue', 'external-review', 'human-decision', 'platform-approval'],
      `${at}.excludedWaitSeconds`,
      diagnostics,
    )
  )
    for (const name of [
      'ci-queue',
      'external-review',
      'human-decision',
      'platform-approval',
    ])
      requireNonNegativeInteger(
        record.excludedWaitSeconds[name],
        `${at}.excludedWaitSeconds.${name}`,
        diagnostics,
      );
  if (
    exactKeys(record.rework, ['status', 'count'], `${at}.rework`, diagnostics)
  ) {
    requireEnum(
      record.rework.status,
      new Set(['qualified', 'unknown']),
      `${at}.rework.status`,
      diagnostics,
    );
    if (record.rework.count !== null)
      requireNonNegativeInteger(
        record.rework.count,
        `${at}.rework.count`,
        diagnostics,
      );
    if (record.rework.status === 'qualified' && record.rework.count === null)
      diagnostics.push(
        diagnostic(
          'incomplete-rework-signal',
          `${at}.rework.count`,
          'qualified rework requires a count',
        ),
      );
  }
  requireCanonicalTextSet(
    record.sourceEvidenceRoots,
    `${at}.sourceEvidenceRoots`,
    diagnostics,
    ROOT,
  );
  validateRooted(record, 'recordRoot', at, diagnostics);
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil((values.length * percentile) / 100) - 1)];
}

export function buildOutcomeInformedEstimate(input) {
  const diagnostics = [];
  if (
    !exactKeys(
      input,
      [
        'asOf',
        'sourceRoot',
        'queryProofRoot',
        'globalWorkProjectionRoot',
        'targetCohortRoot',
        'selectedStateRoots',
        'records',
        'coverage',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, estimate: null, diagnostics };
  requireTimestamp(input.asOf, '$.asOf', diagnostics);
  for (const field of [
    'sourceRoot',
    'queryProofRoot',
    'globalWorkProjectionRoot',
    'targetCohortRoot',
  ])
    requireRoot(input[field], `$.${field}`, diagnostics);
  requireCanonicalTextSet(
    input.selectedStateRoots,
    '$.selectedStateRoots',
    diagnostics,
    ROOT,
  );
  if (!Array.isArray(input.records))
    diagnostics.push(diagnostic('invalid-type', '$.records', 'expected array'));
  for (const [index, record] of (input.records ?? []).entries())
    validateOutcomeHistoryRecord(record, `$.records[${index}]`, diagnostics);
  if (
    exactKeys(
      input.coverage,
      [
        'uniqueSettledStateCount',
        'uniqueAssignmentCount',
        'complete',
        'partial',
        'sealedOnlyUnknown',
        'unqualifiedStateCount',
      ],
      '$.coverage',
      diagnostics,
    )
  )
    for (const field of Object.keys(input.coverage))
      requireNonNegativeInteger(
        input.coverage[field],
        `$.coverage.${field}`,
        diagnostics,
      );
  const roots = new Set();
  for (const record of input.records ?? []) {
    if (roots.has(record.settledStateRoot))
      diagnostics.push(
        diagnostic(
          'duplicate-settled-state',
          '$.records',
          'outcome records must be deduplicated by settled state root',
        ),
      );
    roots.add(record.settledStateRoot);
    if (Date.parse(record.outcomeAsOf) > Date.parse(input.asOf))
      diagnostics.push(
        diagnostic(
          'as-of-leakage',
          '$.records',
          'an outcome was unavailable at the declared estimate cut',
        ),
      );
  }
  if (diagnostics.length > 0)
    return {
      ok: false,
      estimate: null,
      diagnostics: diagnostics.sort(
        (left, right) =>
          compareUtf8(left.path, right.path) ||
          compareUtf8(left.code, right.code),
      ),
    };

  const selected = new Set(input.selectedStateRoots);
  const comparable = input.records.filter(
    (record) =>
      selected.has(record.settledStateRoot) &&
      record.cohortRoot === input.targetCohortRoot &&
      record.coverageComplete === true &&
      record.rework.status === 'qualified',
  );
  const active = comparable
    .map((record) => record.attributableActiveSeconds)
    .sort((left, right) => left - right);
  const p50 = nearestRank(active, 50);
  const p80 = nearestRank(active, 80);
  const waitClasses = [
    'ci-queue',
    'external-review',
    'human-decision',
    'platform-approval',
  ];
  const excludedWaitTotals = Object.fromEntries(
    waitClasses.map((name) => [
      name,
      comparable.reduce(
        (total, record) => total + record.excludedWaitSeconds[name],
        0,
      ),
    ]),
  );
  const count = comparable.length;
  const phase =
    count < 10
      ? 'observation-only'
      : count < 30
        ? 'tentative-trend'
        : 'replay-gated';
  const fallbackReason =
    count === 0
      ? 'no-qualified-comparable-outcomes'
      : count < 10
        ? 'fewer-than-10-qualified-comparable-outcomes'
        : count < 30
          ? 'default-promotion-below-30'
          : 'existing-replay-gates-required';
  const preimage = {
    schema: WORK_DESIGN_OUTCOME_ESTIMATE_SCHEMA,
    asOf: input.asOf,
    source: {
      sourceRoot: input.sourceRoot,
      queryProofRoot: input.queryProofRoot,
      globalWorkProjectionRoot: input.globalWorkProjectionRoot,
    },
    comparability: {
      targetCohortRoot: input.targetCohortRoot,
      exactCohortRequired: true,
      selectedStateCount: input.selectedStateRoots.length,
      qualifiedSampleCount: count,
      criteria: [
        'complete-rooted-outcome',
        'exact-cohort-root',
        'selected-settled-state',
        'verified-as-of',
      ],
    },
    coverage: { ...input.coverage, qualifiedComparableCount: count },
    attributableActiveSeconds: {
      p50,
      p80,
      minimum: active.at(0) ?? null,
      maximum: active.at(-1) ?? null,
    },
    excludedWaitTotals,
    rework: {
      totalCount: comparable.reduce(
        (total, record) => total + record.rework.count,
        0,
      ),
      outcomesWithRework: comparable.filter((record) => record.rework.count > 0)
        .length,
    },
    evidence: {
      settledStateRoots: comparable
        .map((record) => record.settledStateRoot)
        .sort(compareUtf8),
      bindingRoots: comparable
        .map((record) => record.bindingRoot)
        .sort(compareUtf8),
      outcomeRoots: comparable
        .map((record) => record.outcomeRoot)
        .sort(compareUtf8),
      coverageRoots: comparable
        .map((record) => record.coverageRoot)
        .sort(compareUtf8),
      sourceEvidenceRoots: [
        ...new Set(comparable.flatMap((record) => record.sourceEvidenceRoots)),
      ].sort(compareUtf8),
    },
    guidance: {
      phase,
      recommendedBudgetSeconds: count >= 10 ? p80 : null,
      existingConservativeBudgetPreserved: count < 10,
      defaultPolicyInfluence: false,
      requiresExistingReplayGates: count >= 30,
      fallbackReason,
    },
    confidence:
      count >= 30
        ? 'high'
        : count >= 10
          ? 'medium'
          : count > 0
            ? 'low'
            : 'unknown',
    authority: {
      mode: 'advisory-estimate-only',
      workAuthority: false,
      policyAuthority: false,
      defaultActivation: false,
      mayMutate: false,
    },
  };
  return {
    ok: true,
    estimate: { ...preimage, estimateRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function verifyOutcomeInformedEstimate(estimate) {
  if (
    !isObject(estimate) ||
    estimate.schema !== WORK_DESIGN_OUTCOME_ESTIMATE_SCHEMA
  )
    return {
      ok: false,
      diagnostics: [
        diagnostic('unknown-version', '$.schema', 'unsupported estimate'),
      ],
    };
  const { estimateRoot, ...preimage } = estimate;
  const ok =
    ROOT.test(String(estimateRoot ?? '')) &&
    semanticRoot(preimage) === estimateRoot;
  return {
    ok,
    diagnostics: ok
      ? []
      : [
          diagnostic(
            'root-mismatch',
            '$.estimateRoot',
            'estimate root differs from canonical preimage',
          ),
        ],
  };
}

export function buildOpeningEstimateBinding(input) {
  const verification = verifyOutcomeInformedEstimate(input.estimate);
  if (!verification.ok)
    return { ok: false, binding: null, diagnostics: verification.diagnostics };
  const diagnostics = [];
  requireText(input.assignmentId, '$.assignmentId', diagnostics, ID);
  requireRoot(input.workDefinitionRoot, '$.workDefinitionRoot', diagnostics);
  requireRoot(input.adviceRoot, '$.adviceRoot', diagnostics);
  requireTimestamp(input.asOf, '$.asOf', diagnostics);
  if (diagnostics.length > 0) return { ok: false, binding: null, diagnostics };
  const preimage = {
    schema: WORK_DESIGN_OPENING_ESTIMATE_SCHEMA,
    assignmentId: input.assignmentId,
    asOf: input.asOf,
    workDefinitionRoot: input.workDefinitionRoot,
    adviceRoot: input.adviceRoot,
    estimateRoot: input.estimate.estimateRoot,
    targetCohortRoot: input.estimate.comparability.targetCohortRoot,
    guidance: structuredClone(input.estimate.guidance),
    authority: {
      mode: 'opening-observation-only',
      assignmentAuthority: false,
      finalWorkDefinitionAuthority: false,
      mayMutate: false,
    },
  };
  return {
    ok: true,
    binding: { ...preimage, openingEstimateRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function workDesignAdvisoryBoundary() {
  return {
    authority: { ...ADVISORY_BOUNDARY },
    humanOverride: { ...HUMAN_OVERRIDE },
  };
}
