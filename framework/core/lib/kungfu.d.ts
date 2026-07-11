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

interface StorageFsckOptions {
  source_id?: string;
  episode_id?: bigint | number;
  verify_frames?: boolean;
}

interface StorageFsckIssue {
  severity: string;
  code: string;
  projection: string;
  detail: Record<string, unknown>;
}

interface StorageFsckResult {
  ok: boolean;
  degraded: boolean;
  status: string;
  scope: 0 | 1 | 2;
  source_id: string | null;
  episode_id: bigint | null;
  authority: string;
  checked: Record<string, bigint>;
  source_registry: Record<string, unknown>;
  manifest_catalog: Record<string, unknown> | null;
  episode_manifest: Record<string, unknown>;
  projections: StorageProjectionStatus[];
  frame_verification: Record<string, unknown> | null;
  qualification: Record<string, unknown> | null;
  issues: StorageFsckIssue[];
}

interface StorageRepairPlanOptions extends StorageFsckOptions {
  dry_run?: boolean;
}

interface StorageRepairPlanResult {
  ok: boolean;
  scope: 0 | 1 | 2;
  source_id: string | null;
  episode_id: bigint | null;
  dry_run: boolean;
  plan_only: boolean;
  status: string;
  degraded: boolean;
  candidates: Array<Record<string, unknown>>;
  unsupported: StorageFsckIssue[];
  fsck: StorageFsckResult;
  notes: string[];
}

type EpisodeStatus = 1 | 2 | 3 | 4;
type EpisodeRefKind = 1 | 2 | 3 | 4;

interface EpisodeBeginOptions {
  episode_id?: bigint | number;
  parent_episode_id?: bigint | number;
  root_trigger_frame_uid?: bigint | number;
  location_uid?: number;
  begin_time?: number;
  title?: string;
  actor?: string;
  source?: string;
}

interface EpisodeHeartbeatOptions {
  episode_id: bigint | number;
  location_uid?: number;
  update_time?: number;
  last_frame_uid?: bigint | number;
  frame_count?: bigint | number;
  note?: string;
}

interface EpisodeFrameAttachOptions {
  episode_id: bigint | number;
  frame_uid: bigint | number;
  location_uid?: number;
  trigger_frame_uid?: bigint | number;
  stream_id?: bigint | number;
  gen_time?: number;
  trigger_time?: number;
  carrier_type?: number;
  source?: number;
  dest?: number;
  data_length?: number;
  integrity_version?: number;
  payload_checksum?: bigint | number;
  frame_checksum?: bigint | number;
}

interface EpisodeRefAttachOptions {
  episode_id: bigint | number;
  ref_kind?: 'input_frame' | 'payload' | 'schema' | 'episode';
  ref_uid?: bigint | number;
  ref_id?: string;
  ref_hash?: string;
  location_uid?: number;
  update_time?: number;
}

interface EpisodeCloseOptions {
  episode_id: bigint | number;
  aborted?: boolean;
  location_uid?: number;
  end_time?: number;
  last_frame_uid?: bigint | number;
  frame_count?: bigint | number;
  reason?: string;
}

interface EpisodeRecoverOptions {
  episode_id?: bigint | number;
  location_uid?: number;
  end_time?: number;
  reason?: string;
}

interface EpisodeOpenRecord {
  schema_version: number;
  episode_id: bigint;
  parent_episode_id: bigint;
  root_trigger_frame_uid: bigint;
  location_uid: number;
  begin_time: bigint;
  title: string;
  actor: string;
  source: string;
}

interface EpisodeHeartbeatRecord {
  schema_version: number;
  episode_id: bigint;
  location_uid: number;
  update_time: bigint;
  last_frame_uid: bigint;
  frame_count: bigint;
  note: string;
}

interface EpisodeFrameAttachedRecord {
  schema_version: number;
  episode_id: bigint;
  location_uid: number;
  frame_uid: bigint;
  trigger_frame_uid: bigint;
  stream_id: bigint;
  gen_time: bigint;
  trigger_time: bigint;
  carrier_type: number;
  source: number;
  dest: number;
  data_length: number;
  integrity_version: number;
  payload_checksum: bigint;
  frame_checksum: bigint;
}

interface EpisodeRefAttachedRecord {
  schema_version: number;
  episode_id: bigint;
  location_uid: number;
  ref_kind: EpisodeRefKind;
  ref_uid: bigint;
  update_time: bigint;
  ref_id: string;
  ref_hash: string;
}

interface EpisodeClosedRecord {
  schema_version: number;
  episode_id: bigint;
  location_uid: number;
  status: EpisodeStatus;
  end_time: bigint;
  last_frame_uid: bigint;
  frame_count: bigint;
  reason: string;
}

