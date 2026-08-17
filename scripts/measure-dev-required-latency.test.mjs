// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createCandidateTimeline } from '@kungfu-tech/buildchain-alpha/candidate-timeline';

import {
  collectLatestMergedPullWindow,
  latestMergedPulls,
} from './candidate-timeline-events.cjs';
import {
  affectedNativeEvidenceBinding,
  aggregatePartitionEvidence,
  cacheEvidenceFromMembers,
  candidateTimelineInput,
  mergeGroupPullNumber,
  mergeQueueEvidence,
  nativeEvidenceFromMembers,
  nearestRank,
  postMergeAdvisoryEvidence,
  report,
  requiredContextsFromEffectiveRules,
  requiredMergeQueueWindow,
  selectMergeQueueCandidatePulls,
  selectedContext,
  summarize,
  summarizeMergeQueueDelivery,
  summarizeNativeAttribution,
  summarizePostMergeAdvisory,
} from './measure-dev-required-latency.mjs';
import { partitionAffectedNativePlan } from './run-core-affected-native.mjs';

function cacheReceipt(layer, outcome, overrides = {}) {
  return JSON.stringify({
    schema: 'buildchain.portable-dev-cache-receipt/v1',
    layer,
    outcome,
    usable: ['exact', 'compatible'].includes(outcome),
    qualified: ['exact', 'compatible', 'miss'].includes(outcome),
    coldFallbackRequired: outcome === 'miss',
    coldFallbackStatus: outcome === 'miss' ? 'passed' : 'not-run',
    sourceSha: 'abc',
    receiptDigest: `sha256:${layer}`,
    ...overrides,
  });
}

function nativeMembers({ executionPartition = null, plan = null } = {}) {
  const effectivePlan = plan || {
    targets: ['kungfu'],
    tests: [],
  };
  const planDigest = effectivePlan.planDigest || 'sha256:plan';
  const diagnostics = `${JSON.stringify(
    {
      contract: 'kungfu-buildchain-diagnostics',
      consumer: {
        contract: 'kungfu.affected-native-diagnostics/v1',
        gateId: 'source.changed-scope',
        planDigest,
        ...(executionPartition ? { executionPartition } : {}),
      },
      lifecycleObservability: {
        stages: { build: { durationMs: 200000 } },
      },
      process: {
        sampleCount: 3,
        requestedParallelism: 4,
        observedConcurrency: { max: 3, ratioToRequestedMax: 0.75 },
      },
      compilerCaches: { ccache: { available: true } },
    },
    null,
    2,
  )}\n`;
  const diagnosticsDigest = `sha256:${crypto
    .createHash('sha256')
    .update(diagnostics)
    .digest('hex')}`;
  return {
    'diagnostics.json': diagnostics,
    'receipt.json': JSON.stringify({
      schema: 'kungfu.core-affected-native-receipt/v1',
      status: 'passed',
      source: { base: 'base', head: 'head' },
      planDigest,
      plan: effectivePlan,
      ...(executionPartition ? { executionPartition } : {}),
      durationMs: 240000,
      steps: [
        { id: 'cmake-configure', durationMs: 40000, exitCode: 0 },
        { id: 'cmake-build', durationMs: 200000, exitCode: 0 },
      ],
      diagnostics: {
        digest: diagnosticsDigest,
        consumerContract: 'kungfu.affected-native-diagnostics/v1',
      },
    }),
  };
}

test('nearest-rank percentiles preserve the observed tail', () => {
  assert.equal(nearestRank([100, 200, 300, 400], 0.5), 200);
  assert.equal(nearestRank([100, 200, 300, 400], 0.95), 400);
  assert.equal(nearestRank([], 0.95), null);
});

test('merge-group branch names bind Actions runs to one pull request', () => {
  assert.equal(
    mergeGroupPullNumber({
      head_branch:
        'gh-readonly-queue/dev/v4/v4.0/pr-1239-7ea9c140b15ef11d4387be4ca84b84e124f5c7aa',
    }),
    1239,
  );
  assert.equal(
    mergeGroupPullNumber({ head_branch: 'feature/not-a-merge-group' }),
    null,
  );
});

test('latest merged pull window is stable when updated open pulls are added', async () => {
  const merged = [
    {
      number: 11,
      merged_at: '2026-07-22T13:00:00Z',
      updated_at: '2026-07-22T13:00:00Z',
    },
    {
      number: 10,
      merged_at: '2026-07-22T12:00:00Z',
      updated_at: '2026-07-22T12:00:00Z',
    },
    {
      number: 9,
      merged_at: '2026-07-22T11:00:00Z',
      updated_at: '2026-07-22T11:00:00Z',
    },
  ];
  const updatedOpen = Array.from({ length: 4 }, (_, index) => ({
    number: 100 + index,
    merged_at: null,
    updated_at: `2026-07-22T14:0${index}:00Z`,
  }));
  const pages = [
    updatedOpen.slice(0, 3),
    updatedOpen.slice(3).concat(merged.slice(0, 2)),
    merged.slice(2),
  ];
  const fetchedPages = [];
  const value = await collectLatestMergedPullWindow(
    async (page) => {
      fetchedPages.push(page);
      return pages[page - 1] || [];
    },
    2,
    3,
  );

  assert.deepEqual(
    value.merged.map(({ number }) => number),
    [11, 10],
  );
  assert.deepEqual(
    latestMergedPulls(merged, 2).map(({ number }) => number),
    [11, 10],
  );
  assert.deepEqual(fetchedPages, [1, 2, 3]);
});

