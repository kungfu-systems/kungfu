# ADR-0018: Runtime storage service as the persistence contract above journal, payloads, and projections

- Status: accepted
- Date: 2026-07-08
- Category: (architecture) persistence contract — how Kungfu stores user facts
  without exposing storage-engine choices as product semantics
- Subsystem: `framework/core` journal runtime, fact-ledger format direction,
  Atlas import storage slice, payload/blob storage, SQLite projections, and the
  user-facing `kungfu storage` command surface.
- Related: ADR-0001 pins the journal publish barrier; ADR-0002 pins the
  yijinjing schema runtime schema; ADR-0011 pins the capability SDK contract.
  [`docs/runtime-storage-service.md`](../../../../docs/runtime-storage-service.md)
  is the companion reference page for the staged command surface, fsck/export,
  compaction, and source adapter path. ADR-0019 separately decides the
  multi-machine source sync model above this storage contract.

## Context

Kungfu already has the lower layers needed for a local fact ledger:

- an append-only journal with frame provenance, order, and causal routing;
- stable typed schemas and a portable fact-ledger format direction;
- large-payload content commitments and a blob-store direction;
- SQLite projections that are useful for query and UI state but must remain
  rebuildable;
- a first Atlas import slice that stores large JSON payloads outside mmap
  frames, writes manifests, runs `fsck`, exports JSONL, and verifies source
  hashes against the Atlas repository.

Those pieces are not yet one product contract. Without such a contract, callers
would need to know whether a fact lives in journal mmap, content-addressed
files, RocksDB, SQLite, or a temporary adapter directory. That leaks backend
choices into the API and makes long-term maintenance operations hard to define.

The user-facing need is broader than event capture. Kungfu must become the
local persistence service for runs, work items, imported profiles, payload
bodies, source mirrors, projections, and audit bundles. It must also be able to
prove and maintain that storage through read-only checks, rebuilds, exports,
garbage collection, and eventual compaction.

## Decision

Kungfu will expose a **runtime storage service** above the raw storage engines.
The public contract talks about facts, payload references, manifests, schemas,
projections, watermarks, source metadata, and verification results; it does not
promise a specific backend such as RocksDB, SQLite, mmap frames, or files.

The storage semantic contract belongs to `libyijinjing`, the journal/fact-ledger
kernel. Runtime code may implement the contract with RocksDB, content-addressed
files, SQLite projections, or other backends, but those implementations sit in
`libkungfu` above the kernel. Python and Node expose bindings over the C++
surface; they do not own independent storage semantics.

The binding rule is executable, not just architectural: Python storage helpers
must delegate to `pykungfu.runtime.*storage*` functions backed by
`libkungfu::runtime::storage_service_api`, and Node storage helpers must delegate
to `kungfu_node` functions backed by the same C++ service. Any new GUI, CLI, or
agent-facing JavaScript surface that needs storage maintenance/status data
should call the Node binding (or a shell command that reaches the same service),
not reimplement manifest scanning, fsck, import/export, rebuild, GC, compact, or
sync verification in JavaScript.

The `libyijinjing` storage contract must expose the Git-like synchronization
vocabulary as C++ data contracts, not as Python-only or JavaScript-only helper
records: source refs, source heads, range selectors, hash inventories, channel
requests/cursors, bundle manifests, accepted segments, import/export/sync
results, and fsck issue/report records. `libkungfu` may bind and implement those
interfaces, but it must not redefine the architecture-level vocabulary.

The architecture has these roles:

| Part | Role | Authority |
| --- | --- | --- |
| Journal | Event spine, ordering, causality, payload commitments | Authoritative for topology and content commitment |
| Payload/blob store | Large bodies addressed by hash | Authoritative body when present and hash-verified |
| SQLite projections | Query/index/cache views | Derived and rebuildable |
| Manifest/schema registry | Capture boundary, provenance, schemas, versioning | Trust and decode root for bundles |
| Source registry | Known sources, accepted ranges, heads, and watermarks | Local record of what has been accepted |

The storage service owns the semantic operations:

- `kungfu storage status` reports scope, manifest, projection, and payload
  state.
- `kungfu storage fsck` verifies journal readability, event topology, payload
  presence, hashes, schemas, projection watermarks, and manifest consistency.
- `kungfu storage export` produces a portable, verifiable bundle or stream.
- `kungfu storage import` verifies and accepts a bundle into local storage.
- `kungfu storage rebuild-index` rebuilds derived projections from authoritative
  facts.
- `kungfu storage gc` removes only unreachable payload bodies.
- `kungfu storage compact` composes checkpointing, archive bundle creation,
  payload GC, projection vacuum/rebuild, and backend compaction where available.

