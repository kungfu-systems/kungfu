# Runtime Storage Service

Status: draft design plan with implemented Atlas and generic source first
slices.

Kungfu's fact ledger is not only an event capture mechanism. Long term, it is
also the local persistence service for user facts: runs, work items, imported
profiles, payload bodies, projections, bundles, and remote mirrors. That service
must be inspectable and maintainable in the same way a user expects from a
serious local database.

This document ties together the existing fact-ledger format direction, current
journal maintenance commands, journal ingestion, source sync, remote sync, and the
missing storage operations such as `fsck`, import/export, garbage collection,
and compaction.

This storage plan predates the explicit two-substrate formulation. Read its
Episode-specific storage decisions as the temporal half of the current model:
Fact preserves admitted state at explicit Cuts, while Episode preserves bounded
causal experience across Cuts. The canonical integration and authority order
are defined in
[Fact, Episode, and Action Primitive Runtime](fact-episode-action-runtime.md).

The separate [Strong durability and crash recovery](../qualification/durability-and-crash-recovery.md)
contract defines when a published fact is merely visible, durably acknowledged,
projected, or later replicated. This storage-service document must not imply
power-loss durability beyond the profiles qualified there.

The architectural decisions are recorded in
[`KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de`](../adr/KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de.md)
for the local runtime storage service and
[`KF-ADR-019f86da-4f90-76a1-8eda-6e49fa70e7d5`](../adr/KF-ADR-019f86da-4f90-76a1-8eda-6e49fa70e7d5.md)
for Git-like source sync over Kungfu `location` and `channel`.
[`KF-ADR-019f86da-4f90-7111-9165-691b834edbab`](../adr/KF-ADR-019f86da-4f90-7111-9165-691b834edbab.md)
records the first generic source service implementation slice.
[`KF-ADR-019f86da-4f90-791c-9b90-4888cca36327`](../adr/KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md)
defines Episode as the first-class causal segment object that future storage,
sync, fsck, import/export, and timeline slicing should address directly.
[`KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692`](../adr/KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692.md)
defines Episode manifest records as yijinjing-backed append-only journal facts,
with JSON limited to export, import interchange, diagnostics, and folded views.

## Existing Ground

The lower-level contract already exists in pieces:

- [`event-model.md`](event-model.md) documents the append-only journal, frame
  header, `source` / `dest` routing, `initial_source`, `frame_uid`,
  `trigger_frame_uid`, and `stream_id`.
- [`framework/spec/docs/format-spec.md`](../../framework/spec/docs/format-spec.md)
  defines the portable fact-ledger direction: event spine, content commitment,
  blob store, schema registry, and manifest root.
- [`framework/core/slices/fact-ledger/README.md`](../../framework/core/slices/fact-ledger/README.md)
  proves a minimal causal journal slice and stable export.
- [`debugging.md`](../guides/debugging.md) documents journal inspection and index rebuild
  commands.
- The spec error dictionary already includes missing-payload and hash-mismatch
  classes.
- The runtime already has native `location` and `channel` concepts for
  cross-process identity and source/destination communication.
- `kungfu journal ingestion` is currently a read-only projection of Atlas
  control-plane data, not an authority migration.
- Remote sync currently mirrors source-scoped runtime directories; it is not yet
  a range/hash/session delta protocol.

The missing layer is a unified runtime storage service contract.

## Model

Kungfu should expose storage as facts and maintenance operations, not as storage
engine names.

Internal roles:

| Part | Role | Authority |
| --- | --- | --- |
| Journal | Event spine, order, causality, payload commitments | Authoritative for event topology and content commitment |
| Blob store | Large payload bodies addressed by hash | Authoritative body when present and hash-verified |
| SQLite projections | Query/index/cache views | Derived and rebuildable |
| Manifest/schema registry | Capture boundary, provenance, schemas, versioning | Trust and decode root for bundles |
| Source registry | Known sources, locations, heads, accepted ranges, watermarks | Local record of what has been accepted |
| Episode manifest | Bounded causal segment, frame coordinates, dependencies, payload/schema inventories, projection refs, and verification roots | First-class object boundary for export/import/fsck/timeline selection |

