# Episode Object Model

Status: accepted design direction. The term and invariants are accepted by
[ADR-0033](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md);
the physical storage layout is not fully implemented yet.

Kungfu needs a storage object that matches the way users and agents reason about
work. Raw mmap pages are append blocks. A source is a provenance and sync
identity. A session/run is a product-facing view. None of those is the stable
unit that can be exported, imported, verified, hidden, merged, compacted, and
rendered as "the thing that happened."

That object is an **Episode**.

## Definition

An Episode is a first-class, bounded causal segment in the Kungfu fact ledger.
It contains the journal frames, payload commitments, source provenance, schema
references, receipts, dependency metadata, and rebuildable projections needed
to inspect one closed unit of action.

In one sentence:

```text
Episode = causal-closure container + storage/export/fsck unit + timeline input.
```

The object is intentionally not named `Lifecycle` or `Execution`:

- `Lifecycle` collides with object/process/component lifecycle terminology.
- `Execution` sounds like a machine-only action.
- `Episode` names a distinctive Kungfu object: a bounded segment of the
  world-facing causal timeline.

## Invariants

An implementation is Episode-compatible only if these rules hold:

| Invariant | Meaning |
| --- | --- |
| Causal closure | Frame-level causal links inside an Episode resolve to frames in the same Episode. |
| Declared external influence | Cross-Episode influence is recorded as Episode dependencies, not an undeclared frame chain crossing the boundary. |
| Stable projection input | Timeline views select Episodes, then deterministically project their frames under observer policy. |
| Manifest authority | The Episode manifest names the included frames, payloads, schemas, dependencies, source provenance, and verification roots. |
| Rebuildable indexes | SQLite and GUI query rows are derived from Episode manifests and frames, not authority roots. |
| Tombstone before removal | Removing an Episode from normal views is a tombstone/projection decision before any physical garbage collection. |

The causal closure rule is the most important one. It lets Kungfu answer:

- Can this unit be exported by itself?
- Can another runtime import and fsck it?
- Can Rewind explain the action chain without silently chasing missing local
  pages?
- Can a GUI hide this unit without corrupting another unit's causal tree?

## Relation To Timeline Projection

Kungfu's global timeline is not the raw order of mmap pages. The stable model is:

```text
Timeline(view) = deterministic projection(
  selected Episode set,
  observer policy,
  dependency constraints,
  source-local order,
  tie-breakers
)
```

This extends ADR-0021. A machine does not need to prove one universal global
clock. It needs a declared view that can be reproduced from accepted facts and
policy.

Episodes make the projection input explicit:

- Importing or accepting an Episode expands the local selected fact set.
- Tombstoning or hiding an Episode shrinks the default selected fact set.
- Duplicate frame timestamps remain valid if dependency and merge rules are
  deterministic.
- A projection must not invert declared Episode dependencies or known in-Episode
  causal links.

## Relation To Source Sync

Sources, locations, and channels remain important, but they are not the final
object boundary:

| Concept | Role |
| --- | --- |
| Source | Logical provenance and sync registry entry. |
| Location | Runtime identity/address that writes, reads, or serves data. |
| Channel | Transport/request edge between locations. |
| Episode | Accepted causal object that becomes part of the local fact set. |

A remote runtime should not become a special local `remote-120` storage island.
It is a source reachable through one or more locations and channels. When local
Kungfu imports a verified Episode from that source, the Episode becomes local
data with provenance attached.

## Physical Shape

The target storage shape is Episode-aware and journal-backed:

```text
episode manifest journal
  yijinjing mmap frames for Episode metadata records

event journals
  yijinjing mmap frames for runtime/action facts

payload store
  content-addressed payload bodies

projections
  rebuildable indexes and folded views
```

The local authority for Episode manifest facts is not a loose JSON file. ADR-0034
defines manifest records as yijinjing first-class data structures stored in a
yijinjing-backed append-only manifest journal. Providers may maintain
content-addressed files, RocksDB indexes, SQLite projections, or exported JSON
views, but those are not the manifest authority.

The lower journal shape should move toward:

```text
Episode
  -> segment allocation domain
  -> mmap pages
  -> frames
```

That avoids making a semantic object fight the physical substrate. It does not
mean every Episode must own exactly one file. Long Episodes may span pages or
segments. Small Episodes may share provider blocks if the manifest and fsck
proofs remain unambiguous. The important rule is that every frame can be mapped
to Episode coordinates and every Episode can name the physical evidence that
proves it.

## Episode Manifest

A sealed Episode manifest is the folded result of append-only manifest journal
records. It should carry enough data for fsck, export/import, and timeline
projection:

