// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  DEFAULT_THRESHOLD_MINUTES,
  checkWorkspaceHealth,
  decideOverflow,
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
  assert.match(workflow, /release-candidate: true/u);
  assert.match(
    workflow,
    /publish-channel: \$\{\{ \(fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.mode == 'self-hosted'/u,
  );
  assert.match(
    workflow,
    /credential-island-macos-app-path: \$\{\{ \(fromJSON\(inputs\.macos-overflow-request-json \|\| '\{\}'\)\.mode != 'self-hosted'/u,
  );
});
