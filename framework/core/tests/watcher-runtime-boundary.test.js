#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const coreDir = path.resolve(__dirname, '..');
const bindingPath = path.join(coreDir, 'dist', 'kungfu', 'kungfu_node.node');
const probe = path.join(__dirname, 'fixtures', 'watcher-runtime-probe.js');
const watcherSource = path.join(
  coreDir,
  'src',
  'bindings',
  'node',
  'binding',
  'watcher.cpp',
);
const watcherBench = path.join(__dirname, 'bench', 'dispatch_watcher_bench.js');
const watcherBenchDriver = path.join(
  __dirname,
  'bench',
  'dispatch_bench_watcher.mjs',
);
const watcherProbeSource = fs.readFileSync(probe, 'utf8');
const nativeTest = {
  skip: fs.existsSync(bindingPath)
    ? false
    : `native watcher qualification requires ${bindingPath}`,
};

function runProbe(mode, environment = {}) {
  const result = spawnSync(process.execPath, [probe, mode], {
    cwd: path.resolve(coreDir, '..', '..'),
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout:
      mode === 'reconnect' && process.platform === 'win32'
        ? 150_000
        : mode === 'reconnect'
          ? 55_000
          : 10_000,
  });
  assert.equal(
    result.error,
    undefined,
    `${mode} probe failed to launch: ${result.error?.message}`,
  );
  assert.equal(
    result.status,
    0,
    `${mode} probe exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim()
    ? JSON.parse(result.stdout.trim().split('\n').at(-1))
    : null;
}

function runFailingProbe(mode) {
  const result = spawnSync(process.execPath, [probe, mode], {
    cwd: path.resolve(coreDir, '..', '..'),
    env: process.env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, `${mode} must fail closed: ${result.stderr}`);
  return JSON.parse(result.stderr.trim().split('\n').at(-1));
}

test('watcher source does not reserve a libuv worker-pool job', () => {
  const source = fs.readFileSync(watcherSource, 'utf8');
  assert.doesNotMatch(source, /\buv_queue_work\b|\buv_work_t\b/);
  assert.match(source, /std::thread\(&Watcher::RunWorker, this\)/);
  assert.match(
    source,
    /"KungfuWatcherBridge", 1, 1/,
    'the native-to-Node bridge must remain single-slot and single-producer',
  );
});

test('watcher dispatch bench follows and proves the load peer carrier', () => {
  const peer = fs.readFileSync(watcherBench, 'utf8');
  const driver = fs.readFileSync(watcherBenchDriver, 'utf8');
  assert.match(peer, /true, \/\/ captureCustom:/);
  assert.match(peer, /requestReadFromPublic\(loadLocation, 0n\)/);
  assert.match(
    fs.readFileSync(watcherSource, 'utf8'),
    /Watcher::RequestReadFromPublic[\s\S]*?has_writer\(get_coordinator_command_uid\(\)\)[\s\S]*?request_read_from_public/,
  );
  assert.match(driver, /watcher observed \$\{observed\} requested carrier/);
  assert.match(driver, /if \(observed < count\)/);
  assert.match(driver, /coordinator\.kill\(\)/);
});

test('watcher reconnect fixture owns process trees and bounds Windows transitions', () => {
  assert.match(
    watcherProbeSource,
    /watcherConnect: process\.platform === 'win32' \? 30_000 : 8_000/,
  );
  assert.match(
    watcherProbeSource,
    /watcherReconnect: process\.platform === 'win32' \? 30_000 : 10_000/,
  );
  assert.match(
    watcherProbeSource,
    /\['\/pid', String\(child\.pid\), '\/T', '\/F'\]/,
  );
  assert.match(watcherProbeSource, /process\.kill\(-child\.pid, 'SIGTERM'\)/);
});

test(
  'watcher uses a dedicated thread and leaves a single-slot libuv pool available',
  nativeTest,
  () => {
    const result = runProbe('pool', { UV_THREADPOOL_SIZE: '1' });
    assert.equal(result.stats.threadModel, 'dedicated-native-thread');
    assert.equal(result.stats.bridgeQueueCapacity, 1);
    assert.ok(
      result.elapsedMs < 1_500,
      `libuv work completed too slowly: ${result.elapsedMs}ms`,
    );
  },
);

test(
  'watcher quit joins its native thread deterministically',
  nativeTest,
  () => {
    const result = runProbe('lifecycle');
    assert.equal(result.stats.running, false);
    assert.equal(result.stats.stopRequested, true);
    assert.equal(result.stats.bridgeFailures, '0');
  },
);

test(
  'concurrent watcher shutdown preserves bridge event ownership',
  nativeTest,
  () => {
    const result = runProbe('lifecycle-race');
    assert.equal(result.stats.length, 4);
    for (const stats of result.stats) {
      assert.equal(stats.running, false);
      assert.equal(stats.stopRequested, true);
      assert.equal(stats.bridgeFailures, '0');
    }
  },
);

test(
  'environment cleanup stops and joins a live watcher during addon exit',
  nativeTest,
  () => {
    assert.equal(runProbe('addon-exit'), null);
  },
);

test(
  'watcher reconnects after coordinator exit without losing callback ownership',
  nativeTest,
  () => {
    const result = runProbe('reconnect');
    assert.equal(result.reconnected, true);
    assert.equal(result.stats.running, false);
    assert.equal(result.stats.stopRequested, true);
    assert.equal(result.stats.bridgeFailures, '0');
  },
);

test(
  'watcher transition deadlines fail closed with actionable diagnostics',
  nativeTest,
  () => {
    const result = runFailingProbe('deadline-failure');
    assert.equal(result.mode, 'deadline-failure');
    assert.match(result.error, /synthetic watcher deadline/);
    assert.match(result.error, /"stage":"synthetic-deadline"/);
    assert.match(result.error, /"platform":"[^"]+"/);
    assert.match(result.error, /"watcher":\{/);
  },
);
