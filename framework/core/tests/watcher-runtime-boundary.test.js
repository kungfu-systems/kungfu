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
const ioSource = path.join(
  coreDir,
  'src',
  'libkungfu',
  'src',
  'runtime',
  'io',
  'io.cpp',
);
const ioHeader = path.join(
  coreDir,
  'src',
  'libkungfu',
  'include',
  'kungfu',
  'runtime',
  'io.h',
);
const watcherProbeSource = fs.readFileSync(probe, 'utf8');
const reconnectProbeSource = watcherProbeSource.slice(
  watcherProbeSource.indexOf('async function reconnectProbe()'),
  watcherProbeSource.indexOf("if (mode !== 'reconnect')"),
);
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
        ? 240_000
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

test('watcher reconnect fixture sequences readiness, owns process trees, and bounds Windows transitions', () => {
  assert.match(
    watcherProbeSource,
    /watcherConnect: process\.platform === 'win32' \? 75_000 : 8_000/,
  );
  assert.match(
    watcherProbeSource,
    /watcherReconnect: process\.platform === 'win32' \? 75_000 : 10_000/,
  );
  assert.match(
    watcherProbeSource,
    /coordinatorExit: process\.platform === 'win32' \? 15_000 : 10_000/,
  );
  assert.equal(
    watcherProbeSource.match(
      /waitForExitWithin\(child, reconnectDeadlines\.coordinatorExit\)/g,
    )?.length,
    2,
    'graceful and forced coordinator exits share the bounded platform deadline',
  );
  assert.match(
    watcherProbeSource,
    /\['\/pid', String\(child\.pid\), '\/T', '\/F'\]/,
  );
  assert.match(
    watcherProbeSource,
    /signalPosixProcessTree\(child, 'SIGTERM'\)/,
  );
  assert.match(
    watcherProbeSource,
    /signalPosixProcessTree\(child, 'SIGKILL'\)/,
  );
  const posixSignalSource = watcherProbeSource.slice(
    watcherProbeSource.indexOf('function signalPosixProcessTree('),
    watcherProbeSource.indexOf('async function stopCoordinator('),
  );
  assert.match(posixSignalSource, /process\.kill\(-child\.pid, signal\)/);
  assert.match(posixSignalSource, /child\.kill\(signal\)/);
  const coordinatorReady = reconnectProbeSource.indexOf(
    "'initial-coordinator-startup'",
  );
  const watcherConstruction = reconnectProbeSource.indexOf(
    'watcher = createWatcher();',
  );
  const watcherStart = reconnectProbeSource.indexOf('watcher.start();');
  assert.ok(
    coordinatorReady >= 0,
    'the initial readiness boundary is explicit',
  );
  assert.ok(
    coordinatorReady < watcherConstruction,
    'the reconnect watcher is constructed only after coordinator readiness',
  );
  assert.ok(
    watcherConstruction < watcherStart,
    'the reconnect watcher is constructed before its worker starts',
  );
  const exitWaitSource = watcherProbeSource.slice(
    watcherProbeSource.indexOf('function waitForExitWithin('),
    watcherProbeSource.indexOf('async function stopCoordinator('),
  );
  const exitListener = exitWaitSource.indexOf("child.once('exit', onExit);");
  const postListenerStateCheck = exitWaitSource.indexOf(
    'if (child.exitCode !== null || child.signalCode !== null) onExit();',
  );
  assert.ok(exitListener >= 0, 'coordinator exit is observed by a listener');
  assert.ok(
    exitListener < postListenerStateCheck,
    'coordinator exit state is rechecked after listener installation',
  );
  assert.match(exitWaitSource, /let settled = false;/);
});

test('peer usability persists one bounded handshake across slow-joiner retries', () => {
  const source = fs.readFileSync(ioSource, 'utf8');
  const header = fs.readFileSync(ioHeader, 'utf8');
  const watcher = fs.readFileSync(watcherSource, 'utf8');
  const peerUsabilitySource = source.slice(
    source.indexOf('bool io_device_peer::is_usable()'),
    source.indexOf('bool io_device_peer::setup()'),
  );
  const peerCancellationSource = source.slice(
    source.indexOf('void io_device_peer::cancel_usability_probe()'),
    source.indexOf('bool io_device_peer::setup()'),
  );
  const peerSetupSource = source.slice(
    source.indexOf('bool io_device_peer::setup()'),
  );
  assert.match(source, /constexpr int USABILITY_PROBE_ATTEMPTS = 5;/);
  assert.match(
    peerUsabilitySource,
    /std::lock_guard<std::mutex> call_guard\(usability_probe_call_mutex\);\s*std::unique_lock<std::mutex> guard\(usability_probe_mutex_\)/,
    'one call-level lock must outlive waits that release the probe state lock',
  );
  assert.match(
    peerSetupSource,
    /std::lock_guard<std::mutex> call_guard\(usability_probe_call_mutex\);\s*\{\s*std::lock_guard<std::mutex> guard\(usability_probe_mutex_\)/,
    'setup must follow the same call-lock then state-lock order',
  );
  assert.doesNotMatch(
    peerCancellationSource,
    /usability_probe_call_mutex/,
    'cancellation must remain able to wake a probe while its call lock is held',
  );
  assert.match(
    peerUsabilitySource,
    /if \(not usability_probe_publisher_ or not usability_probe_observer_\)/,
  );
  assert.match(
    peerUsabilitySource,
    /if \(not observer->setup\(\) or not publisher->setup\(\)\)/,
  );
  assert.match(peerUsabilitySource, /usability_probe_condition_\.wait_for\(/);
  assert.match(
    peerUsabilitySource,
    /make_shared<nanomsg_observer_peer>\(\*this, false, true\)/,
  );
  assert.match(
    peerUsabilitySource,
    /make_shared<nanomsg_publisher_peer>\(\*this, false, true\)/,
  );
  assert.match(
    peerUsabilitySource,
    /for \(int attempt = 0; attempt < USABILITY_PROBE_ATTEMPTS; \+\+attempt\)/,
  );
  assert.equal(
    peerUsabilitySource.match(/make_shared<nanomsg_observer_peer>/g)?.length,
    1,
    'the SUB socket must not be recreated inside the retry loop',
  );
  assert.match(
    peerUsabilitySource,
    /usability_probe_publisher_->is_usable\(\) and usability_probe_observer_->is_usable\(\)/,
  );
  assert.match(header, /std::mutex usability_probe_mutex_;/);
  assert.match(source, /std::mutex usability_probe_call_mutex;/);
  assert.match(
    header,
    /std::atomic<bool> usability_probe_cancelled_\{false\};/,
  );
  assert.match(header, /std::condition_variable usability_probe_condition_;/);
  assert.match(header, /publisher_ptr usability_probe_publisher_;/);
  assert.match(header, /observer_ptr usability_probe_observer_;/);
  assert.equal(
    watcher.match(/get_io_device\(\)->cancel_usability_probe\(\);/g)?.length,
    2,
    'quit and environment cleanup must both cancel an in-flight readiness probe',
  );
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
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.equal(runProbe('addon-exit'), null);
    }
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
