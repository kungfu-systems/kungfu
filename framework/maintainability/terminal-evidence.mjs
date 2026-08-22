#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';
import { collectTerminalLiveObservations } from '../terminal-evidence/live-observations.mjs';
import {
  verifyLiveAssignment,
  verifyLiveReconciliation,
  verifyLiveRuns,
} from '../terminal-evidence/live-verification.mjs';
import {
  exact,
  issue,
  requiredRoot,
  uniqueBy,
} from '../terminal-evidence/verification-primitives.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MATRIX_PATH = 'framework/maintainability/terminal-evidence-matrix.json';
const SHA = /^[0-9a-f]{40}$/u;
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EXECUTABLE_INPUTS = [
  MATRIX_PATH,
  'framework/maintainability/terminal-evidence.mjs',
  'framework/terminal-evidence/live-observations.mjs',
  'framework/terminal-evidence/live-verification.mjs',
  'framework/terminal-evidence/verification-primitives.mjs',
];

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

function terminalJson(output, label) {
  const lines = output.split('\n');
  let lineStart = output.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    lineStart -= lines[index].length;
    const indentation = lines[index].length - lines[index].trimStart().length;
    const marker = lines[index][indentation];
    if (marker !== '{' && marker !== '[') {
      lineStart -= 1;
      continue;
    }
    try {
      return JSON.parse(output.slice(lineStart + indentation).trim());
    } catch {
      // Earlier command output may contain bracketed log prefixes.
    }
    lineStart -= 1;
  }
  throw new Error(`${label} did not return terminal JSON`);
}

function assertHeadBoundInputs() {
  const diff = spawnSync(
    'git',
    ['diff', '--quiet', 'HEAD', '--', ...EXECUTABLE_INPUTS],
    { cwd: ROOT, shell: false },
  );
  if (diff.status !== 0) {
    throw new Error('terminal evidence executable inputs differ from HEAD');
  }
  for (const relative of EXECUTABLE_INPUTS) {
    const headBytes = command('git', ['show', `HEAD:${relative}`]);
    const worktreeBytes = fs
      .readFileSync(path.join(ROOT, relative), 'utf8')
      .trimEnd();
    if (headBytes !== worktreeBytes) {
      throw new Error(`${relative} is not byte-bound to HEAD`);
    }
  }
}

function resolveRetainedPath(base, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    throw new Error('retained object path must be archive-relative');
  }
  const canonicalBase = fs.realpathSync(base);
  const candidate = path.resolve(canonicalBase, relative);
  const canonical = fs.realpathSync(candidate);
  if (
    canonical !== canonicalBase &&
    !canonical.startsWith(`${canonicalBase}${path.sep}`)
  ) {
    throw new Error('retained object path escapes the evidence archive');
  }
  return canonical;
}

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function retainedRoot(bytes, object) {
  if (object.rootProtocol === 'raw-bytes') return digestBytes(bytes);
  const document = JSON.parse(bytes.toString('utf8'));
  if (object.rootProtocol === 'canonical-json') {
    return { root: semanticRoot(document), document };
  }
  if (object.rootProtocol === 'canonical-json-without-root-field') {
    const field = object.rootField;
    if (!field || document[field] !== object.root) {
      throw new Error('retained root field does not match object root');
    }
    const preimage = { ...document };
    delete preimage[field];
    return { root: semanticRoot(preimage), document };
  }
  throw new Error(
    `unsupported retained root protocol '${object.rootProtocol}'`,
  );
}

