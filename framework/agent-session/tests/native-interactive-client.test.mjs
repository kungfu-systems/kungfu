import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ensureNativeInteractiveSessionSurface } from '../src/native-interactive-client.mjs';

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
          return { schema: 'kungfu.agent-session.capabilities/v1' };
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
