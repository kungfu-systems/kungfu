#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createCandidateTimeline,
  formatCandidateTimelineReport,
} from '@kungfu-tech/buildchain-alpha/candidate-timeline';
import * as queueEvidence from '../framework/dev-delivery/dev-gate-queue-evidence.mjs';
import { latencyBaselineForDevBranch } from '../framework/version-line/version-line-authority.mjs';
import {
  affectedNativeClassification,
  collectDeliveryAttemptFromArtifacts,
  collectFinalDevAncestry,
  combinedAffectedNativeEvidenceBinding,
  deliveryEvidenceForSample,
  deliveryTimelineEvent,
  missingDeliveryAttempt,
  queueAdmissionRequiredContexts,
  readZipMembers,
  resolveAffectedNativeArtifacts,
  resolveHistoricalPlanClassification,
  resolvedAffectedNativeEvidenceBinding,
  roundAttempt,
  summarizeDeliveryEvidence,
  unknownAffectedNativeClassification as unknownClassification,
  validateDevRequiredLatencyBaseline,
} from './cancel-dequeued-merge-group-runs.mjs';
import {
  collectLatestMergedPullWindow,
  isAdmittedDevBranch,
  latencyOnlyEvidence,
  parseDevRequiredLatencyArgs,
  requiredMergeQueueWindow,
  selectLatencyCohort as selectCohort,
} from './candidate-timeline-events.cjs';
import { planAffectedPaths } from './run-core-affected-native.mjs';
export { requiredMergeQueueWindow };
export {
  postMergeAdvisoryEvidence,
  summarizeMergeQueueDelivery,
  summarizePostMergeAdvisory,
} from '../framework/dev-delivery/dev-gate-queue-evidence.mjs';
export {
  affectedNativeEvidenceBinding,
  deliveryAttemptEvidenceFromMembers,
  finalDevAncestryFromCompare,
  reconstructDeliveryEvidence,
} from './cancel-dequeued-merge-group-runs.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [MINIMUM_SAMPLE_COUNT, MINIMUM_NATIVE_SAMPLE_COUNT] = [20, 10];
const QUEUE_ADMISSION_CONTRACT_PATH = path.join(
  ROOT,
  'docs/qualification/gates/dev-queue-admission.contract.json',
);
function repositoryFromOrigin() {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) return '';
  const match = result.stdout
    .trim()
    .match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] || '';
}

function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const result = spawnSync('gh', ['auth', 'token'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      'GitHub token unavailable; set GH_TOKEN/GITHUB_TOKEN or authenticate gh',
    );
  }
  return result.stdout.trim();
}

function retryDelay(attempt) {
  return new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
}

async function githubResponse(route, token, init = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com${route}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'kungfu-dev-gate-latency',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.headers || {}),
        },
      });
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 500);
      const error = new Error(
        `GitHub API ${response.status} for ${route}: ${body}`,
      );
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (
        !['TypeError', 'TimeoutError'].includes(error.name) ||
        attempt === 2
      ) {
        throw error;
      }
    }
    if (attempt < 2) await retryDelay(attempt);
  }
  throw lastError || new Error(`GitHub API request failed for ${route}`);
}

async function githubJson(route, token) {
  return (await githubResponse(route, token)).json();
}

async function githubBytes(route, token) {
  return Buffer.from(await (await githubResponse(route, token)).arrayBuffer());
}

async function githubGraphql(query, variables, token) {
  const payload = await (
    await githubResponse('/graphql', token, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
      headers: { 'Content-Type': 'application/json' },
    })
  ).json();
  if (payload.errors?.length) {
    throw new Error(
      `GitHub GraphQL failed: ${payload.errors
        .map(({ message }) => message)
        .join('; ')}`,
    );
  }
  return payload.data;
}

async function githubPages(route, token, limit = Number.POSITIVE_INFINITY) {
  const separator = route.includes('?') ? '&' : '?';
  const records = [];
  for (let page = 1; records.length < limit; page += 1) {
    const batch = await githubJson(
      `${route}${separator}per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch)) throw new Error(`expected array from ${route}`);
    records.push(...batch);
    if (batch.length < 100) break;
  }
  return records.slice(0, limit);
}
async function githubWorkflowRuns(route, token) {
  const separator = route.includes('?') ? '&' : '?';
  const records = [];
  for (let page = 1; ; page += 1) {
    const payload = await githubJson(
      `${route}${separator}per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(payload.workflow_runs)) {
      throw new Error(`expected workflow_runs from ${route}`);
    }
    records.push(...payload.workflow_runs);
    if (payload.workflow_runs.length < 100) break;
  }
  return records;
}

function milliseconds(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
}

export function nearestRank(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function summarize(samples) {
  const durations = samples.map(({ durationMs }) => durationMs);
  return {
    sampleCount: samples.length,
    p50Ms: nearestRank(durations, 0.5),
    p95Ms: nearestRank(durations, 0.95),
    maxMs: durations.length ? Math.max(...durations) : null,
  };
}

export function mergeGroupPullNumber(run) {
  const match = String(run.head_branch || '').match(
    /\/pr-(\d+)-[0-9a-f]{7,40}$/,
  );
  return match ? Number(match[1]) : null;
}

export function selectMergeQueueCandidatePulls(pulls, merged, runs) {
  const selectedNumbers = new Set(merged.map(({ number }) => number));
  const runNumbers = new Set(
    runs.map(mergeGroupPullNumber).filter(Number.isInteger),
  );
  const windowStartMs = Math.min(
    ...merged
      .map(({ merged_at: mergedAt }) => Date.parse(mergedAt))
      .filter(Number.isFinite),
  );
  return pulls.filter(
    ({ number, merged_at: mergedAt, updated_at: updatedAt }) => {
      if (selectedNumbers.has(number) || (!mergedAt && runNumbers.has(number)))
        return true;
      if (mergedAt || !Number.isFinite(windowStartMs)) return false;
      const updatedAtMs = Date.parse(updatedAt);
      return Number.isFinite(updatedAtMs) && updatedAtMs >= windowStartMs;
    },
  );
}
function jobDuration(job) {
  if (!job.started_at) return 0;
  if (!job.completed_at) return null;
  return Math.max(0, milliseconds(job.started_at, job.completed_at));
}

function projectedJob(job) {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at || null,
    completedAt: job.completed_at || null,
    runnerName: job.runner_name || null,
    steps: (job.steps || []).map((step) => ({
      number: step.number,
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      startedAt: step.started_at || null,
      completedAt: step.completed_at || null,
    })),
  };
}

