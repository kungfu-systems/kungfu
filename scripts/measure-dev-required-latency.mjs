#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { planAffectedPaths } from './run-core-affected-native.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BRANCH = 'dev/v4/v4.0';
const MINIMUM_SAMPLE_COUNT = 20;
const MINIMUM_NATIVE_SAMPLE_COUNT = 10;
const BASELINE_PATH = path.join(
  ROOT,
  'framework',
  'core',
  'architecture',
  'dev-gate-latency-baseline.json',
);

function parseArgs(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY || '',
    branch: DEFAULT_BRANCH,
    limit: 30,
    output: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repository') options.repository = argv[++index];
    else if (arg === '--branch') options.branch = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  return options;
}

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

function jobDuration(job) {
  if (!job.started_at) return 0;
  if (!job.completed_at) return null;
  return Math.max(0, milliseconds(job.started_at, job.completed_at));
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
        headSha: run.head_sha,
        createdAt: run.created_at,
        completedAt: run.updated_at,
        status: run.status,
        conclusion: run.conclusion,
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
  const wastedRuns = exitedRounds.flatMap(({ removedAt, mergeGroupRuns }) =>
    mergeGroupRuns.map((run) => ({ ...run, removedAt })),
  );
  let runnerEvidenceComplete = wastedRuns.every(({ id }) =>
    Array.isArray(jobsByRun[String(id)]),
  );
  let wastedRunnerMs = 0;
  let postDequeueRunnerMs = 0;
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
    repeatedValidationCount: Math.max(0, assignedRunIds.size - 1),
    runnerEvidenceComplete,
    wastedRunnerMs: runnerEvidenceComplete ? wastedRunnerMs : null,
    postDequeueRunnerMs: runnerEvidenceComplete ? postDequeueRunnerMs : null,
    rounds,
    diagnostics,
  };
}

export function summarizeMergeQueueDelivery(samples) {
  const queueObserved = samples.filter(
    ({ mergeQueue }) => mergeQueue?.queueStatus === 'observed',
  );
  const deliveryObserved = queueObserved.filter(
    ({ mergeQueue }) => mergeQueue?.status === 'observed',
  );
  const runnerObserved = queueObserved.filter(
    ({ mergeQueue }) => mergeQueue.runnerEvidenceComplete,
  );
  const durations = deliveryObserved.map(
    ({ mergeQueue }) => mergeQueue.deliveryDurationMs,
  );
  const dequeuePrCount = queueObserved.filter(
    ({ mergeQueue }) => mergeQueue.dequeueCount > 0,
  ).length;
  const reasons = {};
  for (const { mergeQueue } of queueObserved) {
    for (const [reason, count] of Object.entries(
      mergeQueue.dequeueReasons || {},
    )) {
      reasons[reason] = (reasons[reason] || 0) + count;
    }
  }
  const enoughSamples = deliveryObserved.length >= MINIMUM_SAMPLE_COUNT;
  const p50Ms = nearestRank(durations, 0.5);
  const p90Ms = nearestRank(durations, 0.9);
  const dequeueRate = queueObserved.length
    ? dequeuePrCount / queueObserved.length
    : null;
  const meetsTarget =
    p50Ms !== null &&
    p50Ms <= 15 * 60 * 1000 &&
    p90Ms !== null &&
    p90Ms <= 30 * 60 * 1000 &&
    dequeueRate < 0.1;
  return {
    queueObservedCount: queueObserved.length,
    deliveryObservedCount: deliveryObserved.length,
    incompleteCount: samples.filter(
      ({ mergeQueue }) => mergeQueue?.queueStatus === 'incomplete',
    ).length,
    notObservedCount: samples.filter(
      ({ mergeQueue }) => mergeQueue?.queueStatus === 'not-observed',
    ).length,
    runnerEvidenceObservedCount: runnerObserved.length,
    statistics: {
      sampleCount: deliveryObserved.length,
      p50Ms,
      p90Ms,
      maxMs: durations.length ? Math.max(...durations) : null,
    },
    dequeue: {
      pullRequestCount: dequeuePrCount,
      rate: dequeueRate,
      exitCount: queueObserved.reduce(
        (total, { mergeQueue }) => total + mergeQueue.dequeueCount,
        0,
      ),
      reasons,
    },
    repeatedValidationCount: queueObserved.reduce(
      (total, { mergeQueue }) => total + mergeQueue.repeatedValidationCount,
      0,
    ),
    wastedRunnerMs: runnerObserved.reduce(
      (total, { mergeQueue }) => total + mergeQueue.wastedRunnerMs,
      0,
    ),
    postDequeueRunnerMs: runnerObserved.reduce(
      (total, { mergeQueue }) => total + mergeQueue.postDequeueRunnerMs,
      0,
    ),
    verdict: {
      qualified: enoughSamples && meetsTarget,
      reason: !deliveryObserved.length
        ? 'no observed merge queue samples'
        : !enoughSamples
          ? 'insufficient merge queue sample count'
          : !meetsTarget
            ? 'merge queue delivery sample exceeds target'
            : 'merge queue delivery sample meets target',
    },
  };
}

