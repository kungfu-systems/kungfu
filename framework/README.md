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

## Completed public-boundary decisions

Wave 1 completed the four queued decisions. All remain `source-only`: a stable
repository entrypoint is not an npm identity, and compatibility follows the
repository train unless an explicit future package decision proves otherwise.

| Boundary | Disposition | Stable seam | Declared consumers | Migration boundary |
| --- | --- | --- | --- | --- |
| `action` | `repository-stable` | `action/index.mjs` | `work-profile-conformance` | The sole cross-directory code consumer now uses the index; other Action artifacts remain contract/package data rather than npm exports. |
| `assignment-runtime` | `embedded-public-protocol` | `assignment-runtime/index.mjs`, the v1 contract and envelope schema | Core CLI/Agent, API, GUI and Work Dashboard | The protocol stays public through existing runtime products; no separate package, writer or transport is created. |
| `evidence` | `repository-stable` | `evidence/index.mjs` and its envelope schema | Project Cut and source qualification | New code uses the index; envelope identity is unchanged and no independent release is introduced. |
| `project-cut` | `repository-stable` | `project-cut/index.mjs` for the frozen core protocol | Assignment Capture, Core, Cut, Episode Provider, maintainability/work-design tooling and scripts | Existing specialized `src/*` imports are an exact non-growing ratchet; new consumers must use the stable core index or first make a new boundary decision. |

The Evidence/Project Cut source cycle is removed by keeping the one canonical
JSON/root implementation in
[`format/project-cut-canonical-json.mjs`](format/project-cut-canonical-json.mjs).
Project Cut re-exports those functions for compatibility and still owns the
root protocol and preimages. Evidence and Project Cut depend on the neutral
format implementation; only Project Cut depends on Evidence for receipt
envelopes. Golden root and receipt fixtures guard byte compatibility.

For every completed boundary, the manifest declares its stable entrypoints,
consumer scopes and exact legacy deep imports. The layout gate fails closed for
a missing entrypoint or consumer, a completed-boundary dependency cycle, a new
private import, a stale or duplicate ratchet entry, or accidental package and
release-registry drift.

## Verification

Run the focused check through the repository entrypoint:

```sh
./shifu check:framework-layout
```

The same validator and its negative tests are part of `./shifu check:source`, so
an unclassified directory, an accidental package boundary or dependency-map
drift fails the protected source gate.
