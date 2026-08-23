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
const nanomsgSocketHeader = path.join(
  coreDir,
  'src',
  'libkungfu',
  'include',
  'kungfu',
  'runtime',
  'nanomsg',
  'socket.h',
);
const signalSource = path.join(
  coreDir,
  'src',
  'libkungfu',
  'src',
  'runtime',
  'util',
  'signal.cpp',
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
    /const home = fs\.realpathSync\.native\(\s*fs\.mkdtempSync\(/,
    'the watcher and Python coordinator must share the native-canonical temp root',
  );
  assert.match(
    watcherProbeSource,
    /const runtimeDir = path\.join\(home, 'runtime'\);/,
  );
  assert.equal(
    watcherProbeSource.match(/path\.join\(home, 'runtime'\)/g)?.length,
    1,
    'the fixture must derive its runtime path once',
  );
  assert.match(
    watcherProbeSource,
    /function createWatcher\(\) \{\s*return new binding\.Watcher\(\s*runtimeDir,/,
  );
  assert.match(watcherProbeSource, /'--runtime-dir',\s*runtimeDir,/);
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
  assert.match(
    watcherProbeSource,
    /const coordinatorStopLocation = Object\.freeze\(\{\s*mode: 'live',\s*role: 'system',\s*namespace: 'master',\s*name: 'master',\s*\}\);/,
    'the graceful stop request must target the exact coordinator wire',
  );
  assert.match(
    watcherProbeSource,
    /function requestCoordinatorStop\(\) \{\s*if \(watcher === null \|\| !watcher\.isLive\(\)\) return false;\s*return watcher\.requestStop\(coordinatorStopLocation\);\s*\}/,
    'Windows must use the coordinator command channel when the watcher is live',
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
  const stopCoordinatorSource = watcherProbeSource.slice(
    watcherProbeSource.indexOf('async function stopCoordinator('),
    watcherProbeSource.indexOf('function runChildProbe('),
  );
  const gracefulStopRequest = stopCoordinatorSource.indexOf(
    'requestCoordinatorStop()',
  );
  const forcedTreeStop = stopCoordinatorSource.indexOf(
    'forceWindowsProcessTree(child)',
  );
  assert.ok(
    gracefulStopRequest >= 0,
    'Windows requests graceful coordinator stop',
  );
  assert.ok(
    forcedTreeStop >= 0,
    'Windows retains a forced process-tree fallback',
  );
  assert.ok(
    gracefulStopRequest < forcedTreeStop,
    'the coordinator must publish deregistration before the forced fallback',
  );
  assert.match(
    watcherProbeSource,
    /const resolved = spawnSync\(\s*'uv',[\s\S]*?'--frozen'[\s\S]*?'import sys; print\(sys\.executable\)'/,
  );
  assert.match(
    watcherProbeSource,
    /process\.env\.UV_PROJECT_ENVIRONMENT \|\| '\.venv'/,
    'the exact Core project environment must be usable without uv on PATH',
  );
  assert.match(
    watcherProbeSource,
    /process\.platform === 'win32' \? 'Scripts' : 'bin'/,
  );
  assert.match(
    watcherProbeSource,
    /process\.platform === 'win32' \? 'python\.exe' : 'python'/,
  );
  assert.match(
    watcherProbeSource,
    /const projectRuntime = projectCoordinatorRuntime\(\);[\s\S]*?if \(projectRuntime !== null\)[\s\S]*?return coordinatorRuntime;[\s\S]*?const resolved = spawnSync/,
    'the project interpreter must be preferred before the uv fallback',
  );
  assert.match(watcherProbeSource, /resolved\.status !== 0/);
  assert.match(
    watcherProbeSource,
    /!path\.isAbsolute\(python\) \|\| !fs\.existsSync\(python\)/,
  );
  assert.match(
    watcherProbeSource,
    /environment\.VIRTUAL_ENV = runtime\.virtualEnvironment/,
  );
  assert.match(
    watcherProbeSource,
    /environment\.PATH = environment\.PATH[\s\S]*?runtime\.pythonDirectory/,
  );
  assert.match(watcherProbeSource, /const child = spawn\(\s*runtime\.python,/);
  assert.doesNotMatch(
    watcherProbeSource,
    /const child = spawn\(\s*'uv'/,
    'the owned child PID must be the coordinator, not the uv launcher',
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
  const hostSignalSource = fs.readFileSync(signalSource, 'utf8');
  const signalInstaller = hostSignalSource.slice(
    hostSignalSource.indexOf('static void install_os_signal_handler'),
    hostSignalSource.indexOf('void handle_os_signals'),
  );
  assert.match(
    signalInstaller,
    /if \(signum == SIGCHLD\) \{\s*return;\s*\}[\s\S]*?signal\(signum, kf_os_signal_handler\)/,
    'the native reactor must preserve the embedding host child-reaping handler',
  );
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
  const socketHeader = fs.readFileSync(nanomsgSocketHeader, 'utf8');
  assert.match(
    socketHeader,
    /#if defined\(_WIN32\)\s*inline constexpr int DEFAULT_QUIET_DIAL_FLAGS = NNG_FLAG_NONBLOCK;\s*#else\s*inline constexpr int DEFAULT_QUIET_DIAL_FLAGS = 0;/,
  );
  assert.match(
    socketHeader,
    /int dial\(const std::string &path, int flags = 0\)/,
  );
  assert.match(
    socketHeader,
    /int dial_quietly\(const std::string &path, int flags = DEFAULT_QUIET_DIAL_FLAGS\)/,
    'Windows readiness probes must let NNG retain and retry an asynchronous dialer',
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
