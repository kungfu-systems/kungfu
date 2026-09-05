// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  exact,
  issue,
  requiredRoot,
  uniqueBy,
} from './verification-primitives.mjs';

export function verifyLiveAssignment(
  matrix,
  evidence,
  live,
  references,
  issues,
) {
  exact(
    evidence.assignment?.assignmentId,
    matrix.assignmentId,
    'assignment-identity-mismatch',
    'assignment.assignmentId',
    issues,
  );
  exact(
    evidence.assignment?.gitCommit,
    live.source?.head,
    'assignment-head-mismatch',
    'assignment.gitCommit',
    issues,
  );
  for (const [field, kind] of [
    ['requestRoot', 'assignment-request'],
    ['captureReceiptRoot', 'assignment-capture'],
    ['completionClaimRoot', 'assignment-claim'],
    ['independentReviewRoot', 'assignment-review'],
    ['completionDecisionRoot', 'assignment-decision'],
    ['sealedStateRoot', 'assignment-seal'],
  ]) {
    requiredRoot(
      references,
      evidence.assignment?.[field],
      `assignment.${field}`,
      kind,
      issues,
    );
  }
  for (const field of [
    'initiativeId',
    'assignmentId',
    'workspaceIdentityRoot',
    'phase',
    'status',
    'requestRoot',
    'captureReceiptRoot',
    'gitCommit',
    'completionClaimRoot',
    'independentReviewRoot',
    'completionDecisionRoot',
    'sealedStateRoot',
  ]) {
    exact(
      evidence.assignment?.[field],
      live.assignment?.[field],
      `assignment-live-${field}-mismatch`,
      `assignment.${field}`,
      issues,
    );
  }
  exact(
    live.assignment?.phase,
    'continuation-decided',
    'assignment-not-terminal',
    'live.assignment.phase',
    issues,
  );
  exact(
    live.assignment?.sealedPhase,
    'continuation-decided',
    'assignment-seal-not-terminal',
    'live.assignment.sealedPhase',
    issues,
  );
  exact(
    live.assignment?.sealedAssignmentId,
    matrix.assignmentId,
    'assignment-seal-identity-mismatch',
    'live.assignment.sealedAssignmentId',
    issues,
  );
  exact(
    live.assignment?.sealedQueryProofRoot,
    live.assignment?.queryProofRoot,
    'assignment-seal-query-proof-mismatch',
    'live.assignment.sealedQueryProofRoot',
    issues,
  );
  const rule = matrix.terminalEvidence.terminalReviewRule;
  exact(
    live.assignment?.reviewer,
    rule.reviewer,
    'assignment-live-reviewer-mismatch',
    'live.assignment.reviewer',
    issues,
  );
  exact(
    live.assignment?.reviewVerdict,
    rule.verdict,
    'assignment-live-review-verdict-mismatch',
    'live.assignment.reviewVerdict',
    issues,
  );
  exact(
    live.assignment?.reviewerSource,
    evidence.review?.root,
    'assignment-review-source-mismatch',
    'live.assignment.reviewerSource',
    issues,
  );
  exact(
    live.assignment?.decisionAction,
    'close',
    'assignment-decision-not-close',
    'live.assignment.decisionAction',
    issues,
  );
  if (live.assignment?.sealVerified !== true) {
    issues.push(
      issue(
        'assignment-seal-unverified',
        'live.assignment.sealVerified',
        'canonical native Assignment seal did not verify',
      ),
    );
  }
  if ((live.assignment?.nextActions || []).length !== 0) {
    issues.push(
      issue(
        'assignment-still-actionable',
        'live.assignment.nextActions',
        'terminal native Assignment retains actionable next actions',
      ),
    );
  }
  for (const field of [
    'completion_claims',
    'independent_reviews',
    'continuation_decisions',
  ]) {
    exact(
      live.assignment?.sealedCounts?.[field],
      live.assignment?.statusCounts?.[field],
      'assignment-seal-count-mismatch',
      `live.assignment.sealedCounts.${field}`,
      issues,
    );
    if ((live.assignment?.statusCounts?.[field] || 0) < 1) {
      issues.push(
        issue(
          'assignment-terminal-chain-incomplete',
          `live.assignment.statusCounts.${field}`,
          `terminal Assignment has no ${field}`,
        ),
      );
    }
  }
}

