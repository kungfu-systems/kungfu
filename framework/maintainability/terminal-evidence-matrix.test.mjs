// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';
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
  const retain = (
    id,
    value,
    kind,
    rootProtocol = 'canonical-json',
    rootField = undefined,
  ) => {
    const document = Buffer.isBuffer(value) ? undefined : clone(value);
    let root;
    if (rootProtocol === 'raw-bytes') {
      root = digestBytes(value);
    } else if (rootProtocol === 'canonical-json') {
      root = semanticRoot(document);
    } else {
      const preimage = { ...document };
      delete preimage[rootField];
      root = semanticRoot(preimage);
      document[rootField] = root;
    }
    const bytes =
      rootProtocol === 'raw-bytes'
        ? value
        : Buffer.from(`${JSON.stringify(document)}\n`);
    const pathname = `${id}.json`;
    retainedBytes.set(pathname, bytes);
    retainedObjects.push({
      root,
      path: pathname,
      kind,
      rootProtocol,
      ...(rootField ? { rootField } : {}),
    });
    return root;
  };
  const platforms = fixtureMatrix.terminalEvidence.requiredProductPlatforms.map(
    (platform, index) => {
      const run = {
        schema: 'kungfu.terminal-platform-run-snapshot/v1',
        platform,
        commit: HEAD,
        runId: index + 101,
        conclusion: 'success',
      };
      return {
        platform,
        commit: HEAD,
        runId: index + 101,
        conclusion: 'success',
        evidenceRoot: retain(`${platform}-run`, run, 'platform-run'),
        artifacts: [
          {
            name: `${platform}-product`,
            root: retain(
              `${platform}-product`,
              Buffer.from(`artifact:${platform}`),
              'artifact-bytes',
              'raw-bytes',
            ),
          },
        ],
      };
    },
  );
  const request = {
    schema: 'kungfu.assignment-request/v1',
    retention: {
      expiresAt: null,
      policy: 'explicit-expiry-retain-bytes-v1',
    },
    source: { kind: 'atlas-go-card', sourceId: fixtureMatrix.goalId },
    workDefinition: { goal_id: fixtureMatrix.goalId },
  };
  const requestRoot = retain(
    'assignment-request',
    request,
    'assignment-request',
  );
  const capture = {
    schema: 'kungfu.assignment-capture.receipt/v1',
    requestRoot,
  };
  const captureReceiptRoot = retain(
    'assignment-capture',
    capture,
    'assignment-capture',
    'canonical-json-without-root-field',
    'receiptRoot',
  );
  const decision = {
    decision_id: `decision-${'c'.repeat(24)}`,
    action: 'close',
  };
  const completionClaim = {
    claim_id: `completion-${'d'.repeat(24)}`,
    claim_type: 'task-completed',
    git_commit: HEAD,
    go_set: [fixtureMatrix.goalId],
    known_gaps: [],
  };
  const nativeReview = {
    review_id: `review-${'e'.repeat(24)}`,
    review_type: 'independent-completion-review',
    claim_id: completionClaim.claim_id,
    claimant: 'codex/pro-7011/root',
    reviewer: 'kungfu-origin',
    verdict: 'fit',
  };
  const independentReviewRoot = semanticRoot(nativeReview);
  decision.review_root = independentReviewRoot;
  const assignmentSeal = {
    schema: 'kungfu.assignment-orchestration.sealed-state/v1',
    assignment: { assignment_id: fixtureMatrix.goalId },
    phase: 'continuation-decided',
  };
  const predecessorSeal = {
    schema: 'kungfu.assignment-orchestration.sealed-state/v1',
    assignment: { assignment_id: fixtureMatrix.predecessor.assignmentId },
    phase: 'continuation-decided',
  };
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
      evidenceRoot: retain(
        'delivery',
        {
          schema: 'kungfu.terminal-delivery-snapshot/v1',
          pullRequest: 2001,
          mergeCommit: HEAD,
          state: 'MERGED',
        },
        'delivery-snapshot',
      ),
    },
    review: {
      reviewer: 'kungfu-origin',
      decision: 'APPROVED',
      commit: HEAD,
      freshContext: true,
      root: retain(
        'review',
        {
          schema: 'kungfu.terminal-review-snapshot/v1',
          reviewer: 'kungfu-origin',
          decision: 'APPROVED',
          commit: HEAD,
          freshContext: true,
        },
        'review-snapshot',
      ),
    },
    assignment: {
      assignmentId: fixtureMatrix.goalId,
      gitCommit: HEAD,
      requestRoot,
      captureReceiptRoot,
      completionClaimRoot: retain(
        'assignment-claim',
        completionClaim,
        'assignment-claim',
      ),
      independentReviewRoot: retain(
        'assignment-native-review',
        nativeReview,
        'assignment-review',
      ),
      completionDecisionRoot: retain(
        'assignment-decision',
        decision,
        'assignment-decision',
      ),
      sealedStateRoot: retain(
        'assignment-seal',
        assignmentSeal,
        'assignment-seal',
      ),
    },
    predecessor: {
      assignmentId: fixtureMatrix.predecessor.assignmentId,
      sealedStateRoot: retain(
        'predecessor-seal',
        predecessorSeal,
        'predecessor-seal',
      ),
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
        delivery: {
          pullRequest: 2001,
          mergeCommit: HEAD,
          state: 'MERGED',
        },
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
        delivery: {
          pullRequest: 2002,
          mergeCommit: HEAD,
          state: 'MERGED',
        },
      }),
    ).has('delivery-pr-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        delivery: {
          pullRequest: 2001,
          mergeCommit: OTHER_HEAD,
          state: 'MERGED',
        },
      }),
    ).has('delivery-merge-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        delivery: {
          pullRequest: 2001,
          mergeCommit: HEAD,
          state: 'OPEN',
        },
      }),
    ).has('delivery-state-mismatch'),
  );
  const wrongReview = clone(evidence);
  wrongReview.review.reviewer = 'dongkeren';
  assert.ok(issueCodes(verify(wrongReview)).has('reviewer-mismatch'));
  const staleReview = clone(evidence);
  staleReview.review.commit = OTHER_HEAD;
  assert.ok(issueCodes(verify(staleReview)).has('review-head-mismatch'));
});

test('retained semantic roles, platform runs, and artifact bytes fail closed', () => {
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
