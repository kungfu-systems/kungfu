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

Publication follows Kungfu's coordinated package release. After a release is
published, use `alpha` only for discovery and persist the reviewed exact
pickup:

```sh
SITE_VERSION=$(npm view @kungfu-tech/site@alpha version)
npm install --save-exact "@kungfu-tech/site@$SITE_VERSION"
```

Do not leave `@alpha` in a package manifest. This package does not make a
stable-format or `latest` release claim.

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
  including the progressive reader journey, complete task guides, overview,
  reader-contract, version-matrix, registry and retained-vector routes.
  Consumers never need a monorepo checkout.
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

`renderPageModels()` verifies the complete bundle and returns one serializable,
integrity-bound page model for every human route. `renderPageModel(routeOrId)`
selects one route or surface id. The `/format/` model exposes only the journey
summary and navigation metadata; it does not flatten every guide body into the
landing page.

`renderFormatGuideModels()` returns the seven rooted guides in their declared
reading order. `renderFormatGuideModel(id)` selects one guide with its Markdown
body, previous/next/related navigation, level map, package coordinate, and
normative root. A downstream site can therefore install this package and
render both product pages and progressively disclosed Spec documentation
without checking out the Kungfu monorepo:

```js
const {
  renderFormatGuideModels,
  renderPageModels,
} = require('@kungfu-tech/site');

for (const page of renderPageModels()) render(page);
for (const guide of renderFormatGuideModels()) renderGuide(guide);
```

The guide content explains the direct Spec API, `kungfu-spec` CLI, independent
Python reader, and conformance corpus. To execute those tools, install
`@kungfu-tech/spec`; Site intentionally provides the documentation and rooted
evidence projection, not a duplicate executable surface.

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
./shifu pack:site
```
