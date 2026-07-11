# ADR-0047: authoritative structured facts have one schema owner — Hana POD or FlatBuffers

- Status: accepted; implementation staged
- Date: 2026-07-10
- Category: architecture — schema authority and representation boundaries
- Subsystem: `libyijinjing`, `libkungfu`, action envelopes, storage service,
  Python/Node bindings, KFX, and SQLite projections
- Related: ADR-0008 defines the released closed-layout compatibility baseline;
  ADR-0022 places action-recording semantics in the C++ membrane; ADR-0025
  defines action-envelope semantics; ADR-0037 establishes the storage-specific
  Hana/FlatBuffers split; ADR-0039 confines raw FlatBuffers access to
  `kungfu::view`.

## Context

Kungfu currently contains three partially conflicting descriptions of schema
authority:

- ADR-0002 describes FlatBuffers as a runtime schema over the POD layout.
- The live kernel reads and writes fixed-layout Hana-described POD records and
  has no FlatBuffers dependency.
- The open layer uses `.fbs` / `.bfbs` for evolving domain payloads, while some
  service and action-envelope paths still use JSON as an internal semantic
  representation.

That ambiguity allows the same fact to acquire parallel C++ structs, JSON
objects, FlatBuffers tables, and handwritten SQLite mappings. It also makes
bindings choose a representation locally instead of following one schema
owner. A fact ledger cannot be load-bearing if schema authority depends on
which language or service path a caller entered through.

## Decision

Kungfu has exactly two authoritative schema substrates for persisted structured
facts:

```text
authoritative structured fact
  = exactly_one_of(Hana closed-set POD, FlatBuffers open/domain schema)
```

Every persisted structured fact has exactly one schema owner. It must be
registered in the Hana closed set or defined by `.fbs`, never independently
authored in both.

### 1. Hana owns the closed kernel substrate

Hana-described core records are fixed-layout POD with stable kernel
`carrier_type` identities. They are appropriate for facts that must satisfy the
closed-set, mmap-safe, zero-copy, hot-path, and long-lived ABI obligations of
`libyijinjing`.

- The type definition and field reflection live in the Hana schema registry.
- Records contain no heap-owning members such as `std::string` or
  `std::vector`.
- Variable or growing state is represented as append-only delta records folded
  into a current view.
- Python and Node expose C++-owned bindings generated or recursively derived
  from the same Hana description; they do not translate through JSON.

### 2. FlatBuffers owns the open and domain substrate

KFX and evolving cross-language domain facts use `.fbs` as their single schema
owner. `.bfbs`, generated language code, safe C++ views, SQLite tables, JSON
renderings, and SDK types are projections of that source, not competing
definitions.

- Raw C++ FlatBuffers/reflection access remains confined to `kungfu::view` per
  ADR-0039.
- Untrusted buffers are verified before field access.
- Schema evolution follows FlatBuffers compatibility rules and the relevant
  KFD-1 registered surface.

Business meaning alone does not decide substrate membership. Open/KFX/domain
facts default to FlatBuffers. A domain fact may enter Hana only through an
explicit kernel admission decision that accepts the fixed-layout and long-lived
ABI cost. Once admitted, it is not also defined as an `.fbs` fact.

### 3. Typed views are derived API objects, not a third substrate

Service requests, service results, fold outputs, query rows, and other owned
C++ aggregates may be variable-length typed structs. They may use Hana
reflection to generate Python/Node conversion, but they are not journal records
unless they separately satisfy and enter the closed POD registry.

The semantic service interface is typed. A `nlohmann::json` return type or
options bag is not an acceptable core service contract merely because every
language can parse it.

### 4. Opaque bodies are content, not a third structured schema

Files, model outputs, foreign source documents, media, and other large bodies
remain content-addressed bytes. Authoritative metadata commits to their hash,
length, content type, and schema/encoding reference. The body does not have to
be converted to FlatBuffers merely to be stored.

### 5. JSON is edge-only, in both directions

JSON is allowed at true boundaries:

- adapter ingestion of a foreign JSON source;
- CLI and `--json` output;
- import/export interchange;
- diagnostics, logging, and human-readable rendering;
- explicitly JSON-based external protocols.

JSON is not allowed as journal authority, an internal fold or fsck currency, a
core service semantic interface, or a cross-language binding transport. An
adapter may parse JSON, but the accepted fact it produces must enter one of the
two authoritative schema substrates.

### 6. SQLite projections follow the schema owner

SQLite is a rebuildable projection, never authority, and has two exclusive
paths:

| Schema owner | SQLite path |
| --- | --- |
| Hana POD | compile-time Hana accessors to `sqlite_orm` via `make_storage_ptr` |
| FlatBuffers | `.bfbs` reflection planning through `kungfu::view` and the open-layer projector |

There is no third handwritten JSON-to-SQL schema path. A projection may add
query indexes or derived columns, but its source fields and decode path follow
the authoritative owner. Hana-backed query APIs reuse or extend the existing
`sqlite_orm`/Hana machinery and return typed rows or views internally; JSON is
rendered only when that result crosses an edge.

### 7. The action envelope is an open-layer FlatBuffers schema

ADR-0025's semantic decision stands: `carrier_type=1000` is transport metadata,
while `action_type` and `schema_ref` carry business meaning. Its original JSON
wire representation does not stand.

Before the stable v4 baseline, the journal body for the generic action carrier
must migrate to a declared `ActionEnvelope.fbs`. The envelope may carry a nested
payload as bytes plus an encoding and schema reference. JSON/base64 is an edge
rendering or interchange form, not the authoritative on-journal envelope and
not an internal transport between bindings and the C++ core.

The current Python JSON/base64 envelope implementation is explicitly
transitional until that migration lands. Pre-migration v4 dogfood journals are
not compatibility targets, consistent with ADR-0025.

## Relation to earlier ADRs

- **ADR-0002 is superseded in schema scope.** Its `nanomsg` to `nng`
  modernization remains historical fact, and its demand for a declared
  cross-language open schema is retained. FlatBuffers is not a schema layered
  over the Hana POD layout and does not own closed kernel records.
- **ADR-0008 stands.** Its closed runtime layout baseline applies to the Hana
  POD substrate. Open `.fbs` surfaces have their own declared evolution
  contracts and registry entries.
- **ADR-0025 is amended in representation only.** Generic carrier and action
  vocabulary semantics stand; JSON wire authority is replaced by
  `ActionEnvelope.fbs`.
- **ADR-0037 stands and is generalized.** Its storage record classification,
  opaque-body rule, JSON edge rule, and Hana-to-SQLite path are instances of
  this system-wide decision.
- **ADR-0039 stands unchanged in purpose.** It governs safe FlatBuffers access,
  while this ADR governs which facts FlatBuffers owns.

## Implementation sequence

1. Introduce typed storage service request/result/view and POD query-row types,
   reuse the Hana/`sqlite_orm` query path, and move JSON to a named edge adapter.
2. Complete recursive Hana-to-Python and Hana-to-Node conversion for POD and
   typed views; remove JSON stringify/parse binding transport.
3. Define and adopt `ActionEnvelope.fbs`, retaining JSON only as an edge
   renderer/import adapter.
4. Route all SQLite projections exclusively by schema owner and retire any
   remaining handwritten JSON schema path.
5. Add source gates that enforce single ownership and prevent JSON semantic
   interfaces from re-entering the core.

These are staged implementation tasks. This ADR records the target boundary; it
does not claim those migrations are already complete.

## Consequences

- The kernel remains FlatBuffers-independent and the hot path remains zero-copy.
- KFX and domain facts gain a declared, evolvable, cross-language schema owner.
- Python and Node bindings stop defining de facto contracts through JSON.
- SQLite implementation follows the same source that defines the fact, so
  projection drift is mechanically reducible.
- Adding a new kernel type becomes an explicit ABI-cost decision rather than a
  convenience shortcut.

## Alternatives considered

- **Make all facts FlatBuffers.** Rejected because it welds the journal kernel
  and fixed-layout hot path to the open-layer toolchain and obscures the actual
  POD ABI.
- **Make all facts Hana POD.** Rejected because open/KFX/domain schemas need
  variable-length data, independent evolution, and language-neutral published
  artifacts without consuming the finite kernel closed set.
- **Keep JSON as the universal service membrane.** Rejected because it creates
  a third schema authority, loses typed compile-time guarantees, and forces
  serialization through the cross-language core.
- **Define Hana structs and `.fbs` tables for the same fact.** Rejected because
  synchronized duplicate authorities inevitably drift.

## Residual risk

- The boundary will remain aspirational until service signatures, bindings,
  the action envelope, and CI gates migrate.
- A typed view macro must not accidentally register variable-length service
  objects as journal POD.
- Kernel admission pressure can grow the closed set without discipline; each
  new Hana fact must justify its ABI and carrier budget.
- Nested FlatBuffers payloads require a clear verifier and lifetime chain at
  both the outer envelope and referenced payload layers.
