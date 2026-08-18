// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  postMergeAdvisoryEvidence,
  summarizeMergeQueueDelivery,
  summarizePostMergeAdvisory,
} from '../framework/dev-delivery/dev-gate-queue-evidence.mjs';
import {
  candidateTimelineInput,
  mergeQueueEvidence,
} from './measure-dev-required-latency.mjs';

test('dequeue explains a later validation and runner wait remains bounded', () => {
  const value = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-08-17T01:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-08-17T01:10:00Z',
        reason: 'FAILED_CHECKS',
      },
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-08-17T01:20:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-08-17T01:30:00Z',
        reason: 'MERGED',
      },
    ],
    [
      {
        id: 101,
        workflow_id: 77,
        head_sha: 'failed-round',
        created_at: '2026-08-17T01:01:00Z',
        updated_at: '2026-08-17T01:09:00Z',
      },
      {
        id: 102,
        workflow_id: 77,
        head_sha: 'merged-round',
        created_at: '2026-08-17T01:21:00Z',
        updated_at: '2026-08-17T01:29:00Z',
      },
    ],
    {
      101: [
        {
          id: 1001,
          name: 'check',
          started_at: '2026-08-17T01:03:00Z',
          completed_at: '2026-08-17T01:08:00Z',
        },
      ],
      102: [
        {
          id: 1002,
          name: 'check',
          started_at: '2026-08-17T01:25:00Z',
          completed_at: '2026-08-17T01:28:00Z',
        },
      ],
    },
    '2026-08-17T01:30:00Z',
  );
  assert.equal(value.explainedRepeatedValidationCount, 1);
  assert.equal(value.unexplainedRepeatedValidationCount, 0);
  assert.deepEqual(value.repeatedValidationExplanations, { failed_checks: 1 });
  assert.equal(value.runnerWaitEvidenceComplete, true);
  assert.equal(value.runnerWaitUpperBoundMs, 4 * 60 * 1000);
});

test('closed queue rounds without a runner preserve a zero wait bound', () => {
  const value = mergeQueueEvidence(
    [
      {
        __typename: 'AddedToMergeQueueEvent',
        createdAt: '2026-08-17T01:00:00Z',
      },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-08-17T01:05:00Z',
        reason: 'MERGE_CONFLICT',
      },
    ],
    [],
    {},
    null,
  );
  assert.equal(value.runnerWaitEvidenceComplete, true);
  assert.equal(value.runnerWaitUpperBoundMs, 0);
});

test('strict conflict, unexplained repeat, and runner wait budgets fail closed', () => {
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
      runnerWaitUpperBoundMs: index === 0 ? 31 * 60 * 1000 : 120_000,
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

test('post-merge advisory stays visible and outside the candidate critical path', () => {
  const sourceSha = 'a'.repeat(40);
  const evidence = postMergeAdvisoryEvidence(
    {
      merge_commit_sha: sourceSha,
      merged_at: '2026-08-17T01:00:00Z',
    },
    [
      {
        id: 91,
        head_sha: sourceSha,
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-17T01:01:00Z',
        updated_at: '2026-08-17T01:11:00Z',
      },
    ],
  );
  const summary = summarizePostMergeAdvisory([{ postMergeAdvisory: evidence }]);
  assert.equal(summary.statistics.p95Ms, 11 * 60 * 1000);
  assert.equal(summary.criticalPathEligible, false);

  const timeline = candidateTimelineInput(
    'kungfu-systems/kungfu',
    'dev/v4/v4.0',
    {
      pullRequest: 3262,
      sourceSha,
      mergedAt: '2026-08-17T01:00:00Z',
      classification: { kind: 'non-native' },
      checks: [],
      mergeQueue: {
        rounds: [
          {
            index: 0,
            enqueuedAt: '2026-08-17T00:55:00Z',
            removedAt: '2026-08-17T01:00:00Z',
            reason: 'merged',
            mergeGroupRuns: [],
          },
        ],
      },
      postMergeAdvisory: evidence,
      cache: { layers: [] },
    },
  );
  const advisory = timeline.events.find(
    ({ phase }) => phase === 'post-merge-advisory',
  );
  assert.equal(advisory.criticalPathEligible, false);
  assert.equal(advisory.attributes.mergeCriticalMetricImpact, 'excluded');
});