export function validateBaseline(baseline, requiredContexts) {
  if (baseline.$schema !== 'kungfu.dev-required-latency-baseline/v1') {
    throw new Error('unsupported dev required latency baseline schema');
  }
  const expected = [...baseline.requiredContexts].sort();
  const actual = [...requiredContexts].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `live required contexts drifted: expected ${expected.join(', ')}, got ${actual.join(', ')}`,
    );
  }
  return true;
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

function readZipMembers(archive, names) {
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
    };
  }
  if (classification.kind !== 'native') {
    return {
      outcome: 'unknown',
      authority: 'classification-unknown',
      steps: [],
    };
  }
  try {
    if (!members['receipt.json']) throw new Error('missing native receipt');
    if (!members['diagnostics.json']) {
      throw new Error('missing Buildchain diagnostics');
    }
    const receipt = JSON.parse(members['receipt.json']);
    const diagnostics = JSON.parse(members['diagnostics.json']);
    if (
      receipt.schema !== 'kungfu.core-affected-native-receipt/v1' ||
      receipt.status !== 'passed' ||
      !Array.isArray(receipt.steps)
    ) {
      throw new Error('invalid native receipt');
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
    };
  } catch (error) {
    return {
      outcome: 'unknown',
      authority: 'artifact-invalid-or-incomplete',
      reason: error.message,
      steps: [],
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
    },
  };
}