export function mergeQueueEvidence(events, runs, jobsByRun, mergedAt) {
  const orderedEvents = [...events]
    .filter(({ __typename }) =>
      ['AddedToMergeQueueEvent', 'RemovedFromMergeQueueEvent'].includes(
        __typename,
      ),
    )
    .sort(
      (left, right) =>
        new Date(left.createdAt).getTime() -
        new Date(right.createdAt).getTime(),
    );
  const orderedRuns = [...runs].sort(
    (left, right) =>
      new Date(left.created_at).getTime() -
      new Date(right.created_at).getTime(),
  );
  const rounds = [];
  const diagnostics = [];
  let current = null;
  for (const event of orderedEvents) {
    if (event.__typename === 'AddedToMergeQueueEvent') {
      if (current) diagnostics.push('queue-add-before-previous-removal');
      current = { enqueuedAt: event.createdAt };
      continue;
    }
    if (!current) {
      diagnostics.push('queue-removal-without-add');
      continue;
    }
    const removedAt = event.createdAt;
    const roundRuns = orderedRuns.filter(({ created_at: createdAt }) => {
      const created = new Date(createdAt).getTime();
      return (
        created >= new Date(current.enqueuedAt).getTime() &&
        created <= new Date(removedAt).getTime()
      );
    });
    rounds.push({
      index: rounds.length,
      enqueuedAt: current.enqueuedAt,
      removedAt,
      durationMs: milliseconds(current.enqueuedAt, removedAt),
      reason: String(event.reason || 'unknown').toLowerCase(),
      beforeCommit: event.beforeCommit?.oid || null,
      mergeGroupRuns: roundRuns.map((run) => ({
        id: run.id,
        workflowIdentity: queueEvidence.workflowIdentity(run),
        headSha: run.head_sha,
        createdAt: run.created_at,
        completedAt: run.updated_at,
        status: run.status,
        conclusion: run.conclusion,
        jobs: (jobsByRun[String(run.id)] || []).map(projectedJob),
      })),
    });
    current = null;
  }
  if (current) diagnostics.push('queue-add-without-removal');

  const assignedRunIds = new Set(
    rounds.flatMap(({ mergeGroupRuns }) =>
      mergeGroupRuns.map(({ id }) => Number(id)),
    ),
  );
  const unassignedRuns = orderedRuns.filter(
    ({ id }) => !assignedRunIds.has(Number(id)),
  );
  if (unassignedRuns.length) diagnostics.push('merge-group-run-outside-round');

  const exitedRounds = rounds.filter(({ reason }) => reason !== 'merged');
  const allRuns = rounds.flatMap(({ mergeGroupRuns }) => mergeGroupRuns);
  const wastedRuns = exitedRounds.flatMap(({ removedAt, mergeGroupRuns }) =>
    mergeGroupRuns.map((run) => ({ ...run, removedAt })),
  );
  let runnerEvidenceComplete = wastedRuns.every(({ id }) =>
    Array.isArray(jobsByRun[String(id)]),
  );
  let wastedRunnerMs = 0;
  let postDequeueRunnerMs = 0;
  const runnerWaitUpperBounds = [];
  let runnerWaitEvidenceComplete = allRuns.every(
    ({ id, createdAt }) =>
      Boolean(createdAt) &&
      Array.isArray(jobsByRun[String(id)]) &&
      jobsByRun[String(id)].length > 0,
  );
  for (const run of allRuns) {
    for (const job of jobsByRun[String(run.id)] || []) {
      if (!run.createdAt || !job.started_at) {
        runnerWaitEvidenceComplete = false;
        continue;
      }
      const upperBoundMs = milliseconds(run.createdAt, job.started_at);
      if (!Number.isFinite(upperBoundMs) || upperBoundMs < 0) {
        runnerWaitEvidenceComplete = false;
        continue;
      }
      runnerWaitUpperBounds.push({
        workflowRunId: run.id,
        jobId: job.id,
        jobName: job.name,
        upperBoundMs,
        authority:
          'github-actions-workflow-created_at-to-job-started_at-upper-bound',
      });
    }
  }
  if (runnerEvidenceComplete) {
    for (const run of wastedRuns) {
      for (const job of jobsByRun[String(run.id)]) {
        const durationMs = jobDuration(job);
        if (durationMs === null) {
          diagnostics.push('merge-group-job-not-terminal');
          runnerEvidenceComplete = false;
          continue;
        }
        wastedRunnerMs += durationMs;
        if (job.started_at && job.completed_at) {
          const afterRemoval = milliseconds(
            new Date(
              Math.max(
                new Date(job.started_at).getTime(),
                new Date(run.removedAt).getTime(),
              ),
            ).toISOString(),
            job.completed_at,
          );
          postDequeueRunnerMs += Math.max(0, afterRemoval);
        }
      }
    }
  }
  const firstEnqueuedAt = rounds[0]?.enqueuedAt || null;
  const mergedRounds = rounds.filter(({ reason }) => reason === 'merged');
  const queueIncomplete = diagnostics.some((value) =>
    [
      'queue-add-before-previous-removal',
      'queue-removal-without-add',
      'queue-add-without-removal',
      'merge-group-run-outside-round',
    ].includes(value),
  );
  const queueStatus = !orderedEvents.length
    ? 'not-observed'
    : rounds.length > 0 && !queueIncomplete
      ? 'observed'
      : 'incomplete';
  const deliveryComplete =
    Boolean(firstEnqueuedAt && mergedAt) &&
    mergedRounds.length === 1 &&
    rounds.at(-1)?.reason === 'merged' &&
    !queueIncomplete;
  const reasonCounts = Object.fromEntries(
    [...new Set(exitedRounds.map(({ reason }) => reason))]
      .sort()
      .map((reason) => [
        reason,
        exitedRounds.filter((round) => round.reason === reason).length,
      ]),
  );
  const validationRepeats = queueEvidence.validationRepeatEvidence(rounds);
  return {
    queueStatus,
    status: deliveryComplete ? 'observed' : 'incomplete',
    authority: 'github-graphql-merge-queue-events+actions-jobs',
    firstEnqueuedAt,
    mergedAt: mergedAt || null,
    deliveryDurationMs:
      firstEnqueuedAt && mergedAt
        ? milliseconds(firstEnqueuedAt, mergedAt)
        : null,
    entryCount: rounds.length,
    dequeueCount: exitedRounds.length,
    dequeueReasons: reasonCounts,
    mergeGroupRunCount: assignedRunIds.size,
    repeatedValidationCount: validationRepeats.repeated,
    explainedRepeatedValidationCount: validationRepeats.explained,
    unexplainedRepeatedValidationCount: validationRepeats.unexplained,
    repeatedValidationExplanations: validationRepeats.explanations,
    runnerWaitEvidenceComplete,
    runnerWaitUpperBoundMs: runnerWaitEvidenceComplete
      ? runnerWaitUpperBounds.length
        ? Math.max(
            ...runnerWaitUpperBounds.map(({ upperBoundMs }) => upperBoundMs),
          )
        : 0
      : null,
    runnerWaitUpperBounds,
    runnerEvidenceComplete,
    wastedRunnerMs: runnerEvidenceComplete ? wastedRunnerMs : null,
    postDequeueRunnerMs: runnerEvidenceComplete ? postDequeueRunnerMs : null,
    rounds,
    diagnostics,
  };
}

export function requiredContextsFromEffectiveRules(rules) {
  if (!Array.isArray(rules)) {
    throw new Error('expected effective branch rules array');
  }
  return [
    ...new Set(
      rules
        .filter(({ type }) => type === 'required_status_checks')
        .flatMap(({ parameters }) => parameters?.required_status_checks || [])
        .map(({ context }) => context)
        .filter(Boolean),
    ),
  ].sort();
}

export function selectedContext(
  checkRuns,
  actionsRuns,
  context,
  admittedBefore = '',
) {
  const candidates = checkRuns
    .filter((check) => check.name === context && check.status === 'completed')
    .sort(
      (left, right) =>
        new Date(left.completed_at) - new Date(right.completed_at),
    );
  if (!candidates.length) return { status: 'missing', context };
  const cutoff = admittedBefore ? new Date(admittedBefore).getTime() : null;
  const eligible = cutoff
    ? candidates.filter(
        ({ completed_at: completedAt }) =>
          new Date(completedAt).getTime() <= cutoff,
      )
    : candidates;
  if (!eligible.length) {
    return {
      status: 'missing',
      context,
      reason: 'no completed check no later than pull merge',
    };
  }
  const successIndex = eligible.findIndex(
    ({ conclusion }) => conclusion === 'success',
  );
  if (successIndex < 0) {
    const latest = eligible.at(-1);
    return { status: 'non-success', context, conclusion: latest.conclusion };
  }
  const admitted = eligible[successIndex];
  const admittedCandidates = eligible.slice(0, successIndex + 1);
  const candidateRunIds = admittedCandidates
    .map(
      ({ details_url: detailsUrl }) =>
        detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1],
    )
    .filter(Boolean);
  const matchingRuns = actionsRuns.filter((run) =>
    candidateRunIds.includes(String(run.id)),
  );
  const finalWorkflowRunId = Number(
    admitted.details_url?.match(/\/actions\/runs\/(\d+)/)?.[1] || 0,
  );
  const finalWorkflowRun = actionsRuns.find(
    ({ id }) => Number(id) === finalWorkflowRunId,
  );
  const created = matchingRuns
    .map(({ created_at: value }) => value)
    .filter(Boolean)
    .sort();
  const start =
    created[0] ||
    admittedCandidates
      .map(({ started_at: value }) => value)
      .filter(Boolean)
      .sort()[0];
  return {
    status: 'success',
    context,
    startedAt: start,
    completedAt: admitted.completed_at,
    durationMs: milliseconds(start, admitted.completed_at),
    queueMs: milliseconds(start, admitted.started_at),
    retryCount: successIndex,
    startAuthority: created.length
      ? 'workflow.created_at'
      : 'check.started_at-fallback',
    endAuthority: admittedBefore
      ? 'first-success-no-later-than-pull-merge'
      : 'first-success',
    checkRunId: admitted.id,
    finalWorkflowRunId,
    finalWorkflowHeadSha: finalWorkflowRun?.head_sha || null,
    workflowRunIds: [...new Set(candidateRunIds.map(Number))].sort(
      (a, b) => a - b,
    ),
  };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function structuredDigest(value) {
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
  return digest(JSON.stringify(ordered(value)));
}

