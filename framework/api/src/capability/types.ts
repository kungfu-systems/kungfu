// Capability SDK types (ADR-0011). Two vocabulary domains over one SDK:
// ledger vocabulary for runtime event data, domain vocabulary for domain
// state. Neither leaks storage-engine terms into the public surface.

// --- locator -----------------------------------------------------------
// The locator expresses the home/runtime directory layering explicitly
// (ADR-0011 §4): a kungfu home contains a runtime directory; tools that are
// handed a home must not guess.

export type KfLocator =
  | { runtimeDir: string }
  | { home: string; runtime?: string };

export function resolveRuntimeDir(locator: KfLocator): string {
  if ('runtimeDir' in locator) return locator.runtimeDir;
  return `${locator.home}/${locator.runtime ?? 'runtime'}`;
}

// --- enum mapping ------------------------------------------------------
// Enum-to-name mapping lives in the SDK, not in each consumer (ADR-0011 §4).

export const CATEGORY_NAMES = ['md', 'td', 'strategy', 'system'] as const;
export const MODE_NAMES = ['live', 'data', 'replay', 'backtest'] as const;

export type KfCategory = (typeof CATEGORY_NAMES)[number];
export type KfMode = (typeof MODE_NAMES)[number];

export function categoryName(value: number | string): string {
  return CATEGORY_NAMES[Number(value)] ?? String(value);
}

export function modeName(value: number | string): string {
  return MODE_NAMES[Number(value)] ?? String(value);
}

export type KfLocation = {
  category: KfCategory | string;
  group: string;
  name: string;
  mode: KfMode | string;
};

// --- serialization -----------------------------------------------------
// 64-bit identifiers cross the boundary as BigInt with a defined
// serialization rule (ADR-0011 §4): decimal strings.

export function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function toSerializable<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, bigintSafe));
}

// --- ledger domain -----------------------------------------------------

export type LedgerRecord = {
  // Generation and trigger clocks in nanoseconds; the trigger clock is the
  // recorded causal anchor of the event pair.
  genTime: bigint;
  triggerTime: bigint;
  msgType: number;
  source: number;
  dest: number;
  dataLength: number;
};

export type RecordFilter = {
  msgType?: number;
  sinceNanos?: bigint;
  limit?: number;
};

export type ReplayAnchor = {
  location: KfLocation;
  beginTime: bigint;
  endTime: bigint;
  frameCount: bigint;
  dataSize: bigint;
};

// Live-bus health is a first-class queryable signal (ADR-0011 §4), not a
// log line.
export type LiveHealth = {
  joined: boolean;
  live: boolean;
  usable: boolean;
};

export type Subscription = {
  stop: () => void;
};

// --- binding surface (injected) ----------------------------------------
// The capability SDK never loads the native binding itself: the host loads
// it in whatever way its environment requires (window.require in a
// node-integrated renderer, createRequire in a plain node process) and
// injects it. This keeps the SDK environment-agnostic and side-effect free.

export type KfNativeFrame = {
  genTime: () => bigint;
  triggerTime: () => bigint;
  msgType: () => number;
  source: () => number;
  dest: () => number;
  dataLength: () => number;
};

export type KfNativeBinding = {
  Longfist?: new () => {
    types: Record<string, () => Record<string, unknown>>;
  };
  Assemble: new (runtimeDirs: string[]) => {
    dataAvailable: () => boolean;
    next: () => void;
    currentFrame: () => KfNativeFrame;
  };
  SessionStore: new (
    location: Record<string, string>,
    runtimeDir: string,
  ) => { getAllSessions: () => unknown };
  ConfigStore: new (runtimeDir: string) => {
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
  IODevice: new (
    location: Record<string, string>,
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
  ) => {
    isUsable: () => boolean;
    isLive: () => boolean;
    isStarted: () => boolean;
    start: () => void;
  };
  formatTime?: (nano: bigint, format?: string) => string;
};
