import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  CapsuleTransportUnavailableError,
  capsuleNodePtyCandidates,
  createCapsuleNodePtyLoader,
} from '../src/capsule-transport-runtime.mjs';
import { detachedAgentSessionPaths } from '../src/product-client.mjs';
import {
  createIdleWorkerRetirement,
  runAgentSessionProductWorker,
} from '../src/product-worker.mjs';

const PRODUCT_WORKER = fileURLToPath(
  new URL('../src/product-worker.mjs', import.meta.url),
);

test('idle worker retirement preserves retained sessions and retires empty workers', async () => {
  const sessions = [];
  const scheduled = [];
  let retirements = 0;
  const retirement = createIdleWorkerRetirement({
    runtime: { list: () => sessions },
    retire: async () => {
      retirements += 1;
    },
    timeoutMs: 100,
    schedule(callback, timeout) {
      const timer = { callback, timeout, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancel() {},
  });

  retirement.touch();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].timeout, 100);
  sessions.push({ sessionAttemptId: 'attempt:retained' });
  await scheduled[0].callback();
  assert.equal(retirements, 0);
  assert.equal(scheduled.length, 2);

  sessions.length = 0;
  await scheduled[1].callback();
  assert.equal(retirements, 1);
  retirement.touch();
  assert.equal(scheduled.length, 2);
});

test('a detached worker with no retained session retires and removes its endpoint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kungfu-idle-worker-'));
  const paths = detachedAgentSessionPaths(root);
  const child = spawn(process.execPath, [PRODUCT_WORKER], {
    env: {
      ...process.env,
      KUNGFU_AGENT_SESSION_ENDPOINT: paths.endpoint,
      KUNGFU_AGENT_SESSION_METADATA: paths.metadata,
      KUNGFU_AGENT_SESSION_REGISTRY: paths.registry,
      KUNGFU_AGENT_SESSION_NODE_PTY_MODULE: '/definitely/missing/node-pty.js',
      KUNGFU_AGENT_SESSION_IDLE_RETIREMENT_MS: '100',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });

  const [code, signal] = await Promise.race([
    once(child, 'exit'),
    delay(3_000, undefined, { ref: false }).then(() => {
      throw new Error(
        'idle Agent Session worker did not retire within 3 seconds',
      );
    }),
  ]);
  assert.equal(signal, null);
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(existsSync(paths.endpoint), false);
  assert.equal(existsSync(paths.metadata), false);
});

test('Capsule node-pty resolution is lazy and reports an optional capability', () => {
  let resolveCalls = 0;
  const unavailableRequire = Object.assign(
    () => {
      throw new Error('must not import an unavailable module');
    },
    {
      resolve() {
        resolveCalls += 1;
        throw new Error('not installed');
      },
    },
  );
  const loadPty = createCapsuleNodePtyLoader({
    modulePath: '/definitely/missing/node-pty.js',
    registryPath: '/tmp/kungfu-agent-session/agent-session/registry.json',
    moduleRequire: unavailableRequire,
  });
  assert.equal(resolveCalls, 0);
  assert.throws(
    () => loadPty(),
    (error) => {
      assert.equal(error instanceof CapsuleTransportUnavailableError, true);
      assert.equal(error.code, 'capsule_transport_unavailable');
      assert.match(error.message, /optional node-pty runtime/u);
      return true;
    },
  );
  assert.equal(resolveCalls, 1);
});

test('Capsule node-pty resolution includes the signed desktop app layout', () => {
  const bundleDirectory = path.join(
    path.sep,
    'Applications',
    'Kungfu Episodes.app',
    'Contents',
    'Resources',
    'tui',
  );
  assert.deepEqual(capsuleNodePtyCandidates({ bundleDirectory }), [
    null,
    null,
    path.join(bundleDirectory, 'node_modules', 'node-pty', 'lib', 'index.js'),
    path.join(
      bundleDirectory,
      '..',
      'node_modules',
      'node-pty',
      'lib',
      'index.js',
    ),
    path.join(
      bundleDirectory,
      '..',
      'app',
      'node_modules',
      'node-pty',
      'lib',
      'index.js',
    ),
  ]);
});

test('the detached control core starts without node-pty for native sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kungfu-native-core-'));
  const paths = detachedAgentSessionPaths(root);
  const socketRoot =
    process.platform === 'win32'
      ? null
      : await mkdtemp(
          path.join(
            process.platform === 'darwin' ? '/tmp' : os.tmpdir(),
            'kungfu-native-core-socket-',
          ),
        );
  if (socketRoot) await rm(socketRoot, { recursive: true, force: true });
  let worker;
  try {
    worker = await runAgentSessionProductWorker({
      endpoint: socketRoot
        ? path.join(socketRoot, 'core.sock')
        : paths.endpoint,
      metadata: paths.metadata,
      registryPath: paths.registry,
      ptyModule: '/definitely/missing/node-pty.js',
      baseEnv: {},
    });
    assert.equal(
      worker.surface.capabilities().registryAuthority.includes('v3'),
      true,
    );
    if (socketRoot) {
      assert.equal((await stat(socketRoot)).mode & 0o777, 0o700);
    }
    assert.deepEqual(worker.runtime.list(), []);
  } finally {
    await worker?.close();
    await rm(root, { recursive: true, force: true });
    if (socketRoot) await rm(socketRoot, { recursive: true, force: true });
  }
});
