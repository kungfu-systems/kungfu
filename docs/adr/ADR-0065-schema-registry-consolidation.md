---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0065
decision_status: proposed
implementation_status: not-started
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0065: the schema type registry has one authoritative set and trait-derived subsets

- Status: proposed
- Date: 2026-07-12
- Category: (b) mechanism / governance — schema registry hygiene
- Subsystem: `libyijinjing` schema registry, Hana reflection, projections, state cache
- Related: [ADR-0025](ADR-0025-carrier-type-and-action-envelope-semantics.md)
  (`msg_type` → `carrier_type`), [ADR-0037](ADR-0037-storage-records-hana-core-kernel-metadata.md)
  and [ADR-0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) (the
  Hana closed-set → SQLite projection this registry feeds),
  [ADR-0008](ADR-0008-yijinjing-schema-layout-baseline.md) (the closed schema
  baseline), [ADR-0062](ADR-0062-journal-container-epoch-and-offline-conversion.md)
  (another compile-time Hana consumer over the same structs)

## Context

Kungfu's schema layer uses Boost.Hana well at the field level: `KF_DEFINE_*_TYPE`
declares reflectable POD structs (name, `tag`, `primary_keys`, accessors), and
`boost::hana::accessors` folds drive JSON, the SQLite projection (ADR-0037),
bindings, `size_fixed`, hashing, and the ADR-0062 layout fingerprint — one
declaration, no codegen. That core is sound and is not in question here.

The problem is at the type-set level in `schema/registry.h`:

1. **~10 hand-maintained overlapping `make_map` sets** — `AllTypes`,
   `AllDataTypes`, `CorePublicDataTypes`, `CorePublicStateDataTypes`,
   `ProfileDataTypes`, `StateDataTypes`, `SourceRegistryDataTypes`,
   `ManifestCatalogDataTypes`, `EpisodeManifestDataTypes`, plus empty
   `StaticDataTypes` / `StatisticDataTypes`. Membership overlaps heavily and is
   listed by hand, so adding or removing a type means editing several maps
   consistently, with no guard that they agree.

2. **Redundant numeric tag comments** — every `TYPE_PAIR(X)` carries a `// 10105`
   comment duplicating the struct's `static constexpr int32_t tag`. The comment
   has no compile-time link to the tag, so it can silently rot. These stale
   numeric traces are the visible residue of the pre-ADR-0025 `msg_type` world.

3. **Runtime globals built from compile-time sets** — `AllTypesTags` and peers
   are namespace-scope `const std::set<int32_t>` built at static-init time from
   compile-time-known tags.

4. **`msg_type` vocabulary residue** at non-core edges (slices probes, internal
   locals/labels) that ADR-0025 did not reach.

## Decision

Hana reflection stays; the registry's hand-maintained duplication is removed.

1. **One authoritative type set plus trait-derived subsets.** `AllTypes` (or an
   equivalent single source) is the authoritative registry. Each subset
   (`StateDataTypes`, `ProfileDataTypes`, `SourceRegistryDataTypes`,
   `ManifestCatalogDataTypes`, `EpisodeManifestDataTypes`, the `CorePublic*`
   views) is **derived by a compile-time filter** over a per-type membership
   trait, not re-listed by hand. A type declares its memberships once; the
   subsets fall out. Before any hand-written map is deleted, a compile-time
   `static_assert` (or test) proves the derived subset is set-equal to the
   current hand-written one, so the refactor is provably behavior-preserving.

2. **Remove the redundant numeric tag comments.** The `tag` in the struct
   definition is the single source of truth; the map comments are deleted. If a
   human-readable tag catalog is wanted, it is generated from the structs, not
   hand-copied.

3. **Make the tag sets compile-time.** Replace the static-init `const std::set`
   globals with `constexpr` sorted structures derived from the authoritative set,
   removing static-init order and cost and enabling constexpr membership tests.
   Delete the empty placeholder maps or document why they must remain.

4. **Finish the `msg_type` → `carrier_type` vocabulary only where it is not a
   frozen contract.** Internal locals, labels, and slice probes are renamed to
   `carrier_type`. **The `kf_embedding_frame_v1.msg_type` field is a frozen v1 C
   ABI and is NOT renamed** — a rename would break the embedding ABI consumed by
   libwasm and the Rust FFI mirrors. Any vocabulary change there is deferred to a
   deliberate `kf_embedding_frame_v2`, out of scope here.

5. **Dispatch micro-optimization is a non-goal without measurement.** The
   `for_each(Types){ if (DataType::tag == carrier_type) }` linear scan is only a
   candidate for a switch / sorted lookup if a hot-path profile shows it matters.
   It is not changed on speculation; most dispatch is on control events, not the
   per-frame data path.

## Rationale

The Hana approach is load-bearing (ADR-0037/0047) and correct; the failure mode
is not the tool but the hand-maintained duplication and comment rot around it.
Deriving subsets from one authoritative set and one per-type trait converts
"remember to edit N maps and keep N comments accurate" into a single declaration
the compiler expands — reliability over discipline, one source of truth. The ABI
carve-out keeps a real external contract intact rather than chasing cosmetic
vocabulary consistency into a breaking change.

## Consequences

- Adding or removing a schema type edits one authoritative set plus that type's
  membership traits; subsets and their containers follow automatically.
- No stale numeric comments; the `tag` is the only tag authority.
- The subset-equality `static_assert` guards the migration and stays as a
  regression guard.
- No wire/POD layout change, no schema-tag renumbering, no embedding ABI change.
- The internal `msg_type` vocabulary is retired except in the frozen v1 ABI.

## Alternatives considered

- **Leave the hand-maintained maps.** Rejected: the duplication and comment rot
  are a standing correctness hazard with no guard.
- **Code-generate the maps from a manifest.** Rejected: it adds a codegen step
  where a compile-time filter over existing Hana structs already suffices; codegen
  is the thing the reflection approach exists to avoid.
- **Rename `kf_embedding_frame_v1.msg_type` for consistency.** Rejected: it breaks
  a frozen v1 C ABI; vocabulary consistency does not justify an ABI break. A v2
  ABI is the only sanctioned path and is deferred.
- **Optimize the dispatch scan now.** Rejected: premature without a hot-path
  measurement; the scan is small and mostly off the data hot path.

## Verification

- Compile-time `static_assert` proving each derived subset is set-equal (by tag)
  to the map it replaces, kept in the tree as a regression guard.
- Full build + tests green (the registry feeds projections, state cache, and
  bindings).
- A guard or removal for the numeric comments so they cannot silently rot again.

## Open questions (resolved during phased implementation)

- The exact trait mechanism: a membership tag on the struct via the
  `KF_DEFINE_*` macros, versus an external per-type trait map in `registry.h`.
  The external map keeps `schema/core.h` untouched; a struct-member trait keeps
  membership next to the type. To be chosen in phase 1 with a small spike.
