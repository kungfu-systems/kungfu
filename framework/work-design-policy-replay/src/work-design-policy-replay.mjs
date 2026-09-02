// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { canonicalJson, semanticRoot } from '../../project-cut/index.mjs';

export const WORK_DESIGN_REPLAY_POLICY_SCHEMA =
  'kungfu.work-design.replay-policy/v1';
export const WORK_DESIGN_REPLAY_SAMPLE_SCHEMA =
  'kungfu.work-design.replay-sample/v1';
export const WORK_DESIGN_REPLAY_COHORT_SCHEMA =
  'kungfu.work-design.replay-cohort/v1';
export const WORK_DESIGN_REPLAY_REQUEST_SCHEMA =
  'kungfu.work-design.replay-request/v1';
export const WORK_DESIGN_REPLAY_REPORT_SCHEMA =
  'kungfu.work-design.replay-report/v1';
export const WORK_DESIGN_PROMOTION_ARTIFACT_SCHEMA =
  'kungfu.work-design.promotion-artifact/v1';

export const MINIMUM_DEFAULT_PROMOTION_SAMPLES = 30;

const ROOT = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;
const DRIFT_CLASSIFICATIONS = new Set([
  'expected',
  'improvement',
  'none',
  'regression',
  'unclassified',
]);
const DIMENSIONS = [
  ['selection', 'selectionRoot'],
  ['advice', 'adviceRoot'],
  ['disposition', 'dispositionRoot'],
  ['outcome', 'outcomeRoot'],
  ['coverage', 'coverageRoot'],
];
const NON_AUTHORITY = Object.freeze({
  mode: 'offline-advisory',
  assignmentAuthority: false,
  workControlAuthority: false,
  repositoryAuthority: false,
  protectedBranchAuthority: false,
  activeDefaultPolicyAuthority: false,
  mayMutate: false,
});
const ACTIVATION_MODE = 'separately-authorized-native-decision-required';

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

function requireRoot(value, at, diagnostics) {
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

function requireNonNegativeInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 0)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected non-negative safe integer'),
    );
}

function requirePositiveInteger(value, at, diagnostics) {
  if (!Number.isSafeInteger(value) || value < 1)
    diagnostics.push(
      diagnostic('invalid-value', at, 'expected positive safe integer'),
    );
}

function rootedPreimage(value, rootKey) {
  const { [rootKey]: _root, ...preimage } = value;
  return preimage;
}

function validateRooted(value, rootKey, at, diagnostics) {
  requireRoot(value?.[rootKey], `${at}.${rootKey}`, diagnostics);
  if (
    isObject(value) &&
    ROOT.test(value[rootKey] ?? '') &&
    semanticRoot(rootedPreimage(value, rootKey)) !== value[rootKey]
  )
    diagnostics.push(
      diagnostic(
        'root-mismatch',
        `${at}.${rootKey}`,
        'root differs from canonical semantic preimage',
      ),
    );
}

function validateAuthority(value, at, diagnostics) {
  if (!exactKeys(value, Object.keys(NON_AUTHORITY), at, diagnostics)) return;
  if (canonicalJson(value) !== canonicalJson(NON_AUTHORITY))
    diagnostics.push(
      diagnostic(
        'authority-escalation',
        at,
        'offline artifacts cannot acquire mutation authority',
      ),
    );
}

