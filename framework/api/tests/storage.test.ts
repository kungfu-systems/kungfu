import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.deepEqual(
    storage.kfxRegistry('assess', {
      ...registryRequest,
      packageKey: 'example',
    }),
    { ok: true },
  );
  assert.deepEqual(calls, [
    ['kfx_runtime', '/runtime', { action: 'contract' }],
    [
      'kfx_runtime',
      '/runtime',
      { action: 'validate', kind: 'request', document },
    ],
    ['kfx_runtime', '/runtime', { action: 'plan', request: registryRequest }],
    [
      'kfx_runtime',
      '/runtime',
      {
        action: 'assess',
        request: { ...registryRequest, packageKey: 'example' },
      },
    ],
  ]);
});

test('GUI and Agent storage edge preserve the published Buildchain KFX projection and Core report root', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      new URL(
        '../../core/src/libkungfu/tests/fixtures/native_kfx_contract/buildchain-2.13.0-alpha.0-envelope.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const calls: unknown[][] = [];
  const coreResult = {
    trustReport: { reportRoot: fixture.expected.coreReportRoot },
  };
  const binding = {
    runStorageServiceOperation: (
      operation: string,
      runtimeDir: string,
      options: Record<string, unknown> = {},
    ) => {
      calls.push([operation, runtimeDir, options]);
      return coreResult;
    },
  } as unknown as KfNativeBinding;
  const storage = openStorage({ binding, locator: { runtimeDir: '/runtime' } });
  const request = {
    roots: [{ kind: 'workspace', path: '/workspace/extensions' }],
    ...fixture.admission,
    assessmentTime: fixture.assessmentTime,
    attestation: fixture.projection.attestation,
    trustInputs: fixture.projection.trustInputs,
    kfdAssessment: fixture.projection.kfdAssessment,
  };

  assert.strictEqual(storage.kfxRegistry('assess', request), coreResult);
  assert.deepEqual(calls, [
    ['kfx_runtime', '/runtime', { action: 'assess', request }],
  ]);
  assert.equal(
    coreResult.trustReport.reportRoot,
    fixture.expected.coreReportRoot,
  );
});