function verifyRetainedBinding(
  object,
  document,
  evidence,
  matrix,
  live,
  issues,
  sealVerification = undefined,
) {
  const mismatch = (code, target, actual, expected) =>
    exact(actual, expected, code, target, issues);
  switch (object.kind) {
    case 'delivery-snapshot':
      mismatch(
        'retained-delivery-schema',
        'delivery.schema',
        document?.schema,
        'kungfu.terminal-delivery-snapshot/v1',
      );
      for (const field of ['pullRequest', 'mergeCommit', 'state']) {
        mismatch(
          `retained-delivery-${field}`,
          `delivery.${field}`,
          document?.[field],
          evidence.delivery?.[field],
        );
      }
      break;
    case 'github-review-snapshot':
      mismatch(
        'retained-review-schema',
        'review.schema',
        document?.schema,
        'kungfu.terminal-github-review-snapshot/v1',
      );
      for (const field of ['reviewId', 'reviewer', 'decision', 'commit']) {
        mismatch(
          `retained-review-${field}`,
          `review.${field}`,
          document?.[field],
          evidence.delivery?.approval?.[field],
        );
      }
      break;
    case 'terminal-review-report':
      mismatch(
        'retained-terminal-review-schema',
        'terminalReview.schema',
        document?.schema,
        'kungfu.terminal-review-report/v1',
      );
      for (const field of [
        'reviewer',
        'verdict',
        'commit',
        'tree',
        'freshContext',
        'maximumOpenSeverity',
      ]) {
        mismatch(
          `retained-terminal-review-${field}`,
          `terminalReview.${field}`,
          document?.[field],
          evidence.review?.[field],
        );
      }
      if ((document?.findings || []).length !== 0) {
        issues.push(
          issue(
            'terminal-review-open-findings',
            'terminalReview.findings',
            'terminal review retains open findings',
          ),
        );
      }
      break;
    case 'terminal-review-attestation-snapshot':
      mismatch(
        'retained-terminal-attestation-schema',
        'terminalReviewAttestation.schema',
        document?.schema,
        'kungfu.terminal-review-attestation-snapshot/v1',
      );
      for (const field of ['commentId', 'author', 'createdAt', 'updatedAt']) {
        mismatch(
          `retained-terminal-attestation-${field}`,
          `terminalReviewAttestation.${field}`,
          document?.[field],
          live.terminalReview?.[field],
        );
      }
      for (const field of [
        'schema',
        'assignmentId',
        'commit',
        'tree',
        'reviewer',
        'verdict',
        'freshContext',
        'maximumOpenSeverity',
        'reportRoot',
      ]) {
        mismatch(
          `retained-terminal-attestation-document-${field}`,
          `terminalReviewAttestation.attestation.${field}`,
          document?.attestation?.[field],
          live.terminalReview?.[field],
        );
      }
      break;
    case 'assignment-request':
      mismatch(
        'retained-request-schema',
        'assignment.request.schema',
        document?.schema,
        'kungfu.assignment-request/v1',
      );
      mismatch(
        'retained-request-assignment',
        'assignment.request.assignmentId',
        document?.workDefinition?.assignment_id,
        matrix.assignmentId,
      );
      mismatch(
        'retained-request-source',
        'assignment.request.sourceId',
        document?.source?.sourceId,
        matrix.assignmentId,
      );
      break;
    case 'assignment-capture':
      mismatch(
        'retained-capture-schema',
        'assignment.capture.schema',
        document?.schema,
        'kungfu.assignment-capture.receipt/v1',
      );
      mismatch(
        'retained-capture-request',
        'assignment.capture.requestRoot',
        document?.requestRoot,
        evidence.assignment?.requestRoot,
      );
      break;
    case 'assignment-claim':
      mismatch(
        'retained-claim-type',
        'assignment.claim.claim_type',
        document?.claim_type,
        'task-completed',
      );
      mismatch(
        'retained-claim-head',
        'assignment.claim.git_commit',
        document?.git_commit,
        live.source?.head,
      );
      if (
        !Array.isArray(document?.assignment_set) ||
        !document.assignment_set.includes(matrix.assignmentId)
      ) {
        issues.push(
          issue(
            'retained-claim-assignment',
            'assignment.claim.assignment_set',
            'completion claim does not include the terminal Assignment',
          ),
        );
      }
      if ((document?.known_gaps || []).length !== 0) {
        issues.push(
          issue(
            'retained-claim-gap',
            'assignment.claim.known_gaps',
            'terminal completion claim retains known gaps',
          ),
        );
      }
      break;
    case 'assignment-review':
      mismatch(
        'retained-native-review-type',
        'assignment.review.review_type',
        document?.review_type,
        'independent-completion-review',
      );
      mismatch(
        'retained-native-reviewer',
        'assignment.review.reviewer',
        document?.reviewer,
        matrix.terminalEvidence.terminalReviewRule.reviewer,
      );
      mismatch(
        'retained-native-review-verdict',
        'assignment.review.verdict',
        document?.verdict,
        matrix.terminalEvidence.terminalReviewRule.verdict,
      );
      mismatch(
        'retained-native-review-source',
        'assignment.review.reviewer_source',
        document?.reviewer_source,
        evidence.review?.root,
      );
      break;
    case 'assignment-decision':
      mismatch(
        'retained-decision-action',
        'assignment.decision.action',
        document?.action,
        'close',
      );
      mismatch(
        'retained-decision-review',
        'assignment.decision.review_root',
        document?.review_root,
        evidence.assignment?.independentReviewRoot,
      );
      if (!/^decision-[0-9a-f]{24}$/u.test(document?.decision_id || '')) {
        issues.push(
          issue(
            'retained-decision-identity',
            'assignment.decision.decision_id',
            'completion decision must retain its native decision identity',
          ),
        );
      }
      break;
    case 'assignment-seal':
    case 'dependency-seal':
    case 'predecessor-seal': {
      const expectedAssignment =
        object.kind === 'assignment-seal'
          ? matrix.assignmentId
          : object.kind === 'predecessor-seal'
            ? matrix.predecessor.assignmentId
            : object.assignmentId;
      mismatch(
        'retained-seal-schema',
        `${object.kind}.schema`,
        document?.schema,
        'kungfu.assignment-orchestration.sealed-state/v1',
      );
      mismatch(
        'retained-seal-assignment',
        `${object.kind}.assignment`,
        document?.assignment?.assignment_id,
        expectedAssignment,
      );
      if (!ROOT_PATTERN.test(document?.query_proof_root || '')) {
        issues.push(
          issue(
            'retained-seal-query-proof-missing',
            `${object.kind}.query_proof_root`,
            'sealed Assignment has no exact native query-proof root',
          ),
        );
      }
      if (!ROOT_PATTERN.test(document?.assignment?.request_root || '')) {
        issues.push(
          issue(
            'retained-seal-request-root-missing',
            `${object.kind}.assignment.request_root`,
            'sealed Assignment has no exact request root',
          ),
        );
      }
      if (
        !Array.isArray(document?.assignment?.capture_receipt_roots) ||
        document.assignment.capture_receipt_roots.length === 0 ||
        document.assignment.capture_receipt_roots.some(
          (root) => !ROOT_PATTERN.test(root),
        )
      ) {
        issues.push(
          issue(
            'retained-seal-capture-root-missing',
            `${object.kind}.assignment.capture_receipt_roots`,
            'sealed Assignment has no exact capture receipt roots',
          ),
        );
      }
      if (document?.phase !== 'continuation-decided') {
        issues.push(
          issue(
            'retained-seal-not-terminal',
            `${object.kind}.phase`,
            `sealed Assignment phase is ${String(document?.phase)}`,
          ),
        );
      }
      for (const field of [
        'completion_claims',
        'independent_reviews',
        'continuation_decisions',
      ]) {
        if (
          !Number.isInteger(document?.counts?.[field]) ||
          document.counts[field] < 1
        ) {
          issues.push(
            issue(
              'retained-seal-terminal-chain-incomplete',
              `${object.kind}.counts.${field}`,
              `sealed Assignment has no ${field}`,
            ),
          );
        }
      }
      if (sealVerification?.ok !== true) {
        issues.push(
          issue(
            'retained-seal-native-verification-failed',
            object.path,
            'exact retained seal did not pass native verify-seal',
          ),
        );
      }
      mismatch(
        'retained-seal-native-root-mismatch',
        `${object.kind}.state_root`,
        sealVerification?.state_root,
        object.root,
      );
      mismatch(
        'retained-seal-native-phase-mismatch',
        `${object.kind}.verified_phase`,
        sealVerification?.phase,
        'continuation-decided',
      );
      if (
        !Array.isArray(sealVerification?.next_actions) ||
        sealVerification.next_actions.length !== 0
      ) {
        issues.push(
          issue(
            'retained-seal-native-actions-present',
            `${object.kind}.next_actions`,
            'native seal verification retains actions or omitted next_actions',
          ),
        );
      }
      break;
    }
    case 'run-snapshot': {
      const run = (evidence.runs || []).find(
        ({ evidenceRoot }) => evidenceRoot === object.root,
      );
      mismatch(
        'retained-run-schema',
        'run.schema',
        document?.schema,
        'kungfu.terminal-run-snapshot/v1',
      );
      for (const field of [
        'role',
        'workflowPath',
        'runId',
        'runAttempt',
        'event',
        'commit',
        'conclusion',
      ]) {
        mismatch(
          `retained-run-${field}`,
          `run.${field}`,
          document?.[field],
          run?.[field],
        );
      }
      mismatch(
        'retained-run-live-head',
        'run.commit',
        document?.commit,
        live.source?.head,
      );
      break;
    }
    case 'artifact-bytes':
      if (document !== undefined) {
        issues.push(
          issue(
            'artifact-protocol-mismatch',
            object.path,
            'artifact bytes must use the raw-bytes protocol',
          ),
        );
      }
      break;
    default:
      issues.push(
        issue(
          'unknown-retained-kind',
          object.path,
          `unsupported retained object kind '${String(object.kind)}'`,
        ),
      );
  }
}

