#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2];
const coreDir = path.resolve(__dirname, '..', '..');
const binding = require(path.join(coreDir, 'dist', 'kungfu', 'kungfu_node.node'));
const temporaryRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
const home = fs.mkdtempSync(path.join(temporaryRoot, 'kfwr.'));
let watcher = null;

function createWatcher() {
  return new binding.Watcher(
    path.join(home, 'runtime'),
    `runtime_${mode}`,
    true,
    2,
  );
}
const reconnectDeadlines = Object.freeze({
  coordinatorStartup: process.platform === 'win32' ? 30_000 : 15_000,
  // io_device_peer::setup() owns a bounded 60-second registration retry.
  // Leave runner-scheduling margin around that native boundary instead of
  // timing out the fixture while the bounded setup is still authoritative.
  watcherConnect: process.platform === 'win32' ? 75_000 : 8_000,
  watcherDisconnect: process.platform === 'win32' ? 30_000 : 8_000,
  watcherReconnect: process.platform === 'win32' ? 75_000 : 10_000,
  watcherStop: process.platform === 'win32' ? 15_000 : 5_000,
  coordinatorExit: process.platform === 'win32' ? 15_000 : 10_000,
});

function printableStats() {
  if (watcher === null) return null;
  return Object.fromEntries(
    Object.entries(watcher.runtimeStats()).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ]),
  );
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ mode, error: message })}\n`);
  process.exit(2);
}

function waitFor(predicate, timeoutMs, message, context = () => ({})) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(
          new Error(
            `${message}: ${JSON.stringify({ timeoutMs, ...context() })}`,
          ),
        );
      }
    }, 20);
  });
}

function startCoordinator() {
  const outputPath = path.join(home, 'coordinator.out');
  const logOffset = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
  const output = fs.openSync(outputPath, 'a');
  const environment = { ...process.env };
  environment.PATH =
    environment.SHIFU_UV_ORIGINAL_PATH || environment.PATH;
  delete environment.SHIFU_UV_ADAPTER_MANIFEST;
  delete environment.UV_PROJECT_ENVIRONMENT;
  delete environment.UV_PROJECT;
  delete environment.UV_FROZEN;
  delete environment.VIRTUAL_ENV;
  const child = spawn(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      '.devtools/kungfu_cli.py',
      '-H',
      home,
      'runtime',
      'run',
      '--home',
      home,
      '--runtime-dir',
      path.join(home, 'runtime'),
      '--low-latency',
    ],
    {
      cwd: coreDir,
      env: environment,
      stdio: ['ignore', output, output],
      detached: process.platform !== 'win32',
    },
  );
  fs.closeSync(output);
  child.coordinatorLogOffset = logOffset;
  return child;
}

function coordinatorLogTail(child) {
  const outputPath = path.join(home, 'coordinator.out');
  const output = fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, 'utf8').slice(child.coordinatorLogOffset)
    : '';
  return output.slice(-4_000);
}

function reconnectContext(child, stage) {
  return {
    stage,
    platform: process.platform,
    coordinator: {
      pid: child?.pid ?? null,
      exitCode: child?.exitCode ?? null,
      signalCode: child?.signalCode ?? null,
      logTail: child ? coordinatorLogTail(child) : '',
    },
    watcher: printableStats(),
  };
}

function coordinatorReady(child) {
  const output = fs.readFileSync(path.join(home, 'coordinator.out'), 'utf8');
  return output.slice(child.coordinatorLogOffset).includes('live runtime setup done');
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

function waitForExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const onExit = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
    // Close the check/listener race: the process can exit after the caller's
    // fast-path check but before this listener is installed.
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function signalPosixProcessTree(child, signal) {
  let groupError = null;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') groupError = error;
  }

  let childSignalled = false;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      childSignalled = child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH' && groupError === null) groupError = error;
    }
  }
  if (
    groupError !== null &&
    !childSignalled &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    throw new Error(
      `failed to signal coordinator process tree with ${signal}: ${groupError.message}`,
    );
  }
}

async function stopCoordinator(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const terminated = spawnSync(
      'taskkill',
      ['/pid', String(child.pid), '/T', '/F'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (terminated.error) {
      throw new Error(`taskkill failed to launch: ${terminated.error.message}`);
    }
    if (terminated.status !== 0 && child.exitCode === null) {
      throw new Error(
        `taskkill failed (${terminated.status}): ${terminated.stderr.trim()}`,
      );
    }
  } else {
    signalPosixProcessTree(child, 'SIGTERM');
  }
  if (await waitForExitWithin(child, reconnectDeadlines.coordinatorExit)) return;
  if (process.platform === 'win32') {
    child.kill();
  } else {
    signalPosixProcessTree(child, 'SIGKILL');
  }
  if (!(await waitForExitWithin(child, reconnectDeadlines.coordinatorExit))) {
    throw new Error('coordinator did not exit after SIGKILL');
  }
}

function runChildProbe(childMode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, childMode], {
      cwd: path.resolve(coreDir, '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`${childMode} child exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
    });
  });
}

