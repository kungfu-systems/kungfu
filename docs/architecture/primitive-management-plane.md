# Primitive Management Plane

Kungfu's Primitive Catalog is a derived, Root-bearing view over existing
authorities. The architecture decision and exact boundaries are recorded in
[KF-ADR-019f917f-d116-70e8-b4a1-2e0209598aec](../adr/KF-ADR-019f917f-d116-70e8-b4a1-2e0209598aec.md).

## Authority flow

```text
incubation passport (sole intake)
          |
          +-- authority and evidence references
          |
six source facets -- generate-primitive-catalog.mjs
                            |
                            +-- framework contract (KFD-1 source)
                            +-- config artifact (release payload)
                            +-- native header (action_runtime primitive_catalog)
                            +-- KFD-3 query surface
```

The catalog may report a maturity or evidence state, but it cannot originate
one. Every reported Root is recomputed from a referenced file. Drift, duplicate
primitive ids, missing evidence paths, and ghost managed artifacts fail the
generator.

## Birth and promotion

`node scripts/new-primitive.mjs ...` is dry-run by default. `--write` adds one
passport and creates contract, vector, operation-matrix slot, and four-language
SDK slot scaffolds. All start unproved.

`incubating`, `experimental`, and `candidate` entries may expose missing proof
without blocking unrelated release work. `admitted` and `stable` entries fail
source and release admission unless all four language proofs and all promotion
receipt classes are present. Dogfood evidence must be a retained referenced
receipt; prose and empty fixtures are not accepted.

## Query and verification

The native query request is:

```json
{"action":"primitive_catalog"}
```

The response contains `catalogRoot`, six `facetRoots`, the nine baseline
primitive entries, language states, promotion evidence, and explicit
non-claims. Run `npm run check:primitive-catalog` for source verification.
