# ADR-0040: a first-class content-addressed KV is a runtime fact-ledger primitive, backend-neutral from an embedded single agent to a fleet-scale sharded/tiered store

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) storage substrate — the runtime fact ledger's
  key/value capability, its concurrency and scale envelope, and the backend
  topology that lets one contract serve a single embedded agent and a fleet of
  thousands of concurrent cloud agents.
- Subsystem: `libyijinjing` / `libkungfu` runtime storage service, the
  content-addressed payload store, the storage record family (ADR-0037), and the
  Python/Node storage bindings.
- Related: ADR-0018 established the runtime storage service and its provider
  neutrality (content-addressed-file / rocksdb); ADR-0019 builds Git-like source
  sync on the native location/channel types; ADR-0034 makes the Episode manifest
  a yijinjing-native append-only journal; ADR-0035 fixes the workspace-local
  `.kungfu` home; ADR-0037 makes the storage record family Hana-core kernel
  metadata and payload bodies opaque content-addressed bytes; ADR-0028 separates
  content hashes from frame checksums; the yijinjing single-writer-per-location
  publish contract (ADR-0001) underlies the per-writer scaling model here.

## Context

The storage-record migration (ADR-0037) surfaced a requirement that is larger
than any single record type: **a general key/value capability is not a feature
of one scenario, it is a foundational primitive the runtime fact ledger must
provide.** Users — including the runtime itself — store many kinds of things
through it over time: today an import manifest, tomorrow a snapshot, a
checkpoint, an agent artifact, an arbitrary blob. Building a bespoke KV per
scenario (a "manifest KV", then a "something-else KV") fragments the substrate;
the KV must be one first-class contract.

The current state is partial and does not meet this bar:

- Payload bodies are already opaque content-addressed bytes (ADR-0037 point 6),
  but there is no first-class KV surface over them. The Python facade is
  asymmetric — a `write_payload_bytes` method exists, reads go through a path
  helper — and there is no uniform `get / set / has / delete / scan` contract.
- The provider abstraction (ADR-0018: content-addressed-file / rocksdb) opens
  and closes a fresh backend handle **per operation**. This is adequate for a
  single agent doing one thing at a time but is not a concurrency or lifecycle
  model.

The decisive requirement is the target deployment: **kungfu as the runtime fact
ledger for agent work at industrial scale — hundreds, thousands, or tens of
thousands of agents working concurrently in the cloud.** The question is not
"how do we store a manifest"; it is "does this ledger hold up when the fleet is
large and writing at once." That reframes the design around two axes the
single-agent view hides: **fleet-scale concurrency** and **retention-scale
volume**.

### Scale envelope (agent-work fact ledger)

A working agent emits a stream of facts — actions, tool calls, edits,
decisions, Episode frames, receipts — plus the bodies of those facts. A rough
per-agent rate is order 1k–10k events/hour at ~0.5–5 KB/body (tool I/O, file
contents, and command output push the tail higher), i.e. order 10–100 MB/agent/
hour before dedup:

| Concurrency | Pre-dedup ingest | Retained per year |
| --- | --- | --- |
| hundreds | ~1–10 GB/hour | ~TB/month |
| thousands | ~10–100 GB/hour | ~hundreds of TB/year |
| tens of thousands | ~0.1–1 TB/hour | ~PB/year |

Two properties dominate the design:

1. **Dedup is the largest lever.** Agent work is highly redundant — a fleet
   re-reads the same repositories and files, runs the same builds, loads the
   same libraries, and produces similar outputs. Content-addressing deduplicates
   this across the whole fleet, so effective storage tends toward *the union of
   distinct content touched plus unique outputs* rather than a per-agent sum.
   This can pull a naive PB/year back to TB–hundreds-of-TB.
2. **Concurrency, not raw volume, is the sharp constraint.** Thousands of agents
   writing at the same instant is what breaks a naive design; the storage
   contract must absorb it by construction.

## Decision