async function reconnectProbe() {
  let coordinator = startCoordinator();
  let result = null;
  try {
    await waitFor(
      () =>
        coordinatorReady(coordinator) ||
        coordinator.exitCode !== null ||
        coordinator.signalCode !== null,
      reconnectDeadlines.coordinatorStartup,
      'coordinator startup did not reach a terminal state',
      () => reconnectContext(coordinator, 'initial-coordinator-startup'),
    );
    if (coordinator.exitCode !== null || coordinator.signalCode !== null) {
      throw new Error(
        `coordinator exited during startup: ${JSON.stringify(reconnectContext(coordinator, 'initial-coordinator-startup'))}`,
      );
    }
    watcher = createWatcher();
    watcher.start();
    await waitFor(
      () => watcher.isLive(),
      reconnectDeadlines.watcherConnect,
      'watcher did not connect',
      () => reconnectContext(coordinator, 'initial-watcher-connect'),
    );

    await stopCoordinator(coordinator);
    await waitFor(
      () => !watcher.isLive(),
      reconnectDeadlines.watcherDisconnect,
      'watcher did not observe coordinator exit',
      () => reconnectContext(coordinator, 'watcher-disconnect'),
    );

    coordinator = startCoordinator();
    await waitFor(
      () =>
        coordinatorReady(coordinator) ||
        coordinator.exitCode !== null ||
        coordinator.signalCode !== null,
      reconnectDeadlines.coordinatorStartup,
      'replacement coordinator startup did not reach a terminal state',
      () => reconnectContext(coordinator, 'replacement-coordinator-startup'),
    );
    if (coordinator.exitCode !== null || coordinator.signalCode !== null) {
      throw new Error(
        `replacement coordinator exited during startup: ${JSON.stringify(reconnectContext(coordinator, 'replacement-coordinator-startup'))}`,
      );
    }
    await waitFor(
      () => watcher.isLive(),
      reconnectDeadlines.watcherReconnect,
      'watcher did not reconnect to the restarted coordinator',
      () => reconnectContext(coordinator, 'watcher-reconnect'),
    );
    watcher.quit();
    await waitFor(
      () => !watcher.runtimeStats().running,
      reconnectDeadlines.watcherStop,
      'watcher did not stop after reconnect',
      () => reconnectContext(coordinator, 'watcher-stop'),
    );
    result = { mode, reconnected: true, stats: printableStats() };
  } finally {
    watcher.quit();
    await stopCoordinator(coordinator);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

if (mode !== 'reconnect') {
  watcher = createWatcher();
}

if (mode === 'pool') {
  watcher.start();
  const startedAt = Date.now();
  let completed = false;
  crypto.pbkdf2('watcher', 'pool', 1_000, 32, 'sha256', () => {
    completed = true;
    process.stdout.write(
      `${JSON.stringify({
        mode,
        elapsedMs: Date.now() - startedAt,
        stats: printableStats(),
      })}\n`,
    );
    watcher.quit();
  });
  setTimeout(() => {
    if (!completed) fail('libuv worker pool was starved by the watcher');
  }, 1_500);
} else if (mode === 'lifecycle') {
  watcher.start();
  setTimeout(() => watcher.quit(), 25);
  const deadline = Date.now() + 2_000;
  const poll = setInterval(() => {
    const stats = printableStats();
    if (!stats.running) {
      clearInterval(poll);
      process.stdout.write(`${JSON.stringify({ mode, stats })}\n`);
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      fail('watcher did not stop within the lifecycle deadline');
    }
  }, 10);
} else if (mode === 'lifecycle-race') {
  Promise.all(Array.from({ length: 4 }, () => runChildProbe('lifecycle')))
    .then((results) => {
      process.stdout.write(
        `${JSON.stringify({ mode, stats: results.map((item) => item.stats) })}\n`,
      );
    })
    .catch((error) => fail(error.message));
} else if (mode === 'addon-exit') {
  watcher.start();
  setTimeout(() => process.exit(0), 25);
} else if (mode === 'reconnect') {
  reconnectProbe().catch((error) => fail(error.message));
} else if (mode === 'deadline-failure') {
  waitFor(
    () => false,
    25,
    'synthetic watcher deadline',
    () => reconnectContext(null, 'synthetic-deadline'),
  ).catch((error) => fail(error.message));
} else {
  fail(`unknown probe mode: ${mode}`);
}
