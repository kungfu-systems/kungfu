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

import {
  affectedNativeEvidenceBinding as bindAffectedNativeEvidence,
  readZipMembers,
} from '../framework/maintainability/delivery-evidence.mjs';
import { verifyCachePromotionAuthority } from './affected-native-proof.mjs';
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

export function unknownAffectedNativeClassification(reason) {
  return { kind: 'unknown', reason, planDigest: null };
}

export function affectedNativeClassification(
  plan,
  classificationAuthority = 'current-source-planner',
) {
  return {
    kind: plan.closureComponents.length ? 'native' : 'non-native',
    reason: plan.platformTier,
    baseSha: plan.base,
    sourceSha: plan.head,
    planDigest: plan.planDigest,
    changedPaths: plan.changedPaths,
    authority: plan.authority,
    classificationAuthority,
  };
}

export function devCandidatePlanArtifactSelection(artifacts, sourceSha) {
  const name = `dev-candidate-plan-${sourceSha}`;
  const selected = (artifacts || []).filter(
    (artifact) => !artifact.expired && artifact.name === name,
  );
  if (selected.length !== 1) {
    throw new Error(
      selected.length
        ? 'dev candidate plan artifact is ambiguous'
        : 'dev candidate plan artifact is missing',
    );
  }
  return selected[0];
}

export function affectedNativeComparedPaths(files) {
  return [
    ...new Set(
      files
        .filter((file) => file.status !== 'removed')
        .map((file) => file.filename)
        .filter(Boolean),
    ),
  ].sort();
}

export function classificationFromPlanMembers(
  members,
  { expectedSourceSha, expectedBaseSha, changedPaths },
) {
  if (!members['plan.json']) {
    throw new Error('dev candidate plan.json is missing');
  }
  const plan = JSON.parse(members['plan.json']);
  const { planDigest, ...planWithoutDigest } = plan;
  if (
    plan.schema !== 'kungfu.core-affected-native-plan/v1' ||
    plan.head !== expectedSourceSha ||
    (expectedBaseSha && plan.base !== expectedBaseSha) ||
    planDigest !== semanticDigest(planWithoutDigest)
  ) {
    throw new Error('dev candidate plan identity or digest drift');
  }
  if (
    (changedPaths &&
      JSON.stringify(plan.changedPaths) !== JSON.stringify(changedPaths)) ||
    !Array.isArray(plan.closureComponents) ||
    !/^[0-9a-f]{40}$/u.test(plan.base) ||
    !/^sha256:[0-9a-f]{64}$/u.test(plan.authority?.layers || '') ||
    !/^sha256:[0-9a-f]{64}$/u.test(plan.authority?.buildCapabilities || '')
  ) {
    throw new Error('dev candidate plan source or authority drift');
  }
  const native = plan.closureComponents.length > 0;
  if (
    (native && plan.platformTier !== 'github-hosted-linux-native-pr') ||
    (!native && plan.platformTier !== 'none')
  ) {
    throw new Error('dev candidate plan classification drift');
  }
  return affectedNativeClassification(plan, 'source-bound-dev-candidate-plan');
}