All agent-facing commands must support `--json`. Any operation that deletes,
archives, rewrites, or compacts facts must have a preview or dry-run mode before
execution.

## Consequences

- Backend choices stay replaceable. RocksDB, content-addressed files, SQLite
  blob tables, mmap frames, or hybrids can be adopted per slice without changing
  the product vocabulary.
- `libyijinjing` remains the language-neutral storage contract surface, while
  `libkungfu` remains the runtime/provider/projection/binding layer above it.
- Future Python, Node, and C++ action-recording users share the same storage
  vocabulary; language bindings call the C++ contract surface instead of
  inventing independent import/export/fsck models.
- The Node package is a first-class storage consumer: `@kungfu-tech/core`
  exposes native binding functions for capabilities, request construction,
  operation execution, manifest acceptance, latest-manifest loading, record
  export, and payload writes. These functions are JSON/bytes adapters over
  `libkungfu`, not a Node storage engine.
- The first provider family has two C++ implementations behind the same service
  surface: the default content-addressed file provider and an optional RocksDB
  payload/manifest provider. Provider selection is an implementation option;
  Node and Python continue to call the same native runtime service.
- Large payloads are not stored by making journal frames arbitrarily large. The
  journal carries commitments and metadata; the payload store carries bodies.
- SQLite is a projection facility, not the authority root. It may be rebuilt
  from journal, payloads, manifests, and schemas.
- `fsck` is a first-class storage operation. It reports corruption, drift,
  missing payloads, malformed payload JSON, and projection mismatch without
  silently repairing or rewriting facts.
- Import/export becomes a verification path as well as a portability path.
  Exported data must carry enough manifest, schema, payload inventory, and
  watermark information for verification to be recomputed.
- Compaction is not a destructive history rewrite. It is a reported maintenance
  operation over retained ranges, archived ranges, payload reachability, and
  projections.

## First delivery

The accepted first delivery is the Atlas-scoped proof surface:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage status --scope atlas --json
kungfu storage fsck --scope atlas --json
kungfu storage export --scope atlas --format jsonl --out atlas.jsonl --json
kungfu atlas verify --repo <atlas-repo> --json
```

That slice proves the direction without claiming the whole service is complete:

- Atlas large JSON bodies are stored outside mmap frames as hash-addressed
  payloads. The default provider stores those payloads as content-addressed
  files; the RocksDB provider stores the same payloads, manifests, and source
  registry records in a C++-owned key/value backend.
- Import writes a manifest with source head, object count, payload inventory,
  and projection watermark.
- `fsck` detects missing payloads, hash mismatches, malformed payload JSON, and
  projection drift.
- `storage export` emits canonical JSONL records for imported Atlas payloads.
- `atlas verify` recomputes hashes from the Atlas repo and compares them with
  the imported payload manifest.

## Explicitly out of scope

- Choosing RocksDB, SQLite blob tables, files, or another backend as the final
  large-payload store for every runtime profile. The service now has a RocksDB
  provider slice, but the product contract remains provider-neutral.
- Repairing arbitrary journal corruption.
- Declaring Atlas or any imported source no longer authoritative.
- Defining cross-machine fetch/pull semantics, channel protocol, conflict
  handling, or source authority transfer. Those are ADR-0019 concerns.
- Shipping destructive `gc` or `compact` before the reporting and rollback
  contract is implemented.

## Alternatives considered

- **Store every large object directly in the journal.** Rejected. It bloats mmap
  frames, weakens hot-path replay properties, and makes payload-level fsck and
  repair awkward. The journal should commit to payloads; it should not be the
  only payload body store.
- **Make SQLite the single source of truth.** Rejected. SQLite is excellent for
  projection and query, and Kungfu can use it heavily, but it should remain
  rebuildable from the fact ledger and payload commitments.
- **Expose RocksDB or another KV store as the product API.** Rejected. Engine
  names are implementation details. The stable contract is about facts,
  manifests, payloads, verification, and projections.
- **Keep import/export as Atlas-specific commands.** Rejected. Atlas is the
  first high-value adapter, not a special storage architecture. The mechanism
  should generalize to other sources and later to remote Kungfu runtimes.

## Residual risk

- The storage contract can drift if early commands remain Atlas-scoped for too
  long. Shared storage schemas, fixtures, and non-Atlas smoke tests should land
  as soon as a second source exists.
- `compact` is easy to overclaim. It must stay staged until the archive,
  reachability, dry-run, and rollback report are all boring.
- Projection rebuilds may hide payload or schema corruption if they are used as
  repair instead of verification. `fsck` must verify authoritative inputs first.
