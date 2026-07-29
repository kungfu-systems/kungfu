#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

function requiredRoot(references, value, target, issues) {
  if (!ROOT_PATTERN.test(value || '')) {
    issues.push(
      issue('invalid-root', target, `${target} must be a sha256 root`),
    );
    return;
  }
  references.add(value);
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
  const references = new Set();
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
  requiredRoot(
    references,
    evidence.delivery?.evidenceRoot,
    'delivery.evidenceRoot',
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
  requiredRoot(references, evidence.review?.root, 'review.root', issues);

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
  for (const field of [
    'requestRoot',
    'captureReceiptRoot',
    'completionDecisionRoot',
    'sealedStateRoot',
  ]) {
    requiredRoot(
      references,
      evidence.assignment?.[field],
      `assignment.${field}`,
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
      issues,
    );
    uniqueBy(platform.artifacts, 'name', 'duplicate-artifact', issues);
    for (const artifact of platform.artifacts || []) {
      requiredRoot(
        references,
        artifact.root,
        `${required}.artifacts.${artifact.name}`,
        issues,
      );
    }
  }

  uniqueBy(evidence.retainedObjects, 'root', 'duplicate-retained-root', issues);
  const retained = new Map(
    (evidence.retainedObjects || []).map((entry) => [entry.root, entry]),
  );
  for (const root of references) {
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
    try {
      const actual = digestBytes(readBytes(object.path));
      exact(
        actual,
        root,
        'retained-root-mismatch',
        object.path || root,
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
