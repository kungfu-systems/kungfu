// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  KfxRuntimeWarrant,
  KfxRuntimeWarrantAdoption,
  KfxRuntimeWarrantAuthorization,
} from '@kungfu-tech/api/capability';
import type { KfxServicePlanEntry } from '@kungfu-tech/kfx';

import {
  launchDiscoveredService,
  resolveServiceRuntime,
} from './service-host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const FIXTURE_DIR = join(HERE, 'test-fixtures');
const PYTHON_ENTRY = 'python-asyncio-service.py';
const root = (char: string) => `sha256:${char.repeat(64)}`;

function deadline(message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 10_000);
    timer.unref();
  });
}

function authorization(
  runtimeTier: KfxRuntimeWarrantAuthorization['runtimeTier'],
): KfxRuntimeWarrantAuthorization {
  const capabilities = ['ledger', 'network', 'process'];
  return {
    schema: 'kungfu.kfx.host-authorization/v2',
    packageKey: 'fixture.python-asyncio-service',
    packageRoot: root('1'),
    manifestRoot: root('2'),
    ownerProviderRoot: root('3'),
    trustRoot: root('4'),
    runtimeTier,
    admissionGrade: 'kfd-attested',
    placement: 'service-python',
    requiredCapabilities: capabilities,
    grantedCapabilities: capabilities,
    reportRoot: root('5'),
    admissionPlanRoot: root('6'),
    corePolicyRoot: root('7'),
    requestedPolicyRoot: root('8'),
    policyRoot: root('9'),
    authorizationPlanRoot: root('a'),
    capabilityDeclarationRoot: root('b'),
    capabilityGrantRoot: root('c'),
    warrantRoot: root('d'),
    cutRoot: root('e'),
    revision: 1,
    generationRoot: root('f'),
    executionAllowed: true,
    authorizationRoot: root('0'),
    host: 'service-python',
  };
}

function runtimeWarrant(events: string[] = []): KfxRuntimeWarrant {
  return {
    adopt: (exact, request) => {
      events.push('adopt');
      return {
        schema: 'kungfu.kfx.runtime-warrant-adoption/v1',
        executionAllowed: true,
        runtimeWarrant: {
          schema: 'kungfu.kfx.runtime-warrant/v1',
          warrantRoot: root('1'),
          packageKey: exact.packageKey,
          host: exact.host,
          holder: request.holder,
          capabilityGrantRoot: exact.capabilityGrantRoot ?? root('2'),
          hostAuthorizationRoot: exact.authorizationRoot,
          mutationWarrantRoot: exact.warrantRoot ?? root('3'),
          expiresAt: request.expiresAt,
          heartbeatTtl: request.heartbeatTtl,
        },
        leaseState: {
          schema: 'kungfu.kfx.runtime-lease-state-fact/v1',
          warrantRoot: root('1'),
          packageKey: exact.packageKey,
          host: exact.host,
          holder: request.holder,
          generation: 1,
          fencingToken: root('4'),
          state: 'active',
          heartbeatAt: request.issuedAt,
          heartbeatDeadline: request.issuedAt + request.heartbeatTtl,
          expiresAt: request.expiresAt,
        },
        recovery: null,
        receipt: {},
      } satisfies KfxRuntimeWarrantAdoption;
    },
    heartbeat: () => {
      events.push('heartbeat');
      return {
        schema: 'kungfu.kfx.runtime-warrant-transition/v1',
        event: 'heartbeat',
        leaseState: { state: 'active' },
        receipt: {},
      };
    },
    settle: () => {
      events.push('settle');
      return {
        schema: 'kungfu.kfx.runtime-warrant-transition/v1',
        event: 'settled',
        leaseState: { state: 'settled' },
        receipt: {},
      };
    },
  };
}

const entry: KfxServicePlanEntry = {
  id: 'fixture.python-asyncio-service',
  facet: 'service',
  capabilities: ['ledger', 'network', 'process'],
  product: { roles: ['devtool'] },
  executionAllowed: true,
  authorizationRoot: root('0'),
  dir: FIXTURE_DIR,
  source: 'built-in',
  runtimes: ['python'],
  entry: { python: PYTHON_ENTRY },
};

