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

module.exports = {
  measureCandidateStage,
  measureCandidateStageSync,
};
