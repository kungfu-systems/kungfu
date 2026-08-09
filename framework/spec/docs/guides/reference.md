# Complete contract reference

You are at **Check the contract**, the deepest reading level. Use this page to
resolve an exact route after the quickstart and task guides have established
context.

## Package entry points

| Entry | Purpose |
| --- | --- |
| `manifestPath` | Installed `dist/manifest.json` |
| `manifestSchemaPath` | Closed-world manifest schema |
| `bundleRoot` | Installed deterministic Spec bundle |
| `conformanceBundlePath` | Historical unknown-record portable fixture |
| `guides/index.json` | Rooted human and agent reader journey |
| `reference-readers/python/portable_format_reader.py` | Stdlib-only independent verifier in the direct Spec package |

## Normative artifacts

| Artifact ID | Installed path | Meaning |
| --- | --- | --- |
| `authority` | `authority.json` | Composition boundary, terminology, version axes, status, and non-claims |
| `schema_registry` | `registry.json` | Protocol registry and exact owner roots |
| `error_dictionary` | `errors.json` | Reader and migration error contracts |
| `capabilities` | `capabilities.json` | Outcomes, capabilities, and material states |
| `reader_matrix` | `reader-matrix.json` | Reader profiles, preconditions, scope, outcomes, and failure codes |
| `compatibility` | `compatibility.json` | Current compatibility tuple and per-axis outcome map |
| `migration` | `migration.json` | Migration graph, receipts, repair rules, and refusals |
| `conformance_vectors` | `vectors/index.json` | Retained corpus index and release roots |

The canonical `manifest.normative.preimage` binds those paths and roots.
Provenance such as the Git commit is forensic and excluded from the normative
root.

## Non-normative routes

- `reader_journey` roots the progressive guide index and every guide body.
- `overview` and `handbooks` provide human context and binding guidance.
- `history.spec_0_1_draft` is historical, explicitly non-normative prose.
- `history.synthetic_unknown_record` is a historical test fixture.

Continue to the [portable format authority overview](../overview.md) when you
need that broader human context.

## Compatibility and trust rules

- Route by `spec_version`, not package semver.
- Key identity by the domain-free `format_namespace`.
- Verify the manifest's normative root and every consumed artifact root.
- Preserve source roots so results remain traceable to semantic owners.
- Resolve declared paths inside the installed package and reject traversal.
- Treat each format axis independently and honor the selected reader profile.
- Honor `normative.status` and all `normative.non_claims`.
- A Site projection may order and render this material, but may not redefine
  protocol identity, compatibility, migration, failure semantics, or status.

## Current non-claims

The standalone portable format is not declared stable. Package semver is not a
format compatibility algorithm. Historical Spec 0.1 prose is not normative.
The package is a projection and does not replace its owning sources.

Previous: [Run and interpret the conformance corpus](conformance.md)\
Start over: [Reader journey](index.md)
