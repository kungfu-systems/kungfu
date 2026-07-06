import {
  type KfLocator,
  type KfNativeBinding,
  resolveRuntimeDir,
} from './types.js';
// Remote-source capability handle: read source-scoped mirrors under
// <runtime>/remotes without promoting them into the local authoritative
// runtime. GUI/TUI surfaces can render remote work with source and staleness
// labels while continuing to use the same Work projection shape.
import { type WorkItem, openWork } from './work.js';

export type RemoteSyncState = 'fresh' | 'stale' | 'failed' | 'never' | string;

export type RemoteSource = {
  id: string;
  host?: string;
  home?: string;
  transport?: string;
  [key: string]: unknown;
};

export type RemoteProjection = {
  sourceId: string;
  source: RemoteSource;
  sourceLabel: string;
  syncState: RemoteSyncState;
  lastSyncedAt?: string;
  mirrorRuntime: string;
  captureMode: 'imported';
};

export type RemoteWorkItem = WorkItem & {
  source: string;
  sourceId: string;
  syncState: RemoteSyncState;
  lastSyncedAt?: string;
  mirrorRuntime: string;
  captureMode: 'imported';
};

export type RemoteWork = {
  runtimeDir: string;
  sources: () => RemoteProjection[];
  items: () => RemoteWorkItem[];
  refresh: () => void;
};

export type OpenRemoteWorkOptions = {
  binding: KfNativeBinding;
  locator: KfLocator;
  readFile: (path: string) => Uint8Array;
  readDir: (dir: string) => string[];
};

const decoder = new TextDecoder();

function decodeJson<T>(
  readFile: (path: string) => Uint8Array,
  path: string,
): T {
  return JSON.parse(decoder.decode(readFile(path))) as T;
}

function sourceProjection(
  runtimeDir: string,
  source: RemoteSource,
  readFile: (path: string) => Uint8Array,
): RemoteProjection {
  const sourceId = String(source.id);
  const mirrorRuntime = `${runtimeDir}/remotes/${sourceId}/runtime`;
  let syncState: RemoteSyncState = 'never';
  let lastSyncedAt: string | undefined;
  try {
    const manifest = decodeJson<{
      sync_state?: string;
      last_synced_at?: string;
      mirror_runtime?: string;
    }>(readFile, `${runtimeDir}/remotes/${sourceId}/sync-manifest.json`);
    syncState = manifest.sync_state ?? 'stale';
    lastSyncedAt = manifest.last_synced_at;
    return {
      sourceId,
      source,
      sourceLabel: `remote:${sourceId}`,
      syncState,
      lastSyncedAt,
      mirrorRuntime: manifest.mirror_runtime ?? mirrorRuntime,
      captureMode: 'imported',
    };
  } catch {
    return {
      sourceId,
      source,
      sourceLabel: `remote:${sourceId}`,
      syncState,
      mirrorRuntime,
      captureMode: 'imported',
    };
  }
}

export function openRemoteWork(options: OpenRemoteWorkOptions): RemoteWork {
  const { binding, readFile } = options;
  const runtimeDir = resolveRuntimeDir(options.locator);

  let cachedSources: RemoteProjection[] | null = null;
  let cachedItems: RemoteWorkItem[] | null = null;

  const loadSources = (): RemoteProjection[] => {
    if (cachedSources) return cachedSources;
    let raw: { sources?: Record<string, RemoteSource> };
    try {
      raw = decodeJson(readFile, `${runtimeDir}/remotes/sources.json`);
    } catch {
      cachedSources = [];
      return cachedSources;
    }
    cachedSources = Object.entries(raw.sources ?? {})
      .map(([sourceId, source]) =>
        sourceProjection(
          runtimeDir,
          { ...source, id: source.id ?? sourceId },
          readFile,
        ),
      )
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    return cachedSources;
  };

  const loadItems = (): RemoteWorkItem[] => {
    if (cachedItems) return cachedItems;
    cachedItems = [];
    for (const projection of loadSources()) {
      if (projection.syncState === 'never') continue;
      const work = openWork({
        binding,
        locator: { runtimeDir: projection.mirrorRuntime },
      });
      for (const item of work.items()) {
        cachedItems.push({
          ...item,
          source: projection.sourceLabel,
          sourceId: projection.sourceId,
          syncState: projection.syncState,
          lastSyncedAt: projection.lastSyncedAt,
          mirrorRuntime: projection.mirrorRuntime,
          captureMode: projection.captureMode,
        });
      }
    }
    cachedItems.sort((a, b) =>
      a.updatedTime < b.updatedTime
        ? 1
        : a.updatedTime > b.updatedTime
          ? -1
          : 0,
    );
    return cachedItems;
  };

  return {
    runtimeDir,
    refresh: () => {
      cachedSources = null;
      cachedItems = null;
    },
    sources: () => loadSources(),
    items: () => loadItems(),
  };
}
