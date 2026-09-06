---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: architecture-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-05
theme: framework-package-ownership
confidence: high
evidence_grade: B
last_reviewed: 2026-09-06
ai_provenance: GPT-6 via Codex on 2026-09-06; based on checked-in source, package manifests, and the user-approved owner convergence; no claim about unpublished release evidence
---

# Framework package ownership

Every immediate directory under `framework/` is a real npm workspace package.
The framework root contains durable build-on boundaries; repository tools and
product assembly live under `developer/` and `product/` instead of pretending
to be packages.

The authoritative classification is
[`layout.manifest.json`](layout.manifest.json). The layout gate verifies that
every immediate directory has `package.json`, matches the public npm registry,
and that no source-only framework root can be reintroduced.

## Semantic owners

| Owner | Responsibility | Owned protocol and implementation groups |
| --- | --- | --- |
| `@kungfu-tech/spec` | Portable declarations, schemas, registries, compatibility and conformance material | `format`, `contract`, `registry`, `invariant`, `primitive`, `incubation` |
| `@kungfu-tech/core` | Native facts, episodes, runtime admission, persistence, exit and data protection | `config`, `fact`, `episode`, `episode-admission`, `runtime`, `exit`, `data-protection`, `workspace-federation` |
| `@kungfu-tech/work` | Domain-neutral Work semantics and pure composition above Core | `agent-work`, `initiative-assignment`, `work-lifecycle`, `work-loop`, `profile`, Action Geometry, Assignment Runtime, Evidence, Project Cut and their repository-internal helpers |

`@kungfu-tech/spec` can distribute deterministic projections of Core and Work
contracts, but it cannot redefine their semantics. `@kungfu-tech/work` owns no
native writer, journal, storage engine or lease authority; those remain in
Core. Higher product and API layers compose these packages without becoming a
second authority.

## Non-framework owners

- `developer/` owns patrol, dogfood capture, deprecation, delivery,
  maintainability, Production Graph and report-projection tooling.
- `product/` owns Hub Starter, release/version-line automation, upgrade
  contracts and product qualification contracts.

Historical evidence can retain the path it observed. Active source, tests,
registries and documentation must use the current owner paths.

## Consuming another workspace package

A shared checkout does not relax a package boundary. Every consuming package
must declare the provider in `dependencies`, `devDependencies`,
`peerDependencies`, or `optionalDependencies`, according to the consumer's role.
Imports and build entrypoints use the provider's package name and explicit
`exports`; relative imports remain local to their owning package.

For example, use `@kungfu-tech/work/project-cut` and
`@kungfu-tech/agent-session/product-client`. Do not import a sibling's `src/`
path or redirect its package name through TypeScript or bundler source aliases.
The package manager's workspace links provide local resolution. A TypeScript
source file can be an explicit public export; its consumer must use a compatible
TypeScript loader or bundler.

Cold proof CI installs only the declared Product and Spec workspace links
offline before the full toolchain installation. These are ordinary installed
packages under `node_modules`; Node enforces their public exports. The bootstrap
installer does not register source aliases or execute dependency scripts.

Package fixtures copy the package's own manifests and source, then install any
required declared dependencies in the fixture. Installed `node_modules` may
contain cyclic workspace links and must not be recursively copied into source
fixtures. The native KFX bootstrap regression exercises this installed layout
while retaining its existing confinement checks.

The same rule applies to tests and repository tooling. Providers expose narrow
`testing` and `tooling` entries for those consumers. The private root package
`@kungfu-tech/workspaces` owns repository helpers; it is a development dependency
of tooling that needs those helpers. Native/generated entries still require
their documented build. This boundary check does not qualify every export for
standalone distribution or claim a public npm release.

[`check-package-boundaries.mjs`](../scripts/check-package-boundaries.mjs)
checks module imports, constant constructed paths, build aliases/entrypoints,
TypeScript configuration, and cross-package script dispatch. Runtime-selected
external plugins remain dynamic; the static check does not evaluate arbitrary
programs. Layout dependencies are derived from declared package dependencies,
including development and peer relationships.

## Verification

```sh
./shifu check:package-boundaries
./shifu check:framework-layout
./shifu check:npm-package-registry
./shifu check:source
```