function parseCompilerStats(value) {
  if (!value) return null;
  const calls = value.match(/Cacheable calls:\s+(\d+)\s*\/\s*(\d+)/);
  const hits = value.match(/(?:^|\n)\s*Hits:\s+(\d+)\s*\/\s*(\d+)/);
  const misses = value.match(/(?:^|\n)\s*Misses:\s+(\d+)\s*\/\s*(\d+)/);
  if (!calls || !hits || !misses) return null;
  return {
    cacheableCalls: Number(calls[2]),
    hits: Number(hits[1]),
    misses: Number(misses[1]),
    hitRatio: Number(calls[2]) ? Number(hits[1]) / Number(calls[2]) : null,
  };
}

export function cacheEvidenceFromMembers(members, classification) {
  if (classification.kind === 'non-native') {
    return {
      outcome: 'not-applicable',
      authority: 'source-planner',
      warm: false,
      cold: false,
      layers: [],
      compilerStats: null,
    };
  }
  if (classification.kind !== 'native') {
    return {
      outcome: 'unknown',
      authority: 'classification-unknown',
      warm: false,
      cold: false,
      layers: [],
      compilerStats: null,
    };
  }
  try {
    const layers = ['dependency', 'compiler'].map((layer) => {
      const raw = members[`cache/${layer}.receipt.json`];
      if (!raw) throw new Error(`missing ${layer} receipt`);
      const receipt = JSON.parse(raw);
      if (
        receipt.schema !== 'buildchain.portable-dev-cache-receipt/v1' ||
        receipt.layer !== layer ||
        typeof receipt.outcome !== 'string'
      ) {
        throw new Error(`invalid ${layer} receipt`);
      }
      return {
        layer,
        outcome: receipt.outcome,
        usable: receipt.usable === true,
        qualified: receipt.qualified === true,
        coldFallbackRequired: receipt.coldFallbackRequired === true,
        coldFallbackStatus: receipt.coldFallbackStatus || null,
        sourceSha: receipt.sourceSha || null,
        matchedKey: receipt.matchedKey || null,
        receiptDigest: receipt.receiptDigest || null,
      };
    });
    const outcomes = layers.map(({ outcome }) => outcome);
    const warm =
      layers.every(({ usable, qualified }) => usable && qualified) &&
      outcomes.every((outcome) => ['exact', 'compatible'].includes(outcome));
    const cold = outcomes.some((outcome) =>
      ['miss', 'corrupt'].includes(outcome),
    );
    const coldQualified = layers.every(
      ({
        outcome: value,
        qualified,
        coldFallbackRequired,
        coldFallbackStatus,
      }) =>
        !['miss', 'corrupt'].includes(value) ||
        (qualified && coldFallbackRequired && coldFallbackStatus === 'passed'),
    );
    if (cold && !coldQualified) {
      throw new Error('cold cache outcome lacks a passed fallback receipt');
    }
    const outcome = warm
      ? outcomes.every((value) => value === 'exact')
        ? 'exact'
        : 'compatible'
      : cold
        ? outcomes.includes('corrupt')
          ? 'corrupt'
          : 'miss'
        : 'unknown';
    return {
      outcome,
      authority: 'buildchain-portable-cache-receipt',
      warm,
      cold,
      layers,
      compilerStats: parseCompilerStats(members['cache/compiler-stats.txt']),
    };
  } catch (error) {
    return {
      outcome: 'unknown',
      authority: 'artifact-invalid-or-incomplete',
      reason: error.message,
      warm: false,
      cold: false,
      layers: [],
      compilerStats: null,
    };
  }
}

export function nativeEvidenceFromMembers(members, classification) {
  if (classification.kind === 'non-native') {
    return {
      outcome: 'not-applicable',
      authority: 'source-planner',
      steps: [],
      candidateEvents: [],
    };
  }
  if (classification.kind !== 'native') {
    return {
      outcome: 'unknown',
      authority: 'classification-unknown',
      steps: [],
      candidateEvents: [],
    };
  }
  try {
    if (!members['receipt.json']) throw new Error('missing native receipt');
    if (!members['diagnostics.json']) {
      throw new Error('missing Buildchain diagnostics');
    }
    const receipt = JSON.parse(members['receipt.json']);
    const diagnostics = JSON.parse(members['diagnostics.json']);
    const candidateEvents = (members['candidate-events.jsonl'] || '')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      receipt.schema !== 'kungfu.core-affected-native-receipt/v1' ||
      receipt.status !== 'passed' ||
      !Array.isArray(receipt.steps)
    ) {
      throw new Error('invalid native receipt');
    }
    if (
      candidateEvents.some(
        (event) =>
          !event.id ||
          !event.attempt?.id ||
          !event.phase ||
          !event.status ||
          event.attributes?.sourceSha !== receipt.source.head,
      )
    ) {
      throw new Error('invalid candidate timeline event binding');
    }
    if (receipt.plan?.planDigest) {
      const { planDigest, ...planWithoutDigest } = receipt.plan;
      if (
        planDigest !== structuredDigest(planWithoutDigest) ||
        receipt.planDigest !== planDigest
      ) {
        throw new Error('native receipt plan digest drift');
      }
    }
    if (
      diagnostics.contract !== 'kungfu-buildchain-diagnostics' ||
      diagnostics.consumer?.contract !==
        'kungfu.affected-native-diagnostics/v1' ||
      diagnostics.consumer?.gateId !== 'source.changed-scope'
    ) {
      throw new Error('invalid Buildchain diagnostics binding');
    }
    if (
      receipt.diagnostics?.digest !== digest(members['diagnostics.json']) ||
      receipt.diagnostics?.consumerContract !== diagnostics.consumer.contract ||
      receipt.planDigest !== diagnostics.consumer.planDigest
    ) {
      throw new Error('native diagnostics digest or plan binding drift');
    }
    const partition = receipt.executionPartition || null;
    if (partition) {
      if (
        partition.schema !== 'kungfu.core-affected-native-partition/v1' ||
        !Number.isInteger(partition.index) ||
        !Number.isInteger(partition.count) ||
        partition.count < 1 ||
        partition.index < 0 ||
        partition.index >= partition.count ||
        !Array.isArray(partition.targets) ||
        !Array.isArray(partition.tests) ||
        diagnostics.consumer?.executionPartition?.partitionDigest !==
          partition.partitionDigest ||
        diagnostics.consumer?.executionPartition?.coverageDigest !==
          partition.coverageDigest
      ) {
        throw new Error('invalid native execution partition binding');
      }
    }
    return {
      outcome: 'observed',
      authority: 'affected-native-receipt-and-buildchain-diagnostics',
      source: receipt.source,
      planDigest: receipt.planDigest,
      planTargets: receipt.plan?.targets || [],
      planTests: receipt.plan?.tests || [],
      planChangedPaths: receipt.plan?.changedPaths || [],
      planAuthority: receipt.plan?.authority || null,
      executionPartition: partition,
      durationMs: receipt.durationMs,
      steps: receipt.steps.map(({ id, durationMs, exitCode }) => ({
        id,
        durationMs,
        exitCode,
      })),
      lifecycle: diagnostics.lifecycleObservability || null,
      process: diagnostics.process || null,
      compilerCaches: diagnostics.compilerCaches || {},
      candidateEvents,
    };
  } catch (error) {
    return {
      outcome: 'unknown',
      authority: 'artifact-invalid-or-incomplete',
      reason: error.message,
      steps: [],
      candidateEvents: [],
    };
  }
}

