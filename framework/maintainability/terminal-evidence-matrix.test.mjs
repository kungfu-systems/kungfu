// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { semanticRoot } from '../project-cut/src/project-cut.mjs';
import {
  observeRun,
  parseCommandJson,
  parseTerminalReviewAttestation,
} from '../terminal-evidence/live-observations.mjs';
import {
  digestBytes,
  resolveRetainedPath,
  verifyTerminalEvidence,
} from './terminal-evidence.mjs';

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
    source: {
      kind: 'kungfu-assignment',
      sourceId: fixtureMatrix.assignmentId,
    },
    workDefinition: {
      assignment_id: fixtureMatrix.assignmentId,
      parent_assignment_identity: {
        assignment_id: fixtureMatrix.dependencies[0].requiredAssignmentId,
      },
      // The retained v4 request repeats its parent in dependency_identities.
      // Authority comparison is set-based, so this must not invent a ninth
      // dependency or reject the one exact parent/dependency identity.
      dependency_identities: fixtureMatrix.dependencies.map(
        ({ requiredAssignmentId }) => ({
          assignment_id: requiredAssignmentId,
        }),
      ),
      review_baseline: {
        open_pull_requests_at_review: [
          '#2235',
          '#2212',
          '#2193',
          '#2173',
          '#2109',
          '#1997',
        ],
      },
    },
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
    assignment_set: [fixtureMatrix.assignmentId],
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
    assignmentId: fixtureMatrix.assignmentId,
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
    assignment: {
      assignment_id: fixtureMatrix.assignmentId,
      request_root: requestRoot,
      capture_receipt_roots: [captureReceiptRoot],
    },
    phase: 'continuation-decided',
    query_proof_root: `sha256:${'7'.repeat(64)}`,
    counts: {
      completion_claims: 1,
      independent_reviews: 1,
      continuation_decisions: 1,
    },
  };
  const dependencies = fixtureMatrix.dependencies.map((dependency, index) => {
    const seal = {
      schema: 'kungfu.assignment-orchestration.sealed-state/v1',
      assignment: {
        assignment_id: dependency.assignmentId,
        request_root: `sha256:${String(index + 1)
          .repeat(64)
          .slice(0, 64)}`,
        capture_receipt_roots: [
          `sha256:${String(index + 2)
            .repeat(64)
            .slice(0, 64)}`,
        ],
      },
      phase: 'continuation-decided',
      query_proof_root: `sha256:${String(index + 3)
        .repeat(64)
        .slice(0, 64)}`,
      counts: {
        completion_claims: 1,
        independent_reviews: 1,
        continuation_decisions: 1,
      },
    };
    const sealedStateRoot = retain(
      `dependency-seal-${index}`,
      seal,
      'dependency-seal',
    );
    retainedObjects.at(-1).assignmentId = dependency.assignmentId;
    dependency.sealedStateRoot = sealedStateRoot;
    return {
      requiredAssignmentId: dependency.requiredAssignmentId,
      assignmentId: dependency.assignmentId,
      sealedStateRoot,
    };
  });
  const predecessorSeal = {
    schema: 'kungfu.assignment-orchestration.sealed-state/v1',
    assignment: {
      assignment_id: fixtureMatrix.predecessor.assignmentId,
      request_root: `sha256:${'8'.repeat(64)}`,
      capture_receipt_roots: [`sha256:${'9'.repeat(64)}`],
    },
    phase: 'continuation-decided',
    query_proof_root: `sha256:${'6'.repeat(64)}`,
    counts: {
      completion_claims: 1,
      independent_reviews: 1,
      continuation_decisions: 1,
    },
  };
  const evidence = {
    schema: fixtureMatrix.terminalEvidence.schema,
    assignmentId: fixtureMatrix.assignmentId,
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
      assignmentId: fixtureMatrix.assignmentId,
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
    dependencies,
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
        protectedCommitEnd: HEAD,
        protectedTreeEnd: TREE,
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
      reconciliation: {
        declaredPulls: fixtureMatrix.reconciliation.pullRequests.map(
          (pull) => ({
            number: pull.number,
            state: pull.state,
            baseRef: fixtureMatrix.sourceBinding.protectedBranch,
            headRef: pull.headRef,
            head: pull.head,
            mergeCommit: pull.mergeCommit || '',
            ...(pull.successor
              ? {
                  successor: pull.successor,
                  successorState: pull.successorState,
                  successorBaseRef: fixtureMatrix.sourceBinding.protectedBranch,
                  successorHeadRef: pull.successorHeadRef,
                  successorHead: pull.successorHead,
                  successorTree: pull.successorTree,
                  successorMergeCommit: pull.successorMergeCommit || '',
                }
              : {}),
          }),
        ),
        openProtectedPulls: [],
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
        assignmentId: fixtureMatrix.assignmentId,
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
        sealedAssignmentId: fixtureMatrix.assignmentId,
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
      reconciliation: overrides.reconciliation || baseLive.reconciliation,
      runs: overrides.runs || baseLive.runs,
    };
    const nativeRoots = new Map(
      evidence.retainedObjects
        .filter(({ kind }) =>
          ['assignment-seal', 'dependency-seal', 'predecessor-seal'].includes(
            kind,
          ),
        )
        .map(({ path: pathname, root }) => [pathname, root]),
    );
    return verifyTerminalEvidence(
      fixtureMatrix,
      candidate,
      live,
      (relative) => {
        const bytes = retainedBytes.get(relative);
        if (!bytes) throw new Error(`missing fixture ${relative}`);
        return bytes;
      },
      (relative) => {
        const expectedRoot = nativeRoots.get(relative);
        const bytes = retainedBytes.get(relative);
        const actualRoot = bytes
          ? semanticRoot(JSON.parse(bytes.toString('utf8')))
          : undefined;
        return {
          ok: actualRoot === expectedRoot,
          state_root: expectedRoot,
          phase: 'continuation-decided',
          next_actions: [],
        };
      },
    );
  };
  return {
    evidence,
    liveRuns,
    matrix: fixtureMatrix,
    retainedBytes,
    verify,
  };
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