The first runtime backend may use RocksDB, content-addressed files, SQLite blob
tables, or a mix. That choice must remain behind the storage service. Public
commands and SDKs should talk about events, payload references, manifests,
watermarks, bundles, projections, source locations, and verification.

Implementation boundary:

- `libyijinjing` owns the language-neutral storage semantic kernel:
  journal/location identity, event ranges, range selectors, payload references,
  manifests, source records, channel requests/cursors, accepted segments,
  hash/schema inventories, fsck reports, and provider interfaces.
- `libkungfu` owns runtime implementation and adapters on top of that kernel:
  RocksDB-backed providers, SQLite projections, transport/process wiring,
  typed schema dumping, Python/Node bindings, and product command surfaces.
- Python and Node are command, binding, UI, or adapter layers. They may own
  file parsing and temporary glue while a backend is being migrated, but the
  stable storage service surface belongs in `libkungfu` so every language calls
  the same runtime contract.

This keeps storage facts portable across C++, Python, and Node without making
Python or JavaScript responsible for their own storage semantics. It also keeps
backend choices replaceable: a backend can change without changing the
`yijinjing` contract or the product vocabulary.

The first `libkungfu` provider slice exposes
`kungfu::runtime::storage_service_api::storage_service` and the
`kungfu.runtime.storage-service/v1` operation surface for `status`, `fsck`,
`repair_plan`, `repair_fetch`, `export_bundle`, `import_bundle`, `rebuild_index`, `gc_plan`,
`compact_plan`, `verify_sync`, `backend_status`, `backend_switch`,
`backend_rollback`, and read-only `query`. The current default backend is a
content-addressed file provider implemented in C++ under the runtime service. A second C++ provider
stores the same source registry, manifests, and payload bodies in RocksDB behind
the identical service operations. Python storage commands are now compatibility
shims over that service instead of a second implementation of the provider
semantics.

Provider selection is runtime configuration, not product vocabulary. The
default provider remains `content-addressed-file` for an empty runtime. Once a
runtime contains content, [`KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1`](../adr/KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1.md)
makes `storage/backend-binding.json` the provider authority. An explicit option
or `KUNGFU_STORAGE_PROVIDER` value may select the first provider, but it cannot
override an existing binding or unambiguous legacy population. A mismatch fails
closed; operators use the explicit backend switch or rollback operation instead
of changing configuration in place. Status and capabilities expose the binding,
provider availability, configuration source, migration phase, and cutover
contract for observability.

Provider lifecycle is also owned by `libkungfu`, not the bindings. The
content-addressed file provider is stateless filesystem access. The RocksDB
provider owns a RocksDB handle for the lifetime of its C++ provider instance,
uses read-only opens for read operations without creating a backend, upgrades to
a writable handle when writes are required, and reports typed `rocksdb_*`
runtime errors from the service surface. Python and Node remain thin callers of
the same C++ service and must not manage RocksDB handles or provider-specific
retry policy themselves.

The C++ contract surface under `<kungfu/yijinjing/storage...>` is the Hana-core
kernel record vocabulary ([KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5](../adr/KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md)/0047) plus the content-addressed body store:

| Header | Contract role |
| --- | --- |
| `common.h` | Content hash primitive and hash-algorithm constants. |
| `content_hash.h` / `content_store.h` | Content-addressed hashing and the immutable write-once body store ([KF-ADR-019f86da-4f90-738c-b372-e509976f69ff](../adr/KF-ADR-019f86da-4f90-738c-b372-e509976f69ff.md)). |
| `source_registry.h` | The source-registry kernel journal: `SourceRegistered` / `SourceHeadUpdated` / `AcceptedRangeRecorded` POD records folded into the source catalog. |
| `manifest_catalog.h` | The manifest-catalog kernel journal: `ImportManifestAccepted` / `ManifestEntryRecorded` / `ExportBundleRecorded` / `ChannelCursorUpdated` POD records, the accepted entries document committed by content hash, and the import-manifest / export-bundle JSON edge assemblers. |
| `sync_root.h` | The linear-chain sync-root proof over manifest entry commitments. |
| `episode_manifest.h` | The Episode manifest kernel journal ([KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692](../adr/KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692.md)/0041/0043). |

