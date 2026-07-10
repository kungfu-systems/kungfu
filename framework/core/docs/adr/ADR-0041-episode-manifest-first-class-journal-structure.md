# ADR-0041: the Episode manifest is the object's trust boundary — a POD-native yijinjing journal structure with writer / runtime / fsck / query tightened around it, JSON edge-only

- Status: proposed
- Date: 2026-07-10
- Category: (architecture) storage record structure — making the Episode manifest
  (the Episode's trust boundary) a fully first-class, POD-native yijinjing journal
  structure, and tightening the four operations (writer, runtime, fsck, query)
  around it.
- Subsystem: `libyijinjing` `episode_manifest` store and the Episode manifest
  record family, the `libkungfu` runtime storage service Episode operations,
  storage fsck, and the storage query path; Python/Node storage bindings.
- Related: ADR-0033 defines Episode as the first-class causal segment object and
  names the Episode manifest the object's trust boundary; ADR-0034 puts the
  Episode manifest records in the yijinjing journal format; ADR-0037 makes the
  storage record family Hana-core kernel metadata with JSON as an edge
  projection; ADR-0040 makes the runtime fact ledger's content-addressed KV a
  first-class primitive; ADR-0023 starts frame integrity at the C++ recorder;
  ADR-0028 separates content hashes from frame checksums.

## Scope

Episode is the first-class causal segment object and the unit all storage is
organized around (ADR-0033). Its manifest is **the object's trust boundary** —
what fsck, export/import, sync, and inspection trust to answer "what is this
Episode." This ADR is about **that manifest**: making it a clean, POD-native,
first-class yijinjing journal structure and tightening the four operations that
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
and the query. There is no POD-typed current view and no rebuildable projection
(unlike the source-registry family, which folds POD and has a SQLite
projection).

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

This ADR makes these records POD-native and tightens the operations around them.
It carries identity and hash-root *fields*; the deep semantics of Episode
identity and hash-root composition are the forthcoming Episode ADR, not this one.

## Decision

The Episode manifest is the object's trust boundary, structured as a POD-native
yijinjing journal. The journal of POD frames is the authority and the working
representation; JSON appears only at the true edge (CLI, export, binding return
values). The four operations tighten around it:

1. **Structure / fold is POD-native.** Folding an Episode manifest reads POD
   frames from the journal into a typed current view (a POD/`struct` view of the
   Episode manifest and its typed frame/ref/dependency collections), not into
   `nlohmann::json`. JSON is produced only when crossing the edge (a CLI/`--json`
   response, an export bundle, a binding return). The fold, the current view, and
   everything internal are typed; JSON is never the internal currency.

2. **Writer is one tight contract.** Manifest writes go through a single
   open / heartbeat / attach-frame / attach-ref / seal (end/abort/tombstone)
   contract that appends POD frames under the yijinjing single-writer-per-location
   rule. That contract is the only write path; there is no alternate JSON-assembly
   write. Growth is append-only delta folded into the current view (the ADR-0034
   shape), never in-place mutation. `open` / `sealed` / `tombstoned` are recorded
   states, so a partial Episode is never presented as complete.

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

6. **Content-addressed references resolve through the KV primitive.** The
   payload, schema, and hash-root references the manifest records resolve through
   the yijinjing content-addressed KV (ADR-0040), not through bespoke per-path
   logic. The manifest carries the references; the KV holds the bytes.

## Consequences

- The Episode manifest stops treating JSON as internal currency; JSON narrows to
  the edge, matching ADR-0037's discipline one layer up.
- The trust boundary becomes trustworthy from the journal itself: fsck and query
  read the same typed fold, so they cannot diverge (fsck cannot check something
  the query cannot see, and neither depends on a JSON re-derivation).
- Episode gains what source-registry gained — a rebuildable SQLite projection and
  a structure-native fsck — with the journal as the one authority.
- Causal closure, the ADR-0033 core invariant, becomes a checked property of the
  manifest rather than an assumption.
- The manifest is ready to serve the forthcoming complete Episode ADR: the deep
  identity / atomicity / independence / composition model can be defined on top
  of a manifest that is already POD-native and structurally verified.

## Relation to ADR-0033 / ADR-0034

ADR-0033 defines Episode and names the manifest its trust boundary; ADR-0034
decides the manifest records live in the yijinjing journal format. Both stand.
This ADR refines them: the journal is not only the storage format but the working
representation, and the fold / fsck / query stop collapsing to JSON early. It does
not touch the Episode concept, identity model, physical layout, or
dependency/projection policy — those remain with ADR-0033 and the forthcoming
Episode ADR.

## First delivery (staged)

- Make the `episode_manifest` fold POD-native: read POD frames into a typed
  current view and typed frame/ref/dependency collections; produce JSON only at
  the edge.
- Tighten Episode fsck to verify over the typed structure — status/seal
  consistency, payload-reference presence, causal closure, and frame integrity
  (ADR-0023) — reporting the degraded / intentional / failed distinction from the
  structure.
- Add a rebuildable Episode SQLite projection over the journal via
  `cache::make_storage_ptr` (mirroring the source-registry projection) and route
  Episode query through the folded view and that projection.
- Resolve the manifest's content-addressed references through the ADR-0040 KV.
- Keep the ADR-0034 record set and the edge JSON shape stable so consumers are
  unaffected while the internals move to POD-native.

## Explicitly out of scope

- The complete Episode concept ADR: the Episode identity model and its atomic /
  independent / operable / pressure-resistant guarantees, Episode-aware physical
  page allocation, and dependency / projection / observer policy. This ADR is the
  manifest, not the full object model.
- Any change to the ADR-0034 Episode record set, Episode carrier_type allocation,
  or the edge JSON shape; this ADR tightens structure and operations, not the
  schema.
- The content-addressed KV substrate implementation (ADR-0040) and the storage
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

- The POD current view for variable-length manifest content (frames, refs,
  dependencies) must follow the append-only delta discipline and stream / bound
  like the journal it reads; a naive typed view that materializes everything in
  memory does not scale to long Episodes.
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