test('queue candidate discovery retains recent closed attempts without runs', () => {
  const pulls = [
    {
      number: 1,
      merged_at: '2026-07-22T13:00:00Z',
      updated_at: '2026-07-22T13:00:00Z',
    },
    {
      number: 2,
      merged_at: null,
      updated_at: '2026-07-22T13:10:00Z',
    },
    {
      number: 3,
      merged_at: null,
      updated_at: '2026-07-20T13:00:00Z',
    },
    {
      number: 4,
      merged_at: null,
      updated_at: '2026-07-20T13:00:00Z',
    },
    {
      number: 5,
      merged_at: '2026-07-22T13:05:00Z',
      updated_at: '2026-07-22T13:05:00Z',
    },
  ];
  const runs = [
    {
      head_branch:
        'gh-readonly-queue/dev/v4/v4.0/pr-4-7ea9c140b15ef11d4387be4ca84b84e124f5c7aa',
    },
    {
      head_branch:
        'gh-readonly-queue/dev/v4/v4.0/pr-5-7ea9c140b15ef11d4387be4ca84b84e124f5c7aa',
    },
  ];

  assert.deepEqual(
    selectMergeQueueCandidatePulls(pulls, [pulls[0]], runs).map(
      ({ number }) => number,
    ),
    [1, 2, 4],
  );
});

test('merge queue evidence preserves failed dequeue and wasted runner time', () => {
  const value = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:10:00Z',
        reason: 'FAILED_CHECKS',
        beforeCommit: { oid: 'failed-round' },
      },
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:20:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:30:00Z',
        reason: 'MERGED',
        beforeCommit: { oid: 'merged-round' },
      },
    ],
    [
      {
        id: 101,
        workflow_id: 77,
        head_sha: 'failed-round',
        created_at: '2026-07-22T13:01:00Z',
        updated_at: '2026-07-22T13:15:00Z',
        status: 'completed',
        conclusion: 'failure',
      },
      {
        id: 102,
        workflow_id: 77,
        head_sha: 'merged-round',
        created_at: '2026-07-22T13:21:00Z',
        updated_at: '2026-07-22T13:29:00Z',
        status: 'completed',
        conclusion: 'success',
      },
    ],
    {
      101: [
        {
          id: 1001,
          name: 'check',
          started_at: '2026-07-22T13:02:00Z',
          completed_at: '2026-07-22T13:12:00Z',
        },
        {
          id: 1002,
          name: 'affected-native / linux',
          started_at: '2026-07-22T13:05:00Z',
          completed_at: '2026-07-22T13:15:00Z',
        },
      ],
      102: [
        {
          id: 1003,
          name: 'check',
          started_at: '2026-07-22T13:22:00Z',
          completed_at: '2026-07-22T13:28:00Z',
        },
      ],
    },
    '2026-07-22T13:30:00Z',
  );

  assert.equal(value.status, 'observed');
  assert.equal(value.deliveryDurationMs, 30 * 60 * 1000);
  assert.equal(value.dequeueCount, 1);
  assert.deepEqual(value.dequeueReasons, { failed_checks: 1 });
  assert.equal(value.mergeGroupRunCount, 2);
  assert.equal(value.repeatedValidationCount, 1);
  assert.equal(value.explainedRepeatedValidationCount, 1);
  assert.equal(value.unexplainedRepeatedValidationCount, 0);
  assert.deepEqual(value.repeatedValidationExplanations, { failed_checks: 1 });
  assert.equal(value.runnerWaitEvidenceComplete, true);
  assert.equal(value.runnerWaitUpperBoundMs, 4 * 60 * 1000);
  assert.equal(value.wastedRunnerMs, 20 * 60 * 1000);
  assert.equal(value.postDequeueRunnerMs, 7 * 60 * 1000);
  assert.equal(value.rounds[0].mergeGroupRuns[0].jobs.length, 2);
});

