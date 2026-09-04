---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: architecture-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-04
theme: framework-package-ownership
confidence: high
evidence_grade: B
last_reviewed: 2026-09-04
ai_provenance: GPT-5 via Codex on 2026-09-04; based on checked-in source, package manifests, and the user-approved owner convergence; no claim about unpublished release evidence
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

## Verification

```sh
./shifu check:framework-layout
./shifu check:npm-package-registry
./shifu check:source
```
