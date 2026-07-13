# Episode Object Model

Status: accepted design direction with v1 implementation. The term and
invariants are accepted by
[ADR-0033](./adr/ADR-0033-episode-causal-segment-object.md).
[ADR-0034](./adr/ADR-0034-yijinjing-episode-manifest-journal.md)
defines the append-only yijinjing manifest journal. The full Episode-aware
physical journal layout is still future work.
[ADR-0042](./adr/ADR-0042-episode-atomic-safety-and-qualification.md)
proposes Episode as the atomic safety and fault-containment unit: degradation
preserves verified work and contracts only the capabilities that missing or
unverifiable evidence cannot safely support. Its executable verification design
lives in [Episode Atomicity Qualification](episode-atomicity-qualification.md).

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

[`journal-page-sizing-and-episode-reclamation.md`](journal-page-sizing-and-episode-reclamation.md)
records the design judgment that constrains this future work: page-size variation
serves only the max-frame bound at page creation, space efficiency comes from
segment packing rather than per-Episode variable-length pages, and reclamation is
tombstone-then-cold-path GC rather than shrinking live pages.

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

## V1 Implementation

Episode manifest v1 is implemented as a system catalog journal at:

```text
journal/system/storage/episode-manifest/live/*.journal
```

In the workspace data-home layout this resolves to:

```text
.kungfu/runtime/journal/system/storage/episode-manifest/live/*.journal
```

Use `kungfu storage layout --json` to inspect the fully resolved absolute path
for the current process. That command reports the workspace data home, runtime
dir, storage provider paths, SQLite projection path, and Episode manifest
journal path through the C++ storage service. The JSON output is intentionally
only an inspection view; the append-only yijinjing manifest journal remains the
Episode authority.

The authority records are yijinjing Hana/POD schema records:

| Record | Tag | Purpose |
| --- | ---: | --- |
| `EpisodeOpen` | `10801` | Opens an Episode and records title, actor, source, location, parent Episode, and root trigger frame. |
| `EpisodeHeartbeat` | `10802` | Appends progress metadata such as frame count and last frame uid. |
| `EpisodeFrameAttached` | `10803` | Associates a runtime frame receipt with an Episode without changing the frame header. |
| `EpisodeRefAttached` | `10804` | Records compact external refs for input frames, payloads, schemas, or Episode dependencies. |
| `EpisodeClosed` | `10805` | Seals an Episode as ended, aborted, or tombstoned. |

The runtime storage service exposes the first operation slice through the C++
core service and existing Node/Python binding path:

```text
episode_begin
episode_heartbeat
episode_attach_frame
episode_attach_ref
episode_end
episode_abort
episode_list
episode_inspect
```

`storage fsck` folds the manifest journal and reports
`episode_manifest_records`, `episodes`, and manifest-level errors such as
missing open records, duplicate opens, duplicate closes, and malformed frame
attachments.

The same folded manifest now exposes a first causal graph projection:

```text
kungfu.episode.causal-graph/v1
```

`episode_inspect` and Episode-scoped storage export include this graph plus the
folded `dependencies` list. V1 records internal frame trigger edges when both
frames live in the Episode, and records declared or missing external
dependencies for parent Episodes, referenced Episodes, trigger frames, payloads,
and schemas. `storage fsck --scope episode` uses the graph to distinguish a
failed Episode from a degraded Episode: failed means unreadable or structurally
invalid manifest evidence; degraded means the Episode remains inspectable but
some dependency, trigger frame, or payload evidence is missing.

V1 deliberately does not add an Episode field to `frame_header`. New writes are
associated with Episodes by appending `EpisodeFrameAttached` records from the
C++ service using the action recorder's frame receipt. This keeps current mmap
pages byte-compatible while establishing Episode as the durable semantic object.
Future physical-layout work can move from manifest association to Episode-aware
allocation domains without changing the product-facing API.

The first runtime lifecycle slice wires real Rewind actions into this manifest
authority:

- `kungfu trace` opens one Episode for the traced run, records all run frames
  through the C++ action recorder, attaches the returned frame receipts, records
  bundle payload refs, and ends or aborts the Episode with the process result.
- `kungfu managed-run` uses the same lifecycle helper around provider-managed
  runs after provider discovery succeeds.
