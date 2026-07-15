import assert from 'node:assert/strict';
import test from 'node:test';
import { openStorage } from '../src/capability/storage.ts';
import type { KfNativeBinding } from '../src/capability/types.ts';

test('native KFX helpers are transport-only storage edge calls', () => {
  const calls: unknown[][] = [];
  const binding = {
    runStorageServiceOperation: (
      operation: string,
      runtimeDir: string,
      options: Record<string, unknown> = {},
    ) => {
      calls.push([operation, runtimeDir, options]);
      return { ok: true };
    },
  } as unknown as KfNativeBinding;
  const storage = openStorage({ binding, locator: { runtimeDir: '/runtime' } });
  const document = {
    schema: 'kungfu.kfx.native-request/v1',
    contractVersion: 1,
    operation: 'inspect',
    packagePath: 'extensions/example',
    requestedCapabilities: [],
  };

  assert.deepEqual(storage.kfxRuntimeContract(), { ok: true });
  assert.deepEqual(storage.validateKfxRuntimeDocument('request', document), {
    ok: true,
  });
  const registryRequest = {
    roots: [{ kind: 'workspace', path: '/workspace/extensions' }],
  };
  assert.deepEqual(storage.kfxRegistry('plan', registryRequest), { ok: true });
  assert.deepEqual(calls, [
    ['kfx_runtime', '/runtime', { action: 'contract' }],
    [
      'kfx_runtime',
      '/runtime',
      { action: 'validate', kind: 'request', document },
    ],
    ['kfx_runtime', '/runtime', { action: 'plan', request: registryRequest }],
  ]);
});
