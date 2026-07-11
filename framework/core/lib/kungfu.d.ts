// SPDX-License-Identifier: Apache-2.0

interface StorageTimeRange {
  since: string;
  until: string;
}

interface StorageSyncRoot {
  algorithm: string;
  value: string;
}

interface StorageProjectionVerification {
  ok: boolean;
  status: string;
  schema: string;
  runtime_dir: string;
  authority: string;
  projection_present: boolean;
  degraded: boolean;
  note: string;
  drift: Array<{
    table: string;
    projection_rows: number | bigint;
    journal_distinct: number | bigint;
  }>;
  rows: Array<{ table: string; count: number | bigint }>;
  journal_distinct: Array<{ table: string; count: number | bigint }>;
}

interface StorageProjectionStatus {
  name: string;
  path: string;
  rebuildable: boolean;
  verification: StorageProjectionVerification;
}

interface StorageProviderRuntime {
  lifecycle: string;
  instance_lifecycle: string;
  handle: string;
  readonly_open_creates_backend: boolean;
  write_open_creates_backend: boolean;
  read_fill_cache: boolean | null;
  write_sync: boolean | null;
}

interface StorageProviderCache {
  lifecycle: string;
  entries: bigint;
  hits: bigint;
  misses: bigint;
}

interface StorageStatusResult {
  ok: boolean;
  backend: string;
  provider: string;
  provider_config_source: string;
  provider_runtime: StorageProviderRuntime;
  provider_cache: StorageProviderCache;
  scope: string;
  source_id: string | null;
  authority: string;
  sources: Array<Record<string, unknown>>;
  projections: StorageProjectionStatus[];
  source_status: Array<Record<string, unknown>>;
}

type StorageQueryName =
  | 'sources'
  | 'manifests'
  | 'entries'
  | 'episodes'
  | 'episode_records'
  | 'episode_frames'
  | 'episode_refs';

type StorageQueryKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface StorageQueryOptions {
  source_id?: string;
  entry_kind?: string;
  episode_id?: bigint | number;
  limit?: number;
  since?: string;
  until?: string;
}

interface StorageQueryResult {
  ok: boolean;
  scope: string;
  source_id: string | null;
  episode_id: bigint | null;
  projection_name: string;
  projection_schema: string;
  authority: string;
  rebuildable: boolean;
  query: StorageQueryKind;
  entry_kind: string | null;
  range: StorageTimeRange;
  limit: bigint;
  rows: Array<Record<string, unknown>>;
  errors: Array<{ code: string; episode_id: bigint | null }>;
}

interface KungfuRuntime {
  storageStatusTyped(
    runtimeDir: string,
    sourceId?: string,
  ): StorageStatusResult;
  storageQueryTyped(
    runtimeDir: string,
    query: StorageQueryName,
    options?: StorageQueryOptions,
  ): StorageQueryResult;
  [name: string]: unknown;
}

declare function createKungfuRuntime(): KungfuRuntime;

export = createKungfuRuntime;
