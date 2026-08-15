// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_THRESHOLD_MINUTES,
  REQUIRED_SELF_HOSTED_LABELS,
  RUNNER_AVAILABILITY_SCHEMA,
  checkWorkspaceHealth,
  controlOverflow,
  decideOverflow,
  normalizeRunnerAvailability,
  observeRunnerAvailability,
  summarizeCandidate,
} from '../.github/actions/require-alpha-preflight/alpha-macos-overflow.mjs';

const queuedSelf = summarizeCandidate({
  route: 'self-hosted',
  run: {
    id: 10,
    status: 'in_progress',
    created_at: '2026-07-30T00:00:00Z',
  },
  jobs: [
    {
      id: 12,
      name: 'build / macOS ARM64 self-hosted primary',
      status: 'queued',
      conclusion: null,
      runner_name: '',
      started_at: '2026-07-30T00:01:00Z',
      completed_at: null,
      labels: ['self-hosted', 'macOS', 'ARM64', 'kungfu-build-v4-macos-arm64'],
    },
  ],
});

test('healthy primary remains preferred inside the 25 minute queue budget', () => {
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      now: Date.parse('2026-07-30T00:20:00Z'),
    }),
    { action: 'wait', reason: 'self-hosted-within-queue-budget' },
  );
  assert.equal(DEFAULT_THRESHOLD_MINUTES, 25);
});

test('observed queue crossing dispatches the hosted candidate', () => {
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      now: Date.parse('2026-07-30T00:26:01Z'),
    }),
    {
      action: 'dispatch-hosted',
      reason: 'observed-queue-exceeds-threshold',
    },
  );
});

test('trusted offline inventory dispatches hosted without waiting for the queue budget', () => {
  const runnerAvailability = normalizeRunnerAvailability({
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: 'offline',
    requiredLabels: REQUIRED_SELF_HOSTED_LABELS,
    matchingRunnerCount: 1,
    onlineRunnerCount: 0,
    busyOnlineRunnerCount: 0,
    observedAt: '2026-07-30T00:00:00Z',
    source: 'github-actions-repository-runners-api',
  });
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      runnerAvailability,
      now: Date.parse('2026-07-30T00:02:00Z'),
    }),
    {
      action: 'dispatch-hosted',
      reason: 'self-hosted-fleet-offline',
    },
  );
});

test('a busy online runner remains online and keeps the queue threshold', () => {
  const runnerAvailability = normalizeRunnerAvailability({
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: 'online',
    requiredLabels: REQUIRED_SELF_HOSTED_LABELS,
    matchingRunnerCount: 1,
    onlineRunnerCount: 1,
    busyOnlineRunnerCount: 1,
    observedAt: '2026-07-30T00:00:00Z',
    source: 'github-actions-repository-runners-api',
  });
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      runnerAvailability,
      now: Date.parse('2026-07-30T00:20:00Z'),
    }),
    { action: 'wait', reason: 'self-hosted-within-queue-budget' },
  );
});

test('unavailable runner inventory fails closed to the queue threshold', () => {
  const runnerAvailability = normalizeRunnerAvailability({
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: 'unavailable',
    reason: 'repository-runner-inventory-unavailable',
  });
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      runnerAvailability,
      now: Date.parse('2026-07-30T00:20:00Z'),
    }),
    { action: 'wait', reason: 'self-hosted-within-queue-budget' },
  );
});

test('runner inventory classifies exact-label offline, online busy, and unavailable states', async () => {
  const observedAt = Date.parse('2026-07-30T00:00:00Z');
  const exactLabels = REQUIRED_SELF_HOSTED_LABELS.map((name) => ({ name }));
  const offline = await observeRunnerAvailability({
    repository: 'kungfu-systems/kungfu',
    client: {
      async runners() {
        return [{ status: 'offline', busy: false, labels: exactLabels }];
      },
    },
    now: () => observedAt,
  });
  assert.equal(offline.status, 'offline');
  assert.equal(offline.matchingRunnerCount, 1);
  assert.equal(offline.onlineRunnerCount, 0);

  const onlineBusy = await observeRunnerAvailability({
    repository: 'kungfu-systems/kungfu',
    client: {
      async runners() {
        return [{ status: 'online', busy: true, labels: exactLabels }];
      },
    },
    now: () => observedAt,
  });
  assert.equal(onlineBusy.status, 'online');
  assert.equal(onlineBusy.busyOnlineRunnerCount, 1);

  const unavailable = await observeRunnerAvailability({
    repository: 'kungfu-systems/kungfu',
  });
  assert.deepEqual(unavailable, {
    schema: RUNNER_AVAILABILITY_SCHEMA,
    status: 'unavailable',
    reason: 'runner-inventory-token-not-projected',
    observedAt: '',
  });
});