test('required latency starts at first enqueue and ends at the merged round required set', () => {
  const value = requiredMergeQueueWindow(
    ['Candidate source acceptance / check', 'affected-native / linux'],
    {
      queueStatus: 'observed',
      status: 'observed',
      firstEnqueuedAt: '2026-07-22T13:00:00Z',
      mergedAt: '2026-07-22T13:30:02Z',
      rounds: [
        {
          index: 0,
          enqueuedAt: '2026-07-22T13:00:00Z',
          removedAt: '2026-07-22T13:05:00Z',
          reason: 'failed_checks',
          mergeGroupRuns: [],
        },
        {
          index: 1,
          enqueuedAt: '2026-07-22T13:10:00Z',
          removedAt: '2026-07-22T13:30:00Z',
          reason: 'merged',
          mergeGroupRuns: [
            {
              id: 102,
              headSha: 'b'.repeat(40),
              jobs: [
                {
                  id: 1,
                  name: 'Candidate source acceptance / check',
                  status: 'completed',
                  conclusion: 'success',
                  startedAt: '2026-07-22T13:11:00Z',
                  completedAt: '2026-07-22T13:12:00Z',
                },
                {
                  id: 2,
                  name: 'affected-native / linux',
                  status: 'completed',
                  conclusion: 'success',
                  startedAt: '2026-07-22T13:27:00Z',
                  completedAt: '2026-07-22T13:29:00Z',
                },
              ],
            },
          ],
        },
      ],
    },
  );

  assert.equal(value.status, 'observed');
  assert.equal(value.durationMs, 29 * 60 * 1000);
  assert.equal(value.workflowRunId, 102);
  assert.equal(value.priorQueueRoundCount, 1);
  assert.deepEqual(
    value.contexts.map(({ context }) => context),
    ['Candidate source acceptance / check', 'affected-native / linux'],
  );
});

test('required contexts may complete in separate exact-source workflows', () => {
  const headSha = 'b'.repeat(40);
  const mergeQueue = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:10:00Z',
        reason: 'MERGED',
      },
    ],
    [
      {
        id: 101,
        workflow_id: 1,
        head_sha: headSha,
        created_at: '2026-07-22T13:00:30Z',
        updated_at: '2026-07-22T13:02:00Z',
      },
      {
        id: 102,
        workflow_id: 2,
        head_sha: headSha,
        created_at: '2026-07-22T13:00:31Z',
        updated_at: '2026-07-22T13:09:00Z',
      },
    ],
    {
      101: [
        {
          id: 1,
          name: 'source',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-07-22T13:02:00Z',
        },
      ],
      102: [
        {
          id: 2,
          name: 'native',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-07-22T13:09:00Z',
        },
      ],
    },
    '2026-07-22T13:10:00Z',
  );
  const value = requiredMergeQueueWindow(['source', 'native'], mergeQueue);
  assert.equal(value.status, 'observed');
  assert.equal(value.durationMs, 9 * 60 * 1000);
  assert.deepEqual(value.workflowRunIds, [101, 102]);
  assert.equal(mergeQueue.mergeGroupRunCount, 2);
  assert.equal(mergeQueue.repeatedValidationCount, 0);
});

test('required latency fails closed on missing or ambiguous merged-round jobs', () => {
  const mergeQueue = {
    queueStatus: 'observed',
    status: 'observed',
    firstEnqueuedAt: '2026-07-22T13:00:00Z',
    mergedAt: '2026-07-22T13:30:00Z',
    rounds: [
      {
        index: 0,
        enqueuedAt: '2026-07-22T13:00:00Z',
        removedAt: '2026-07-22T13:30:00Z',
        reason: 'merged',
        mergeGroupRuns: [
          {
            id: 102,
            headSha: 'b'.repeat(40),
            jobs: [
              {
                id: 1,
                name: 'required',
                status: 'completed',
                conclusion: 'success',
                completedAt: '2026-07-22T13:10:00Z',
              },
            ],
          },
        ],
      },
    ],
  };

  assert.match(
    requiredMergeQueueWindow(['required', 'missing'], mergeQueue).reason,
    /no complete successful required-context set/,
  );
  mergeQueue.rounds[0].mergeGroupRuns[0].jobs.push({
    id: 2,
    name: 'required',
    status: 'completed',
    conclusion: 'success',
    completedAt: '2026-07-22T13:11:00Z',
  });
  assert.match(
    requiredMergeQueueWindow(['required'], mergeQueue).reason,
    /ambiguous/,
  );
});

