// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  evaluateReport,
  evaluateWorkload,
  loadSloProfile,
  qualificationPlan,
} from './run-durability-slo.mjs';

const loaded = loadSloProfile();
const plan = qualificationPlan({
  loaded,
  runId: 'agent120-test-v1',
  sourceRevision: 'a'.repeat(40),
});

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

function fixture(workload) {
  const completed =
    workload.records || workload.target_rate * workload.duration_seconds;
  const histogram = {
    schema: 'kungfu.durability.slo-histogram/v1',
    count: completed,
    mean_ns: 1000,
    p50_ns: 1000,
    p95_ns: 1000,
    p99_ns: 1000,
    p999_ns: 1000,
    max_ns: 1000,
    buckets: [{ upper_bound_ns: 1024, count: completed }],
  };
  return {
    schema: 'kungfu.durability.slo-fixture-result/v1',
    profile: workload.durability_profile,
    qualification_profile: 'candidate/linux-ext4-agent120-slo-v1',
    workload: { records_completed: completed },
    correctness: { passed: true, violations: [] },
    metrics: {
      records_per_second: 10000,
      candidate_append_latency: histogram,
      durability_receipt_latency: histogram,
      recovery_ns: 1000,
      projection_rebuild_ns: 1000,
      projection_bootstrap_ns: 1000,
      backup_ns: 1000,
      restore_ns: 1000,
      fixture_bytes: 1000,
      resources: { max_rss_kib: 1000 },
    },
    claims: { production_eligible: false },
  };
}

test('profile freezes both profiles, rollover, throughput, and two 15-minute soaks', () => {
  assert.equal(loaded.profile.workloads.length, 8);
  assert.deepEqual(
    new Set(loaded.profile.workloads.map((value) => value.durability_profile)),
    new Set(['durable_group', 'durable_sync']),
  );
  assert.equal(
    loaded.profile.workloads.filter((value) => value.duration_seconds === 900)
      .length,
    2,
  );
  assert.ok(
    loaded.profile.workloads.some((value) => value.segment_bytes === 65536),
  );
  assert.equal(loaded.profile.claims.production_eligible, false);
  assert.equal(loaded.profile.claims.comparator_used, false);
});

test('dry-run plan is project-local and cannot dispatch GitHub CI', () => {
  assert.equal(plan.mode, 'dry-run');
  assert.match(
    portablePath(plan.workspace),
    /framework\/core\/build\/qualification/u,
  );
  assert.equal(plan.safety.github_workflow, false);
  assert.equal(plan.safety.self_hosted_runner_dispatch, false);
  assert.equal(plan.safety.host_restart, false);
  assert.ok(
    plan.workloads.every((value) =>
      value.command[0].endsWith('kungfu_durability_slo_fixture'),
    ),
  );
  assert.doesNotMatch(JSON.stringify(plan), /workflow_dispatch|gh workflow/iu);
});

test('correctness is a knockout and absolute ceilings do not move', () => {
  const workload = loaded.profile.workloads[0];
  const passing = fixture(workload);
  assert.deepEqual(
    evaluateWorkload(workload, passing, loaded.profile.global_thresholds),
    [],
  );
  passing.correctness.passed = false;
  assert.match(
    evaluateWorkload(workload, passing, loaded.profile.global_thresholds).join(
      '\n',
    ),
    /correctness knockout/u,
  );
  passing.correctness.passed = true;
  passing.metrics.records_per_second = 0;
  assert.match(
    evaluateWorkload(workload, passing, loaded.profile.global_thresholds).join(
      '\n',
    ),
    /below/u,
  );
});

test('aggregate report passes only the exact named host and NVMe/ext4 envelope', () => {
  const results = loaded.profile.workloads.map((workload) => ({
    id: workload.id,
    status: 'passed',
    fixture: fixture(workload),
    violations: [],
  }));
  const passing = evaluateReport({
    loaded,
    plan,
    host: {
      hostname: 'agent-120',
      filesystem: 'ext4',
      device_source: '/dev/nvme0n1p2',
    },
    results,
    rawSha256: 'b'.repeat(64),
  });
  assert.equal(passing.verdict, 'passed-candidate-slo');
  assert.equal(passing.claims.production_eligible, false);
  const wrongHost = evaluateReport({
    loaded,
    plan,
    host: {
      hostname: 'other',
      filesystem: 'ext4',
      device_source: '/dev/nvme0n1p2',
    },
    results,
    rawSha256: 'b'.repeat(64),
  });
  assert.equal(wrongHost.verdict, 'rejected');
});

test('implementation contains no GitHub or host-control authority', () => {
  const source = fs.readFileSync(
    new URL('./run-durability-slo.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /gh workflow|workflow_dispatch|self-hosted|systemctl|reboot|sudo/iu,
  );
  assert.match(source, /source worktree must be clean/u);
  assert.match(source, /refusing existing workspace/u);
  assert.match(source, /fsyncSync/u);
});