1. **A first-class content-addressed KV is a runtime fact-ledger primitive.** The
   ledger exposes one uniform KV contract — `put` / `get` / `has` / `delete` /
   `scan`, organized by `namespace`, with a content-addressed `put-if-absent`
   mode — in C++, Python, and Node. Features (import manifest, source registry,
   snapshots, arbitrary user blobs) are *uses* of this KV plus the journal, never
   bespoke per-scenario stores. Callers never program against a concrete engine
   (`rocksdb::DB`, `sqlite3`) directly; the KV contract is the surface, the
   engine is a replaceable part beneath it. Concretely: building manifest storage
   means building on the yijinjing KV (`yijinjing.kv.put/get/...`) plus the
   journal — never on the RocksDB API. RocksDB is never a caller-facing surface.

2. **Content-addressing is the concurrency, dedup, and tiering enabler — not
   merely a simplification.** Content-addressed objects are write-once: their key
   is the hash of their bytes, so the bytes at a key can never change. This gives
   three load-bearing properties at fleet scale:
   - *Lock-free concurrent writes:* two writers writing the same hash write
     identical bytes (idempotent, no coordination); different hashes are
     different keys (no conflict). Thousands of concurrent writers need no write
     lock for the content-addressed bulk of the data.
   - *Fleet-wide dedup:* identical content is stored once regardless of how many
     agents produce it.
   - *Cold tiering:* immutable objects can be moved to cheap/cold storage,
     addressed by hash, without invalidating references.

3. **The KV contract is backend- and transport-neutral, and the dependency
   direction is one-way: yijinjing owns the contract and depends on no concrete
   engine.** The KV *interface* is a yijinjing primitive. Concrete engine-backed
   implementations (RocksDB, later sharded / distributed / object-store-tiered)
   live in the runtime / provider layer above it and are injected through the
   interface. **`libyijinjing` must not depend on, link, or include RocksDB (or
   any other specific engine); the dependency points from the implementation
   layer down to the yijinjing interface, never the reverse.** yijinjing ships a
   dependency-free default backend (a file-based content-addressed store) so its
   KV works standalone with zero heavy dependencies; RocksDB is an optional,
   injected, replaceable backend selected at the runtime / deployment layer for
   the scale profile. The same interface then serves a single embedded agent and
   a fleet, differing only in the injected backend:
   - single agent / small scale: the in-process default (file) or embedded
     RocksDB, no service;
   - fleet scale: the same contract behind a storage service, over a
     content-hash-sharded hot store plus an object-store cold tier.
   No caller-facing contract change is required to move between these; scale is
   added by swapping the injected backend, not by rewriting callers and not by
   giving the kernel a new dependency.

4. **Per-agent journals give linear write scaling.** Ordered per-agent event
   streams follow the yijinjing single-writer-per-location contract: each agent
   is its own writer to its own journal, so N agents are N independent writers
   with no cross-agent contention. Fleet write throughput scales with fleet size
   for the journal path.

5. **RocksDB is the default hot backend *at the runtime layer*, injected through
   the KV interface; at fleet scale it is a per-shard part, not the whole store.**
   "Default" here means the recommended production backend for the scale profile,
   selected and linked by the runtime / provider layer — not a dependency of the
   yijinjing kernel (see Decision 3). RocksDB is retained because it is
   industrial-grade and the most widely deployed embedded storage engine, is
   built for datasets far larger than memory and for write-heavy churn (its home
   turf), comfortably handles multi-TB per instance, and is already integrated. At
   fleet scale a single embedded instance cannot be the shared store — a large
   fleet of processes cannot share one embedded handle — so RocksDB serves
   per-node / per-shard hot data behind the storage service; the shared
   content-addressed store is service-fronted, sharded, and cold-tiered, not one
   local engine. Because it sits behind the interface, RocksDB can be replaced
   (by SQLite/LMDB for small profiles, or a distributed store at the top) without
   touching callers or the kernel.

