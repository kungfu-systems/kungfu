import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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

test('detached endpoint is stable per runtime root and derived only from it', () => {
  const first = detachedAgentSessionPaths('/tmp/kungfu-runtime-a');
  const second = detachedAgentSessionPaths('/tmp/kungfu-runtime-a');
  const other = detachedAgentSessionPaths('/tmp/kungfu-runtime-b');
  const expectedScope = createHash('sha256')
    .update(first.directory)
    .digest('hex')
    .slice(0, 16);
  assert.deepEqual(first, second);
  assert.notEqual(first.endpoint, other.endpoint);
  assert.equal(
    first.endpoint,
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kungfu-agent-session-${expectedScope}`
      : path.join(first.socketDirectory, `${expectedScope}.sock`),
  );
  if (process.platform !== 'win32') {
    assert.equal(
      first.socketDirectory,
      path.join('/tmp', `kungfu-agent-session-${process.getuid?.() ?? 'user'}`),
    );
  }
});

test('filesystem aliases resolve to one detached endpoint', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'kungfu-session-alias-'));
  const runtime = path.join(parent, 'runtime');
  const alias = path.join(parent, 'runtime-alias');
  try {
    await mkdir(runtime);
    await symlink(
      runtime,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.deepEqual(
      detachedAgentSessionPaths(alias),
      detachedAgentSessionPaths(runtime),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('a new main client reconnects to one worker and worker loss never fakes continuity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kungfu-session-worker-'));
  const children = [];
  const spawnedEnvironments = [];
  const spawnProcess = (command, args, options) => {
    spawnedEnvironments.push(options.env);
    const child = spawn(command, args, { ...options, detached: false });
    children.push(child);
    return child;
  };
  const options = {
    runtimeDir: root,
    executable: process.execPath,
    workerPath: FIXTURE,
    env: {
      ...process.env,
      KUNGFU_NODE_VARIANT_ENTRY: '/product/tui/tui.mjs',
    },
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
    assert.equal(spawnedEnvironments[0].KUNGFU_AS_VARIANT, 'node');
    assert.equal(spawnedEnvironments[0].KUNGFU_NODE_VARIANT_ENTRY, undefined);

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
