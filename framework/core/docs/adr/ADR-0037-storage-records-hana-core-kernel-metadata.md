# ADR-0037: ADR-0018 storage-service records are Hana-core kernel metadata; JSON is an edge projection, not the contract

- Status: accepted, delivered (the source-registry slice validated the
  pattern; the final slice migrated import manifest / export bundle / channel
  cursor and retired the JSON-as-contract path — see "First delivery")
- Date: 2026-07-09
- Category: (architecture) storage-service record representation and schema
  ownership — which substrate defines source registry, manifest, and fsck
  records, so the storage kernel stays independent of the FlatBuffers toolchain.
- Subsystem: `libyijinjing` storage semantic contract, `libkungfu` runtime
  storage service and providers, the yijinjing closed-set schema registry,
  Python/Node storage bindings, and SQLite/RocksDB projections.
- Related: ADR-0002 makes FlatBuffers the wire/journal runtime schema over POD;
  ADR-0018 established the runtime storage service; ADR-0019 builds Git-like
  source sync on the native location/channel types; ADR-0027 limits the Python
  yijinjing surface to core public runtime types; ADR-0033/0034 make Episode and
  the Episode manifest journal yijinjing-native kernel facts; ADR-0035 fixes the
  workspace-local `.kungfu` home. Companion reference:
  [`docs/runtime-storage-service.md`](../../../../docs/runtime-storage-service.md).

## Context

ADR-0018 established the runtime storage service and correctly insisted the
contract talk about facts, manifests, payloads, and verification rather than
backend engines. It left the record *representation* open. The implemented form
settled, by default rather than by decision, on three parallel shapes — none of
which is the kernel's own fact substrate:

1. **A JSON service surface.** `runtime::storage_service_api::storage_service`
   returns `nlohmann::json` for every operation; the language-neutral kernel
   free functions (`build_storage_import_manifest`, `verify_storage_import_manifest`,
   the sync-root helpers) are JSON-in / JSON-out. This is what runs.
2. **A parallel set of hand-written heap C++ structs.** `yijinjing/storage`
   `common.h` / `bundle.h` / `source.h` define `payload_ref`, `manifest_ref`,
   `source_record`, etc. with `std::string` members. They are largely
   unpopulated and unconsumed — the code that builds a manifest emits a JSON
   object, not a `manifest_ref`.
3. **Abstract interfaces over those structs** (`provider.h`), which nothing
   implements or includes.

Payload bodies compound the drift: they are stored as `.json` text
(`storage/payloads/<prefix>/<sha256>.json`).

Meanwhile v4 has settled a **two-substrate schema architecture**:

- **Hana closed-set core** (`schema/registry.h` `AllTypes` / `AllDataTypes`):
  compile-time POD kernel types — `frame_header`, `page_header`, `Session`,
  `Channel`, `ChannelRequest`, and the rest — registered with stable `carrier_type`
  ids. This is the kernel's own fact substrate. It does **not** depend on
  FlatBuffers; the core is defined, built, read, written, and debugged without
  the FlatBuffers toolchain.
- **FlatBuffers open layer** (`*.fbs` + the `.bfbs` reflection projector):
  domain and replayable payloads (`atlas_events`, `rewind_events`,
  `work_events`, agent bodies) — the cross-language extension surface.

ADR-0033/0034 already placed Episode manifest records in the Hana-core kernel
family, stored in a yijinjing append-only manifest journal, with JSON as an
export/debug view only. That decision implicitly answers the same question for
the ADR-0018 storage-service record family — which is the same kind of thing,
storage kernel metadata — but is still implemented in JSON. The overlap is
concrete: the storage service's channel request/cursor vocabulary sits beside —
and per ADR-0019 should build on — existing Hana-core types (`Channel` 10305,
`ChannelRequest` 10306), rather than redefine them as parallel heap structs.

## Decision

The ADR-0018 storage-service record family — source ref/head/record, source
registry snapshot, accepted range, import/export manifest, payload/schema
inventory, bundle root, channel request/cursor, and fsck issue/report — are
**Hana-core kernel metadata**, not JSON and not FlatBuffers.

1. **Kernel metadata, Hana core.** These records join the yijinjing closed-set
   core schema (`schema/registry.h`) alongside `frame_header` / `Session` /
   `Channel`. They are compile-time POD types with stable `carrier_type` ids. The
   storage kernel does not depend on the FlatBuffers toolchain to define, read,
   write, or debug them. FlatBuffers stays confined to the open/domain-payload
   layer.

2. **POD constraint, growth by delta.** Core records are fixed-layout POD (no
   `std::string` or other heap members) so they are mmap-safe and zero-copy.
   Variable-length or growing data is modeled as **append-only delta records
   folded into a current view** — the shape ADR-0034 chose for Episode manifests
   (`episode_open`, `..._attached`, `..._sealed`) — not as inline variable-length
   arrays. The current heap structs in `common.h` / `bundle.h` are the interim
   non-POD form; they are rebuilt into POD core records or retired, not
   registered as-is.

