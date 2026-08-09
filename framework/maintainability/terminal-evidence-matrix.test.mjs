// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';
import {
  observeRun,
  parseCommandJson,
  parseTerminalReviewAttestation,
} from '../terminal-evidence/live-observations.mjs';
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
const TREE = 'c'.repeat(40);

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
  const liveRuns = [];
  const runs = fixtureMatrix.terminalEvidence.runGroups.map((group, index) => {
    const runId = index + 101;
    const jobs = group.requiredJobs.map((name, jobIndex) => ({
      id: runId * 100 + jobIndex,
      name,
      status: 'completed',
      conclusion: 'success',
    }));
    const artifacts = (group.requiredArtifacts || []).map(
      ({ platform, nameTemplate }, artifactIndex) => {
        const name = nameTemplate
          .replaceAll('{platform}', platform)
          .replaceAll('{commit}', HEAD);
        const bytes = Buffer.from(`artifact:${platform}`);
        const root = retain(
          `${platform}-product`,
          bytes,
          'artifact-bytes',
          'raw-bytes',
        );
        return {
          platform,
          id: runId * 1000 + artifactIndex,
          name,
          root,
          sizeBytes: bytes.length,
        };
      },
    );
    const snapshot = {
      schema: 'kungfu.terminal-run-snapshot/v1',
      role: group.role,
      workflowPath: group.workflowPath,
      runId,
      runAttempt: 1,
      event: group.events[0],
      commit: HEAD,
      conclusion: 'success',
    };
    liveRuns.push({
      role: group.role,
      workflowPath: group.workflowPath,
      runId,
      runAttempt: 1,
      event: group.events[0],
      headSha: HEAD,
      headBranch: fixtureMatrix.sourceBinding.protectedBranch,
      status: 'completed',
      conclusion: 'success',
      jobs,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        digest: artifact.root,
        sizeBytes: artifact.sizeBytes,
        expired: false,
        workflowRunId: runId,
        headSha: HEAD,
      })),
    });
    return {
      ...snapshot,
      evidenceRoot: retain(`${group.role}-run`, snapshot, 'run-snapshot'),
      jobs: jobs.map(({ name, conclusion }) => ({ name, conclusion })),
      artifacts,
    };
  });
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
  const terminalReview = {
    schema: 'kungfu.terminal-review-report/v1',
    reviewer: 'kungfu-origin',
    verdict: 'fit',
    commit: HEAD,
    tree: TREE,
    freshContext: true,
    maximumOpenSeverity: 'none',
    findings: [],
  };
  const terminalReviewRoot = retain(
    'terminal-review',
    terminalReview,
    'terminal-review-report',
  );
  const terminalAttestation = {
    schema: 'kungfu.terminal-review-attestation/v1',
    goalId: fixtureMatrix.goalId,
    commit: HEAD,
    tree: TREE,
    reviewer: 'kungfu-origin',
    verdict: 'fit',
    freshContext: true,
    maximumOpenSeverity: 'none',
    reportRoot: terminalReviewRoot,
  };
  const terminalAttestationSnapshot = {
    schema: 'kungfu.terminal-review-attestation-snapshot/v1',
    commentId: 4001,
    author: 'kungfu-origin',
    createdAt: '2026-08-02T00:01:00Z',
    updatedAt: '2026-08-02T00:01:00Z',
    attestation: terminalAttestation,
  };
  const terminalAttestationRoot = retain(
    'terminal-review-attestation',
    terminalAttestationSnapshot,
    'terminal-review-attestation-snapshot',
  );
  const nativeReview = {
    review_id: `review-${'e'.repeat(24)}`,
    review_type: 'independent-completion-review',
    claim_id: completionClaim.claim_id,
    claimant: 'codex/pro-7011/root',
    reviewer: 'kungfu-origin',
    reviewer_source: terminalReviewRoot,
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
      tree: TREE,
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
      approval: {
        reviewId: 3001,
        reviewer: 'kungfu-origin',
        decision: 'APPROVED',
        commit: OTHER_HEAD,
        root: retain(
          'github-review',
          {
            schema: 'kungfu.terminal-github-review-snapshot/v1',
            reviewId: 3001,
            reviewer: 'kungfu-origin',
            decision: 'APPROVED',
            commit: OTHER_HEAD,
          },
          'github-review-snapshot',
        ),
      },
    },
    review: {
      reviewer: 'kungfu-origin',
      verdict: 'fit',
      commit: HEAD,
      tree: TREE,
      freshContext: true,
      maximumOpenSeverity: 'none',
      root: terminalReviewRoot,
      attestationRoot: terminalAttestationRoot,
    },
    assignment: {
      initiativeId: 'kungfu-technical-stewardship',
      assignmentId: fixtureMatrix.goalId,
      workspaceIdentityRoot: `sha256:${'f'.repeat(64)}`,
      phase: 'continuation-decided',
      status: 'active',
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
    runs,
    retainedObjects,
  };
  fixtureMatrix.predecessor.sealedStateRoot =
    evidence.predecessor.sealedStateRoot;
  const verify = (candidate = evidence, overrides = {}) => {
    const baseLive = {
      schema: 'kungfu.terminal-live-observations/v1',
      source: {
        repository: fixtureMatrix.sourceBinding.repository,
        protectedBranch: fixtureMatrix.sourceBinding.protectedBranch,
        head: HEAD,
        headTree: TREE,
        protectedCommit: HEAD,
        protectedTree: TREE,
      },
      delivery: {
        pullRequest: 2001,
        mergeCommit: HEAD,
        state: 'MERGED',
        baseRef: fixtureMatrix.sourceBinding.protectedBranch,
        pullRequestHead: OTHER_HEAD,
        pullRequestTree: TREE,
        mergeTree: TREE,
        approval: {
          reviewId: 3001,
          reviewer: 'kungfu-origin',
          decision: 'APPROVED',
          commit: OTHER_HEAD,
          tree: TREE,
          submittedAt: '2026-08-02T00:00:00Z',
        },
      },
      terminalReview: {
        commentId: 4001,
        author: 'kungfu-origin',
        createdAt: '2026-08-02T00:01:00Z',
        updatedAt: '2026-08-02T00:01:00Z',
        ...terminalAttestation,
      },
      assignment: {
        initiativeId: 'kungfu-technical-stewardship',
        assignmentId: fixtureMatrix.goalId,
        workspaceIdentityRoot: `sha256:${'f'.repeat(64)}`,
        phase: 'continuation-decided',
        status: 'active',
        requestRoot,
        captureReceiptRoot,
        gitCommit: HEAD,
        completionClaimRoot: semanticRoot(completionClaim),
        independentReviewRoot,
        completionDecisionRoot: semanticRoot(decision),
        sealedStateRoot: evidence.assignment.sealedStateRoot,
        queryProofRoot: `sha256:${'7'.repeat(64)}`,
        sealedQueryProofRoot: `sha256:${'7'.repeat(64)}`,
        reviewer: 'kungfu-origin',
        reviewerSource: terminalReviewRoot,
        reviewVerdict: 'fit',
        decisionAction: 'close',
        sealVerified: true,
        nextActions: [],
        sealedAssignmentId: fixtureMatrix.goalId,
        sealedPhase: 'continuation-decided',
        statusCounts: {
          completion_claims: 1,
          independent_reviews: 1,
          continuation_decisions: 1,
        },
        sealedCounts: {
          completion_claims: 1,
          independent_reviews: 1,
          continuation_decisions: 1,
        },
      },
      runs: liveRuns,
    };
    const live = {
      ...baseLive,
      ...overrides,
      source: { ...baseLive.source, ...(overrides.source || {}) },
      delivery: {
        ...baseLive.delivery,
        ...(overrides.delivery || {}),
        approval: {
          ...baseLive.delivery.approval,
          ...(overrides.delivery?.approval || {}),
        },
      },
      terminalReview: {
        ...baseLive.terminalReview,
        ...(overrides.terminalReview || {}),
      },
      assignment: {
        ...baseLive.assignment,
        ...(overrides.assignment || {}),
      },
      runs: overrides.runs || baseLive.runs,
    };
    return verifyTerminalEvidence(
      fixtureMatrix,
      candidate,
      live,
      (relative) => {
        const bytes = retainedBytes.get(relative);
        if (!bytes) throw new Error(`missing fixture ${relative}`);
        return bytes;
      },
    );
  };
  return { evidence, liveRuns, retainedBytes, verify };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function issueCodes(report) {
  return new Set(report.issues.map(({ code }) => code));
}

