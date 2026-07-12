---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0040
decision_status: proposed
implementation_status: not-started
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0040: a first-class content-addressed store is a runtime fact-ledger primitive, with mutable KV and fleet topology kept as separate capabilities

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) storage substrate — the runtime fact ledger's
  immutable content-addressed object capability, the semantic boundary between
  that capability and mutable key/value metadata, and the backend profiles that
  may implement those contracts.
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
than any single record type: **immutable bodies addressed by content hash need
one first-class storage contract.** Users — including the runtime itself — store
many kinds of things through it over time: today an import-manifest body,
tomorrow a snapshot, a checkpoint, an agent artifact, or an arbitrary blob.
Building a bespoke content store per scenario fragments the substrate.

That does not make every key/value use the same semantic object. Immutable
content-addressed bodies and mutable metadata have different guarantees:
content objects are write-once and verified by hash, while mutable metadata may
need delete, ordered scan, compare-and-set, transactions, or a declared
consistency model. This ADR makes the immutable content store first-class and
keeps a general mutable KV as a separate capability rather than hiding both
behind one ambiguous interface.

The current state is partial and does not meet this bar:

- Payload bodies are already opaque content-addressed bytes (ADR-0037 point 6),
  but there is no first-class content-store surface over them. The Python facade is
  asymmetric — a `write_payload_bytes` method exists, reads go through a path
  helper — and there is no uniform content `put / get / has / verify` contract.
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

### Scale envelope hypothesis (agent-work fact ledger)

A working agent emits a stream of facts — actions, tool calls, edits,
decisions, Episode frames, receipts — plus the bodies of those facts. The
following is a planning hypothesis, not measured capacity evidence. A rough
per-agent rate is order 1k–10k events/hour at ~0.5–5 KB/body (tool I/O, file
contents, and command output push the tail higher), i.e. order 10–100 MB/agent/
hour before dedup:

| Concurrency | Pre-dedup ingest | Retained per year |
| --- | --- | --- |
| hundreds | ~1–10 GB/hour | ~TB/month |
| thousands | ~10–100 GB/hour | ~hundreds of TB/year |
| tens of thousands | ~0.1–1 TB/hour | ~PB/year |

Two properties dominate the design:

1. **Dedup may be a large lever.** Agent work can be highly redundant — a fleet
   re-reads the same repositories and files, runs the same builds, loads the
   same libraries, and produces similar outputs. Content-addressing deduplicates
   this across the whole fleet, so effective storage can approach *the union of
   distinct content touched plus unique outputs* rather than a per-agent sum.
   The actual ratio is workload-dependent and must be measured before it is used
   for retention or capacity commitments.
2. **Concurrency, not raw volume, is the sharp constraint.** Thousands of agents
   writing at the same instant is what breaks a naive design; the storage
   contract must absorb it by construction.

## Decision

1. **A first-class content-addressed store is a runtime fact-ledger primitive.**
   The ledger exposes an immutable `content_store` contract — content-addressed
   `put-if-absent`, `get`, `has`, and `verify`, with an explicit hash algorithm
   and namespace/profile — in C++, Python, and Node. Features such as manifests,
   snapshots, and arbitrary user blobs are *uses* of this store plus the journal,
   never bespoke per-scenario content stores. Callers never program against a
   concrete engine (`rocksdb::DB`, `sqlite3`) directly.

   A general mutable `kv_store` is a separate, optional capability. If introduced,
   its `put` / `get` / `has` / `delete` / `scan` surface must define ordering,
   pagination, atomicity, consistency, and failure semantics independently. CAS
   deletion is not an ordinary caller operation; reachability-based deletion
   belongs to the later retention/GC contract.

