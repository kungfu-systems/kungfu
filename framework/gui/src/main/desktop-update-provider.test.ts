// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProductionDesktopUpdateProvider } from './desktop-update-provider';
import type { ElectronUpdaterLike } from './electron-updater-adapter';
import type {
  DesktopUpdateState,
  RuntimeUpgradeBridge,
} from './update-controller';

function rawUpdater(calls: string[]): ElectronUpdaterLike {
  return {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    on() {},
    removeListener() {},
    async checkForUpdates() {
      calls.push('check');
    },
    async downloadUpdate() {
      calls.push('download');
    },
    quitAndInstall() {
      calls.push('install');
    },
  };
}

function inertCore(): RuntimeUpgradeBridge {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected Core call');
  };
  return {
    installBundledRuntime: unexpected,
    plan: unexpected,
    stage: unexpected,
    reconcile: unexpected,
  };
}

test('production provider construction disables implicit updater actions', () => {
  const calls: string[] = [];
  const updater = rawUpdater(calls);
  const root = mkdtempSync(path.join(tmpdir(), 'kungfu-provider-'));
  const provider = createProductionDesktopUpdateProvider({
    resourcesPath: path.join(root, 'resources'),
    userDataPath: path.join(root, 'user-data'),
    runtimeBin: '/unused/kungfu',
    runtimeEnv: {},
    productVersion: '4.0.0-alpha.1',
    platform: 'darwin',
    architecture: 'arm64',
    updater,
    core: inertCore(),
    store: { load: () => null, save() {} },
  });

  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  assert.deepEqual(calls, []);
  assert.equal(provider.snapshot().phase, 'idle');
  provider.start();
  provider.stop();
  assert.deepEqual(calls, []);
});

test('bundled reconciliation rejects unqualified manifests before Core', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kungfu-provider-'));
  const resourcesPath = path.join(root, 'resources');
  const manifestDir = path.join(resourcesPath, 'upgrade');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    path.join(manifestDir, 'kungfu-release-manifest.json'),
    JSON.stringify({
      schema: 'kungfu.product-upgrade.manifest/v1',
      productVersion: '4.0.0-alpha.1',
      runtimeBuildId: 'runtime-a',
      documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
      platform: 'darwin',
      architecture: 'arm64',
      sourceCommit: '1'.repeat(40),
      qualificationEvidenceRef: 'unqualified-local-build:fixture',
      artifacts: [
        {
          kind: 'runtime',
          url: 'app-resource://kungfu',
          signature: 'sigstore:runtime',
        },
        {
          kind: 'desktop',
          url: 'https://example.invalid/app.zip',
          signature: 'apple:notarization-ticket',
        },
      ],
    }),
  );
  let saved: DesktopUpdateState | null = null;
  const provider = createProductionDesktopUpdateProvider({
    resourcesPath,
    userDataPath: path.join(root, 'user-data'),
    runtimeBin: '/unused/kungfu',
    runtimeEnv: {},
    productVersion: '4.0.0-alpha.1',
    platform: 'darwin',
    architecture: 'arm64',
    updater: rawUpdater([]),
    core: inertCore(),
    store: {
      load: () => null,
      save(state) {
        saved = state;
      },
    },
  });

  await assert.rejects(
    provider.reconcileBundledRuntime(async () => true),
    /is not qualified/,
  );
  assert.equal(saved, null);
  assert.equal(provider.snapshot().phase, 'idle');
});
