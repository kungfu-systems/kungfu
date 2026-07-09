# ADR-0033: Episode is the first-class causal segment object

- Status: accepted
- Date: 2026-07-09
- Category: (architecture) storage object model and causal timeline slicing
- Subsystem: yijinjing journal/storage kernel, runtime storage service,
  source sync, fsck, export/import, Rewind, and GUI timeline views.
- Related: ADR-0018 defines the runtime storage service. ADR-0019 defines
  Git-like source sync over `location` and `channel`. ADR-0020 defines the
  action timeline and replay boundary. ADR-0021 defines observer-relative
  timeline projection. ADR-0032 defines the generic source service v1. ADR-0034
  defines the yijinjing-backed Episode manifest journal.
  [`docs/episode-object-model.md`](../../../../docs/episode-object-model.md)
  is the companion design document.

## Context

Kungfu's lowest journal mechanism is append-only. Writers append frames to
memory-mapped pages, readers follow those pages, and the global event stream can
span many files. That is correct for the hot path, but it is not the unit users
or agents naturally need to reason about.

A meaningful unit of work can start in the middle of one mmap page and finish in
the middle of another. It may contain frames, payload references, projection
rows, source metadata, receipts, and later imported evidence. If Kungfu keeps
only raw page boundaries, it is hard to export, import, verify, delete, compact,
or visualize "the thing that happened" as one object.

Git and container systems are useful comparisons because they made semantic
storage objects first-class: commits, trees, packs, image layers, and manifests
are the units that can be copied, verified, hidden, or merged. Kungfu should not
copy their filesystem-snapshot model, because Kungfu records causal runtime
facts rather than filesystem state. It does need an equivalent first-class
object for a bounded causal segment.

The name matters. `Execution` is too machine-action oriented, and `Lifecycle`
collides with common software object/process lifecycle terminology. `Episode`
is distinct enough to become a Kungfu term: a bounded segment of action and
causality in the ledger.

## Decision

Kungfu defines **Episode** as the first-class causal segment object.

An Episode is a bounded container of causal facts. It is the unit that storage,
sync, export/import, fsck, GUI inspection, and later maintenance operations
should be able to address directly.

The core invariants are:

- Episode is a causal-closure container.
- Frame-level causality must be closed inside one Episode.
- Cross-Episode influence is represented at the Episode level through declared
  dependencies, not by an undeclared naked frame-level chain crossing Episode
  boundaries.
- A timeline is not raw mmap order. It is a deterministic projection over a
  selected set of Episodes under an explicit observer policy.
- Adding an Episode to the selected set expands the local fact projection.
  Hiding or tombstoning an Episode shrinks the default projection without
  rewriting older facts.

This does not require "one Episode equals one mmap file." The storage direction
is:

```text
Episode
  -> segment / page allocation domain
  -> frames
  -> payload references
  -> projections
  -> manifest / hash root / dependency metadata
```

The journal and mmap pages remain implementation blocks. They should become
Episode-aware allocation and verification blocks, rather than the user-visible
fact object. Page headers, segment metadata, manifests, and indexes should carry
enough Episode coordinates to answer "which Episode owns this frame?" and "which
physical pages prove this Episode?"

An Episode manifest is the trust boundary for the object. It records at least:

- Episode identity and manifest version;
- open/sealed/tombstoned status;
- frame ranges or frame ids included in the Episode;
- payload inventory and content hashes;
- schema inventory;
- source and location provenance;
- declared dependency Episode ids;
- projection and query indexes that can be rebuilt;
- hash roots or sync roots needed by fsck/export/import.

Delete-like operations are tombstone plus garbage collection. The first-class
operation is not "erase these mmap bytes"; it is "exclude this Episode from the
default projection, then eventually collect unreachable payloads/pages when the
retention and archive policy permits."

## Consequences

- The natural unit for future `storage export`, `storage import`, `source sync`,
  `fsck`, `compact`, and GUI inspection becomes Episode, not session directory,
  raw mmap file, or arbitrary date range.
- `Timeline(view)` becomes a projection over selected Episodes. Duplicate frame
  times are acceptable if the projection policy and Episode merge rules are
  deterministic and do not invert declared causality.
- Rewind can present a coherent object: an Episode contains one causal tree or a
  closed set of causal trees, plus the evidence needed to inspect it.
- The C++ core must own Episode contracts. Python, Node, GUI, and CLI surfaces
  may expose and render Episodes, but they must not invent separate Episode
  identity, causality, export/import, or fsck semantics.
- Storage providers should be judged by whether they preserve Episode
  invariants, not by their backend name. Content-addressed files, RocksDB,
  SQLite projections, and mmap pages are implementation facilities behind the
  service.
- Migration can start logically: manifests and indexes can identify Episodes
  before the mmap writer fully allocates page files by Episode. The target
  architecture still makes Episode the physical organization domain.
- Manifest facts are append-only yijinjing records, not loose JSON authority.
  JSON can be exported as a folded view, but the local manifest authority is
  decided separately in ADR-0034.

## First delivery

This ADR is a design commitment. The first delivery is documentation-level:

- accept the `Episode` term and invariants;
- add the companion design document;
- route docs for storage, event model, and documentation map to the Episode
  object model.

No on-disk journal layout change is claimed by this ADR. Existing storage
commands still operate on sources, manifests, scopes, and ranges. Future
implementation slices should move those surfaces toward Episode-native
selectors and manifests.

## Explicitly out of scope

- Implementing the new mmap layout immediately.
- Rewriting existing journal pages or source manifests.
- Solving conflict resolution between independently edited Episodes.
- Claiming one absolute global clock or one universal observer view.
- Re-executing external side effects during Episode replay; ADR-0020 controls
  that replay boundary.

## Alternatives considered

- **Use session or run as the storage object.** Rejected. A session/run is a
  useful product view, but it is too tied to one agent/process vocabulary. The
  object must also cover scripts, imports, remote bundles, and future runtime
  actions that are not named as agent runs.
- **Use Lifecycle.** Rejected. It is semantically close, but it collides with
  common software lifecycle terminology and would be easy to confuse with
  object, process, or component lifecycle hooks.
- **Use Execution.** Rejected. It over-centers machine execution and underplays
  the reality that Kungfu models a causal segment in the world-facing timeline.
- **Keep mmap/page files as the object.** Rejected. Page boundaries are
  implementation boundaries. They do not match the causal/user boundary and
  would make export/import, deletion, GUI inspection, and fsck harder.
- **Allow frame-level causality to cross Episode boundaries freely.** Rejected.
  That would make an Episode impossible to move or verify as a closed object.
  Cross-Episode influence must be explicit at the Episode dependency layer.

## Residual risk

- If implementation only adds Episode indexes above an unchanged physical
  layout, large maintenance operations may still pay unnecessary page scanning
  costs. The index-first phase is acceptable, but the target is Episode-aware
  physical organization.
- If GUI labels every source import as an Episode without enforcing causal
  closure, users will trust an object that cannot be independently exported or
  verified. Fsck must make closure visible.
- If Episode dependency metadata is not versioned early, different nodes may
  project the same Episode set differently. Projection and dependency policy
  must be declared and fixture-tested once implemented.
