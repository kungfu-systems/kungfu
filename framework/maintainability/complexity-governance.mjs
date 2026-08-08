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

function parseInstant(value) {
  if (typeof value !== 'string' || !value.endsWith('Z')) return Number.NaN;
  return Date.parse(value);
}

function authorityFor(receipt, trustPolicy) {
  return (trustPolicy.waiver.trustedAuthorities || []).find(
    (authority) =>
      authority.authority_id === receipt.authority_id &&
      authority.key_id === receipt.key_id &&
      authority.algorithm === receipt.algorithm,
  );
}

function approvalTimeIssues(receipt, approvalPolicy, path, evaluationTime) {
  const issues = [];
  const issuedAt = parseInstant(receipt.issued_at);
  const approvedAt = parseInstant(receipt.approved_at);
  const expiresAt = parseInstant(receipt.expires_at);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > approvedAt ||
    approvedAt > evaluationTime ||
    evaluationTime >= expiresAt
  )
    issues.push({
      code:
        Number.isFinite(expiresAt) && evaluationTime >= expiresAt
          ? 'expired-approval'
          : 'invalid-approval-timestamp',
      path,
      message:
        'approval timestamps must be valid UTC instants ordered issued <= approved <= evaluation < expiry',
    });
  const maxAgeDays = Number(approvalPolicy.maxApprovalAgeDays || 0);
  if (
    maxAgeDays > 0 &&
    Number.isFinite(approvedAt) &&
    evaluationTime - approvedAt > maxAgeDays * 86_400_000
  )
    issues.push({
      code: 'stale-approval',
      path,
      message: `approval is older than ${maxAgeDays} days`,
    });
  return issues;
}

function approvalIssues({
  receipt,
  approvalPolicy,
  trustPolicy,
  path,
  evaluationTime,
  authorizationRoot,
  requester,
}) {
  const issues = [];
  if (receipt.schema !== approvalPolicy.approvalReceiptSchema)
    issues.push({
      code: 'invalid-approval-receipt',
      path,
      message: 'approval receipt schema mismatch',
    });
  issues.push(
    ...approvalTimeIssues(receipt, approvalPolicy, path, evaluationTime),
  );
  if (receipt.authorization_root !== authorizationRoot)
    issues.push({
      code: 'approval-scope-root-mismatch',
      path,
      message: 'approval receipt is not bound to the recomputed scope',
    });
  const authority = authorityFor(receipt, trustPolicy);
  if (!authority)
    issues.push({
      code: 'unknown-approval-authority',
      path,
      message: 'approval authority/key is not in the protected trust set',
    });
  else {
    if (authority.authority_id === requester)
      issues.push({
        code: 'same-authority-approval',
        path,
        message: 'requester and approval authority must be independent',
      });
    if (!verifyApproval(receipt, authority, authorizationRoot))
      issues.push({
        code: 'invalid-approval-signature',
        path,
        message: 'approval signature does not verify over the exact scope root',
      });
  }
  return issues;
}

function waiverAuthorization(record, issue, requester) {
  const waiver = record.value;
  return {
    schema: 'kungfu.code-complexity-budget-waiver-authorization/v1',
    issueRoot: issue.issueRoot,
    issueKind: issue.issueKind,
    paths: issue.paths,
    budgetClasses: issue.budgetClasses,
    baselineMeasurement: issue.baselineMeasurement,
    currentMeasurement: issue.currentMeasurement,
    allowedDelta: waiver.allowed_delta,
    owner: waiver.owner,
    requester,
    responsibilityBoundary: waiver.responsibility_boundary,
    retirementOrDecompositionRef: waiver.retirement_or_decomposition_ref,
  };
}

function verifyApproval(receipt, authority, authorizationRoot) {
  if (
    receipt.algorithm !== 'ed25519' ||
    !authority.public_key_pem ||
    typeof receipt.signature !== 'string'
  )
    return false;
  try {
    return crypto.verify(
      null,
      Buffer.from(authorizationRoot, 'utf8'),
      authority.public_key_pem,
      Buffer.from(receipt.signature, 'base64'),
    );
  } catch {
    return false;
  }
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

  const receipt = waiver.approval_receipt || {};
  const evaluationTime =
    context.evaluationTime instanceof Date
      ? context.evaluationTime.getTime()
      : Date.now();

  const issue = context.issue;
  const requester = String(context.requester || '');
  let authorizationRoot = receipt.authorization_root;
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
    authorizationRoot = digest(
      waiverAuthorization(record, issue, requester || waiver.requested_by),
    );
  }
  issues.push(
    ...approvalIssues({
      receipt,
      approvalPolicy: policy.waiver,
      trustPolicy: context.trustPolicy || policy,
      path: record.file,
      evaluationTime,
      authorizationRoot,
      requester: requester || waiver.requested_by,
    }),
  );
  return issues;
}

function baselineTransitionAuthorization(transition) {
  return {
    schema: 'kungfu.code-complexity-baseline-transition-authorization/v1',
    expectedOldMeasurementRoot: transition.expected_old_measurement_root,
    expectedOldBaselineRef: transition.expected_old_baseline_ref,
    newMeasurementRoot: transition.new_measurement_root,
    newBaselineRef: transition.new_baseline_ref,
    changedMeasurements: transition.changed_measurements,
    aggregateLineDelta: transition.aggregate_line_delta,
    changeManifestRoot: transition.change_manifest_root || '',
    reconstructionScope: transition.reconstruction_scope || '',
    reconstructionReasonCodes: transition.reconstruction_reason_codes || [],
    requester: transition.requested_by,
    reason: transition.reason,
    retirementOrDecompositionRef: transition.retirement_or_decomposition_ref,
  };
}

