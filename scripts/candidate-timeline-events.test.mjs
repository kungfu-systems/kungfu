// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { digest as proofDigest } from './affected-native-proof.mjs';
import {
  deliveryAttemptEvidenceFromMembers,
  finalDevAncestryFromCompare,
  reconstructDeliveryEvidence,
} from './cancel-dequeued-merge-group-runs.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  findOperationalExactBindings,
  isAdmittedDevBranch,
  latencyOnlyEvidence,
  measureCandidateStage,
  measureCandidateStageSync,
  parseDevRequiredLatencyArgs,
  readDevChannelContract,
  resolveDevBranch,
  selectLatencyCohort,
} = require('./candidate-timeline-events.cjs');

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-candidate-events-'),
  );
  return {
    root,
    output: path.join(root, 'events.jsonl'),
    env: {
      KUNGFU_CANDIDATE_TIMELINE_EVENTS: path.join(root, 'events.jsonl'),
      KUNGFU_CANDIDATE_GATE_ID: 'source.changed-scope',
      KUNGFU_AFFECTED_NATIVE_PARTITION_INDEX: '0',
      GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_RUN_ID: '42',
      GITHUB_SHA: 'a'.repeat(40),
    },
  };
}

function events(value) {
  return fs
    .readFileSync(value.output, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('dev channel authority admits current and future lines but rejects legacy lines', () => {
  const contract = readDevChannelContract();
  assert.equal(isAdmittedDevBranch(`dev/v${4}/v${4}.0`, contract), true);
  assert.equal(isAdmittedDevBranch(`dev/v${10}/v${10}.2`, contract), true);
  assert.equal(isAdmittedDevBranch(`dev/v${3}/v${3}.2`, contract), false);
  assert.equal(
    resolveDevBranch({
      contract,
      env: { GITHUB_BASE_REF: `dev/v${6}/v${6}.1` },
      symbolicRemoteHead: () => '',
    }),
    `dev/v${6}/v${6}.1`,
  );
  assert.equal(
    resolveDevBranch({
      contract,
      env: {},
      symbolicRemoteHead: () => `refs/remotes/origin/dev/v${5}/v${5}.0`,
    }),
    `dev/v${5}/v${5}.0`,
  );
  assert.throws(
    () =>
      resolveDevBranch({
        contract,
        env: { KUNGFU_DEV_BRANCH: `dev/v${3}/v${3}.2` },
        symbolicRemoteHead: () => '',
      }),
    /cannot resolve the admitted dev branch/u,
  );
});

test('cohort start excludes samples whose first queue admission predates activation', () => {
  const mergeQueue = (firstEnqueuedAt) => ({
    firstEnqueuedAt,
    queueStatus: 'observed',
  });
  const records = [
    {
      pullRequest: 1,
      requiredWindow: { startedAt: '2026-07-28T10:35:00Z' },
      mergeQueue: mergeQueue('2026-07-28T10:35:00Z'),
    },
    {
      pullRequest: 2,
      mergedAt: '2026-07-28T10:52:00Z',
      requiredWindow: { startedAt: '2026-07-28T10:42:00Z' },
      mergeQueue: mergeQueue('2026-07-28T10:42:00Z'),
    },
    {
      pullRequest: 3,
      requiredWindow: { startedAt: '2026-07-28T10:50:00Z' },
      mergeQueue: mergeQueue('2026-07-28T10:50:00Z'),
    },
    {
      pullRequest: 4,
      mergeQueue: { queueStatus: 'unknown' },
    },
  ];
  const value = selectLatencyCohort(
    records,
    records,
    '2026-07-28T10:47:22.936Z',
  );

  assert.equal(value.collection.cohortStart, '2026-07-28T10:47:22.936Z');
  assert.deepEqual(
    value.records.map(({ pullRequest, excluded, exclusionReason }) => ({
      pullRequest,
      excluded,
      exclusionReason,
    })),
    [
      {
        pullRequest: 1,
        excluded: true,
        exclusionReason: 'before-cohort-start',
      },
      {
        pullRequest: 2,
        excluded: true,
        exclusionReason: 'before-cohort-start',
      },
      { pullRequest: 3, excluded: undefined, exclusionReason: undefined },
      {
        pullRequest: 4,
        excluded: true,
        exclusionReason: 'cohort-start-unprovable',
      },
    ],
  );
  assert.deepEqual(
    value.mergeQueueRecords.map(({ pullRequest }) => pullRequest),
    [3],
  );
});

test('cohort start CLI requires an RFC3339 timestamp with timezone', () => {
  assert.equal(
    parseDevRequiredLatencyArgs(['--cohort-start', '2026-07-28T10:47:22.936Z'])
      .cohortStart,
    '2026-07-28T10:47:22.936Z',
  );
  assert.throws(
    () =>
      parseDevRequiredLatencyArgs(['--cohort-start', '2026-07-28 10:47:22']),
    /RFC3339 timestamp with timezone/,
  );
  assert.throws(
    () => parseDevRequiredLatencyArgs(['--cohort-start']),
    /requires a value/,
  );
});

test('dev channel authority reports operational exact branch bindings', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-dev-channel-authority-'),
  );
  try {
    const workflow = path.join(temporary, '.github', 'workflows');
    fs.mkdirSync(workflow, { recursive: true });
    fs.writeFileSync(
      path.join(workflow, 'bad.yml'),
      `base: dev/v${9}/v${9}.0\n`,
    );
    assert.deepEqual(findOperationalExactBindings(temporary), [
      {
        path: '.github/workflows/bad.yml',
        branch: `dev/v${9}/v${9}.0`,
      },
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('candidate stage records bounded source and attempt correlation', () => {
  const value = fixture();
  try {
    assert.equal(
      measureCandidateStageSync('core-build', 'core-build', () => 7, {
        env: value.env,
      }),
      7,
    );
    const [event] = events(value);
    assert.equal(event.attempt.id, 'merge_group-42');
    assert.equal(event.attempt.mergeGroupSha, 'a'.repeat(40));
    assert.equal(event.gate.partition, '0');
    assert.equal(event.status, 'success');
    assert.equal(event.timing.clock, 'monotonic-duration+wall-envelope');
    assert.equal(event.timing.precisionMs, 1);
    assert.deepEqual(Object.keys(event.attributes).sort(), [
      'laneId',
      'sourceSha',
      'stage',
    ]);
    assert.equal(event.attributes.laneId, 'affected-native/partition-0');
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('candidate stage records failure and rethrows', async () => {
  const value = fixture();
  try {
    await assert.rejects(
      measureCandidateStage(
        'wire-rust',
        'sdk-wire-rust',
        async () => {
          throw new Error('fixture failure');
        },
        { env: value.env, language: 'rust' },
      ),
      /fixture failure/,
    );
    const [event] = events(value);
    assert.equal(event.status, 'failure');
    assert.equal(event.attributes.language, 'rust');
    assert.equal(JSON.stringify(event).includes('fixture failure'), false);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('candidate stage instrumentation has bounded local overhead and output', () => {
  const value = fixture();
  const withoutSink = { ...value.env };
  withoutSink.KUNGFU_CANDIDATE_TIMELINE_EVENTS = undefined;
  const noSinkStarted = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    measureCandidateStageSync(`no-sink-${index}`, 'overhead-probe', () => {}, {
      env: withoutSink,
    });
  }
  const noSinkDurationMs = performance.now() - noSinkStarted;

  try {
    const sinkStarted = performance.now();
    for (let index = 0; index < 25; index += 1) {
      measureCandidateStageSync(`sink-${index}`, 'overhead-probe', () => {}, {
        env: value.env,
      });
    }
    const sinkDurationMs = performance.now() - sinkStarted;
    assert.ok(noSinkDurationMs < 1_000, `no-sink=${noSinkDurationMs}ms`);
    assert.ok(sinkDurationMs < 1_000, `sink=${sinkDurationMs}ms`);
    assert.ok(fs.statSync(value.output).size < 32 * 1_024);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test('latency-only is explicit and skips native artifacts', () => {
  assert.deepEqual(
    [
      parseDevRequiredLatencyArgs([]).latencyOnly,
      parseDevRequiredLatencyArgs(['--latency-only']).latencyOnly,
    ],
    [false, true],
  );
  const evidence = latencyOnlyEvidence({ kind: 'native' }, 42);
  assert.equal(evidence.cache.outcome, 'unknown');
  assert.equal(evidence.native.outcome, 'unknown');
  assert.equal(evidence.native.workflowRunId, 42);
});

test('latency-only reports cannot qualify or update the baseline', async () => {
  const { report } = await import('./measure-dev-required-latency.mjs');
  const record = {
    excluded: false,
    sourceSha: 'a'.repeat(40),
    durationMs: 120000,
    classification: { kind: 'native' },
    cache: latencyOnlyEvidence({ kind: 'native' }).cache,
  };
  const records = Array(20).fill(record);
  const value = report('owner/repo', 'dev', ['required'], records, records, {
    latencyOnly: true,
  });
  assert.equal(value.collection.retainedBaselineEligible, false);
  assert.equal(value.verdict.qualified, false);
});

function deliveryAttempt(overrides = {}) {
  const pullRequestHead = 'a'.repeat(40);
  const mergeGroupHead = 'b'.repeat(40);
  const contexts = ['affected-native / linux', 'required'];
  const body = {
    schema: 'kungfu.affected-native-delivery-attempt/v1',
    deliveryBindingRoot: `sha256:${'0'.repeat(64)}`,
    source: {
      pullRequest: 1262,
      pullRequestHead,
      devHead: 'c'.repeat(40),
      replayedCandidate: mergeGroupHead,
      replayedTree: 'e'.repeat(40),
      mergeGroupHead,
      checkout: mergeGroupHead,
    },
    family: {
      initiativeId: 'go-family-native-state-contract',
      assignmentId: 'go-family-proof-evidence-binding',
      deliveryClass: 'native-proof-required',
      queueAttempt: 'attempt-one',
      leaseRoot: `sha256:${'1'.repeat(64)}`,
      admissionProofRoot: `sha256:${'2'.repeat(64)}`,
      admissionProofRoots: [`sha256:${'2'.repeat(64)}`],
      statusContext: 'project-cut / family-go-family-native-state-contract',
    },
    requiredChecks: {
      contexts,
      root: proofDigest({ contexts }),
    },
    queueAdmission: {
      context: 'project-cut / queue-admission',
      state: 'success',
      familyLeaseState: 'pending',
      root: `sha256:${'3'.repeat(64)}`,
    },
    proof: {
      decision: 'reused',
      proofId: '4'.repeat(64),
      proofRoot: `sha256:${'5'.repeat(64)}`,
      producer: {
        repository: 'kungfu-systems/kungfu',
        runId: 41,
        event: 'pull_request',
        workflowPath: '.github/workflows/affected-native-pr.yml',
        triggerHeadSha: pullRequestHead,
        checkoutSha: pullRequestHead,
        createdAt: '2026-07-28T00:00:00Z',
      },
    },
    workflow: {
      repository: 'kungfu-systems/kungfu',
      runId: 42,
      event: 'merge_group',
      workflowPath: '.github/workflows/affected-native-pr.yml',
      runner: {
        environment: 'github-hosted',
        os: 'Linux',
        arch: 'X64',
      },
    },
    ...overrides,
  };
  return { ...body, attemptRoot: proofDigest(body) };
}

test('delivery evidence reconstructs one exact family queue attempt through final dev', () => {
  const attemptEvidence = deliveryAttemptEvidenceFromMembers(
    { 'delivery-attempt.json': JSON.stringify(deliveryAttempt()) },
    {
      repository: 'kungfu-systems/kungfu',
      workflowRunId: 42,
      pullRequestHead: 'a'.repeat(40),
      mergeGroupHead: 'b'.repeat(40),
      requiredContexts: ['required', 'affected-native / linux'],
    },
  );
  assert.equal(attemptEvidence.outcome, 'proved');
  assert.equal(attemptEvidence.proof.decision, 'reused');

  const finalDev = finalDevAncestryFromCompare('f'.repeat(40), '9'.repeat(40), {
    status: 'ahead',
    merge_base_commit: { sha: 'f'.repeat(40) },
  });
  assert.equal(finalDev.outcome, 'proved');

  const mergeQueue = {
    queueStatus: 'observed',
    status: 'observed',
    runnerEvidenceComplete: true,
    dequeueCount: 1,
    repeatedValidationCount: 1,
    wastedRunnerMs: 60_000,
    postDequeueRunnerMs: 0,
    rounds: [
      {
        index: 0,
        reason: 'failed_checks',
        mergeGroupRuns: [],
      },
      {
        index: 1,
        enqueuedAt: '2026-07-28T00:00:00Z',
        removedAt: '2026-07-28T00:10:00Z',
        reason: 'merged',
        mergeGroupRuns: [
          {
            id: 42,
            headSha: 'b'.repeat(40),
            jobs: [
              {
                startedAt: '2026-07-28T00:01:00Z',
                completedAt: '2026-07-28T00:02:00Z',
              },
            ],
          },
        ],
      },
    ],
  };
  const requiredWindow = {
    status: 'observed',
    contexts: [{ context: 'affected-native / linux' }, { context: 'required' }],
  };
  const common = {
    pullRequest: 1262,
    sourceSha: 'a'.repeat(40),
    mergeCommitSha: 'f'.repeat(40),
    requiredContexts: ['affected-native / linux', 'required'],
    requiredWindow,
    mergeQueue,
    deliveryAttempt: attemptEvidence,
    finalDev,
  };
  const proved = reconstructDeliveryEvidence(common);
  assert.equal(proved.outcome, 'proved');
  assert.equal(proved.dequeueCount, 1);
  assert.equal(proved.queue.repeatedValidationCount, 1);
  assert.equal(
    proved.queue.rounds[1].mergeGroupRuns[0].runnerUse.runnerMs,
    60_000,
  );
  assert.equal(proved.mergedRound.workflowRunId, 42);
  assert.equal(
    proved.deliveryAttempt.family.deliveryClass,
    'native-proof-required',
  );
  assert.equal(
    reconstructDeliveryEvidence({
      ...common,
      mergeQueue: { ...mergeQueue, runnerEvidenceComplete: false },
    }).outcome,
    'partial',
  );
});

test('delivery evidence invalidates source drift and distinguishes missing history', () => {
  const invalid = deliveryAttemptEvidenceFromMembers(
    { 'delivery-attempt.json': JSON.stringify(deliveryAttempt()) },
    {
      repository: 'kungfu-systems/kungfu',
      workflowRunId: 42,
      pullRequestHead: '8'.repeat(40),
      mergeGroupHead: 'b'.repeat(40),
      requiredContexts: ['affected-native / linux', 'required'],
    },
  );
  assert.equal(invalid.outcome, 'invalidated');
  assert.deepEqual(invalid.disagreements, ['pull-request-head']);
  assert.equal(
    finalDevAncestryFromCompare('f'.repeat(40), '9'.repeat(40), {
      status: 'diverged',
      merge_base_commit: { sha: '7'.repeat(40) },
    }).outcome,
    'invalidated',
  );
  assert.equal(
    reconstructDeliveryEvidence({
      pullRequest: 1,
      sourceSha: 'a'.repeat(40),
      mergeCommitSha: null,
      requiredContexts: [],
      requiredWindow: {},
      mergeQueue: { queueStatus: 'not-observed', rounds: [] },
      deliveryAttempt: {
        outcome: 'missing',
        reason: 'historical artifact absent',
      },
      finalDev: { outcome: 'unknown' },
    }).outcome,
    'missing',
  );
});

test('delivery workflows preserve exact attempt and cache-promotion bindings', () => {
  const affectedNative = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-pr.yml'),
    'utf8',
  );
  assert.match(
    affectedNative,
    /Capture exact family delivery binding[\s\S]*rules\/branches\/\$encoded_branch[\s\S]*bind-delivery/,
  );
  assert.match(affectedNative, /--delivery-binding/);
  assert.match(
    affectedNative,
    /Seal reconstructable family delivery attempt[\s\S]*seal-attempt/,
  );
  assert.match(
    affectedNative,
    /Seal reconstructable family delivery attempt[\s\S]*--dev-delta-plan "\$admission\/proof-admission\/dev-delta-plan\.json"/,
  );
  const proofRuntime = fs.readFileSync(
    path.join(ROOT, 'scripts/affected-native-proof.mjs'),
    'utf8',
  );
  assert.match(proofRuntime, /options\['dev-delta-plan'\][\s\S]*deltaPlan:/);
  assert.match(
    affectedNative,
    /core-affected-native-delivery-attempt-\$\{\{ github\.sha \}\}/,
  );

  const dequeue = fs.readFileSync(
    path.join(ROOT, '.github/workflows/cancel-dequeued-merge-group.yml'),
    'utf8',
  );
  assert.match(dequeue, /DEQUEUE_EVIDENCE_OUTPUT:/);
  assert.match(dequeue, /Upload exact dequeue settlement evidence/);

  const cachePromotion = fs.readFileSync(
    path.join(ROOT, '.github/workflows/affected-native-cache-promote.yml'),
    'utf8',
  );
  assert.match(cachePromotion, /verify-attempt/);
  assert.match(cachePromotion, /--delivery-attempt-root/);
  assert.match(cachePromotion, /--delivery-binding-root/);
});