test('candidate timeline input correlates provider and internal events without mixing attempts', () => {
  const sourceSha = 'a'.repeat(40);
  const input = candidateTimelineInput('kungfu-systems/kungfu', 'dev/v4/v4.0', {
    pullRequest: 1262,
    sourceSha,
    mergedAt: '2026-07-23T00:30:00Z',
    classification: { kind: 'native' },
    checks: [
      {
        status: 'success',
        context: 'affected-native / linux',
        startedAt: '2026-07-23T00:00:00Z',
        completedAt: '2026-07-23T00:05:00Z',
        startAuthority: 'workflow.created_at',
        endAuthority: 'first-success',
      },
    ],
    mergeQueue: {
      rounds: [
        {
          index: 0,
          enqueuedAt: '2026-07-23T00:10:00Z',
          removedAt: '2026-07-23T00:30:00Z',
          reason: 'merged',
          mergeGroupRuns: [
            {
              id: 42,
              headSha: 'b'.repeat(40),
              createdAt: '2026-07-23T00:11:00Z',
              completedAt: '2026-07-23T00:29:00Z',
              conclusion: 'success',
              jobs: [
                {
                  id: 7,
                  name: 'affected-native partition 0 of 2 / linux',
                  conclusion: 'success',
                  startedAt: '2026-07-23T00:12:00Z',
                  completedAt: '2026-07-23T00:28:00Z',
                  steps: [
                    {
                      number: 9,
                      name: 'Build Core SDK artifacts',
                      conclusion: 'success',
                      startedAt: '2026-07-23T00:13:00Z',
                      completedAt: '2026-07-23T00:20:00Z',
                    },
                  ],
                },
                {
                  id: 8,
                  name: 'KFD verifier / linux',
                  conclusion: 'skipped',
                  startedAt: null,
                  completedAt: null,
                  steps: [],
                },
                {
                  id: 9,
                  name: 'affected-native / linux',
                  conclusion: 'success',
                  startedAt: '2026-07-23T00:28:00Z',
                  completedAt: '2026-07-23T00:29:00Z',
                  steps: [
                    {
                      number: 1,
                      name: 'Aggregate affected native evidence',
                      conclusion: 'success',
                      startedAt: '2026-07-23T00:28:00Z',
                      completedAt: '2026-07-23T00:29:00Z',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    postMergeAdvisory: {
      attempts: [
        {
          workflowRunId: 91,
          status: 'observed',
          conclusion: 'success',
          createdAt: '2026-07-23T00:31:00Z',
          completedAt: '2026-07-23T00:41:00Z',
          tailDurationMs: 11 * 60 * 1000,
        },
      ],
    },
    nativeEvidence: {
      candidateEvents: [
        {
          id: 'merge_group-42:linux:0:sdk-wire-cpp',
          attempt: { id: 'merge_group-42', workflowRunId: '42' },
          phase: 'sdk-wire-cpp',
          status: 'success',
          timing: {
            startedAt: '2026-07-23T00:20:00Z',
            completedAt: '2026-07-23T00:21:00Z',
            durationMs: 60000,
            clock: 'monotonic-duration+wall-envelope',
            precisionMs: 1,
          },
          attributes: { sourceSha },
        },
        {
          id: 'merge_group-42:linux:0:sdk-pack-python',
          attempt: { id: 'merge_group-42', workflowRunId: '42' },
          phase: 'sdk-pack-python',
          status: 'success',
          timing: {
            startedAt: '2026-07-23T00:19:00Z',
            completedAt: '2026-07-23T00:20:00Z',
            durationMs: 60_000,
            clock: 'monotonic-duration+wall-envelope',
            precisionMs: 1,
          },
          attributes: { sourceSha },
        },
      ],
    },
    cache: {
      layers: [
        {
          layer: 'compiler',
          outcome: 'miss',
          partitionIndex: 0,
          sourceSha: 'b'.repeat(40),
          receiptDigest: 'sha256:cache',
        },
      ],
    },
  });
  assert.equal(input.candidate.pullRequest, 1262);
  assert.equal(
    input.events.find(({ phase }) => phase === 'sdk-wire-cpp').attempt.id,
    'mq-1262-0',
  );
  assert.equal(
    input.events.find(({ phase }) => phase === 'core-build').timing.precisionMs,
    1000,
  );
  assert.equal(
    input.events.find(({ phase }) => phase === 'sdk-wire-rust').status,
    'unknown',
  );
  assert.equal(
    input.events.some(
      ({ id, phase }) => id.includes(':unobserved:') && phase === 'sdk-pack',
    ),
    false,
  );
  assert.equal(
    input.events.find(({ phase }) => phase === 'runner-wait').attributes.reason,
    'github-actions-jobs-api-does-not-expose-job-queued-at',
  );
  assert.deepEqual(
    input.events.find(({ category }) => category === 'job').gate,
    {
      id: 'affected-native partition 0 of 2 / linux',
      platform: 'linux',
      partition: '0',
    },
  );
  assert.equal(
    input.events.find(
      ({ category, gate }) =>
        category === 'job' && gate.id === 'KFD verifier / linux',
    ).status,
    'skipped',
  );
  assert.equal(
    input.events.find(
      ({ category, gate }) =>
        category === 'job' && gate.id === 'affected-native / linux',
    ).phase,
    'aggregate-admission',
  );
  assert.equal(
    input.events.find(({ phase }) => phase === 'merge-finalization').timing
      .durationMs,
    60_000,
  );
  assert.match(
    input.events.find(({ category }) => category === 'workflow').attributes
      .runUrl,
    /actions\/runs\/42$/,
  );
  assert.deepEqual(
    input.events.find(({ category }) => category === 'cache-evidence').cache,
    { layer: 'compiler', outcome: 'miss' },
  );
  const advisory = input.events.find(
    ({ phase }) => phase === 'post-merge-advisory',
  );
  assert.equal(advisory.criticalPathEligible, false);
  assert.equal(advisory.attributes.mergeCriticalMetricImpact, 'excluded');
  const timeline = createCandidateTimeline(input);
  assert.equal(timeline.contract, 'buildchain.candidate-timeline/v1');
  assert.deepEqual(
    timeline.attempts.map(({ attempt }) => attempt.id),
    [`pr-1262-${sourceSha}`, 'mq-1262-0'],
  );
  assert.equal(timeline.attempts[1].criticalPath.durationMs, 20 * 60 * 1000);
  assert.equal(
    timeline.attempts[1].criticalPath.activeIntervalUnionMs,
    20 * 60 * 1000,
  );
  assert.equal(timeline.attempts[1].criticalPath.status, 'incomplete');
});

test('merge queue evidence fails closed for incomplete queue or runner facts', () => {
  const unpaired = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:00:00Z',
      },
    ],
    [],
    {},
    '2026-07-22T13:30:00Z',
  );
  assert.equal(unpaired.status, 'incomplete');
  assert.deepEqual(unpaired.diagnostics, ['queue-add-without-removal']);

  const missingJobs = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:10:00Z',
        reason: 'FAILED_CHECKS',
      },
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:20:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:30:00Z',
        reason: 'MERGED',
      },
    ],
    [
      {
        id: 101,
        created_at: '2026-07-22T13:01:00Z',
        updated_at: '2026-07-22T13:15:00Z',
      },
    ],
    {},
    '2026-07-22T13:30:00Z',
  );
  assert.equal(missingJobs.status, 'observed');
  assert.equal(missingJobs.runnerEvidenceComplete, false);
  assert.equal(missingJobs.wastedRunnerMs, null);
  assert.equal(missingJobs.postDequeueRunnerMs, null);
});

test('paired closed queue attempts remain observed without merge-group runs', () => {
  const value = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:05:00Z',
        reason: 'MERGE_CONFLICT',
      },
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-07-22T13:10:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-07-22T13:15:00Z',
        reason: 'MERGE_CONFLICT',
      },
    ],
    [],
    {},
    null,
  );

  assert.equal(value.queueStatus, 'observed');
  assert.equal(value.status, 'incomplete');
  assert.equal(value.entryCount, 2);
  assert.equal(value.dequeueCount, 2);
  assert.deepEqual(value.dequeueReasons, { merge_conflict: 2 });
  assert.equal(value.mergeGroupRunCount, 0);
  assert.equal(value.runnerWaitEvidenceComplete, true);
  assert.equal(value.runnerWaitUpperBoundMs, 0);
  assert.equal(value.runnerEvidenceComplete, true);
  assert.equal(value.wastedRunnerMs, 0);
  assert.equal(value.postDequeueRunnerMs, 0);
});

