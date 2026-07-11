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

interface StorageMaintenanceOptions {
  source_id?: string;
  dry_run?: boolean;
}

interface StorageGcPlanResult {
  ok: boolean;
  scope: string;
  source_id: string | null;
  dry_run: boolean;
  payloads_scanned: bigint;
  referenced_payloads: bigint;
  candidate_bytes: bigint;
  candidates: Array<{
    payload_hash: string;
    uri: string;
    bytes: bigint;
    safe_to_delete: boolean;
  }>;
  notes: string[];
}

interface StorageRebuildIndexResult {
  ok: boolean;
  scope: string;
  source_id: string | null;
  authority: string;
  rebuilt_from: string;
  projections: Array<Record<string, unknown>>;
  dry_run: boolean;
  would_write: boolean;
  written: boolean;
  sources_rebuilt: bigint;
  errors: Array<Record<string, unknown>>;
}

interface StorageCompactPlanResult {
  ok: boolean;
  scope: string;
  source_id: string | null;
  dry_run: boolean;
  retained_manifests: Array<Record<string, unknown>>;
  rebuild_index: StorageRebuildIndexResult;
  gc: StorageGcPlanResult;
  projection_compact: Record<string, unknown>;
  unsupported: Array<Record<string, unknown>>;
  notes: string[];
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
  storageGcPlanTyped(
    runtimeDir: string,
    options?: StorageMaintenanceOptions,
  ): StorageGcPlanResult;
  storageRebuildIndexTyped(
    runtimeDir: string,
    options?: StorageMaintenanceOptions,
  ): StorageRebuildIndexResult;
  storageCompactPlanTyped(
    runtimeDir: string,
    options?: StorageMaintenanceOptions,
  ): StorageCompactPlanResult;
  [name: string]: unknown;
}

declare function createKungfuRuntime(): KungfuRuntime;

export = createKungfuRuntime;
