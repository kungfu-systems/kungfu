#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function command(program, args, cwd = ROOT) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${program} ${args.join(' ')} failed: ${(
        result.stderr || result.stdout || ''
      ).trim()}`,
    );
  }
  return result.stdout.trim();
}

function jsonOutput(output, label) {
  const starts = [];
  for (const match of output.matchAll(/(?:^|\n)\s*([\[{])/gu)) {
    starts.push((match.index || 0) + match[0].lastIndexOf(match[1]));
  }
  for (const start of starts.reverse()) {
    try {
      return JSON.parse(output.slice(start).trim());
    } catch {
      // Earlier tool output may contain bracketed log prefixes.
    }
  }
  throw new Error(`${label} did not return a terminal JSON document`);
}

function git(args) {
  return command('git', args);
}

function gh(endpoint) {
  return jsonOutput(command('gh', ['api', endpoint]), `gh api ${endpoint}`);
}

function gitTree(commit) {
  return git(['rev-parse', `${commit}^{tree}`]);
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function githubTree(repository, commit, observe = gh) {
  return observe(
    `/repos/${repository}/git/commits/${encodeURIComponent(commit)}`,
  ).tree?.sha;
}

function canonicalSealPath(root) {
  if (!ROOT_PATTERN.test(root || '')) {
    throw new Error('Assignment seal root is not exact');
  }
  const digest = root.slice('sha256:'.length);
  const commonDir = path.resolve(ROOT, git(['rev-parse', '--git-common-dir']));
  return path.join(
    commonDir,
    'kungfu',
    'assignment-states',
    'sha256',
    digest.slice(0, 2),
    digest,
    'state.json',
  );
}

function latest(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`native Assignment has no ${label}`);
  }
  return values.at(-1);
}

function observeAssignment(matrix, evidence) {
  const initiativeId = evidence.assignment?.initiativeId;
  const assignmentId = evidence.assignment?.assignmentId;
  if (!initiativeId || !assignmentId) {
    throw new Error(
      'evidence must identify the native Initiative and Assignment',
    );
  }
  const status = jsonOutput(
    command(path.join(ROOT, 'shifu'), [
      'work',
      'status',
      '--workspace',
      ROOT,
      '--initiative-id',
      initiativeId,
      '--assignment-id',
      assignmentId,
    ]),
    'kungfu work status',
  );
  const claim = latest(status.completion_claims, 'completion claim');
  const review = latest(status.independent_reviews, 'independent review');
  const decision = latest(
    status.continuation_decisions,
    'continuation decision',
  );
  const sealPath = canonicalSealPath(evidence.assignment?.sealedStateRoot);
  if (!fs.existsSync(sealPath)) {
    throw new Error(`canonical Assignment seal is missing: ${sealPath}`);
  }
  const verification = jsonOutput(
    command(path.join(ROOT, 'shifu'), ['work', 'verify-seal', sealPath]),
    'kungfu work verify-seal',
  );
  const seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  return {
    initiativeId,
    assignmentId,
    workspaceIdentityRoot:
      status.assignment?.owning_workspace_identity_root || '',
    phase: status.phase,
    status: status.assignment?.status || '',
    requestRoot: status.assignment?.request_root || '',
    captureReceiptRoot:
      (status.assignment?.capture_receipt_roots || []).at(-1) || '',
    gitCommit: claim.git_commit || '',
    completionClaimRoot: semanticRoot(claim),
    independentReviewRoot: semanticRoot(review),
    completionDecisionRoot: semanticRoot(decision),
    reviewer: review.reviewer || '',
    reviewerSource: review.reviewer_source || '',
    reviewVerdict: review.verdict || '',
    decisionAction: decision.action || '',
    sealedStateRoot: verification.state_root || '',
    queryProofRoot: status.query_proof_root || '',
    sealedQueryProofRoot: seal.query_proof_root || '',
    sealVerified: verification.ok === true,
    nextActions: verification.next_actions || [],
    sealedAssignmentId: seal.assignment?.assignment_id || '',
    sealedPhase: seal.phase || '',
    statusCounts: {
      completion_claims: status.completion_claim_count,
      independent_reviews: status.independent_review_count,
      continuation_decisions: status.continuation_decision_count,
    },
    sealedCounts: seal.counts || {},
  };
}

function observeDelivery(matrix, head, headTree) {
  const repository = matrix.sourceBinding.repository;
  const encoded = encodeURIComponent(head);
  const pulls = gh(`/repos/${repository}/commits/${encoded}/pulls`);
  const pull = (Array.isArray(pulls) ? pulls : []).find(
    (candidate) =>
      candidate?.merged_at &&
      candidate?.merge_commit_sha === head &&
      candidate?.base?.ref === matrix.sourceBinding.protectedBranch,
  );
  if (!pull) {
    throw new Error('live protected HEAD has no exact merged pull request');
  }
  const pullHead = pull.head?.sha || '';
  const pullHeadTree = githubTree(repository, pullHead);
  if (pullHeadTree !== headTree) {
    throw new Error(
      'approved pull-request tree differs from live protected tree',
    );
  }
  const rule = matrix.terminalEvidence.pullRequestReviewRule;
  const reviews = gh(
    `/repos/${repository}/pulls/${pull.number}/reviews?per_page=100`,
  );
  const approval = (Array.isArray(reviews) ? reviews : [])
    .filter(
      (review) =>
        review?.user?.login === rule.reviewer &&
        review?.state === rule.decision &&
        githubTree(repository, review.commit_id || '') === headTree,
    )
    .sort((left, right) =>
      String(left.submitted_at).localeCompare(String(right.submitted_at)),
    )
    .at(-1);
  if (!approval) {
    throw new Error(
      'exact pull-request tree has no required independent approval',
    );
  }
  return {
    pullRequest: pull.number,
    state: pull.state === 'closed' && pull.merged_at ? 'MERGED' : pull.state,
    baseRef: pull.base?.ref || '',
    pullRequestHead: pullHead,
    pullRequestTree: pullHeadTree,
    mergeCommit: pull.merge_commit_sha || '',
    mergeTree: githubTree(repository, pull.merge_commit_sha || ''),
    approval: {
      reviewId: approval.id,
      reviewer: approval.user?.login || '',
      decision: approval.state || '',
      commit: approval.commit_id || '',
      tree: githubTree(repository, approval.commit_id || ''),
      submittedAt: approval.submitted_at || '',
    },
  };
}

function observeReconciliation(matrix, observe = gh) {
  const repository = matrix.sourceBinding.repository;
  const pulls = new Map();
  const observePull = (number) => {
    if (!pulls.has(number)) {
      pulls.set(number, observe(`/repos/${repository}/pulls/${number}`));
    }
    return pulls.get(number);
  };
  const declaredPulls = requiredArray(
    matrix.reconciliation?.pullRequests,
    'matrix.reconciliation.pullRequests',
  ).map((required) => {
    const pull = observePull(required.number);
    const successor = required.successor
      ? observePull(required.successor)
      : undefined;
    return {
      number: pull.number,
      state:
        pull.state === 'closed' && pull.merged_at
          ? 'MERGED'
          : pull.state?.toUpperCase() || '',
      baseRef: pull.base?.ref || '',
      headRef: pull.head?.ref || '',
      head: pull.head?.sha || '',
      mergeCommit: pull.merge_commit_sha || '',
      ...(successor
        ? {
            successor: successor.number,
            successorState:
              successor.state === 'closed' && successor.merged_at
                ? 'MERGED'
                : successor.state?.toUpperCase() || '',
            successorBaseRef: successor.base?.ref || '',
            successorHeadRef: successor.head?.ref || '',
            successorHead: successor.head?.sha || '',
            successorTree: githubTree(
              repository,
              successor.head?.sha || '',
              observe,
            ),
            successorMergeCommit: successor.merged_at
              ? successor.merge_commit_sha || ''
              : '',
          }
        : {}),
    };
  });
  const openPullPayload = requiredArray(
    observe(
      `/repos/${repository}/pulls?state=open&base=${encodeURIComponent(
        matrix.sourceBinding.protectedBranch,
      )}&per_page=100`,
    ),
    'GitHub open protected pull requests',
  );
  if (openPullPayload.length === 100) {
    throw new Error(
      'open protected pull-request enumeration reached its hard page bound',
    );
  }
  const openProtectedPulls = openPullPayload.map((pull) => ({
    number: pull.number,
    state: pull.state?.toUpperCase() || '',
    baseRef: pull.base?.ref || '',
    headRef: pull.head?.ref || '',
    head: pull.head?.sha || '',
    headTree: githubTree(repository, pull.head?.sha || '', observe),
    title: pull.title || '',
  }));
  return { declaredPulls, openProtectedPulls };
}

function terminalReviewAttestation(body) {
  try {
    const value = JSON.parse(String(body || '').trim());
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function observeTerminalReview(matrix, pullRequest, head, headTree) {
  const repository = matrix.sourceBinding.repository;
  const rule = matrix.terminalEvidence.terminalReviewRule;
  const comments = gh(
    `/repos/${repository}/issues/${pullRequest}/comments?per_page=100`,
  );
  const attestation = (Array.isArray(comments) ? comments : [])
    .map((comment) => ({
      comment,
      document: terminalReviewAttestation(comment?.body),
    }))
    .filter(
      ({ comment, document }) =>
        comment?.user?.login === rule.reviewer &&
        document?.schema === rule.attestationSchema &&
        document?.assignmentId === matrix.assignmentId &&
        document?.commit === head &&
        document?.tree === headTree &&
        document?.reviewer === rule.reviewer &&
        document?.verdict === rule.verdict &&
        document?.freshContext === rule.freshContext &&
        document?.maximumOpenSeverity === rule.maximumOpenSeverity &&
        ROOT_PATTERN.test(document?.reportRoot || ''),
    )
    .sort(({ comment: left }, { comment: right }) =>
      String(left.created_at).localeCompare(String(right.created_at)),
    )
    .at(-1);
  if (!attestation) {
    throw new Error(
      'live protected cut has no independent terminal review attestation',
    );
  }
  return {
    commentId: attestation.comment.id,
    author: attestation.comment.user?.login || '',
    createdAt: attestation.comment.created_at || '',
    updatedAt: attestation.comment.updated_at || '',
    url: attestation.comment.html_url || '',
    ...attestation.document,
  };
}

function observeRun(matrix, declared, observe = gh) {
  const repository = matrix.sourceBinding.repository;
  if (!Number.isInteger(declared.runAttempt) || declared.runAttempt < 1) {
    throw new Error(`${declared.role} run attempt must be a positive integer`);
  }
  const attemptEndpoint = `/repos/${repository}/actions/runs/${declared.runId}/attempts/${declared.runAttempt}`;
  const run = observe(attemptEndpoint);
  const jobsPayload = observe(`${attemptEndpoint}/jobs?per_page=100`);
  const artifactsPayload = observe(
    `/repos/${repository}/actions/runs/${declared.runId}/artifacts?per_page=100`,
  );
  return {
    role: declared.role,
    workflowPath: run.path || '',
    runId: run.id,
    runAttempt: run.run_attempt,
    event: run.event || '',
    headSha: run.head_sha || '',
    headBranch: run.head_branch || '',
    status: run.status || '',
    conclusion: run.conclusion || '',
    jobs: (jobsPayload.jobs || []).map((job) => ({
      id: job.id,
      name: job.name || '',
      status: job.status || '',
      conclusion: job.conclusion || '',
    })),
    artifacts: (artifactsPayload.artifacts || []).map((artifact) => ({
      id: artifact.id,
      name: artifact.name || '',
      digest: artifact.digest || '',
      sizeBytes: artifact.size_in_bytes,
      expired: artifact.expired === true,
      workflowRunId: artifact.workflow_run?.id,
      headSha: artifact.workflow_run?.head_sha || '',
    })),
  };
}

function observeProtectedSource(matrix, observe = gh) {
  const repository = matrix.sourceBinding.repository;
  const ref = observe(
    `/repos/${repository}/git/ref/heads/${encodeURIComponent(
      matrix.sourceBinding.protectedBranch,
    )}`,
  );
  const commit = ref.object?.sha || '';
  return { commit, tree: githubTree(repository, commit, observe) };
}

export function collectTerminalLiveObservations(
  matrix,
  evidence,
  observe = gh,
) {
  requiredArray(evidence.runs, 'evidence.runs');
  const head = git(['rev-parse', 'HEAD']);
  const headTree = gitTree(head);
  const protectedStart = observeProtectedSource(matrix, observe);
  const delivery = observeDelivery(matrix, head, headTree);
  const reconciliation = observeReconciliation(matrix, observe);
  const terminalReview = observeTerminalReview(
    matrix,
    delivery.pullRequest,
    head,
    headTree,
  );
  const assignment = observeAssignment(matrix, evidence);
  const runs = evidence.runs.map((run) => observeRun(matrix, run, observe));
  const protectedEnd = observeProtectedSource(matrix, observe);
  return {
    schema: 'kungfu.terminal-live-observations/v1',
    observedAt: new Date().toISOString(),
    source: {
      repository: matrix.sourceBinding.repository,
      protectedBranch: matrix.sourceBinding.protectedBranch,
      head,
      headTree,
      protectedCommit: protectedStart.commit,
      protectedTree: protectedStart.tree,
      protectedCommitEnd: protectedEnd.commit,
      protectedTreeEnd: protectedEnd.tree,
    },
    delivery,
    reconciliation,
    terminalReview,
    assignment,
    runs,
  };
}

export {
  jsonOutput as parseCommandJson,
  observeRun,
  observeReconciliation,
  terminalReviewAttestation as parseTerminalReviewAttestation,
};
