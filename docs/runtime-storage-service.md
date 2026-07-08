# Runtime Storage Service

Status: draft design plan with an implemented Atlas first slice.

Kungfu's fact ledger is not only an event capture mechanism. Long term, it is
also the local persistence service for user facts: runs, work items, imported
profiles, payload bodies, projections, bundles, and remote mirrors. That service
must be inspectable and maintainable in the same way a user expects from a
serious local database.

This document ties together the existing fact-ledger format direction, current
journal maintenance commands, Atlas import, source sync, remote sync, and the
missing storage operations such as `fsck`, import/export, garbage collection,
and compaction.

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

The first runtime backend may use RocksDB, content-addressed files, SQLite blob
tables, or a mix. That choice must remain behind the storage service. Public
commands and SDKs should talk about events, payload references, manifests,
watermarks, bundles, projections, source locations, and verification.

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

Example target:

```sh
kungfu storage fsck --scope atlas --json
kungfu storage fsck --scope all --since 20d --json
kungfu source fsck atlas-local --since 20d --json
```

`fsck` reports degraded facts without rewriting them. A missing payload is not
repaired by pretending it was absent; it is reported as missing until an import,
repair, or redaction decision changes that state.

## Import And Export

Import/export should become the shared mechanism for:

- moving a run or work item between machines;
- syncing source-scoped remote mirrors;
- importing Atlas, another profile, or another adapter by range;
- repairing missing payloads by hash;
- producing portable audit bundles.

Filters should support at least:

- source id;
- scope/profile, such as `atlas`, `work`, `rewind`, or `all`;
- session or run id;
- `--since` / `--until`;
- cursor or event range;
- hash inventory.

The bundle must carry:

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

The implemented first slice is:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage status --scope atlas --json
kungfu storage fsck --scope atlas --json
kungfu storage export --scope atlas --format jsonl --out atlas.jsonl --json
kungfu atlas verify --repo <atlas-repo> --json
```

Acceptance covered by that slice:

- large Atlas JSON bodies are stored outside mmap frames as hash-addressed
  payloads;
- import writes a manifest with source head, object count, payload inventory,
  and projection watermark;
- `fsck` detects missing payloads, hash mismatches, malformed payload JSON, and
  projection drift against the current Atlas projection;
- `storage export` emits a canonical JSONL record per imported Atlas payload;
- `atlas verify` recomputes source hashes from the Atlas repo and compares them
  with the latest imported payload manifest.

The first slice deliberately does not claim generic storage compaction, range
sync, schema repair, or a complete rebuild-index command yet.

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
export, and source-verify loop. Kungfu still does not claim that it can repair
arbitrary journal corruption, safely compact user data, run range/session/hash
remote sync, or replace Atlas or any other external source as an authority
source.