async function collectAffectedNativeEvidence(
  repository,
  runId,
  classification,
  token,
  expectedSourceSha,
) {
  if (classification.kind === 'non-native') {
    return {
      cache: cacheEvidenceFromMembers({}, classification),
      native: nativeEvidenceFromMembers({}, classification),
    };
  }
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
    };
  }
  try {
    const payload = await githubJson(
      `/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      token,
    );
    const artifactPrefix = `core-affected-native-${expectedSourceSha}`;
    const partitionPattern = new RegExp(
      `^${artifactPrefix}-partition-(\\d+)-of-(\\d+)$`,
    );
    const artifacts = (payload.artifacts || [])
      .filter(
        ({ name, expired }) =>
          !expired && (name === artifactPrefix || partitionPattern.test(name)),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!artifacts.length) {
      throw new Error('affected-native artifact missing or expired');
    }
    const entries = [];
    for (const artifact of artifacts) {
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
      ]);
      const cache = cacheEvidenceFromMembers(members, classification);
      const native = nativeEvidenceFromMembers(members, classification);
      if (
        cache.layers.some(
          ({ sourceSha }) => !sourceSha || sourceSha !== expectedSourceSha,
        ) ||
        (native.outcome === 'observed' &&
          (native.source?.head !== expectedSourceSha ||
            JSON.stringify(native.planChangedPaths) !==
              JSON.stringify(classification.changedPaths) ||
            JSON.stringify(native.planAuthority) !==
              JSON.stringify(classification.authority)))
      ) {
        throw new Error(
          'affected-native evidence does not match source or plan',
        );
      }
      entries.push({ cache, native, artifact });
    }
    const combined = aggregatePartitionEvidence(entries, classification);
    const artifactIds = artifacts.map(({ id }) => id);
    const artifactNames = artifacts.map(({ name }) => name);
    return {
      cache: {
        ...combined.cache,
        artifactIds,
        artifactNames,
        workflowRunId: runId,
      },
      native: {
        ...combined.native,
        artifactIds,
        artifactNames,
        workflowRunId: runId,
      },
    };
  } catch (error) {
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
    const wastedRunIds = [
      ...new Set(
        initial.rounds
          .filter(({ reason }) => reason !== 'merged')
          .flatMap(({ mergeGroupRuns: runs }) => runs.map(({ id }) => id)),
      ),
    ];
    const jobsByRun = Object.fromEntries(
      await Promise.all(
        wastedRunIds.map(async (runId) => {
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
  token,
) {
  const sha = pull.head.sha;
  const [checkPayload, files] = await Promise.all([
    githubJson(
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100`,
      token,
    ),
    githubPages(`/repos/${repository}/pulls/${pull.number}/files`, token),
  ]);
  const checkRuns = checkPayload.check_runs || [];
  const actionsRuns = await Promise.all(
    workflowRunIds(checkRuns).map((runId) =>
      githubJson(`/repos/${repository}/actions/runs/${runId}`, token),
    ),
  );
  const checks = requiredContexts.map((context) =>
    selectedContext(checkRuns, actionsRuns, context, pull.merged_at),
  );
  const incomplete = checks.filter(({ status }) => status !== 'success');
  const changedPaths = [
    ...new Set(
      files
        .flatMap((file) => [file.filename, file.previous_filename])
        .filter(Boolean),
    ),
  ].sort();
  let classification = {
    kind: 'unknown',
    reason: 'planner did not run',
    planDigest: null,
  };
  try {
    const plan = planAffectedPaths(changedPaths, pull.base.sha, sha);
    classification = {
      kind: plan.closureComponents.length ? 'native' : 'non-native',
      reason: plan.platformTier,
      planDigest: plan.planDigest,
      changedPaths: plan.changedPaths,
      authority: plan.authority,
    };
  } catch (error) {
    classification = {
      kind: 'unknown',
      reason: error.message,
      planDigest: null,
    };
  }
  if (incomplete.length) {
    return {
      excluded: true,
      exclusionReason: 'required-context-incomplete',
      pullRequest: pull.number,
      sourceSha: sha,
      classification,
      checks,
      mergeQueue,
    };
  }
  const affectedNative = checks.find(
    ({ context }) => context === 'affected-native / linux',
  );
  const evidence = await collectAffectedNativeEvidence(
    repository,
    affectedNative?.finalWorkflowRunId,
    classification,
    token,
    affectedNative?.finalWorkflowHeadSha || sha,
  );
  const startedAt = checks.map(({ startedAt }) => startedAt).sort()[0];
  const completedAt = checks
    .map(({ completedAt }) => completedAt)
    .sort()
    .at(-1);
  return {
    excluded: false,
    pullRequest: pull.number,
    mergedAt: pull.merged_at,
    sourceSha: sha,
    baseSha: pull.base.sha,
    classification,
    cache: evidence.cache,
    nativeEvidence: evidence.native,
    startedAt,
    completedAt,
    durationMs: milliseconds(startedAt, completedAt),
    checks,
    mergeQueue,
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
) {
  const samples = records.filter(({ excluded }) => !excluded);
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
    statistics.all.p50Ms <= 300000 && statistics.all.p95Ms <= 600000;
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
  const mergeQueueDelivery = summarizeMergeQueueDelivery(mergeQueueRecords);
  return {
    schema: 'kungfu.dev-required-latency/v1',
    generatedAt: new Date().toISOString(),
    repository,
    branch,
    metric: {
      start:
        'earliest workflow.created_at among required contexts for the final PR source revision',
      end: 'latest first-success timestamp among required contexts no later than PR merge',
      retries:
        'included from the first matching workflow run through the first pre-merge success; post-merge reruns are excluded',
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
          'additional Core affected-native merge_group runs after the first run for the pull request',
        wastedRunner:
          'sum of Actions job execution time for non-merged queue rounds',
        postDequeueRunner:
          'portion of non-merged round job execution after removal from the queue',
        target: {
          p50Ms: 15 * 60 * 1000,
          p90Ms: 30 * 60 * 1000,
          dequeueRateExclusiveMax: 0.1,
        },
        minimumSamples: MINIMUM_SAMPLE_COUNT,
      },
      ...mergeQueueDelivery,
      samples: mergeQueueRecords,
    },
    cache,
    nativeAttribution: summarizeNativeAttribution(samples),
    verdict: {
      qualified: enoughSamples && meetsTarget && nativeCacheEvidenceComplete,
      reason:
        statistics.all.sampleCount === 0
          ? 'no qualifying samples'
          : !enoughSamples
            ? 'insufficient overall or native sample count'
            : !meetsTarget
              ? 'observed sample exceeds target'
              : !nativeCacheEvidenceComplete
                ? 'native cache evidence is incomplete'
                : 'observed sample meets target with complete native cache evidence',
    },
    samples,
    exclusions: records.filter(({ excluded }) => excluded),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = options.repository || repositoryFromOrigin();
  if (!/^[^/]+\/[^/]+$/.test(repository))
    throw new Error('cannot resolve GitHub repository');
  const token = githubToken();
  const branchPath = encodeURIComponent(options.branch);
  const [protection, pulls] = await Promise.all([
    githubJson(
      `/repos/${repository}/branches/${branchPath}/protection/required_status_checks`,
      token,
    ),
    githubPages(
      `/repos/${repository}/pulls?state=all&base=${encodeURIComponent(options.branch)}&sort=updated&direction=desc`,
      token,
      options.limit * 3,
    ),
  ]);
  const requiredContexts = [
    ...new Set([
      ...(protection.contexts || []),
      ...(protection.checks || []).map(({ context }) => context),
    ]),
  ].sort();
  if (!requiredContexts.length)
    throw new Error(`no required contexts on ${options.branch}`);
  validateBaseline(
    JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')),
    requiredContexts,
  );
  const merged = pulls
    .filter(({ merged_at: mergedAt }) => mergedAt)
    .slice(0, options.limit);
  const earliestPullCreatedAt = merged
    .map(({ created_at: createdAt }) => createdAt)
    .filter(Boolean)
    .sort()[0];
  const mergeGroupRuns = earliestPullCreatedAt
    ? await githubWorkflowRuns(
        `/repos/${repository}/actions/workflows/affected-native-pr.yml/runs?event=merge_group&created=${encodeURIComponent(`>=${earliestPullCreatedAt}`)}`,
        token,
      )
    : [];
  const queuePullNumbers = new Set([
    ...merged.map(({ number }) => number),
    ...mergeGroupRuns.map(mergeGroupPullNumber).filter(Number.isInteger),
  ]);
  const queuePulls = pulls.filter(({ number }) => queuePullNumbers.has(number));
  const mergeQueueRecords = [];
  const mergeQueueByPull = new Map();
  for (const pull of queuePulls) {
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
    mergeQueueRecords.push({
      pullRequest: pull.number,
      state: pull.state,
      mergedAt: pull.merged_at,
      mergeQueue,
    });
  }
  const records = [];
  for (const pull of merged) {
    records.push(
      await collectSample(
        repository,
        pull,
        requiredContexts,
        mergeQueueByPull.get(pull.number),
        token,
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