test('a dispatched hosted candidate is not duplicated while run visibility lags', () => {
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      hosted: summarizeCandidate({
        route: 'github-hosted',
        run: null,
        jobs: [],
      }),
      hostedDispatched: true,
      runnerAvailability: normalizeRunnerAvailability({
        schema: RUNNER_AVAILABILITY_SCHEMA,
        status: 'offline',
        requiredLabels: REQUIRED_SELF_HOSTED_LABELS,
        matchingRunnerCount: 0,
        onlineRunnerCount: 0,
        busyOnlineRunnerCount: 0,
        observedAt: '2026-07-30T00:00:00Z',
        source: 'github-actions-repository-runners-api',
      }),
    }),
    { action: 'wait', reason: 'hosted-run-not-visible' },
  );
});

test('controller dispatches hosted immediately after self when the trusted fleet is offline', async () => {
  const dispatches = [];
  const client = {
    async dispatch({ route }) {
      dispatches.push(route);
    },
    async findRun({ route }) {
      return route === 'self-hosted'
        ? {
            id: 70,
            status: 'completed',
            conclusion: 'cancelled',
            created_at: '2026-07-30T00:00:00Z',
            updated_at: '2026-07-30T00:00:10Z',
          }
        : {
            id: 80,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-07-30T00:00:01Z',
            updated_at: '2026-07-30T00:01:00Z',
          };
    },
    async jobs(runId) {
      return runId === 70
        ? [
            {
              id: 71,
              name: 'build / macOS ARM64 self-hosted primary',
              status: 'completed',
              conclusion: 'cancelled',
              runner_name: '',
              labels: [
                'self-hosted',
                'macOS',
                'ARM64',
                'kungfu-build-v4-macos-arm64',
              ],
            },
          ]
        : [
            {
              id: 81,
              name: 'build / macOS ARM64 GitHub-hosted overflow',
              status: 'completed',
              conclusion: 'success',
              runner_name: 'GitHub Actions 103',
              labels: ['macos-15'],
              completed_at: '2026-07-30T00:01:00Z',
            },
          ];
    },
    async cancel() {
      throw new Error('terminal self candidate must not be cancelled');
    },
  };
  const output = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-offline-overflow-')),
    'receipt.json',
  );
  const receipt = await controlOverflow({
    repository: 'kungfu-systems/kungfu',
    token: 'fixture-token',
    ref: 'dev/v4/v4.0',
    sourceSha: 'a'.repeat(40),
    preflightRunId: '123',
    requestId: 'offline-fixture',
    runnerAvailability: {
      schema: RUNNER_AVAILABILITY_SCHEMA,
      status: 'offline',
      requiredLabels: REQUIRED_SELF_HOSTED_LABELS,
      matchingRunnerCount: 0,
      onlineRunnerCount: 0,
      busyOnlineRunnerCount: 0,
      observedAt: '2026-07-30T00:00:00Z',
      source: 'github-actions-repository-runners-api',
    },
    out: output,
    client,
    now: () => Date.parse('2026-07-30T00:00:00Z'),
  });
  assert.deepEqual(dispatches, ['self-hosted', 'github-hosted']);
  assert.equal(receipt.decision.fallbackReason, 'self-hosted-fleet-offline');
  assert.equal(receipt.decision.winner, 'github-hosted');
});

test('source-proven predicted remaining queue can dispatch early', () => {
  assert.deepEqual(
    decideOverflow({
      self: queuedSelf,
      now: Date.parse('2026-07-30T00:02:00Z'),
      predictedRemainingQueueMinutes: 31,
      predictionRoot: `sha256:${'a'.repeat(64)}`,
    }),
    {
      action: 'dispatch-hosted',
      reason: 'predicted-remaining-queue-exceeds-threshold',
    },
  );
  assert.equal(
    decideOverflow({
      self: queuedSelf,
      now: Date.parse('2026-07-30T00:02:00Z'),
      predictedRemainingQueueMinutes: 31,
      predictionRoot: '',
    }).action,
    'wait',
  );
});

test('failed self-hosted health-guarded platform dispatches hosted immediately', () => {
  assert.throws(
    () =>
      checkWorkspaceHealth({
        route: 'self-hosted',
        healthMode: 'unhealthy',
      }),
    /retained signing result would conflict/u,
  );
  const unhealthy = summarizeCandidate({
    route: 'self-hosted',
    run: {
      id: 20,
      status: 'completed',
      conclusion: 'failure',
      created_at: '2026-07-30T00:00:00Z',
    },
    jobs: [
      {
        id: 21,
        name: 'build / macOS ARM64 self-hosted primary',
        status: 'completed',
        conclusion: 'failure',
        runner_name: 'mac-primary',
        started_at: '2026-07-30T00:00:05Z',
        completed_at: '2026-07-30T00:00:15Z',
        labels: [
          'self-hosted',
          'macOS',
          'ARM64',
          'kungfu-build-v4-macos-arm64',
        ],
      },
    ],
  });
  assert.deepEqual(decideOverflow({ self: unhealthy }), {
    action: 'dispatch-hosted',
    reason: 'self-hosted-platform-failed',
  });
});