test('portable retained paths stay inside the evidence archive', (context) => {
  const archive = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-evidence-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-outside-'));
  context.after(() => {
    fs.rmSync(archive, { recursive: true });
    fs.rmSync(outside, { recursive: true });
  });
  const retained = path.join(archive, 'seal.json');
  const outsideSeal = path.join(outside, 'seal.json');
  fs.writeFileSync(retained, '{}\n');
  fs.writeFileSync(outsideSeal, '{}\n');
  fs.symlinkSync(outsideSeal, path.join(archive, 'escaped.json'));
  assert.equal(
    resolveRetainedPath(archive, 'seal.json'),
    fs.realpathSync(retained),
  );
  assert.throws(
    () => resolveRetainedPath(archive, '../seal.json'),
    /ENOENT|escapes/u,
  );
  assert.throws(
    () => resolveRetainedPath(archive, 'escaped.json'),
    /escapes the evidence archive/u,
  );
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

test('terminal maintainability matrix declares an exact-head v4 contract', () => {
  assert.equal(
    matrix.schema,
    'kungfu.maintainability-terminal-evidence-matrix/v4',
  );
  assert.equal(matrix.sourceBinding.repository, 'kungfu-systems/kungfu');
  assert.equal(matrix.sourceBinding.protectedBranch, 'dev/v4/v4.0');
  assert.equal(
    matrix.terminalEvidence.schema,
    'kungfu.maintainability-terminal-evidence/v4',
  );
  assert.equal(repositoryPathExists(matrix.terminalEvidence.verifier), true);
  assert.match(matrix.sourceBinding.exactHeadRule, /reads Git HEAD/u);
  assert.deepEqual(matrix.exceptions, []);
  assert.equal(matrix.dependencies.length, 8);
  assert.match(matrix.reconciliation.branchPolicy, /audit and recovery/u);
  assert.equal(matrix.reconciliation.pullRequests.length, 10);
  assert.equal(
    new Set(matrix.reconciliation.pullRequests.map(({ number }) => number))
      .size,
    10,
  );
  assert.equal(
    new Set(matrix.dependencies.map(({ assignmentId }) => assignmentId)).size,
    8,
  );
  assert.equal(
    new Set(
      matrix.dependencies.map(
        ({ requiredAssignmentId }) => requiredAssignmentId,
      ),
    ).size,
    8,
  );
  assert.equal(
    new Set(matrix.dependencies.map(({ sealedStateRoot }) => sealedStateRoot))
      .size,
    8,
  );
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
  assert.ok(
    issueCodes(
      verify(evidence, { source: { protectedCommitEnd: OTHER_HEAD } }),
    ).has('protected-head-toctou'),
  );
});

test('missing v4 sets and request-authority substitution fail closed', () => {
  const { evidence, matrix: fixtureMatrix, verify } = fixture();
  const omitted = clone(evidence);
  omitted.dependencies = undefined;
  const omittedCodes = issueCodes(
    verify(omitted, { reconciliation: { openProtectedPulls: [] } }),
  );
  assert.ok(omittedCodes.has('required-v4-field-missing'));
  assert.ok(omittedCodes.has('reconciliation-set-missing'));

  fixtureMatrix.dependencies = undefined;
  assert.ok(issueCodes(verify(evidence)).has('required-v4-field-missing'));

  const replacement = fixture();
  const alternate = '2026-08-08-kungfu-unrelated-terminal-assignment';
  replacement.matrix.dependencies[1].requiredAssignmentId = alternate;
  replacement.matrix.dependencies[1].assignmentId = alternate;
  replacement.evidence.dependencies[1].requiredAssignmentId = alternate;
  replacement.evidence.dependencies[1].assignmentId = alternate;
  assert.ok(
    issueCodes(replacement.verify(replacement.evidence)).has(
      'dependency-authority-set-mismatch',
    ),
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
    'retained attempt identity must still match the live attempt endpoint',
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

test('dependency omission, rerooting, and non-terminal seals fail closed', () => {
  const { evidence, retainedBytes, verify } = fixture();

  const omitted = clone(evidence);
  omitted.dependencies.pop();
  assert.ok(issueCodes(verify(omitted)).has('missing-dependency'));
  assert.ok(issueCodes(verify(omitted)).has('dependency-cardinality-mismatch'));

  const rerooted = clone(evidence);
  rerooted.dependencies[0].sealedStateRoot = `sha256:${'8'.repeat(64)}`;
  assert.ok(
    issueCodes(verify(rerooted)).has('dependency-sealedStateRoot-mismatch'),
  );

  const dependency = evidence.dependencies[0];
  const retained = evidence.retainedObjects.find(
    ({ root }) => root === dependency.sealedStateRoot,
  );
  const document = JSON.parse(
    retainedBytes.get(retained.path).toString('utf8'),
  );
  document.phase = 'stage-ready';
  retainedBytes.set(
    retained.path,
    Buffer.from(`${JSON.stringify(document)}\n`),
  );
  const codes = issueCodes(verify(evidence));
  assert.ok(codes.has('retained-root-mismatch'));
  assert.ok(codes.has('retained-seal-not-terminal'));

  const forgedFixture = fixture();
  const forged = clone(forgedFixture.evidence);
  const forgedDependency = forged.dependencies[0];
  const forgedRetained = forged.retainedObjects.find(
    ({ root }) => root === forgedDependency.sealedStateRoot,
  );
  const forgedDocument = JSON.parse(
    forgedFixture.retainedBytes.get(forgedRetained.path).toString('utf8'),
  );
  forgedDocument.assignment.objective = 'self-described replacement';
  const forgedRoot = semanticRoot(forgedDocument);
  forgedFixture.retainedBytes.set(
    forgedRetained.path,
    Buffer.from(`${JSON.stringify(forgedDocument)}\n`),
  );
  forgedRetained.root = forgedRoot;
  forgedDependency.sealedStateRoot = forgedRoot;
  forgedFixture.matrix.dependencies[0].sealedStateRoot = forgedRoot;
  const forgedCodes = issueCodes(forgedFixture.verify(forged));
  assert.ok(forgedCodes.has('retained-seal-native-root-mismatch'));
  assert.ok(forgedCodes.has('retained-seal-native-verification-failed'));
});

test('remediation pull-request state and exact head drift fail closed', () => {
  const { evidence, verify } = fixture();
  const observed = {
    declaredPulls: matrix.reconciliation.pullRequests.map((pull) => ({
      number: pull.number,
      state: pull.state,
      baseRef: matrix.sourceBinding.protectedBranch,
      headRef: pull.headRef,
      head: pull.head,
      mergeCommit: pull.mergeCommit || '',
      ...(pull.successor
        ? {
            successor: pull.successor,
            successorState: pull.successorState,
            successorBaseRef: matrix.sourceBinding.protectedBranch,
            successorHeadRef: pull.successorHeadRef,
            successorHead: pull.successorHead,
            successorTree: pull.successorTree,
            successorMergeCommit: pull.successorMergeCommit || '',
          }
        : {}),
    })),
    openProtectedPulls: [],
  };

  const reopened = clone(observed);
  reopened.declaredPulls[0].state = 'OPEN';
  assert.ok(
    issueCodes(verify(evidence, { reconciliation: reopened })).has(
      'reconciliation-pr-state-mismatch',
    ),
  );

  const moved = clone(observed);
  moved.declaredPulls[1].head = OTHER_HEAD;
  assert.ok(
    issueCodes(verify(evidence, { reconciliation: moved })).has(
      'reconciliation-pr-head-mismatch',
    ),
  );

  const omitted = clone(observed);
  omitted.declaredPulls.pop();
  const codes = issueCodes(verify(evidence, { reconciliation: omitted }));
  assert.ok(codes.has('missing-reconciliation-pr'));
  assert.ok(codes.has('reconciliation-pr-cardinality-mismatch'));

  const liveSuccessor = clone(observed);
  liveSuccessor.declaredPulls[0].successorState = 'OPEN';
  assert.ok(
    issueCodes(verify(evidence, { reconciliation: liveSuccessor })).has(
      'reconciliation-successor-not-terminal',
    ),
  );

  const movedSuccessor = clone(observed);
  movedSuccessor.declaredPulls[0].successorHead = OTHER_HEAD;
  assert.ok(
    issueCodes(verify(evidence, { reconciliation: movedSuccessor })).has(
      'reconciliation-successorHead-mismatch',
    ),
  );

  const unlistedOpen = clone(observed);
  unlistedOpen.openProtectedPulls.push({
    number: 9999,
    state: 'OPEN',
    baseRef: matrix.sourceBinding.protectedBranch,
    headRef: 'fix/terminal-review-unlisted',
    head: OTHER_HEAD,
    headTree: TREE,
    title: 'unlisted remediation',
  });
  assert.ok(
    issueCodes(verify(evidence, { reconciliation: unlistedOpen })).has(
      'reconciliation-in-scope-pr-open',
    ),
  );
});
