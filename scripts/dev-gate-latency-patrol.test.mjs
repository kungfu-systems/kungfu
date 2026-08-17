// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyLatencyReport,
  classifyMonitorFailure,
} from '../framework/dev-gate-latency-patrol/classify.mjs';
import { captureLatencyFindings } from '../framework/dev-gate-latency-patrol/dogfood-capture.mjs';
import {
  discoverProtectedBranches,
  selectMonitoredBranches,
} from '../framework/dev-gate-latency-patrol/select.mjs';

const ROOT_A = `sha256:${'a'.repeat(64)}`;
const ROOT_B = `sha256:${'b'.repeat(64)}`;

function report(overrides = {}) {
  return {
    schema: 'kungfu.dev-required-latency/v1',
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    collection: { nativeArtifacts: 'required' },
    statistics: {
      all: { sampleCount: 30, p50Ms: 220_000, p95Ms: 280_000 },
      native: { sampleCount: 20, p50Ms: 230_000, p95Ms: 290_000 },
      unknown: { sampleCount: 0 },
    },
    cache: { unknownCount: 0 },
    verdict: { qualified: true },
    mergeQueueDelivery: {
      queueObservedCount: 30,
      statistics: { sampleCount: 30, p50Ms: 240_000, p90Ms: 300_000 },
      incompleteCount: 0,
      notObservedCount: 0,
      runnerEvidenceObservedCount: 30,
      dequeue: { pullRequestCount: 0, rate: 0 },
      repeatedValidationCount: 0,
      unexplainedRepeatedValidationCount: 0,
      runnerWait: { evidenceObservedCount: 30, qualified: true },
      wastedRunnerMs: 0,
      postDequeueRunnerMs: 0,
      verdict: { qualified: true },
    },
    ...overrides,
  };
}

test('selector admits protected v4, v5, and v6 without exact branch binding', () => {
  const plan = selectMonitoredBranches({
    eventName: 'schedule',
    protectedBranches: [
      'dev/v6/v6.1',
      'dev/v3/v3.0',
      'dev/v4/v4.0',
      'release/v5.0',
      'dev/v5/v5.0',
    ],
  });
  assert.deepEqual(plan.branches, [
    'dev/v4/v4.0',
    'dev/v5/v5.0',
    'dev/v6/v6.1',
  ]);
  assert.equal(plan.requiredGate, false);
  assert.equal(plan.issueAdmission, 'prohibited');
});

test('push selection measures only the pushed protected admitted branch', () => {
  const plan = selectMonitoredBranches({
    eventName: 'push',
    refName: 'dev/v6/v6.0',
    refProtected: true,
    protectedBranches: ['dev/v4/v4.0'],
  });
  assert.deepEqual(plan.branches, ['dev/v6/v6.0']);
  assert.throws(
    () =>
      selectMonitoredBranches({
        eventName: 'push',
        refName: 'dev/v3/v3.0',
        refProtected: true,
      }),
    /not a protected admitted/u,
  );
});

test('protected branch discovery paginates through GitHub read API', async () => {
  const seen = [];
  const rows = await discoverProtectedBranches(
    'kungfu-systems/kungfu',
    'token',
    async (url, init) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () =>
          new URL(url).searchParams.get('page') === '1'
            ? Array.from({ length: 100 }, (_, index) => ({
                name: `dev/v4/v4.${index}`,
              }))
            : [{ name: 'dev/v5/v5.0' }],
      };
    },
  );
  assert.equal(rows.length, 101);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer token');
});

test('healthy full rolling window creates no Finding', () => {
  const result = classifyLatencyReport(report(), {
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
  });
  assert.equal(result.outcome, 'healthy');
  assert.equal(result.captureRequired, false);
  assert.deepEqual(result.findingIntents, []);
});