test('merge queue delivery summary reports tail, dequeues, and waste', () => {
  const mergeQueue = (overrides) => ({
    queueStatus: 'observed',
    status: 'observed',
    deliveryDurationMs: 10 * 60 * 1000,
    dequeueCount: 0,
    dequeueReasons: {},
    repeatedValidationCount: 0,
    explainedRepeatedValidationCount: 0,
    unexplainedRepeatedValidationCount: 0,
    runnerWaitEvidenceComplete: true,
    runnerWaitUpperBoundMs: 2 * 60 * 1000,
    runnerEvidenceComplete: true,
    wastedRunnerMs: 0,
    postDequeueRunnerMs: 0,
    ...overrides,
  });
  const samples = Array.from({ length: 20 }, (_, index) => ({
    mergeQueue: mergeQueue(
      index === 19
        ? {
            deliveryDurationMs: 35 * 60 * 1000,
            dequeueCount: 1,
            dequeueReasons: { failed_checks: 1 },
            repeatedValidationCount: 1,
            explainedRepeatedValidationCount: 1,
            wastedRunnerMs: 8 * 60 * 1000,
            postDequeueRunnerMs: 2 * 60 * 1000,
          }
        : {},
    ),
  }));
  const value = summarizeMergeQueueDelivery(samples);
  assert.equal(value.statistics.p50Ms, 10 * 60 * 1000);
  assert.equal(value.statistics.p90Ms, 10 * 60 * 1000);
  assert.equal(value.dequeue.rate, 0.05);
  assert.deepEqual(value.dequeue.reasons, { failed_checks: 1 });
  assert.equal(value.dequeue.mergeConflict.rate, 0);
  assert.equal(value.repeatedValidationCount, 1);
  assert.equal(value.explainedRepeatedValidationCount, 1);
  assert.equal(value.unexplainedRepeatedValidationCount, 0);
  assert.equal(value.runnerWait.qualified, true);
  assert.equal(value.wastedRunnerMs, 8 * 60 * 1000);
  assert.equal(value.postDequeueRunnerMs, 2 * 60 * 1000);
  assert.equal(value.verdict.qualified, true);
});

