#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  parseFamilyQueueLeaseMarker,
  releaseFamilyQueueLease,
} from './project-cut-merge-queue-admission.mjs';

export {
  affectedNativeEvidenceBinding,
  collectDeliveryAttemptFromArtifacts,
  collectFinalDevAncestry,
  deliveryAttemptEvidenceFromMembers,
  deliveryEvidenceForSample,
  deliveryTimelineEvent,
  finalDevAncestryFromCompare,
  missingDeliveryAttempt,
  readZipMembers,
  reconstructDeliveryEvidence,
  roundAttempt,
  summarizeDeliveryEvidence,
} from '../framework/maintainability/delivery-evidence.mjs';

const ACTIVE_STATUSES = [
  'queued',
  'in_progress',
  'requested',
  'waiting',
  'pending',
];
const REPAIR_REASONS = new Set([
  'failed_checks',
  'invalid_merge_commit',
  'merge_conflict',
]);
const REPAIR_MARKER = '<!-- kungfu-merge-queue-repair:v1';
export const DEQUEUE_EVIDENCE_SCHEMA =
  'kungfu.family-delivery-dequeue-evidence/v1';

function semanticDigest(value) {
  const ordered = (item) => {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, ordered(item[key])]),
      );
    }
    return item;
  };
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex')}`;
}

export function createDequeueEvidence({
  repository,
  pullRequest,
  headSha,
  settlement,
}) {
  const evidence = {
    schema: DEQUEUE_EVIDENCE_SCHEMA,
    source: {
      repository,
      pullRequest,
      pullRequestHead: headSha,
    },
    dequeue: {
      reason: settlement.repairMarker?.removal?.reason || null,
      observedAt: settlement.repairMarker?.removal?.createdAt || null,
    },
    cancellation: settlement.cancellation,
    queueAdmissionLease: settlement.queueAdmissionLease,
    familyQueueLease: {
      applicable: settlement.familyQueueLease?.applicable === true,
      state: settlement.familyQueueLease?.state || null,
      leaseRoot:
        settlement.familyQueueLease?.release?.predecessorLeaseRoot ||
        settlement.familyQueueLease?.leaseRoot ||
        null,
      releaseRoot: settlement.familyQueueLease?.release?.releaseRoot || null,
    },
  };
  return { ...evidence, evidenceRoot: semanticDigest(evidence) };
}