The interim heap structs (`bundle.h`, `channel.h`, `source.h`, `acceptance.h`,
`fsck.h`, `range.h`) and the abstract `provider.h` interfaces were retired with
the [KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5](../adr/KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md) final slice: the record contract is the closed-set POD schema plus
the journals, never `std::string`-bearing structs and never JSON files.

The next storage-contract layer should add Episode vocabulary under the same
C++ ownership boundary. Episode is not a Python/Node convenience term: it is the
causal segment object that providers, fsck, export/import, and timeline
projection must agree on. Its manifest history should be stored as yijinjing
manifest journal records, not as loose JSON authority.

## Source, Location, And Channel

Runtime storage sync should build on Kungfu's native runtime concepts instead
of inventing a second addressing layer.

- A **source** is a logical registry entry: a local profile, an imported bundle,
  another Kungfu runtime, or an adapter that can enumerate facts.
- A **location** is the runtime identity/address: who writes, who reads, which
  home/locator owns the journal path, and which process or node is being
  addressed.
- A **channel** is the communication edge between locations: request a range,
  subscribe, read from a source, write to a destination, or repair missing
  payloads.
- A **manifest** is the accept boundary: it says which segment, payloads,
  schemas, source metadata, and watermarks were accepted.

For example, a remote machine should not be modeled as a special local
`remote-120` storage island. It should be modeled as a source with one or more
locations that can answer channel requests. When a local runtime imports a
verified event segment, the accepted facts become part of the local fact ledger;
the original location and source provenance remain attached as metadata.

`channel` is transport, not authority. Authority is the accepted journal spine
plus the manifest root and payload/schema verification result.

## Git-like, Not Git-shaped

The storage service should support a Git-like workflow:

```text
remote location
  -> channel request/fetch
  -> manifest-backed event segment
  -> payload/hash/schema inventory
  -> local accept into the unified fact ledger
  -> rebuildable projection
```

The useful analogy is:

| Git-like concept | Kungfu storage concept |
| --- | --- |
| remote | source + location |
| fetch/pull | channel request + import |
| object | payload/blob by hash |
| pack/bundle | fact-ledger bundle |
| commit-ish accepted point | manifest-backed accepted segment |
| ref/head | source head, accepted frame uid, or watermark |
| fsck | causal/hash/schema/projection verification |

Do not copy Git's commit/tree/branch model directly. Kungfu is an ordered,
causal runtime fact ledger, not a snapshot tree database. The first sync stages
can assume a single accepted timeline and avoid conflict resolution; if forks,
authority-root changes, or conflicts appear later, they must become explicit
accept/reject/rebase policy rather than implicit directory layout.

Episode is the Kungfu analogue of a distributable object, but for causal
segments instead of filesystem snapshots. A remote fetch should eventually
accept verified Episodes into the local fact set; the observer timeline then
projects the selected Episode set under declared policy.

## Command Surface

The service should grow behind stable top-level surfaces:

```sh
kungfu source add
kungfu source list
kungfu source sync
kungfu source fsck
kungfu storage status
kungfu storage fsck
kungfu storage export
kungfu storage import
kungfu storage rebuild-index
kungfu storage gc
kungfu storage compact
kungfu storage backend status
kungfu storage backend switch --to rocksdb
kungfu storage backend rollback
```

All commands intended for agents should support `--json`. Any command that
deletes, rewrites, or archives local facts should support a dry-run or preview
mode before execution.

Backend changes are non-destructive but stateful. `switch` and `rollback` copy
and verify all immutable content namespaces, briefly fence old-provider writes,
atomically publish one new binding generation, retain the old provider
read-only, and emit a receipt. They never migrate journals or derived SQLite
projections because those have provider-neutral authority and rebuild rules.

## Integrity: `storage fsck`

`fsck` is the read-only proof that local storage is internally consistent.

It should check:

- journal pages/frames are readable in the selected scope;
- event order and causal parent references are consistent with declared
  boundaries;
- `source`, `dest`, and `initial_source` are internally consistent for imported
  or forwarded facts;