| Field | Meaning |
| --- | --- |
| `episode_id` | Stable id, eventually content-addressed from the sealed manifest/root. |
| `episode_version` | Contract version for manifest semantics. |
| `status` | `open`, `sealed`, `tombstoned`, or later maintenance states. |
| `writer_location` | Location that opened or wrote the Episode. |
| `source_refs` | Sources that contributed facts or payloads. |
| `frame_ranges` | Frame ranges, frame ids, or segment/page coordinates included. |
| `payload_inventory` | Payload refs, byte lengths, states, and content hashes. |
| `schema_inventory` | Schemas required to decode payloads. |
| `depends_on_episode_ids` | Declared cross-Episode dependencies. |
| `projection_refs` | Rebuildable projection/index refs and watermarks. |
| `sync_root` | Hash root for fsck/export/import verification. |
| `created_at` / `sealed_at` | Diagnostic timestamps, not cross-machine ordering truth. |

Open Episodes may have provisional ids. A sealed Episode should get a stable id
derived from its manifest/root so export/import can be idempotent.

The manifest journal records the history that produces this folded view:

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

JSON may be emitted as an export/debug/folded view, but Python, Node, CLI, and
GUI code should treat the C++/yijinjing manifest journal as the local source of
truth.

## Core Operations

Episode-native storage should expose these operations through the C++ core
surface first, then through Python/Node bindings and CLI/GUI commands:

| Operation | Semantics |
| --- | --- |
| `open` | Create an open Episode allocation domain and initial dependency set. |
| `append` | Write frames and payload commitments into the current Episode. |
| `seal` | Freeze the manifest, compute roots, and make the Episode import/export ready. |
| `query` | Read Episode metadata, frame lists, dependencies, and projection rows. |
| `export` | Produce a portable bundle for selected Episodes. |
| `import` | Verify and accept Episode bundles into the local fact set. |
| `fsck` | Verify closure, frames, payloads, schemas, roots, dependencies, and projections. |
| `tombstone` | Exclude an Episode from default views without rewriting retained evidence. |
| `gc` | Collect unreachable payloads/pages after tombstone, archive, and retention policy. |
| `compact` | Archive, rebuild projections, vacuum/compact providers, and report restore paths. |

All destructive or history-reducing operations need dry-run/preview output.

## Fsck Rules

Episode fsck should verify at least:

- every included frame is readable and mapped to the Episode;
- every `trigger_frame_uid` or equivalent frame-level causal parent resolves
  inside the Episode;
- external dependencies are declared as Episode ids;
- payload refs exist or are explicitly marked redacted/absent/missing;
- present payload hashes and byte lengths match the manifest;
- required schemas resolve;
- projection rows can be rebuilt from the Episode evidence;
- hash roots/sync roots recompute;
- tombstoned Episodes are not selected by default projections unless requested.

Fsck must report degraded evidence. It must not invent causality or silently
repair a missing payload by treating it as absent.

## Migration Plan

The migration can be staged without pretending the physical layout is already
complete:

1. **Documentation and contracts** — accept ADR-0033, publish this design, and
   add C++ vocabulary types for Episode ids, manifests, dependencies, and fsck
   issues.
2. **Manifest journal records** — add yijinjing first-class Episode manifest
   record types in C++ before adding Python/Node convenience APIs.
3. **Logical Episode index** — let current storage manifests and source imports
   name Episodes, even if the frames still live in existing journal pages.
4. **Episode-aware writer** — make the C++ action recorder/storage writer open,
   append to, and seal Episodes; expose thin Python/Node bindings.
5. **Episode-aware providers** — make file/RocksDB providers store and query
   Episode manifests and frame coordinates as first-class records.
6. **Episode export/import/fsck** — support `kungfu storage export/import/fsck`
   by Episode selectors and bundles.
7. **GUI/Rewind** — render Episodes as the primary work slices; timeline views
   project selected Episodes rather than raw source/page streams.
8. **Maintenance** — implement tombstone, gc, compact, archive, and restore
   around retained Episode sets.

During the migration, source/range/date selectors remain useful compatibility
filters. They should gradually become ways to select Episodes, not substitutes
for the Episode object.

## Non-goals

- One universal global wall-clock order.
- Conflict resolution between independently edited Episodes.
- A guarantee that every Episode maps to one physical mmap file.
- A user-visible model where mmap page names are the primary object.
- Replaying real-world side effects without explicit replay mode boundaries.

## Maturity

Episode is currently an accepted architecture direction and documentation
surface. Existing storage commands still operate on sources, manifests, scopes,
and ranges. The next implementation work is to add C++ Episode vocabulary and
logical manifests, then move the writer/provider surfaces toward Episode-aware
allocation and fsck.