test('queue delivery fails strict conflict, unexplained repeat, and runner wait budgets', () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({
    mergeQueue: {
      queueStatus: 'observed',
      status: 'observed',
      deliveryDurationMs: 10 * 60 * 1000,
      dequeueCount: index === 0 ? 1 : 0,
      dequeueReasons: index === 0 ? { merge_conflict: 1 } : {},
      repeatedValidationCount: index === 0 ? 1 : 0,
      explainedRepeatedValidationCount: 0,
      unexplainedRepeatedValidationCount: index === 0 ? 1 : 0,
      runnerWaitEvidenceComplete: true,
      runnerWaitUpperBoundMs: index === 0 ? 31 * 60 * 1000 : 2 * 60 * 1000,
      runnerEvidenceComplete: true,
      wastedRunnerMs: 0,
      postDequeueRunnerMs: 0,
    },
  }));
  const value = summarizeMergeQueueDelivery(samples);
  assert.equal(value.dequeue.mergeConflict.rate, 0.05);
  assert.equal(value.unexplainedRepeatedValidationCount, 1);
  assert.equal(value.runnerWait.qualified, false);
  assert.equal(value.verdict.qualified, false);
});

test('post-merge advisory tail stays visible and outside merge-critical timing', () => {
  const pull = {
    merge_commit_sha: 'a'.repeat(40),
    merged_at: '2026-08-17T01:00:00Z',
  };
  const evidence = postMergeAdvisoryEvidence(pull, [
    {
      id: 91,
      head_sha: 'a'.repeat(40),
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-08-17T01:01:00Z',
      updated_at: '2026-08-17T01:11:00Z',
    },
  ]);
  assert.equal(evidence.status, 'observed');
  assert.equal(evidence.criticalPathEligible, false);
  assert.equal(evidence.mergeCriticalMetricImpact, 'excluded');
  assert.equal(evidence.tailDurationMs, 11 * 60 * 1000);
  const summary = summarizePostMergeAdvisory([{ postMergeAdvisory: evidence }]);
  assert.equal(summary.observedCount, 1);
  assert.equal(summary.statistics.p95Ms, 11 * 60 * 1000);
  assert.equal(summary.criticalPathEligible, false);
});

test('queue summary retains dequeued work before eventual merge', () => {
  const value = summarizeMergeQueueDelivery([
    {
      mergeQueue: {
        queueStatus: 'observed',
        status: 'incomplete',
        deliveryDurationMs: null,
        dequeueCount: 1,
        dequeueReasons: { failed_checks: 1 },
        repeatedValidationCount: 0,
        runnerEvidenceComplete: true,
        wastedRunnerMs: 12 * 60 * 1000,
        postDequeueRunnerMs: 3 * 60 * 1000,
      },
    },
  ]);
  assert.equal(value.queueObservedCount, 1);
  assert.equal(value.deliveryObservedCount, 0);
  assert.equal(value.statistics.sampleCount, 0);
  assert.equal(value.dequeue.rate, 1);
  assert.deepEqual(value.dequeue.reasons, { failed_checks: 1 });
  assert.equal(value.wastedRunnerMs, 12 * 60 * 1000);
  assert.equal(value.postDequeueRunnerMs, 3 * 60 * 1000);
  assert.equal(value.verdict.qualified, false);
});

test('an under-sized passing window remains non-qualifying', () => {
  const sample = {
    excluded: false,
    pullRequest: 1,
    sourceSha: 'a'.repeat(40),
    durationMs: 120000,
    classification: { kind: 'native' },
  };
  const value = report('owner/repo', 'dev', ['required'], [sample]);
  assert.equal(value.verdict.qualified, false);
  assert.match(value.verdict.reason, /insufficient/);
});

test('portable cache receipts distinguish warm compatibility from cold fallback', () => {
  const warm = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'compatible'),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'exact'),
      'cache/compiler-stats.txt': [
        'Cacheable calls:     91 /  91 (100.0%)',
        '  Hits:              91 /  91 (100.0%)',
        '  Misses:             0 /  91 ( 0.00%)',
      ].join('\n'),
    },
    { kind: 'native' },
  );
  assert.equal(warm.outcome, 'compatible');
  assert.equal(warm.warm, true);
  assert.deepEqual(warm.compilerStats, {
    cacheableCalls: 91,
    hits: 91,
    misses: 0,
    hitRatio: 1,
  });

  const cold = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'miss'),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'miss'),
    },
    { kind: 'native' },
  );
  assert.equal(cold.outcome, 'miss');
  assert.equal(cold.cold, true);
});

test('missing or invalid cache receipts remain unknown', () => {
  const value = cacheEvidenceFromMembers({}, { kind: 'native' });
  assert.equal(value.outcome, 'unknown');
  assert.match(value.reason, /missing dependency receipt/);
});

test('a cache miss without a passed cold fallback remains unknown', () => {
  const value = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'miss', {
        coldFallbackStatus: 'failed',
      }),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'miss'),
    },
    { kind: 'native' },
  );
  assert.equal(value.outcome, 'unknown');
  assert.match(value.reason, /passed fallback/);
});

test('non-native samples explicitly have no portable cache work', () => {
  const value = cacheEvidenceFromMembers({}, { kind: 'non-native' });
  assert.equal(value.outcome, 'not-applicable');
  assert.equal(value.authority, 'source-planner');
});