- schema ids and versions resolve;
- each payload reference is explicitly present, redacted, absent, or missing;
- present payloads match their committed hash and byte length;
- derived SQLite projections can be rebuilt from journal plus payloads;
- current projection watermarks match the event ranges they claim;
- source manifests, channel cursors, and accepted ranges are internally
  consistent.

Hash verification follows the [KF-ADR-019f86da-4f90-7d2c-aaa5-974ca5e38654](../adr/KF-ADR-019f86da-4f90-7d2c-aaa5-974ca5e38654.md) taxonomy: storage payloads and manifests
use explicit content-hash algorithms such as `sha256`; frame receipts use the
recorded checksum algorithm such as `fnv1a64`; yijinjing `fast_hash_*` ids are
not valid payload or manifest hashes.

The first trust-proof surface is the manifest-scoped sync root from
[`KF-ADR-019f86da-4f90-765c-9723-069718911491`](../adr/KF-ADR-019f86da-4f90-765c-9723-069718911491.md).
For journal ingestions, `fsck` recomputes `kungfu.sync-root/v1` from the manifest's
ordered entries and reports missing or mismatched root data as a storage
failure. This root binds payload references, source coordinates, action
envelopes, and frame receipt metadata for the accepted segment. It is local
tamper evidence, not a signature, MAC, or non-repudiation proof.

Example target:

```sh
kungfu storage fsck --scope atlas --json
kungfu storage fsck --scope all --since 20d --json
kungfu source fsck atlas-local --since 20d --json
```

`fsck` reports degraded facts without rewriting them. A missing payload is not
repaired by pretending it was absent; it is reported as missing until an import,
repair, or redaction decision changes that state.

`storage repair --plan --dry-run` is the read-only follow-up to fsck. It turns
known degraded diagnostics into `kungfu.storage.repair-plan/v1` candidates with
stable issue code, target kind, role, target id/hash fields, and suggested
action. V1 deliberately does not fetch remote data, delete local data, compact
providers, or mutate manifests. It only gives a future importer or remote sync
source precise missing Episode, frame, or payload targets.

`storage repair --fetch --out <json> --dry-run` is the local evidence collection
step between plan and apply. It consumes the current repair plan, searches the
current runtime plus already registered local remote mirrors under
`runtime/remotes/<source-id>/runtime`, and emits
`kungfu.storage.repair-material/v1` containing Episode bundles or source export
bundles. Fetch writes a material artifact only when `--out` is explicit. It does
not perform network sync, apply material, delete facts, compact providers, or
mark anything repaired.

`storage repair --apply --from <json>` is the explicit local-material follow-up
to that plan. It consumes a validated `kungfu.storage.episode-bundle/v1` or
`kungfu.storage.export-bundle/v1` that the caller already has on disk. The
command defaults to dry-run and reports `kungfu.storage.repair-apply/v1`; only
`--execute` writes. V1 may append missing Episode manifest records or restore
missing source payload bodies whose content hash and length match the local
manifest. It still does not contact remotes, invent missing data, delete facts,
compact providers, garbage collect payloads, or override intentional
`redacted`/`absent` states.

## Import And Export

Import/export should become the shared mechanism for:

- moving a run or work item between machines;
- syncing source-scoped remote mirrors;
- importing Atlas, another profile, or another adapter by range;
- repairing missing payloads by hash;
- producing portable audit bundles.

Filters should support at least:

- episode id or Episode selector;
- source id;
- scope/profile, such as `atlas`, `work`, `rewind`, or `all`;
- session or run id;
- `--since` / `--until`;
- cursor or event range;
- hash inventory.

The bundle must carry:

- Episode manifest, dependencies, and selected projection policy if the export
  claims a projected timeline;
- manifest and capture boundary;
- event segment;
- payload inventory with present/redacted/absent/missing state;
- required schema registry entries;
- source metadata, including locations when relevant;
- watermarks and idempotency keys;
- enough data for verification to be recomputed.

Example target:

```sh
kungfu storage export --scope atlas --since 20d --out atlas.kfbundle --json
kungfu storage export --scope work --since 20d --out work.kfbundle --json
kungfu storage import --from atlas.kfbundle --verify --json
```