interface EpisodeRootCommittedRecord {
  schema_version: number;
  episode_id: bigint;
  location_uid: number;
  commit_time: bigint;
  covered_record_count: number;
  algorithm: string;
  root_value: string;
}

interface EpisodeManifestRecord {
  manifest_frame_uid: bigint;
  manifest_gen_time: bigint;
  body:
    | EpisodeOpenRecord
    | EpisodeHeartbeatRecord
    | EpisodeFrameAttachedRecord
    | EpisodeRefAttachedRecord
    | EpisodeClosedRecord
    | EpisodeRootCommittedRecord
    | {
        carrier_type: number;
        schema_version: number;
        unknown_version: boolean;
      };
}

interface EpisodeCurrentView {
  episode_id: bigint;
  opened: boolean;
  closed: boolean;
  open_count: bigint;
  close_count: bigint;
  open: EpisodeOpenRecord;
  open_manifest_frame_uid: bigint;
  open_manifest_gen_time: bigint;
  heartbeat_seen: boolean;
  update_time: bigint;
  claimed_frame_count: bigint;
  last_frame_uid_seen: boolean;
  last_frame_uid: bigint;
  unique_frame_count: bigint;
  close: EpisodeClosedRecord;
  close_statuses: EpisodeStatus[];
  root_seen: boolean;
  root_count: bigint;
  root: EpisodeRootCommittedRecord;
  records: EpisodeManifestRecord[];
  frame_indices: bigint[];
  ref_indices: bigint[];
  duplicate_frame_uids: bigint[];
  missing_frame_uid_count: bigint;
}

interface EpisodeContentRootVerification {
  recorded: EpisodeRootCommittedRecord | null;
  computed: {
    covered_record_count: number;
    algorithm: string;
    value: string;
  } | null;
  match: boolean | null;
  status: 0 | 1 | 2 | 3 | 4 | 5;
}

interface EpisodeDependency {
  kind: string;
  role: string;
  status: string;
  episode_id: bigint | null;
  frame_uid: bigint | null;
  dependent_frame_uid: bigint | null;
  ref_uid: bigint | null;
  ref_id: string | null;
  ref_hash: string | null;
}

interface EpisodeCausalGraph {
  schema: string;
  episode_id: bigint;
  frame_count: bigint;
  edges: Array<{ from_frame_uid: bigint; to_frame_uid: bigint }>;
  dependencies: EpisodeDependency[];
  errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  degraded: boolean;
}

interface EpisodeListResult {
  ok: boolean;
  runtime_dir: string;
  authority: string;
  episodes: EpisodeCurrentView[];
  unknown_record_count: bigint;
}

interface EpisodeInspectResult {
  ok: boolean;
  runtime_dir: string;
  authority: string;
  episode: EpisodeCurrentView;
  content_root: EpisodeContentRootVerification;
  causal_graph: EpisodeCausalGraph;
  unknown_record_count: bigint;
  qualification: Record<string, unknown> | null;
}

interface SourceRegisteredRecord {
  schema_version: number;
  source_uid: bigint;
  kind: 1 | 2 | 3 | 4;
  location_uid: number;
  register_time: bigint;
  source_id: string;
  coordinate: string;
  head: string;
}

interface SourceHeadUpdatedRecord {
  schema_version: number;
  source_uid: bigint;
  location_uid: number;
  update_time: bigint;
  first_frame_uid: bigint;
  last_frame_uid: bigint;
  since: bigint;
  until: bigint;
  head: string;
  inventory_hash_algo: string;
  inventory_hash: string;
}

interface AcceptedRangeRecordedRecord {
  schema_version: number;
  source_uid: bigint;
  manifest_uid: bigint;
  location_uid: number;
  accept_time: bigint;
  first_frame_uid: bigint;
  last_frame_uid: bigint;
  since: bigint;
  until: bigint;
  status: 1 | 2 | 3;
  source_id: string;
  manifest_id: string;
}

interface SourceRegistryRecord {
  registry_frame_uid: bigint;
  registry_gen_time: bigint;
  body:
    | SourceRegisteredRecord
    | SourceHeadUpdatedRecord
    | AcceptedRangeRecordedRecord
    | { carrier_type: number };
}

interface SourceRegistryCurrentView {
  source_uid: bigint;
  registered: boolean;
  register_count: bigint;
  registration: SourceRegisteredRecord;
  head_update_seen: boolean;
  head_update: SourceHeadUpdatedRecord;
  current_head: string;
  records: SourceRegistryRecord[];
  accepted_range_indices: bigint[];
}

