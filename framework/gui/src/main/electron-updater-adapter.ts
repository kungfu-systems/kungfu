// SPDX-License-Identifier: Apache-2.0

import type {
  DesktopUpdateInfo,
  DesktopUpdater,
  ReleaseManifest,
} from './update-controller';

type ElectronUpdateInfo = {
  version: string;
  downloadedFile?: string;
  [key: string]: unknown;
};

type ElectronProgressInfo = {
  percent: number;
};

type ElectronUpdaterListener = (...args: unknown[]) => void;

export type ElectronUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: string, listener: ElectronUpdaterListener): unknown;
  removeListener(event: string, listener: ElectronUpdaterListener): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

type ReleaseManifestResolver = (
  info: ElectronUpdateInfo,
) => Promise<ReleaseManifest>;

export function createElectronUpdaterAdapter(
  updater: ElectronUpdaterLike,
  resolveReleaseManifest: ReleaseManifestResolver,
): DesktopUpdater {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  const manifestCache = new Map<string, Promise<ReleaseManifest>>();
  const manifestFor = (info: ElectronUpdateInfo) => {
    let pending = manifestCache.get(info.version);
    if (!pending) {
      pending = resolveReleaseManifest(info);
      manifestCache.set(info.version, pending);
    }
    return pending;
  };

  return {
    subscribe(listener) {
      const bindings = new Map<string, ElectronUpdaterListener>();
      const bind = (event: string, handler: ElectronUpdaterListener) => {
        bindings.set(event, handler);
        updater.on(event, handler);
      };
      const emitInfo = async (
        type: 'update-available' | 'update-downloaded',
        raw: unknown,
      ) => {
        const info = raw as ElectronUpdateInfo;
        try {
          const releaseManifest = await manifestFor(info);
          const payload: DesktopUpdateInfo = {
            version: info.version,
            releaseManifest,
            downloadedFile:
              typeof info.downloadedFile === 'string'
                ? info.downloadedFile
                : undefined,
          };
          listener({ type, info: payload });
        } catch (error) {
          listener({ type: 'error', message: (error as Error).message });
        }
      };

      bind('checking-for-update', () =>
        listener({ type: 'checking-for-update' }),
      );
      bind('update-not-available', () =>
        listener({ type: 'update-not-available' }),
      );
      bind(
        'update-available',
        (info) => void emitInfo('update-available', info),
      );
      bind(
        'update-downloaded',
        (info) => void emitInfo('update-downloaded', info),
      );
      bind('download-progress', (raw) => {
        const progress = raw as ElectronProgressInfo;
        listener({ type: 'download-progress', percent: progress.percent });
      });
      bind('error', (raw) => {
        const message = raw instanceof Error ? raw.message : String(raw);
        listener({ type: 'error', message });
      });

      return () => {
        for (const [event, handler] of bindings) {
          updater.removeListener(event, handler);
        }
      };
    },

    async checkForUpdates() {
      await updater.checkForUpdates();
    },

    async downloadUpdate() {
      await updater.downloadUpdate();
    },

    quitAndInstall() {
      updater.quitAndInstall(false, true);
    },
  };
}
