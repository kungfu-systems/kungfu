// SPDX-License-Identifier: Apache-2.0
// @ts-check

const MINIMUM_SAMPLE_COUNT = 20;

function milliseconds(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
}

function nearestRank(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function workflowIdentity(run) {
  return String(run.workflow_id || run.path || run.name || 'unknown-workflow');
}

export function validationRepeatEvidence(rounds) {
  const seen = new Set();
  let repeated = 0;
  let explained = 0;
  let unexplained = 0;
  const explanations = {};
  for (const round of rounds) {
    const seenInRound = new Set();
    for (const run of round.mergeGroupRuns || []) {
      const identity = run.workflowIdentity || String(run.id);
      if (seen.has(identity)) {
        repeated += 1;
        const priorExit = rounds
          .slice(0, round.index)
          .reverse()
          .find(({ reason }) => reason !== 'merged');
        if (!seenInRound.has(identity) && priorExit) {
          explained += 1;
          explanations[priorExit.reason] =
            (explanations[priorExit.reason] || 0) + 1;
        } else {
          unexplained += 1;
        }
      }
      seen.add(identity);
      seenInRound.add(identity);
    }
  }
  return { repeated, explained, unexplained, explanations };
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
  const runnerWaitObserved = queueObserved.filter(
    ({ mergeQueue }) => mergeQueue.runnerWaitEvidenceComplete,
  );
  const durations = deliveryObserved.map(
    ({ mergeQueue }) => mergeQueue.deliveryDurationMs,
  );
  const dequeuePrCount = queueObserved.filter(
    ({ mergeQueue }) => mergeQueue.dequeueCount > 0,
  ).length;
  const mergeConflictPrCount = queueObserved.filter(
    ({ mergeQueue }) => (mergeQueue.dequeueReasons?.merge_conflict || 0) > 0,
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
  const mergeConflictRate = queueObserved.length
    ? mergeConflictPrCount / queueObserved.length
    : null;
  const unexplainedRepeatedValidationCount = queueObserved.reduce(
    (total, { mergeQueue }) =>
      total + (mergeQueue.unexplainedRepeatedValidationCount || 0),
    0,
  );
  const runnerWaitUpperBounds = runnerWaitObserved.map(
    ({ mergeQueue }) => mergeQueue.runnerWaitUpperBoundMs,
  );
  const runnerWaitQualified =
    runnerWaitObserved.length === queueObserved.length &&
    runnerWaitUpperBounds.length > 0 &&
    Math.max(...runnerWaitUpperBounds) <= 30 * 60 * 1000;
  const meetsTarget =
    p50Ms !== null &&
    p50Ms <= 15 * 60 * 1000 &&
    p90Ms !== null &&
    p90Ms <= 30 * 60 * 1000 &&
    dequeueRate < 0.1 &&
    mergeConflictRate < 0.05 &&
    unexplainedRepeatedValidationCount === 0 &&
    runnerWaitQualified;
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
      mergeConflict: {
        pullRequestCount: mergeConflictPrCount,
        rate: mergeConflictRate,
        exclusiveMax: 0.05,
      },
    },
    repeatedValidationCount: queueObserved.reduce(
      (total, { mergeQueue }) => total + mergeQueue.repeatedValidationCount,
      0,
    ),
    explainedRepeatedValidationCount: queueObserved.reduce(
      (total, { mergeQueue }) =>
        total + (mergeQueue.explainedRepeatedValidationCount || 0),
      0,
    ),
    unexplainedRepeatedValidationCount,
    runnerWait: {
      authority:
        'github-actions-workflow-created_at-to-job-started_at-upper-bound',
      evidenceObservedCount: runnerWaitObserved.length,
      statistics: {
        sampleCount: runnerWaitUpperBounds.length,
        p50Ms: nearestRank(runnerWaitUpperBounds, 0.5),
        p95Ms: nearestRank(runnerWaitUpperBounds, 0.95),
        maxMs: runnerWaitUpperBounds.length
          ? Math.max(...runnerWaitUpperBounds)
          : null,
      },
      target: { maxUpperBoundMs: 30 * 60 * 1000 },
      qualified: runnerWaitQualified,
    },
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

export function postMergeAdvisoryEvidence(pull, runs) {
  const matching = runs
    .filter(({ head_sha: headSha }) => headSha === pull.merge_commit_sha)
    .sort(
      (left, right) =>
        new Date(left.created_at).getTime() -
        new Date(right.created_at).getTime(),
    );
  const attempts = matching.map((run) => {
    const terminal = run.status === 'completed' && Boolean(run.updated_at);
    return {
      workflowRunId: run.id,
      status: terminal ? 'observed' : 'incomplete',
      conclusion: run.conclusion || null,
      createdAt: run.created_at || null,
      completedAt: terminal ? run.updated_at : null,
      durationMs:
        terminal && run.created_at
          ? Math.max(0, milliseconds(run.created_at, run.updated_at))
          : null,
      tailDurationMs:
        terminal && pull.merged_at
          ? Math.max(0, milliseconds(pull.merged_at, run.updated_at))
          : null,
    };
  });
  const complete = attempts.filter(({ status }) => status === 'observed');
  return {
    status: !attempts.length
      ? 'not-observed'
      : complete.length === attempts.length
        ? 'observed'
        : 'incomplete',
    authority: 'github-actions-dev-post-merge-advisory-workflow-run',
    criticalPathEligible: false,
    mergeCriticalMetricImpact: 'excluded',
    attemptCount: attempts.length,
    tailDurationMs: complete.length
      ? Math.max(...complete.map(({ tailDurationMs }) => tailDurationMs))
      : null,
    attempts,
  };
}

export function summarizePostMergeAdvisory(samples) {
  const evidence = samples
    .map(({ postMergeAdvisory }) => postMergeAdvisory)
    .filter(Boolean);
  const observed = evidence.filter(({ status }) => status === 'observed');
  const durations = observed
    .map(({ tailDurationMs }) => tailDurationMs)
    .filter(Number.isFinite);
  return {
    authority: 'github-actions-dev-post-merge-advisory-workflow-run',
    criticalPathEligible: false,
    mergeCriticalMetricImpact: 'excluded',
    observedCount: observed.length,
    incompleteCount: evidence.filter(({ status }) => status === 'incomplete')
      .length,
    notObservedCount: evidence.filter(({ status }) => status === 'not-observed')
      .length,
    statistics: {
      sampleCount: durations.length,
      p50Ms: nearestRank(durations, 0.5),
      p95Ms: nearestRank(durations, 0.95),
      maxMs: durations.length ? Math.max(...durations) : null,
    },
    samples: evidence,
  };
}
