#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { validateDeliveryAttempt } from './affected-native-proof.mjs';
import {
  parseFamilyQueueLeaseMarker,
  releaseFamilyQueueLease,
} from './project-cut-merge-queue-admission.mjs';

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

function deliveryMilliseconds(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
}

function sortedStrings(values) {
  return [...new Set((values || []).map(String))].sort();
}

export function affectedNativeEvidenceBinding(
  cache,
  native,
  classification,
  expectedSourceSha,
  pullSourceSha,
) {
  if (
    cache.layers.some(
      ({ sourceSha }) => !sourceSha || sourceSha !== expectedSourceSha,
    ) ||
    native.outcome !== 'observed' ||
    native.source?.head !== expectedSourceSha ||
    JSON.stringify(native.planAuthority) !==
      JSON.stringify(classification.authority)
  ) {
    throw new Error('affected-native evidence does not match source or plan');
  }
  const exactPlan =
    JSON.stringify(native.planChangedPaths) ===
    JSON.stringify(classification.changedPaths);
  if (!exactPlan && expectedSourceSha === pullSourceSha) {
    throw new Error('affected-native evidence does not match source or plan');
  }
  return {
    sourceRelation:
      expectedSourceSha === pullSourceSha
        ? 'pull-source'
        : 'merge-group-source',
    planRelation: exactPlan ? 'exact' : 'merge-group-coalesced',
  };
}

export function roundAttempt(pullRequest, round) {
  const run = round.mergeGroupRuns[0];
  return {
    id: `mq-${pullRequest}-${round.index}`,
    index: round.index + 1,
    kind: 'merge-queue',
    mergeGroupSha: run?.headSha,
    workflowRunId: run?.id,
  };
}

