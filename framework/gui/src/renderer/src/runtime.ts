// Runtime access for the reference app: load the native kungfu binding
// in-process (nodeIntegration renderer) and boot the shared handles that
// kfx views consume. This is the moat: the renderer reaches the runtime
// directly, no IPC copy.

declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

export type KfLocation = {
  category: string;
  group: string;
  name: string;
  mode: string;
};

export type KfConfigStore = {
  setConfig: (
    category: string,
    group: string,
    name: string,
    mode: string,
    value: string,
  ) => boolean;
  removeConfig: (
    category: string,
    group: string,
    name: string,
    mode: string,
  ) => boolean;
  getAllConfig: () => Record<string, Record<string, unknown>>;
};

export type KfWatcher = {
  isUsable: () => boolean;
  isLive: () => boolean;
  isStarted: () => boolean;
  start: () => void;
};

export type KfFrame = {
  genTime: () => bigint;
  triggerTime: () => bigint;
  msgType: () => number;
  source: () => number;
  dest: () => number;
  dataLength: () => number;
};

export type Kfe = {
  Longfist: new () => { types: Record<string, () => Record<string, unknown>> };
  ConfigStore: new (runtimeDir: string) => KfConfigStore;
  SessionStore: new (
    location: KfLocation,
    runtimeDir: string,
  ) => { getAllSessions: () => unknown };
  IODevice: new (
    location: KfLocation,
    runtimeDir: string,
  ) => { getAllLocations: () => Record<string, Record<string, unknown>> };
  Watcher: new (
    runtimeDir: string,
    name: string,
    bypassRestore: boolean,
    bypassAccounting: boolean,
    bypassTradingData: boolean,
    refreshTradingDataBeforeSync: boolean,
    bypassRefreshBook: boolean,
    millisecondsSleepAfterStep: number,
  ) => KfWatcher;
  Assemble: new (
    runtimeDirs: string[],
  ) => {
    dataAvailable: () => boolean;
    next: () => void;
    currentFrame: () => KfFrame;
  };
  formatTime?: (nano: bigint, format?: string) => string;
};

export const bigintSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

export const APP_LOCATION: KfLocation = {
  category: 'system',
  group: 'node',
  name: 'reference_app',
  mode: 'live',
};

export type Runtime = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kfcVersion: string;
  buildInfo: Record<string, unknown> | null;
  exports: string[];
  kfe: Kfe | null;
  watcher: KfWatcher | null;
  watcherState: string;
};

export function bootRuntime(): Runtime {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const base: Omit<Runtime, 'ok' | 'message'> = {
    runtimeDir,
    kfcVersion: env.KFC_VERSION || '',
    buildInfo: null,
    exports: [],
    kfe: null,
    watcher: null,
    watcherState: 'not constructed',
  };
  try {
    const bindingPath = env.KFE_PATH;
    if (!bindingPath) {
      return { ...base, ok: false, message: 'KFE_PATH not set' };
    }
    const kfe = window.require(bindingPath) as Kfe;
    let buildInfo: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const path = window.require('node:path');
      buildInfo = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(bindingPath), 'kungfubuildinfo.json'),
          'utf8',
        ),
      );
    } catch {
      buildInfo = null;
    }
    // Constructing a Watcher initializes the runtime home (profile db layout)
    // so stores work against a fresh directory. Starting it joins a live
    // master when one is running.
    let watcher: KfWatcher | null = null;
    let watcherState = 'not constructed';
    try {
      watcher = new kfe.Watcher(
        runtimeDir,
        APP_LOCATION.name,
        true,
        true,
        true,
        false,
        true,
        50,
      );
      watcherState = `constructed · usable=${watcher.isUsable()}`;
    } catch (e) {
      watcherState = `failed: ${(e as Error).message}`;
    }
    return {
      ...base,
      ok: true,
      message: `in-process binding loaded · ${Object.keys(kfe).length} exports`,
      buildInfo,
      exports: Object.keys(kfe),
      kfe,
      watcher,
      watcherState,
    };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message };
  }
}
