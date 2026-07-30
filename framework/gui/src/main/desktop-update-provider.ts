// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoUpdater } from 'electron-updater';
import {
  type ElectronUpdaterLike,
  createElectronUpdaterAdapter,
} from './electron-updater-adapter';
import {
  type ReleaseManifestFetch,
  assertPublishedReleaseManifest,
  createPublishedReleaseManifestResolver,
} from './release-manifest-resolver';
import { createRuntimeUpgradeCliBridge } from './runtime-upgrade-cli';
import {
  type DesktopUpdateState,
  type DesktopUpdateStateStore,
  type ReleaseManifest,
  type RuntimeUpgradeBridge,
  UpdateController,
} from './update-controller';
import { createFileUpdateStateStore } from './update-state-store';

const RELEASE_BASE_URL =
  'https://github.com/kungfu-systems/kungfu/releases/download';
const MAX_BUNDLED_MANIFEST_BYTES = 1024 * 1024;

type DesktopUpdateProviderOptions = {
  resourcesPath: string;
  userDataPath: string;
  runtimeBin: string;
  runtimeEnv: NodeJS.ProcessEnv;
  productVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  updater?: ElectronUpdaterLike;
  fetch?: ReleaseManifestFetch;
  core?: RuntimeUpgradeBridge;
  store?: DesktopUpdateStateStore;
};

export type ProductionDesktopUpdateProvider = {
  start(): void;
  stop(): void;
  snapshot(): DesktopUpdateState;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  applyDownloadedUpdate(): Promise<DesktopUpdateState>;
  reconcileBundledRuntime(
    readinessProbe: () => Promise<boolean>,
  ): Promise<DesktopUpdateState>;
};

function readBundledReleaseManifest(
  manifestFile: string,
  productVersion: string,
  platform: NodeJS.Platform,
  architecture: string,
): ReleaseManifest {
  const payload = readFileSync(manifestFile, 'utf8');
  if (Buffer.byteLength(payload, 'utf8') > MAX_BUNDLED_MANIFEST_BYTES) {
    throw new Error('Bundled release manifest exceeds the size limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch (error) {
    throw new Error(
      `Bundled release manifest is invalid JSON: ${(error as Error).message}`,
    );
  }
  assertPublishedReleaseManifest(value, productVersion, platform, architecture);
  return value;
}

export function createProductionDesktopUpdateProvider(
  options: DesktopUpdateProviderOptions,
): ProductionDesktopUpdateProvider {
  const stateDir = path.join(options.userDataPath, 'upgrade');
  const bundledRuntimeRoot = path.join(options.resourcesPath, 'kungfu');
  const bundledManifestFile = path.join(
    options.resourcesPath,
    'upgrade',
    'kungfu-release-manifest.json',
  );
  const resolveReleaseManifest = createPublishedReleaseManifestResolver({
    fetch: options.fetch ?? ((url) => fetch(url)),
    releaseBaseUrl: RELEASE_BASE_URL,
    platform: options.platform,
    architecture: options.architecture,
  });
  const updater = createElectronUpdaterAdapter(
    options.updater ?? (autoUpdater as unknown as ElectronUpdaterLike),
    resolveReleaseManifest,
  );
  const controller = new UpdateController({
    updater,
    core:
      options.core ??
      createRuntimeUpgradeCliBridge({
        bin: options.runtimeBin,
        env: options.runtimeEnv,
        stateDir,
      }),
    store:
      options.store ??
      createFileUpdateStateStore(path.join(stateDir, 'desktop-update.json')),
  });

  return {
    start: () => controller.start(),
    stop: () => controller.stop(),
    snapshot: () => controller.snapshot(),
    checkForUpdates: () => controller.checkForUpdates(),
    downloadUpdate: () => controller.downloadUpdate(),
    applyDownloadedUpdate: () => controller.applyDownloadedUpdate(),
    async reconcileBundledRuntime(readinessProbe) {
      const manifest = readBundledReleaseManifest(
        bundledManifestFile,
        options.productVersion,
        options.platform,
        options.architecture,
      );
      return await controller.reconcileBundledRuntime(
        manifest,
        bundledRuntimeRoot,
        readinessProbe,
      );
    },
  };
}
