// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ElectronUpdaterLike,
  createElectronUpdaterAdapter,
} from './electron-updater-adapter';
import type { DesktopUpdaterEvent, ReleaseManifest } from './update-controller';

const manifest: ReleaseManifest = {
  schema: 'kungfu.product-upgrade.manifest/v1',
  productVersion: '4.0.0-alpha.1',
  runtimeBuildId: 'runtime-b',
  documentationUrl: 'https://www.kungfu.tech/docs/guides/upgrading',
};

test('electron-updater adapter disables implicit download and install', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const calls: string[] = [];
  const raw: ElectronUpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event) {
      listeners.delete(event);
    },
    async checkForUpdates() {
      calls.push('check');
    },
    async downloadUpdate() {
      calls.push('download');
    },
    quitAndInstall(silent, forceRunAfter) {
      calls.push(`install:${silent}:${forceRunAfter}`);
    },
  };
  const resolvedVersions: string[] = [];
  const adapter = createElectronUpdaterAdapter(raw, async (info) => {
    resolvedVersions.push(info.version);
    return manifest;
  });
  const events: DesktopUpdaterEvent[] = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));

  assert.equal(raw.autoDownload, false);
  assert.equal(raw.autoInstallOnAppQuit, false);
  assert.equal(raw.allowDowngrade, false);
  listeners.get('update-available')?.({ version: manifest.productVersion });
  await new Promise<void>((resolve) => setImmediate(resolve));
  listeners.get('update-downloaded')?.({
    version: manifest.productVersion,
    downloadedFile: '/tmp/update.zip',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await adapter.checkForUpdates();
  await adapter.downloadUpdate();
  adapter.quitAndInstall();

  assert.deepEqual(resolvedVersions, [manifest.productVersion]);
  assert.deepEqual(
    events.map((event) => event.type),
    ['update-available', 'update-downloaded'],
  );
  assert.deepEqual(calls, ['check', 'download', 'install:false:true']);
  unsubscribe();
  assert.equal(listeners.size, 0);
});

test('release-manifest resolution errors stay on the adapter event surface', async () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const raw: ElectronUpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener() {},
    async checkForUpdates() {},
    async downloadUpdate() {},
    quitAndInstall() {},
  };
  const adapter = createElectronUpdaterAdapter(raw, async () => {
    throw new Error('release manifest signature is invalid');
  });
  const events: DesktopUpdaterEvent[] = [];
  adapter.subscribe((event) => events.push(event));

  listeners.get('update-available')?.({ version: '4.0.0-alpha.1' });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    { type: 'error', message: 'release manifest signature is invalid' },
  ]);
});