function baselineChangeManifest(protectedBaseline, candidateBaseline) {
  const before = new Map(
    (protectedBaseline.files || []).map((file) => [file.path, file]),
  );
  const after = new Map(
    (candidateBaseline.files || []).map((file) => [file.path, file]),
  );
  const paths = sortedUnique([...before.keys(), ...after.keys()]);
  const changes = paths
    .filter(
      (pathname) =>
        comparable(before.get(pathname) || null) !==
        comparable(after.get(pathname) || null),
    )
    .map((pathname) => ({
      path: pathname,
      before: before.get(pathname) || null,
      after: after.get(pathname) || null,
    }));
  return {
    schema: 'kungfu.code-complexity-baseline-change-manifest/v1',
    expectedOldMeasurementRoot: protectedBaseline.measurementRoot,
    newMeasurementRoot: candidateBaseline.measurementRoot,
    changedMeasurements: changes.length,
    aggregateLineDelta: changes.reduce(
      (total, change) =>
        total + (change.after?.lines || 0) - (change.before?.lines || 0),
      0,
    ),
    changes,
  };
}

function baselineTransitionIssues(record, context) {
  const issues = [];
  const transition = record.value || {};
  const governance = context.candidatePolicy.baselineGovernance || {};
  const changeManifest = baselineChangeManifest(
    context.protectedBaseline,
    context.candidateBaseline,
  );
  const changeManifestRoot = digest(changeManifest);
  const reconstruction = transition.schema === governance.reconstructionSchema;
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
    'approval_receipt',
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
  if (transition.schema !== governance.transitionSchema && !reconstruction)
    issues.push({
      code: 'invalid-baseline-transition',
      path: record.file,
      message: 'baseline transition schema mismatch',
    });
  if (
    transition.changed_measurements !== changeManifest.changedMeasurements ||
    transition.aggregate_line_delta !== changeManifest.aggregateLineDelta
  )
    issues.push({
      code: 'baseline-transition-delta-mismatch',
      path: record.file,
      message:
        'declared baseline delta does not match the exact recomputed change manifest',
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
    (!reconstruction &&
      !Number.isSafeInteger(transition.changed_measurements)) ||
    (!reconstruction && transition.changed_measurements < 0) ||
    (!reconstruction &&
      transition.changed_measurements > governance.maxChangedMeasurements)
  )
    issues.push({
      code: 'baseline-transition-too-broad',
      path: record.file,
      message: 'changed_measurements exceeds the bounded transition policy',
    });
  if (
    (!reconstruction &&
      !Number.isSafeInteger(transition.aggregate_line_delta)) ||
    (!reconstruction &&
      Math.abs(transition.aggregate_line_delta) >
        governance.maxAggregateLineDelta)
  )
    issues.push({
      code: 'baseline-transition-too-broad',
      path: record.file,
      message: 'aggregate_line_delta exceeds the bounded transition policy',
    });
  if (reconstruction) {
    if (transition.change_manifest_root !== changeManifestRoot)
      issues.push({
        code: 'baseline-reconstruction-manifest-mismatch',
        path: record.file,
        message:
          'reconstruction does not bind the exact recomputed change manifest',
      });
    if (transition.reconstruction_scope !== 'full-exact-baseline')
      issues.push({
        code: 'invalid-baseline-reconstruction',
        path: record.file,
        message: 'reconstruction_scope must cover the full exact baseline',
      });
    if (
      !Array.isArray(transition.reconstruction_reason_codes) ||
      transition.reconstruction_reason_codes.length === 0 ||
      comparable(transition.reconstruction_reason_codes) !==
        comparable(sortedUnique(transition.reconstruction_reason_codes))
    )
      issues.push({
        code: 'invalid-baseline-reconstruction',
        path: record.file,
        message:
          'reconstruction_reason_codes must be a non-empty sorted unique list',
      });
    const exceedsOrdinaryBounds =
      changeManifest.changedMeasurements > governance.maxChangedMeasurements ||
      Math.abs(changeManifest.aggregateLineDelta) >
        governance.maxAggregateLineDelta;
    if (!exceedsOrdinaryBounds)
      issues.push({
        code: 'unnecessary-baseline-reconstruction',
        path: record.file,
        message: 'bounded changes must use the ordinary transition contract',
      });
  }
  const authorizationRoot = digest(baselineTransitionAuthorization(transition));
  const evaluationTime =
    context.evaluationTime instanceof Date
      ? context.evaluationTime.getTime()
      : Date.now();
  issues.push(
    ...approvalIssues({
      receipt: transition.approval_receipt || {},
      approvalPolicy: context.protectedPolicy.waiver,
      trustPolicy: context.protectedPolicy,
      path: record.file,
      evaluationTime,
      authorizationRoot,
      requester: transition.requested_by,
    }),
  );
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
          ? 'multiple valid transition receipts target the candidate baseline'
          : 'baseline changed without one exact independently signed transition from the protected root',
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
  baselineChangeManifest,
  baselineTransitionAuthorization,
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
  waiverAuthorization,
  waiverIssues,
};