function requiredArray(value, target, issues) {
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        'required-v4-field-missing',
        target,
        `${target} must be an explicit array`,
      ),
    );
    return [];
  }
  return value;
}

function retainedDocument(root, kind, retained, readBytes, issues) {
  const object = retained.get(root);
  if (!object || object.kind !== kind) {
    issues.push(
      issue(
        'retained-authority-missing',
        root || kind,
        `retained ${kind} authority is missing`,
      ),
    );
    return undefined;
  }
  try {
    const result = retainedRoot(readBytes(object.path), object);
    if (typeof result === 'string' || result.root !== root) {
      throw new Error(`${kind} authority root does not match retained bytes`);
    }
    return result.document;
  } catch (error) {
    issues.push(
      issue(
        'retained-authority-unreadable',
        object.path || root,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return undefined;
  }
}

function verifyDependencyAuthority(
  matrix,
  evidence,
  request,
  references,
  issues,
) {
  const matrixDependencies = requiredArray(
    matrix.dependencies,
    'matrix.dependencies',
    issues,
  );
  const evidenceDependencies = requiredArray(
    evidence.dependencies,
    'evidence.dependencies',
    issues,
  );
  const requestDependencies = requiredArray(
    request?.workDefinition?.dependency_identities,
    'assignment.request.workDefinition.dependency_identities',
    issues,
  );
  const requestIdentities = [
    request?.workDefinition?.parent_assignment_identity?.assignment_id,
    ...requestDependencies.map(({ assignment_id }) => assignment_id),
  ];
  if (requestIdentities.some((identity) => !identity)) {
    issues.push(
      issue(
        'request-dependency-identity-missing',
        'assignment.request.workDefinition',
        'parent or dependency Assignment identity is absent',
      ),
    );
  }
  uniqueBy(
    matrixDependencies,
    'requiredAssignmentId',
    'duplicate-required-dependency',
    issues,
  );
  uniqueBy(matrixDependencies, 'assignmentId', 'duplicate-dependency', issues);
  uniqueBy(
    matrixDependencies,
    'sealedStateRoot',
    'duplicate-dependency-seal',
    issues,
  );
  uniqueBy(
    evidenceDependencies,
    'requiredAssignmentId',
    'duplicate-evidence-required-dependency',
    issues,
  );
  uniqueBy(
    evidenceDependencies,
    'assignmentId',
    'duplicate-evidence-dependency',
    issues,
  );
  uniqueBy(
    evidenceDependencies,
    'sealedStateRoot',
    'duplicate-evidence-dependency-seal',
    issues,
  );
  const authoritySet = [...new Set(requestIdentities)].sort();
  const matrixAuthoritySet = matrixDependencies
    .map(({ requiredAssignmentId }) => requiredAssignmentId)
    .sort();
  if (JSON.stringify(matrixAuthoritySet) !== JSON.stringify(authoritySet)) {
    issues.push(
      issue(
        'dependency-authority-set-mismatch',
        'matrix.dependencies',
        'matrix dependency authority set differs from immutable request',
      ),
    );
  }
  const declaredDependencies = new Map(
    evidenceDependencies.map((dependency) => [
      dependency.requiredAssignmentId,
      dependency,
    ]),
  );
  for (const dependency of matrixDependencies) {
    const declared = declaredDependencies.get(dependency.requiredAssignmentId);
    if (!declared) {
      issues.push(
        issue(
          'missing-dependency',
          dependency.requiredAssignmentId,
          'required terminal dependency or declared successor is absent',
        ),
      );
      continue;
    }
    for (const field of [
      'requiredAssignmentId',
      'assignmentId',
      'sealedStateRoot',
    ]) {
      exact(
        declared[field],
        dependency[field],
        `dependency-${field}-mismatch`,
        `${dependency.requiredAssignmentId}.${field}`,
        issues,
      );
    }
    requiredRoot(
      references,
      declared.sealedStateRoot,
      `${dependency.requiredAssignmentId}.sealedStateRoot`,
      'dependency-seal',
      issues,
    );
  }
  if (
    evidenceDependencies.length !== matrixDependencies.length ||
    matrixDependencies.length !== authoritySet.length
  ) {
    issues.push(
      issue(
        'dependency-cardinality-mismatch',
        'dependencies',
        'request, matrix, and evidence dependency sets differ',
      ),
    );
  }
}

/**
 * Verify one terminal evidence set against facts observed outside the set.
 *
 * `readBytes` is injectable so negative tests can prove root handling without
 * touching the checkout. Production callers read the retained paths directly.
 */
export function verifyTerminalEvidence(
  matrix,
  evidence,
  live,
  readBytes = (relative) => fs.readFileSync(path.resolve(relative)),
  verifySeal = undefined,
) {
  const issues = [];
  const references = new Map();
  const retainedObjects = requiredArray(
    evidence.retainedObjects,
    'evidence.retainedObjects',
    issues,
  );
  const retained = new Map(retainedObjects.map((entry) => [entry.root, entry]));
  const request = retainedDocument(
    evidence.assignment?.requestRoot,
    'assignment-request',
    retained,
    readBytes,
    issues,
  );
  requiredArray(
    matrix.terminalEvidence?.runGroups,
    'matrix.terminalEvidence.runGroups',
    issues,
  );
  requiredArray(evidence.runs, 'evidence.runs', issues);
  requiredArray(
    matrix.reconciliation?.pullRequests,
    'matrix.reconciliation.pullRequests',
    issues,
  );
  exact(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v4',
    'matrix-schema',
    'matrix.schema',
    issues,
  );
  exact(
    evidence.schema,
    matrix.terminalEvidence.schema,
    'evidence-schema',
    'evidence.schema',
    issues,
  );
  exact(
    evidence.assignmentId,
    matrix.assignmentId,
    'assignment-identity-mismatch',
    'assignmentId',
    issues,
  );
  if ((matrix.exceptions || []).length !== 0) {
    issues.push(
      issue(
        'terminal-exception-present',
        'matrix.exceptions',
        'terminal closure does not admit exceptions',
      ),
    );
  }
  exact(
    live.schema,
    'kungfu.terminal-live-observations/v1',
    'live-schema',
    'live.schema',
    issues,
  );
  if (!SHA.test(live.source?.head || '')) {
    issues.push(
      issue('invalid-live-head', 'live.source.head', 'live HEAD is not exact'),
    );
  }
  exact(
    evidence.source?.commit,
    live.source?.head,
    'source-head-mismatch',
    'source.commit',
    issues,
  );
  exact(
    evidence.source?.commit,
    live.source?.protectedCommit,
    'protected-head-mismatch',
    'source.commit',
    issues,
  );
  exact(
    evidence.source?.tree,
    live.source?.headTree,
    'source-tree-mismatch',
    'source.tree',
    issues,
  );
  exact(
    live.source?.headTree,
    live.source?.protectedTree,
    'protected-tree-mismatch',
    'live.source.protectedTree',
    issues,
  );
  exact(
    live.source?.protectedCommitEnd,
    live.source?.protectedCommit,
    'protected-head-toctou',
    'live.source.protectedCommitEnd',
    issues,
  );
  exact(
    live.source?.protectedTreeEnd,
    live.source?.protectedTree,
    'protected-tree-toctou',
    'live.source.protectedTreeEnd',
    issues,
  );
  exact(
    evidence.source?.repository,
    matrix.sourceBinding.repository,
    'repository-mismatch',
    'source.repository',
    issues,
  );
  exact(
    evidence.source?.protectedBranch,
    matrix.sourceBinding.protectedBranch,
    'protected-branch-mismatch',
    'source.protectedBranch',
    issues,
  );

  exact(
    evidence.delivery?.pullRequest,
    live.delivery?.pullRequest,
    'delivery-pr-mismatch',
    'delivery.pullRequest',
    issues,
  );
  exact(
    evidence.delivery?.mergeCommit,
    live.delivery?.mergeCommit,
    'delivery-merge-mismatch',
    'delivery.mergeCommit',
    issues,
  );
  exact(
    evidence.delivery?.mergeCommit,
    live.source?.head,
    'delivery-not-live-head',
    'delivery.mergeCommit',
    issues,
  );
  exact(
    evidence.delivery?.state,
    'MERGED',
    'delivery-not-merged',
    'delivery.state',
    issues,
  );
  exact(
    evidence.delivery?.state,
    live.delivery?.state,
    'delivery-state-mismatch',
    'delivery.state',
    issues,
  );
  requiredRoot(
    references,
    evidence.delivery?.evidenceRoot,
    'delivery.evidenceRoot',
    'delivery-snapshot',
    issues,
  );
  exact(
    live.delivery?.baseRef,
    matrix.sourceBinding.protectedBranch,
    'delivery-base-mismatch',
    'live.delivery.baseRef',
    issues,
  );
  exact(
    live.delivery?.pullRequestTree,
    live.source?.headTree,
    'delivery-tested-tree-mismatch',
    'live.delivery.pullRequestTree',
    issues,
  );
  exact(
    live.delivery?.mergeTree,
    live.source?.headTree,
    'delivery-merge-tree-mismatch',
    'live.delivery.mergeTree',
    issues,
  );
  const pullReviewRule = matrix.terminalEvidence.pullRequestReviewRule;
  for (const field of ['reviewId', 'reviewer', 'decision', 'commit']) {
    exact(
      evidence.delivery?.approval?.[field],
      live.delivery?.approval?.[field],
      `pull-review-${field}-mismatch`,
      `delivery.approval.${field}`,
      issues,
    );
  }
  exact(
    evidence.delivery?.approval?.reviewer,
    pullReviewRule.reviewer,
    'pull-reviewer-mismatch',
    'delivery.approval.reviewer',
    issues,
  );
  exact(
    evidence.delivery?.approval?.decision,
    pullReviewRule.decision,
    'pull-review-decision-mismatch',
    'delivery.approval.decision',
    issues,
  );
  exact(
    live.delivery?.approval?.tree,
    live.source?.headTree,
    'pull-review-tree-mismatch',
    'live.delivery.approval.tree',
    issues,
  );
  requiredRoot(
    references,
    evidence.delivery?.approval?.root,
    'delivery.approval.root',
    'github-review-snapshot',
    issues,
  );

  const terminalReviewRule = matrix.terminalEvidence.terminalReviewRule;
  exact(
    live.terminalReview?.schema,
    terminalReviewRule.attestationSchema,
    'review-attestation-schema-mismatch',
    'live.terminalReview.schema',
    issues,
  );
  exact(
    live.terminalReview?.assignmentId,
    matrix.assignmentId,
    'review-attestation-assignment-mismatch',
    'live.terminalReview.assignmentId',
    issues,
  );
  exact(
    live.terminalReview?.commit,
    live.source?.head,
    'review-attestation-head-mismatch',
    'live.terminalReview.commit',
    issues,
  );
  exact(
    live.terminalReview?.tree,
    live.source?.headTree,
    'review-attestation-tree-mismatch',
    'live.terminalReview.tree',
    issues,
  );
  exact(
    live.terminalReview?.author,
    terminalReviewRule.reviewer,
    'review-attestation-author-mismatch',
    'live.terminalReview.author',
    issues,
  );
  exact(
    live.terminalReview?.reviewer,
    terminalReviewRule.reviewer,
    'review-attestation-reviewer-mismatch',
    'live.terminalReview.reviewer',
    issues,
  );
  exact(
    live.terminalReview?.verdict,
    terminalReviewRule.verdict,
    'review-attestation-verdict-mismatch',
    'live.terminalReview.verdict',
    issues,
  );
  exact(
    live.terminalReview?.freshContext,
    terminalReviewRule.freshContext,
    'review-attestation-fresh-context-mismatch',
    'live.terminalReview.freshContext',
    issues,
  );
  exact(
    live.terminalReview?.maximumOpenSeverity,
    terminalReviewRule.maximumOpenSeverity,
    'review-attestation-severity-mismatch',
    'live.terminalReview.maximumOpenSeverity',
    issues,
  );
  exact(
    evidence.review?.root,
    live.terminalReview?.reportRoot,
    'review-attestation-root-mismatch',
    'review.root',
    issues,
  );
  exact(
    evidence.review?.reviewer,
    terminalReviewRule.reviewer,
    'reviewer-mismatch',
    'review.reviewer',
    issues,
  );
  exact(
    evidence.review?.verdict,
    terminalReviewRule.verdict,
    'review-verdict-mismatch',
    'review.verdict',
    issues,
  );
  exact(
    evidence.review?.commit,
    live.source?.head,
    'review-head-mismatch',
    'review.commit',
    issues,
  );
  exact(
    evidence.review?.tree,
    live.source?.headTree,
    'review-tree-mismatch',
    'review.tree',
    issues,
  );
  exact(
    evidence.review?.freshContext,
    terminalReviewRule.freshContext,
    'review-not-fresh',
    'review.freshContext',
    issues,
  );
  exact(
    evidence.review?.maximumOpenSeverity,
    terminalReviewRule.maximumOpenSeverity,
    'review-open-severity',
    'review.maximumOpenSeverity',
    issues,
  );
  if (!Number.isInteger(live.terminalReview?.commentId)) {
    issues.push(
      issue(
        'review-attestation-comment-missing',
        'live.terminalReview.commentId',
        'terminal review attestation has no live GitHub comment identity',
      ),
    );
  }
  requiredRoot(
    references,
    evidence.review?.root,
    'review.root',
    'terminal-review-report',
    issues,
  );
  requiredRoot(
    references,
    evidence.review?.attestationRoot,
    'review.attestationRoot',
    'terminal-review-attestation-snapshot',
    issues,
  );

  verifyLiveAssignment(matrix, evidence, live, references, issues);
  verifyLiveReconciliation(matrix, live, request, issues);
  verifyDependencyAuthority(matrix, evidence, request, references, issues);
  exact(
    evidence.predecessor?.assignmentId,
    matrix.predecessor.assignmentId,
    'predecessor-identity-mismatch',
    'predecessor.assignmentId',
    issues,
  );
  exact(
    evidence.predecessor?.sealedStateRoot,
    matrix.predecessor.sealedStateRoot,
    'predecessor-seal-mismatch',
    'predecessor.sealedStateRoot',
    issues,
  );
  requiredRoot(
    references,
    evidence.predecessor?.sealedStateRoot,
    'predecessor.sealedStateRoot',
    'predecessor-seal',
    issues,
  );

  verifyLiveRuns(matrix, evidence, live, references, issues);

  uniqueBy(retainedObjects, 'root', 'duplicate-retained-root', issues);
  for (const [root, reference] of references) {
    const object = retained.get(root);
    if (!object) {
      issues.push(
        issue(
          'missing-retained-bytes',
          root,
          `declared root ${root} has no retained bytes`,
        ),
      );
      continue;
    }
    if (object.kind !== reference.kind) {
      issues.push(
        issue(
          'retained-kind-mismatch',
          object.path || root,
          `retained object is ${String(object.kind)}, expected ${reference.kind}`,
        ),
      );
    }
    try {
      const result = retainedRoot(readBytes(object.path), object);
      const actual = typeof result === 'string' ? result : result.root;
      exact(
        actual,
        root,
        'retained-root-mismatch',
        object.path || root,
        issues,
      );
      let sealVerification;
      if (
        ['assignment-seal', 'dependency-seal', 'predecessor-seal'].includes(
          object.kind,
        )
      ) {
        if (typeof verifySeal !== 'function') {
          issues.push(
            issue(
              'native-seal-verifier-missing',
              object.path || root,
              'native verify-seal callback is required',
            ),
          );
        } else {
          try {
            sealVerification = verifySeal(object.path);
          } catch (error) {
            issues.push(
              issue(
                'native-seal-verification-error',
                object.path || root,
                error instanceof Error ? error.message : String(error),
              ),
            );
          }
        }
      }
      verifyRetainedBinding(
        object,
        typeof result === 'string' ? undefined : result.document,
        evidence,
        matrix,
        live,
        issues,
        sealVerification,
      );
    } catch (error) {
      issues.push(
        issue(
          'retained-bytes-unreadable',
          object.path || root,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return {
    schema: 'kungfu.terminal-evidence-verification/v1',
    verdict: issues.length ? 'fail' : 'pass',
    sourceCommit: live.source?.head,
    liveObservationRoot: semanticRoot(live),
    verifiedRoots: references.size,
    issues,
  };
}

function parseArgs(argv) {
  const options = { evidence: '', delivery: '', protectedRef: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--evidence') options.evidence = argv[++index] || '';
    else if (value === '--delivery') options.delivery = argv[++index] || '';
    else if (value === '--protected-ref')
      options.protectedRef = argv[++index] || '';
    else throw new Error(`unknown argument '${value}'`);
  }
  if (!options.evidence || !options.delivery || !options.protectedRef) {
    throw new Error('--evidence, --delivery, and --protected-ref are required');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertHeadBoundInputs();
  const matrix = JSON.parse(
    fs.readFileSync(path.join(ROOT, MATRIX_PATH), 'utf8'),
  );
  const evidencePath = path.resolve(options.evidence);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  const delivery = JSON.parse(
    fs.readFileSync(path.resolve(options.delivery), 'utf8'),
  );
  if (semanticRoot(delivery) !== evidence.delivery?.evidenceRoot) {
    throw new Error('delivery input does not match the retained delivery root');
  }
  const expectedProtectedRef = `refs/remotes/origin/${matrix.sourceBinding.protectedBranch}`;
  if (options.protectedRef !== expectedProtectedRef) {
    throw new Error(`protected ref must be ${expectedProtectedRef}`);
  }
  const localProtectedCommit = command('git', [
    'rev-parse',
    options.protectedRef,
  ]);
  const live = collectTerminalLiveObservations(matrix, evidence);
  if (
    localProtectedCommit !== live.source?.protectedCommit ||
    localProtectedCommit !== live.source?.protectedCommitEnd
  ) {
    throw new Error('local and live protected refs do not identify one cut');
  }
  const report = verifyTerminalEvidence(
    matrix,
    evidence,
    live,
    (relative) =>
      fs.readFileSync(
        resolveRetainedPath(path.dirname(evidencePath), relative),
      ),
    (relative) => {
      const sealPath = resolveRetainedPath(
        path.dirname(evidencePath),
        relative,
      );
      return terminalJson(
        command(path.join(ROOT, 'shifu'), ['work', 'verify-seal', sealPath]),
        'kungfu work verify-seal',
      );
    },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.issues.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `terminal evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

export { digestBytes, resolveRetainedPath };
