// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateDeliveryAttempt } from '../../scripts/affected-native-proof.mjs';

function deliveryMilliseconds(start, end) {
  return new Date(end).getTime() - new Date(start).getTime();
}

function sortedStrings(values) {
  return [...new Set((values || []).map(String))].sort();
}

export function affectedNativeEvidenceBinding(
  cache,
  native,
  classification,
  expectedSourceSha,
  pullSourceSha,
) {
  if (
    cache.layers.some(
      ({ sourceSha }) => !sourceSha || sourceSha !== expectedSourceSha,
    ) ||
    native.outcome !== 'observed' ||
    native.source?.head !== expectedSourceSha ||
    JSON.stringify(native.planAuthority) !==
      JSON.stringify(classification.authority)
  ) {
    throw new Error('affected-native evidence does not match source or plan');
  }
  const exactPlan =
    JSON.stringify(native.planChangedPaths) ===
    JSON.stringify(classification.changedPaths);
  if (!exactPlan && expectedSourceSha === pullSourceSha) {
    throw new Error('affected-native evidence does not match source or plan');
  }
  return {
    sourceRelation:
      expectedSourceSha === pullSourceSha
        ? 'pull-source'
        : 'merge-group-source',
    planRelation: exactPlan ? 'exact' : 'merge-group-coalesced',
  };
}

export function roundAttempt(pullRequest, round) {
  const run = round.mergeGroupRuns[0];
  return {
    id: `mq-${pullRequest}-${round.index}`,
    index: round.index + 1,
    kind: 'merge-queue',
    mergeGroupSha: run?.headSha,
    workflowRunId: run?.id,
  };
}

