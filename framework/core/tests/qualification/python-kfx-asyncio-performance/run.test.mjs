// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  commandInvocation,
  deriveStatistics,
  evaluateReport,
  loadProfile,
  parseObservationStream,
  qualificationPlan,
  validateCoverage,
  validateReport,
} from './run.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

function source(dirty = false) {
  return { revision: '1'.repeat(40), tree: '2'.repeat(40), dirty };
}

function suite(status = 'passed') {
  return {
    command: ['./shifu', 'fixture'],
    status,
    exit_code: status === 'planned' ? null : status === 'passed' ? 0 : 1,
    duration_ms: status === 'planned' ? 0 : 1,
    raw_log: status === 'planned' ? null : 'fixture.log',
    raw_sha256: status === 'planned' ? null : 'a'.repeat(64),
  };
}

function record(overrides = {}) {
  return {
    schema: 'kungfu.python-kfx-asyncio.performance-observation/v1',
    workload: 'raw-asyncio-scheduling',
    case: 'one-yield',
    repetition: 0,
    concurrency: 1,
    payload_bytes: 64,
    operations: 16,
    elapsed_ns: 1000,
    throughput_ops_per_second: 16_000_000,
    p50_microseconds: 1,
    p95_microseconds: 2,
    p99_microseconds: 3,
    cpu_seconds: 0.001,
    peak_rss_bytes: 1024,
    shutdown_milliseconds: 0,
    cancelled_operations: 0,
    error_operations: 0,
    backpressure_peak_inflight: 1,
    status: 'passed',
    ...overrides,
  };
}

test('frozen profile covers the exact matrix and explicit claim boundary', () => {
  const loaded = loadProfile();
  assert.deepEqual(loaded.profile.matrix.concurrency, [1, 8, 64]);
  assert.deepEqual(loaded.profile.matrix.payload_bytes, [64, 1024, 65536]);
  assert.deepEqual(
    loaded.profile.platforms.map(({ os, arch }) => `${os}/${arch}`),
    ['darwin/arm64', 'linux/x64', 'win32/x64'],
  );
  assert.match(loaded.profile.claim_boundary.unqualified, /journal/u);
  assert.match(loaded.profile.evidence_policy.outliers, /never delete/u);
});

test('plan builds and proves correctness before invoking the scored workload', () => {
  const plan = qualificationPlan(loadProfile());
  assert.deepEqual(plan.setup.slice(1), ['build:core']);
  assert.deepEqual(plan.correctness.slice(1), ['test:native-kfx-admission']);
  assert.ok(plan.workload.some((item) => item.endsWith('workload.py')));
  assert.equal(plan.workload.includes('--quick'), false);
});

test('Windows invokes Shifu through ComSpec without weakening argument boundaries', () => {
  const invocation = commandInvocation(
    ['shifu.cmd', 'exec', 'argument with spaces'],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /"argument with spaces"/u);
});

test('manual Gate Measurement retains exact-source evidence on all three supported lanes', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'gate-measurement.yml'),
    'utf8',
  );
  assert.match(workflow, /python-kfx-asyncio-performance:/u);
  for (const label of [
    'kungfu-build-v4-linux-x64',
    'kungfu-build-v4-macos-arm64',
    'kungfu-build-v4-windows-x64',
  ]) {
    assert.match(workflow, new RegExp(label, 'u'));
  }
  assert.match(workflow, /python-kfx-asyncio:qualify -- --execute --output/u);
  assert.match(workflow, /raw observations and derived report/u);
  assert.doesNotMatch(workflow.split('jobs:')[0], /pull_request:/u);
});