function required(value, label, pattern) {
  if (!value || !pattern.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function validateDevRequiredLatencyBaseline(
  baseline,
  requiredContexts,
  allowedContextAdditions = [],
) {
  if (baseline.$schema !== 'kungfu.dev-required-latency-baseline/v1') {
    throw new Error('unsupported dev required latency baseline schema');
  }
  const expected = [...baseline.requiredContexts].sort();
  const actual = [...requiredContexts].sort();
  const allowed = [...new Set(allowedContextAdditions)].sort();
  const additions = actual.filter((context) => !expected.includes(context));
  const removals = expected.filter((context) => !actual.includes(context));
  if (
    removals.length ||
    additions.some((context) => !allowed.includes(context))
  ) {
    throw new Error(
      `live required contexts drifted: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
    );
  }
  return true;
}

export function queueAdmissionRequiredContexts(contract) {
  if (contract?.schema !== 'kungfu.dev-queue-admission/v1') {
    throw new Error('unsupported dev queue admission contract schema');
  }
  if (contract.rulesetActivation?.required !== true) {
    throw new Error(
      'dev queue admission contract must require ruleset activation',
    );
  }
  const context = String(contract.requiredContext || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,99}$/u.test(context)) {
    throw new Error('dev queue admission required context is invalid');
  }
  return [context];
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

function splitRepository(repository) {
  const [owner, name] = repository.split('/');
  return { owner, name };
}

export function mergeQueueRepairComment({ headSha, reason }) {
  required(headSha, 'head sha', /^[0-9a-f]{40}$/u);
  required(reason, 'dequeue reason', /^[a-z_]+$/u);
  return (
    `${REPAIR_MARKER} head=${headSha} reason=${reason} -->\n` +
    `Merge queue repair required for source \`${headSha.slice(0, 12)}\`: ` +
    `\`${reason}\`. Push a corrected source revision before re-enqueueing.`
  );
}

async function latestMergeQueueRemoval({
  repository,
  pullRequest,
  token,
  request,
}) {
  const { owner, name } = splitRepository(repository);
  const response = await githubResponse('/graphql', token, request, {
    method: 'POST',
    body: JSON.stringify({
      query: `query($owner:String!,$name:String!,$number:Int!){
        repository(owner:$owner,name:$name){
          pullRequest(number:$number){
            timelineItems(last:20,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){
              nodes{
                ... on RemovedFromMergeQueueEvent{createdAt reason}
              }
            }
          }
        }
      }`,
      variables: { owner, name, number: pullRequest },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} while reading merge-queue removal`,
    );
  }
  const payload = await response.json();
  const nodes = payload?.data?.repository?.pullRequest?.timelineItems?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('merge-queue removal timeline is unavailable');
  }
  const removal = nodes.at(-1);
  const reason = String(removal?.reason || '').toLowerCase();
  required(reason, 'dequeue reason', /^[a-z_]+$/u);
  return {
    createdAt: required(
      String(removal?.createdAt || ''),
      'dequeue timestamp',
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u,
    ),
    reason,
  };
}

async function upsertRepairComment({
  repository,
  pullRequest,
  body,
  token,
  request,
}) {
  const listRoute = `/repos/${repository}/issues/${pullRequest}/comments?per_page=100&sort=created&direction=desc`;
  const listResponse = await githubResponse(listRoute, token, request);
  if (!listResponse.ok) {
    throw new Error(
      `GitHub API ${listResponse.status} while listing repair comments`,
    );
  }
  const comments = await listResponse.json();
  if (!Array.isArray(comments)) {
    throw new Error('GitHub issue comments response is invalid');
  }
  const existing = comments.find(
    ({ body: candidate, user }) =>
      user?.login === 'github-actions[bot]' &&
      String(candidate || '').startsWith(REPAIR_MARKER),
  );
  const route = existing
    ? `/repos/${repository}/issues/comments/${existing.id}`
    : `/repos/${repository}/issues/${pullRequest}/comments`;
  const response = await githubResponse(route, token, request, {
    method: existing ? 'PATCH' : 'POST',
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status} while writing repair comment`,
    );
  }
  return existing ? 'updated' : 'created';
}

export async function recordDequeuedRepairMarker({
  repository,
  pullRequest,
  headSha,
  removal: observedRemoval = null,
  token,
  request = fetch,
}) {
  required(repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  required(headSha, 'head sha', /^[0-9a-f]{40}$/u);
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error('invalid pull request number');
  }
  if (!token) throw new Error('GitHub token is unavailable');

  const removal =
    observedRemoval ||
    (await latestMergeQueueRemoval({
      repository,
      pullRequest,
      token,
      request,
    }));
  if (!REPAIR_REASONS.has(removal.reason)) {
    return {
      repairRequired: false,
      removal,
      comment: 'not-applicable',
    };
  }
  const comment = await upsertRepairComment({
    repository,
    pullRequest,
    body: mergeQueueRepairComment({ headSha, reason: removal.reason }),
    token,
    request,
  });
  return {
    repairRequired: true,
    removal,
    headSha,
    comment,
  };
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

export async function revokeQueueAdmissionLease({
  repository,
  headSha,
  context,
  token,
  request = fetch,
}) {
  required(repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  required(headSha, 'head sha', /^[0-9a-f]{40}$/u);
  required(
    context,
    'queue admission context',
    /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,99}$/u,
  );
  if (!token) throw new Error('GitHub token is unavailable');

  const response = await githubResponse(
    `/repos/${repository}/statuses/${headSha}`,
    token,
    request,
    {
      method: 'POST',
      body: JSON.stringify({
        state: 'failure',
        context,
        description:
          'Lease revoked after merge-queue dequeue; use the serialized wrapper',
      }),
    },
  );
  if (response.status !== 201) {
    throw new Error(
      `GitHub API ${response.status} while revoking queue admission lease`,
    );
  }
  return { headSha, context, state: 'failure' };
}

export function preserveQueueAdmissionLease({ headSha, context, reason }) {
  required(headSha, 'head sha', /^[0-9a-f]{40}$/u);
  required(
    context,
    'queue admission context',
    /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,99}$/u,
  );
  if (reason !== 'merged') {
    throw new Error('queue admission lease can be preserved only after merge');
  }
  return { headSha, context, state: 'preserved', reason };
}

export async function releaseDequeuedFamilyQueueLease({
  repository,
  pullRequest,
  headSha,
  body,
  reason,
  token,
  request = fetch,
}) {
  required(repository, 'repository', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  required(headSha, 'head sha', /^[0-9a-f]{40}$/u);
  if (!Number.isInteger(pullRequest) || pullRequest < 1) {
    throw new Error('invalid pull request number');
  }
  if (!token) throw new Error('GitHub token is unavailable');

  const lease = parseFamilyQueueLeaseMarker(body);
  if (lease === null) {
    return {
      applicable: false,
      state: 'not-applicable',
    };
  }
  if (lease.pullRequestHead !== headSha) {
    return {
      applicable: true,
      state: 'stale-observation',
      leaseRoot: lease.leaseRoot,
      observedHead: headSha,
    };
  }
  const releaseReason =
    reason ||
    (
      await latestMergeQueueRemoval({
        repository,
        pullRequest,
        token,
        request,
      })
    ).reason;
  required(releaseReason, 'dequeue reason', /^[a-z_]+$/u);
  const release = releaseFamilyQueueLease(lease, {
    expectedLeaseRoot: lease.leaseRoot,
    observedHead: headSha,
    terminalReason: `dequeue-${releaseReason}`,
    evidenceRoots: [],
  });
  const response = await githubResponse(
    `/repos/${repository}/statuses/${headSha}`,
    token,
    request,
    {
      method: 'POST',
      body: JSON.stringify({
        state: 'success',
        context: lease.statusContext,
        description: `Released ${release.releaseRoot.slice(7, 19)} after dequeue`,
      }),
    },
  );
  if (response.status !== 201) {
    throw new Error(
      `GitHub API ${response.status} while releasing family queue lease`,
    );
  }
  return {
    applicable: true,
    state: 'released',
    release,
  };
}

export async function settleDequeuedMergeGroup({
  repository,
  pullRequest,
  headSha,
  pullRequestBody = '',
  workflow,
  context,
  token,
  request = fetch,
}) {
  const removalPromise = latestMergeQueueRemoval({
    repository,
    pullRequest,
    token,
    request,
  });
  const results = await Promise.allSettled([
    cancelDequeuedMergeGroupRuns({
      repository,
      pullRequest,
      workflow,
      token,
      request,
    }),
    removalPromise.then((observedRemoval) =>
      recordDequeuedRepairMarker({
        repository,
        pullRequest,
        headSha,
        removal: observedRemoval,
        token,
        request,
      }),
    ),
    removalPromise.then(
      (observedRemoval) =>
        observedRemoval.reason === 'merged'
          ? preserveQueueAdmissionLease({
              headSha,
              context,
              reason: observedRemoval.reason,
            })
          : revokeQueueAdmissionLease({
              repository,
              headSha,
              context,
              token,
              request,
            }),
      () =>
        revokeQueueAdmissionLease({
          repository,
          headSha,
          context,
          token,
          request,
        }),
    ),
    removalPromise.then(
      (observedRemoval) =>
        releaseDequeuedFamilyQueueLease({
          repository,
          pullRequest,
          headSha,
          body: pullRequestBody,
          reason: observedRemoval.reason,
          token,
          request,
        }),
      () =>
        releaseDequeuedFamilyQueueLease({
          repository,
          pullRequest,
          headSha,
          body: pullRequestBody,
          reason: '',
          token,
          request,
        }),
    ),
  ]);
  const failures = results
    .map((result, index) =>
      result.status === 'rejected'
        ? `${
            [
              'cancellation',
              'repair-marker',
              'lease-revocation',
              'family-lease-release',
            ][index]
          }: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`
        : '',
    )
    .filter(Boolean);
  if (failures.length) {
    throw new Error(`dequeue settlement failed (${failures.join('; ')})`);
  }
  const [cancellation, repairMarker, queueAdmissionLease, familyQueueLease] =
    results;
  if (
    cancellation.status !== 'fulfilled' ||
    repairMarker.status !== 'fulfilled' ||
    queueAdmissionLease.status !== 'fulfilled' ||
    familyQueueLease.status !== 'fulfilled'
  ) {
    throw new Error('dequeue settlement result invariant failed');
  }
  const settlement = {
    cancellation: cancellation.value,
    repairMarker: repairMarker.value,
    queueAdmissionLease: queueAdmissionLease.value,
    familyQueueLease: familyQueueLease.value,
  };
  return {
    ...settlement,
    evidence: createDequeueEvidence({
      repository,
      pullRequest,
      headSha,
      settlement,
    }),
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY || '';
  const pullRequest = Number(process.env.DEQUEUED_PULL_REQUEST || 0);
  const workflow = process.env.MERGE_GROUP_WORKFLOW || 'affected-native-pr.yml';
  const headSha = process.env.DEQUEUED_HEAD_SHA || '';
  const pullRequestBody = process.env.DEQUEUED_PULL_REQUEST_BODY || '';
  const context = process.env.QUEUE_ADMISSION_CONTEXT || '';
  const token = process.env.GITHUB_TOKEN || '';
  const output = process.env.DEQUEUE_EVIDENCE_OUTPUT || '';
  const result = await settleDequeuedMergeGroup({
    repository,
    pullRequest,
    headSha,
    pullRequestBody,
    workflow,
    context,
    token,
  });
  if (output) {
    const target = path.resolve(output);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(result.evidence, null, 2)}\n`);
  }
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
