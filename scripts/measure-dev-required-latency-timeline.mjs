// SPDX-License-Identifier: Apache-2.0
// @ts-check

import {
  deliveryTimelineEvent,
  roundAttempt,
} from './cancel-dequeued-merge-group-runs.mjs';

function milliseconds(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
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

function appendPrCheckEvents(events, sourceSha, prAttempt, checks) {
  for (const check of checks || []) {
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
}

function appendWorkflowJobEvents(
  events,
  repository,
  sourceSha,
  attempt,
  run,
  job,
) {
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
    attempt,
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
    attempt,
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
      attempt,
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

function appendWorkflowRunEvents(events, repository, sourceSha, attempt, run) {
  const runAttempt = {
    ...attempt,
    mergeGroupSha: run.headSha,
    workflowRunId: run.id,
  };
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
    appendWorkflowJobEvents(
      events,
      repository,
      sourceSha,
      runAttempt,
      run,
      job,
    );
  }
  return runAttempt;
}

function appendQueueRoundEvents(
  events,
  repository,
  sourceSha,
  pullRequest,
  rounds,
) {
  const runAttempts = new Map();
  for (const round of rounds) {
    const attempt = roundAttempt(pullRequest, round);
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
      const runAttempt = appendWorkflowRunEvents(
        events,
        repository,
        sourceSha,
        attempt,
        run,
      );
      runAttempts.set(String(run.id), runAttempt);
    }
  }
  return runAttempts;
}

function appendMergeFinalizationEvent(
  events,
  repository,
  sourceSha,
  sample,
  rounds,
) {
  const mergedRound = [...rounds]
    .reverse()
    .find(({ reason }) => reason === 'merged');
  const mergedRun = mergedRound?.mergeGroupRuns?.at(-1);
  if (!mergedRound || !mergedRun) return;
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
      finalDevAncestry: sample.deliveryEvidence?.finalDev?.outcome || 'unknown',
      pullRequestUrl: `https://github.com/${repository}/pull/${sample.pullRequest}`,
      runUrl: `https://github.com/${repository}/actions/runs/${mergedRun.id}`,
    },
  });
}

function appendInternalEvents(events, sourceSha, runAttempts, internalEvents) {
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
}

function appendPostMergeAdvisoryEvents(
  events,
  sourceSha,
  finalAttempt,
  attempts,
) {
  if (!finalAttempt) return;
  for (const advisory of attempts || []) {
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

function appendCacheEvents(events, sourceSha, finalAttempt, layers) {
  if (!finalAttempt) return;
  for (const [index, layer] of (layers || []).entries()) {
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

const NATIVE_PHASES = [
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
];

function appendUnobservedNativeEvents(
  events,
  sourceSha,
  finalAttempt,
  classification,
  internalEvents,
) {
  if (classification?.kind !== 'native' || !finalAttempt) return;
  const observedPhases = internalEvents.map(({ phase }) => phase);
  for (const phase of NATIVE_PHASES) {
    const observed = observedPhases.some(
      (value) => value === phase || value.startsWith(`${phase}-`),
    );
    if (observed) continue;
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

export function candidateTimelineInput(repository, branch, sample) {
  const events = [];
  const sourceSha = sample.sourceSha;
  const prAttempt = {
    id: `pr-${sample.pullRequest}-${sourceSha}`,
    index: 0,
    kind: 'pull-request',
  };
  appendPrCheckEvents(events, sourceSha, prAttempt, sample.checks);

  const rounds = sample.mergeQueue?.rounds || [];
  const runAttempts = appendQueueRoundEvents(
    events,
    repository,
    sourceSha,
    sample.pullRequest,
    rounds,
  );
  appendMergeFinalizationEvent(events, repository, sourceSha, sample, rounds);

  const proofEvent = deliveryTimelineEvent(sample, rounds, sourceSha);
  if (proofEvent) events.push(proofEvent);

  const internalEvents = sample.nativeEvidence?.candidateEvents || [];
  appendInternalEvents(events, sourceSha, runAttempts, internalEvents);
  const finalAttempt = rounds.length
    ? roundAttempt(sample.pullRequest, rounds.at(-1))
    : null;
  appendPostMergeAdvisoryEvents(
    events,
    sourceSha,
    finalAttempt,
    sample.postMergeAdvisory?.attempts,
  );
  appendCacheEvents(events, sourceSha, finalAttempt, sample.cache?.layers);
  appendUnobservedNativeEvents(
    events,
    sourceSha,
    finalAttempt,
    sample.classification,
    internalEvents,
  );

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
