import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createDetachedAgentSessionHost,
  detachedAgentSessionPaths,
} from '../src/product-client.mjs';

const FIXTURE = fileURLToPath(
  new URL('./fixtures/product-worker-fixture.mjs', import.meta.url),
);

test('detached endpoint is stable per runtime root and contains no main pid', () => {
  const first = detachedAgentSessionPaths('/tmp/kungfu-runtime-a');
  const second = detachedAgentSessionPaths('/tmp/kungfu-runtime-a');
  const other = detachedAgentSessionPaths('/tmp/kungfu-runtime-b');
  assert.deepEqual(first, second);
  assert.notEqual(first.endpoint, other.endpoint);
  assert.doesNotMatch(first.endpoint, new RegExp(String(process.pid)));
});

test('a new main client reconnects to one worker and worker loss never fakes continuity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kungfu-session-worker-'));
  const children = [];
  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, detached: false });
    children.push(child);
    return child;
  };
  const options = {
    runtimeDir: root,
    executable: process.execPath,
    workerPath: FIXTURE,
    spawnProcess,
    unrefWorker: false,
  };
  try {
    const firstMain = createDetachedAgentSessionHost(options);
    await firstMain.invoke({
      operation: 'start',
      sessionAttemptId: 'attempt:retained-across-main-restart',
    });
    const restartedMain = createDetachedAgentSessionHost(options);
    assert.deepEqual(await restartedMain.invoke({ operation: 'list' }), {
      sessions: ['attempt:retained-across-main-restart'],
    });
    assert.equal(children.length, 1);

    children[0].kill('SIGTERM');
    await new Promise((resolve) => children[0].once('exit', resolve));
    assert.deepEqual(await restartedMain.invoke({ operation: 'list' }), {
      sessions: [],
    });
    assert.equal(children.length, 2);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode
          ? Promise.resolve()
          : new Promise((resolve) => child.once('exit', resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});

test('independent clients serialize first worker startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kungfu-session-race-'));
  const children = [];
  const spawnProcess = (command, args, options) => {
    const child = spawn(command, args, { ...options, detached: false });
    children.push(child);
    return child;
  };
  const options = {
    runtimeDir: root,
    executable: process.execPath,
    workerPath: FIXTURE,
    spawnProcess,
    unrefWorker: false,
  };
  try {
    const firstClient = createDetachedAgentSessionHost(options);
    const secondClient = createDetachedAgentSessionHost(options);
    const [first, second] = await Promise.all([
      firstClient.invoke({ operation: 'capabilities' }),
      secondClient.invoke({ operation: 'capabilities' }),
    ]);
    assert.deepEqual(first, second);
    assert.equal(children.length, 1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode
          ? Promise.resolve()
          : new Promise((resolve) => child.once('exit', resolve)),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