test('live observation parser preserves object and array authority payloads', () => {
  assert.deepEqual(
    parseCommandJson('[tool] prelude\n{"ok":true}\n', 'object'),
    { ok: true },
  );
  assert.deepEqual(
    parseCommandJson('tool prelude\n[{"id":1},{"id":2}]\n', 'array'),
    [{ id: 1 }, { id: 2 }],
  );
  assert.deepEqual(
    parseTerminalReviewAttestation('{"schema":"test","ok":true}'),
    { schema: 'test', ok: true },
  );
  assert.equal(parseTerminalReviewAttestation('not json'), undefined);
});

test('live run observation binds run and jobs to the declared attempt', () => {
  const calls = [];
  const observed = observeRun(
    matrix,
    { role: 'source', runId: 123, runAttempt: 2 },
    (endpoint) => {
      calls.push(endpoint);
      if (endpoint.endsWith('/attempts/2')) {
        return {
          id: 123,
          run_attempt: 2,
          path: '.github/workflows/affected-native-pr.yml',
          event: 'merge_group',
          head_sha: HEAD,
          head_branch: matrix.sourceBinding.protectedBranch,
          status: 'completed',
          conclusion: 'success',
        };
      }
      if (endpoint.endsWith('/attempts/2/jobs?per_page=100')) {
        return {
          jobs: [
            {
              id: 456,
              name: 'Candidate source acceptance / check',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        };
      }
      return { artifacts: [] };
    },
  );
  assert.deepEqual(calls, [
    '/repos/kungfu-systems/kungfu/actions/runs/123/attempts/2',
    '/repos/kungfu-systems/kungfu/actions/runs/123/attempts/2/jobs?per_page=100',
    '/repos/kungfu-systems/kungfu/actions/runs/123/artifacts?per_page=100',
  ]);
  assert.equal(observed.runAttempt, 2);
  assert.equal(observed.jobs[0].id, 456);
  assert.throws(
    () => observeRun(matrix, { role: 'source', runId: 123, runAttempt: 0 }),
    /source run attempt must be a positive integer/u,
  );
});

test('terminal maintainability matrix declares an exact-head v3 contract', () => {
  assert.equal(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v3',
  );
  assert.equal(matrix.sourceBinding.repository, 'kungfu-systems/kungfu');
  assert.equal(matrix.sourceBinding.protectedBranch, 'dev/v4/v4.0');
  assert.equal(
    matrix.terminalEvidence.schema,
    'kungfu.maintainability-terminal-evidence/v3',
  );
  assert.equal(repositoryPathExists(matrix.terminalEvidence.verifier), true);
  assert.match(matrix.sourceBinding.exactHeadRule, /reads Git HEAD/u);
  assert.deepEqual(matrix.exceptions, []);
  for (const group of matrix.terminalEvidence.runGroups) {
    assert.equal(repositoryPathExists(group.workflowPath), true, group.role);
    assert.ok(group.requiredJobs.length > 0, group.role);
  }
  assert.deepEqual(
    matrix.terminalEvidence.runGroups.map(({ role }) => role),
    ['source', 'preflight', 'product', 'dev-verify', 'agent-patrol'],
  );
  assert.deepEqual(
    matrix.rows.map((row) => row.assignmentId).sort(),
    [...REQUIRED_ASSIGNMENTS].sort(),
  );
  assert.equal(new Set(matrix.rows.map((row) => row.assignmentId)).size, 7);
  assert.deepEqual(
    matrix.terminalEvidence.runGroups
      .find(({ role }) => role === 'product')
      .requiredArtifacts.map(({ platform }) => platform),
    ['linux-x64', 'macos-arm64', 'windows-x64'],
  );
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
    issueCodes(verify(evidence, { source: { head: OTHER_HEAD } })).has(
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
  assert.ok(
    issueCodes(
      verify(evidence, { delivery: { approval: { reviewId: 3999 } } }),
    ).has('pull-review-reviewId-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        terminalReview: { reportRoot: `sha256:${'8'.repeat(64)}` },
      }),
    ).has('review-attestation-root-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        assignment: { requestRoot: `sha256:${'9'.repeat(64)}` },
      }),
    ).has('assignment-live-requestRoot-mismatch'),
  );
  assert.ok(
    issueCodes(
      verify(evidence, {
        assignment: { sealedQueryProofRoot: `sha256:${'6'.repeat(64)}` },
      }),
    ).has('assignment-seal-query-proof-mismatch'),
  );
});