function aggregateCompilerStats(values) {
  if (values.some((value) => !value)) return null;
  const cacheableCalls = values.reduce(
    (total, value) => total + value.cacheableCalls,
    0,
  );
  const hits = values.reduce((total, value) => total + value.hits, 0);
  const misses = values.reduce((total, value) => total + value.misses, 0);
  return {
    cacheableCalls,
    hits,
    misses,
    hitRatio: cacheableCalls ? hits / cacheableCalls : null,
  };
}

export function aggregatePartitionEvidence(entries, classification) {
  if (entries.length === 1 && !entries[0].native.executionPartition) {
    return entries[0];
  }
  if (classification.kind !== 'native') return entries[0];
  if (!entries.length)
    throw new Error('affected-native partition set is empty');
  if (
    entries.some(
      ({ cache, native }) =>
        cache.outcome === 'unknown' ||
        native.outcome !== 'observed' ||
        !native.executionPartition,
    )
  ) {
    throw new Error('affected-native partition evidence is incomplete');
  }
  const orderedEntries = [...entries].sort(
    (left, right) =>
      left.native.executionPartition.index -
      right.native.executionPartition.index,
  );
  const first = orderedEntries[0].native;
  const count = first.executionPartition.count;
  const indices = orderedEntries.map(
    ({ native }) => native.executionPartition.index,
  );
  if (
    orderedEntries.length !== count ||
    indices.some((index, position) => index !== position)
  ) {
    throw new Error('affected-native partition index set is incomplete');
  }
  if (
    orderedEntries.some(
      ({ native }) =>
        native.planDigest !== first.planDigest ||
        native.source?.head !== first.source?.head ||
        native.executionPartition.count !== count ||
        native.executionPartition.coverageDigest !==
          first.executionPartition.coverageDigest,
    )
  ) {
    throw new Error('affected-native partition source or coverage drift');
  }
  const lanes = orderedEntries.map(({ native }) => ({
    index: native.executionPartition.index,
    targets: native.executionPartition.targets,
    tests: native.executionPartition.tests,
  }));
  const expectedCoverageDigest = structuredDigest({
    planDigest: first.planDigest,
    count,
    lanes,
  });
  if (expectedCoverageDigest !== first.executionPartition.coverageDigest) {
    throw new Error('affected-native partition coverage digest drift');
  }
  const targets = lanes.flatMap(({ targets: values }) => values);
  const tests = lanes.flatMap(({ tests: values }) => values);
  const uniqueSorted = (values) => [...new Set(values)].sort();
  if (
    targets.length !== new Set(targets).size ||
    tests.length !== new Set(tests).size ||
    JSON.stringify(uniqueSorted(targets)) !==
      JSON.stringify(uniqueSorted(first.planTargets)) ||
    JSON.stringify(uniqueSorted(tests)) !==
      JSON.stringify(uniqueSorted(first.planTests))
  ) {
    throw new Error('affected-native partition target or test coverage drift');
  }

  const caches = orderedEntries.map(({ cache }) => cache);
  const cacheOutcomes = caches.map(({ outcome }) => outcome);
  const warm = caches.every(({ warm }) => warm);
  const cold = caches.some(({ cold }) => cold);
  const cacheOutcome = warm
    ? cacheOutcomes.every((outcome) => outcome === 'exact')
      ? 'exact'
      : 'compatible'
    : cold
      ? cacheOutcomes.includes('corrupt')
        ? 'corrupt'
        : 'miss'
      : 'unknown';
  const stepIds = uniqueSorted(
    orderedEntries.flatMap(({ native }) => native.steps.map(({ id }) => id)),
  );
  const steps = stepIds.map((id) => {
    const matching = orderedEntries
      .map(({ native }) => native.steps.find((step) => step.id === id))
      .filter(Boolean);
    return {
      id,
      durationMs: Math.max(...matching.map(({ durationMs }) => durationMs)),
      exitCode: Math.max(...matching.map(({ exitCode }) => exitCode)),
    };
  });
  return {
    cache: {
      outcome: cacheOutcome,
      authority: 'buildchain-portable-cache-partition-receipts',
      warm,
      cold,
      layers: orderedEntries.flatMap(({ cache, native }) =>
        cache.layers.map((layer) => ({
          ...layer,
          partitionIndex: native.executionPartition.index,
        })),
      ),
      compilerStats: aggregateCompilerStats(
        caches.map(({ compilerStats }) => compilerStats),
      ),
    },
    native: {
      outcome: 'observed',
      authority:
        'affected-native-partition-receipts-and-buildchain-diagnostics',
      source: first.source,
      planDigest: first.planDigest,
      durationMs: Math.max(
        ...orderedEntries.map(({ native }) => native.durationMs),
      ),
      steps,
      lifecycle: null,
      process: null,
      compilerCaches: {},
      executionPartitions: lanes,
      candidateEvents: orderedEntries.flatMap(
        ({ native }) => native.candidateEvents || [],
      ),
    },
  };
}

async function collectAffectedNativeEvidence(
  repository,
  runId,
  classification,
  token,
  expectedSourceSha,
  pullSourceSha,
  requiredContexts,
) {
  if (!runId) {
    return {
      cache: {
        ...cacheEvidenceFromMembers({}, { kind: 'unknown' }),
        authority: 'affected-native-workflow-run-missing',
      },
      native: {
        ...nativeEvidenceFromMembers({}, { kind: 'unknown' }),
        authority: 'affected-native-workflow-run-missing',
      },
      deliveryAttempt: missingDeliveryAttempt(
        'affected-native-workflow-run-missing',
        'affected-native workflow run is missing',
      ),
    };
  }
  try {
    const payload = await githubJson(
      `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      token,
    );
    Object.assign(
      classification,
      await resolveHistoricalPlanClassification({
        repository,
        artifacts: payload.artifacts,
        expectedSourceSha,
        token,
        githubBytes,
        githubJson: (route) => githubJson(route, token),
      }),
    );
    if (classification.kind === 'non-native')
      return {
        cache: cacheEvidenceFromMembers({}, classification),
        native: nativeEvidenceFromMembers({}, classification),
        deliveryAttempt: missingDeliveryAttempt(
          'affected-native-delivery-attempt-artifact',
          'delivery attempt is not emitted for non-native qualification',
        ),
      };
    const deliveryAttempt = await collectDeliveryAttemptFromArtifacts({
      artifacts: payload.artifacts,
      expectedSourceSha,
      repository,
      workflowRunId: runId,
      pullSourceSha,
      requiredContexts,
      token,
      githubBytes,
    });
    const resolved = await resolveAffectedNativeArtifacts({
      repository,
      runId,
      expectedSourceSha,
      artifacts: payload.artifacts,
      token,
      githubJson,
      githubBytes,
    });
    const entries = [];
    const evidenceBindings = [];
    for (const artifact of resolved.artifacts) {
      const archive = await githubBytes(
        `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
        token,
      );
      const members = readZipMembers(archive, [
        'cache/dependency.receipt.json',
        'cache/compiler.receipt.json',
        'cache/compiler-stats.txt',
        'receipt.json',
        'diagnostics.json',
        'candidate-events.jsonl',
      ]);
      const cache = cacheEvidenceFromMembers(members, classification);
      const native = nativeEvidenceFromMembers(members, classification);
      evidenceBindings.push(
        resolvedAffectedNativeEvidenceBinding({
          resolved,
          members,
          cache,
          native,
          classification,
          expectedSourceSha,
          pullSourceSha,
        }),
      );
      entries.push({ cache, native, artifact });
    }
    const combined = aggregatePartitionEvidence(entries, classification);
    const artifactIds = resolved.artifacts.map(({ id }) => id);
    const artifactNames = resolved.artifacts.map(({ name }) => name);
    return {
      cache: {
        ...combined.cache,
        artifactIds,
        artifactNames,
        workflowRunId: resolved.evidenceRunId,
      },
      native: {
        ...combined.native,
        artifactIds,
        artifactNames,
        evidenceBinding:
          combinedAffectedNativeEvidenceBinding(evidenceBindings),
        workflowRunId: resolved.evidenceRunId,
      },
      deliveryAttempt,
    };
  } catch (error) {
    Object.assign(classification, unknownClassification(error.message));
    return {
      cache: {
        outcome: 'unknown',
        authority: 'artifact-unavailable',
        reason: error.message,
        warm: false,
        cold: false,
        layers: [],
        compilerStats: null,
        workflowRunId: runId,
      },
      native: {
        outcome: 'unknown',
        authority: 'artifact-unavailable',
        reason: error.message,
        steps: [],
        workflowRunId: runId,
      },
      deliveryAttempt: {
        outcome: 'invalidated',
        authority: 'artifact-unavailable',
        reason: error.message,
        workflowRunId: runId,
      },
    };
  }
}

