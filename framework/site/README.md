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
review_state: self-reviewed
last_reviewed: 2026-07-27
ai_provenance: GPT-5 via Codex on 2026-07-27; based on the current site bundle, packaged Spec reader journey, KFD-3 registries, trademark policy, and visually verified downstream reader patterns; no site deployment, npm publication, or downstream repository mutation is claimed
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
- `experience.js` — deterministic, framework-independent human/Agent page
  generator. It emits complete HTML pages plus rooted `manifest.json`,
  `agent-index.json`, and `llms.txt` bodies without writing a downstream
  repository.
- `schema/site-experience-config.schema.json` — closed configuration/content
  boundary for the experience generator.
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

`renderFormatDocumentModels()` is the complete web-document projection. It
adds the authority overview, CLI/Node/Python handbooks, and explicitly
historical Spec draft to the seven task guides. Every model binds the exact
Markdown route, byte length, SHA-256 root, progressive previous/next/related
navigation, and rewritten package-local links.

`renderSourceDocumentModels()` projects every declared product authority into
a human route plus an exact raw-source route. The current bundle covers all
thirty declared sources behind product framing, primitives, runtime, ABI, SDK,
extensions, products, qualification, ADR navigation, and domain horizons.
Markdown is rendered as structured prose; JSON contracts and the public C
header remain readable as exact code. Relative document links resolve to
another packaged authority page when available and otherwise to the pinned
source revision.

The guide content explains the direct Spec API, `kungfu-spec` CLI, independent
Python reader, and conformance corpus. To execute those tools, install
`@kungfu-tech/spec`; Site intentionally provides the documentation and rooted
evidence projection, not a duplicate executable surface.

## Generate a complete reader experience

`renderProductSiteExperience()` turns the packaged product map into a complete
Core site. A consumer supplies only its canonical base URL and local context:

```js
const {
  renderProductSiteExperience,
  verifySiteExperience,
} = require('@kungfu-tech/site');

const experience = renderProductSiteExperience({
  canonicalBaseUrl: 'https://core.libkungfu.dev',
  context: 'Core Product and Developer Platform',
});

verifySiteExperience(experience);
for (const file of experience.files) writeRoute(file.route, file.body);
```

The generated product experience contains all eleven product pages, all twelve
format documentation pages, all thirty product-authority pages, their exact raw
sources, every packaged JSON/JSONL format route, and the complete retained
conformance vector corpus. The site does not need a source checkout or a
site-specific copy step. `agent-index.json`, `manifest.json`, and `llms.txt`
list the same documentation and evidence routes that humans can open.

Every human page is generated with the same order:

1. a concise human proposition;
2. a visible Agent co-reading prompt linked to the KFD-3 machine entry;
3. human-oriented explanation and known limits; and
4. complete implementer/auditor material inside a collapsed technical
   disclosure.

The header, metadata, footer, primary navigation, machine alternates, and
machine artifacts all use the exact `Kungfu UNGFU™` signature. `Kungfu`
remains the product name; UNGFU is not a second product or runtime. Machine
routes stay out of the human primary navigation while remaining visible in the
first-screen cue and `<link rel="alternate">` metadata.

`renderSiteExperience(config)` applies the same contract to other Kungfu
surfaces. Its input is intentionally only site context, navigation, machine
routes, and page content split into `humanSections` and `technicalSections`.
It escapes all supplied prose, renders technical sections collapsed by
default, creates human and Agent projections from the same page array, and
binds every emitted body to SHA-256 roots:

```js
const { renderSiteExperience } = require('@kungfu-tech/site');

const experience = renderSiteExperience({
  contract: 'kungfu.site-experience-config/v1',
  site: {
    id: 'example-site',
    context: 'Example Surface',
    canonicalBaseUrl: 'https://example.kungfu.test',
  },
  content: {
    pages: [
      {
        id: 'home',
        label: 'Home',
        route: '/',
        headline: 'Start from the human outcome.',
        summary: 'Open exact technical evidence only when the task needs it.',
        claimClass: 'site-synthesis',
        maturity: 'staged',
        knownLimits: ['This example is not a release claim.'],
        humanSections: [
          {
            id: 'orientation',
            heading: 'Understand the result first.',
            body: 'The first reading layer stays short and useful.',
          },
        ],
        technicalSections: [
          {
            id: 'evidence',
            heading: 'Inspect exact evidence.',
            body: 'Put rooted contracts and source references here.',
          },
        ],
      },
    ],
  },
});
```

This generator projects KFD-3 parity; it does not certify a downstream site.
The package binds the parity rule to Kungfu's exact KFD-3 API and Buildchain
surface registries. A downstream release still owns its own conformance and
publication evidence.

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
