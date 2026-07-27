// SPDX-License-Identifier: Apache-2.0
// @ts-check

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function compact(value) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) => entry !== undefined && entry !== '',
    ),
  );
}

function attempt(env = process.env) {
  const runId = env.GITHUB_RUN_ID || 'local';
  const eventName = env.GITHUB_EVENT_NAME || 'local';
  return compact({
    id: env.KUNGFU_CANDIDATE_ATTEMPT_ID || `${eventName}-${runId}`,
    index: /^\d+$/.test(env.KUNGFU_CANDIDATE_ATTEMPT_INDEX || '')
      ? Number(env.KUNGFU_CANDIDATE_ATTEMPT_INDEX)
      : undefined,
    kind:
      eventName === 'merge_group'
        ? 'merge-queue'
        : eventName === 'pull_request'
          ? 'pull-request'
          : 'local',
    mergeGroupSha: eventName === 'merge_group' ? env.GITHUB_SHA : undefined,
    workflowRunId: env.GITHUB_RUN_ID,
  });
}

function eventId(id, env = process.env) {
  const partition = env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX || 'none';
  return `${attempt(env).id}:${process.platform}:${partition}:${id}`;
}

function appendEvent(event, env = process.env) {
  const output = env.KUNGFU_CANDIDATE_TIMELINE_EVENTS || '';
  if (!output) return;
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(event)}\n`);
}

function buildEvent(id, phase, startedAt, started, status, options = {}) {
  const env = options.env || process.env;
  const completedAt = new Date().toISOString();
  return compact({
    id: eventId(id, env),
    attempt: attempt(env),
    phase,
    category: options.category || 'stage',
    status,
    gate: compact({
      id: options.gateId || env.KUNGFU_CANDIDATE_GATE_ID || undefined,
      platform: options.platform || `${process.platform}-${process.arch}`,
      partition: env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX,
    }),
    span: options.parentId
      ? { id: eventId(id, env), parentId: eventId(options.parentId, env) }
      : { id: eventId(id, env) },
    execution: compact({
      boundary: options.boundary || 'process',
      runner: env.RUNNER_NAME,
    }),
    timing: {
      startedAt,
      completedAt,
      durationMs: Math.round((performance.now() - started) * 1000) / 1000,
      clock: 'monotonic-duration+wall-envelope',
      precisionMs: 1,
      authority: 'kungfu-process-stage',
    },
    criticalPathEligible: options.criticalPathEligible !== false,
    attributes: compact({
      sourceSha: env.GITHUB_SHA,
      language: options.language,
      laneId:
        env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX === undefined
          ? undefined
          : `affected-native/partition-${env.KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX}`,
      stage: id,
    }),
  });
}

function measureCandidateStageSync(id, phase, callback, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = callback();
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'success', options),
      options.env,
    );
    return result;
  } catch (error) {
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'failure', options),
      options.env,
    );
    throw error;
  }
}

async function measureCandidateStage(id, phase, callback, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await callback();
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'success', options),
      options.env,
    );
    return result;
  } catch (error) {
    appendEvent(
      buildEvent(id, phase, startedAt, started, 'failure', options),
      options.env,
    );
    throw error;
  }
}

function incompleteRequiredWindow(reason, diagnostics = []) {
  return {
    status: 'incomplete',
    authority:
      'github-graphql-first-added-to-merge-queue+github-actions-merged-round-required-jobs',
    startAuthority: 'github-graphql-first-added-to-merge-queue',
    endAuthority: 'first-successful-merged-round-required-context-set',
    reason,
    diagnostics,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    queueRoundIndex: null,
    workflowRunId: null,
    workflowHeadSha: null,
    contexts: [],
  };
}

function requiredMergeQueueWindow(requiredContexts, mergeQueue) {
  const contexts = [...new Set(requiredContexts || [])].filter(Boolean).sort();
  if (!contexts.length) {
    return incompleteRequiredWindow('required context set is empty');
  }
  if (
    mergeQueue?.queueStatus !== 'observed' ||
    mergeQueue?.status !== 'observed'
  ) {
    return incompleteRequiredWindow(
      'authoritative merge queue delivery evidence is incomplete',
      mergeQueue?.diagnostics || [],
    );
  }
  const startedAt = mergeQueue.firstEnqueuedAt;
  const startedAtMs = Date.parse(startedAt);
  const mergedAtMs = Date.parse(mergeQueue.mergedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(mergedAtMs)) {
    return incompleteRequiredWindow(
      'first enqueue or merge timestamp is missing or invalid',
    );
  }
  const mergedRounds = (mergeQueue.rounds || []).filter(
    ({ reason }) => reason === 'merged',
  );
  if (
    mergedRounds.length !== 1 ||
    mergeQueue.rounds.at(-1) !== mergedRounds[0]
  ) {
    return incompleteRequiredWindow(
      'eventual merged queue round is missing or ambiguous',
    );
  }
  const mergedRound = mergedRounds[0];
  const roundEndMs = Date.parse(mergedRound.removedAt);
  if (
    !Number.isFinite(roundEndMs) ||
    roundEndMs < startedAtMs ||
    mergedAtMs < startedAtMs
  ) {
    return incompleteRequiredWindow(
      'merged queue or pull request timestamps have invalid chronology',
    );
  }

  const diagnostics = [];
  const selectedContexts = [];
  for (const context of contexts) {
    const candidates = [];
    for (const run of mergedRound.mergeGroupRuns || []) {
      const matches = (run.jobs || []).filter(({ name }) => name === context);
      if (matches.length > 1) {
        return incompleteRequiredWindow(
          `required context is ambiguous in merged queue run: ${context}`,
          [`workflow-run-${run.id}-duplicate-${context}`],
        );
      }
      const job = matches[0];
      if (!job || job.status !== 'completed' || job.conclusion !== 'success') {
        diagnostics.push(`workflow-run-${run.id}-missing-success-${context}`);
        continue;
      }
      const completedAtMs = Date.parse(job.completedAt);
      if (
        !Number.isFinite(completedAtMs) ||
        completedAtMs < startedAtMs ||
        completedAtMs > roundEndMs ||
        completedAtMs > mergedAtMs
      ) {
        return incompleteRequiredWindow(
          `required context has invalid queue chronology: ${context}`,
          [`workflow-run-${run.id}-invalid-completion-${context}`],
        );
      }
      candidates.push({
        context,
        jobId: job.id,
        workflowRunId: run.id,
        workflowHeadSha: run.headSha,
        startedAt: job.startedAt || null,
        completedAt: job.completedAt,
        completedAtMs,
        conclusion: job.conclusion,
      });
    }
    if (!candidates.length) {
      return incompleteRequiredWindow(
        'eventual merged queue round has no complete successful required-context set',
        diagnostics,
      );
    }
    candidates.sort(
      (left, right) =>
        left.completedAtMs - right.completedAtMs ||
        Number(left.workflowRunId) - Number(right.workflowRunId),
    );
    selectedContexts.push(candidates[0]);
  }
  const selectedHeadShas = [
    ...new Set(selectedContexts.map(({ workflowHeadSha }) => workflowHeadSha)),
  ];
  if (selectedHeadShas.length !== 1 || !selectedHeadShas[0]) {
    return incompleteRequiredWindow(
      'successful required contexts disagree on merge-group source',
      selectedHeadShas.map(
        (sha) => `required-context-source-${sha || 'missing'}`,
      ),
    );
  }
  selectedContexts.sort(
    (left, right) =>
      left.completedAtMs - right.completedAtMs ||
      Number(left.workflowRunId) - Number(right.workflowRunId),
  );
  const finalContext = selectedContexts.at(-1);
  return {
    status: 'observed',
    authority:
      'github-graphql-first-added-to-merge-queue+github-actions-merged-round-required-jobs',
    startAuthority: 'github-graphql-first-added-to-merge-queue',
    endAuthority: 'first-successful-merged-round-required-context-set',
    reason: 'complete successful required-context set observed',
    diagnostics,
    startedAt,
    completedAt: finalContext.completedAt,
    durationMs:
      new Date(finalContext.completedAt).getTime() -
      new Date(startedAt).getTime(),
    queueRoundIndex: mergedRound.index,
    workflowRunId: finalContext.workflowRunId,
    workflowHeadSha: finalContext.workflowHeadSha,
    workflowRunIds: [
      ...new Set(selectedContexts.map(({ workflowRunId }) => workflowRunId)),
    ],
    contexts: selectedContexts.map(({ completedAtMs, ...context }) => context),
    priorQueueRoundCount: Math.max(0, (mergeQueue.rounds || []).length - 1),
  };
}

function latestMergedPulls(pulls, limit) {
  return pulls
    .filter(({ merged_at: mergedAt }) => Number.isFinite(Date.parse(mergedAt)))
    .sort((left, right) => {
      const mergedOrder =
        Date.parse(right.merged_at) - Date.parse(left.merged_at);
      return mergedOrder || right.number - left.number;
    })
    .slice(0, limit);
}

async function collectLatestMergedPullWindow(fetchPage, limit, pageSize = 100) {
  const pulls = [];
  for (let page = 1; ; page += 1) {
    const batch = await fetchPage(page, pageSize);
    if (!Array.isArray(batch)) throw new Error('expected pull request page');
    pulls.push(...batch);
    const merged = latestMergedPulls(pulls, limit);
    if (!batch.length || batch.length < pageSize) return { pulls, merged };
    if (merged.length < limit) continue;
    const cutoffMs = Date.parse(merged.at(-1).merged_at);
    const lastUpdatedMs = Date.parse(batch.at(-1).updated_at);
    if (Number.isFinite(lastUpdatedMs) && lastUpdatedMs < cutoffMs) {
      return { pulls, merged };
    }
  }
}

function parseDevRequiredLatencyArgs(argv) {
  const options = {
    repository: process.env.GITHUB_REPOSITORY || '',
    branch: 'dev/v4/v4.0',
    limit: 30,
    output: '',
    pulls: [],
    timelineOutput: '',
    latencyOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--latency-only') options.latencyOnly = true;
    else if (arg === '--repository') options.repository = argv[++index];
    else if (arg === '--branch') options.branch = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--pull') options.pulls.push(Number(argv[++index]));
    else if (arg === '--timeline-output')
      options.timelineOutput = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error('--limit must be an integer from 1 to 100');
  }
  if (
    options.pulls.some(
      (pullNumber) => !Number.isInteger(pullNumber) || pullNumber < 1,
    )
  ) {
    throw new Error('--pull must be a positive integer');
  }
  if (options.timelineOutput && options.pulls.length !== 1) {
    throw new Error('--timeline-output requires exactly one --pull');
  }
  return options;
}

function latencyOnlyEvidence(classification, workflowRunId = null) {
  if (classification.kind === 'non-native') {
    return {
      cache: {
        outcome: 'not-applicable',
        authority: 'source-planner',
        warm: false,
        cold: false,
        layers: [],
        compilerStats: null,
      },
      native: {
        outcome: 'not-applicable',
        authority: 'source-planner',
        steps: [],
        candidateEvents: [],
      },
    };
  }
  const reason = 'native artifact download skipped by explicit --latency-only';
  return {
    cache: {
      outcome: 'unknown',
      authority: 'latency-only',
      reason,
      warm: false,
      cold: false,
      layers: [],
      compilerStats: null,
      workflowRunId,
    },
    native: {
      outcome: 'unknown',
      authority: 'latency-only',
      reason,
      steps: [],
      candidateEvents: [],
      workflowRunId,
    },
  };
}

module.exports = {
  collectLatestMergedPullWindow,
  latestMergedPulls,
  latencyOnlyEvidence,
  measureCandidateStage,
  measureCandidateStageSync,
  parseDevRequiredLatencyArgs,
  requiredMergeQueueWindow,
};