export function readZipMembers(archive, names) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-dev-gate-latency-'),
  );
  const archivePath = path.join(temporary, 'artifact.zip');
  try {
    fs.writeFileSync(archivePath, archive);
    const listing = spawnSync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      shell: false,
    });
    if (listing.status !== 0) {
      throw new Error(
        `cannot list artifact zip: ${(listing.stderr || '').trim() || 'unzip failed'}`,
      );
    }
    const entries = listing.stdout.split('\n').filter(Boolean);
    return Object.fromEntries(
      names.map((name) => {
        const entry = entries.find(
          (candidate) => candidate === name || candidate.endsWith(`/${name}`),
        );
        if (!entry) return [name, null];
        const extracted = spawnSync('unzip', ['-p', archivePath, entry], {
          encoding: 'utf8',
          shell: false,
          maxBuffer: 4 * 1024 * 1024,
        });
        if (extracted.status !== 0) {
          throw new Error(`cannot read ${entry} from artifact zip`);
        }
        return [name, extracted.stdout];
      }),
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function deliveryAttemptEvidenceFromMembers(members, expected) {
  const raw = members['delivery-attempt.json'];
  if (!raw) {
    return {
      outcome: 'missing',
      authority: 'affected-native-delivery-attempt-artifact',
      reason: 'delivery-attempt.json is missing',
    };
  }
  try {
    const attempt = validateDeliveryAttempt(JSON.parse(raw));
    const expectedContexts = sortedStrings(expected.requiredContexts);
    const actualContexts = sortedStrings(attempt.requiredChecks?.contexts);
    const disagreements = [];
    if (attempt.workflow.repository !== expected.repository) {
      disagreements.push('repository');
    }
    if (attempt.workflow.runId !== Number(expected.workflowRunId)) {
      disagreements.push('workflow-run');
    }
    if (attempt.source.pullRequestHead !== expected.pullRequestHead) {
      disagreements.push('pull-request-head');
    }
    if (attempt.source.mergeGroupHead !== expected.mergeGroupHead) {
      disagreements.push('merge-group-head');
    }
    if (attempt.source.checkout !== expected.mergeGroupHead) {
      disagreements.push('checkout-head');
    }
    if (JSON.stringify(actualContexts) !== JSON.stringify(expectedContexts)) {
      disagreements.push('required-contexts');
    }
    if (disagreements.length) {
      return {
        outcome: 'invalidated',
        authority: 'affected-native-delivery-attempt-artifact',
        reason: `delivery attempt disagrees on ${disagreements.join(', ')}`,
        disagreements,
        attemptRoot: attempt.attemptRoot,
      };
    }
    return {
      outcome: 'proved',
      authority: 'affected-native-delivery-attempt-artifact',
      attemptRoot: attempt.attemptRoot,
      deliveryBindingRoot: attempt.deliveryBindingRoot,
      source: attempt.source,
      family: attempt.family,
      requiredChecks: attempt.requiredChecks,
      queueAdmission: attempt.queueAdmission,
      proof: attempt.proof,
      workflow: attempt.workflow,
    };
  } catch (error) {
    return {
      outcome: 'invalidated',
      authority: 'affected-native-delivery-attempt-artifact',
      reason: error.message,
    };
  }
}

export function finalDevAncestryFromCompare(
  mergeCommitSha,
  finalDevHead,
  comparison,
) {
  if (
    !/^[0-9a-f]{40}$/u.test(mergeCommitSha || '') ||
    !/^[0-9a-f]{40}$/u.test(finalDevHead || '')
  ) {
    return {
      outcome: 'unknown',
      authority: 'github-compare',
      reason: 'merge commit or final dev head is unavailable',
      mergeCommitSha: mergeCommitSha || null,
      finalDevHead: finalDevHead || null,
    };
  }
  const status = comparison?.status || null;
  const mergeBase = comparison?.merge_base_commit?.sha || null;
  const proved =
    ['ahead', 'identical'].includes(status) && mergeBase === mergeCommitSha;
  return {
    outcome: proved ? 'proved' : 'invalidated',
    authority: 'github-compare',
    mergeCommitSha,
    finalDevHead,
    compareStatus: status,
    mergeBase,
    ...(proved
      ? {}
      : {
          reason:
            'merged pull request commit is not an ancestor of final dev head',
        }),
  };
}

export function reconstructDeliveryEvidence({
  pullRequest,
  sourceSha,
  mergeCommitSha,
  requiredContexts,
  requiredWindow,
  mergeQueue,
  deliveryAttempt,
  finalDev,
}) {
  const authority =
    'family-lease+github-merge-queue+affected-native-proof+github-compare';
  const rounds = mergeQueue?.rounds || [];
  const queue = {
    authority: mergeQueue?.authority || null,
    firstEnqueuedAt: mergeQueue?.firstEnqueuedAt || null,
    mergedAt: mergeQueue?.mergedAt || null,
    deliveryDurationMs: mergeQueue?.deliveryDurationMs ?? null,
    dequeueCount: mergeQueue?.dequeueCount ?? null,
    dequeueReasons: mergeQueue?.dequeueReasons || {},
    repeatedValidationCount: mergeQueue?.repeatedValidationCount ?? null,
    runnerEvidenceComplete: mergeQueue?.runnerEvidenceComplete === true,
    wastedRunnerMs: mergeQueue?.wastedRunnerMs ?? null,
    postDequeueRunnerMs: mergeQueue?.postDequeueRunnerMs ?? null,
    rounds: rounds.map((round) => ({
      index: round.index,
      enqueuedAt: round.enqueuedAt,
      removedAt: round.removedAt,
      reason: round.reason,
      beforeCommit: round.beforeCommit || null,
      mergeGroupRuns: (round.mergeGroupRuns || []).map((run) => {
        const jobs = run.jobs || [];
        const measuredJobs = jobs.filter(
          ({ startedAt, completedAt }) => startedAt && completedAt,
        );
        return {
          id: run.id,
          headSha: run.headSha,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          status: run.status,
          conclusion: run.conclusion,
          runnerUse: {
            jobCount: jobs.length,
            measuredJobCount: measuredJobs.length,
            runnerMs:
              measuredJobs.length === jobs.length
                ? measuredJobs.reduce(
                    (total, job) =>
                      total +
                      deliveryMilliseconds(job.startedAt, job.completedAt),
                    0,
                  )
                : null,
          },
        };
      }),
    })),
  };
  if (
    deliveryAttempt?.outcome === 'invalidated' ||
    finalDev?.outcome === 'invalidated'
  ) {
    return {
      outcome: 'invalidated',
      authority,
      reason:
        deliveryAttempt?.outcome === 'invalidated'
          ? deliveryAttempt.reason
          : finalDev.reason,
      pullRequest,
      sourceSha,
      mergeCommitSha: mergeCommitSha || null,
      queue,
      requiredWindow,
      deliveryAttempt,
      finalDev,
    };
  }
  const mergedRound = [...rounds]
    .reverse()
    .find(({ reason }) => reason === 'merged');
  const mergedRun = mergedRound?.mergeGroupRuns?.find(
    ({ id }) => Number(id) === Number(deliveryAttempt?.workflow?.runId),
  );
  if (
    mergeQueue?.queueStatus === 'not-observed' ||
    !mergedRound ||
    deliveryAttempt?.outcome === 'missing'
  ) {
    return {
      outcome: 'missing',
      authority,
      reason:
        deliveryAttempt?.outcome === 'missing'
          ? deliveryAttempt.reason
          : 'authoritative merged merge-queue round is missing',
      pullRequest,
      sourceSha,
      mergeCommitSha: mergeCommitSha || null,
      queue,
      requiredWindow,
      deliveryAttempt,
      finalDev,
    };
  }
  const expectedContexts = sortedStrings(requiredContexts);
  const observedContexts = sortedStrings(
    requiredWindow?.contexts?.map(({ context }) => context),
  );
  const complete =
    mergeQueue?.status === 'observed' &&
    mergeQueue?.runnerEvidenceComplete === true &&
    requiredWindow?.status === 'observed' &&
    JSON.stringify(observedContexts) === JSON.stringify(expectedContexts) &&
    deliveryAttempt?.outcome === 'proved' &&
    mergedRun &&
    Number(mergedRun.id) === Number(deliveryAttempt.workflow?.runId) &&
    mergedRun.headSha === deliveryAttempt.source?.mergeGroupHead &&
    sourceSha === deliveryAttempt.source?.pullRequestHead &&
    finalDev?.outcome === 'proved';
  return {
    outcome: complete ? 'proved' : 'partial',
    authority,
    ...(complete
      ? {}
      : {
          reason:
            'one or more queue, required-check, runner, source, or final-dev facts are incomplete',
        }),
    pullRequest,
    sourceSha,
    mergeCommitSha: mergeCommitSha || null,
    requiredContexts: expectedContexts,
    queue,
    requiredWindow,
    mergedRound: mergedRound
      ? {
          index: mergedRound.index,
          enqueuedAt: mergedRound.enqueuedAt,
          removedAt: mergedRound.removedAt,
          dequeueReason: mergedRound.reason,
          workflowRunId: mergedRun?.id || null,
          mergeGroupHead: mergedRun?.headSha || null,
        }
      : null,
    dequeueCount: mergeQueue?.dequeueCount ?? null,
    deliveryAttempt,
    finalDev,
  };
}

export function missingDeliveryAttempt(authority, reason, workflowRunId) {
  return {
    outcome: 'missing',
    authority,
    reason,
    ...(workflowRunId === undefined ? {} : { workflowRunId }),
  };
}

export async function collectDeliveryAttemptFromArtifacts({
  artifacts,
  expectedSourceSha,
  repository,
  workflowRunId,
  pullSourceSha,
  requiredContexts,
  token,
  githubBytes,
}) {
  const artifact = (artifacts || []).find(
    ({ name, expired }) =>
      !expired &&
      name === `core-affected-native-delivery-attempt-${expectedSourceSha}`,
  );
  if (!artifact) {
    return missingDeliveryAttempt(
      'affected-native-delivery-attempt-artifact',
      'delivery-attempt artifact is missing or expired',
    );
  }
  const archive = await githubBytes(
    `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    token,
  );
  return {
    ...deliveryAttemptEvidenceFromMembers(
      readZipMembers(archive, ['delivery-attempt.json']),
      {
        repository,
        workflowRunId,
        pullRequestHead: pullSourceSha,
        mergeGroupHead: expectedSourceSha,
        requiredContexts,
      },
    ),
    artifactId: artifact.id,
    artifactName: artifact.name,
  };
}

export function deliveryEvidenceForSample({
  pull,
  sourceSha,
  requiredContexts,
  requiredWindow,
  mergeQueue,
  evidence,
  finalDev,
  latencyOnly,
}) {
  const deliveryAttempt =
    evidence.deliveryAttempt ||
    missingDeliveryAttempt(
      latencyOnly
        ? 'latency-only-collection'
        : 'affected-native-delivery-attempt-artifact',
      latencyOnly
        ? 'delivery attempt skipped in latency-only collection'
        : 'delivery attempt was not returned',
    );
  return reconstructDeliveryEvidence({
    pullRequest: pull.number,
    sourceSha,
    mergeCommitSha: pull.merge_commit_sha,
    requiredContexts,
    requiredWindow,
    mergeQueue,
    deliveryAttempt,
    finalDev,
  });
}

export function deliveryTimelineEvent(sample, rounds, sourceSha) {
  const deliveryAttempt = sample.deliveryEvidence?.deliveryAttempt;
  const attempt = rounds.length
    ? roundAttempt(sample.pullRequest, rounds.at(-1))
    : null;
  if (!attempt || !deliveryAttempt) return null;
  return {
    id: `${attempt.id}:delivery-proof`,
    attempt: {
      ...attempt,
      mergeGroupSha: deliveryAttempt.source?.mergeGroupHead,
      workflowRunId: deliveryAttempt.workflow?.runId,
    },
    phase: 'delivery-proof',
    category: 'proof-evidence',
    status: 'unknown',
    criticalPathEligible: false,
    attributes: {
      sourceSha,
      outcome: sample.deliveryEvidence.outcome,
      proofDecision: deliveryAttempt.proof?.decision || null,
      proofRoot: deliveryAttempt.proof?.proofRoot || null,
      deliveryAttemptRoot: deliveryAttempt.attemptRoot || null,
      deliveryBindingRoot: deliveryAttempt.deliveryBindingRoot || null,
      familyLeaseRoot: deliveryAttempt.family?.leaseRoot || null,
      deliveryClass: deliveryAttempt.family?.deliveryClass || null,
      requiredChecksRoot: deliveryAttempt.requiredChecks?.root || null,
      queueAdmissionRoot: deliveryAttempt.queueAdmission?.root || null,
    },
  };
}

export function summarizeDeliveryEvidence(samples) {
  return {
    authority:
      'family-lease+github-merge-queue+affected-native-proof+github-compare',
    promotionEffect: 'advisory-only',
    ...Object.fromEntries(
      ['proved', 'partial', 'missing', 'invalidated'].map((outcome) => [
        `${outcome}Count`,
        samples.filter(
          ({ deliveryEvidence: evidence }) => evidence?.outcome === outcome,
        ).length,
      ]),
    ),
  };
}

export async function collectFinalDevAncestry({
  merged,
  finalDevHead,
  repository,
  githubJson,
}) {
  const entries = await Promise.all(
    merged.map(async (pull) => {
      if (!pull.merge_commit_sha || !finalDevHead) {
        return [
          pull.number,
          finalDevAncestryFromCompare(
            pull.merge_commit_sha,
            finalDevHead,
            null,
          ),
        ];
      }
      try {
        const comparison = await githubJson(
          `/repos/${repository}/compare/${pull.merge_commit_sha}...${finalDevHead}`,
        );
        return [
          pull.number,
          finalDevAncestryFromCompare(
            pull.merge_commit_sha,
            finalDevHead,
            comparison,
          ),
        ];
      } catch (error) {
        return [
          pull.number,
          {
            outcome: 'unknown',
            authority: 'github-compare',
            reason: error.message,
            mergeCommitSha: pull.merge_commit_sha,
            finalDevHead,
          },
        ];
      }
    }),
  );
  return new Map(entries);
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