test('required latency and merge delivery regressions classify separately', () => {
  const value = report();
  value.statistics.all.p95Ms = 700_000;
  value.mergeQueueDelivery.statistics.p90Ms = 2_000_000;
  value.mergeQueueDelivery.verdict.qualified = false;
  value.mergeQueueDelivery.dequeue.pullRequestCount = 2;
  value.mergeQueueDelivery.repeatedValidationCount = 3;
  value.mergeQueueDelivery.unexplainedRepeatedValidationCount = 3;
  value.mergeQueueDelivery.wastedRunnerMs = 1000;
  const result = classifyLatencyReport(value, {
    repository: value.repository,
    branch: value.branch,
  });
  assert.deepEqual(result.categories, [
    'merge-queue-delivery-slo',
    'merge-queue-dequeue',
    'merge-queue-revalidation',
    'merge-queue-waste',
    'required-latency-slo',
  ]);
});

test('latency-only monitoring skips cache artifacts without hiding SLO regressions', () => {
  const value = report({
    collection: {
      evidenceMode: 'latency-only',
      nativeArtifacts: 'skipped',
      retainedBaselineEligible: false,
    },
    cache: { unknownCount: 20 },
  });
  const healthy = classifyLatencyReport(value, {
    repository: value.repository,
    branch: value.branch,
  });
  assert.deepEqual(healthy.categories, []);

  value.statistics.native.p95Ms = 700_000;
  const regressed = classifyLatencyReport(value, {
    repository: value.repository,
    branch: value.branch,
  });
  assert.deepEqual(regressed.categories, ['required-latency-slo']);
});

test('unknown and insufficient evidence stay distinct from collector failure', () => {
  const value = report();
  value.statistics.all.sampleCount = 9;
  value.statistics.native.sampleCount = 4;
  value.statistics.unknown.sampleCount = 1;
  value.cache.unknownCount = 1;
  value.mergeQueueDelivery.statistics.sampleCount = 9;
  const incomplete = classifyLatencyReport(value, {
    repository: value.repository,
    branch: value.branch,
  });
  assert.deepEqual(incomplete.categories, [
    'insufficient-evidence',
    'unknown-attribution',
  ]);
  const failed = classifyMonitorFailure({
    repository: value.repository,
    branch: value.branch,
    failureClass: 'collector-exit-1',
  });
  assert.deepEqual(failed.categories, ['monitor-infrastructure']);
});

test('Finding identity is stable for the same branch and anomaly class', () => {
  const first = classifyMonitorFailure({
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v5/v5.0',
    failureClass: 'timeout',
  });
  const second = classifyMonitorFailure({
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v5/v5.0',
    failureClass: 'api-error',
  });
  assert.equal(
    first.findingIntents[0].findingId,
    second.findingIntents[0].findingId,
  );
  assert.equal(first.findingIntents[0].capture.privacy, 'internal');
});

function commandResult(status, value) {
  return {
    status,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: '',
    error: null,
  };
}

