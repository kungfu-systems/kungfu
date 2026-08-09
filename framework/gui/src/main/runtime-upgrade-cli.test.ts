// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRuntimeUpgradeCliBridge } from './runtime-upgrade-cli';
import type {
  ReleaseManifest,
  RuntimeUpgradePlan,
  RuntimeUpgradeReceipt,
} from './update-controller';

const manifest: ReleaseManifest = {
  schema: 'kungfu.product-upgrade.manifest/v1',
  productVersion: '4.0.0-alpha.1',
  runtimeBuildId: 'runtime-b',
  documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
};

test('CLI bridge stays inside runtime upgrade and carries stale-plan fences', async () => {
  const calls: string[][] = [];
  const outputs = [
    { state: 'download-allowed', planId: 'install-plan' },
    { state: 'verified', buildId: 'runtime-b' },
    {
      schema: 'kungfu.runtime-upgrade-plan/v1',
      planId: 'activation-plan',
      state: 'apply-now',
      reasonCode: 'workspace-idle',
      activeGeneration: '7',
      impact: {
        activeWorkContinues: false,
        activationTiming: 'now',
        userActionRequired: false,
      },
      nextAction: 'activate',
    } satisfies RuntimeUpgradePlan,
    {
      schema: 'kungfu.runtime-upgrade-receipt/v1',
      receiptId: 'receipt-1',
      planId: 'activation-plan',
      state: 'reconciling',
      reasonCode: 'workspace-idle',
    } satisfies RuntimeUpgradeReceipt,
    {
      schema: 'kungfu.runtime-upgrade-receipt/v1',
      receiptId: 'receipt-1',
      planId: 'activation-plan',
      state: 'complete',
      reasonCode: 'workspace-idle',
    } satisfies RuntimeUpgradeReceipt,
  ];
  const bridge = createRuntimeUpgradeCliBridge({
    bin: '/runtime/kungfu',
    env: { KF_CONFIG_HOME: '/config' },
    stateDir: mkdtempSync(path.join(tmpdir(), 'kungfu-desktop-update-')),
    execFile: ((
      file: string,
      args: readonly string[],
      options: { env: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      assert.equal(file, '/runtime/kungfu');
      assert.equal(options.env.KF_CONFIG_HOME, '/config');
      calls.push(args as string[]);
      callback(null, JSON.stringify(outputs.shift()), '');
    }) as never,
  });

  await bridge.installBundledRuntime(manifest, '/app/Resources/kungfu');
  const activationPlan = await bridge.plan(manifest);
  const staged = await bridge.stage(activationPlan);
  await bridge.reconcile(staged, true);

  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ['runtime', 'upgrade', 'plan-install'],
      ['runtime', 'upgrade', 'install'],
      ['runtime', 'upgrade', 'plan'],
      ['runtime', 'upgrade', 'stage'],
      ['runtime', 'upgrade', 'reconcile'],
    ],
  );
  assert.ok(calls[1].includes('install-plan'));
  assert.ok(calls[3].includes('activation-plan'));
  assert.ok(calls[3].includes('7'));
  assert.ok(calls[4].includes('yes'));
  const manifestFile = calls[0][3];
  assert.equal(
    JSON.parse(readFileSync(manifestFile, 'utf8')).runtimeBuildId,
    'runtime-b',
  );
});