- `kungfu report run begin/end` supports the lower-fidelity reported workflow by
  reopening the open Episode by `source=rewind:<run_id>` across separate CLI
  invocations, then closing it on `run end`.

The helper is intentionally thin. Python owns command orchestration and process
flow; the load-bearing facts remain the C++ `action_recorder` receipts and the
C++ runtime storage service's yijinjing Episode manifest operations.

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
- declared external trigger frames are named as compact input-frame refs;
- payload refs exist or are explicitly marked redacted/absent/missing;
- present payload hashes and byte lengths match the manifest;
- required schemas resolve;
- projection rows can be rebuilt from the Episode evidence;
- hash roots/sync roots recompute;
- tombstoned Episodes are not selected by default projections unless requested.

Fsck must report degraded evidence. It must not invent causality or silently
repair a missing payload by treating it as absent.

V1 degraded diagnostics are intentionally conservative. A missing parent
Episode, missing referenced Episode, undeclared external trigger frame, missing
root trigger frame, or missing payload ref produces a warning and a degraded
status while keeping `ok: true` when the manifest itself is readable. This gives
repair/sync code a precise target without making the Episode disappear from
inspection or export.

ADR-0042 tightens the intended interpretation without turning degradation into
a deletion policy: lifecycle, health, and safe capabilities are separate
dimensions. `kungfu.episode.qualification/v1` now states which operations remain
safe, their evidence requirements, their blockers, and repair prerequisites.
The compatibility `ok` field must still be read in its documented fsck scope;
it is not a substitute for the capability contract.

`kungfu.storage.repair-plan/v1` is the first repair-facing projection over that
diagnostic set. It maps the Episode warnings to read-only candidates such as
`repair_episode_dependency`, `repair_episode_trigger_frame`, and
`repair_episode_payload_ref`. Each candidate carries the original issue code,
target kind, role, Episode/frame/payload id fields, and a suggested action. The
plan is not authority and does not mutate storage; authority remains the
yijinjing Episode manifest journal plus the referenced payload/frame evidence.

`kungfu.storage.repair-fetch/v1` is the read-only material discovery step. It
consumes the repair plan, checks the local runtime and registered local remote
mirror runtimes for matching Episode/source evidence, and emits
`kungfu.storage.repair-material/v1` with Episode bundles and source bundles. It
may write that material to an explicit output path, but it does not network
fetch, apply, delete, compact, or mark a candidate repaired.

`kungfu.storage.repair-apply/v1` is the first mutation-capable repair receipt,
but it is still local-material only. It consumes an already available
`kungfu.storage.episode-bundle/v1` or source export bundle, validates the
material, defaults to dry-run, and writes only under `--execute`. For Episodes,
it appends missing manifest records through the C++ yijinjing manifest store and
skips already identified open/close/frame/ref records. For source payloads, it
restores missing payload bodies only when the bytes match the manifest hash and
length. It does not fetch remote evidence, delete data, compact providers, or
rewrite intentional redaction/absence decisions.

Episode bundle import v1 validates `kungfu.storage.episode-bundle/v1` and
returns the folded causal graph, dependencies, and degraded evidence without
materializing missing data into the local manifest journal. Materialization is a
separate repair-apply operation so fsck, import, preview, and mutation remain
auditable steps.

## Migration Plan

The migration can be staged without pretending the physical layout is already
complete:

1. **Documentation and contracts** — accept ADR-0033, publish this design, and
   add C++ vocabulary types for Episode ids, manifests, dependencies, and fsck
   issues. Done.
2. **Manifest journal records** — add yijinjing first-class Episode manifest
   record types in C++ before adding Python/Node convenience APIs. Done for v1.
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

Episode is now an accepted architecture direction with a v1 manifest journal.
Existing source/range storage commands still operate on sources, manifests,
scopes, and ranges. Episode operations exist as the first C++ storage-service
surface and can be called through Python/Node bindings and the CLI. Episode is
also addressable through the generic storage service as `scope=episode` for
fsck/export and through storage query tables such as `episodes`,
`episode_frames`, `episode_refs`, and `episode_records`. The next
implementation work is to make the action recorder automatically open/current/
seal Episodes and move writer/provider surfaces toward Episode-aware
allocation.