interface SourceListResult {
  ok: boolean;
  runtime_dir: string;
  authority: string;
  sources: SourceRegistryCurrentView[];
  unknown_record_count: bigint;
}

interface SourceInspectResult {
  ok: boolean;
  runtime_dir: string;
  authority: string;
  source: SourceRegistryCurrentView;
  unknown_record_count: bigint;
}

interface SourceHeadUpdateOptions {
  source_id: string;
  location_uid?: number;
  update_time?: bigint | number;
  first_frame_uid?: bigint | number;
  last_frame_uid?: bigint | number;
  since?: bigint | number;
  until?: bigint | number;
  head?: string;
  inventory_hash_algo?: string;
  inventory_hash?: string;
}

interface AcceptedRangeRecordOptions {
  source_id: string;
  manifest_id: string;
  location_uid?: number;
  accept_time?: bigint | number;
  first_frame_uid?: bigint | number;
  last_frame_uid?: bigint | number;
  since?: bigint | number;
  until?: bigint | number;
  status?: 'ok' | 'degraded' | 'failed';
}

interface EpisodeCloseResult {
  close: EpisodeClosedRecord;
  content_root: EpisodeRootCommittedRecord | null;
}

interface EpisodeRecoverResult {
  runtime_dir: string;
  recovered: EpisodeCloseResult[];
  skipped_open: Array<{ episode_id: bigint; location_uid: number }>;
}

interface StorageProjectionRebuildResult {
  ok: boolean;
  schema: string;
  runtime_dir: string;
  authority: string;
  projection: string;
  sqlite_path: string;
  rows: Array<{ table: string; count: bigint }>;
  journal_records: Array<{ table: string; count: bigint }>;
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
  storageFsckTyped(
    runtimeDir: string,
    options?: StorageFsckOptions,
  ): StorageFsckResult;
  storageRepairPlanTyped(
    runtimeDir: string,
    options?: StorageRepairPlanOptions,
  ): StorageRepairPlanResult;
  storageEpisodeBeginTyped(
    runtimeDir: string,
    options: EpisodeBeginOptions,
  ): EpisodeOpenRecord;
  storageEpisodeHeartbeatTyped(
    runtimeDir: string,
    options: EpisodeHeartbeatOptions,
  ): EpisodeHeartbeatRecord;
  storageEpisodeAttachFrameTyped(
    runtimeDir: string,
    options: EpisodeFrameAttachOptions,
  ): EpisodeFrameAttachedRecord;
  storageEpisodeAttachRefTyped(
    runtimeDir: string,
    options: EpisodeRefAttachOptions,
  ): EpisodeRefAttachedRecord;
  storageEpisodeCloseTyped(
    runtimeDir: string,
    options: EpisodeCloseOptions,
  ): EpisodeCloseResult;
  storageEpisodeRecoverTyped(
    runtimeDir: string,
    options: EpisodeRecoverOptions,
  ): EpisodeRecoverResult;
  storageEpisodeProjectionRebuildTyped(
    runtimeDir: string,
  ): StorageProjectionRebuildResult;
  storageEpisodeListTyped(
    runtimeDir: string,
    options?: { location_uid?: number; limit?: bigint | number },
  ): EpisodeListResult;
  storageEpisodeInspectTyped(
    runtimeDir: string,
    options: { episode_id: bigint | number },
  ): EpisodeInspectResult;
  storageSourceRegisterTyped(
    runtimeDir: string,
    options: {
      source_id: string;
      kind?: 'local' | 'imported_bundle' | 'kungfu_runtime' | 'adapter';
      coordinate?: string;
      head?: string;
      location_uid?: number;
      register_time?: number;
    },
  ): SourceRegisteredRecord;
  storageSourceUpdateHeadTyped(
    runtimeDir: string,
    options: SourceHeadUpdateOptions,
  ): SourceHeadUpdatedRecord;
  storageSourceRecordAcceptedRangeTyped(
    runtimeDir: string,
    options: AcceptedRangeRecordOptions,
  ): AcceptedRangeRecordedRecord;
  storageSourceListTyped(runtimeDir: string): SourceListResult;
  storageSourceInspectTyped(
    runtimeDir: string,
    options: { source_id: string },
  ): SourceInspectResult;
  storageSourceRegistryFsckTyped(
    runtimeDir: string,
    options?: { source_id?: string },
  ): {
    ok: boolean;
    status: string;
    journal: Record<string, unknown>;
    projection: StorageProjectionVerification;
  };
  storageSourceRegistryRebuildTyped(
    runtimeDir: string,
  ): StorageProjectionRebuildResult;
  [name: string]: unknown;
}

declare function createKungfuRuntime(): KungfuRuntime;

export = createKungfuRuntime;