test('native evidence binds the receipt to Buildchain diagnostics', () => {
  const value = nativeEvidenceFromMembers(nativeMembers(), { kind: 'native' });
  assert.equal(value.outcome, 'observed');
  assert.equal(value.steps[1].id, 'cmake-build');
  assert.equal(value.process.observedConcurrency.max, 3);

  const drifted = nativeMembers();
  drifted['diagnostics.json'] = drifted['diagnostics.json'].replace(
    '200000',
    '200001',
  );
  assert.equal(
    nativeEvidenceFromMembers(drifted, { kind: 'native' }).outcome,
    'unknown',
  );
});

test('partition evidence admits only a complete source-bound closure', () => {
  const planWithoutDigest = {
    targets: ['kungfu', 'test-a', 'yijinjing', 'test-b'],
    tests: ['test-a', 'test-b'],
  };
  const ordered = (value) => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      );
    }
    return value;
  };
  const plan = {
    ...planWithoutDigest,
    planDigest: `sha256:${crypto
      .createHash('sha256')
      .update(JSON.stringify(ordered(planWithoutDigest)))
      .digest('hex')}`,
  };
  const entries = [0, 1].map((index) => {
    const executionPartition = partitionAffectedNativePlan(plan, 2, index);
    const members = nativeMembers({ executionPartition, plan });
    members['cache/dependency.receipt.json'] = cacheReceipt(
      'dependency',
      'compatible',
      { sourceSha: 'head' },
    );
    members['cache/compiler.receipt.json'] = cacheReceipt('compiler', 'exact', {
      sourceSha: 'head',
    });
    return {
      cache: cacheEvidenceFromMembers(members, { kind: 'native' }),
      native: nativeEvidenceFromMembers(members, { kind: 'native' }),
    };
  });
  const combined = aggregatePartitionEvidence(entries, { kind: 'native' });
  assert.equal(combined.cache.outcome, 'compatible');
  assert.equal(combined.cache.layers.length, 4);
  assert.equal(combined.native.executionPartitions.length, 2);
  assert.equal(combined.native.steps[1].id, 'cmake-configure');

  assert.throws(
    () => aggregatePartitionEvidence(entries.slice(0, 1), { kind: 'native' }),
    /index set is incomplete/,
  );
});

test('native attribution separates warm and cold phase distributions', () => {
  const nativeEvidence = nativeEvidenceFromMembers(nativeMembers(), {
    kind: 'native',
  });
  const value = summarizeNativeAttribution([
    {
      durationMs: 250000,
      classification: { kind: 'native' },
      cache: { warm: true, cold: false },
      nativeEvidence,
    },
    {
      durationMs: 500000,
      classification: { kind: 'native' },
      cache: { warm: false, cold: true },
      nativeEvidence: {
        ...nativeEvidence,
        steps: nativeEvidence.steps.map((step) => ({
          ...step,
          durationMs: step.durationMs * 2,
        })),
      },
    },
  ]);
  assert.equal(value.observedCount, 2);
  assert.equal(value.steps['cmake-build'].p95Ms, 400000);
  assert.equal(value.cohorts.warm.latency.p50Ms, 250000);
  assert.equal(value.cohorts.cold.latency.p50Ms, 500000);
  assert.equal(value.process.maxActiveProcesses.p95, 3);
});

test('a passing latency window still requires complete native cache evidence', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    excluded: false,
    pullRequest: index + 1,
    sourceSha: index.toString(16).padStart(40, '0'),
    durationMs: 120000,
    classification: { kind: 'native' },
    cache:
      index === 0
        ? { outcome: 'unknown', warm: false, cold: false }
        : { outcome: 'compatible', warm: true, cold: false },
  }));
  const incomplete = report('owner/repo', 'dev', ['required'], records);
  assert.equal(incomplete.verdict.qualified, false);
  assert.match(incomplete.verdict.reason, /cache evidence is incomplete/);

  records[0].cache = { outcome: 'miss', warm: false, cold: true };
  const complete = report('owner/repo', 'dev', ['required'], records);
  assert.equal(complete.verdict.qualified, true);
  assert.equal(complete.cache.warmCount, 19);
  assert.equal(complete.cache.coldCount, 1);
});

test('an overall passing window cannot mask a native P95 violation', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    excluded: false,
    pullRequest: index + 1,
    sourceSha: index.toString(16).padStart(40, '0'),
    durationMs: index === 0 ? 700000 : 120000,
    classification: { kind: index < 10 ? 'native' : 'non-native' },
    cache:
      index < 10
        ? { outcome: 'compatible', warm: true, cold: false }
        : { outcome: 'not-applicable' },
  }));
  const value = report('owner/repo', 'dev', ['required'], records);
  assert.equal(value.statistics.all.p95Ms, 120000);
  assert.equal(value.statistics.native.p95Ms, 700000);
  assert.equal(value.verdict.qualified, false);
  assert.match(value.verdict.reason, /native sample exceeds target/);
  records[10].classification.kind = 'unknown';
  const incomplete = report('owner/repo', 'dev', ['required'], records);
  assert.equal(incomplete.statistics.unknown.sampleCount, 1);
  assert.match(incomplete.verdict.reason, /unknown impact attribution/);
});
test('summary reports sample count and queue-inclusive distribution', () => {
  assert.deepEqual(
    summarize([
      { durationMs: 120000 },
      { durationMs: 300000 },
      { durationMs: 700000 },
    ]),
    { sampleCount: 3, p50Ms: 300000, p95Ms: 700000, maxMs: 700000 },
  );
});