test('capture writes Findings, deduplicates, and exposes no Issue path', () => {
  const classification = classifyMonitorFailure({
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    failureClass: 'collector-exit-1',
  });
  const calls = [];
  let present = false;
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'runtime' && args[2] === 'resolve')
      return commandResult(0, {
        schema: 'kungfu.runtime-surface-receipt/v1',
        operationId: 'dogfood.capture',
        runtimeSurface: 'source-checkout',
        selectedProvider: 'source-shifu',
        receiptRoot: ROOT_A,
      });
    if (args[0] === 'runtime' && args[2] === 'verify')
      return commandResult(0, {
        schema: 'kungfu.runtime-surface-verification/v1',
        ok: true,
        operationId: 'dogfood.capture',
        runtimeSurface: 'source-checkout',
        selectedProvider: 'source-shifu',
        receiptRoot: ROOT_A,
      });
    if (args[0] === 'workspace') return commandResult(0, { ok: true });
    if (args[1] === 'doctor') return commandResult(0, { ok: true });
    if (args[1] === 'show') {
      if (!present)
        return commandResult(3, {
          ok: false,
          match_count: 0,
          matches: [],
          lookup_root: ROOT_A,
        });
      return commandResult(0, {
        ok: true,
        match_count: 1,
        matches: [
          {
            kind: 'finding',
            record: {
              finding_id: classification.findingIntents[0].findingId,
              finding_root: ROOT_B,
            },
          },
        ],
        lookup_root: ROOT_A,
      });
    }
    present = true;
    return commandResult(0, {
      status: 'captured',
      finding: {
        finding_id: classification.findingIntents[0].findingId,
        finding_root: ROOT_B,
      },
    });
  };
  const options = {
    run,
    inspectSource: () => ({
      buildInfo: {
        version: '4.0.0-alpha.1',
        git: { revision: '1'.repeat(40), pristine: true },
      },
      buildInfoRoot: ROOT_A,
      shifuPath: '/repo/shifu',
      shifuRoot: ROOT_B,
      head: '1'.repeat(40),
      tree: '2'.repeat(40),
      dirty: false,
      worktree: '/repo',
    }),
    intentDirectory: '/tmp/dev-gate-latency-patrol-intents',
    workspaceRoot: '/tmp/dev-gate-latency-patrol-workspace',
  };
  const first = captureLatencyFindings(classification, options);
  const second = captureLatencyFindings(classification, options);
  assert.equal(first.status, 'captured');
  assert.equal(second.status, 'deduplicated');
  assert.equal(first.issueAdmitted, false);
  assert.equal(
    calls.some((args) => args.includes('admit')),
    false,
  );
  assert.equal(
    calls.some((args) => args.includes('transition')),
    false,
  );
});

test('healthy classification performs no native Dogfood command', () => {
  const healthy = classifyLatencyReport(report(), {
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
  });
  const receipt = captureLatencyFindings(healthy, {
    run: () => assert.fail('no command should run'),
    intentDirectory: '/tmp/unused',
    workspaceRoot: '/tmp/unused',
  });
  assert.equal(receipt.status, 'not-required');
  assert.equal(receipt.issueAdmitted, false);
});

test('source Finding capture rejects a dirty checkout before native capture', () => {
  const classification = classifyMonitorFailure({
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    failureClass: 'collector-exit-1',
  });
  assert.throws(
    () =>
      captureLatencyFindings(classification, {
        run: () =>
          assert.fail('dirty source must fail before Kungfu execution'),
        inspectSource: () => ({
          buildInfo: {
            version: '4.0.0-alpha.1',
            git: { revision: '1'.repeat(40), pristine: true },
          },
          buildInfoRoot: ROOT_A,
          shifuPath: '/repo/shifu',
          shifuRoot: ROOT_B,
          head: '1'.repeat(40),
          tree: '2'.repeat(40),
          dirty: true,
          worktree: '/repo',
        }),
        intentDirectory: '/tmp/dev-gate-latency-patrol-intents-dirty',
        workspaceRoot: '/tmp/dev-gate-latency-patrol-workspace-dirty',
      }),
    /does not match the exact current checkout/,
  );
});

test('pre-bound Finding capture rejects a sha256-shaped root without its receipt', () => {
  const classification = classifyMonitorFailure({
    repository: 'kungfu-systems/kungfu',
    branch: 'dev/v4/v4.0',
    failureClass: 'collector-exit-1',
  });
  classification.findingIntents[0].capture.runtimeSurface = 'source-checkout';
  classification.findingIntents[0].capture.runtimeReceiptRoot = ROOT_A;

  assert.throws(
    () =>
      captureLatencyFindings(classification, {
        run: () => assert.fail('unverified receipt must fail before execution'),
        intentDirectory: '/tmp/dev-gate-latency-patrol-intents-unverified',
        workspaceRoot: '/tmp/dev-gate-latency-patrol-workspace-unverified',
      }),
    /full runtimeReceipt object/,
  );
});