6. **Sharding is for scale, tiering is for retention; the lock is solved
   separately.** The per-operation open/close of the current provider is a
   lifecycle artifact, not a RocksDB limit: RocksDB is thread-safe through a
   single long-lived handle, so within a process the lock is dissolved by holding
   one handle under the single-writer-per-workspace contract — not by sharding.
   Sharding (by content-hash prefix, preserving dedup) is reserved for genuine
   scale-out beyond a single instance; cold tiering (immutable objects to an
   object store, addressed by hash) is reserved for retention beyond hot
   capacity. Both are enabled by content-addressing.

7. **Scale target.** Design the content-addressed KV so that a single node
   comfortably holds single-digit to tens of TB (RocksDB's normal range),
   the contract shards to hundreds of TB by content-hash, and nothing
   structurally caps the topology below PB — where PB means a sharded / tiered /
   distributed backend, explicitly not a single local engine. The near-term
   effective target after dedup is TB–hundreds-of-TB per deployment.

## For implementers: the dependency boundary (do not make yijinjing depend on RocksDB)

This is the single most confusable point; read it before writing code.

- **The KV interface belongs to `libyijinjing`.** An abstract `kv_store`
  interface (`put` / `get` / `has` / `delete` / `scan`, namespace,
  content-addressed `put-if-absent`) plus a dependency-free default backend
  (file-based content-addressed) live in the kernel. `libyijinjing` must build,
  link, and run with **no RocksDB dependency at all**.
- **The RocksDB-backed `kv_store` lives in the runtime / provider layer**
  (`libkungfu`), which is the only place allowed to include and link RocksDB. It
  implements the yijinjing interface and is injected into the kernel through that
  interface at runtime — the kernel receives a `kv_store*`, never a
  `rocksdb::DB*`.
- **Dependency direction is one-way and down:** implementation layer → yijinjing
  interface. Never the reverse. If you find yourself adding `#include
  <rocksdb/...>`, a `rocksdb::` type, or a librocksdb link to anything under
  `libyijinjing`, you have broken this boundary — stop and move that code into
  the provider layer behind the interface.
- **Enforce it mechanically, not by prose.** Add a source-quality boundary gate
  (in the spirit of ADR-0039's `check-view-boundary.mjs`) that fails if
  `libyijinjing` references RocksDB (or any concrete engine) by include, symbol,
  or link. A reviewer note is not enough; the gate is the guarantee.
- Callers (manifest storage, source registry, snapshots, user features) depend
  only on the yijinjing KV interface. They never see RocksDB, SQLite, LMDB, or a
  distributed backend; swapping the backend is invisible to them.

## Consequences

- The KV becomes a stable substrate contract that outlives any one record type;
  the storage record family (ADR-0037) and the import-manifest migration build on
  it rather than defining private stores.
- "Embedded, no extra service" holds for a single agent and small scale; a large
  concurrent fleet requires a storage service / tier. The contract is designed so
  this is a backend swap, not a contract change.
- Content-addressing is load-bearing for correctness under concurrency, not only
  for dedup: the fleet-scale write path is lock-free *because* objects are
  write-once.
- RocksDB earns its place for the large-scale write-heavy envelope and is kept.
  The earlier suggestion (in the ADR-0037 discussion) to consider dropping it was
  scoped to a 3 MB control-plane store; under a fleet-scale fact-ledger
  requirement that suggestion is withdrawn.
- A gc / retention / compaction policy becomes first-class at this scale
  (ADR-0018 deferred destructive gc); this ADR sets the scale context that policy
  must serve but does not define it.

## First delivery (staged)

- Define the first-class KV interface (`put` / `get` / `has` / `delete` /
  `scan`, `namespace`, content-addressed `put-if-absent`) as a `kv_store`
  abstraction in `libyijinjing`, with a dependency-free default backend
  (file-based content-addressed) so the kernel KV works with no RocksDB
  dependency. Add a symmetric Python/Node facade, and complete the asymmetric
  payload facade into this uniform KV surface.
- Add the boundary gate that fails if `libyijinjing` references RocksDB (or any
  concrete engine) by include, symbol, or link, in the spirit of ADR-0039's
  `check-view-boundary.mjs`.
- Provide the RocksDB-backed `kv_store` in the runtime / provider layer
  (`libkungfu`), held as a single long-lived handle under the
  single-writer-per-workspace contract (retiring per-operation open/close for the
  hot path), injected into the kernel through the interface.
- Prove content-addressed `put-if-absent` dedup and concurrent-writer safety at
  the single-node level.
- Then, as separate work: content-hash sharding, the object-store cold tier, the
  fleet storage service, and the retention/gc policy.

## Explicitly out of scope

- The import-manifest record migration itself (a use of this KV + journal),
  recorded and delivered separately.
- The distributed / service-fronted backend implementation; this ADR fixes the
  contract and topology direction, not that implementation.
- Destructive gc / compact execution and the retention policy (ADR-0018); this
  ADR only sets their scale context.
- The trading market-data ledger; its volume profile is different and is not the
  subject here.
- The choice of cold-tier object store and any distributed KV; those are backend
  decisions under this contract, taken when scale-out work begins.

## Alternatives considered

- **Store all manifest/record data as journal frames (append every entry).**
  Rejected as the general model. It over-applies the Episode append-only frame
  pattern to high-cardinality, regenerated-per-sync snapshot data, causing
  journal churn with destructive gc deferred. The compact acceptance receipt
  belongs in the journal; the entry set belongs in the content-addressed store as
  a sealed object. (ADR-0037 point 3 "sealed roots are immutable" is consistent
  with this.)
- **A bespoke KV per scenario.** Rejected. It fragments the substrate; the KV
  must be one first-class contract.
- **SQLite adapted to KV (`WITHOUT ROWID` table + `INSERT OR IGNORE`).** Viable
  and already in the stack for the projection layer, and a strong fit for a small
  write-once, read-heavy store; but for a general, mutable, fleet-scale KV
  primitive it means adapting a relational engine to a KV contract, and its
  single-writer / scale ceiling is lower than an engine built for large
  write-heavy datasets. Kept as a candidate backend for small/embedded profiles,
  not as the fleet-scale default.
- **LMDB.** Industrial-grade (OpenLDAP; Monero at hundreds of GB), crash-proof by
  design, tiny footprint, and excellent read-latency predictability (no
  compaction stalls). But its comfort ceiling — memory-mapped, single-writer,
  pre-declared map size — sits below the write-heavy, far-larger-than-RAM,
  TB-to-PB envelope this ledger must reach. A strong option for read-heavy,
  working-set-bounded profiles; not the fleet-scale default.
- **A single-node, single-writer, single-embedded-instance store.** Rejected as
  the fleet model. It is the correct shape for one agent / 3 MB of control-plane
  data and the wrong shape for thousands of concurrent writers; a large fleet of
  processes cannot share one embedded handle.

## Residual risk

- The backend-neutral contract must be defined tightly enough that the embedded
  and fleet backends are genuinely interchangeable; a contract that leaks
  embedded assumptions (synchronous local paths, single-process handles) would
  force a rewrite at scale-out.
- The kernel-must-not-depend-on-RocksDB boundary erodes silently if left to
  reviewer vigilance; without the mechanical gate (see "For implementers"), a
  future change can quietly link RocksDB into `libyijinjing` and invert the
  dependency. The gate, not the prose, is the guarantee.
- Content-hash sharding preserves dedup only if sharding is by content hash, not
  by source or owner; a wrong sharding key breaks dedup and re-introduces the
  per-source copy explosion.
- The mutable metadata / index and the cross-fleet query surface are not
  write-once and remain the genuinely hard concurrency problem; this ADR makes
  the bulk (content) tractable but does not by itself solve the metadata-write
  and distributed-query path.
- Retention at PB scale requires a real gc / tiering policy (ADR-0018 deferred);
  without it the ledger grows monotonically.
- Fleet-scale correctness ultimately rests on the concurrency contract
  (single-writer-per-location / per-workspace); relaxing it to concurrent writers
  on one location must be solved at the contract layer, not by backend choice.
