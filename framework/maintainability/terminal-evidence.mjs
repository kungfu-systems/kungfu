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

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MATRIX_PATH = 'framework/maintainability/terminal-evidence-matrix.json';
const SHA = /^[0-9a-f]{40}$/u;
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function digestBytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function issue(code, target, message) {
  return { code, target, message };
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function requiredRoot(references, value, target, kind, issues) {
  if (!ROOT_PATTERN.test(value || '')) {
    issues.push(
      issue('invalid-root', target, `${target} must be a sha256 root`),
    );
    return;
  }
  const prior = references.get(value);
  if (prior && prior.kind !== kind) {
    issues.push(
      issue(
        'retained-role-conflict',
        target,
        `${value} cannot represent both ${prior.kind} and ${kind}`,
      ),
    );
    return;
  }
  references.set(value, { kind, target });
}

function exact(value, expected, code, target, issues) {
  if (value !== expected) {
    issues.push(
      issue(
        code,
        target,
        `${target} is ${String(value)}, expected ${expected}`,
      ),
    );
  }
}

function uniqueBy(values, key, code, issues) {
  const seen = new Set();
  for (const value of values || []) {
    const identity = value?.[key];
    if (!identity || seen.has(identity)) {
      issues.push(
        issue(
          code,
          identity || key,
          `${key} values must be present and unique`,
        ),
      );
    }
    seen.add(identity);
  }
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
    case 'review-snapshot':
      mismatch(
        'retained-review-schema',
        'review.schema',
        document?.schema,
        'kungfu.terminal-review-snapshot/v1',
      );
      for (const field of ['reviewer', 'decision', 'commit', 'freshContext']) {
        mismatch(
          `retained-review-${field}`,
          `review.${field}`,
          document?.[field],
          evidence.review?.[field],
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
        'retained-request-goal',
        'assignment.request.goalId',
        document?.workDefinition?.goal_id,
        matrix.goalId,
      );
      mismatch(
        'retained-request-source',
        'assignment.request.sourceId',
        document?.source?.sourceId,
        matrix.goalId,
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
        live.head,
      );
      if (
        !Array.isArray(document?.go_set) ||
        !document.go_set.includes(matrix.goalId)
      ) {
        issues.push(
          issue(
            'retained-claim-assignment',
            'assignment.claim.go_set',
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
        matrix.terminalEvidence.reviewRule.reviewer,
      );
      mismatch(
        'retained-native-review-verdict',
        'assignment.review.verdict',
        document?.verdict,
        'fit',
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
          ? matrix.goalId
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
    case 'platform-run': {
      const platform = (evidence.platforms || []).find(
        ({ evidenceRoot }) => evidenceRoot === object.root,
      );
      mismatch(
        'retained-platform-schema',
        'platform.schema',
        document?.schema,
        'kungfu.terminal-platform-run-snapshot/v1',
      );
      for (const field of ['platform', 'commit', 'runId', 'conclusion']) {
        mismatch(
          `retained-platform-${field}`,
          `platform.${field}`,
          document?.[field],
          platform?.[field],
        );
      }
      mismatch(
        'retained-platform-live-head',
        'platform.commit',
        document?.commit,
        live.head,
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
    'kungfu.maintainability-terminal-evidence-matrix/v2',
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
    evidence.goalId,
    matrix.goalId,
    'goal-identity-mismatch',
    'goalId',
    issues,
  );

  if (!SHA.test(live.head || '')) {
    issues.push(
      issue('invalid-live-head', 'live.head', 'live HEAD is not exact'),
    );
  }
  exact(
    evidence.source?.commit,
    live.head,
    'source-head-mismatch',
    'source.commit',
    issues,
  );
  exact(
    evidence.source?.commit,
    live.protectedCommit,
    'protected-head-mismatch',
    'source.commit',
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
    live.head,
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
    evidence.review?.reviewer,
    matrix.terminalEvidence.reviewRule.reviewer,
    'reviewer-mismatch',
    'review.reviewer',
    issues,
  );
  exact(
    evidence.review?.decision,
    matrix.terminalEvidence.reviewRule.decision,
    'review-decision-mismatch',
    'review.decision',
    issues,
  );
  exact(
    evidence.review?.commit,
    live.head,
    'review-head-mismatch',
    'review.commit',
    issues,
  );
  if (evidence.review?.freshContext !== true) {
    issues.push(
      issue(
        'review-not-fresh',
        'review.freshContext',
        'terminal review must be fresh-context',
      ),
    );
  }
  requiredRoot(
    references,
    evidence.review?.root,
    'review.root',
    'review-snapshot',
    issues,
  );

  exact(
    evidence.assignment?.assignmentId,
    matrix.goalId,
    'assignment-identity-mismatch',
    'assignment.assignmentId',
    issues,
  );
  exact(
    evidence.assignment?.gitCommit,
    live.head,
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

  uniqueBy(evidence.platforms, 'platform', 'duplicate-platform', issues);
  const platforms = new Map(
    (evidence.platforms || []).map((entry) => [entry.platform, entry]),
  );
  for (const required of matrix.terminalEvidence.requiredProductPlatforms) {
    const platform = platforms.get(required);
    if (!platform) {
      issues.push(
        issue('missing-platform', required, `missing platform ${required}`),
      );
      continue;
    }
    exact(
      platform.commit,
      live.head,
      'platform-head-mismatch',
      `${required}.commit`,
      issues,
    );
    if (!Number.isInteger(platform.runId) || platform.runId < 1) {
      issues.push(
        issue(
          'invalid-platform-run',
          `${required}.runId`,
          'platform run id must be positive',
        ),
      );
    }
    if (platform.conclusion !== 'success') {
      issues.push(
        issue(
          'platform-not-successful',
          required,
          `platform conclusion is ${platform.conclusion}`,
        ),
      );
    }
    requiredRoot(
      references,
      platform.evidenceRoot,
      `${required}.evidenceRoot`,
      'platform-run',
      issues,
    );
    uniqueBy(platform.artifacts, 'name', 'duplicate-artifact', issues);
    for (const artifact of platform.artifacts || []) {
      requiredRoot(
        references,
        artifact.root,
        `${required}.artifacts.${artifact.name}`,
        'artifact-bytes',
        issues,
      );
    }
  }

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
    sourceCommit: live.head,
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
  const protectedRef =
    options.protectedRef ||
    `refs/remotes/origin/${matrix.sourceBinding.protectedBranch}`;
  const report = verifyTerminalEvidence(
    matrix,
    evidence,
    {
      head: git(['rev-parse', 'HEAD']),
      protectedCommit: git(['rev-parse', protectedRef]),
      delivery,
    },
    (relative) =>
      fs.readFileSync(
        path.resolve(path.dirname(evidencePath), String(relative)),
      ),
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
