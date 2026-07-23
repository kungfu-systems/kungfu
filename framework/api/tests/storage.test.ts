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

test('Episode Admission API is a thin projection over the native destination operation', () => {
  const calls: unknown[][] = [];
  const binding = {
    runStorageServiceOperation: (
      operation: string,
      runtimeDir: string,
      options: Record<string, unknown> = {},
    ) => {
      calls.push([operation, runtimeDir, options]);
      return { ok: true, planRoot: 'sha256:plan' };
    },
  } as unknown as KfNativeBinding;
  const storage = openStorage({
    binding,
    locator: { runtimeDir: '/destination' },
  });
  const values = {
    initiator: 'source-push',
    transport: 'local-direct',
    source_runtime_dir: '/source',
    episode_ids: [41, 42],
  };

  assert.deepEqual(storage.episodeAdmission('plan', values), {
    ok: true,
    planRoot: 'sha256:plan',
  });
  assert.deepEqual(calls, [
    ['episode_admission', '/destination', { action: 'plan', ...values }],
  ]);
});

test('Fact kernel API preserves the generic action request without product vocabulary', () => {
  const calls: unknown[][] = [];
  const binding = {
    runStorageServiceOperation: (
      operation: string,
      runtimeDir: string,
      options: Record<string, unknown> = {},
    ) => {
      calls.push([operation, runtimeDir, options]);
      return { ok: true, schema: 'kungfu.fact-kernel.state/v1' };
    },
  } as unknown as KfNativeBinding;
  const storage = openStorage({ binding, locator: { runtimeDir: '/runtime' } });

  assert.deepEqual(
    storage.factKernel('query', {
      ref_name: 'profiles/work',
      include_bodies: true,
    }),
    { ok: true, schema: 'kungfu.fact-kernel.state/v1' },
  );
  assert.deepEqual(calls, [
    [
      'fact_kernel',
      '/runtime',
      {
        action: 'query',
        ref_name: 'profiles/work',
        include_bodies: true,
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
