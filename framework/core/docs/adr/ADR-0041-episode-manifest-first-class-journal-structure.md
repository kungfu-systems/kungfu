# ADR-0041: the Episode manifest is the object's trust boundary — POD journal records, one typed fold, and JSON at the edge

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) storage record structure — keeping the Episode
  manifest's authoritative records as fixed-layout yijinjing POD frames, deriving
  one typed current view, and tightening writer, runtime, fsck, and query around
  that boundary.
- Subsystem: `libyijinjing` `episode_manifest` store and the Episode manifest
  record family, the `libkungfu` runtime storage service Episode operations,
  storage fsck, and the storage query path; Python/Node storage bindings.
- Related: ADR-0033 defines Episode as the first-class causal segment object and
  names the Episode manifest the object's trust boundary; ADR-0034 puts the
  Episode manifest records in the yijinjing journal format; ADR-0037 makes the
  storage record family Hana-core kernel metadata with JSON as an edge
  projection; ADR-0040 makes the runtime fact ledger's content-addressed store a
  first-class primitive; ADR-0023 starts frame integrity at the C++ recorder;
  ADR-0028 separates content hashes from frame checksums.

## Scope

Episode is the first-class causal segment object and the unit all storage is
organized around (ADR-0033). Its manifest is **the object's trust boundary** —
what fsck, export/import, sync, and inspection trust to answer "what is this
Episode." ADR-0034 already made its records first-class yijinjing journal frames.
This ADR is about eliminating the remaining JSON-early implementation, deriving
one typed current view from those records, and tightening the operations that
touch it.

It is deliberately narrow. The **complete Episode concept** — the Episode
identity model and its atomic / independent / operable / pressure-resistant
guarantees, Episode-aware physical page allocation, and the dependency /
projection / observer policy — is a **forthcoming Episode ADR**, consistent with
ADR-0033 deferring physical layout. This ADR only makes the manifest (the trust
boundary) clear and tight; it does not decide the deep Episode identity or
composition semantics.

## Context

ADR-0033 named the Episode manifest the trust boundary; ADR-0034 put its records
in the yijinjing journal. On the **write** side this is already journal-native:
`EpisodeOpen` / `EpisodeHeartbeat` / `EpisodeFrameAttached` /
`EpisodeRefAttached` / `EpisodeClosed` are POD frames appended to the journal.

The rest is not yet first-class. In the current `episode_manifest` store,
`read_records` converts each POD frame to `nlohmann::json` immediately;
`fold_records` folds over JSON; and every operation — `list`, `inspect`, `fsck`,
and the runtime `query` path — reads and reasons over that JSON. JSON is not the
edge projection here, it is the internal currency of the fold, the verification,
and the query. There is no typed current view and no rebuildable Episode
projection. The source-registry family provides a useful typed-record reader for
its SQLite projection, but its list/inspect/fsck fold still converts records to
JSON; this ADR deliberately goes further by making the typed fold the shared
internal path.

This is the drift ADR-0037 rejects, one layer up: the authoritative substrate is
the journal of POD frames, but the working representation settled on JSON by
default. Because the manifest is the trust boundary, this matters directly: fsck
and query trust a JSON re-derivation rather than the journal-native structure
itself.

## What the manifest records (the trust boundary)

Per ADR-0033, the Episode manifest records at least:

- Episode identity and manifest version;
- open / sealed / tombstoned status;
- frame ranges or frame ids included in the Episode;
- payload inventory and content hashes;
- schema inventory;
- source and location provenance;
- declared dependency Episode ids;
- rebuildable projection / query indexes;
- hash roots or sync roots needed by fsck / export / import.

The stored records remain POD-native; the current view is a typed C++ aggregate
whose variable-length collections may be streamed or bounded. Before
implementation, the existing ADR-0034 record family must be mapped explicitly to
each trust-boundary claim above. If a claim cannot be represented without
overloading an existing field, a schema-version ADR must precede that change.
Deep Episode identity and hash-root composition remain the forthcoming Episode
ADR, not this one.

## Decision

The Episode manifest is the object's trust boundary. The append-only journal of
POD records is the authority; one deterministic typed fold is the canonical
in-memory derivation; a rebuildable SQLite projection is a query accelerator;
and JSON appears only at the true edge (CLI, export, binding return values). The
operations tighten around that separation:

1. **Records are POD; the fold is typed.** Folding an Episode manifest decodes
   fixed-layout POD frames into a typed current view and typed
   frame/ref/dependency collections, not into `nlohmann::json`. The current view
   is not itself required to be POD: variable-length collections may use normal
   C++ ownership, but they must support streaming or bounded materialization.
   JSON is produced only when crossing the edge (a CLI/`--json` response, an
   export bundle, or a binding return).

2. **Writer is one tight contract.** Manifest writes go through a single
   open / heartbeat / attach-frame / attach-ref / seal (end/abort/tombstone)
   contract that appends POD frames under the yijinjing single-writer-per-location
   rule. That contract is the only write path; there is no alternate JSON-assembly
   write. Growth is append-only delta folded into the current view (the ADR-0034
   shape), never in-place mutation. `open` / `sealed` / `tombstoned` are recorded
   states, so a partial Episode is never presented as complete.

   The implementation must name one logical writer owner for the manifest
   location. Masterless operation does not waive ownership: a process must acquire
   the same data-root-scoped writer guard or fail rather than append concurrently
   to an active catalog writer.

   Event frames and manifest records live in different journals and therefore do
   not form one atomic write. Before lifecycle wiring lands, the implementation
   must document the publication order and recovery state machine and prove each
   crash point with fixtures. At minimum, a sealed Episode may be reported healthy
   only when every attached frame/ref is present and verified; interrupted writes
   remain open/aborted or degraded, and fsck reports the exact missing side. The
   typed-fold slice may land before this contract, but automatic writer lifecycle
   integration may not.

3. **Runtime operations expose the journal-native structure.** The storage
   service Episode operations (begin / heartbeat / attach-frame / attach-ref /
   end / abort / list / inspect, and repair) operate on the typed fold and return
   its edge projection. They do not assemble or re-parse JSON as an internal
   step; the runtime surface is a thin edge over the typed structure.

4. **fsck verifies over the journal-native structure and the trust-boundary
   claims.** Episode fsck reopens the journal, folds POD, and checks the
   manifest's invariants on the typed view: open present and unique, seal / status
   consistency, frame-uid integrity, payload-reference presence against the
   content hashes it records, and — the ADR-0033 core invariant — **causal
   closure** (frame-level causality closed inside the Episode; cross-Episode
   influence only through declared dependency ids). It also checks frame integrity
   (ADR-0023 checksums; ADR-0028 content-hash vs frame-checksum separation) and
   reports the honest degraded / intentional / failed distinction, computed from
   the structure, not from JSON heuristics. fsck makes closure visible (ADR-0033
   residual risk).

5. **Query is the folded view plus a rebuildable projection.** Episode queries
   read the typed folded current view; for indexed / SQL access they use a
   rebuildable projection over the journal via the compile-time Hana closed-set →
   SQLite path (`cache::make_storage_ptr`, the same path the source-registry
   projection uses), never ad-hoc JSON assembly. The projection is a derived view
   verified against the journal by fsck, never a second authority.

6. **Content-addressed references resolve through the immutable content-store
   primitive.** The
   payload, schema, and hash-root references the manifest records resolve through
   the yijinjing `content_store` (ADR-0040), not through bespoke per-path
   logic. The manifest carries the references; the content store holds the bytes.

## Consequences

- The Episode manifest stops treating JSON as internal currency; JSON narrows to
  the edge, matching ADR-0037's discipline one layer up.
- Fsck and query consume the same typed fold, removing duplicate JSON fold logic;
  the SQLite projection remains independently verifiable and can still drift.
- Episode gains a typed-record path and rebuildable SQLite projection, extending
  the source-registry projection pattern while keeping the journal as authority.
- Causal closure, the ADR-0033 core invariant, becomes a checked property of the
  manifest rather than an assumption.
- The manifest is ready to serve the forthcoming complete Episode ADR: the deep
  identity / atomicity / independence / composition model can be defined on top
  of a manifest that is already POD-native and structurally verified.

## Relation to ADR-0033 / ADR-0034

