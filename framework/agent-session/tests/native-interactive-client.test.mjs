import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureNativeInteractiveSessionSurface } from '../src/native-interactive-client.mjs';

const nativeCapabilities = {
  schema: 'kungfu.agent-session.surface-capabilities/v1',
  actions: [
    'capabilities',
    'show',
    'plan-native-start',
    'start-native',
    'heartbeat-native',
    'project-native-work',
    'end-native',
  ],
};

test('provider-native bootstrap resolves the default source worker', async () => {
  const calls = [];
  const endpoint = await ensureNativeInteractiveSessionSurface({
    runtimeDir: '/tmp/kungfu-native-default-worker',
    env: {},
    createHost(options) {
      calls.push(options);
      return {
        endpoint: '/tmp/native-agent-session.sock',
        async invoke(request) {
          assert.deepEqual(request, { operation: 'capabilities' });
          return nativeCapabilities;
        },
      };
    },
  });
  assert.equal(endpoint, '/tmp/native-agent-session.sock');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].workerPath,
    fileURLToPath(new URL('../src/product-worker.mjs', import.meta.url)),
  );
});

test('provider-native bootstrap does not resolve or forward node-pty', async () => {
  const calls = [];
  const endpoint = await ensureNativeInteractiveSessionSurface({
    runtimeDir: '/tmp/kungfu-native-provider-first',
    env: {
      KUNGFU_AGENT_SESSION_NODE_PTY_MODULE: '/must/not/be/forwarded.js',
      KUNGFU_AGENT_SESSION_WORKER: '/tmp/native-worker.mjs',
    },
    createHost(options) {
      calls.push(options);
      return {
        endpoint: '/tmp/native-agent-session.sock',
        async invoke(request) {
          assert.deepEqual(request, { operation: 'capabilities' });
          return nativeCapabilities;
        },
      };
    },
  });
  assert.equal(endpoint, '/tmp/native-agent-session.sock');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workerPath, path.resolve('/tmp/native-worker.mjs'));
  assert.equal(
    Object.hasOwn(calls[0].env, 'KUNGFU_AGENT_SESSION_NODE_PTY_MODULE'),
    false,
  );
});

test('provider-native bootstrap rejects an incompatible live operation vocabulary', async () => {
  await assert.rejects(
    ensureNativeInteractiveSessionSurface({
      runtimeDir: '/tmp/kungfu-native-stale-worker',
      env: {},
      createHost() {
        return {
          endpoint: '/tmp/native-agent-session.sock',
          async invoke() {
            return {
              schema: 'kungfu.agent-session.surface-capabilities/v1',
              actions: ['capabilities', 'show'],
            };
          },
        };
      },
    }),
    /Agent Session protocol mismatch: missing operations:.*plan-native-start.*Project data does not need to be deleted/u,
  );
});
