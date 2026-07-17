// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const CORE_DIR = path.join(ROOT, 'framework', 'core');
const CORE_DIST = path.join(CORE_DIR, 'dist', 'kungfu');
const BINDING_PATH = path.join(CORE_DIST, 'kungfu_node.node');
const PEER_FIXTURE = path.join(TEST_DIR, 'runtime-port.native-peer.mjs');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function coordinatorEnvironment() {
  const environment = { ...process.env };
  const loaderVariable =
    process.platform === 'darwin'
      ? 'DYLD_FALLBACK_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  environment[loaderVariable] = environment[loaderVariable]
    ? `${CORE_DIST}${path.delimiter}${environment[loaderVariable]}`
    : CORE_DIST;
  return environment;
}

function waitForJsonLine(child, type, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      timeout,
    );
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (value.type === type) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve(value);
          return;
        }
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `${type} peer exited with ${code}: ${child.__stderr || 'no stderr'}`,
        ),
      );
    });
  });
}

function spawnPeer(role, runtimeDir) {
  const child = spawn(process.execPath, [PEER_FIXTURE, role, runtimeDir], {
    cwd: ROOT,
    env: coordinatorEnvironment(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__stderr = '';
  child.stderr.on('data', (chunk) => {
    child.__stderr += chunk.toString('utf8');
  });
  return child;
}

function signalChildTree(child, signal) {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
  }
  child.kill(signal);
}

export function windowsTreeKillInvocation(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`invalid test-owned Windows process id: ${pid}`);
  return {
    command: 'taskkill.exe',
    args: ['/pid', String(pid), '/t', '/f'],
  };
}

async function stopChild(child) {
  if (!child) return;
  const ownsProcessGroup = process.platform !== 'win32' && child.pid;
  if (child.exitCode !== null && !ownsProcessGroup) return;
  let treeKill = null;
  if (process.platform === 'win32' && child.pid) {
    const invocation = windowsTreeKillInvocation(child.pid);
    treeKill = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      windowsHide: true,
    });
  } else {
    signalChildTree(child, 'SIGTERM');
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    sleep(2_000),
  ]);
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      const diagnostic = `${treeKill?.error?.message || ''}\n${treeKill?.stdout || ''}\n${treeKill?.stderr || ''}`.trim();
      throw new Error(
        `test-owned process tree ${child.pid || 'unknown'} did not exit: ${diagnostic}`,
      );
    }
    return;
  }
  if (!child.pid) return;
  // A native peer can keep libuv work alive after its direct wrapper exits.
  // Always reap the POSIX fixture group after the grace period so a timed-out
  // qualification cannot occupy a self-hosted runner indefinitely.
  signalChildTree(child, 'SIGKILL');
  if (child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(2_000),
    ]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(
      `test-owned process tree ${child.pid || 'unknown'} did not exit after SIGKILL`,
    );
  }
}

test(
  'native peers exchange an AgentSession frame through mmap journal plus nng notice',
  { timeout: 45_000 },
  async (context) => {
    assert.ok(
      fs.existsSync(BINDING_PATH),
      `native qualification requires ${BINDING_PATH}; run ./shifu build:core first`,
    );

    const home = fs.mkdtempSync(
      path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kfas.'),
    );
    const runtimeDir = path.join(home, 'runtime');
    const coordinatorOutput = path.join(home, 'coordinator.out');
    const output = fs.openSync(coordinatorOutput, 'w');
    const coordinator = spawn(
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
        runtimeDir,
        '--low-latency',
      ],
      {
        cwd: CORE_DIR,
        env: coordinatorEnvironment(),
        detached: process.platform !== 'win32',
        stdio: ['ignore', output, output],
      },
    );
    let coordinatorExited = false;
    coordinator.once('exit', () => {
      coordinatorExited = true;
    });

    const peers = [];
    context.after(async () => {
      await Promise.all(peers.map((peer) => stopChild(peer)));
      await stopChild(coordinator);
      fs.closeSync(output);
      fs.rmSync(home, { recursive: true, force: true });
    });

    // The coordinator does not materialize the runtime journal tree until a
    // Peer registers. Match the established Core bench readiness contract:
    // allow its listener window to open, then require the process to be alive.
    await sleep(3_000);
    assert.ok(
      !coordinatorExited,
      `coordinator exited early:\n${fs.readFileSync(coordinatorOutput, 'utf8')}`,
    );

    const writer = spawnPeer('writer', runtimeDir);
    peers.push(writer);
    const written = await waitForJsonLine(writer, 'writer-ready');
    const reader = spawnPeer('reader', runtimeDir);
    peers.push(reader);
    const received = await waitForJsonLine(reader, 'reader-received');

    assert.deepEqual(received.frame, written.frame);
    assert.deepEqual(
      {
        transport: received.health.transport,
        coordinatorByteProxy: received.health.coordinatorByteProxy,
      },
      {
        transport: 'mmap-journal+nng-notice',
        coordinatorByteProxy: false,
      },
    );
  },
);