test('retained semantic roles, live runs, and artifact bytes fail closed', () => {
  const { evidence, retainedBytes, verify } = fixture();
  const wrongAssignment = clone(evidence);
  wrongAssignment.assignment.requestRoot = digestBytes(
    Buffer.from('unretained-request'),
  );
  assert.ok(issueCodes(verify(wrongAssignment)).has('missing-retained-bytes'));

  const wrongRun = clone(evidence);
  wrongRun.runs[0].runId = 999;
  assert.ok(issueCodes(verify(wrongRun)).has('run-runId-live-mismatch'));

  const wrongWorkflow = clone(evidence);
  wrongWorkflow.runs[1].workflowPath = '.github/workflows/build.yml';
  assert.ok(
    issueCodes(verify(wrongWorkflow)).has('run-workflowPath-live-mismatch'),
  );

  const product = evidence.runs.find(({ role }) => role === 'product');
  const missingArtifacts = clone(evidence);
  missingArtifacts.runs.find(({ role }) => role === 'product').artifacts = [];
  assert.ok(
    issueCodes(verify(missingArtifacts)).has('missing-required-artifact'),
  );

  const artifact = product.artifacts[2];
  const object = evidence.retainedObjects.find(
    ({ root }) => root === artifact.root,
  );
  retainedBytes.set(object.path, Buffer.from('mutated-artifact'));
  assert.ok(issueCodes(verify(evidence)).has('retained-root-mismatch'));
});

