#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ACTIVE_STATUSES = [
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
];

function required(value, label, pattern) {
  if (!value || !pattern.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function activeMergeGroupRunsForPull(runs, pullRequest) {
  const branchPattern = new RegExp(`/pr-${pullRequest}-[0-9a-f]{7,40}$`, 'u');
  return runs.filter(
    ({ event, status, head_branch: headBranch }) =>
      event === 'merge_group' &&
      ACTIVE_STATUSES.includes(status) &&
      branchPattern.test(String(headBranch || '')),
  );
}

async function githubResponse(route, token, request, init = {}) {
  const response = await request(`https://api.github.com${route}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kungfu-dequeued-merge-group-cancellation',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  return response;
}

async function activeWorkflowRuns(repository, workflow, token, request) {
  const runs = [];
  for (const status of ACTIVE_STATUSES) {
    for (let page = 1; ; page += 1) {
      const route =
        `/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}` +
        `/runs?event=merge_group&status=${status}&per_page=100&page=${page}`;
      const response = await githubResponse(route, token, request);
      if (!response.ok) {
        throw new Error(
          `GitHub API ${response.status} while listing ${status} merge-group runs`,
        );
      }
      const payload = await response.json();
      if (!Array.isArray(payload.workflow_runs)) {
        throw new Error('GitHub Actions response omitted workflow_runs');
      }
      runs.push(...payload.workflow_runs);
      if (payload.workflow_runs.length < 100) break;
    }
  }
  return runs;
}

export async function cancelDequeuedMergeGroupRuns({
  repository,
  pullRequest,
  workflow,
  token,
  request = fetch,
}) {
  required(repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  required(workflow, 'workflow', /^[A-Za-z0-9_.-]+\.ya?ml$/u);
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error('invalid pull request number');
  }
  if (!token) throw new Error('GitHub token is unavailable');

  const activeRuns = activeMergeGroupRunsForPull(
    await activeWorkflowRuns(repository, workflow, token, request),
    pullRequest,
  );
  const uniqueRuns = [
    ...new Map(activeRuns.map((run) => [Number(run.id), run])).values(),
  ].sort((left, right) => Number(left.id) - Number(right.id));
  const cancellations = [];
  for (const run of uniqueRuns) {
    const response = await githubResponse(
      `/repos/${repository}/actions/runs/${run.id}/cancel`,
      token,
      request,
      { method: 'POST' },
    );
    if (response.status === 202) {
      cancellations.push({ runId: Number(run.id), outcome: 'accepted' });
      continue;
    }
    if (response.status === 409) {
      cancellations.push({
        runId: Number(run.id),
        outcome: 'already-terminal',
      });
      continue;
    }
    throw new Error(
      `GitHub API ${response.status} while cancelling workflow run ${run.id}`,
    );
  }
  return {
    pullRequest,
    matchedRunCount: uniqueRuns.length,
    cancellations,
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const pullRequest = Number(process.env.DEQUEUED_PULL_REQUEST || 0);
  const workflow = process.env.MERGE_GROUP_WORKFLOW || 'affected-native-pr.yml';
  const token = process.env.GITHUB_TOKEN || '';
  const result = await cancelDequeuedMergeGroupRuns({
    repository,
    pullRequest,
    workflow,
    token,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(
      `[dequeued-merge-group-cancellation] ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
