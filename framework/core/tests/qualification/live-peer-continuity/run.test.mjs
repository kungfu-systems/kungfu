// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import {
  boundedDiagnosticTail,
  campaignTempParent,
  createLogBundle,
  defaultOutputDir,
  evaluateQualification,
  nativeFailureDiagnosticTails,
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
    'peer-lifecycle-control-plane',
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
    peerHostCrashAdopted: true,
    staleHostGenerationRejected: true,
    peerCrashRestarted: true,
    peerGenerationAdvanced: true,
  },
};

test('default evidence is outside the Core build tree', () => {
  const output = defaultOutputDir('qualification-test');
  assert.match(output, /live-peer-continuity/u);
  assert.doesNotMatch(output, /framework[/\\]core[/\\]build/u);
});

test('native state-machine leg fails when CTest discovers no matching test', () => {
  const command = qualificationPlan('/tmp/qualification-test').find(
    (suite) => suite.id === 'core-continuity-state-machine',
  ).command;
  assert.ok(command.includes('--no-tests=error'));
  assert.ok(command.includes('^kungfu_peer_continuity_tests$'));
  assert.ok(command.includes('framework/core/build/src/libkungfu'));
});

test('Peer lifecycle control plane unit suite uses the Shifu-managed Python project', () => {
  const suite = qualificationPlan('/tmp/qualification-test').find(
    (item) => item.id === 'peer-lifecycle-control-plane',
  );
  assert.ok(suite.command.includes('pytest'));
  assert.ok(
    suite.command.includes(
      'framework/core/tests/python/test_peer_lifecycle.py',
    ),
  );
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

test('native campaign uses a short platform-owned temp root', () => {
  assert.equal(campaignTempParent('linux'), '/tmp');
  assert.equal(campaignTempParent('darwin'), '/tmp');
  assert.equal(
    campaignTempParent('win32', {
      env: { RUNNER_TEMP: 'D:\\a\\_temp', TEMP: 'D:\\repo\\.buildchain\\tmp' },
      temporaryDirectory: 'C:\\Users\\runneradmin\\AppData\\Local\\Temp',
    }),
    'D:\\a\\_temp',
  );
  assert.equal(
    campaignTempParent('win32', {
      env: {},
      temporaryDirectory: 'C:\\Users\\local\\AppData\\Local\\Temp',
    }),
    'C:\\Users\\local\\AppData\\Local\\Temp',
  );
  assert.equal(
    campaignTempParent('win32', {
      env: {
        KUNGFU_QUALIFICATION_HOST_TEMP:
          'C:\\Users\\local\\AppData\\Local\\Temp',
      },
      temporaryDirectory: 'D:\\repo\\.buildchain\\tmp',
    }),
    'C:\\Users\\local\\AppData\\Local\\Temp',
  );
  const linux = qualificationPlan('/qualification', {
    platform: 'linux',
  }).find((suite) => suite.id === 'native-cross-process-restart');
  const windows = qualificationPlan('/qualification', {
    platform: 'win32',
  }).find((suite) => suite.id === 'native-cross-process-restart');
  assert.deepEqual(linux.command.slice(-2), ['--temp-parent', '/tmp']);
  assert.ok(windows.command.includes('--temp-parent'));
  assert.notEqual(
    windows.command[windows.command.indexOf('--temp-parent') + 1],
    null,
  );
});

test('native campaign failure diagnostics retain only a bounded log tail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-log-tail-'));
  const log = path.join(root, 'peer.log');
  try {
    fs.writeFileSync(log, 'first\r\nsecond\r\nthird\r\nfourth\r\n');
    assert.equal(
      boundedDiagnosticTail(log, { maxBytes: 1024, maxLines: 2 }),
      'third\nfourth',
    );
    assert.equal(boundedDiagnosticTail(path.join(root, 'missing.log')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native campaign failure diagnostics include coordinator and peer logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-log-tails-'));
  const campaignDir = path.join(root, 'native-campaign');
  try {
    fs.mkdirSync(campaignDir);
    fs.writeFileSync(
      path.join(campaignDir, 'coordinator-7-1.log'),
      'coordinator\n',
    );
    fs.writeFileSync(path.join(campaignDir, 'peer.log'), 'peer\n');
    fs.writeFileSync(path.join(campaignDir, 'capsule.log'), 'capsule\n');
    assert.deepEqual(nativeFailureDiagnosticTails(root), [
      { path: 'coordinator-7-1.log', tail: 'coordinator' },
      { path: 'peer.log', tail: 'peer' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native campaign binds Peer workload identity and fenced host adoption', () => {
  const campaignSource = fs.readFileSync(
    path.join(import.meta.dirname, 'native_campaign.py'),
    'utf8',
  );
  assert.match(
    campaignSource,
    /peer_host_pid = int\(hosted\["host"\]\["pid"\]\)/u,
  );
  assert.match(campaignSource, /peer_pid = int\(first\[0\]\["pid"\]\)/u);
  assert.match(campaignSource, /second_ready_pids != \[peer_pid\]/u);
  assert.match(
    campaignSource,
    /expected_host_generation=peer_host_generation/u,
  );
  assert.match(campaignSource, /restarted_pid == peer_pid/u);
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