3. **Journal-backed authority.** The authoritative store is a yijinjing
   append-only journal in the storage/catalog plane (its home per ADR-0035),
   consistent with ADR-0034. Import/export acceptance, source registry updates,
   and fsck receipts append records; sealed roots are immutable; tombstone /
   repair / purge append receipts rather than mutating history.

4. **Projections are rebuildable; the core projection needs no runtime
   reflection.** SQLite and RocksDB remain rebuildable projections over the
   journal. The SQLite projection for these core records reuses the existing
   compile-time Hana closed-set → SQLite column path already used by the runtime
   cache
   (`libkungfu/runtime/cache/backend.h` `make_storage_ptr` over `sqlite_orm`),
   **not** the `.bfbs` runtime reflection projector, which serves the FlatBuffers
   open layer. RocksDB stores the POD record bytes.

5. **JSON is an edge projection only — including at adapter input.** The
   existing `run_storage_service_operation` JSON surface remains valid as the
   agent / CLI / export edge projection — preserving ADR-0018's `--json`
   guarantees — not as the contract or an internal currency. No language
   reimplements manifest parsing; bindings wrap the C++ core (ADR-0027).
   Adapter *ingestion input* is an edge too: an importer that reads a foreign
   source (for example an Atlas JSON repository) legitimately parses that source
   at the adapter boundary. What this ADR governs is the *accepted fact record*
   the importer produces — that record is a Hana-core kernel type, not the
   adapter's input format. Reading foreign JSON at ingestion is not a violation;
   letting that JSON become the stored record is.

6. **Payload bodies are opaque content-addressed bytes.** Large bodies are
   stored as raw bytes addressed by content hash, not `.json` text envelopes.
   Body format is orthogonal to record schema; the record commits to the body by
   hash, length, and payload state.

## Relation to ADR-0018 (supersession)

This supersedes ADR-0018's record-representation implications. The
language-neutral storage contract is the **Hana-core kernel schema plus the
journal**, not the JSON operation surface and not the hand-written heap structs
of `common.h` / `bundle.h` or the abstract `provider.h` interfaces; those
interim structures are rebuilt into POD core records or retired. ADR-0018's
service architecture — provider neutrality, the operation set, fsck / export /
import / rebuild / gc / compact, and SQLite as a rebuildable projection —
stands.

## Relation to ADR-0034

This applies ADR-0034's decision (manifest records are Hana-core kernel metadata
in a yijinjing manifest journal, JSON export-only) to the ADR-0018 generic
storage-service record family, which ADR-0034 did not explicitly cover. The two
manifest families share substrate and should share the manifest journal format
or a sibling catalog-plane journal, not diverge into two incompatible layouts.

## Consequences

- **The storage kernel is FlatBuffers-independent.** Core data can be defined,
  built, and debugged without the FlatBuffers toolchain, which keeps core
  development simplest and avoids welding the kernel to FlatBuffers.
- Storage records gain what the rest of the kernel has: POD zero-copy, one
  closed-set schema, `carrier_type` identity, journal-native append semantics, and
  the existing Hana → SQLite projection path.
- The JSON service surface narrows from "contract" to "edge projection,"
  preserving agent `--json` output without letting JSON define facts.
- Payload bodies become raw content-addressed blobs.
- Cross-language consumption follows the same path as other kernel types
  (C++-owned bindings exposing core public runtime types, ADR-0027), not
  per-type JSON conversion.

## First delivery (staged)

- Pick one storage-service record — the source record or the import manifest —
  define it as a POD Hana-core type with a kernel `carrier_type` id (a core type
  like `Channel`, registered in the closed-set — not a raw business allocation of
  the kind ADR-0023 gates), and write/read it through a storage/catalog-plane
  journal. **(done, slice 1)** — the source registry landed as three POD records
  `SourceRegistered` (10901), `SourceHeadUpdated` (10902), `AcceptedRangeRecorded`
  (10903), registered in the closed-set alongside the Episode manifest family.
  `source_registry_store` writes them to an append-only yijinjing SYSTEM journal
  (namespace `storage`, name `source-registry`) and folds frames into the current
  view; variable-length growth (accepted ranges) is modeled as append-only delta
  records, not inline arrays. Exposed through the libkungfu runtime storage
  service (`source_register` / `source_update_head` /
  `source_record_accepted_range` / `source_list` / `source_inspect` /
  `source_registry_fsck`).
- Project it to SQLite via the Hana → SQLite path; store any body as
  content-addressed bytes. **(SQLite projection done, slice 2)** — the
  source-registry records project to a rebuildable SQLite cache through
  `cache::make_storage_ptr` over `SourceRegistryDataTypes` (the same compile-time
  Hana closed-set → SQLite column path the profile / session / state caches use,
  not the hand-written raw-SQL projection that serves the JSON manifest layer and
  not the `.bfbs` reflection projector). `source_registry_rebuild` replays the
  journal into the typed tables; the journal stays the authority and the
  projection is fully rebuildable. **Content-addressed payload bodies done
  (payload slice)** — payload bodies are now stored as opaque bytes named by the
  content hash alone (`storage/payloads/<hash-prefix>/<sha256>`, no
  format-implying extension), in both the C++ runtime storage service and the
  Python atlas importer. Body format is orthogonal to the record schema; the
  manifest entry commits to the body by hash, length, and `content_type`
  metadata. This decouples and precedes the import-manifest migration, whose
  entries reference payloads by hash.
