// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activeMergeGroupRunsForPull,
  cancelDequeuedMergeGroupRuns,
  mergeQueueRepairComment,
  recordDequeuedRepairMarker,
  releaseDequeuedFamilyQueueLease,
  revokeQueueAdmissionLease,
  settleDequeuedMergeGroup,
} from './cancel-dequeued-merge-group-runs.mjs';
import { createFamilyQueueLease } from './project-cut-merge-queue-admission.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function response(status, payload = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test('selector admits only active merge-group runs for the exact pull request', () => {
  const matching = {
    id: 42,
    event: 'merge_group',
    status: 'in_progress',
    head_branch:
      'gh-readonly-queue/dev/v4/v4.0/pr-1510-b63868f6ea79d07953a370f26c0b813456d724f4',
  };
  assert.deepEqual(
    activeMergeGroupRunsForPull(
      [
        matching,
        { ...matching, id: 43, status: 'completed' },
        { ...matching, id: 44, event: 'pull_request' },
        {
          ...matching,
          id: 45,
          head_branch: 'gh-readonly-queue/dev/v4/v4.0/pr-15101-b63868f6ea79',
        },
      ],
      1510,
    ),
    [matching],
  );
});

test('dequeue workflow executes only the trusted base with least privilege', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'cancel-dequeued-merge-group.yml'),
    'utf8',
  );
  assert.match(workflow, /pull_request_target:\n\s+types: \[dequeued\]/u);
  assert.match(workflow, /permissions:\n\s+actions: write\n\s+contents: read/u);
  assert.match(workflow, /\s+pull-requests: write/u);
  assert.match(workflow, /\s+statuses: write/u);
  assert.match(workflow, /QUEUE_ADMISSION_CONTEXT: Queue admission lease/u);
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(
    workflow,
    /ref:\s+\$\{\{ github\.event\.pull_request\.head/u,
  );
});

