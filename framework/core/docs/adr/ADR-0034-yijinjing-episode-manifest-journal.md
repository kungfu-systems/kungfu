# ADR-0034: Episode manifest records live in the yijinjing journal format

- Status: accepted
- Date: 2026-07-09
- Category: (architecture) Episode manifest storage and schema ownership
- Subsystem: yijinjing schema, journal mmap, Episode manifests, runtime storage
  service, Python bindings, Node bindings, Rewind payloads.
- Related: ADR-0002 defines the FlatBuffers runtime schema over the zero-copy
  POD layout. ADR-0022 defines the C++ core as the action-recording membrane.
  ADR-0033 defines Episode as the first-class causal segment object.
  [`docs/episode-object-model.md`](../../../../docs/episode-object-model.md)
  describes the Episode object model.

## Context

ADR-0033 defines Episode as a first-class causal segment object. That makes the
Episode manifest load-bearing: it records Episode open/seal state, frame
membership, input references, dependencies, payload/schema references,
tombstones, repairs, and purge receipts.

The first design sketches used `manifest.json` as an understandable folded view.
That is acceptable as an export/debug representation, but it is the wrong local
authority implementation. A JSON-file manifest would force every language
surface to implement its own parsing and update path, weaken zero-copy
cross-language sharing, and create a second fact system next to yijinjing.

The manifest history is journal-like: append-only records are folded into a
current Episode view; sealed roots are immutable; tombstone/repair/purge events
append new receipts rather than modifying the old manifest. Therefore the local
authority should use the same journal substrate as the rest of Kungfu's core
facts.

## Decision

Episode manifest records are yijinjing first-class data structures and are
stored in a yijinjing-backed append-only **Episode manifest journal**.

The authority split is:

```text
event journal
  yijinjing frames for runtime events, action facts, and payload commitments

episode manifest journal
  yijinjing frames for Episode object metadata facts

projection / query cache
  rebuildable SQLite, RocksDB secondary indexes, or GUI caches

JSON / bundle views
  export, import interchange, diagnostics, and human-readable folded views
```

The Episode manifest journal should be written by a stable storage/catalog
location, not as private metadata hidden inside an agent's short-lived runtime
journal. It still uses yijinjing mmap and frame semantics, but it belongs to the
storage/catalog plane so deleting one agent location's journal does not erase
the Episode object directory.

The manifest record schema belongs to yijinjing's core POD/Hana-style schema
surface. It is kernel metadata, not domain payload. Python and Node consume the
same compiled schema/bindings that C++ owns; they must not implement an
independent JSON manifest authority.

The first record family should be small, append-only, and delta-oriented:

```text
episode_open
episode_frame_attached
episode_input_ref_attached
episode_payload_ref_attached
episode_schema_ref_attached
episode_sealed
episode_tombstoned
episode_repair_receipt
episode_purge_receipt
```

Large or domain-specific payloads remain outside this core record family.
Rewind actions, agent action bodies, app facts, and other business payloads
should use FlatBuffers or other declared payload schemas behind action
envelopes. The manifest journal records references, hashes, and Episode object
metadata; it does not become a revived trading-era business schema registry.

## Consequences

- C++, Python, and Node share one authority for Episode manifests through the
  yijinjing format instead of each parsing loose JSON files.
- Fsck can use one journal reader model to check event journals and manifest
  journals, then cross-check them:

  ```text
  event frame says:      frame F belongs to Episode E
  manifest record says:  Episode E contains frame F
  fsck verifies:         checksums, roots, and dependency closure agree
  ```

- Deleting an agent location journal can degrade Episode evidence without
  deleting the manifest catalog. Fsck can still report which Episodes are
  missing frames and which downstream Episodes have unresolved dependencies.
- Exported JSON or bundle JSON is a folded view of yijinjing manifest records,
  not the local source of truth.
- The C++ implementation must define manifest records before binding surfaces.
  Python and Node APIs should wrap the C++ journal/schema surface.
- Runtime storage providers can maintain secondary indexes, but those indexes
  are rebuildable projections over the manifest journal and event journals.

## First delivery

This ADR is a design commitment. The first implementation slice should add C++
Episode manifest record vocabulary in the yijinjing schema/storage layer before
adding Python or Node convenience APIs.

Documentation is updated to avoid presenting `manifest.json` as the intended
local authority. JSON remains valid for export/debug/folded views.

## Explicitly out of scope

- Implementing the full manifest journal writer in this ADR.
- Replacing Rewind or action-envelope domain payload schemas with Hana records.
- Making every business data type a yijinjing core type.
- Removing JSON export or diagnostic output.
- Solving Episode conflict resolution or remote merge policy.

## Alternatives considered

- **Loose JSON manifest files as local authority.** Rejected. They create a
  parallel storage implementation, duplicate parsing across languages, and lose
  yijinjing's cross-language single fact source.
- **Store all manifest data only in event frame trailers.** Rejected. Frame
  trailers should carry minimal per-frame membership/integrity data. Episode
  object graph updates such as open, input refs, seal, tombstone, repair, and
  purge are object-level facts and may happen without a business event frame.
- **Use FlatBuffers for Episode manifest records.** Rejected for the core
  manifest record family. FlatBuffers remains appropriate for domain payloads,
  but Episode manifest records are storage-kernel metadata that must follow the
  yijinjing POD/Hana core schema path.
- **Make SQLite the manifest authority.** Rejected. SQLite is useful for query
  projection, but it must remain rebuildable from append-only facts.

## Residual risk

- Reintroducing a broad Hana business model would repeat the old trading-era
  coupling. The yijinjing core schema must stay limited to kernel facts,
  storage metadata, receipts, and compact references.
- If the storage/catalog location is stored under the same retention boundary as
  short-lived agent journals, violent journal deletion can still erase too much.
  The manifest journal needs a clear catalog-plane home and backup policy.
- If bindings expose JSON as if it were the authority, higher layers may drift.
  Binding names and docs should make JSON a view/export format.
