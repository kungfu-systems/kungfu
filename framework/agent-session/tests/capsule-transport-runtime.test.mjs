import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CapsuleTransportUnavailableError,
  createCapsuleNodePtyLoader,
} from '../src/capsule-transport-runtime.mjs';
import { detachedAgentSessionPaths } from '../src/product-client.mjs';
import { runAgentSessionProductWorker } from '../src/product-worker.mjs';

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
