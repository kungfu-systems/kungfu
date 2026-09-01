---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: architecture-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-01
theme: framework-layout-governance
confidence: high
evidence_grade: B
last_reviewed: 2026-09-01
ai_provenance: GPT-5 via Codex on 2026-09-01; generated from checked-in source and repository contracts, with no access to invisible model internals
---

# Framework layout and package boundaries

`framework/` is an architecture root, not a synonym for an npm workspace
package. Its immediate directories currently have two distribution classes:

- `npm-package`: a directory with `package.json` whose package identity is also
  present in [`release/npm-package-registry.json`](release/npm-package-registry.json);
- `source-only`: checked-in contracts, internal libraries or repository tools
  that deliberately have no independent npm package identity.

The authoritative, complete classification is
[`layout.manifest.json`](layout.manifest.json). The repository gate checks that
every immediate directory is classified exactly once, that source-only roots do
not silently acquire `package.json`, and that npm-package entries match the npm
release registry. A root `workspaces` glob may discover directories, but it does
not turn a directory without `package.json` into a package.

## Current inventory

The manifest classifies all 56 immediate directories: 10 npm packages and 46
source-only roots. Their architectural roles are independent of distribution:

| Role | Count | Meaning |
| --- | ---: | --- |
| `runtime-package` | 10 | Released build-on or reference runtime surface |
| `contract-root` | 23 | Schemas, contracts, fixtures, vectors and adjacent validators |
| `internal-library` | 14 | Reusable repository source without an independent package boundary |
| `repository-tool` | 9 | Development, governance, qualification or release automation |

The ten current npm packages are `agent-session`, `api`, `core`, `gui`, `kfx`,
`site`, `skill`, `spec`, `storage` and `tui`. This list is a projection of the
manifest and release registry, not a naming convention for future directories.

Each manifest entry also records cross-directory dependencies discovered from
single-literal relative paths in checked-in JavaScript and TypeScript source.
This is a lexical repository-coupling map across production code, tests and
tooling. It is not by itself a public API graph or proof of runtime coupling.

## Public-boundary review candidates

Four source-only roots are queued for a later, explicit boundary decision. The
`candidate` marker is non-binding: it does not create a package, authorize
publication or promise API stability.

| Candidate | Why review it | Evidence required before a package decision |
| --- | --- | --- |
| `action` | Owns action and loop contracts consumed by work-profile conformance | Identify external consumers, stabilize the contract and prove release independence |
| `assignment-runtime` | Freezes a protocol shared by GUI, CLI, Agent and KFX clients | Prove that callers need a separately versioned artifact rather than repository-shared schemas |
| `evidence` | Provides a reusable evidence-envelope implementation consumed by Project Cut | Resolve its reciprocal source coupling with Project Cut and define a minimal stable export surface |
| `project-cut` | Has broad internal reuse across settlement, history, evidence and work-design tooling | Separate protocol API from repository orchestration, then prove isolated tests and compatible versioning |

A follow-up boundary card must evaluate, for each candidate:

1. real consumers and whether any live outside this repository;
2. a minimal stable import/export contract and explicit ownership;
3. dependency direction, including cycle removal where a package boundary would
   otherwise reproduce repository coupling;
4. independent semantic versioning, release need and compatibility policy; and
5. isolated build, test and package-artifact verification.

Until that evidence is accepted, all four remain source-only. This classification
does not move directories, change runtime behavior, alter a public API or add a
release artifact.

## Verification

Run the focused check through the repository entrypoint:

```sh
./shifu check:framework-layout
```

The same validator and its negative tests are part of `./shifu check:source`, so
an unclassified directory, an accidental package boundary or dependency-map
drift fails the protected source gate.