export function readZipMembers(archive, names) {
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

export function deliveryAttemptEvidenceFromMembers(members, expected) {
  const raw = members['delivery-attempt.json'];
  if (!raw) {
    return {
      outcome: 'missing',
      authority: 'affected-native-delivery-attempt-artifact',
      reason: 'delivery-attempt.json is missing',
    };
  }
  try {
    const attempt = validateDeliveryAttempt(JSON.parse(raw));
    const expectedContexts = sortedStrings(expected.requiredContexts);
    const actualContexts = sortedStrings(attempt.requiredChecks?.contexts);
    const disagreements = [];
    if (attempt.workflow.repository !== expected.repository) {
      disagreements.push('repository');
    }
    if (attempt.workflow.runId !== Number(expected.workflowRunId)) {
      disagreements.push('workflow-run');
    }
    if (attempt.source.pullRequestHead !== expected.pullRequestHead) {
      disagreements.push('pull-request-head');
    }
    if (attempt.source.mergeGroupHead !== expected.mergeGroupHead) {
      disagreements.push('merge-group-head');
    }
    if (attempt.source.checkout !== expected.mergeGroupHead) {
      disagreements.push('checkout-head');
    }
    if (JSON.stringify(actualContexts) !== JSON.stringify(expectedContexts)) {
      disagreements.push('required-contexts');
    }
    if (disagreements.length) {
      return {
        outcome: 'invalidated',
        authority: 'affected-native-delivery-attempt-artifact',
        reason: `delivery attempt disagrees on ${disagreements.join(', ')}`,
        disagreements,
        attemptRoot: attempt.attemptRoot,
      };
    }
    return {
      outcome: 'proved',
      authority: 'affected-native-delivery-attempt-artifact',
      attemptRoot: attempt.attemptRoot,
      deliveryBindingRoot: attempt.deliveryBindingRoot,
      source: attempt.source,
      family: attempt.family,
      requiredChecks: attempt.requiredChecks,
      queueAdmission: attempt.queueAdmission,
      proof: attempt.proof,
      workflow: attempt.workflow,
    };
  } catch (error) {
    return {
      outcome: 'invalidated',
      authority: 'affected-native-delivery-attempt-artifact',
      reason: error.message,
    };
  }
}

export function finalDevAncestryFromCompare(
  mergeCommitSha,
  finalDevHead,
  comparison,
) {
  if (
    !/^[0-9a-f]{40}$/u.test(mergeCommitSha || '') ||
    !/^[0-9a-f]{40}$/u.test(finalDevHead || '')
  ) {
    return {
      outcome: 'unknown',
      authority: 'github-compare',
      reason: 'merge commit or final dev head is unavailable',
      mergeCommitSha: mergeCommitSha || null,
      finalDevHead: finalDevHead || null,
    };
  }
  const status = comparison?.status || null;
  const mergeBase = comparison?.merge_base_commit?.sha || null;
  const proved =
    ['ahead', 'identical'].includes(status) && mergeBase === mergeCommitSha;
  return {
    outcome: proved ? 'proved' : 'invalidated',
    authority: 'github-compare',
    mergeCommitSha,
    finalDevHead,
    compareStatus: status,
    mergeBase,
    ...(proved
      ? {}
      : {
          reason:
            'merged pull request commit is not an ancestor of final dev head',
        }),
  };
}

export function reconstructDeliveryEvidence({
  pullRequest,
  sourceSha,
  mergeCommitSha,
  requiredContexts,
  requiredWindow,
  mergeQueue,
  deliveryAttempt,
  finalDev,
}) {
  const authority =
    'family-lease+github-merge-queue+affected-native-proof+github-compare';
  const rounds = mergeQueue?.rounds || [];
  const queue = {
    authority: mergeQueue?.authority || null,
    firstEnqueuedAt: mergeQueue?.firstEnqueuedAt || null,
    mergedAt: mergeQueue?.mergedAt || null,
    deliveryDurationMs: mergeQueue?.deliveryDurationMs ?? null,
    dequeueCount: mergeQueue?.dequeueCount ?? null,
    dequeueReasons: mergeQueue?.dequeueReasons || {},
    repeatedValidationCount: mergeQueue?.repeatedValidationCount ?? null,
    runnerEvidenceComplete: mergeQueue?.runnerEvidenceComplete === true,
    wastedRunnerMs: mergeQueue?.wastedRunnerMs ?? null,
    postDequeueRunnerMs: mergeQueue?.postDequeueRunnerMs ?? null,
    rounds: rounds.map((round) => ({
      index: round.index,
      enqueuedAt: round.enqueuedAt,
      removedAt: round.removedAt,
      reason: round.reason,
      beforeCommit: round.beforeCommit || null,
      mergeGroupRuns: (round.mergeGroupRuns || []).map((run) => {
        const jobs = run.jobs || [];
        const measuredJobs = jobs.filter(
          ({ startedAt, completedAt }) => startedAt && completedAt,
        );
        return {
          id: run.id,
          headSha: run.headSha,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          status: run.status,
          conclusion: run.conclusion,
          runnerUse: {
            jobCount: jobs.length,
            measuredJobCount: measuredJobs.length,
            runnerMs:
              measuredJobs.length === jobs.length
                ? measuredJobs.reduce(
                    (total, job) =>
                      total +
                      deliveryMilliseconds(job.startedAt, job.completedAt),
                    0,
                  )
                : null,
          },
        };
      }),
    })),
  };
  if (
    deliveryAttempt?.outcome === 'invalidated' ||
    finalDev?.outcome === 'invalidated'
  ) {
    return {
      outcome: 'invalidated',
      authority,
      reason:
        deliveryAttempt?.outcome === 'invalidated'
          ? deliveryAttempt.reason
          : finalDev.reason,
      pullRequest,
      sourceSha,
      mergeCommitSha: mergeCommitSha || null,
      queue,
      requiredWindow,
      deliveryAttempt,
      finalDev,
    };
  }
  const mergedRound = [...rounds]
    .reverse()
    .find(({ reason }) => reason === 'merged');
  const mergedRun = mergedRound?.mergeGroupRuns?.find(
    ({ id }) => Number(id) === Number(deliveryAttempt?.workflow?.runId),
  );
  if (
    mergeQueue?.queueStatus === 'not-observed' ||
    !mergedRound ||
    deliveryAttempt?.outcome === 'missing'
  ) {
    return {
      outcome: 'missing',
      authority,
      reason:
        deliveryAttempt?.outcome === 'missing'
          ? deliveryAttempt.reason
          : 'authoritative merged merge-queue round is missing',
      pullRequest,
      sourceSha,
      mergeCommitSha: mergeCommitSha || null,
      queue,
      requiredWindow,
      deliveryAttempt,
      finalDev,
    };
  }
  const expectedContexts = sortedStrings(requiredContexts);
  const observedContexts = sortedStrings(
    requiredWindow?.contexts?.map(({ context }) => context),
  );
  const complete =
    mergeQueue?.status === 'observed' &&
    mergeQueue?.runnerEvidenceComplete === true &&
    requiredWindow?.status === 'observed' &&
    JSON.stringify(observedContexts) === JSON.stringify(expectedContexts) &&
    deliveryAttempt?.outcome === 'proved' &&
    mergedRun &&
    Number(mergedRun.id) === Number(deliveryAttempt.workflow?.runId) &&
    mergedRun.headSha === deliveryAttempt.source?.mergeGroupHead &&
    sourceSha === deliveryAttempt.source?.pullRequestHead &&
    finalDev?.outcome === 'proved';
  return {
    outcome: complete ? 'proved' : 'partial',
    authority,
    ...(complete
      ? {}
      : {
          reason:
            'one or more queue, required-check, runner, source, or final-dev facts are incomplete',
        }),
    pullRequest,
    sourceSha,
    mergeCommitSha: mergeCommitSha || null,
    requiredContexts: expectedContexts,
    queue,
    requiredWindow,
    mergedRound: mergedRound
      ? {
          index: mergedRound.index,
          enqueuedAt: mergedRound.enqueuedAt,
          removedAt: mergedRound.removedAt,
          dequeueReason: mergedRound.reason,
          workflowRunId: mergedRun?.id || null,
          mergeGroupHead: mergedRun?.headSha || null,
        }
      : null,
    dequeueCount: mergeQueue?.dequeueCount ?? null,
    deliveryAttempt,
    finalDev,
  };
}

export function missingDeliveryAttempt(authority, reason, workflowRunId) {
  return {
    outcome: 'missing',
    authority,
    reason,
    ...(workflowRunId === undefined ? {} : { workflowRunId }),
  };
}

export async function collectDeliveryAttemptFromArtifacts({
  artifacts,
  expectedSourceSha,
  repository,
  workflowRunId,
  pullSourceSha,
  requiredContexts,
  token,
  githubBytes,
}) {
  const artifact = (artifacts || []).find(
    ({ name, expired }) =>
      !expired &&
      name === `core-affected-native-delivery-attempt-${expectedSourceSha}`,
  );
  if (!artifact) {
    return missingDeliveryAttempt(
      'affected-native-delivery-attempt-artifact',
      'delivery-attempt artifact is missing or expired',
    );
  }
  const archive = await githubBytes(
    `/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    token,
  );
  return {
    ...deliveryAttemptEvidenceFromMembers(
      readZipMembers(archive, ['delivery-attempt.json']),
      {
        repository,
        workflowRunId,
        pullRequestHead: pullSourceSha,
        mergeGroupHead: expectedSourceSha,
        requiredContexts,
      },
    ),
    artifactId: artifact.id,
    artifactName: artifact.name,
  };
}

export function deliveryEvidenceForSample({
  pull,
  sourceSha,
  requiredContexts,
  requiredWindow,
  mergeQueue,
  evidence,
  finalDev,
  latencyOnly,
}) {
  const deliveryAttempt =
    evidence.deliveryAttempt ||
    missingDeliveryAttempt(
      latencyOnly
        ? 'latency-only-collection'
        : 'affected-native-delivery-attempt-artifact',
      latencyOnly
        ? 'delivery attempt skipped in latency-only collection'
        : 'delivery attempt was not returned',
    );
  return reconstructDeliveryEvidence({
    pullRequest: pull.number,
    sourceSha,
    mergeCommitSha: pull.merge_commit_sha,
    requiredContexts,
    requiredWindow,
    mergeQueue,
    deliveryAttempt,
    finalDev,
  });
}

export function deliveryTimelineEvent(sample, rounds, sourceSha) {
  const deliveryAttempt = sample.deliveryEvidence?.deliveryAttempt;
  const attempt = rounds.length
    ? roundAttempt(sample.pullRequest, rounds.at(-1))
    : null;
  if (!attempt || !deliveryAttempt) return null;
  return {
    id: `${attempt.id}:delivery-proof`,
    attempt: {
      ...attempt,
      mergeGroupSha: deliveryAttempt.source?.mergeGroupHead,
      workflowRunId: deliveryAttempt.workflow?.runId,
    },
    phase: 'delivery-proof',
    category: 'proof-evidence',
    status: 'unknown',
    criticalPathEligible: false,
    attributes: {
      sourceSha,
      outcome: sample.deliveryEvidence.outcome,
      proofDecision: deliveryAttempt.proof?.decision || null,
      proofRoot: deliveryAttempt.proof?.proofRoot || null,
      deliveryAttemptRoot: deliveryAttempt.attemptRoot || null,
      deliveryBindingRoot: deliveryAttempt.deliveryBindingRoot || null,
      familyLeaseRoot: deliveryAttempt.family?.leaseRoot || null,
      deliveryClass: deliveryAttempt.family?.deliveryClass || null,
      requiredChecksRoot: deliveryAttempt.requiredChecks?.root || null,
      queueAdmissionRoot: deliveryAttempt.queueAdmission?.root || null,
    },
  };
}

export function summarizeDeliveryEvidence(samples) {
  return {
    authority:
      'family-lease+github-merge-queue+affected-native-proof+github-compare',
    promotionEffect: 'advisory-only',
    ...Object.fromEntries(
      ['proved', 'partial', 'missing', 'invalidated'].map((outcome) => [
        `${outcome}Count`,
        samples.filter(
          ({ deliveryEvidence: evidence }) => evidence?.outcome === outcome,
        ).length,
      ]),
    ),
  };
}

export async function collectFinalDevAncestry({
  merged,
  finalDevHead,
  repository,
  githubJson,
}) {
  const entries = await Promise.all(
    merged.map(async (pull) => {
      if (!pull.merge_commit_sha || !finalDevHead) {
        return [
          pull.number,
          finalDevAncestryFromCompare(
            pull.merge_commit_sha,
            finalDevHead,
            null,
          ),
        ];
      }
      try {
        const comparison = await githubJson(
          `/repos/${repository}/compare/${pull.merge_commit_sha}...${finalDevHead}`,
        );
        return [
          pull.number,
          finalDevAncestryFromCompare(
            pull.merge_commit_sha,
            finalDevHead,
            comparison,
          ),
        ];
      } catch (error) {
        return [
          pull.number,
          {
            outcome: 'unknown',
            authority: 'github-compare',
            reason: error.message,
            mergeCommitSha: pull.merge_commit_sha,
            finalDevHead,
          },
        ];
      }
    }),
  );
  return new Map(entries);
}
