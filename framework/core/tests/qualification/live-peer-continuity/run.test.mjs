// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  createLogBundle,
  defaultOutputDir,
  evaluateQualification,
  pythonInvocation,
  qualificationPlan,
  retainQualificationArtifacts,
} from './run.mjs';

const source = (dirty = false) => ({
  revision: '1'.repeat(40),
  tree: '2'.repeat(40),
  dirty,
});

const suites = (failed = null) =>
  [
    'core-continuity-state-machine',
    'agent-session-capsule-continuity',
    'native-cross-process-restart',
  ].map((id) => ({ id, status: id === failed ? 'failed' : 'passed' }));

const campaign = {
  verdict: 'passed',
  coverage: {
    peerPidPreserved: true,
    capsulePidPreserved: true,
    capsuleStreamEpochPreserved: true,
  },
};

test('default evidence is outside the Core build tree', () => {
  const output = defaultOutputDir('qualification-test');
  assert.match(output, /live-peer-continuity/u);
  assert.doesNotMatch(output, /framework[/\\]core[/\\]build/u);
});

test('native state-machine leg fails when CTest discovers no matching test', () => {
  const command = qualificationPlan('/tmp/qualification-test')[0].command;
  assert.ok(command.includes('--no-tests=error'));
  assert.ok(command.includes('^kungfu_peer_continuity_tests$'));
  assert.ok(command.includes('framework/core/build/src/libkungfu'));
});

test('native campaign enters Python through the Shifu-managed uv project', () => {
  const linux = pythonInvocation({ platform: 'linux' });
  const windows = pythonInvocation({ platform: 'win32' });
  assert.deepEqual(linux.command.slice(0, 4), [
    'uv',
    'run',
    '--frozen',
    '--project',
  ]);
  assert.match(linux.command[4], /framework[/\\]core$/u);
  assert.equal(linux.command[5], 'python');
  assert.equal(linux.shell, false);
  assert.equal(windows.shell, true);
});

test('clean complete evidence qualifies only the bounded single-host claim', () => {
  const report = evaluateQualification({
    source: source(),
    platform: { os: 'darwin', arch: 'arm64' },
    suites: suites(),
    campaign,
    bundle: { path: 'raw-logs.jsonl.gz' },
  });
  assert.equal(report.verdict, 'passed');
  assert.equal(report.claims.single_host_process_continuity, true);
  assert.equal(report.claims.physical_power_loss, false);
  assert.equal(report.claims.cross_host_high_availability, false);
});

test('dirty source and a failed suite fail closed', () => {
  const dirty = evaluateQualification({
    source: source(true),
    platform: {},
    suites: suites(),
    campaign,
    bundle: {},
  });
  const failed = evaluateQualification({
    source: source(),
    platform: {},
    suites: suites('agent-session-capsule-continuity'),
    campaign,
    bundle: {},
  });
  assert.equal(dirty.verdict, 'unqualified');
  assert.equal(failed.verdict, 'failed');
  assert.equal(dirty.claims.single_host_process_continuity, false);
  assert.equal(failed.claims.single_host_process_continuity, false);
});

test('gzip bundle and report are retained together with nested native evidence', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'peer-continuity-bundle-'),
  );
  const output = path.join(root, 'output');
  const retained = path.join(root, 'retained');
  try {
    fs.mkdirSync(path.join(output, 'native-campaign'), { recursive: true });
    fs.writeFileSync(path.join(output, 'core.log'), 'core output\n');
    fs.writeFileSync(
      path.join(output, 'native-campaign', 'report.json'),
      '{"verdict":"passed"}\n',
    );
    const bundle = createLogBundle(output);
    const rows = gunzipSync(fs.readFileSync(path.join(output, bundle.path)))
      .toString('utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.deepEqual(
      rows.map((row) => row.path),
      ['core.log', 'native-campaign/report.json'],
    );
    fs.writeFileSync(path.join(output, 'report.json'), '{}\n');
    retainQualificationArtifacts(output, retained);
    assert.deepEqual(fs.readdirSync(retained).sort(), [
      'raw-logs.jsonl.gz',
      'report.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