test('raw parser keeps every observation and rejects failure records', () => {
  const manifest = {
    schema: 'kungfu.python-kfx-asyncio.performance-manifest/v1',
    python: '3.13.7',
    implementation: 'CPython',
    platform: 'darwin',
    machine: 'arm64',
    quick: false,
  };
  const parsed = parseObservationStream(
    `${JSON.stringify(record())}\n${JSON.stringify(record({ repetition: 1 }))}\n${JSON.stringify(manifest)}\n`,
  );
  assert.equal(parsed.observations.length, 2);
  assert.throws(
    () =>
      parseObservationStream(
        `${JSON.stringify({ schema: 'kungfu.python-kfx-asyncio.performance-failure/v1', error: 'boom' })}\n`,
      ),
    /workload failed/u,
  );
});

test('statistics retain tails, errors, cancellations, backpressure, and resources', () => {
  const statistics = deriveStatistics([
    record({ p99_microseconds: 10, cancelled_operations: 2 }),
    record({
      repetition: 1,
      p99_microseconds: 20,
      error_operations: 1,
      backpressure_peak_inflight: 8,
    }),
  ]);
  assert.equal(statistics[0].p99_microseconds_median, 15);
  assert.equal(statistics[0].cancelled_operations_total, 2);
  assert.equal(statistics[0].error_operations_total, 1);
  assert.equal(statistics[0].backpressure_peak_inflight_max, 8);
  assert.equal(statistics[0].peak_rss_bytes_max, 1024);
});

test('frozen matrix coverage rejects missing and duplicate scored repetitions', () => {
  const loaded = loadProfile();
  const observations = [];
  for (const concurrency of [1, 8]) {
    for (const caseName of [
      'one-yield',
      'future-handoff',
      'cancel-timeout-error',
    ]) {
      observations.push(record({ case: caseName, concurrency, repetition: 0 }));
    }
    for (const payload of [64, 1024]) {
      observations.push(
        record({
          workload: 'async-capability-relay',
          case: 'round-trip',
          concurrency,
          payload_bytes: payload,
          repetition: 0,
        }),
      );
    }
  }
  observations.push(
    record({
      workload: 'journal-asyncio-bridge',
      case: 'journal-callback-and-empty-pump',
    }),
    record({
      workload: 'python-service-process-lifecycle',
      case: 'cold-launch-relay-and-graceful-shutdown',
      shutdown_milliseconds: 1,
    }),
    record({
      workload: 'bounded-relay-soak',
      case: 'relay-1024b-concurrency-8',
      concurrency: 8,
      payload_bytes: 1024,
    }),
  );
  validateCoverage(observations, loaded.profile, { quick: true });
  assert.throws(
    () =>
      validateCoverage(observations.slice(1), loaded.profile, { quick: true }),
    /count 0 does not match 1/u,
  );
  assert.throws(
    () =>
      validateCoverage([...observations, observations[0]], loaded.profile, {
        quick: true,
      }),
    /count 2 does not match 1/u,
  );
});

test('dirty and quick evidence fail closed while dry-run makes no claim', () => {
  const loaded = loadProfile();
  const base = {
    runId: 'fixture',
    loaded,
    setup: suite(),
    correctness: suite(),
    observations: [record()],
    rawPath: 'raw-observations.jsonl',
    rawSha256: 'b'.repeat(64),
    manifest: { python: '3.13.7', implementation: 'CPython' },
  };
  const dirty = evaluateReport({
    ...base,
    mode: 'execute',
    source: source(true),
  });
  assert.equal(dirty.verdict, 'unqualified');
  assert.equal(dirty.claims.service_plane_envelope_qualified, false);
  const quick = evaluateReport({
    ...base,
    mode: 'execute',
    source: source(),
    quick: true,
  });
  assert.equal(quick.verdict, 'unqualified');
  const planned = evaluateReport({
    ...base,
    mode: 'dry-run',
    source: source(),
    setup: suite('planned'),
    correctness: suite('planned'),
    observations: [],
  });
  validateReport(planned);
  assert.equal(planned.verdict, 'planned');
  assert.equal(planned.claims.service_plane_envelope_qualified, false);
});
