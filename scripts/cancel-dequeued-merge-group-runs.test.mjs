// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activeMergeGroupRunsForPull,
  cancelDequeuedMergeGroupRuns,
} from './cancel-dequeued-merge-group-runs.mjs';

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
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(workflow, /pull_request\.head/u);
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
