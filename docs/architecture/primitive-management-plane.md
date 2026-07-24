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
primitive ids, missing evidence paths, and ghost artifacts fail the generator.

## Mechanical intake boundary

Primitive classification is explicit, not inferred from source-code names or
prose. For governance purposes, a capability becomes a Kungfu Primitive only
when an incubation passport declares it. A machine-readable primitive artifact
must carry both:

- a top-level `schema` in the `kungfu.primitive.*` or `kungfu.primitive-*`
  namespace; and
- a top-level `primitiveId` matching its passport declaration.

The source gate scans every tracked or unignored JSON file in the repository,
not only `framework/primitive/`. A marker outside the conventional scaffold
directories is therefore still governed and fails closed when it is missing
from the matching passport. Files inside the managed contract, operation-slot,
SDK-slot, and primitive-vector roots remain governed even if their marker is
malformed or absent.

Implementation and proof files are references rather than primitive artifacts;
their paths and Roots must still be present in the passport. Code or prose that
has no passport declaration cannot enter the catalog or claim catalog maturity.

## Birth and promotion

Use the Shifu entrypoint for both planning and creation:

```sh
./shifu primitive:new -- --id example --name Example --layer example
./shifu primitive:new -- --id example --name Example --layer example --write
```

The command is dry-run by default. `--write` adds one passport and creates
contract, vector, operation-matrix slot, and four-language SDK slot scaffolds.
Every scaffold carries the machine marker, and all proof states start empty.

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
non-claims. Run `./shifu check:primitive-catalog` for focused verification and
`./shifu check:source` for the complete source gate.

The protected development channel accepts changes only through a pull request
and merge queue. GitHub requires both `Candidate source acceptance / check` and
the final `affected-native / linux` aggregate before the queue may update the
channel. Force pushes and branch deletion are blocked. A local green result is
useful feedback, but it does not replace those exact-revision checks.