2. **Content-addressing is the concurrency, dedup, and tiering enabler — not
   merely a simplification.** Content-addressed objects are write-once: their key
   is the hash of their bytes, so the bytes at a key can never change. This gives
   three load-bearing properties at fleet scale:
   - *Coordination-free logical keys:* two writers proposing the same hash must
     propose identical bytes; different hashes are different logical keys. The
     backend must still implement atomic publication, collision/mismatch checks,
     durability, and visibility. Content addressing removes logical overwrite
     conflicts; it does not claim the implementation has no locks or coordination.
   - *Fleet-wide dedup:* identical content is stored once regardless of how many
     agents produce it.
   - *Cold tiering:* immutable objects can be moved to cheap/cold storage,
     addressed by hash, without invalidating references.

3. **The content-store contract is backend-neutral within a declared capability
   profile, and the dependency direction is one-way: yijinjing owns the contract
   and depends on no concrete engine.** The content-store *interface* is a
   yijinjing primitive. Concrete engine-backed
   implementations (RocksDB, later sharded / distributed / object-store-tiered)
   live in the runtime / provider layer above it and are injected through the
   interface. **`libyijinjing` must not depend on, link, or include RocksDB (or
   any other specific engine); the dependency points from the implementation
   layer down to the yijinjing interface, never the reverse.** yijinjing ships a
   dependency-free default backend (a file-based content-addressed store) so its
   content store works standalone with zero heavy dependencies; RocksDB is an optional,
   injected, replaceable backend selected at the runtime / deployment layer for
   the scale profile. The same interface then serves a single embedded agent and
   a fleet, differing only in the injected backend:
   - single agent / small scale: the in-process default (file) or embedded
     RocksDB, no service;
   - fleet scale: the same contract behind a storage service, over a
     content-hash-sharded hot store plus an object-store cold tier.
   Callers retain the same content-addressed vocabulary, but local embedded and
   remote service profiles are interchangeable only for guarantees declared by
   the interface: hash identity, atomic put-if-absent, verified reads, durability
   level, visibility, error categories, size limits, and capability discovery.
   Transport retries, latency, pagination, and consistency must not be smuggled
   in as invisible local assumptions.

4. **Per-agent journals remove cross-agent contention on the journal write path.** Ordered per-agent event
   streams follow the yijinjing single-writer-per-location contract: each agent
   is its own writer to its own journal, so N agents are N independent writers
   with no cross-agent contention at that logical layer. This does not claim
   end-to-end linear scaling: catalog metadata, content publication, query, file
   descriptors, and storage-service coordination remain shared constraints.

5. **RocksDB is a candidate hot backend *at the runtime layer*, injected through
   the content-store interface; at fleet scale it is a per-shard part, not the whole store.**
   "Candidate" here means a production backend for the scale profile,
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

6. **Sharding is for scale, tiering is for retention; local lifecycle is solved
   separately.** The per-operation open/close of the current provider is a
   lifecycle artifact, not a RocksDB limit: RocksDB is thread-safe through a
   single long-lived handle, so within a process repeated open/close is removed by
   holding one handle owned by one runtime/provider instance — not by sharding.
   Multi-process ownership of one database path is not implied and must be
   rejected or service-fronted explicitly.
   Sharding (by content-hash prefix, preserving dedup) is reserved for genuine
   scale-out beyond a single instance; cold tiering (immutable objects to an
   object store, addressed by hash) is reserved for retention beyond hot
   capacity. Both are enabled by content-addressing.

7. **Scale target is a validation envelope, not a current guarantee.** Design the
   content-store contract so a backend can report capabilities and scale without
   changing content identity. Single-node TB claims, content-hash sharding to
   hundreds of TB, and PB-tier topology require benchmark and dogfood evidence
   before they become supported capacity commitments. PB explicitly means a
   sharded / tiered / distributed backend, never a single local engine.

## For implementers: the dependency boundary (do not make yijinjing depend on RocksDB)

This is the single most confusable point; read it before writing code.

- **The content-store interface belongs to `libyijinjing`.** An abstract
  `content_store` interface (`put-if-absent` / `get` / `has` / `verify`, hash
  algorithm, namespace/profile, and capabilities) plus a dependency-free default backend
  (file-based content-addressed) live in the kernel. `libyijinjing` must build,
  link, and run with **no RocksDB dependency at all**.
