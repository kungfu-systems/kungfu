// SPDX-License-Identifier: Apache-2.0
// @ts-check

function runnerWaitEvidenceForRun(run, jobs, milliseconds) {
  const upperBounds = [];
  let complete = true;
  for (const job of jobs) {
    const upperBoundMs =
      run.createdAt && job.started_at
        ? milliseconds(run.createdAt, job.started_at)
        : Number.NaN;
    if (!Number.isFinite(upperBoundMs) || upperBoundMs < 0) {
      complete = false;
      continue;
    }
    upperBounds.push({
      workflowRunId: run.id,
      jobId: job.id,
      jobName: job.name,
      upperBoundMs,
      authority:
        'github-actions-workflow-created_at-to-job-started_at-upper-bound',
    });
  }
  return { complete, upperBounds };
}

export function collectRunnerWaitEvidence(
  allRuns,
  jobsByRun,
  { milliseconds },
) {
  const runs = allRuns.map((run) =>
    runnerWaitEvidenceForRun(
      run,
      jobsByRun[String(run.id)] || [],
      milliseconds,
    ),
  );
  return {
    complete:
      allRuns.every(
        ({ id, createdAt }) =>
          Boolean(createdAt) &&
          Array.isArray(jobsByRun[String(id)]) &&
          jobsByRun[String(id)].length > 0,
      ) && runs.every(({ complete }) => complete),
    upperBounds: runs.flatMap(({ upperBounds }) => upperBounds),
  };
}

function wastedRunnerEvidenceForRun(run, jobs, { jobDuration, milliseconds }) {
  const diagnostics = [];
  let complete = true;
  let wastedRunnerMs = 0;
  let postDequeueRunnerMs = 0;
  for (const job of jobs) {
    const durationMs = jobDuration(job);
    if (durationMs === null) {
      diagnostics.push('merge-group-job-not-terminal');
      complete = false;
      continue;
    }
    wastedRunnerMs += durationMs;
    const afterRemoval =
      job.started_at && job.completed_at
        ? milliseconds(
            new Date(
              Math.max(
                new Date(job.started_at).getTime(),
                new Date(run.removedAt).getTime(),
              ),
            ).toISOString(),
            job.completed_at,
          )
        : 0;
    postDequeueRunnerMs += Math.max(0, afterRemoval);
  }
  return { complete, wastedRunnerMs, postDequeueRunnerMs, diagnostics };
}

export function collectWastedRunnerEvidence(
  wastedRuns,
  jobsByRun,
  diagnostics,
  dependencies,
) {
  const runs = wastedRuns.map((run) =>
    wastedRunnerEvidenceForRun(
      run,
      jobsByRun[String(run.id)] || [],
      dependencies,
    ),
  );
  diagnostics.push(...runs.flatMap((run) => run.diagnostics));
  return {
    complete:
      wastedRuns.every(({ id }) => Array.isArray(jobsByRun[String(id)])) &&
      runs.every(({ complete }) => complete),
    wastedRunnerMs: runs.reduce((total, run) => total + run.wastedRunnerMs, 0),
    postDequeueRunnerMs: runs.reduce(
      (total, run) => total + run.postDequeueRunnerMs,
      0,
    ),
  };
}

function requireNativeEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

export function parseAndValidateNativeEvidenceMembers(
  members,
  { digest, structuredDigest },
) {
  requireNativeEvidence(members['receipt.json'], 'missing native receipt');
  requireNativeEvidence(
    members['diagnostics.json'],
    'missing Buildchain diagnostics',
  );
  const receipt = JSON.parse(members['receipt.json']);
  const diagnostics = JSON.parse(members['diagnostics.json']);
  const candidateEvents = (members['candidate-events.jsonl'] || '')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  requireNativeEvidence(
    receipt.schema === 'kungfu.core-affected-native-receipt/v1' &&
      receipt.status === 'passed' &&
      Array.isArray(receipt.steps),
    'invalid native receipt',
  );
  requireNativeEvidence(
    candidateEvents.every(
      (event) =>
        event.id &&
        event.attempt?.id &&
        event.phase &&
        event.status &&
        event.attributes?.sourceSha === receipt.source.head,
    ),
    'invalid candidate timeline event binding',
  );
  if (receipt.plan?.planDigest) {
    const { planDigest, ...planWithoutDigest } = receipt.plan;
    requireNativeEvidence(
      planDigest === structuredDigest(planWithoutDigest) &&
        receipt.planDigest === planDigest,
      'native receipt plan digest drift',
    );
  }
  requireNativeEvidence(
    diagnostics.contract === 'kungfu-buildchain-diagnostics' &&
      diagnostics.consumer?.contract ===
        'kungfu.affected-native-diagnostics/v1' &&
      diagnostics.consumer?.gateId === 'source.changed-scope',
    'invalid Buildchain diagnostics binding',
  );
  requireNativeEvidence(
    receipt.diagnostics?.digest === digest(members['diagnostics.json']) &&
      receipt.diagnostics?.consumerContract === diagnostics.consumer.contract &&
      receipt.planDigest === diagnostics.consumer.planDigest,
    'native diagnostics digest or plan binding drift',
  );
  const partition = receipt.executionPartition || null;
  if (partition) {
    requireNativeEvidence(
      partition.schema === 'kungfu.core-affected-native-partition/v1' &&
        Number.isInteger(partition.index) &&
        Number.isInteger(partition.count) &&
        partition.count >= 1 &&
        partition.index >= 0 &&
        partition.index < partition.count &&
        Array.isArray(partition.targets) &&
        Array.isArray(partition.tests) &&
        diagnostics.consumer?.executionPartition?.partitionDigest ===
          partition.partitionDigest &&
        diagnostics.consumer?.executionPartition?.coverageDigest ===
          partition.coverageDigest,
      'invalid native execution partition binding',
    );
  }
  return { receipt, diagnostics, candidateEvents, partition };
}
