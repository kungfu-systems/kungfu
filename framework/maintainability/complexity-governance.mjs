#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';

const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])]),
    );
  return value;
}

function digest(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

function digestBytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function comparable(value) {
  return JSON.stringify(ordered(value));
}

function measurement(file) {
  if (!file) return null;
  return {
    path: file.path,
    class: file.class,
    language: file.language,
    owner: file.owner,
    lines: file.lines,
    contentRoot: file.contentRoot || '',
  };
}

function enrichIssue(issue, baselineFiles, currentFiles) {
  const paths = sortedUnique([...(issue.paths || []), issue.path || '']);
  const baseline = new Map(baselineFiles.map((file) => [file.path, file]));
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  const baselineMeasurement = paths
    .map((pathname) => measurement(baseline.get(pathname)))
    .filter(Boolean);
  const currentMeasurement = paths
    .map((pathname) => measurement(current.get(pathname)))
    .filter(Boolean);
  const budgetClasses = sortedUnique(
    [...baselineMeasurement, ...currentMeasurement].map(
      (item) => `${item.class}:${item.language}`,
    ),
  );
  const identity = {
    schema: 'kungfu.code-complexity-budget-issue/v1',
    issueKind: issue.code,
    paths,
    budgetClasses,
    owners: sortedUnique(
      [...baselineMeasurement, ...currentMeasurement].map((item) => item.owner),
    ),
    baselineMeasurement,
    currentMeasurement,
  };
  return {
    ...issue,
    path: paths[0] || issue.path || '',
    paths,
    issueKind: issue.code,
    budgetClasses,
    baselineMeasurement,
    currentMeasurement,
    issueRoot: digest(identity),
  };
}

function baselineMeasurementRoot(baseline) {
  return digest({
    schema: 'kungfu.code-complexity-budget-measurement/v1',
    baselineRef: baseline.baselineRef,
    policyRoot: baseline.policyRoot,
    classification: baseline.classification,
    calibration: baseline.calibration,
    summary: baseline.summary,
    groups: baseline.groups,
    grandfathered: baseline.grandfathered,
    files: baseline.files,
    issues: baseline.issues,
  });
}

function measurementPolicyRoot(policy) {
  return digest({
    schema: 'kungfu.code-complexity-measurement-policy/v1',
    baselineRef: policy.baselineRef,
    classificationOrder: policy.classificationOrder,
    calibration: policy.calibration,
    eligibleExtensions: policy.eligibleExtensions,
    specialEligibleNames: policy.specialEligibleNames,
    governanceMetadata: {
      baselinePath: policy.baselinePath,
      waiverDirectory: policy.waiverDirectory,
      transitionDirectory: policy.baselineGovernance?.transitionDirectory || '',
    },
  });
}

function baselineIntegrityIssues(committed, recomputed, path) {
  const issues = [];
  const expectedRoot = baselineMeasurementRoot(recomputed);
  if (!ROOT_PATTERN.test(committed.measurementRoot || ''))
    issues.push({
      code: 'invalid-baseline-measurement-root',
      path,
      message: 'baseline omits a valid recomputed measurement root',
    });
  else if (committed.measurementRoot !== expectedRoot)
    issues.push({
      code: 'forged-baseline-measurement',
      path,
      expectedMeasurementRoot: expectedRoot,
      actualMeasurementRoot: committed.measurementRoot,
      message:
        'committed baseline measurements do not match the exact baseline ref',
    });
  for (const field of [
    'policyRoot',
    'baselineRef',
    'classification',
    'calibration',
    'summary',
    'groups',
    'grandfathered',
    'files',
    'issues',
  ])
    if (comparable(committed[field]) !== comparable(recomputed[field]))
      issues.push({
        code: 'forged-baseline-artifact',
        path,
        field,
        message: `committed baseline field '${field}' differs from recomputation`,
      });
  return issues;
}

function waiverIssues(record, policy, context = {}) {
  const issues = [];
  const waiver = record.value;
  for (const field of policy.waiver.requiredFields)
    if (
      waiver[field] === undefined ||
      waiver[field] === null ||
      waiver[field] === ''
    )
      issues.push({
        code: 'invalid-waiver',
        path: record.file,
        message: `missing ${field}`,
      });
  if (waiver.schema !== policy.waiver.schema)
    issues.push({
      code: 'invalid-waiver',
      path: record.file,
      message: 'schema mismatch',
    });
  const paths = Array.isArray(waiver.paths_or_scope)
    ? sortedUnique(waiver.paths_or_scope)
    : [];
  if (
    paths.length === 0 ||
    paths.length !== (waiver.paths_or_scope || []).length
  )
    issues.push({
      code: 'invalid-waiver-scope',
      path: record.file,
      message:
        'paths_or_scope must be a sorted, unique, non-empty exact path set',
    });

  const issue = context.issue;
  const requester = String(context.requester || '');
  if (issue) {
    for (const [field, expected, actual] of [
      ['issue_root', issue.issueRoot, waiver.issue_root],
      ['issue_kind', issue.issueKind, waiver.issue_kind],
      ['paths_or_scope', issue.paths, paths],
      ['budget_classes', issue.budgetClasses, waiver.budget_classes],
      [
        'baseline_measurement',
        issue.baselineMeasurement,
        waiver.baseline_measurement,
      ],
      [
        'current_measurement',
        issue.currentMeasurement,
        waiver.current_measurement,
      ],
    ])
      if (comparable(expected) !== comparable(actual))
        issues.push({
          code: 'waiver-scope-mismatch',
          path: record.file,
          field,
          message: `${field} does not match the gate-computed issue`,
        });
    if (requester && waiver.requested_by !== requester)
      issues.push({
        code: 'forged-waiver-requester',
        path: record.file,
        message: 'requested_by does not match the candidate commit author',
      });
  }
  return issues;
}

function baselineTransitionIssues(record, context) {
  const issues = [];
  const transition = record.value || {};
  const governance = context.candidatePolicy.baselineGovernance || {};
  for (const field of [
    'schema',
    'expected_old_measurement_root',
    'expected_old_baseline_ref',
    'new_measurement_root',
    'new_baseline_ref',
    'changed_measurements',
    'aggregate_line_delta',
    'requested_by',
    'reason',
    'retirement_or_decomposition_ref',
  ])
    if (
      transition[field] === undefined ||
      transition[field] === null ||
      transition[field] === ''
    )
      issues.push({
        code: 'invalid-baseline-transition',
        path: record.file,
        message: `missing ${field}`,
      });
  if (transition.schema !== governance.transitionSchema)
    issues.push({
      code: 'invalid-baseline-transition',
      path: record.file,
      message: 'baseline transition schema mismatch',
    });
  for (const [field, expected] of [
    [
      'expected_old_measurement_root',
      context.protectedBaseline.measurementRoot,
    ],
    ['expected_old_baseline_ref', context.protectedBaseline.baselineRef],
    ['new_measurement_root', context.candidateBaseline.measurementRoot],
    ['new_baseline_ref', context.candidateBaseline.baselineRef],
  ])
    if (transition[field] !== expected)
      issues.push({
        code: 'baseline-transition-root-mismatch',
        path: record.file,
        field,
        message: `${field} does not match the protected expected-old/new roots`,
      });
  if (
    !Number.isSafeInteger(transition.changed_measurements) ||
    transition.changed_measurements < 0 ||
    transition.changed_measurements > governance.maxChangedMeasurements
  )
    issues.push({
      code: 'baseline-transition-too-broad',
      path: record.file,
      message: 'changed_measurements exceeds the bounded transition policy',
    });
  if (
    !Number.isSafeInteger(transition.aggregate_line_delta) ||
    Math.abs(transition.aggregate_line_delta) > governance.maxAggregateLineDelta
  )
    issues.push({
      code: 'baseline-transition-too-broad',
      path: record.file,
      message: 'aggregate_line_delta exceeds the bounded transition policy',
    });
  if (context.requester && transition.requested_by !== context.requester)
    issues.push({
      code: 'baseline-transition-requester-mismatch',
      path: record.file,
      message: 'requested_by does not match the candidate commit author',
    });
  return issues;
}

function protectedBaselineIssues(context) {
  const { protectedPolicy, protectedBaseline, candidateBaseline } = context;
  if (
    protectedPolicy.status !== 'p1-trusted-governance' ||
    !protectedPolicy.baselineGovernance
  )
    return [];
  if (
    protectedBaseline.measurementRoot === candidateBaseline.measurementRoot &&
    protectedBaseline.baselineRef === candidateBaseline.baselineRef
  )
    return [];
  const matches = (context.transitions || []).filter(
    (record) => baselineTransitionIssues(record, context).length === 0,
  );
  if (matches.length === 1) return [];
  return [
    {
      code: 'unauthorized-baseline-transition',
      path: context.candidatePolicy.baselinePath,
      message:
        matches.length > 1
          ? 'multiple valid transition records target the candidate baseline'
          : 'baseline changed without one exact deterministic transition from the protected root',
    },
  ];
}

function validWaiverFor(issue, current, waivers, policy, context = {}) {
  for (const record of waivers) {
    const scoped = {
      ...context,
      issue,
    };
    if (waiverIssues(record, policy, scoped).length) continue;
    const waiver = record.value;
    const currentLines = issue.currentMeasurement.reduce(
      (total, item) => total + item.lines,
      0,
    );
    const baselineLines = issue.baselineMeasurement.reduce(
      (total, item) => total + item.lines,
      0,
    );
    if (
      current &&
      waiver.owner === current.owner &&
      Number.isFinite(waiver.allowed_delta) &&
      waiver.allowed_delta >= currentLines - baselineLines
    )
      return record.file;
  }
  return '';
}

export {
  baselineTransitionIssues,
  baselineIntegrityIssues,
  baselineMeasurementRoot,
  digest,
  digestBytes,
  enrichIssue,
  measurementPolicyRoot,
  ordered,
  protectedBaselineIssues,
  validWaiverFor,
  waiverIssues,
};