Directory copying can be an early implementation detail, but it must not become
the contract. The contract is manifest-backed, hash-verified, and idempotent.

## Rebuild, GC, And Compact

`rebuild-index` rebuilds derived projections. It should be safe after a failed
sync, partial import, or suspected projection drift.

`gc` removes only unreachable payload bodies. A payload is live if it is
referenced by a retained event, checkpoint, retained bundle manifest, or
redaction tombstone.

`compact` must not mean destructive history rewrite. For a fact ledger,
compaction is a composition:

```text
checkpoint projection state at a watermark
  + archive older retained event spine into a verified bundle
  + garbage-collect unreachable payload bodies
  + vacuum/rebuild derived SQLite projections
  + compact underlying KV ranges if the backend supports it
```

The compact report should state:

- retained event range;
- archived event range and archive hash/path;
- payloads retained, deleted, redacted, or missing;
- projections rebuilt or vacuumed;
- before/after sizes;
- rollback or restore route.

## Source Adapter Path

Source adapters let existing systems feed Kungfu without pretending that Kungfu
already owns their authority.

Initial authority boundary:

```text
External source remains source of truth.
Kungfu imports and verifies a local projection.
```

For each imported object, Kungfu should eventually record:

- source kind and stable source coordinate;
- source id and source head;
- location and channel metadata when the source is a Kungfu runtime;
- import id and batch id;
- schema id/version;
- content type;
- content hash;
- byte length;
- payload state;
- event range/cursor;
- accepted frame uid or equivalent watermark;
- projection watermark.

This lets a one-way adapter remain safe while still exercising the same payload,
manifest, fsck, export, and rebuild mechanisms required for future remote sync
and authority migration.

### Generic Source Service First Slice

The next implemented slice makes Atlas one adapter over a generic source
service instead of a special storage architecture.

The C++ semantic surface now builds and verifies these contracts:

- `kungfu.storage.source-record/v1`;
- `kungfu.storage.source-registry/v1`;
- `kungfu.storage.import-manifest/v1`;
- `kungfu.storage.export-bundle/v1`;
- `kungfu.storage.accepted-range/v1`;
- `kungfu.storage.payload-inventory/v1`;
- `kungfu.storage.schema-inventory/v1`.

The runtime store persists ([KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5](../adr/KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md) final slice — the journals are the
authority; there are no JSON manifest files and no JSON source registry):

```text
runtime/journal/system/storage/source-registry/live/*.journal
runtime/journal/system/storage/manifest-catalog/live/*.journal
runtime/storage/manifests/<prefix>/<sha256>      # accepted entries documents
runtime/storage/payloads/<prefix>/<sha256>       # content-addressed bodies
runtime/storage/projections/source-registry.sqlite
runtime/storage/projections/manifest-catalog.sqlite
```

When the resolved data home is a workspace `.kungfu/`, those paths live under
the workspace root as:

```text
.kungfu/runtime/journal/system/storage/episode-manifest/live/*.journal
.kungfu/runtime/journal/system/storage/source-registry/live/*.journal
.kungfu/runtime/journal/system/storage/manifest-catalog/live/*.journal
.kungfu/runtime/storage/manifests/<prefix>/<sha256>
.kungfu/runtime/storage/payloads/<prefix>/<sha256>
.kungfu/runtime/storage/schemas/<prefix>/<sha256>
.kungfu/runtime/storage/rocksdb/
.kungfu/runtime/storage/projections/*.sqlite
```

`kungfu storage layout --json` is the v1 inspection surface for this resolved
layout. It enters through the C++ `kungfu.runtime.storage-service/v1` operation
`layout`, so Python, Node, CLI, and GUI code can inspect the same paths without
redefining path rules. The returned JSON is a CLI/adapter inspection projection,
not a fact source or the semantic C++ service contract: Episode authority
within the temporal manifest domain remains the yijinjing manifest journal, source
authority remains accepted manifests plus content-addressed payloads, and
SQLite/RocksDB remain provider/projection implementation details behind the
storage service API.

[KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76](../adr/KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76.md)
freezes that projection as additive-only layout v1. Its typed `entries` array
covers the workspace roots, all five yijinjing layout directories, coordinator,
skills, agent sessions, sources, peers, coordination, admission state, Project
Cut runtime context, provider state and locks, mirrors, and the Atlas store.
Each entry is `durable`, `ephemeral`, or `cache`.
For standard `<home>/runtime` placement, `coverage` scans the bounded
home/runtime/storage/coordinator namespaces and reports every unknown name as
an `unclassified_durable_candidate`; nonstandard runtime paths do not cause
their unrelated parent directory to be scanned.
`kungfu storage layout --verify --json` exits non-zero until those candidates
are classified. Deleting a durable path can lose accepted state; ephemeral
paths belong to live processes; cache paths are rebuildable from another
declared authority.

The same freeze pins the journal wire epoch to `0xe3b24c8d` (`3820113037`):
the compile-time layout fingerprint must equal that declaration. KFX runtime
authorization is deliberately outside this layout contract and comes only from
exact Core-owned Fact/Work roots. `.xinfa/` remains the Git-published Xinfa
semantic input root, not a location for live journals, payload CAS, locks,
private material, projections, or runtime caches.

`runtime/storage/projections/source-registry.sqlite` and
`runtime/storage/projections/manifest-catalog.sqlite` are the generic SQLite
projections. They are owned by the C++ storage service, rebuilt by
`storage rebuild-index` through the compile-time Hana closed-set → SQLite
column path (`cache::make_storage_ptr`), and are intentionally derived from the
kernel journals: deleting them loses query cache only, not authority.
`storage fsck` treats a missing projection as a warning and a present
projection whose current-view row counts diverge from the journal fold as
projection drift (degraded, never failed — a rebuild restores the view).

`storage query` is the public read-only API over the journal folds. It enters
through `libkungfu` (`kungfu.runtime.storage-service/v1` operation `query`)
instead of letting Python, Node, CLI, or GUI code read SQLite directly. The
query surface supports `sources`, `manifests`, and `entries`, source filtering,
entry-kind filtering, ISO time ranges, and a bounded limit. The semantic
service and Hana/`sqlite_orm` query path return typed rows/views internally;
JSON is produced only by the named CLI/binding edge adapter. The SQLite files
remain rebuildable projections and may serve external SQL tooling; they never
become authority. `framework/core/schema-authority.json` plus the blocking
schema-authority gate enforce this owner-to-projection route.

The user-facing generic commands are:

```sh
kungfu storage layout --json
kungfu storage status --scope all --json
kungfu storage status --scope source --source <source-id> --json
kungfu storage fsck --scope all --json
kungfu storage fsck --scope source --source <source-id> --json
kungfu storage repair --scope episode --episode-id <episode-id> \
  --plan --dry-run --json
kungfu storage repair --scope episode --episode-id <episode-id> \
  --apply --from episode.kfbundle.json --dry-run --json
kungfu storage repair --scope episode --episode-id <episode-id> \
  --apply --from episode.kfbundle.json --execute --json
kungfu storage export --scope source --source <source-id> \
  --format jsonl --out source.jsonl --json
kungfu storage export --scope source --source <source-id> \
  --format bundle-json --out source.kfbundle.json --json
kungfu storage import --from source.kfbundle.json --json
kungfu storage rebuild-index --scope all --json
kungfu storage rebuild-index --scope source --source <source-id> --json
kungfu storage gc --scope all --dry-run --json
kungfu storage compact --scope all --dry-run --json
kungfu storage verify-sync --source <source-id> --json
kungfu storage query --table entries --scope source --source <source-id> \
  --kind goal --since 20d --json
kungfu storage query --table episodes --scope episode --json
kungfu storage query --table episode_frames --scope episode \
  --episode-id <episode-id> --json
kungfu storage fsck --scope episode --episode-id <episode-id> --json
kungfu storage export --scope episode --episode-id <episode-id> \
  --format bundle-json --out episode.kfbundle.json --json
```