ADR-0033 defines Episode and names the manifest its trust boundary; ADR-0034
decides the manifest records live in the yijinjing journal format. Both stand.
This ADR refines them: the journal is the authority, the typed fold is the one
canonical in-memory derivation, and fold / fsck / query stop collapsing to JSON early. It does
not touch the Episode concept, identity model, physical layout, or
dependency/projection policy — those remain with ADR-0033 and the forthcoming
Episode ADR.

## First delivery (staged)

1. **Typed fold.** Read POD frames into one typed current view and typed
   frame/ref/dependency collections; define deterministic fold order, duplicate
   handling, unknown-version behavior, and bounded/streaming behavior; produce
   JSON only at the edge. Keep the ADR-0034 record set and edge JSON shape stable.
2. **Writer/recovery contract.** Name the manifest writer owner, document the
   event-journal/manifest-journal publication order, and add crash-point fixtures.
   Do not wire automatic lifecycle appends until this stage is proved.
3. **Structural fsck.** Verify status/seal consistency, payload-reference claims,
   causal closure, and frame integrity (ADR-0023) over the typed fold, reporting
   degraded / intentional / failed from the structure.
4. **Content resolution.** After ADR-0040's minimal immutable `content_store`
   contract and default backend land, resolve and verify manifest content refs
   through that interface. No bespoke path fallback becomes a second contract.
5. **Projection/query.** Add a rebuildable Episode SQLite projection via
   `cache::make_storage_ptr`, verify it against the journal fold, and route indexed
   Episode query through the typed model and projection.

Before stage 1 implementation, publish a field-to-claim mapping for the existing
ADR-0034 records. If the current schema cannot represent a required hash root,
reference, or lifecycle state without overloading a field, stop and write a
schema-version ADR rather than silently changing the record set.

## Explicitly out of scope

- The complete Episode concept ADR: the Episode identity model and its atomic /
  independent / operable / pressure-resistant guarantees, Episode-aware physical
  page allocation, and dependency / projection / observer policy. This ADR is the
  manifest, not the full object model.
- Any change to the ADR-0034 Episode record set, Episode carrier_type allocation,
  or the edge JSON shape; this ADR tightens structure and operations, not the
  schema.
- The content-addressed store substrate implementation (ADR-0040) and the storage
  record kernel-metadata direction (ADR-0037); this ADR builds on them.
- The import-manifest record migration; it adopts the same POD-native pattern but
  is delivered separately.

## Alternatives considered

- **Keep the JSON-early fold (status quo).** Rejected. It makes JSON the internal
  currency of fold / fsck / query — the exact drift ADR-0037 rejects — so the
  trust boundary is only ever a JSON re-derivation, not the journal-native
  structure. It blocks a typed current view, lets fsck and query diverge, and
  blocks a clean rebuildable projection.
- **Fold into JSON but add a separate typed path only for fsck.** Rejected. Two
  representations of the same fold drift; the typed fold must be the single
  working representation all four operations share.
- **Expand this ADR to the full Episode object model (identity, atomicity,
  composition).** Rejected for now. The manifest is the core of the Episode and
  can be made first-class on its own; the deep object model is a distinct decision
  best made on top of a clean manifest, in the forthcoming Episode ADR.

## Residual risk

- The typed current view for variable-length manifest content (frames, refs,
  dependencies) must follow the append-only delta discipline and stream / bound
  like the journal it reads; a naive view that materializes everything in memory
  does not scale to long Episodes.
- The SQLite projection must stay a rebuildable derived view (verified against the
  journal by fsck), never a second authority — the same guarantee the
  source-registry projection carries.
- "JSON edge-only" must be enforced by structure and review, or JSON re-creeps
  inward; the payoff is realized only if the typed fold is genuinely the single
  internal representation.
- Tightening the four operations touches a live subsystem (Episode is in use);
  the migration must keep the ADR-0034 record set and the edge JSON shape stable
  so consumers are unaffected while the internals move to POD-native.
- The manifest records identity and hash-root fields whose deep semantics are
  deferred to the Episode ADR; the field layout chosen here must not foreclose a
  content-addressed identity / hash-root model later.
- A prose-only writer ownership rule is insufficient. The implementation needs a
  data-root-scoped guard and crash fixtures before a master and masterless process
  can safely target the same manifest location.