test('report declares merge-queue authority and PR checks as diagnostic only', () => {
  const value = report(
    'owner/repo',
    'dev',
    ['required'],
    [
      {
        excluded: false,
        pullRequest: 1,
        sourceSha: 'a'.repeat(40),
        durationMs: 120000,
        classification: { kind: 'non-native' },
        cache: { outcome: 'not-applicable' },
      },
    ],
  );
  assert.match(value.metric.start, /AddedToMergeQueueEvent/);
  assert.match(value.metric.end, /eventual merged merge-group round/);
  assert.match(value.metric.retries, /diagnostic only/);
});

test('context duration starts at the workflow run creation time', () => {
  const context = selectedContext(
    [
      {
        id: 7,
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-17T00:03:00Z',
        completed_at: '2026-07-17T00:05:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/42/job/7',
      },
    ],
    [
      {
        id: 42,
        created_at: '2026-07-17T00:00:00Z',
        head_sha: 'merge-head',
      },
    ],
    'required',
  );
  assert.equal(context.startAuthority, 'workflow.created_at');
  assert.equal(context.durationMs, 300000);
  assert.equal(context.queueMs, 180000);
  assert.equal(context.finalWorkflowHeadSha, 'merge-head');
});

test('context admission ignores successful post-merge reruns', () => {
  const context = selectedContext(
    [
      {
        id: 7,
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-17T00:03:00Z',
        completed_at: '2026-07-17T00:05:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/42/job/7',
      },
      {
        id: 8,
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-17T02:00:00Z',
        completed_at: '2026-07-17T04:00:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/43/job/8',
      },
    ],
    [
      { id: 42, created_at: '2026-07-17T00:00:00Z' },
      { id: 43, created_at: '2026-07-17T02:00:00Z' },
    ],
    'required',
    '2026-07-17T00:06:00Z',
  );
  assert.equal(context.checkRunId, 7);
  assert.equal(context.durationMs, 300000);
  assert.deepEqual(context.workflowRunIds, [42]);
  assert.equal(context.endAuthority, 'first-success-no-later-than-pull-merge');
});

test('required contexts come from all effective required-status rules', () => {
  assert.deepEqual(
    requiredContextsFromEffectiveRules([
      { type: 'deletion', parameters: null },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'affected-native / linux', integration_id: 15368 },
            {
              context: 'Candidate source acceptance / check',
              integration_id: 15368,
            },
          ],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: [
            { context: 'affected-native / linux', integration_id: 15368 },
          ],
        },
      },
    ]),
    ['Candidate source acceptance / check', 'affected-native / linux'],
  );
  assert.throws(
    () => requiredContextsFromEffectiveRules({}),
    /expected effective branch rules array/,
  );
});

test('cache evidence binds exact pull plans and explicit coalesced queue plans', () => {
  const sourceSha = 'a'.repeat(40);
  const groupSha = 'b'.repeat(40);
  const classification = {
    changedPaths: ['framework/core/a.cpp'],
    authority: { layers: 'layers', buildCapabilities: 'capabilities' },
  };
  const cache = { layers: [{ sourceSha: groupSha }] };
  const native = {
    outcome: 'observed',
    source: { head: groupSha },
    planChangedPaths: ['framework/core/a.cpp', 'framework/core/b.cpp'],
    planAuthority: classification.authority,
  };
  assert.deepEqual(
    affectedNativeEvidenceBinding(
      cache,
      native,
      classification,
      groupSha,
      sourceSha,
    ),
    {
      sourceRelation: 'merge-group-source',
      planRelation: 'merge-group-coalesced',
    },
  );
  assert.throws(
    () =>
      affectedNativeEvidenceBinding(
        { layers: [{ sourceSha }] },
        { ...native, source: { head: sourceSha } },
        classification,
        sourceSha,
        sourceSha,
      ),
    /does not match source or plan/,
  );
});

test('context admission retains failed attempts before the first success', () => {
  const context = selectedContext(
    [
      {
        id: 6,
        name: 'required',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-17T00:01:00Z',
        completed_at: '2026-07-17T00:02:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/41/job/6',
      },
      {
        id: 7,
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-17T00:04:00Z',
        completed_at: '2026-07-17T00:05:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/42/job/7',
      },
    ],
    [
      { id: 41, created_at: '2026-07-17T00:00:00Z' },
      { id: 42, created_at: '2026-07-17T00:03:00Z' },
    ],
    'required',
    '2026-07-17T00:06:00Z',
  );
  assert.equal(context.retryCount, 1);
  assert.equal(context.durationMs, 300000);
  assert.deepEqual(context.workflowRunIds, [41, 42]);
});