function workflowRunIds(checkRuns) {
  return [
    ...new Set(
      checkRuns
        .map(
          ({ details_url: detailsUrl }) =>
            detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1],
        )
        .filter(Boolean),
    ),
  ];
}

async function collectMergeQueueEvents(repository, pullNumber, token) {
  const [owner, name] = repository.split('/');
  const query = `
    query MergeQueueTimeline(
      $owner: String!
      $name: String!
      $number: Int!
      $cursor: String
    ) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          timelineItems(
            first: 100
            after: $cursor
            itemTypes: [
              ADDED_TO_MERGE_QUEUE_EVENT
              REMOVED_FROM_MERGE_QUEUE_EVENT
            ]
          ) {
            nodes {
              __typename
              ... on AddedToMergeQueueEvent {
                id
                createdAt
              }
              ... on RemovedFromMergeQueueEvent {
                id
                createdAt
                reason
                beforeCommit { oid }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;
  const events = [];
  let cursor = null;
  do {
    const data = await githubGraphql(
      query,
      { owner, name, number: pullNumber, cursor },
      token,
    );
    const timeline = data.repository?.pullRequest?.timelineItems;
    if (!timeline)
      throw new Error(`missing merge queue timeline for #${pullNumber}`);
    events.push(...timeline.nodes);
    cursor = timeline.pageInfo.hasNextPage ? timeline.pageInfo.endCursor : null;
  } while (cursor);
  return events;
}

async function collectMergeQueueEvidence(
  repository,
  pull,
  mergeGroupRuns,
  token,
) {
  try {
    const events = await collectMergeQueueEvents(
      repository,
      pull.number,
      token,
    );
    const initial = mergeQueueEvidence(
      events,
      mergeGroupRuns,
      {},
      pull.merged_at,
    );
    const assignedRunIds = [
      ...new Set(
        initial.rounds.flatMap(({ mergeGroupRuns: runs }) =>
          runs.map(({ id }) => id),
        ),
      ),
    ];
    const jobsByRun = Object.fromEntries(
      await Promise.all(
        assignedRunIds.map(async (runId) => {
          const payload = await githubJson(
            `/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`,
            token,
          );
          if (!Array.isArray(payload.jobs)) {
            throw new Error(`missing jobs for merge-group run ${runId}`);
          }
          return [String(runId), payload.jobs];
        }),
      ),
    );
    return mergeQueueEvidence(
      events,
      mergeGroupRuns,
      jobsByRun,
      pull.merged_at,
    );
  } catch (error) {
    return {
      queueStatus: 'incomplete',
      status: 'incomplete',
      authority: 'github-graphql-merge-queue-events+actions-jobs',
      reason: error.message,
      firstEnqueuedAt: null,
      mergedAt: pull.merged_at,
      deliveryDurationMs: null,
      entryCount: 0,
      dequeueCount: 0,
      dequeueReasons: {},
      mergeGroupRunCount: 0,
      repeatedValidationCount: 0,
      explainedRepeatedValidationCount: 0,
      unexplainedRepeatedValidationCount: 0,
      repeatedValidationExplanations: {},
      runnerWaitEvidenceComplete: false,
      runnerWaitUpperBoundMs: null,
      runnerWaitUpperBounds: [],
      runnerEvidenceComplete: false,
      wastedRunnerMs: null,
      postDequeueRunnerMs: null,
      rounds: [],
      diagnostics: ['collection-failed'],
    };
  }
}

async function collectSample(
  repository,
  pull,
  requiredContexts,
  mergeQueue,
  postMergeAdvisory,
  token,
  finalDev,
  latencyOnly = false,
) {
  const sha = pull.head.sha;
  const files = await githubPages(
    `/repos/${repository}/pulls/${pull.number}/files`,
    token,
  );
  let checks;
  try {
    const checkPayload = await githubJson(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      token,
    );
    const checkRuns = checkPayload.check_runs || [];
    const actionsRuns = await Promise.all(
      workflowRunIds(checkRuns).map((runId) =>
        githubJson(`/repos/${repository}/actions/runs/${runId}`, token),
      ),
    );
    checks = requiredContexts.map((context) =>
      selectedContext(checkRuns, actionsRuns, context, pull.merged_at),
    );
  } catch (error) {
    checks = [{ status: 'unknown', reason: error.message }];
  }
  const changedPaths = [
    ...new Set(
      files
        .flatMap((file) => [file.filename, file.previous_filename])
        .filter(Boolean),
    ),
  ].sort();
  let classification;
  try {
    classification = affectedNativeClassification(
      planAffectedPaths(changedPaths, pull.base.sha, sha),
    );
  } catch (error) {
    classification = unknownClassification(error.message);
  }
  const requiredWindow = requiredMergeQueueWindow(requiredContexts, mergeQueue);
  if (requiredWindow.status !== 'observed') {
    return {
      excluded: true,
      exclusionReason: 'merge-queue-required-context-incomplete',
      pullRequest: pull.number,
      sourceSha: sha,
      classification,
      requiredWindow,
      checks,
      mergeQueue,
      postMergeAdvisory,
    };
  }
  const affectedNativeContext = requiredWindow.contexts.find(
    ({ context }) => context === 'affected-native / linux',
  );
  const affectedNativeWorkflowRunId =
    affectedNativeContext?.workflowRunId || requiredWindow.workflowRunId;
  const evidence = latencyOnly
    ? latencyOnlyEvidence(classification, affectedNativeWorkflowRunId)
    : await collectAffectedNativeEvidence(
        repository,
        affectedNativeWorkflowRunId,
        classification,
        token,
        affectedNativeContext?.workflowHeadSha ||
          requiredWindow.workflowHeadSha,
        sha,
        requiredContexts,
      );
  const deliveryEvidence = deliveryEvidenceForSample({
    pull,
    sourceSha: sha,
    requiredContexts,
    requiredWindow,
    mergeQueue,
    evidence,
    finalDev,
    latencyOnly,
  });
  return {
    excluded: false,
    pullRequest: pull.number,
    mergedAt: pull.merged_at,
    sourceSha: sha,
    baseSha: pull.base.sha,
    classification,
    cache: evidence.cache,
    nativeEvidence: evidence.native,
    deliveryEvidence,
    mergeCommitSha: pull.merge_commit_sha || null,
    startedAt: requiredWindow.startedAt,
    completedAt: requiredWindow.completedAt,
    durationMs: requiredWindow.durationMs,
    requiredWindow,
    checkAuthority: 'pull-request-head-diagnostic-only',
    checks,
    mergeQueue,
    postMergeAdvisory,
  };
}

function summarizeNumbers(values) {
  return {
    sampleCount: values.length,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}

function summarizeSteps(samples) {
  const ids = [
    ...new Set(
      samples.flatMap(({ nativeEvidence }) =>
        (nativeEvidence?.steps || []).map(({ id }) => id),
      ),
    ),
  ].sort();
  return Object.fromEntries(
    ids.map((id) => [
      id,
      summarize(
        samples
          .map(({ nativeEvidence }) =>
            nativeEvidence.steps.find((step) => step.id === id),
          )
          .filter(Boolean),
      ),
    ]),
  );
}

function providerStatus(conclusion, measured) {
  if (conclusion === 'skipped') return 'skipped';
  if (!measured) return 'unknown';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'cancelled') return 'cancelled';
  return 'failure';
}