function validatePolicy(policy, at, diagnostics) {
  if (
    !exactKeys(
      policy,
      [
        'schema',
        'id',
        'version',
        'advisorPolicyRoot',
        'maximumRegressionRateBps',
        'minimumQualifiedSamples',
        'policyRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (policy.schema !== WORK_DESIGN_REPLAY_POLICY_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        `${at}.schema`,
        'unsupported replay policy',
      ),
    );
  requireId(policy.id, `${at}.id`, diagnostics);
  requirePositiveInteger(policy.version, `${at}.version`, diagnostics);
  requireRoot(policy.advisorPolicyRoot, `${at}.advisorPolicyRoot`, diagnostics);
  requireNonNegativeInteger(
    policy.maximumRegressionRateBps,
    `${at}.maximumRegressionRateBps`,
    diagnostics,
  );
  if (policy.maximumRegressionRateBps > 10000)
    diagnostics.push(
      diagnostic(
        'invalid-value',
        `${at}.maximumRegressionRateBps`,
        'basis points must not exceed 10000',
      ),
    );
  if (policy.minimumQualifiedSamples !== MINIMUM_DEFAULT_PROMOTION_SAMPLES)
    diagnostics.push(
      diagnostic(
        'promotion-floor-drift',
        `${at}.minimumQualifiedSamples`,
        'default promotion requires exactly the 30-sample floor',
      ),
    );
  validateRooted(policy, 'policyRoot', at, diagnostics);
}

function validateEvaluation(value, at, diagnostics) {
  if (
    !exactKeys(
      value,
      [
        'policyRoot',
        'selectionRoot',
        'adviceRoot',
        'dispositionRoot',
        'outcomeRoot',
        'coverageRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  for (const key of [
    'policyRoot',
    'selectionRoot',
    'adviceRoot',
    'dispositionRoot',
    'outcomeRoot',
    'coverageRoot',
  ])
    requireRoot(value[key], `${at}.${key}`, diagnostics);
}

function validateSample(sample, at, diagnostics) {
  if (
    !exactKeys(
      sample,
      [
        'schema',
        'id',
        'qualifiedAt',
        'qualificationRoot',
        'baseline',
        'candidate',
        'drift',
        'sampleRoot',
      ],
      at,
      diagnostics,
    )
  )
    return;
  if (sample.schema !== WORK_DESIGN_REPLAY_SAMPLE_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        `${at}.schema`,
        'unsupported replay sample',
      ),
    );
  requireId(sample.id, `${at}.id`, diagnostics);
  requireTimestamp(sample.qualifiedAt, `${at}.qualifiedAt`, diagnostics);
  requireRoot(sample.qualificationRoot, `${at}.qualificationRoot`, diagnostics);
  validateEvaluation(sample.baseline, `${at}.baseline`, diagnostics);
  validateEvaluation(sample.candidate, `${at}.candidate`, diagnostics);
  if (
    exactKeys(
      sample.drift,
      ['classification', 'evidenceRoot'],
      `${at}.drift`,
      diagnostics,
    )
  ) {
    if (!DRIFT_CLASSIFICATIONS.has(sample.drift.classification))
      diagnostics.push(
        diagnostic(
          'invalid-value',
          `${at}.drift.classification`,
          'unsupported drift classification',
        ),
      );
    requireRoot(
      sample.drift.evidenceRoot,
      `${at}.drift.evidenceRoot`,
      diagnostics,
    );
  }
  validateRooted(sample, 'sampleRoot', at, diagnostics);
}

function validateCohort(cohort, diagnostics) {
  if (
    !exactKeys(
      cohort,
      ['schema', 'asOf', 'samples', 'cohortRoot'],
      '$.cohort',
      diagnostics,
    )
  )
    return;
  if (cohort.schema !== WORK_DESIGN_REPLAY_COHORT_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.cohort.schema',
        'unsupported replay cohort',
      ),
    );
  requireTimestamp(cohort.asOf, '$.cohort.asOf', diagnostics);
  if (!Array.isArray(cohort.samples)) {
    diagnostics.push(
      diagnostic('invalid-type', '$.cohort.samples', 'expected array'),
    );
    return;
  }
  cohort.samples.forEach((sample, index) =>
    validateSample(sample, `$.cohort.samples[${index}]`, diagnostics),
  );
  const ids = cohort.samples.map((sample) => sample?.id);
  if (
    new Set(ids).size !== ids.length ||
    canonicalJson(ids) !== canonicalJson([...ids].sort(compareUtf8))
  )
    diagnostics.push(
      diagnostic(
        'non-canonical-cohort',
        '$.cohort.samples',
        'samples must be id-sorted and unique',
      ),
    );
  for (const [index, sample] of cohort.samples.entries()) {
    if (
      TIMESTAMP.test(sample?.qualifiedAt ?? '') &&
      TIMESTAMP.test(cohort.asOf ?? '') &&
      Date.parse(sample.qualifiedAt) > Date.parse(cohort.asOf)
    )
      diagnostics.push(
        diagnostic(
          'as-of-leakage',
          `$.cohort.samples[${index}].qualifiedAt`,
          'sample was not qualified at the declared as_of cut',
        ),
      );
  }
  validateRooted(cohort, 'cohortRoot', '$.cohort', diagnostics);
}