`kungfu source add/list/sync/fsck` uses the same source registry path. Atlas
sync now writes the adapter-specific Atlas manifest and the generic storage
manifest; it also mirrors imported payload bodies into the generic payload
store so `storage fsck/export --scope source` can verify and export the same
facts.

This slice includes a non-Atlas synthetic fixture that exercises manifest
construction, accepted ranges, payload inventory, source-scoped fsck,
range-limited export, bundle creation, and bundle import. It deliberately does
not implement remote channel transport, conflict policy, destructive GC,
automatic repair, or destructive compaction.

### Episode-Owned Storage Slice V1

Episode-owned storage v1 makes the yijinjing Episode manifest journal a normal
selector in the runtime storage service:

- `storage fsck --scope episode --episode-id <id>` verifies one Episode through
  the same `libkungfu` service surface as source/all fsck.
- `storage query --table episodes|episode_records|episode_frames|episode_refs`
  reads the yijinjing-backed Episode manifest journal through the service
  rather than treating SQLite as authority.
- `storage export --scope episode --episode-id <id> --format bundle-json`
  emits `kungfu.storage.episode-bundle/v1`, a folded export/debug bundle with
  the Episode manifest summary, manifest records, frame attachments, refs, and
  declared Episode dependencies.
- `storage repair --scope episode --episode-id <id> --plan --dry-run --json`
  maps degraded Episode causal graph warnings to read-only repair candidates.
- `storage repair --scope episode --episode-id <id> --fetch --out <material>
  --dry-run --json` searches only local runtime/mirror evidence and writes a
  `kungfu.storage.repair-material/v1` artifact for later validation or apply.
- `storage repair --scope episode --episode-id <id> --apply --from <bundle>
  --dry-run|--execute --json` validates local Episode material and, only with
  `--execute`, appends missing Episode manifest records while skipping records
  already identified by the manifest.
- `storage import --from episode.kfbundle.json --json` validates
  `kungfu.storage.episode-bundle/v1` and preserves its causal graph,
  dependencies, and degraded evidence in the import result. Materialization is
  intentionally routed through the separate repair-apply command so mutation
  remains explicit and previewable.

This slice still does not move event mmap pages into Episode-owned physical
directories. Frame membership is authoritative through
`EpisodeFrameAttached` records in the manifest journal. The physical allocation
domain can change later without changing the product-facing Episode selector.

### Maintenance And Sync-Readiness Slice

The first maintenance slice keeps destructive operations out of scope while
making storage health and sync readiness inspectable:

- `storage status --scope all|source` now reports each source's latest manifest,
  accepted ranges, manifest sync root, payload/schema inventory counts, and a
  cursor-like accepted head for future channel fetch.
- `storage fsck --scope all|source` checks the source-registry journal fold,
  each source's latest catalog manifest, registry/catalog head drift, the
  sync-root chain recomputed from the per-entry commitment records, the
  committed entries document (re-fetched and cross-checked field by field
  against the delta records), payload presence/hash/length through the
  content store, SQLite projection drift, and all-scope orphan payload
  candidates.
- `storage rebuild-index` rebuilds the derived SQLite projections
  (`source-registry.sqlite`, `manifest-catalog.sqlite`) from the kernel
  journals. This command writes only derived indexes unless `--dry-run` is
  used.
- `storage query --table sources|manifests|entries` folds the kernel journals
  through the runtime storage service. It is read-only.
- `storage gc --dry-run` scans payload files and reports unreachable candidates.
  All-scope candidates are unreferenced by retained storage manifests. Source
  scope is informational only because the interim payload store is shared.
- `storage compact --dry-run` composes a reviewable plan: retained manifests,
  rebuild-index preview, gc preview, SQLite rebuild/vacuum intent, and
  unsupported backend/history actions. It does not archive, delete, vacuum,
  compact, or rewrite any facts.
- `storage verify-sync --source <source-id>` exports a manifest-backed bundle,
  imports it into a temporary local runtime, runs fsck there, and compares sync
  roots. This simulates the proof path future remote sync will use without a
  real remote.

The current generic store has a generic SQLite projection and content-addressed
file plus RocksDB providers, but SQLite remains a rebuildable projection, not a
provider or authority root. Atlas's user-facing cards remain a journal-folded
projection; this slice does not add a standalone Atlas-specific SQLite
projection.