test('queued self is cancelled only after hosted platform acquisition', () => {
  const hostedQueued = summarizeCandidate({
    route: 'github-hosted',
    run: { id: 30, status: 'in_progress' },
    jobs: [
      {
        id: 31,
        name: 'build / macOS ARM64 GitHub-hosted overflow',
        status: 'queued',
        runner_name: '',
        labels: ['macos-15'],
      },
    ],
  });
  assert.equal(
    decideOverflow({ self: queuedSelf, hosted: hostedQueued }).action,
    'wait',
  );

  const hostedAcquired = summarizeCandidate({
    route: 'github-hosted',
    run: { id: 30, status: 'in_progress' },
    jobs: [
      {
        id: 31,
        name: 'build / macOS ARM64 GitHub-hosted overflow',
        status: 'in_progress',
        runner_name: 'GitHub Actions 100',
        labels: ['macos-15'],
      },
    ],
  });
  assert.deepEqual(
    decideOverflow({ self: queuedSelf, hosted: hostedAcquired }),
    {
      action: 'cancel-self',
      reason: 'hosted-acquired-while-self-still-queued',
    },
  );
});

test('a started self-hosted platform is never cancelled by overflow', () => {
  const startedSelf = structuredClone(queuedSelf);
  startedSelf.platformJob.status = 'in_progress';
  startedSelf.platformJob.runner_name = 'mac-primary';
  startedSelf.acquired = true;
  startedSelf.queued = false;
  const hosted = summarizeCandidate({
    route: 'github-hosted',
    run: { id: 40, status: 'in_progress' },
    jobs: [
      {
        id: 41,
        name: 'build / macOS ARM64 GitHub-hosted overflow',
        status: 'in_progress',
        runner_name: 'GitHub Actions 101',
        labels: ['macos-15'],
      },
    ],
  });
  assert.deepEqual(decideOverflow({ self: startedSelf, hosted }), {
    action: 'wait',
    reason: 'candidate-runs-in-progress',
  });
});

test('terminal candidates reconcile to the first successful completion', () => {
  const self = structuredClone(queuedSelf);
  self.run.status = 'completed';
  self.run.conclusion = 'success';
  self.platformJob.status = 'completed';
  self.platformJob.conclusion = 'success';
  self.platformJob.runner_name = 'mac-primary';
  self.platformJob.completed_at = '2026-07-30T01:00:00Z';
  const hosted = summarizeCandidate({
    route: 'github-hosted',
    run: { id: 50, status: 'completed', conclusion: 'success' },
    jobs: [
      {
        id: 51,
        name: 'build / macOS ARM64 GitHub-hosted overflow',
        status: 'completed',
        conclusion: 'success',
        runner_name: 'GitHub Actions 102',
        completed_at: '2026-07-30T00:59:00Z',
        labels: ['macos-15'],
      },
    ],
  });
  assert.deepEqual(decideOverflow({ self, hosted }), {
    action: 'reconcile',
    reason: 'candidate-runs-terminal',
    winner: 'github-hosted',
  });
});