test('Python runtime resolution carries exact rooted metadata', () => {
  const exact = authorization('isolated');
  const runtime = resolveServiceRuntime(
    entry,
    'unused.mjs',
    entry.capabilities,
    {
      command: '/qualified/python',
      path: '/qualified/pythonpath',
      shutdownTimeoutMs: 2_000,
      authorization: exact,
    },
  );
  assert.equal(runtime.command, '/qualified/python');
  assert.deepEqual(runtime.args, ['-m', 'kungfu.kfx_host']);
  assert.equal(runtime.env.KFX_SERVICE_ENTRY, join(FIXTURE_DIR, PYTHON_ENTRY));
  assert.equal(
    runtime.env.KFX_SERVICE_AUTHORIZATION_ROOT,
    exact.authorizationRoot,
  );
  assert.equal(
    runtime.env.KFX_SERVICE_CAPABILITY_GRANT_ROOT,
    exact.capabilityGrantRoot,
  );
  assert.equal(runtime.env.KFX_SERVICE_GENERATION_ROOT, exact.generationRoot);
  assert.equal(runtime.env.PYTHONPATH, '/qualified/pythonpath');
});

test('Python launch refuses capabilities outside the exact Core grant', async () => {
  const narrowed = {
    ...authorization('integrated-explicit'),
    requiredCapabilities: ['ledger'],
    grantedCapabilities: ['ledger'],
  };
  await assert.rejects(
    launchDiscoveredService(entry, {
      caps: { ledger: {} },
      authorization: narrowed,
      runtimeWarrant: runtimeWarrant(),
    }),
    /KF_KFX_HOST_NOT_AUTHORIZED/,
  );
});

test('integrated-explicit Python service uses standard asyncio in a separate process', async () => {
  const warrantEvents: string[] = [];
  const reports: Array<Record<string, unknown>> = [];
  let resolveRunning: (() => void) | undefined;
  let resolveStopped: (() => void) | undefined;
  let releaseRunningResult: (() => void) | undefined;
  const running = new Promise<void>((resolvePromise) => {
    resolveRunning = resolvePromise;
  });
  const stopped = new Promise<void>((resolvePromise) => {
    resolveStopped = resolvePromise;
  });
  const runningResultReleased = new Promise<void>((resolvePromise) => {
    releaseRunningResult = resolvePromise;
  });
  const caps = {
    ledger: {
      records: ({ limit }: { limit: number }) =>
        Array.from({ length: limit }, (_value, index) => ({ index })),
      result: async (report: Record<string, unknown>) => {
        reports.push(report);
        if (report.phase === 'running') {
          resolveRunning?.();
          await runningResultReleased;
        }
        if (report.phase === 'stopped') resolveStopped?.();
      },
    },
    network: {},
    process: {},
  };
  const pythonPath = [
    join(ROOT, 'framework/core/build/Release'),
    join(ROOT, 'framework/core/src/python'),
  ].join(delimiter);
  const service = await launchDiscoveredService(entry, {
    caps,
    authorization: authorization('integrated-explicit'),
    runtimeWarrant: runtimeWarrant(warrantEvents),
    runtimeWarrantHeartbeatTtlMs: 20,
    pythonCommand:
      process.env.KUNGFU_PYTHON_BIN ??
      (process.platform === 'win32' ? 'python' : 'python3'),
    pythonPath,
    pythonShutdownTimeoutMs: 2_000,
  });
  try {
    await Promise.race([running, deadline('Python service did not report')]);
    assert.deepEqual(reports[0], {
      phase: 'running',
      future: 'future',
      timeout: 'timed-out',
      cancellation: 'cancelled',
      network: 'pong',
      process: 'subprocess-ok',
      concurrentRelayCounts: [1, 2],
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));

    service.dispose();
    releaseRunningResult?.();
    await Promise.race([
      stopped,
      deadline('Python service did not stop gracefully'),
    ]);
    assert.equal(await service.done, 0);
    assert.deepEqual(reports.at(-1), { phase: 'stopped' });
    assert.equal(warrantEvents[0], 'adopt');
    assert.ok(warrantEvents.includes('heartbeat'));
    assert.equal(warrantEvents.at(-1), 'settle');
  } finally {
    // A failed readiness assertion must not strand the Python child and keep
    // the Node test process alive. This is especially important on Windows,
    // where the runner cannot reclaim inherited pipe handles until the child
    // has crossed its graceful-shutdown boundary.
    releaseRunningResult?.();
    service.dispose();
    await Promise.race([
      service.done,
      deadline('Python service cleanup did not finish'),
    ]).catch(() => undefined);
  }
});