test('self-consistent declared runs cannot replace GitHub live truth', () => {
  const { evidence, liveRuns, retainedBytes, verify } = fixture();
  const candidate = clone(evidence);
  const source = candidate.runs.find(({ role }) => role === 'source');
  const retained = candidate.retainedObjects.find(
    ({ root }) => root === source.evidenceRoot,
  );
  const snapshot = JSON.parse(
    retainedBytes.get(retained.path).toString('utf8'),
  );
  snapshot.runId = 999;
  source.runId = 999;
  const replacementRoot = semanticRoot(snapshot);
  source.evidenceRoot = replacementRoot;
  retained.root = replacementRoot;
  retainedBytes.set(
    retained.path,
    Buffer.from(`${JSON.stringify(snapshot)}\n`),
  );
  assert.ok(
    issueCodes(verify(candidate)).has('run-runId-live-mismatch'),
    'positive, retained, internally consistent run id must still match live API',
  );

  const wrongAttempt = clone(evidence);
  const attemptRun = wrongAttempt.runs.find(({ role }) => role === 'source');
  const attemptRetained = wrongAttempt.retainedObjects.find(
    ({ root }) => root === attemptRun.evidenceRoot,
  );
  const attemptSnapshot = JSON.parse(
    retainedBytes.get(attemptRetained.path).toString('utf8'),
  );
  attemptSnapshot.runAttempt = 2;
  attemptRun.runAttempt = 2;
  const attemptRoot = semanticRoot(attemptSnapshot);
  attemptRun.evidenceRoot = attemptRoot;
  attemptRetained.root = attemptRoot;
  retainedBytes.set(
    attemptRetained.path,
    Buffer.from(`${JSON.stringify(attemptSnapshot)}\n`),
  );
  assert.ok(
    issueCodes(verify(wrongAttempt)).has('run-runAttempt-live-mismatch'),
    'positive, retained, internally consistent attempt must still match live API',
  );

  const missingJob = clone(liveRuns);
  missingJob[0].jobs = missingJob[0].jobs.slice(1);
  assert.ok(
    issueCodes(verify(evidence, { runs: missingJob })).has(
      'missing-required-job',
    ),
  );

  const wrongDigest = clone(liveRuns);
  const product = wrongDigest.find(({ role }) => role === 'product');
  product.artifacts[0].digest = `sha256:${'8'.repeat(64)}`;
  assert.ok(
    issueCodes(verify(evidence, { runs: wrongDigest })).has(
      'artifact-root-live-mismatch',
    ),
  );

  const expired = clone(liveRuns);
  expired.find(({ role }) => role === 'product').artifacts[0].expired = true;
  assert.ok(
    issueCodes(verify(evidence, { runs: expired })).has('artifact-expired'),
  );
});