- **The RocksDB-backed `content_store` lives in the runtime / provider layer**
  (`libkungfu`), which is the only place allowed to include and link RocksDB. It
  implements the yijinjing interface and is injected into the kernel through that
  interface at runtime — the kernel receives a `content_store*`, never a
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
- Callers (manifest storage, snapshots, user features) depend only on the
  yijinjing content-store interface. They never see RocksDB, SQLite, LMDB, or a
  distributed backend. Backend changes are invisible only within the declared
  capability and consistency profile.

## Consequences

- The content store becomes a stable substrate contract that outlives any one record type;
  the storage record family (ADR-0037) and the import-manifest migration build on
  it rather than defining private stores.
- "Embedded, no extra service" holds for a single agent and small scale; a large
  concurrent fleet requires a storage service / tier. Callers retain content
  identity, while deployment-specific capabilities remain explicit.
- Content-addressing removes logical overwrite conflicts and enables dedup; the
  backend still owns atomic publication, durability, and visibility.
- RocksDB remains a candidate for the large-scale write-heavy envelope.
  The earlier suggestion (in the ADR-0037 discussion) to consider dropping it was
  scoped to a 3 MB control-plane store; under a fleet-scale fact-ledger
  requirement that suggestion is withdrawn.
- A gc / retention / compaction policy becomes first-class at this scale
  (ADR-0018 deferred destructive gc); this ADR sets the scale context that policy
  must serve but does not define it.

## First delivery (staged)

- Define the first-class immutable `content_store` interface
  (`put-if-absent` / `get` / `has` / `verify`, hash algorithm,
  namespace/profile, capabilities) in `libyijinjing`, with a dependency-free
  file backend. The file backend must prove atomic publish, hash mismatch
  rejection, crash-safe visibility, and verified reads. Add symmetric
  Python/Node facades over this surface.
- Add the boundary gate that fails if `libyijinjing` references RocksDB (or any
  concrete engine) by include, symbol, or link, in the spirit of ADR-0039's
  `check-view-boundary.mjs`.
- Provide the RocksDB-backed `content_store` in the runtime / provider layer
  (`libkungfu`), held as a single long-lived handle owned by one provider
  instance (retiring per-operation open/close for the hot path), injected into
  the kernel through the interface.
- Prove content-addressed `put-if-absent` dedup and concurrent-writer safety at
  the single-node level.
- Then, as separate work: content-hash sharding, the object-store cold tier, the
  fleet storage service, a mutable KV contract, and the retention/gc policy.

## Explicitly out of scope

- The import-manifest record migration itself (a use of this store + journal),
  recorded and delivered separately.
- The distributed / service-fronted backend implementation; this ADR fixes the
  contract and topology direction, not that implementation.
- Destructive gc / compact execution and the retention policy (ADR-0018); this
  ADR only sets their scale context.
- The trading market-data ledger; its volume profile is different and is not the
  subject here.
- The choice of cold-tier object store and any distributed KV; those are backend
  decisions under this contract, taken when scale-out work begins.
- A general mutable KV contract, including delete, ordered scan, transactions,
  compare-and-set, or distributed consistency semantics.

## Alternatives considered

- **Store all manifest/record data as journal frames (append every entry).**
  Rejected as the general model. It over-applies the Episode append-only frame
  pattern to high-cardinality, regenerated-per-sync snapshot data, causing
  journal churn with destructive gc deferred. The compact acceptance receipt
  belongs in the journal; the entry set belongs in the content-addressed store as
  a sealed object. (ADR-0037 point 3 "sealed roots are immutable" is consistent
  with this.)
- **A bespoke content store per scenario.** Rejected. It fragments immutable
  body storage; content identity needs one first-class contract.
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

- The backend-neutral contract must define atomic put-if-absent, hash mismatch,
  durability, visibility, error categories, size limits, and capability
  discovery tightly enough that embedded and service-backed profiles preserve
  the same content semantics without pretending they have identical latency or
  consistency behavior.
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
- Fleet-scale correctness still depends on ownership and concurrency contracts
  for mutable metadata and catalog journals. Content addressing does not solve
  those shared-write paths.