export async function resolveHistoricalPlanClassification({
  repository,
  artifacts,
  expectedSourceSha,
  token,
  githubBytes,
  githubJson,
}) {
  const artifact = devCandidatePlanArtifactSelection(
    artifacts,
    expectedSourceSha,
  );
  const archive = await githubBytes(
    `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    token,
  );
  const classification = classificationFromPlanMembers(
    readZipMembers(archive, ['plan.json']),
    {
      expectedSourceSha,
    },
  );
  const comparison = await githubJson(
    `/repos/${repository}/compare/${classification.baseSha}...${expectedSourceSha}`,
  );
  if (
    comparison.merge_base_commit?.sha !== classification.baseSha ||
    !['ahead', 'identical'].includes(comparison.status)
  ) {
    throw new Error('dev candidate plan base ancestry drift');
  }
  const comparedPaths = affectedNativeComparedPaths(comparison.files);
  if (
    JSON.stringify(classification.changedPaths) !==
    JSON.stringify(comparedPaths)
  ) {
    throw new Error('dev candidate plan compared paths drift');
  }
  return classification;
}

export function affectedNativeArtifactSelection(artifacts, sourceSha) {
  const artifactPrefix = `core-affected-native-${sourceSha}`;
  const partitionPattern = new RegExp(
    `^${artifactPrefix}-partition-(\\d+)-of-(\\d+)$`,
  );
  const selected = (artifacts || [])
    .filter(
      ({ name, expired }) =>
        !expired && (name === artifactPrefix || partitionPattern.test(name)),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const legacy = selected.filter(({ name }) => name === artifactPrefix);
  const partitions = selected
    .map((artifact) => {
      const match = artifact.name.match(partitionPattern);
      return match
        ? {
            artifact,
            index: Number(match[1]),
            count: Number(match[2]),
          }
        : null;
    })
    .filter(Boolean);
  if (legacy.length > 1 || (legacy.length && partitions.length)) {
    throw new Error('affected-native artifact set is ambiguous');
  }
  if (partitions.length) {
    const counts = new Set(partitions.map(({ count }) => count));
    const indexes = partitions.map(({ index }) => index).sort((a, b) => a - b);
    const expected = Array.from(
      { length: partitions[0].count },
      (_value, index) => index,
    );
    if (
      counts.size !== 1 ||
      JSON.stringify(indexes) !== JSON.stringify(expected)
    ) {
      throw new Error('affected-native partition artifact set is incomplete');
    }
  }
  return selected;
}

function verifiedCachePromotionAuthority(archive, options) {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-cache-promotion-authority-'),
  );
  const archivePath = path.join(temporary, 'artifact.zip');
  const extracted = path.join(temporary, 'extracted');
  try {
    fs.writeFileSync(archivePath, archive);
    const listing = spawnSync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      shell: false,
    });
    if (listing.status !== 0) {
      throw new Error('cannot list cache promotion authority artifact');
    }
    const entries = listing.stdout.split('\n').filter(Boolean);
    if (
      entries.some(
        (entry) =>
          path.isAbsolute(entry) || entry.split(/[\\/]/u).includes('..'),
      )
    ) {
      throw new Error('cache promotion authority artifact path is unsafe');
    }
    const unpacked = spawnSync('unzip', ['-q', archivePath, '-d', extracted], {
      encoding: 'utf8',
      shell: false,
    });
    if (unpacked.status !== 0) {
      throw new Error('cannot extract cache promotion authority artifact');
    }
    const rawAuthority = JSON.parse(
      fs.readFileSync(path.join(extracted, 'authority.json'), 'utf8'),
    );
    const authority = verifyCachePromotionAuthority(extracted, {
      ...options,
      now: rawAuthority.producer?.createdAt,
    });
    const proof = JSON.parse(
      fs.readFileSync(path.join(extracted, 'proof', 'proof.json'), 'utf8'),
    );
    return { authority, proof };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function resolveAffectedNativeArtifacts({
  repository,
  runId,
  expectedSourceSha,
  artifacts,
  token,
  githubJson,
  githubBytes,
}) {
  const direct = affectedNativeArtifactSelection(artifacts, expectedSourceSha);
  if (direct.length) {
    return {
      artifacts: direct,
      evidenceSourceSha: expectedSourceSha,
      evidenceRunId: runId,
      proofPartitions: null,
      sourceRelation: 'workflow-source',
    };
  }
  const promotionName = `core-affected-native-cache-promotion-authority-${runId}`;
  const promotionArtifacts = (artifacts || []).filter(
    ({ name, expired }) => !expired && name === promotionName,
  );
  if (promotionArtifacts.length !== 1) {
    throw new Error(
      promotionArtifacts.length
        ? 'cache promotion authority artifact is ambiguous'
        : 'affected-native artifact and cache promotion authority are missing',
    );
  }
  const [commit, archive] = await Promise.all([
    githubJson(`/repos/${repository}/git/commits/${expectedSourceSha}`, token),
    githubBytes(
      `/repos/${repository}/actions/artifacts/${promotionArtifacts[0].id}/zip`,
      token,
    ),
  ]);
  const { authority, proof } = verifiedCachePromotionAuthority(archive, {
    targetRepository: repository,
    targetRunId: runId,
    targetHeadSha: expectedSourceSha,
    targetSourceTree: commit.tree?.sha,
  });
  if (
    authority.producer?.repository !== repository ||
    authority.payloadSourceSha !== authority.producer?.checkoutSha
  ) {
    throw new Error('cache promotion producer repository or source drift');
  }
  const producerPayload = await githubJson(
    `/repos/${repository}/actions/runs/${authority.producer.runId}/artifacts?per_page=100`,
    token,
  );
  const producerArtifacts = affectedNativeArtifactSelection(
    producerPayload.artifacts,
    authority.payloadSourceSha,
  );
  if (
    !producerArtifacts.length ||
    producerArtifacts.length !== authority.partitionCount ||
    proof.partitions?.length !== authority.partitionCount
  ) {
    throw new Error('cache promotion producer partition set is incomplete');
  }
  return {
    artifacts: producerArtifacts,
    evidenceSourceSha: authority.payloadSourceSha,
    evidenceRunId: authority.producer.runId,
    proofPartitions: proof.partitions,
    sourceRelation: 'verified-proof-producer',
  };
}

export function resolvedAffectedNativeEvidenceBinding({
  resolved,
  members,
  cache,
  native,
  classification,
  expectedSourceSha,
  pullSourceSha,
}) {
  if (!resolved.proofPartitions) {
    return bindAffectedNativeEvidence(
      cache,
      native,
      classification,
      expectedSourceSha,
      pullSourceSha,
    );
  }
  const proofPartition = resolved.proofPartitions.find(
    ({ index }) => index === native.executionPartition?.index,
  );
  if (
    !proofPartition ||
    semanticDigest(JSON.parse(members['receipt.json'])) !==
      proofPartition.receiptDigest ||
    native.source?.head !== resolved.evidenceSourceSha ||
    cache.layers.some(
      ({ sourceSha }) => sourceSha !== resolved.evidenceSourceSha,
    )
  ) {
    throw new Error(
      'cache promotion producer evidence does not match verified proof',
    );
  }
  return {
    sourceRelation: resolved.sourceRelation,
    planRelation: 'verified-proof-authority',
  };
}

export function combinedAffectedNativeEvidenceBinding(bindings) {
  const planRelation = bindings.some(
    ({ planRelation }) => planRelation === 'verified-proof-authority',
  )
    ? 'verified-proof-authority'
    : bindings.some(
          ({ planRelation }) => planRelation === 'merge-group-coalesced',
        )
      ? 'merge-group-coalesced'
      : 'exact';
  return { sourceRelation: bindings[0].sourceRelation, planRelation };
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
  const reviewAuthority = contract.rulesetActivation?.reviewAuthority;
  if (
    reviewAuthority?.requireCodeOwnerReview !== true ||
    reviewAuthority?.requireLastPushApproval !== true ||
    reviewAuthority?.emptyCommitIsReviewablePush !== false
  ) {
    throw new Error(
      'dev queue admission contract must preserve fail-closed reviewable-push authority',
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
  const cancellationPromise = removalPromise.then(
    (observedRemoval) =>
      observedRemoval.reason === 'merged'
        ? {
            pullRequest,
            matchedRunCount: 0,
            cancellations: [],
          }
        : cancelDequeuedMergeGroupRuns({
            repository,
            pullRequest,
            workflow,
            token,
            request,
          }),
    () =>
      cancelDequeuedMergeGroupRuns({
        repository,
        pullRequest,
        workflow,
        token,
        request,
      }),
  );
  const results = await Promise.allSettled([
    cancellationPromise,
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