- Keep `storage status` / `storage export` as the JSON edge projection over the
  record; `fsck` verifies journal + payload + projection. **(done, slice 1–2 for
  the source registry)** — `source_list` / `source_inspect` return JSON edge
  projections labelled `authority: yijinjing-journal`; `source_registry_fsck`
  reopens journal frames to check fold consistency (missing / duplicate
  registration, dangling head) **and now also verifies the SQLite projection
  against the journal fold** — projection drift is reported as `degraded` (the
  journal is intact, the derived cache just needs a rebuild), a missing
  projection as a distinct honest state. Payload verification arrives with the
  payload slice.
- Then migrate the remaining storage-service records and retire the
  JSON-as-contract path and the unconsumed heap structs / `provider.h`.
  **(done, final slice)** — the manifest-catalog family landed as four POD
  records `ImportManifestAccepted` (10904), `ManifestEntryRecorded` (10905),
  `ExportBundleRecorded` (10906), `ChannelCursorUpdated` (10907), written to an
  append-only yijinjing SYSTEM journal (namespace `storage`, name
  `manifest-catalog`, the source-registry journal's sibling). Variable-length
  manifest entries grow as per-entry delta records; the exact accepted entries
  document is committed by content hash into the content store
  (`storage/manifests/<prefix>/<sha256>`) so the JSON edge and the cross-store
  sync root stay byte-reproducible, and each delta record carries the entry's
  sync-root leaf hash so the linear chain is recomputable from kernel records
  alone (identical proof semantics). Acceptance also aligns the source-registry
  journal (register-once, head update, accepted range), which retires the
  parallel JSON `sources.json` registry. The `generic_service` JSON builders,
  the per-source JSON manifest files, the hand-written raw-SQL `storage.sqlite`
  projection, and the heap structs (`common.h` heap members, `bundle.h`,
  `channel.h`, `source.h`, `acceptance.h`, `fsck.h`, `range.h`) plus
  `provider.h` are retired; the typed projection (`manifest-catalog.sqlite`,
  `cache::make_storage_ptr` over `ManifestCatalogDataTypes`) replaces them.
  `import-manifest/v1` / `export-bundle/v1` / `channel-cursor/v1` survive as
  JSON edge projections labelled `authority: yijinjing-journal`; export appends
  an `ExportBundleRecorded` receipt as a local journal fact without embedding
  it in the deterministic exchange bundle. fsck verifies journal fold
  consistency, the recomputed sync-root chain, the committed entries document,
  payload references through the ADR-0040 content store, and projection drift
  (degraded, never failed).

## Explicitly out of scope

- The Episode manifest record family (ADR-0034); this ADR is the ADR-0018
  generic storage-service family. They align but are recorded separately.
- The journal home / location (ADR-0035).
- Making any domain or business payload a Hana core type — those stay
  FlatBuffers behind action envelopes (ADR-0025/0034). The Hana core stays
  limited to kernel facts, storage metadata, receipts, and compact references.
- Destructive `gc` / `compact` execution (ADR-0018).

## Alternatives considered

- **Keep JSON as the storage contract (status quo).** Rejected. JSON is not the
  kernel's fact substrate; it forces per-language parsing and a second fact
  system next to yijinjing. It belongs at the edge.
- **Make storage records FlatBuffers `*.fbs` single sources (an earlier draft of
  this ADR).** Rejected. It would weld the storage kernel to the FlatBuffers
  toolchain and place kernel metadata in the domain-payload layer. FlatBuffers
  stays the open-layer substrate; the kernel must remain FlatBuffers-independent,
  and the Hana closed-set keeps core data simplest to develop and debug.
- **Implement `provider.h`'s heap structs as the contract.** Rejected.
  `std::string`-bearing structs are not mmap-safe POD; they are neither the JSON
  edge nor a valid core record. They are rebuilt into POD core records or
  retired.

## Residual risk

- POD-ifying variable-length manifest data requires the delta-append discipline;
  a naive port of the `std::string` heap structs would reintroduce non-POD
  members. Review must reject heap members in core records.
- Two manifest families (Episode per ADR-0034 and storage-service here) must not
  drift into two incompatible journal formats; prefer a shared record and
  journal vocabulary.
- The closed-set has a member-count / `carrier_type` budget; a storage record
  family consumes core `carrier_type` ids. These are kernel types, not the raw
  business allocations ADR-0023 gates, but the closed-set budget is still finite.
- The JSON edge projection must be named as a view / export, or higher layers may
  treat it as authority again.