function providerTiming(startedAt, completedAt, authority) {
  if (!startedAt || !completedAt) return undefined;
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs < startedAtMs
  )
    return undefined;
  return {
    startedAt,
    completedAt,
    durationMs: milliseconds(startedAt, completedAt),
    clock: 'provider-wall',
    precisionMs: 1000,
    authority,
  };
}

function workflowStepPhase(name = '') {
  if (/checkout|setup node|resolve affected native revisions/iu.test(name))
    return 'bootstrap';
  if (
    /plan affected|portable cache plan|prepare sdk build toolchain/iu.test(name)
  )
    return 'preflight';
  if (/restore .*cache/iu.test(name)) return 'cache-restore';
  if (
    /enable compiler cache|reset compiler cache|compiler cache statistics|seal portable cache/iu.test(
      name,
    )
  )
    return 'cache-validation';
  if (
    /install pinned source acceptance tools|ensure compiler cache tool/iu.test(
      name,
    )
  )
    return 'tool-bootstrap';
  if (/install frozen workspace/iu.test(name)) return 'workspace-install';
  if (/build core sdk artifacts/iu.test(name)) return 'core-build';
  if (/pack four-language sdk artifacts/iu.test(name)) return 'sdk-pack';
  if (/qualify installed four-language sdk wire contract/iu.test(name))
    return 'sdk-wire-contract';
  if (/run affected native closure/iu.test(name)) return 'native-closure';
  if (/aggregate|admission|enforce qualifying/iu.test(name))
    return 'aggregate-admission';
  if (/save .*cache/iu.test(name)) return 'cache-save';
  if (/upload/iu.test(name)) return 'artifact-upload';
  return 'workflow-step';
}

function workflowJobPhase(name = '') {
  return name === 'affected-native / linux'
    ? 'aggregate-admission'
    : 'gate-fanout';
}

function workflowJobGate(job) {
  const platform = job.name?.match(/\/\s*([^/]+)$/u)?.[1];
  const partition = job.name?.match(/(?:partition|shard)\s+(\d+)/iu)?.[1];
  return {
    id: job.name,
    ...(platform ? { platform } : {}),
    ...(partition === undefined ? {} : { partition }),
  };
}

export function candidateTimelineInput(repository, branch, sample) {
  const events = [];
  const sourceSha = sample.sourceSha;
  const prAttempt = {
    id: `pr-${sample.pullRequest}-${sourceSha}`,
    index: 0,
    kind: 'pull-request',
  };
  for (const check of sample.checks || []) {
    const timing = providerTiming(
      check.startedAt,
      check.completedAt,
      `${check.startAuthority || 'check.started_at'}+${check.endAuthority || 'check.completed_at'}`,
    );
    events.push({
      id: `${prAttempt.id}:check:${check.context}`,
      attempt: prAttempt,
      phase: 'pr-admission',
      category: 'gate',
      status: providerStatus(check.status, Boolean(timing)),
      gate: { id: check.context },
      timing,
      attributes: {
        sourceSha,
        retryCount: check.retryCount || 0,
        checkRunId: check.checkRunId || null,
      },
    });
  }

  const rounds = sample.mergeQueue?.rounds || [];
  const runAttempts = new Map();
  for (const round of rounds) {
    const attempt = roundAttempt(sample.pullRequest, round);
    events.push({
      id: `${attempt.id}:queue-residence`,
      attempt,
      phase: 'queue-residence',
      category: 'queue',
      status: round.reason === 'merged' ? 'success' : 'cancelled',
      timing: providerTiming(
        round.enqueuedAt,
        round.removedAt,
        'github-graphql-merge-queue-events',
      ),
      attributes: { sourceSha, dequeueReason: round.reason },
    });
    for (const run of round.mergeGroupRuns || []) {
      const runAttempt = {
        ...attempt,
        mergeGroupSha: run.headSha,
        workflowRunId: run.id,
      };
      runAttempts.set(String(run.id), runAttempt);
      const runTiming = providerTiming(
        run.createdAt,
        run.completedAt,
        'github-actions-workflow-run',
      );
      events.push({
        id: `${attempt.id}:workflow:${run.id}`,
        attempt: runAttempt,
        phase: 'authoritative-build',
        category: 'workflow',
        status: providerStatus(run.conclusion, Boolean(runTiming)),
        timing: runTiming,
        attributes: {
          sourceSha,
          workflowRunId: run.id,
          runUrl: `https://github.com/${repository}/actions/runs/${run.id}`,
        },
      });
      for (const job of run.jobs || []) {
        const gate = workflowJobGate(job);
        const laneId =
          gate.partition === undefined
            ? undefined
            : `affected-native/partition-${gate.partition}`;
        const jobTiming = providerTiming(
          job.startedAt,
          job.completedAt,
          'github-actions-job',
        );
        events.push({
          id: `${attempt.id}:job:${job.id}`,
          attempt: runAttempt,
          phase: workflowJobPhase(job.name),
          category: 'job',
          status: providerStatus(job.conclusion, Boolean(jobTiming)),
          gate,
          execution: { boundary: 'github-actions-job', runner: job.runnerName },
          timing: jobTiming,
          attributes: {
            sourceSha,
            jobId: job.id,
            jobUrl: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
            laneId,
          },
        });
        events.push({
          id: `${attempt.id}:job:${job.id}:runner-wait`,
          attempt: runAttempt,
          phase: 'runner-wait',
          category: 'runner-wait',
          status: 'unknown',
          gate,
          criticalPathEligible: true,
          attributes: {
            sourceSha,
            reason: 'github-actions-jobs-api-does-not-expose-job-queued-at',
            laneId,
          },
        });
        for (const step of job.steps || []) {
          const stepTiming = providerTiming(
            step.startedAt,
            step.completedAt,
            'github-actions-job-step',
          );
          events.push({
            id: `${attempt.id}:job:${job.id}:step:${step.number}`,
            attempt: runAttempt,
            phase: workflowStepPhase(step.name),
            category: 'workflow-step',
            status: providerStatus(step.conclusion, Boolean(stepTiming)),
            gate,
            span: {
              id: `${attempt.id}:job:${job.id}:step:${step.number}`,
              parentId: `${attempt.id}:job:${job.id}`,
            },
            execution: {
              boundary: 'github-actions-step',
              runner: job.runnerName,
            },
            timing: stepTiming,
            attributes: {
              sourceSha,
              stepName: step.name,
              jobUrl: `https://github.com/${repository}/actions/runs/${run.id}/job/${job.id}`,
              laneId,
            },
          });
        }
      }
    }
  }

  const mergedRound = [...rounds]
    .reverse()
    .find(({ reason }) => reason === 'merged');
  const mergedRun = mergedRound?.mergeGroupRuns?.at(-1);
  if (mergedRound && mergedRun) {
    const attempt = {
      ...roundAttempt(sample.pullRequest, mergedRound),
      mergeGroupSha: mergedRun.headSha,
      workflowRunId: mergedRun.id,
    };
    const timing = providerTiming(
      mergedRun.completedAt,
      sample.mergedAt,
      'github-actions-workflow-run+github-pull-request-merge',
    );
    events.push({
      id: `${attempt.id}:merge-finalization`,
      attempt,
      phase: 'merge-finalization',
      category: 'merge',
      status: providerStatus('success', Boolean(timing)),
      timing,
      attributes: {
        sourceSha,
        mergeCommitSha: sample.mergeCommitSha || null,
        finalDevHead: sample.deliveryEvidence?.finalDev?.finalDevHead || null,
        finalDevAncestry:
          sample.deliveryEvidence?.finalDev?.outcome || 'unknown',
        pullRequestUrl: `https://github.com/${repository}/pull/${sample.pullRequest}`,
        runUrl: `https://github.com/${repository}/actions/runs/${mergedRun.id}`,
      },
    });
  }

  const proofEvent = deliveryTimelineEvent(sample, rounds, sourceSha);
  if (proofEvent) events.push(proofEvent);

  const internalEvents = sample.nativeEvidence?.candidateEvents || [];
  for (const event of internalEvents) {
    const runId = String(event.attempt?.workflowRunId || '');
    const observedSourceSha = event.attributes?.sourceSha;
    events.push({
      ...event,
      attempt: runAttempts.get(runId) || event.attempt,
      attributes: {
        ...(event.attributes || {}),
        ...(observedSourceSha && observedSourceSha !== sourceSha
          ? { observedSourceSha }
          : {}),
        sourceSha,
      },
    });
  }

  const observedPhases = new Set(internalEvents.map(({ phase }) => phase));
  const phaseObserved = (phase) =>
    observedPhases.has(phase) ||
    [...observedPhases].some((observed) => observed.startsWith(`${phase}-`));
  const finalAttempt = rounds.length
    ? roundAttempt(sample.pullRequest, rounds.at(-1))
    : null;
  if (finalAttempt) {
    for (const advisory of sample.postMergeAdvisory?.attempts || []) {
      events.push({
        id: `${finalAttempt.id}:post-merge-advisory:${advisory.workflowRunId}`,
        attempt: finalAttempt,
        phase: 'post-merge-advisory',
        category: 'advisory',
        status: providerStatus(
          advisory.conclusion,
          advisory.status === 'observed',
        ),
        timing: providerTiming(
          advisory.createdAt,
          advisory.completedAt,
          'github-actions-dev-post-merge-advisory-workflow-run',
        ),
        criticalPathEligible: false,
        attributes: {
          sourceSha,
          workflowRunId: advisory.workflowRunId,
          tailDurationMs: advisory.tailDurationMs,
          mergeCriticalMetricImpact: 'excluded',
        },
      });
    }
  }
  if (finalAttempt) {
    for (const [index, layer] of (sample.cache?.layers || []).entries()) {
      events.push({
        id: `${finalAttempt.id}:cache:${layer.partitionIndex ?? 'none'}:${layer.layer}:${index}`,
        attempt: finalAttempt,
        phase: 'cache-validation',
        category: 'cache-evidence',
        status: 'unknown',
        gate: {
          id: 'source.changed-scope',
          partition: layer.partitionIndex,
        },
        cache: { layer: layer.layer, outcome: layer.outcome },
        criticalPathEligible: false,
        attributes: {
          sourceSha,
          observedSourceSha: layer.sourceSha,
          receiptDigest: layer.receiptDigest,
          laneId:
            layer.partitionIndex === undefined
              ? undefined
              : `affected-native/partition-${layer.partitionIndex}`,
          timingReason: 'portable-cache-receipt-has-no-stage-interval',
        },
      });
    }
  }
  if (sample.classification?.kind === 'native' && finalAttempt) {
    for (const phase of [
      'core-configure',
      'core-build',
      'core-link',
      'sdk-pack',
      'sdk-wire-cpp',
      'sdk-wire-python',
      'sdk-wire-node',
      'sdk-wire-rust',
      'native-install',
      'native-configure',
      'native-build',
      'native-test',
    ]) {
      if (phaseObserved(phase)) continue;
      events.push({
        id: `${finalAttempt.id}:unobserved:${phase}`,
        attempt: finalAttempt,
        phase,
        category: 'internal-stage',
        status: 'unknown',
        attributes: {
          sourceSha,
          reason: 'no-source-bound-internal-stage-receipt',
        },
      });
    }
  }

  return {
    candidate: {
      repository,
      baseBranch: branch,
      sourceSha,
      pullRequest: sample.pullRequest,
      mergedAt: sample.mergedAt,
    },
    events,
  };
}

