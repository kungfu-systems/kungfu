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

export const ROLE_NAMES = [
  'source',
  'sink',
  'actor',
  'system',
  'service',
] as const;
export const MODE_NAMES = ['live', 'data', 'replay', 'backtest'] as const;

export type KfRole = (typeof ROLE_NAMES)[number];
export type KfMode = (typeof MODE_NAMES)[number];

export function roleName(value: number | string): string {
  return ROLE_NAMES[Number(value)] ?? String(value);
}

export function modeName(value: number | string): string {
  return MODE_NAMES[Number(value)] ?? String(value);
}

export type KfLocation = {
  role: KfRole | string;
  namespace: string;
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
  carrierType: number;
  frameUid: bigint;
  triggerFrameUid: bigint;
  streamId: bigint;
  source: number;
  initialSource: number;
  dest: number;
  dataLength: number;
  dataType: number;
  integrityVersion?: number;
  payloadChecksum?: bigint;
  frameChecksum?: bigint;
};

export type RecordFilter = {
  carrierType?: number;
  sinceNanos?: bigint;
  limit?: number;
};

export type ReplayAnchor = {
  episodeId: bigint;
  locationUid: number;
  beginTime: bigint;
  endTime: bigint;
  frameCount: bigint;
  lastFrameUid: bigint;
  closed: boolean;
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
  frameUid: () => bigint;
  triggerFrameUid: () => bigint;
  streamId: () => bigint;
  carrierType: () => number;
  source: () => number;
  initialSource: () => number;
  dest: () => number;
  dataLength: () => number;
  dataType: () => number;
  // raw payload bytes — the decode path for open-layer frames (e.g. rewind
  // events), whose schemas live outside the compiled yijinjing schema registry
  dataBytes: () => Uint8Array;
};

export type KfActionEnvelope = {
  version: number;
  action_type: string;
  schema_ref: { id: string; version: number };
  payload?: {
    encoding: number;
    data: Uint8Array;
    hash_algorithm: string;
    hash: string;
    byte_len: bigint;
    content_type: string;
    state: string;
  };
};

export type KfNativeBinding = {
  runStorageServiceOperation?: (
    operation: string,
    runtimeDir: string,
    options?: Record<string, unknown>,
  ) => Record<string, unknown>;
  Schema?: new () => {
    types: Record<string, () => Record<string, unknown>>;
  };
  Assemble: new (
    runtimeDirs: string[],
  ) => {
    dataAvailable: () => boolean;
    next: () => void;
    currentFrame: () => KfNativeFrame;
  };
  ActionRecorder?: new (
    runtimeDir: string,
    namespace: string,
    name: string,
    destId?: number,
    streamId?: bigint | number,
  ) => {
    recordBytes: (
      carrierType: number,
      payload: Uint8Array,
      options?: {
        genTime?: bigint | number;
        triggerTime?: bigint | number;
        parentFrameUid?: bigint | number;
        streamId?: bigint | number;
        chainToLast?: boolean;
      },
    ) => LedgerRecord;
    recordJson: (
      carrierType: number,
      jsonPayload: string,
      options?: {
        genTime?: bigint | number;
        triggerTime?: bigint | number;
        parentFrameUid?: bigint | number;
        streamId?: bigint | number;
        chainToLast?: boolean;
      },
    ) => LedgerRecord;
    recordAction: (
      value: Record<string, unknown>,
      options?: {
        genTime?: bigint | number;
        triggerTime?: bigint | number;
        parentFrameUid?: bigint | number;
        streamId?: bigint | number;
        chainToLast?: boolean;
      },
    ) => LedgerRecord;
    mark: (
      carrierType: number,
      options?: {
        genTime?: bigint | number;
        triggerTime?: bigint | number;
        parentFrameUid?: bigint | number;
        streamId?: bigint | number;
        chainToLast?: boolean;
      },
    ) => LedgerRecord;
    lastFrameUid: () => bigint;
  };
  decodeActionEnvelope: (value: Uint8Array) => KfActionEnvelope | null;
  encodeActionEnvelope: (value: Record<string, unknown>) => Uint8Array;
  verifyFlatbufferPayload: (
    schemaBfbs: Uint8Array,
    payload: Uint8Array,
    objectName?: string,
  ) => boolean;
  storageEpisodeListTyped: (
    runtimeDir: string,
    options?: { location_uid?: number; limit?: bigint | number },
  ) => { episodes: unknown[] };
  ConfigStore: new (
    runtimeDir: string,
  ) => {
    setConfig: (
      role: string,
      namespace: string,
      name: string,
      mode: string,
      value: string,
    ) => boolean;
    removeConfig: (
      role: string,
      namespace: string,
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
    millisecondsSleepAfterStep: number,
    captureCustom?: boolean,
  ) => {
    isUsable: () => boolean;
    isLive: () => boolean;
    isStarted: () => boolean;
    start: () => void;
    getLocation: (uid?: number | string) => Record<string, unknown> | undefined;
    issueRawPublic: (carrierType: number, data: Buffer) => boolean;
    requestReadFromPublic: (
      location: Record<string, unknown>,
      fromTime: bigint,
    ) => boolean;
    drainCustomData: () => {
      dropped: bigint;
      frames: Array<{
        genTime: bigint;
        triggerTime: bigint;
        frameUid: bigint;
        carrierType: number;
        source: number;
        dest: number;
        data: Buffer;
      }>;
    };
    quit: () => void;
  };
  formatTime?: (nano: bigint, format?: string) => string;
};
