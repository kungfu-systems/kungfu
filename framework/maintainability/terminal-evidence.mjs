#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';
import { collectTerminalLiveObservations } from '../terminal-evidence/live-observations.mjs';
import {
  verifyLiveAssignment,
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
    case 'predecessor-seal': {
      const expectedAssignment =
        object.kind === 'assignment-seal'
          ? matrix.assignmentId
          : matrix.predecessor.assignmentId;
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
      if (
        object.kind === 'assignment-seal' &&
        document?.phase !== 'continuation-decided'
      ) {
        issues.push(
          issue(
            'retained-seal-not-terminal',
            'assignment.seal.phase',
            `sealed Assignment phase is ${String(document?.phase)}`,
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
) {
  const issues = [];
  const references = new Map();
  exact(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v3',
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
    'goal-identity-mismatch',
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
    'review-attestation-goal-mismatch',
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

  uniqueBy(evidence.retainedObjects, 'root', 'duplicate-retained-root', issues);
  const retained = new Map(
    (evidence.retainedObjects || []).map((entry) => [entry.root, entry]),
  );
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
      verifyRetainedBinding(
        object,
        typeof result === 'string' ? undefined : result.document,
        evidence,
        matrix,
        live,
        issues,
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
  if (!options.evidence || !options.delivery) {
    throw new Error('--evidence and --delivery are required');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
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
  if (options.protectedRef && options.protectedRef !== expectedProtectedRef) {
    throw new Error(`protected ref must be ${expectedProtectedRef}`);
  }
  const live = collectTerminalLiveObservations(matrix, evidence);
  const report = verifyTerminalEvidence(matrix, evidence, live, (relative) =>
    fs.readFileSync(path.resolve(path.dirname(evidencePath), String(relative))),
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

export { digestBytes };
