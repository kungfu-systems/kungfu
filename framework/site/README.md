---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: ongoing
theme: kungfu-site-bundle
doc_type: repository-document
sources: [local-files, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-24
---

# `@kungfu-tech/site`

This package publishes the auditable product-positioning bundle consumed by
Kungfu human and agent sites. It answers one navigation question:

> How do Kungfu's product promise, `.kungfu` workspace and format boundary,
> primitives, runtime, ABI, SDKs, extensions, products, qualification,
> decisions, and future horizons fit together?

It does not own those technical facts. `src/site-bundle.source.json` is a
composition declaration. The generator resolves every declared authority in
the current monorepo, records its SHA-256 content root, and emits deterministic
artifacts under `dist/site/`.

## Published contract

- `dist/site/site-bundle.json` — complete human and agent product map.
- `dist/site/agent-index.json` — compact machine reading order.
- `dist/site/adr-map.json` — exact generated ADR navigation projection.
- `dist/site/format/manifest.json` — exact byte-for-byte
  `@kungfu-tech/spec` manifest projection. Its package coordinate, manifest
  root, portable normative root, status and non-claims are repeated in the
  bundle for fail-closed inspection.
- `dist/site/format/` — package-local copy of the verified Spec bundle,
  including stable overview, reader-contract, version-matrix, registry and
  retained-vector routes. Consumers never need a monorepo checkout.
- `schema/site-bundle.schema.json` — package/consumer contract.
- `installer-publication.mjs` — package-owned writer and verifier for a
  content-addressed installer publication handoff. It packages exact
  `install.sh`, `install.ps1`, signed-channel, trust-anchor, route, digest,
  MIME, cache, source, and Release Passport coordinates without operating a
  downstream site repository.
- `schema/installer-publication-bundle.schema.json` — the corresponding
  closed-world bundle contract.

An Alpha or Stable release may materialize an installer bundle only after its
signed channel and product artifacts exist. The resulting directory is a
release artifact, not a site checkout: a site-owned workflow pins and verifies
the bundle root before projecting any route. Source builds do not make an
installer available, and this package never deploys `kungfu.tech`.

The bundle schema version, npm pickup version, `.kungfu` layout/spec versions,
ABI versions, and component contract versions are independent axes. The
`@kungfu-tech/spec` package version is a pickup coordinate; compatibility is
read from the packaged version matrix and owning protocols.

Package consumers can load `formatManifestPath` or call
`loadFormatAuthorityManifest()`. `loadFormatAuthorityRoute(id)` accepts
`overview`, `readerContract`, `versionMatrix`, `registry`, or `vectors`,
verifies the exact packaged bytes, and returns the rooted JSON without any
source-tree dependency.

## Authority boundary

The package may frame, order, summarize, and link. It must not:

- promote the pre-release portable authority to stable;
- treat the historical Spec 0.1 prose as normative;
- turn qualified-shadow primitives, staged KFX/Profile behavior, or
  source-built SDKs into stable release claims;
- redefine Fact, Episode, Action Geometry, ABI, Profile, or release semantics;
- treat inferred ADR navigation as architecture authority; or
- omit known limits from the human or agent projection.

Run through Shifu from the repository root:

```sh
./shifu --filter @kungfu-tech/site build
./shifu --filter @kungfu-tech/site verify
./shifu --filter @kungfu-tech/site test
```
