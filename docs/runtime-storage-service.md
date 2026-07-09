# Runtime Storage Service

Status: draft design plan with implemented Atlas and generic source first
slices.

Kungfu's fact ledger is not only an event capture mechanism. Long term, it is
also the local persistence service for user facts: runs, work items, imported
profiles, payload bodies, projections, bundles, and remote mirrors. That service
must be inspectable and maintainable in the same way a user expects from a
serious local database.

This document ties together the existing fact-ledger format direction, current
journal maintenance commands, Atlas import, source sync, remote sync, and the
missing storage operations such as `fsck`, import/export, garbage collection,
and compaction.

The architectural decisions are recorded in
[`ADR-0018`](../framework/core/docs/adr/ADR-0018-runtime-storage-service-architecture.md)
for the local runtime storage service and
[`ADR-0019`](../framework/core/docs/adr/ADR-0019-git-like-source-sync-over-location-and-channel.md)
for Git-like source sync over Kungfu `location` and `channel`.
[`ADR-0032`](../framework/core/docs/adr/ADR-0032-generic-source-service-v1.md)
records the first generic source service implementation slice.
[`ADR-0033`](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md)
defines Episode as the first-class causal segment object that future storage,
sync, fsck, import/export, and timeline slicing should address directly.
[`ADR-0034`](../framework/core/docs/adr/ADR-0034-yijinjing-episode-manifest-journal.md)
defines Episode manifest records as yijinjing-backed append-only journal facts,
with JSON limited to export, import interchange, diagnostics, and folded views.

## Existing Ground

The lower-level contract already exists in pieces:

- [`event-model.md`](event-model.md) documents the append-only journal, frame
  header, `source` / `dest` routing, `initial_source`, `frame_uid`,
  `trigger_frame_uid`, and `stream_id`.
- [`framework/spec/docs/format-spec.md`](../framework/spec/docs/format-spec.md)
  defines the portable fact-ledger direction: event spine, content commitment,
  blob store, schema registry, and manifest root.
- [`framework/core/slices/fact-ledger/README.md`](../framework/core/slices/fact-ledger/README.md)
  proves a minimal causal journal slice and stable export.
- [`debugging.md`](debugging.md) documents journal inspection and index rebuild
  commands.
- The spec error dictionary already includes missing-payload and hash-mismatch
  classes.
- The runtime already has native `location` and `channel` concepts for
  cross-process identity and source/destination communication.
- `kungfu atlas import` is currently a read-only projection of Atlas
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
`repair_plan`, `export_bundle`, `import_bundle`, `rebuild_index`, `gc_plan`,
`compact_plan`, `verify_sync`, and read-only `query`. The current default backend is a content-addressed file
provider implemented in C++ under the runtime service. A second C++ provider
stores the same source registry, manifests, and payload bodies in RocksDB behind
the identical service operations. Python storage commands are now compatibility
shims over that service instead of a second implementation of the provider
semantics.

Provider selection is runtime configuration, not product vocabulary. The
default provider remains `content-addressed-file`; explicit storage service
options win over environment defaults, and `KUNGFU_STORAGE_PROVIDER=rocksdb`
selects RocksDB only when the request does not pass `{"provider":"..."}`. The
returned request/status/capabilities include `provider_config_source` for
observability, but commands and SDKs should continue to model storage in terms
of manifests, payload references, bundles, projections, and verification.

Provider lifecycle is also owned by `libkungfu`, not the bindings. The
content-addressed file provider is stateless filesystem access. The RocksDB
provider owns a RocksDB handle for the lifetime of its C++ provider instance,
uses read-only opens for read operations without creating a backend, upgrades to
a writable handle when writes are required, and reports typed `rocksdb_*`
runtime errors from the service surface. Python and Node remain thin callers of
the same C++ service and must not manage RocksDB handles or provider-specific
retry policy themselves.

The first C++ contract surface is intentionally header-only vocabulary under
`<kungfu/yijinjing/storage...>`:

| Header | Contract role |
| --- | --- |
| `common.h` | Stable primitive enums and references: payload state, verification status, content hash, location, event range. |
| `range.h` | Range selectors and hash inventories for partial fetch/export. |
| `source.h` | Source identity, heads, accepted ranges, and registry snapshots. |
| `bundle.h` | Manifest, payload inventory, schema inventory, and bundle root. |
| `channel.h` | Channel refs, cursors, and request envelopes. |
| `acceptance.h` | Accepted segments plus import/export/sync result records. |
| `fsck.h` | Read-only verification options, issue taxonomy, and reports. |
| `provider.h` | Abstract service/provider interfaces implemented above the kernel. |

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
```

All commands intended for agents should support `--json`. Any command that
deletes, rewrites, or archives local facts should support a dry-run or preview
mode before execution.

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

Hash verification follows the ADR-0028 taxonomy: storage payloads and manifests
use explicit content-hash algorithms such as `sha256`; frame receipts use the
recorded checksum algorithm such as `fnv1a64`; yijinjing `fast_hash_*` ids are
not valid payload or manifest hashes.

The first trust-proof surface is the manifest-scoped sync root from
[`ADR-0030`](../framework/core/docs/adr/ADR-0030-manifest-scoped-sync-root-v1.md).
For Atlas imports, `fsck` recomputes `kungfu.sync-root/v1` from the manifest's
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

### Atlas Import First Slice

Atlas import is the first high-value adapter for this service.

Initial authority boundary:

```text
Atlas remains source of truth.
Kungfu imports and verifies a local projection.
```

The implemented Atlas adapter slice is:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage status --scope atlas --json
kungfu storage fsck --scope atlas --json
kungfu storage export --scope atlas --format jsonl --out atlas.jsonl --json
kungfu atlas verify --repo <atlas-repo> --json
```

