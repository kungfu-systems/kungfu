// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { episodeRuntimeEnv } from '../episode/run.mjs';
import {
  evaluateQualification,
  loadProfile,
  qualificationCommandInvocation,
  qualificationPlan,
} from './run.mjs';

const profileNames = [
  'macos-apfs-process-v1',
  'linux-ext4-process-v1',
  'windows-ntfs-process-v1',
];

function platformFor(profile) {
  return {
    os: profile.platform.node_platform,
    arch: profile.platform.architectures[0],
    release: 'qualification-test',
  };
}

function toolchain(status = 'passed') {
  return {
    node: process.version,
    doctor_status: status,
    doctor_sha256: status === 'planned' ? null : 'a'.repeat(64),
    doctor: status === 'passed' ? { schema_version: 1 } : null,
  };
}

function suites(loaded, durabilityProfile, status = 'passed') {
  return qualificationPlan(loaded.profile, durabilityProfile).map((step) => ({
    ...step,
    status,
    exit_code: status === 'planned' ? null : status === 'passed' ? 0 : 1,
    duration_ms: status === 'planned' ? 0 : 1,
    missing_markers: status === 'failed' ? [step.required_markers[0]] : [],
    raw_log: status === 'planned' ? null : `${step.id}.log`,
    raw_sha256: status === 'planned' ? null : 'b'.repeat(64),
  }));
}

function report(overrides = {}) {
  const loaded = overrides.loaded || loadProfile(profileNames[0]);
  const durabilityProfile = overrides.durabilityProfile || 'durable_group';
  return evaluateQualification({
    mode: overrides.mode || 'execute',
    loaded,
    durabilityProfile,
    filesystem:
      overrides.filesystem === undefined
        ? loaded.profile.platform.filesystem
        : overrides.filesystem,
    source: overrides.source || {
      revision: '1'.repeat(40),
      tree: '2'.repeat(40),
      dirty: false,
    },
    platform: overrides.platform || platformFor(loaded.profile),
    toolchain:
      overrides.toolchain ||
      toolchain(overrides.mode === 'dry-run' ? 'planned' : 'passed'),
    suites:
      overrides.suites ||
      suites(
        loaded,
        durabilityProfile,
        overrides.mode === 'dry-run' ? 'planned' : 'passed',
      ),
    runId: 'qualification-test-run',
  });
}

test('all platform profiles are schema-valid and cover both receipt profiles', () => {
  for (const name of profileNames) {
    const loaded = loadProfile(name);
    assert.deepEqual(loaded.profile.durability_profiles, [
      'durable_group',
      'durable_sync',
    ]);
    assert.equal(loaded.digest.length, 64);
  }
});

test('the dry run plans only local Shifu commands and makes no claim', () => {
  const loaded = loadProfile(profileNames[1]);
  const plan = qualificationPlan(loaded.profile, 'durable_sync');
  assert.ok(plan.every((step) => /shifu(?:\.cmd)?$/.test(step.command[0])));
  assert.doesNotMatch(JSON.stringify(plan), /github|self-hosted|buildchain/i);
  assert.ok(
    plan
      .find((step) => step.id === 'durable-ingest')
      .required_markers.some((marker) => marker.includes('sync I/O error')),
  );
  assert.ok(
    plan
      .find((step) => step.id === 'projection-bootstrap')
      .required_markers.includes(
        '[projection-bootstrap-test] candidate snapshot/replay contracts passed',
      ),
  );
  const result = report({
    loaded,
    durabilityProfile: 'durable_sync',
    mode: 'dry-run',
    filesystem: '',
  });
  assert.equal(result.verdict, 'planned');
  assert.equal(result.claims.declared_process_envelope_qualified, false);
  assert.equal(result.claims.power_loss_qualified, false);
  assert.equal(result.claims.production_profile_eligible, false);
});

test('Windows qualification commands enter Shifu through cmd.exe', () => {
  const invocation = qualificationCommandInvocation(
    ['shifu.cmd', 'doctor', '--json'],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert.deepEqual(invocation, {
    command: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/c', 'call shifu.cmd doctor --json'],
  });
  assert.deepEqual(
    qualificationCommandInvocation(['./shifu', 'doctor', '--json'], 'linux'),
    { command: './shifu', args: ['doctor', '--json'] },
  );
});

test('Windows Episode workers preserve Path and declare the source runtime boundary', () => {
  const env = episodeRuntimeEnv(
    'win32',
    { Path: 'C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links' },
    'C:\\core\\dist\\kungfu',
  );
  assert.deepEqual(env, {
    Path: 'C:\\core\\dist\\kungfu;C:\\Users\\tester\\AppData\\Local\\Microsoft\\WinGet\\Links',
    KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
  });
  assert.equal(env.PATH, undefined);
});

test('passing suites qualify only the declared process-crash envelope', () => {
  const result = report();
  assert.equal(result.verdict, 'passed');
  assert.equal(result.claims.declared_process_envelope_qualified, true);
  assert.equal(result.claims.power_loss_qualified, false);
  assert.equal(result.claims.production_profile_eligible, false);
  assert.ok(result.fault_coverage.every((fault) => fault.status === 'passed'));
});

test('dirty source or platform facts fail closed without rewriting suite evidence', () => {
  const result = report({
    source: {
      revision: '1'.repeat(40),
      tree: '2'.repeat(40),
      dirty: true,
    },
    platform: { os: 'linux', arch: 'x64', release: 'test' },
  });
  assert.equal(result.verdict, 'unqualified');
  assert.equal(result.claims.declared_process_envelope_qualified, false);
  assert.match(result.violations.join('\n'), /dirty/);
  assert.match(result.violations.join('\n'), /platform/);
});

test('a failed or marker-incomplete suite fails the report and its fault coverage', () => {
  const loaded = loadProfile(profileNames[0]);
  const failedSuites = suites(loaded, 'durable_sync');
  failedSuites[0] = {
    ...failedSuites[0],
    status: 'failed',
    exit_code: 0,
    missing_markers: [failedSuites[0].required_markers[0]],
  };
  const result = report({
    loaded,
    durabilityProfile: 'durable_sync',
    suites: failedSuites,
  });
  assert.equal(result.verdict, 'failed');
  assert.equal(result.claims.declared_process_envelope_qualified, false);
  assert.ok(result.fault_coverage.some((fault) => fault.status === 'failed'));
});
