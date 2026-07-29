// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digestBytes, verifyTerminalEvidence } from './terminal-evidence.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const MATRIX_PATH = path.join(
  ROOT,
  'framework/maintainability/terminal-evidence-matrix.json',
);
const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
const REQUIRED_ASSIGNMENTS = [
  '2026-07-26-kungfu-authority-convergence',
  '2026-07-26-kungfu-responsibility-hotspot-decomposition',
  '2026-07-26-kungfu-linux-product-qualification',
  '2026-07-26-kungfu-windows-product-qualification',
  '2026-07-26-kungfu-dogfood-operational-hardening',
  '2026-07-27-kungfu-complexity-gate-integrity',
  '2026-07-27-kungfu-readonly-source-acceptance-closure',
];
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function repositoryPathExists(reference) {
  if (/^https:\/\//u.test(reference)) return true;
  return fs.existsSync(path.join(ROOT, reference));
}

function fixture() {
  const fixtureMatrix = clone(matrix);
  const retainedBytes = new Map();
  const retainedObjects = [];
  const retain = (id) => {
    const bytes = Buffer.from(`retained:${id}`);
    const root = digestBytes(bytes);
    const pathname = `${id}.json`;
    retainedBytes.set(pathname, bytes);
    retainedObjects.push({ root, path: pathname });
    return root;
  };
  const platforms = fixtureMatrix.terminalEvidence.requiredProductPlatforms.map(
    (platform, index) => ({
      platform,
      commit: HEAD,
      runId: index + 101,
      conclusion: 'success',
      evidenceRoot: retain(`${platform}-run`),
      artifacts: [
        {
          name: `${platform}-product`,
          root: retain(`${platform}-product`),
        },
      ],
    }),
  );
  const evidence = {
    schema: fixtureMatrix.terminalEvidence.schema,
    goalId: fixtureMatrix.goalId,
    source: {
      repository: fixtureMatrix.sourceBinding.repository,
      protectedBranch: fixtureMatrix.sourceBinding.protectedBranch,
      commit: HEAD,
    },
    delivery: {
      pullRequest: 2001,
      mergeCommit: HEAD,
      state: 'MERGED',
      evidenceRoot: retain('delivery'),
    },
    review: {
      reviewer: 'kungfu-origin',
      decision: 'APPROVED',
      commit: HEAD,
      freshContext: true,
      root: retain('review'),
    },
    assignment: {
      assignmentId: fixtureMatrix.goalId,
      gitCommit: HEAD,
      requestRoot: retain('assignment-request'),
      captureReceiptRoot: retain('assignment-capture'),
      completionDecisionRoot: retain('assignment-decision'),
      sealedStateRoot: retain('assignment-seal'),
    },
    predecessor: {
      assignmentId: fixtureMatrix.predecessor.assignmentId,
      sealedStateRoot: retain('predecessor-seal'),
    },
    platforms,
    retainedObjects,
  };
  fixtureMatrix.predecessor.sealedStateRoot =
    evidence.predecessor.sealedStateRoot;
  const verify = (candidate = evidence, live = {}) =>
    verifyTerminalEvidence(
      fixtureMatrix,
      candidate,
      {
        head: HEAD,
        protectedCommit: HEAD,
        delivery: { pullRequest: 2001, mergeCommit: HEAD },
        ...live,
      },
      (relative) => {
        const bytes = retainedBytes.get(relative);
        if (!bytes) throw new Error(`missing fixture ${relative}`);
        return bytes;
      },
    );
  return { evidence, retainedBytes, verify };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueCodes(report) {
  return new Set(report.issues.map(({ code }) => code));
}

test('terminal maintainability matrix declares an exact-head v2 contract', () => {
  assert.equal(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v2',
  );
  assert.equal(matrix.sourceBinding.repository, 'kungfu-systems/kungfu');
  assert.equal(matrix.sourceBinding.protectedBranch, 'dev/v4/v4.0');
  assert.equal(
    matrix.terminalEvidence.schema,
    'kungfu.maintainability-terminal-evidence/v2',
  );
  assert.equal(repositoryPathExists(matrix.terminalEvidence.verifier), true);
  assert.match(matrix.sourceBinding.exactHeadRule, /reads Git HEAD/u);
  assert.deepEqual(matrix.exceptions, []);
  for (const workflow of [
    matrix.terminalEvidence.sourceWorkflow,
    matrix.terminalEvidence.platformPreflightWorkflow,
    matrix.terminalEvidence.productWorkflow,
  ]) {
    assert.equal(repositoryPathExists(workflow), true, workflow);
  }
  assert.deepEqual(
    matrix.rows.map((row) => row.assignmentId).sort(),
    [...REQUIRED_ASSIGNMENTS].sort(),
  );
  assert.equal(new Set(matrix.rows.map((row) => row.assignmentId)).size, 7);
  assert.deepEqual(matrix.terminalEvidence.requiredProductPlatforms, [
    'linux-x64',
    'macos-arm64',
    'windows-x64',
  ]);
  for (const row of matrix.rows) {
    assert.equal(row.disposition, 'closed', row.assignmentId);
    for (const reference of [...row.sourceEvidence, ...row.rawChecks]) {
      assert.equal(
        repositoryPathExists(reference),
        true,
        `${row.assignmentId}: missing ${reference}`,
      );
    }
  }
});

test('terminal evidence accepts one exact live protected cut', () => {
  const { verify } = fixture();
  const report = verify();
  assert.deepEqual(report.issues, []);
});

test('live HEAD, protected PR, merge, and review identities fail closed', () => {
  const { evidence, verify } = fixture();
  assert.ok(
    issueCodes(verify(evidence, { head: OTHER_HEAD })).has(
      'source-head-mismatch',
    ),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        delivery: { pullRequest: 2002, mergeCommit: HEAD },
      }),
    ).has('delivery-pr-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        delivery: { pullRequest: 2001, mergeCommit: OTHER_HEAD },
      }),
    ).has('delivery-merge-mismatch'),
  );
  const wrongReview = clone(evidence);
  wrongReview.review.reviewer = 'dongkeren';
  assert.ok(issueCodes(verify(wrongReview)).has('reviewer-mismatch'));
  const staleReview = clone(evidence);
  staleReview.review.commit = OTHER_HEAD;
  assert.ok(issueCodes(verify(staleReview)).has('review-head-mismatch'));
});

test('Assignment roots, platform runs, and artifact bytes fail closed', () => {
  const { evidence, retainedBytes, verify } = fixture();
  const wrongAssignment = clone(evidence);
  wrongAssignment.assignment.requestRoot = digestBytes(
    Buffer.from('unretained-request'),
  );
  assert.ok(issueCodes(verify(wrongAssignment)).has('missing-retained-bytes'));

  const wrongRun = clone(evidence);
  wrongRun.platforms[0].runId = 0;
  assert.ok(issueCodes(verify(wrongRun)).has('invalid-platform-run'));

  const stalePlatform = clone(evidence);
  stalePlatform.platforms[1].commit = OTHER_HEAD;
  assert.ok(issueCodes(verify(stalePlatform)).has('platform-head-mismatch'));

  const artifact = evidence.platforms[2].artifacts[0];
  const object = evidence.retainedObjects.find(
    ({ root }) => root === artifact.root,
  );
  retainedBytes.set(object.path, Buffer.from('mutated-artifact'));
  assert.ok(issueCodes(verify(evidence)).has('retained-root-mismatch'));
});