function changedDimensions(sample) {
  return DIMENSIONS.filter(
    ([, rootKey]) => sample.baseline[rootKey] !== sample.candidate[rootKey],
  ).map(([dimension]) => dimension);
}

function comparisonFor(samples, rootKey) {
  const sampleIds = samples
    .filter((sample) => sample.baseline[rootKey] !== sample.candidate[rootKey])
    .map((sample) => sample.id);
  return { changedCount: sampleIds.length, sampleIds };
}

function validateIdArray(value, at, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(
      diagnostic('invalid-type', at, 'expected identifier array'),
    );
    return [];
  }
  value.forEach((id, index) => requireId(id, `${at}[${index}]`, diagnostics));
  if (
    new Set(value).size !== value.length ||
    canonicalJson(value) !== canonicalJson([...value].sort(compareUtf8))
  )
    diagnostics.push(
      diagnostic(
        'non-canonical-identifiers',
        at,
        'identifiers must be UTF-8 sorted and unique',
      ),
    );
  return value;
}

function reportDiagnostics(report) {
  const diagnostics = [];
  if (
    !exactKeys(
      report,
      [
        'schema',
        'asOf',
        'cohortRoot',
        'baselinePolicyRoot',
        'candidatePolicyRoot',
        'sampleCount',
        'comparison',
        'drift',
        'gates',
        'advisoryModeEligible',
        'defaultPromotionEligible',
        'authority',
        'reportRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return diagnostics;
  if (report.schema !== WORK_DESIGN_REPLAY_REPORT_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported replay report'),
    );
  requireTimestamp(report.asOf, '$.asOf', diagnostics);
  for (const key of ['cohortRoot', 'baselinePolicyRoot', 'candidatePolicyRoot'])
    requireRoot(report[key], `$.${key}`, diagnostics);
  requireNonNegativeInteger(report.sampleCount, '$.sampleCount', diagnostics);
  const comparisonIds = [];
  if (
    exactKeys(
      report.comparison,
      DIMENSIONS.map(([dimension]) => dimension),
      '$.comparison',
      diagnostics,
    )
  )
    for (const [dimension] of DIMENSIONS) {
      const delta = report.comparison[dimension];
      if (
        !exactKeys(
          delta,
          ['changedCount', 'sampleIds'],
          `$.comparison.${dimension}`,
          diagnostics,
        )
      )
        continue;
      requireNonNegativeInteger(
        delta.changedCount,
        `$.comparison.${dimension}.changedCount`,
        diagnostics,
      );
      const ids = validateIdArray(
        delta.sampleIds,
        `$.comparison.${dimension}.sampleIds`,
        diagnostics,
      );
      comparisonIds.push(...ids);
      if (delta.changedCount !== ids.length)
        diagnostics.push(
          diagnostic(
            'comparison-count-mismatch',
            `$.comparison.${dimension}.changedCount`,
            'changed count differs from the exact sample-id set',
          ),
        );
    }
  let changedIds = [];
  let unclassifiedIds = [];
  let regressionIds = [];
  if (
    exactKeys(
      report.drift,
      [
        'changedSampleIds',
        'unclassifiedSampleIds',
        'regressionSampleIds',
        'regressionRateBps',
      ],
      '$.drift',
      diagnostics,
    )
  ) {
    changedIds = validateIdArray(
      report.drift.changedSampleIds,
      '$.drift.changedSampleIds',
      diagnostics,
    );
    unclassifiedIds = validateIdArray(
      report.drift.unclassifiedSampleIds,
      '$.drift.unclassifiedSampleIds',
      diagnostics,
    );
    regressionIds = validateIdArray(
      report.drift.regressionSampleIds,
      '$.drift.regressionSampleIds',
      diagnostics,
    );
    requireNonNegativeInteger(
      report.drift.regressionRateBps,
      '$.drift.regressionRateBps',
      diagnostics,
    );
    const expectedChanged = [...new Set(comparisonIds)].sort(compareUtf8);
    if (canonicalJson(changedIds) !== canonicalJson(expectedChanged))
      diagnostics.push(
        diagnostic(
          'drift-set-mismatch',
          '$.drift.changedSampleIds',
          'changed samples differ from the comparison dimensions',
        ),
      );
    const changedSet = new Set(changedIds);
    if (
      [...unclassifiedIds, ...regressionIds].some((id) => !changedSet.has(id))
    )
      diagnostics.push(
        diagnostic(
          'drift-set-mismatch',
          '$.drift',
          'classified drift must name a changed sample',
        ),
      );
    if (unclassifiedIds.some((id) => regressionIds.includes(id)))
      diagnostics.push(
        diagnostic(
          'drift-set-overlap',
          '$.drift',
          'one sample cannot be both unclassified and regression',
        ),
      );
    const expectedRate =
      report.sampleCount === 0
        ? 0
        : Math.floor((regressionIds.length * 10000) / report.sampleCount);
    if (report.drift.regressionRateBps !== expectedRate)
      diagnostics.push(
        diagnostic(
          'regression-rate-mismatch',
          '$.drift.regressionRateBps',
          'regression rate differs from the exact cohort count',
        ),
      );
  }
  if (
    exactKeys(
      report.gates,
      [
        'cohortExact',
        'evidenceComplete',
        'driftQualified',
        'regressionWithinThreshold',
        'sampleThresholdSatisfied',
      ],
      '$.gates',
      diagnostics,
    )
  )
    for (const [key, value] of Object.entries(report.gates))
      if (typeof value !== 'boolean')
        diagnostics.push(
          diagnostic(
            'invalid-type',
            `$.gates.${key}`,
            'expected boolean gate result',
          ),
        );
  if (
    typeof report.advisoryModeEligible !== 'boolean' ||
    typeof report.defaultPromotionEligible !== 'boolean'
  )
    diagnostics.push(
      diagnostic(
        'invalid-type',
        '$.advisoryModeEligible',
        'eligibility fields must be boolean',
      ),
    );
  validateAuthority(report.authority, '$.authority', diagnostics);
  validateRooted(report, 'reportRoot', '$', diagnostics);
  if (
    report.defaultPromotionEligible !==
    (report.gates?.sampleThresholdSatisfied === true &&
      report.gates?.evidenceComplete === true &&
      report.gates?.driftQualified === true &&
      report.gates?.regressionWithinThreshold === true &&
      report.gates?.cohortExact === true)
  )
    diagnostics.push(
      diagnostic(
        'promotion-gate-mismatch',
        '$.defaultPromotionEligible',
        'promotion eligibility differs from fail-closed gates',
      ),
    );
  if (report.advisoryModeEligible !== report.sampleCount >= 1)
    diagnostics.push(
      diagnostic(
        'advisory-gate-mismatch',
        '$.advisoryModeEligible',
        'one qualified sample must remain advisory eligible',
      ),
    );
  return diagnostics;
}

export function buildWorkDesignReplayPolicy(input) {
  const preimage = {
    schema: WORK_DESIGN_REPLAY_POLICY_SCHEMA,
    id: input.id,
    version: input.version,
    advisorPolicyRoot: input.advisorPolicyRoot,
    maximumRegressionRateBps: input.maximumRegressionRateBps,
    minimumQualifiedSamples: MINIMUM_DEFAULT_PROMOTION_SAMPLES,
  };
  return { ...preimage, policyRoot: semanticRoot(preimage) };
}

export function buildWorkDesignReplaySample(input) {
  const preimage = {
    schema: WORK_DESIGN_REPLAY_SAMPLE_SCHEMA,
    id: input.id,
    qualifiedAt: input.qualifiedAt,
    qualificationRoot: input.qualificationRoot,
    baseline: structuredClone(input.baseline),
    candidate: structuredClone(input.candidate),
    drift: structuredClone(input.drift),
  };
  return { ...preimage, sampleRoot: semanticRoot(preimage) };
}

export function buildWorkDesignReplayCohort(input) {
  const preimage = {
    schema: WORK_DESIGN_REPLAY_COHORT_SCHEMA,
    asOf: input.asOf,
    samples: input.samples
      .map((sample) => structuredClone(sample))
      .sort((left, right) => compareUtf8(left.id, right.id)),
  };
  return { ...preimage, cohortRoot: semanticRoot(preimage) };
}

export function replayWorkDesignPolicy(request) {
  const diagnostics = [];
  if (
    !exactKeys(
      request,
      [
        'schema',
        'asOf',
        'cohort',
        'expectedCohortRoot',
        'baselinePolicy',
        'candidatePolicy',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, report: null, diagnostics };
  if (request.schema !== WORK_DESIGN_REPLAY_REQUEST_SCHEMA)
    diagnostics.push(
      diagnostic('unknown-version', '$.schema', 'unsupported replay request'),
    );
  requireTimestamp(request.asOf, '$.asOf', diagnostics);
  requireRoot(request.expectedCohortRoot, '$.expectedCohortRoot', diagnostics);
  validateCohort(request.cohort, diagnostics);
  validatePolicy(request.baselinePolicy, '$.baselinePolicy', diagnostics);
  validatePolicy(request.candidatePolicy, '$.candidatePolicy', diagnostics);
  if (request.asOf !== request.cohort?.asOf)
    diagnostics.push(
      diagnostic(
        'as-of-mismatch',
        '$.asOf',
        'request and cohort must bind the same as_of cut',
      ),
    );
  if (request.expectedCohortRoot !== request.cohort?.cohortRoot)
    diagnostics.push(
      diagnostic(
        'cohort-root-mismatch',
        '$.expectedCohortRoot',
        'replay cohort differs from the expected qualified cohort',
      ),
    );
  if (
    request.baselinePolicy?.id !== request.candidatePolicy?.id ||
    request.candidatePolicy?.version <= request.baselinePolicy?.version
  )
    diagnostics.push(
      diagnostic(
        'policy-version-order',
        '$.candidatePolicy',
        'candidate must be a later immutable version of the same policy',
      ),
    );

  for (const [index, sample] of request.cohort?.samples?.entries?.() ?? []) {
    if (sample.baseline?.policyRoot !== request.baselinePolicy?.policyRoot)
      diagnostics.push(
        diagnostic(
          'policy-drift',
          `$.cohort.samples[${index}].baseline.policyRoot`,
          'baseline output names another policy version',
        ),
      );
    if (sample.candidate?.policyRoot !== request.candidatePolicy?.policyRoot)
      diagnostics.push(
        diagnostic(
          'policy-drift',
          `$.cohort.samples[${index}].candidate.policyRoot`,
          'candidate output names another policy version',
        ),
      );
    const changes = changedDimensions(sample);
    if (
      (changes.length === 0 && sample.drift?.classification !== 'none') ||
      (changes.length > 0 && sample.drift?.classification === 'none')
    )
      diagnostics.push(
        diagnostic(
          'drift-classification-mismatch',
          `$.cohort.samples[${index}].drift.classification`,
          'drift classification disagrees with observed policy outputs',
        ),
      );
  }
  diagnostics.sort(
    (left, right) =>
      compareUtf8(left.path, right.path) || compareUtf8(left.code, right.code),
  );
  if (diagnostics.length > 0) return { ok: false, report: null, diagnostics };

  const samples = request.cohort.samples;
  const unclassifiedSampleIds = samples
    .filter((sample) => sample.drift.classification === 'unclassified')
    .map((sample) => sample.id);
  const regressionSampleIds = samples
    .filter((sample) => sample.drift.classification === 'regression')
    .map((sample) => sample.id);
  const regressionRateBps =
    samples.length === 0
      ? 0
      : Math.floor((regressionSampleIds.length * 10000) / samples.length);
  const gates = {
    cohortExact: true,
    evidenceComplete: true,
    driftQualified: unclassifiedSampleIds.length === 0,
    regressionWithinThreshold:
      regressionRateBps <= request.candidatePolicy.maximumRegressionRateBps,
    sampleThresholdSatisfied:
      samples.length >= MINIMUM_DEFAULT_PROMOTION_SAMPLES,
  };
  const preimage = {
    schema: WORK_DESIGN_REPLAY_REPORT_SCHEMA,
    asOf: request.asOf,
    cohortRoot: request.cohort.cohortRoot,
    baselinePolicyRoot: request.baselinePolicy.policyRoot,
    candidatePolicyRoot: request.candidatePolicy.policyRoot,
    sampleCount: samples.length,
    comparison: Object.fromEntries(
      DIMENSIONS.map(([dimension, rootKey]) => [
        dimension,
        comparisonFor(samples, rootKey),
      ]),
    ),
    drift: {
      changedSampleIds: samples
        .filter((sample) => changedDimensions(sample).length > 0)
        .map((sample) => sample.id),
      unclassifiedSampleIds,
      regressionSampleIds,
      regressionRateBps,
    },
    gates,
    advisoryModeEligible: samples.length >= 1,
    defaultPromotionEligible: Object.values(gates).every(Boolean),
    authority: { ...NON_AUTHORITY },
  };
  return {
    ok: true,
    report: { ...preimage, reportRoot: semanticRoot(preimage) },
    diagnostics: [],
  };
}

export function verifyWorkDesignReplayReport(report) {
  const diagnostics = reportDiagnostics(report);
  return { ok: diagnostics.length === 0, diagnostics };
}

export function buildWorkDesignPromotionArtifact(input) {
  const diagnostics = reportDiagnostics(input.report);
  validatePolicy(input.candidatePolicy, '$.candidatePolicy', diagnostics);
  requireRoot(input.activePolicyRoot, '$.activePolicyRoot', diagnostics);
  requireRoot(input.rollbackPolicyRoot, '$.rollbackPolicyRoot', diagnostics);
  if (input.report?.candidatePolicyRoot !== input.candidatePolicy?.policyRoot)
    diagnostics.push(
      diagnostic(
        'policy-drift',
        '$.candidatePolicy.policyRoot',
        'promotion candidate differs from replayed candidate',
      ),
    );
  const rollbackVerified =
    input.rollbackPolicyRoot === input.activePolicyRoot &&
    input.report?.baselinePolicyRoot === input.activePolicyRoot;
  const eligibility = {
    sampleCount: input.report?.sampleCount ?? 0,
    minimumQualifiedSamples: MINIMUM_DEFAULT_PROMOTION_SAMPLES,
    sampleThresholdSatisfied:
      input.report?.gates?.sampleThresholdSatisfied === true,
    evidenceComplete: input.report?.gates?.evidenceComplete === true,
    driftQualified: input.report?.gates?.driftQualified === true,
    regressionWithinThreshold:
      input.report?.gates?.regressionWithinThreshold === true,
    cohortExact: input.report?.gates?.cohortExact === true,
    rollbackVerified,
    eligible:
      input.report?.defaultPromotionEligible === true && rollbackVerified,
  };
  const preimage = {
    schema: WORK_DESIGN_PROMOTION_ARTIFACT_SCHEMA,
    reportRoot: input.report?.reportRoot,
    cohortRoot: input.report?.cohortRoot,
    activePolicyRoot: input.activePolicyRoot,
    candidatePolicyRoot: input.candidatePolicy?.policyRoot,
    candidateVersion: input.candidatePolicy?.version,
    eligibility,
    activation: {
      mode: ACTIVATION_MODE,
      targetPolicyRoot: input.candidatePolicy?.policyRoot,
      activated: false,
    },
    rollback: {
      fromPolicyRoot: input.candidatePolicy?.policyRoot,
      toPolicyRoot: input.rollbackPolicyRoot,
      verified: rollbackVerified,
    },
    authority: { ...NON_AUTHORITY },
  };
  const artifact = {
    ...preimage,
    promotionRoot: semanticRoot(preimage),
  };
  if (!rollbackVerified)
    diagnostics.push(
      diagnostic(
        'rollback-root-mismatch',
        '$.rollbackPolicyRoot',
        'rollback must restore the exact replayed active policy',
      ),
    );
  return { ok: diagnostics.length === 0, artifact, diagnostics };
}

export function verifyWorkDesignPromotionArtifact(artifact) {
  const diagnostics = [];
  if (
    !exactKeys(
      artifact,
      [
        'schema',
        'reportRoot',
        'cohortRoot',
        'activePolicyRoot',
        'candidatePolicyRoot',
        'candidateVersion',
        'eligibility',
        'activation',
        'rollback',
        'authority',
        'promotionRoot',
      ],
      '$',
      diagnostics,
    )
  )
    return { ok: false, diagnostics };
  if (artifact.schema !== WORK_DESIGN_PROMOTION_ARTIFACT_SCHEMA)
    diagnostics.push(
      diagnostic(
        'unknown-version',
        '$.schema',
        'unsupported promotion artifact',
      ),
    );
  for (const key of [
    'reportRoot',
    'cohortRoot',
    'activePolicyRoot',
    'candidatePolicyRoot',
  ])
    requireRoot(artifact[key], `$.${key}`, diagnostics);
  requirePositiveInteger(
    artifact.candidateVersion,
    '$.candidateVersion',
    diagnostics,
  );
  if (
    exactKeys(
      artifact.eligibility,
      [
        'sampleCount',
        'minimumQualifiedSamples',
        'sampleThresholdSatisfied',
        'evidenceComplete',
        'driftQualified',
        'regressionWithinThreshold',
        'cohortExact',
        'rollbackVerified',
        'eligible',
      ],
      '$.eligibility',
      diagnostics,
    )
  ) {
    requireNonNegativeInteger(
      artifact.eligibility.sampleCount,
      '$.eligibility.sampleCount',
      diagnostics,
    );
    if (
      artifact.eligibility.minimumQualifiedSamples !==
      MINIMUM_DEFAULT_PROMOTION_SAMPLES
    )
      diagnostics.push(
        diagnostic(
          'promotion-floor-drift',
          '$.eligibility.minimumQualifiedSamples',
          'default promotion requires exactly the 30-sample floor',
        ),
      );
    for (const key of [
      'sampleThresholdSatisfied',
      'evidenceComplete',
      'driftQualified',
      'regressionWithinThreshold',
      'cohortExact',
      'rollbackVerified',
      'eligible',
    ])
      if (typeof artifact.eligibility[key] !== 'boolean')
        diagnostics.push(
          diagnostic(
            'invalid-type',
            `$.eligibility.${key}`,
            'expected boolean eligibility result',
          ),
        );
  }
  if (
    exactKeys(
      artifact.activation,
      ['mode', 'targetPolicyRoot', 'activated'],
      '$.activation',
      diagnostics,
    )
  )
    requireRoot(
      artifact.activation.targetPolicyRoot,
      '$.activation.targetPolicyRoot',
      diagnostics,
    );
  if (
    exactKeys(
      artifact.rollback,
      ['fromPolicyRoot', 'toPolicyRoot', 'verified'],
      '$.rollback',
      diagnostics,
    )
  ) {
    requireRoot(
      artifact.rollback.fromPolicyRoot,
      '$.rollback.fromPolicyRoot',
      diagnostics,
    );
    requireRoot(
      artifact.rollback.toPolicyRoot,
      '$.rollback.toPolicyRoot',
      diagnostics,
    );
    if (typeof artifact.rollback.verified !== 'boolean')
      diagnostics.push(
        diagnostic(
          'invalid-type',
          '$.rollback.verified',
          'expected boolean rollback result',
        ),
      );
  }
  validateAuthority(artifact.authority, '$.authority', diagnostics);
  validateRooted(artifact, 'promotionRoot', '$', diagnostics);
  if (
    artifact.activation?.mode !== ACTIVATION_MODE ||
    artifact.activation?.activated !== false
  )
    diagnostics.push(
      diagnostic(
        'activation-authority-escalation',
        '$.activation',
        'promotion artifacts never activate a default policy',
      ),
    );
  const expectedRollback =
    artifact.rollback?.toPolicyRoot === artifact.activePolicyRoot &&
    artifact.rollback?.fromPolicyRoot === artifact.candidatePolicyRoot;
  if (
    artifact.rollback?.verified !== expectedRollback ||
    artifact.eligibility?.rollbackVerified !== expectedRollback
  )
    diagnostics.push(
      diagnostic(
        'rollback-root-mismatch',
        '$.rollback',
        'rollback coordinates do not restore the exact active policy',
      ),
    );
  const expectedEligible =
    artifact.eligibility?.sampleCount >= MINIMUM_DEFAULT_PROMOTION_SAMPLES &&
    artifact.eligibility?.sampleThresholdSatisfied === true &&
    artifact.eligibility?.evidenceComplete === true &&
    artifact.eligibility?.driftQualified === true &&
    artifact.eligibility?.regressionWithinThreshold === true &&
    artifact.eligibility?.cohortExact === true &&
    artifact.eligibility?.rollbackVerified === true;
  if (artifact.eligibility?.eligible !== expectedEligible)
    diagnostics.push(
      diagnostic(
        'promotion-gate-mismatch',
        '$.eligibility.eligible',
        'promotion eligibility differs from fail-closed contract',
      ),
    );
  return { ok: diagnostics.length === 0, diagnostics };
}

export function workDesignReplayAuthorityBoundary() {
  return { ...NON_AUTHORITY };
}