test('dequeue revokes the exact-head queue admission lease', async () => {
  const requests = [];
  const headSha = 'c'.repeat(40);
  const request = async (url, init = {}) => {
    requests.push({
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    return response(201);
  };
  assert.deepEqual(
    await revokeQueueAdmissionLease({
      repository: 'kungfu-systems/kungfu',
      headSha,
      context: 'Queue admission lease',
      token: 'test-token',
      request,
    }),
    {
      headSha,
      context: 'Queue admission lease',
      state: 'failure',
    },
  );
  assert.deepEqual(requests, [
    {
      url: `https://api.github.com/repos/kungfu-systems/kungfu/statuses/${headSha}`,
      method: 'POST',
      body: {
        state: 'failure',
        context: 'Queue admission lease',
        description:
          'Lease revoked after merge-queue dequeue; use the serialized wrapper',
      },
    },
  ]);
});

test('dequeue releases the exact family lease and ignores stale head observations', async () => {
  const headSha = 'b'.repeat(40);
  const lease = createFamilyQueueLease(
    {
      schema: 'project.cut.merge-queue-admission/v1',
      ok: true,
      decision: 'qualified',
      baseCommitOid: 'a'.repeat(40),
      headCommitOid: headSha,
      candidateCommitOid: 'c'.repeat(40),
      candidateTreeOid: 'd'.repeat(40),
      replayedCommitCount: 1,
      compositionChanged: false,
      reasonCodes: [],
    },
    {
      initiativeId: 'initiative-one',
      assignmentId: 'child-one',
      deliveryClass: 'non-native-fast',
      queueAttempt: 'attempt-one',
    },
  );
  const requests = [];
  const released = await releaseDequeuedFamilyQueueLease({
    repository: 'kungfu-systems/kungfu',
    pullRequest: 1510,
    headSha,
    body: lease.marker,
    reason: 'manual',
    token: 'test-token',
    request: async (url, init = {}) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return response(201);
    },
  });
  assert.equal(released.state, 'released');
  assert.equal(released.release.terminalReason, 'dequeue-manual');
  assert.deepEqual(requests, [
    {
      url: `https://api.github.com/repos/kungfu-systems/kungfu/statuses/${headSha}`,
      body: {
        state: 'success',
        context: lease.statusContext,
        description: `Released ${released.release.releaseRoot.slice(7, 19)} after dequeue`,
      },
    },
  ]);
  assert.deepEqual(
    await releaseDequeuedFamilyQueueLease({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      headSha: 'e'.repeat(40),
      body: lease.marker,
      reason: 'failed_checks',
      token: 'test-token',
      request: async () => {
        throw new Error('stale observation must not write');
      },
    }),
    {
      applicable: true,
      state: 'stale-observation',
      leaseRoot: lease.leaseRoot,
      observedHead: 'e'.repeat(40),
    },
  );
});

test('dequeue settlement still revokes the lease when other cleanup fails', async () => {
  const headSha = 'd'.repeat(40);
  const leaseRequests = [];
  const request = async (url, init = {}) => {
    if (url.endsWith(`/statuses/${headSha}`)) {
      leaseRequests.push({
        method: init.method,
        body: JSON.parse(init.body),
      });
      return response(201);
    }
    return response(500);
  };
  await assert.rejects(
    settleDequeuedMergeGroup({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      headSha,
      workflow: 'affected-native-pr.yml',
      context: 'Queue admission lease',
      token: 'test-token',
      request,
    }),
    /dequeue settlement failed \(cancellation: .*; repair-marker: .*\)/u,
  );
  assert.deepEqual(leaseRequests, [
    {
      method: 'POST',
      body: {
        state: 'failure',
        context: 'Queue admission lease',
        description:
          'Lease revoked after merge-queue dequeue; use the serialized wrapper',
      },
    },
  ]);
});

test('failed or conflicting dequeue records one exact-head repair marker', async () => {
  const requests = [];
  const headSha = 'a'.repeat(40);
  const request = async (url, init = {}) => {
    requests.push({
      url,
      method: init.method || 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    if (url.endsWith('/graphql')) {
      return response(200, {
        data: {
          repository: {
            pullRequest: {
              timelineItems: {
                nodes: [
                  {
                    createdAt: '2026-07-27T02:00:00Z',
                    reason: 'MERGE_CONFLICT',
                  },
                ],
              },
            },
          },
        },
      });
    }
    if (url.includes('/issues/1510/comments?')) {
      return response(200, [
        {
          id: 99,
          body: mergeQueueRepairComment({
            headSha,
            reason: 'merge_conflict',
          }),
          user: { login: 'untrusted-contributor' },
        },
      ]);
    }
    if (url.endsWith('/issues/1510/comments')) {
      return response(201, { id: 7 });
    }
    throw new Error(`unexpected request ${url}`);
  };
  assert.deepEqual(
    await recordDequeuedRepairMarker({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      headSha,
      token: 'test-token',
      request,
    }),
    {
      repairRequired: true,
      removal: {
        createdAt: '2026-07-27T02:00:00Z',
        reason: 'merge_conflict',
      },
      headSha,
      comment: 'created',
    },
  );
  assert.equal(requests.at(-1).method, 'POST');
  assert.equal(
    requests.at(-1).body.body,
    mergeQueueRepairComment({ headSha, reason: 'merge_conflict' }),
  );
});

test('manual dequeue does not mint a repair marker', async () => {
  const request = async (url) => {
    assert.match(url, /\/graphql$/u);
    return response(200, {
      data: {
        repository: {
          pullRequest: {
            timelineItems: {
              nodes: [
                {
                  createdAt: '2026-07-27T02:00:00Z',
                  reason: 'MANUAL',
                },
              ],
            },
          },
        },
      },
    });
  };
  assert.deepEqual(
    await recordDequeuedRepairMarker({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      headSha: 'b'.repeat(40),
      token: 'test-token',
      request,
    }),
    {
      repairRequired: false,
      removal: {
        createdAt: '2026-07-27T02:00:00Z',
        reason: 'manual',
      },
      comment: 'not-applicable',
    },
  );
});

test('cancellation is deduplicated and treats terminal races idempotently', async () => {
  const requests = [];
  const run = {
    id: 42,
    event: 'merge_group',
    status: 'in_progress',
    head_branch: 'gh-readonly-queue/dev/v4/v4.0/pr-1510-b63868f6ea79',
  };
  const request = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    if (url.endsWith('/actions/runs/42/cancel')) return response(409);
    const status = new URL(url).searchParams.get('status');
    return response(200, {
      workflow_runs: ['in_progress', 'queued'].includes(status) ? [run] : [],
    });
  };
  assert.deepEqual(
    await cancelDequeuedMergeGroupRuns({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      workflow: 'affected-native-pr.yml',
      token: 'test-token',
      request,
    }),
    {
      pullRequest: 1510,
      matchedRunCount: 1,
      cancellations: [{ runId: 42, outcome: 'already-terminal' }],
    },
  );
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
});

test('unexpected cancellation failures remain fatal', async () => {
  const run = {
    id: 42,
    event: 'merge_group',
    status: 'queued',
    head_branch: 'gh-readonly-queue/dev/v4/v4.0/pr-1510-b63868f6ea79',
  };
  const request = async (url) =>
    url.endsWith('/actions/runs/42/cancel')
      ? response(403)
      : response(200, {
          workflow_runs:
            new URL(url).searchParams.get('status') === 'queued' ? [run] : [],
        });
  await assert.rejects(
    cancelDequeuedMergeGroupRuns({
      repository: 'kungfu-systems/kungfu',
      pullRequest: 1510,
      workflow: 'affected-native-pr.yml',
      token: 'test-token',
      request,
    }),
    /403 while cancelling workflow run 42/,
  );
});