Range-limited Atlas imports preserve the control-plane context needed to make
the selected records meaningful. For example, if a goal updated inside
`--from` references a mission whose own card was last updated before that
window, the import includes that mission as context. `storage export --scope
atlas` applies the same closure rule: a range export keeps those context
records instead of re-filtering them away. To export the exact latest imported
batch, omit range flags; to export a subrange from the latest import, pass
`--since` / `--from` / `--until` and expect a JSONL stream containing the
selected records plus required context records.

Acceptance covered by that slice:

- large Atlas JSON bodies are stored outside mmap frames as hash-addressed
  payloads;
- import writes a manifest with source head, object count, payload inventory,
  hash algorithm, frame checksum algorithm, and projection watermark;
- `fsck` detects missing payloads, hash mismatches, malformed payload JSON, and
  projection drift against the current Atlas projection;
- `storage export` emits a canonical JSONL record per imported Atlas payload;
- `atlas verify` recomputes source hashes from the Atlas repo and compares them
  with the latest imported payload manifest.

The first slice deliberately does not claim generic storage compaction, range
sync, schema repair, or a complete rebuild-index command yet.

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

The interim runtime store persists:

```text
runtime/storage/sources.json
runtime/storage/sources/<source_id>/manifests/latest.json
runtime/storage/sources/<source_id>/manifests/<manifest_id>.json
runtime/storage/payloads/<prefix>/<sha256>.json
runtime/storage/projections/storage.sqlite
```

When the resolved data home is a workspace `.kungfu/`, those paths live under
the workspace root as:

```text
.kungfu/runtime/journal/system/storage/episode-manifest/live/*.journal
.kungfu/runtime/storage/sources.json
.kungfu/runtime/storage/sources/<source_id>/manifests/*.json
.kungfu/runtime/storage/payloads/<prefix>/<sha256>.json
.kungfu/runtime/storage/rocksdb/
.kungfu/runtime/storage/projections/storage.sqlite
```

`kungfu storage layout --json` is the v1 inspection surface for this resolved
layout. It enters through the C++ `kungfu.runtime.storage-service/v1` operation
`layout`, so Python, Node, CLI, and GUI code can inspect the same paths without
redefining path rules. The returned JSON is an inspection contract, not a fact
source: Episode authority remains the yijinjing manifest journal, source
authority remains accepted manifests plus content-addressed payloads, and
SQLite/RocksDB remain provider/projection implementation details behind the
storage service API.

`runtime/storage/projections/storage.sqlite` is the first generic SQLite
projection. It is owned by the C++ storage service, rebuilt by
`storage rebuild-index`, and contains query tables for accepted source records,
latest manifests, and manifest entries. It is intentionally derived from the
provider's accepted latest manifests: deleting it loses query cache only, not
authority. `storage fsck` treats a missing projection as a warning and treats a
present projection whose row counts no longer match latest manifests as
projection drift.

`storage query` is the first public read-only API over that projection. It still
enters through `libkungfu` (`kungfu.runtime.storage-service/v1` operation
`query`) instead of letting Python, Node, CLI, or GUI code read SQLite directly.
The v1 query surface supports `sources`, `manifests`, and `entries` tables,
source filtering, entry-kind filtering, ISO time ranges, and a bounded limit.
It returns JSON rows decoded by the C++ service; the SQLite file remains
rebuildable cache, not a source of authority.

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
- `storage fsck --scope all|source` checks the generic source registry, latest
  manifests, source-record drift, accepted ranges, sync roots, payload
  presence/hash/length, payload inventory counts, schema inventory counts,
  SQLite projection drift, and all-scope orphan payload candidates.
- `storage rebuild-index` rebuilds the derived
  `runtime/storage/sources.json` source registry and the C++-owned SQLite
  projection from accepted latest manifests. This command writes only derived
  indexes unless `--dry-run` is used.
- `storage query --table sources|manifests|entries` reads the C++-owned SQLite
  projection through the runtime storage service. It is read-only and fails with
  a rebuild hint when the projection is missing.
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

## Open Decisions

- First payload backend: RocksDB, content-addressed files, SQLite blob table, or
  a hybrid.
- Exact encoding for present/redacted/absent/missing payload state.
- Exact source registry schema.
- How channel requests map to range/session/hash inventory across machines.
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
user data, run range/session/hash remote sync, or replace Atlas or any other
external source as an authority source.