function assignmentFamily(assignmentId) {
  const family = String(assignmentId || '')
    .replace(/^\d{4}-\d{2}-\d{2}-kungfu-/u, '')
    .replace(/-v\d+$/u, '');
  return family.startsWith('terminal-review-') ? 'terminal-review' : family;
}

function authoritativePullScope(request, issues) {
  const work = request?.workDefinition;
  const dependencies = work?.dependency_identities;
  const baseline = work?.review_baseline?.open_pull_requests_at_review;
  if (!Array.isArray(dependencies)) {
    issues.push(
      issue(
        'request-dependencies-missing',
        'assignment.request.workDefinition.dependency_identities',
        'immutable Assignment request has no dependency identities',
      ),
    );
  }
  if (!Array.isArray(baseline)) {
    issues.push(
      issue(
        'request-reconciliation-scope-missing',
        'assignment.request.workDefinition.review_baseline.open_pull_requests_at_review',
        'immutable Assignment request has no pull-request review baseline',
      ),
    );
  }
  const identities = [
    work?.parent_assignment_identity?.assignment_id,
    ...(Array.isArray(dependencies)
      ? dependencies.map(({ assignment_id }) => assignment_id)
      : []),
  ].filter(Boolean);
  const families = new Set(identities.map(assignmentFamily).filter(Boolean));
  const pullNumbers = new Set(
    (Array.isArray(baseline) ? baseline : [])
      .map((value) => /^#([1-9][0-9]*)$/u.exec(String(value)))
      .filter(Boolean)
      .map((match) => Number(match[1])),
  );
  return { families, pullNumbers };
}

export function verifyLiveReconciliation(matrix, live, request, issues) {
  const requiredPulls = matrix.reconciliation?.pullRequests;
  const observedPulls = live.reconciliation?.declaredPulls;
  const openProtectedPulls = live.reconciliation?.openProtectedPulls;
  if (!Array.isArray(requiredPulls) || !Array.isArray(observedPulls)) {
    issues.push(
      issue(
        'reconciliation-set-missing',
        'reconciliation.pullRequests',
        'required and observed pull-request sets must be arrays',
      ),
    );
    return;
  }
  if (!Array.isArray(openProtectedPulls)) {
    issues.push(
      issue(
        'reconciliation-open-scope-missing',
        'live.reconciliation.openProtectedPulls',
        'live open protected pull-request enumeration is missing',
      ),
    );
    return;
  }
  uniqueBy(requiredPulls, 'number', 'duplicate-reconciliation-pr', issues);
  uniqueBy(observedPulls, 'number', 'duplicate-live-reconciliation-pr', issues);
  const observedByNumber = new Map(
    observedPulls.map((pull) => [pull.number, pull]),
  );
  for (const required of requiredPulls) {
    const observed = observedByNumber.get(required.number);
    if (!observed) {
      issues.push(
        issue(
          'missing-reconciliation-pr',
          `pullRequests.${required.number}`,
          'required remediation pull request was not observed',
        ),
      );
      continue;
    }
    for (const field of ['number', 'state', 'headRef', 'head']) {
      exact(
        observed[field],
        required[field],
        `reconciliation-pr-${field}-mismatch`,
        `pullRequests.${required.number}.${field}`,
        issues,
      );
    }
    exact(
      observed.baseRef,
      matrix.sourceBinding.protectedBranch,
      'reconciliation-pr-base-mismatch',
      `pullRequests.${required.number}.baseRef`,
      issues,
    );
    if (required.state === 'MERGED') {
      exact(
        observed.mergeCommit,
        required.mergeCommit,
        'reconciliation-pr-merge-mismatch',
        `pullRequests.${required.number}.mergeCommit`,
        issues,
      );
    }
    if (
      required.disposition === 'superseded-by' &&
      (!Number.isInteger(required.successor) || required.successor < 1)
    ) {
      issues.push(
        issue(
          'reconciliation-successor-missing',
          `pullRequests.${required.number}.successor`,
          'superseded pull request has no exact successor identity',
        ),
      );
    }
    if (required.disposition === 'superseded-by') {
      exact(
        observed.successor,
        required.successor,
        'reconciliation-successor-mismatch',
        `pullRequests.${required.number}.successor`,
        issues,
      );
      if (!['CLOSED', 'MERGED'].includes(observed.successorState)) {
        issues.push(
          issue(
            'reconciliation-successor-not-terminal',
            `pullRequests.${required.number}.successorState`,
            'superseding pull request remains actionable',
          ),
        );
      }
      exact(
        observed.successorBaseRef,
        matrix.sourceBinding.protectedBranch,
        'reconciliation-successor-base-mismatch',
        `pullRequests.${required.number}.successorBaseRef`,
        issues,
      );
      for (const field of [
        'successorState',
        'successorHeadRef',
        'successorHead',
        'successorTree',
        'successorMergeCommit',
      ]) {
        exact(
          observed[field] || '',
          required[field] || '',
          `reconciliation-${field}-mismatch`,
          `pullRequests.${required.number}.${field}`,
          issues,
        );
      }
    }
    if (
      !['superseded-by', 'delivered', 'historical-nonmerge'].includes(
        required.disposition,
      )
    ) {
      issues.push(
        issue(
          'reconciliation-disposition-invalid',
          `pullRequests.${required.number}.disposition`,
          'pull request disposition is not terminal',
        ),
      );
    }
  }
  if (observedPulls.length !== requiredPulls.length) {
    issues.push(
      issue(
        'reconciliation-pr-cardinality-mismatch',
        'reconciliation.pullRequests',
        'live remediation pull-request set differs from the matrix',
      ),
    );
  }
  const authority = authoritativePullScope(request, issues);
  const requiredNumbers = new Set(requiredPulls.map(({ number }) => number));
  for (const number of authority.pullNumbers) {
    if (!requiredNumbers.has(number)) {
      issues.push(
        issue(
          'reconciliation-authority-pr-missing',
          `pullRequests.${number}`,
          'immutable Assignment review-baseline pull request is absent',
        ),
      );
    }
  }
  for (const pull of openProtectedPulls) {
    const inScope =
      authority.pullNumbers.has(pull.number) ||
      [...authority.families].some((family) =>
        String(pull.headRef || '').includes(family),
      );
    if (inScope) {
      issues.push(
        issue(
          'reconciliation-in-scope-pr-open',
          `openPullRequests.${pull.number}`,
          `in-scope protected pull request ${pull.headRef} remains open`,
        ),
      );
    }
  }
}

function verifyRequiredArtifact(
  required,
  artifactRule,
  declared,
  observed,
  live,
  references,
  issues,
) {
  const name = artifactRule.nameTemplate
    .replaceAll('{platform}', artifactRule.platform)
    .replaceAll('{commit}', live.source?.head || '');
  const declaredArtifact = (declared.artifacts || []).find(
    (artifact) => artifact.platform === artifactRule.platform,
  );
  const observedArtifact = (observed.artifacts || []).find(
    (artifact) => artifact.name === name,
  );
  if (!declaredArtifact || !observedArtifact) {
    issues.push(
      issue(
        'missing-required-artifact',
        `${required.role}.${artifactRule.platform}`,
        `required live artifact ${name} is absent`,
      ),
    );
    return;
  }
  for (const [field, expected] of [
    ['id', observedArtifact.id],
    ['name', name],
    ['root', observedArtifact.digest],
    ['sizeBytes', observedArtifact.sizeBytes],
  ]) {
    exact(
      declaredArtifact[field],
      expected,
      `artifact-${field}-live-mismatch`,
      `${required.role}.${artifactRule.platform}.${field}`,
      issues,
    );
  }
  exact(
    observedArtifact.workflowRunId,
    observed.runId,
    'artifact-run-mismatch',
    `${required.role}.${artifactRule.platform}.workflowRunId`,
    issues,
  );
  exact(
    observedArtifact.headSha,
    live.source?.head,
    'artifact-head-mismatch',
    `${required.role}.${artifactRule.platform}.headSha`,
    issues,
  );
  if (observedArtifact.expired === true) {
    issues.push(
      issue(
        'artifact-expired',
        `${required.role}.${artifactRule.platform}`,
        `required artifact ${name} has expired`,
      ),
    );
  }
  requiredRoot(
    references,
    declaredArtifact.root,
    `${required.role}.${artifactRule.platform}.root`,
    'artifact-bytes',
    issues,
  );
}

export function verifyLiveRuns(matrix, evidence, live, references, issues) {
  uniqueBy(
    matrix.terminalEvidence.runGroups,
    'role',
    'duplicate-required-run-role',
    issues,
  );
  uniqueBy(evidence.runs, 'role', 'duplicate-run-role', issues);
  uniqueBy(live.runs, 'role', 'duplicate-live-run-role', issues);
  const declaredRuns = new Map(
    (evidence.runs || []).map((entry) => [entry.role, entry]),
  );
  const observedRuns = new Map(
    (live.runs || []).map((entry) => [entry.role, entry]),
  );
  for (const required of matrix.terminalEvidence.runGroups || []) {
    uniqueBy(
      required.requiredArtifacts,
      'platform',
      'duplicate-required-artifact-platform',
      issues,
    );
    const declared = declaredRuns.get(required.role);
    const observed = observedRuns.get(required.role);
    if (!declared || !observed) {
      issues.push(
        issue(
          'missing-run-group',
          required.role,
          `missing declared or observed ${required.role} run`,
        ),
      );
      continue;
    }
    for (const [field, expected] of [
      ['workflowPath', required.workflowPath],
      ['runId', observed.runId],
      ['runAttempt', observed.runAttempt],
      ['event', observed.event],
      ['commit', observed.headSha],
      ['conclusion', observed.conclusion],
    ]) {
      exact(
        declared[field],
        expected,
        `run-${field}-live-mismatch`,
        `${required.role}.${field}`,
        issues,
      );
    }
    exact(
      observed.workflowPath,
      required.workflowPath,
      'run-workflow-mismatch',
      `${required.role}.workflowPath`,
      issues,
    );
    exact(
      observed.headSha,
      live.source?.head,
      'run-head-mismatch',
      `${required.role}.headSha`,
      issues,
    );
    if (!required.events.includes(observed.event)) {
      issues.push(
        issue(
          'run-event-mismatch',
          `${required.role}.event`,
          `event ${observed.event} is outside the declared run contract`,
        ),
      );
    }
    if (!Number.isInteger(observed.runId) || observed.runId < 1) {
      issues.push(
        issue(
          'invalid-run-id',
          `${required.role}.runId`,
          'observed run id must be positive',
        ),
      );
    }
    exact(
      observed.status,
      'completed',
      'run-not-completed',
      `${required.role}.status`,
      issues,
    );
    exact(
      observed.conclusion,
      'success',
      'run-not-successful',
      `${required.role}.conclusion`,
      issues,
    );
    requiredRoot(
      references,
      declared.evidenceRoot,
      `${required.role}.evidenceRoot`,
      'run-snapshot',
      issues,
    );
    uniqueBy(declared.jobs, 'name', 'duplicate-run-job', issues);
    uniqueBy(observed.jobs, 'name', 'duplicate-live-run-job', issues);
    const declaredJobs = new Map(
      (declared.jobs || []).map((job) => [job.name, job]),
    );
    const observedJobs = new Map(
      (observed.jobs || []).map((job) => [job.name, job]),
    );
    for (const jobName of required.requiredJobs || []) {
      const declaredJob = declaredJobs.get(jobName);
      const observedJob = observedJobs.get(jobName);
      if (!declaredJob || !observedJob) {
        issues.push(
          issue(
            'missing-required-job',
            `${required.role}.${jobName}`,
            `required job ${jobName} is absent`,
          ),
        );
        continue;
      }
      exact(
        declaredJob.conclusion,
        observedJob.conclusion,
        'run-job-live-mismatch',
        `${required.role}.${jobName}`,
        issues,
      );
      exact(
        observedJob.conclusion,
        'success',
        'required-job-not-successful',
        `${required.role}.${jobName}`,
        issues,
      );
    }
    uniqueBy(declared.artifacts, 'id', 'duplicate-artifact-id', issues);
    uniqueBy(declared.artifacts, 'name', 'duplicate-artifact-name', issues);
    for (const artifactRule of required.requiredArtifacts || []) {
      verifyRequiredArtifact(
        required,
        artifactRule,
        declared,
        observed,
        live,
        references,
        issues,
      );
    }
  }
}