## Safety Boundaries

Storage service operations must preserve these boundaries:

- no silent partial import;
- no raw secret, token, cookie, billing page, signed URL, or hidden provider
  session store capture;
- skipped sensitive sources are recorded as redacted or explicitly absent;
- imported facts keep source, original location, and attribution labels;
- remote mirrors are source-scoped and not mixed into local authority without an
  explicit import boundary;
- projections are disposable, payloads referenced by retained events are not.

`kungfu health` consumes storage `status` in bounded mode and adds the existing
read-only all-scope `fsck` only with `--deep`. It translates typed issue codes
through the shared diagnostics contract, but it never applies repair, rebuild,
garbage collection, or compaction. Suggested maintenance stops at inspection or
a dry-run plan; storage remains the authority for every finding.

### Payload State Encoding

The four-state payload encoding is decided and producer-facing (it closed the
former open decision):

- The state lives on the kernel manifest entry record
  (`ManifestEntryRecorded.payload_state`, POD enum `PayloadState`:
  `present=1, redacted=2, absent=3, missing=4`) and participates in the
  sync-root entry commitment, so a state can never be rewritten without
  changing the manifest's proof.
- `present`: the body is stored content-addressed; `payload_hash` and
  `byte_len` are required and verified by fsck.
- `redacted`: a sensitive body deliberately withheld at the adapter edge
  ([KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de](../adr/KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de.md) security boundary). The body is never serialized or stored — no
  raw secret can reach the payload store, manifest, or journal. The entry may
  carry the hash/length the producer computed before withholding, or leave
  them empty. fsck reports `intentional=true` and does not degrade.
- `absent`: the source confirmed the body does not exist. `payload_hash` is
  empty and `byte_len` is zero. fsck reports `intentional=true` and does not
  degrade.
- `missing`: the body was expected but is lost. fsck degrades the verdict.
- Export carries every entry with its recorded state. `redacted` and `absent`
  bodies are never read; a `missing` body is attempted so a lost-and-found
  copy becomes repair material, otherwise the honest gap is exported as a
  body-less record. Import accepts the entries verbatim, so the states and
  the sync root survive cross-store round trips.
- Producers enter through `enrich_source_records` / `write_import_payloads`
  (Python adapter edge) or the acceptance input document directly: a record
  marked `payload_state=redacted|absent` is never serialized and never
  written to the store.

## Open Decisions

Decided since this list was first drafted (kept here so the history of the
question is visible):

- ~~First payload backend~~ — decided: the content-addressed file store is the
  default provider and RocksDB is the optional engine-backed provider, both
  behind the same immutable content-store contract ([KF-ADR-019f86da-4f90-738c-b372-e509976f69ff](../adr/KF-ADR-019f86da-4f90-738c-b372-e509976f69ff.md)).
- ~~Exact source registry schema~~ — decided: the source registry is the
  Hana-core kernel journal family `SourceRegistered` / `SourceHeadUpdated` /
  `AcceptedRangeRecorded` ([KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5](../adr/KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md)), folded into the current view with a
  rebuildable SQLite projection.
- ~~Exact payload state encoding~~ — decided: see "Payload State Encoding"
  above.

Still open:

- How channel requests map to range/Episode/hash inventory across machines.
- Whether `compact` ships as one command first, or later after `checkpoint`,
  `gc`, and `rebuild-index` are boring.
- How much Atlas profile semantics should remain `atlas/*` versus become a
  generic imported-fact profile.
- When an imported source is allowed to become the source of truth.

## Maturity

This is a phased storage-service plan. The fact-ledger spine, location/channel
runtime concepts, schema registry direction, and export slice exist as grounded
building blocks. The Atlas scope now has a concrete payload import, fsck,
export, source-verify, and generic source-manifest loop. Kungfu also has a
non-Atlas source fixture and generic bundle import/export proof. Kungfu still
does not claim that it can repair arbitrary journal corruption, safely compact
user data, run range/Episode/hash remote sync, or replace Atlas or any other
external source as an authority source.
