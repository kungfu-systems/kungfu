# Runtime Storage Service

Status: draft design plan.

Kungfu's fact ledger is not only an event capture mechanism. Long term, it is
also the local persistence service for user facts: runs, work items, imported
profiles, payload bodies, projections, bundles, and remote mirrors. That service
must be inspectable and maintainable in the same way a user expects from a
serious local database.

This document ties together the existing fact-ledger format direction, current
journal maintenance commands, Atlas import, remote sync, and the missing storage
operations such as fsck, import/export, garbage collection, and compaction.

## Existing Ground

The lower-level contract already exists in pieces:

- `framework/spec/docs/format-spec.md` defines an append-only event spine,
  content commitments, a blob store, schema registry, and manifest root.
- `framework/core/slices/fact-ledger/README.md` proves a minimal causal journal
  slice and marks the external hash-blob store as future work.
- `docs/debugging.md` documents journal inspection and index rebuild commands.
- The spec error dictionary already includes missing-payload and hash-mismatch
  classes.
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

The first runtime backend may use RocksDB, content-addressed files, SQLite blob
tables, or a mix. That choice must remain behind the storage service. Public
commands and SDKs should talk about events, payload references, manifests,
watermarks, bundles, projections, and verification.

## Command Surface

The service should grow behind a stable top-level surface:

```sh
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
- schema ids and versions resolve;
- each payload reference is explicitly present, redacted, absent, or missing;
- present payloads match their committed hash and byte length;
- derived SQLite projections can be rebuilt from journal plus payloads;
- current projection watermarks match the event ranges they claim;
- remote/source manifests and cursors are internally consistent.

Example target:

```sh
kungfu storage fsck --scope atlas --json
kungfu storage fsck --scope all --since 20d --json
```

`fsck` should report degraded facts without rewriting them. A missing payload is
not repaired by pretending it was absent; it is reported as missing until an
import, repair, or redaction decision changes that state.

## Import And Export

Import/export should become the shared mechanism for:

- moving a run or work item between machines;
- syncing source-scoped remote mirrors;
- importing Atlas or another profile by range;
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
- source metadata;
- watermarks and idempotency keys;
- enough data for verification to be recomputed.

Example target:

```sh
kungfu storage export --scope atlas --since 20d --out atlas.kfbundle --json
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

## Atlas Import Path

Atlas import is the first high-value profile for this service.

Initial authority boundary:

```text
Atlas remains source of truth.
Kungfu imports and verifies a local projection.
```

For each imported Atlas object, Kungfu should eventually record:

- source kind and stable source coordinate;
- source path or source id;
- source Git head or equivalent version;
- import id and batch id;
- schema id/version;
- content type;
- content hash;
- byte length;
- payload state;
- event range/cursor;
- projection watermark.

This lets `kungfu atlas import` remain safe and one-way while still exercising
the same payload, manifest, fsck, and rebuild mechanisms required for future
remote sync and authority migration.

The first useful slice is:

```sh
kungfu atlas import --repo <atlas-repo> --json
kungfu storage status --scope atlas --json
kungfu storage fsck --scope atlas --json
kungfu storage rebuild-index --scope atlas --json
```

Acceptance for that slice:

- large Atlas JSON bodies are stored outside mmap frames as hash-addressed
  payloads;
- journal events carry payload hash, size, content type, and state;
- import writes a manifest with source head, object count, event range, payload
  inventory, and projection watermark;
- `fsck` detects missing payloads, hash mismatches, missing schemas, and
  projection drift;
- `rebuild-index` reconstructs the Atlas projection from journal plus payloads.

## Safety Boundaries

Storage service operations must preserve these boundaries:

- no silent partial import;
- no raw secret, token, cookie, billing page, signed URL, or hidden provider
  session store capture;
- skipped sensitive sources are recorded as redacted or explicitly absent;
- reported/imported facts keep source and attribution labels;
- remote mirrors are source-scoped and not mixed into local authority without an
  explicit import boundary;
- projections are disposable, payloads referenced by retained events are not.

## Open Decisions

- First payload backend: RocksDB, content-addressed files, SQLite blob table, or
  a hybrid.
- Exact encoding for present/redacted/absent/missing payload state.
- Whether `compact` ships as one command first, or later after `checkpoint`,
  `gc`, and `rebuild-index` are boring.
- How much Atlas profile semantics should remain `atlas/*` versus become a
  generic imported-fact profile.
- When an imported source is allowed to become the source of truth.

## Maturity

This is a draft design plan. It names the service boundary and phased target. It
does not yet claim that Kungfu can repair arbitrary journal corruption, safely
compact user data, or replace Atlas as an authority source.