export function summarizeNativeAttribution(samples) {
  const native = samples.filter(
    ({ classification }) => classification.kind === 'native',
  );
  const observed = native.filter(
    ({ nativeEvidence }) => nativeEvidence?.outcome === 'observed',
  );
  const processObserved = observed.filter(
    ({ nativeEvidence }) => nativeEvidence.process?.sampleCount > 0,
  );
  const cohort = (predicate) => {
    const selected = observed.filter(predicate);
    return {
      latency: summarize(selected),
      steps: summarizeSteps(selected),
    };
  };
  return {
    observedCount: observed.length,
    unknownCount: native.length - observed.length,
    steps: summarizeSteps(observed),
    cohorts: {
      warm: cohort(({ cache }) => cache?.warm === true),
      cold: cohort(({ cache }) => cache?.cold === true),
    },
    process: {
      observedCount: processObserved.length,
      requestedParallelism: summarizeNumbers(
        processObserved.map(
          ({ nativeEvidence }) => nativeEvidence.process.requestedParallelism,
        ),
      ),
      maxActiveProcesses: summarizeNumbers(
        processObserved.map(
          ({ nativeEvidence }) =>
            nativeEvidence.process.observedConcurrency.max,
        ),
      ),
      activeToRequestedRatio: summarizeNumbers(
        processObserved.map(
          ({ nativeEvidence }) =>
            nativeEvidence.process.observedConcurrency.ratioToRequestedMax,
        ),
      ),
    },
  };
}
export function report(
  repository,
  branch,
  requiredContexts,
  records,
  mergeQueueRecords = records,
  options = {},
) {
  const cohort = selectCohort(records, mergeQueueRecords, options.cohortStart);
  const samples = cohort.records.filter(({ excluded }) => !excluded);
  const byKind = (kind) =>
    samples.filter(({ classification }) => classification.kind === kind);
  const statistics = {
    all: summarize(samples),
    native: summarize(byKind('native')),
    nonNative: summarize(byKind('non-native')),
    unknown: summarize(byKind('unknown')),
  };
  const enoughSamples =
    statistics.all.sampleCount >= MINIMUM_SAMPLE_COUNT &&
    statistics.native.sampleCount >= MINIMUM_NATIVE_SAMPLE_COUNT;
  const meetsTarget =
    statistics.unknown.sampleCount === 0 &&
    Math.max(statistics.all.p50Ms, statistics.native.p50Ms) <= 300000 &&
    Math.max(statistics.all.p95Ms, statistics.native.p95Ms) <= 600000;
  const cache = {
    warmCount: samples.filter(({ cache: value }) => value?.warm).length,
    coldCount: samples.filter(({ cache: value }) => value?.cold).length,
    notApplicableCount: samples.filter(
      ({ cache: value }) => value?.outcome === 'not-applicable',
    ).length,
    unknownCount: samples.filter(
      ({ cache: value }) => !value || value.outcome === 'unknown',
    ).length,
  };
  const nativeCacheEvidenceComplete = byKind('native').every(
    ({ cache: value }) => value && value.outcome !== 'unknown',
  );
  const cacheObserved = cache.warmCount + cache.coldCount;
  cache.warmRatio = cacheObserved ? cache.warmCount / cacheObserved : null;
  cache.coldRatio = cacheObserved ? cache.coldCount / cacheObserved : null;
  const queueRecords = cohort.mergeQueueRecords;
  const mergeQueueDelivery =
    queueEvidence.summarizeMergeQueueDelivery(queueRecords);
  const postMergeAdvisory = queueEvidence.summarizePostMergeAdvisory(
    cohort.records,
  );
  const deliveryEvidence = summarizeDeliveryEvidence(samples);
  const generatedAt = new Date().toISOString();
  const candidateTimelines = samples.map((sample) =>
    createCandidateTimeline({
      ...candidateTimelineInput(repository, branch, sample),
      generatedAt,
    }),
  );
  return {
    schema: 'kungfu.dev-required-latency/v1',
    generatedAt,
    repository,
    branch,
    collection: {
      evidenceMode: options.latencyOnly ? 'latency-only' : 'full',
      nativeArtifacts: options.latencyOnly ? 'skipped' : 'required',
      retainedBaselineEligible: !options.latencyOnly,
      ...cohort.collection,
    },
    metric: {
      start: 'first authoritative GitHub AddedToMergeQueueEvent',
      end: 'latest successful required job completion in the first complete required-context set on the eventual merged merge-group round',
      retries:
        'all dequeue, retry, and queue gaps after first enqueue are included; pull-request-head checks are diagnostic only',
      percentile: 'nearest-rank',
      target: { p50Ms: 300000, p95Ms: 600000 },
      minimumSamples: {
        all: MINIMUM_SAMPLE_COUNT,
        native: MINIMUM_NATIVE_SAMPLE_COUNT,
      },
    },
    branchProtection: { requiredContexts },
    statistics,
    mergeQueueDelivery: {
      metric: {
        start: 'first GitHub AddedToMergeQueueEvent',
        end: 'pull request merged_at',
        dequeue:
          'every non-merged RemovedFromMergeQueueEvent using the authoritative GraphQL reason',
        repeatedValidation:
          'additional merge_group runs split into dequeue-explained retries and unexplained same-round duplicates',
        runnerWait:
          'workflow created_at to job started_at is a conservative scheduler and dependency wait upper bound',
        wastedRunner:
          'sum of Actions job execution time for non-merged queue rounds',
        postDequeueRunner:
          'portion of non-merged round job execution after removal from the queue',
        target: {
          p50Ms: 15 * 60 * 1000,
          p90Ms: 30 * 60 * 1000,
          dequeueRateExclusiveMax: 0.1,
          mergeConflictDequeueRateExclusiveMax: 0.05,
          unexplainedRepeatedValidationCount: 0,
          runnerWaitUpperBoundMaxMs: 30 * 60 * 1000,
        },
        minimumSamples: MINIMUM_SAMPLE_COUNT,
      },
      ...mergeQueueDelivery,
      samples: queueRecords,
    },
    postMergeAdvisory,
    deliveryEvidence,
    cache,
    nativeAttribution: summarizeNativeAttribution(samples),
    candidateTimelines,
    candidateTimelineReports: candidateTimelines.map((timeline) => ({
      pullRequest: timeline.candidate.pullRequest,
      report: formatCandidateTimelineReport(timeline),
    })),
    verdict: {
      qualified: enoughSamples && meetsTarget && nativeCacheEvidenceComplete,
      reason:
        statistics.all.sampleCount === 0
          ? 'no qualifying samples'
          : !enoughSamples
            ? 'insufficient overall or native sample count'
            : !meetsTarget
              ? 'unknown impact attribution or observed overall or native sample exceeds target'
              : !nativeCacheEvidenceComplete
                ? 'native cache evidence is incomplete'
                : 'observed overall and native samples meet target with complete native cache evidence',
    },
    samples,
    exclusions: cohort.records.filter(({ excluded }) => excluded),
  };
}
async function main() {
  const options = parseDevRequiredLatencyArgs(process.argv.slice(2));
  const repository = options.repository || repositoryFromOrigin();
  if (!/^[^/]+\/[^/]+$/.test(repository))
    throw new Error('cannot resolve GitHub repository');
  const token = githubToken();
  if (!options.branch)
    options.branch =
      (await githubJson(`/repos/${repository}`, token)).default_branch || '';
  if (!isAdmittedDevBranch(options.branch))
    throw new Error(`repository default is not admitted: ${options.branch}`);
  const branchPath = encodeURIComponent(options.branch);
  const pullRoute = `/repos/${repository}/pulls?state=all&base=${encodeURIComponent(options.branch)}&sort=updated&direction=desc`;
  const [effectiveRules, pullWindow, branchState] = await Promise.all([
    githubJson(`/repos/${repository}/rules/branches/${branchPath}`, token),
    options.pulls.length
      ? Promise.all(
          options.pulls.map((pullNumber) =>
            githubJson(`/repos/${repository}/pulls/${pullNumber}`, token),
          ),
        )
      : collectLatestMergedPullWindow(
          (page, pageSize) =>
            githubJson(`${pullRoute}&per_page=${pageSize}&page=${page}`, token),
          options.limit,
        ),
    githubJson(`/repos/${repository}/branches/${branchPath}`, token),
  ]);
  const pulls = options.pulls.length ? pullWindow : pullWindow.pulls;
  const requiredContexts = requiredContextsFromEffectiveRules(effectiveRules);
  if (!requiredContexts.length) throw new Error('no required contexts');
  if (!options.pulls.length) {
    validateDevRequiredLatencyBaseline(
      latencyBaselineForDevBranch(options.branch),
      requiredContexts,
      queueAdmissionRequiredContexts(
        JSON.parse(fs.readFileSync(QUEUE_ADMISSION_CONTRACT_PATH, 'utf8')),
      ),
    );
  }
  const merged = options.pulls.length
    ? pulls.filter(({ merged_at: mergedAt }) => mergedAt)
    : pullWindow.merged;
  if (options.pulls.length && merged.length !== options.pulls.length)
    throw new Error('every requested --pull must be merged');
  const finalDevByPull = await collectFinalDevAncestry({
    merged,
    finalDevHead: branchState?.commit?.sha || null,
    repository,
    githubJson: (route) => githubJson(route, token),
  });
  const earliestPullCreatedAt = merged
    .map(({ created_at: createdAt }) => createdAt)
    .filter(Boolean)
    .sort()[0];
  const [mergeGroupRuns, postMergeAdvisoryRuns] = earliestPullCreatedAt
    ? await Promise.all([
        githubWorkflowRuns(
          `/repos/${repository}/actions/runs?event=merge_group&created=${encodeURIComponent(`>=${earliestPullCreatedAt}`)}`,
          token,
        ),
        githubWorkflowRuns(
          `/repos/${repository}/actions/workflows/dev-post-merge-advisory.yml/runs?event=push&branch=${encodeURIComponent(options.branch)}&created=${encodeURIComponent(`>=${earliestPullCreatedAt}`)}`,
          token,
        ),
      ])
    : [[], []];
  const selectedPullNumbers = new Set(merged.map(({ number }) => number));
  const mergeGroupPullNumbers = new Set(
    mergeGroupRuns.map(mergeGroupPullNumber).filter(Number.isInteger),
  );
  const queueCandidates = selectMergeQueueCandidatePulls(
    pulls,
    merged,
    mergeGroupRuns,
  );
  const mergeQueueRecords = [];
  const mergeQueueByPull = new Map();
  for (const pull of queueCandidates) {
    const pullMergeGroupRuns = mergeGroupRuns.filter(
      (run) => mergeGroupPullNumber(run) === pull.number,
    );
    const mergeQueue = await collectMergeQueueEvidence(
      repository,
      pull,
      pullMergeGroupRuns,
      token,
    );
    mergeQueueByPull.set(pull.number, mergeQueue);
    if (
      selectedPullNumbers.has(pull.number) ||
      mergeGroupPullNumbers.has(pull.number) ||
      mergeQueue.queueStatus !== 'not-observed'
    ) {
      mergeQueueRecords.push({
        pullRequest: pull.number,
        state: pull.state,
        mergedAt: pull.merged_at,
        mergeQueue,
      });
    }
  }
  const records = [];
  for (const pull of merged) {
    records.push(
      await collectSample(
        repository,
        pull,
        requiredContexts,
        mergeQueueByPull.get(pull.number),
        queueEvidence.postMergeAdvisoryEvidence(pull, postMergeAdvisoryRuns),
        token,
        finalDevByPull.get(pull.number),
        options.latencyOnly,
      ),
    );
    console.error(`[dev-gate-latency] collected PR #${pull.number}`);
  }
  const value = report(
    repository,
    options.branch,
    requiredContexts,
    records,
    mergeQueueRecords,
    {
      latencyOnly: options.latencyOnly,
      cohortStart: options.cohortStart,
    },
  );
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (options.output) {
    const output = path.resolve(ROOT, options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, json);
    console.error(`[dev-gate-latency] wrote ${path.relative(ROOT, output)}`);
  } else {
    process.stdout.write(json);
  }
  if (options.timelineOutput) {
    const timeline = value.candidateTimelines[0];
    if (!timeline) throw new Error('requested pull has no candidate timeline');
    const output = path.resolve(ROOT, options.timelineOutput);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(timeline, null, 2)}\n`);
    console.error(`[dev-gate-latency] wrote ${path.relative(ROOT, output)}`);
    console.error(formatCandidateTimelineReport(timeline));
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`[dev-gate-latency] ${error.message}`);
    process.exitCode = 1;
  });
}