test('workflow contract keeps candidates exact-source, independent, and publish-none', () => {
  const workflow = fs.readFileSync('.github/workflows/build.yml', 'utf8');
  const affectedNativeWorkflow = fs.readFileSync(
    '.github/workflows/affected-native-pr.yml',
    'utf8',
  );
  const preflightAction = fs.readFileSync(
    '.github/actions/require-alpha-preflight/action.yml',
    'utf8',
  );
  assert.match(
    workflow,
    /format\('alpha-macos-candidate-\{0\}-\{1\}', fromJSON\(inputs\.macos-overflow-request-json\)\.requestId, fromJSON\(inputs\.macos-overflow-request-json\)\.mode\)/u,
  );
  assert.match(
    workflow,
    /permissions:[\s\S]*actions: write[\s\S]*contents: read/u,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.sourceSha/u,
  );
  assert.match(preflightAction, /--request-json "\$REQUEST_JSON"/u);
  assert.match(
    preflightAction,
    /RUNNER_INVENTORY_TOKEN: \$\{\{ inputs\.runner-inventory-token \}\}/u,
  );
  assert.match(
    workflow,
    /runner-inventory-token: \$\{\{ github\.event_name == 'workflow_dispatch' && fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.mode == 'control' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\) && secrets\.KUNGFU_GITHUB_TOKEN \|\| '' \}\}/u,
  );
  assert.match(
    workflow,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@v3-alpha/u,
  );
  assert.match(
    workflow,
    /^\s+buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3-alpha' \}\}$/mu,
  );
  assert.match(
    affectedNativeWorkflow,
    /source_acceptance:[\s\S]*uses: kungfu-systems\/buildchain\/\.github\/workflows\/check\.yml@fb0ad6d84f10a1f9b872a799e035232d82558bd0[\s\S]*buildchain-ref: fb0ad6d84f10a1f9b872a799e035232d82558bd0[\s\S]*source-proof-reuse: true[\s\S]*source-proof-policy-paths-json: '\["\.github\/workflows\/affected-native-pr\.yml"\]'[\s\S]*source-proof-closure-paths-json: '\["\.buildchain\/buildchain\.toml","shifu","scripts\/source-acceptance\.mjs","scripts\/require-shifu\.mjs"\]'[\s\S]*source-proof-dependency-paths-json: '\["package\.json","pnpm-lock\.yaml"\]'[\s\S]*source-proof-required-contexts-json: '\["Candidate source acceptance \/ check"\]'/u,
  );
  assert.match(
    affectedNativeWorkflow,
    /uses: kungfu-systems\/buildchain\/actions\/validate-config@58e48d73ae7fef0dd06ae02baf6d090e4da5487d/u,
  );
  assert.doesNotMatch(
    affectedNativeWorkflow,
    /kungfu-systems\/buildchain\/(?:\.github\/workflows\/check\.yml|actions\/validate-config)@v3/u,
  );
  const signing = fs.readFileSync('.buildchain/buildchain.toml', 'utf8');
  assert.match(
    signing,
    /id = "kungfu-cli-macos-arm64"[\s\S]*profile = "auto"[\s\S]*platforms = \["macos-arm64"\][\s\S]*required = true/u,
  );
  assert.match(
    signing,
    /id = "kungfu-cli-macos-arm64"[\s\S]*entitlements_profile = "jit-executable-v1"[\s\S]*entitlements_paths = \[[\s\S]*"kungfu-episodes-cli-darwin-arm64\/runtime\/kungfu"[\s\S]*"kungfu-episodes-cli-darwin-arm64\/runtime\/python\/bin\/python3"[\s\S]*"kungfu-episodes-cli-darwin-arm64\/runtime\/python\/bin\/python3\.13"[\s\S]*\]/u,
  );
  assert.match(
    signing,
    /\[lifecycle\.signing-finalization\][\s\S]*command = "node product\/scripts\/verify-cli-surface-qualification\.mjs[^\n]+ && node product\/scripts\/upgrade-manifest\.mjs finalize-macos-release-artifacts"/u,
  );
  assert.match(workflow, /checkout-history-mode: full/u);
  assert.match(
    workflow,
    /checkout-cache-mode: \$\{\{ fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.mode == 'self-hosted' && 'auto' \|\| \(inputs\.platforms-json && 'auto' \|\| 'off'\) \}\}/u,
  );
  for (const input of [
    'cargo-registry-index',
    'checkout-cache-mirror-url-template',
    'checkout-cache-reference-repository-template',
  ]) {
    assert.match(
      workflow,
      new RegExp(
        `${input}: \\$\\{\\{ \\(fromJSON\\(inputs\\.macos-overflow-request-json \\|\\| '\\{\\}'\\)\\.mode == 'self-hosted' \\|\\| inputs\\.platforms-json\\) && vars\\.`,
        'u',
      ),
    );
  }
  assert.match(workflow, /self-hosted-offline-fallback: false/u);
  for (const runner of [
    String.raw`runner":"[\"ubuntu-24.04\"]"`,
    String.raw`runner":"[\"ubuntu-24.04-arm\"]"`,
    String.raw`runner":"[\"macos-15\"]"`,
    String.raw`runner":"[\"windows-2022\"]"`,
  ])
    assert.ok(workflow.includes(runner), runner);
  assert.match(workflow, /release-candidate: true/u);
  assert.match(
    workflow,
    /publish-channel: \$\{\{ \(fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.mode == 'self-hosted'/u,
  );
  assert.doesNotMatch(workflow, /credential-island-macos-app-path:/u);
  assert.doesNotMatch(workflow, /credential-island-caller-owned:/u);
  assert.doesNotMatch(workflow, /credential-island-macos-platform-id:/u);
  assert.match(
    workflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/u,
  );
  assert.doesNotMatch(workflow, /^ {2}credential-island-macos:$/mu);
});
