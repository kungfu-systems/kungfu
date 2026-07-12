---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---

# @kungfu-tech/spec

The portable fact-ledger **format spec** bundle for kungfu, and the **manifest
contract** that connects the monorepo to any consumer of the spec.

This package is the **alignment baseline** for the whole spec pipeline: it is
deliberately landed first, as a skeleton, so the generating flows (core /
toolchain / node / python) and the downstream site all agree on one contract
before any content exists.

> **Pre-release walking skeleton.** The manifest contract and aggregation
> pipeline are active. The bundled format prose is still the historical 0.1
> draft and is not the current normative `.kungfu` semantic contract. It
> predates the Episode-centered object model and is retained as an explicit
> draft input, not as implementation guidance. Current public semantics live in
> [`docs/the-episode.md`](../../docs/the-episode.md),
> [`docs/episode-object-model.md`](../../docs/episode-object-model.md), and
> [`docs/event-model.md`](../../docs/event-model.md).

## What this package is

- The **single connection protocol** between the kungfu monorepo (the single
  source of truth for the format) and any consumer (e.g. a docs site) is the
  **manifest** of this package. The manifest schema is the versioned contract;
  changing it changes the two-repo interface.
- This package **only aggregates and publishes** the bundle. It does **not**
  own the content of the generated pieces — each source package owns its own
  generator and its own drift gate.

## The three version axes (kept separate)

| Axis | Example | Role |
| --- | --- | --- |
| kungfu software version | `4.0.0-alpha.0` | software release (lerna single source) |
| this package's version | `4.0.0-alpha.0` | **pickup coordinate** (reproducible pin; tracks lerna) |
| **spec / format version** | **`0.1`** | pre-release draft coordinate declared in the manifest; no stable format compatibility claim yet |

Consumers render and route off `spec_version`, never off the npm package
version. The format identity (`format_namespace`) is **domain-free** on purpose:
the docs domain may move (e.g. `.dev` ↔ `.cc`) without touching the format.

## The contract

- `schema/manifest.schema.json` — the manifest contract (JSON Schema). **This is
  the hard artifact this package pins.**
- `schema/manifest.example.json` — a reference manifest instance (placeholder
  paths/values) showing the shape every flow targets.

The manifest points at **six categories** (format spec, schema registry, error
dictionary, capabilities, conformance vectors, conformance map) and **three
handbooks** (kungfu/CLI, pypi/python, npm/node), plus a resolvable
`docs_url_base`. Ownership of each generated piece:

| Piece | Source package |
| --- | --- |
| schema registry, error dictionary, conformance vectors, capabilities | `framework/core` |
| CLI-ref handbook | `developer/toolchain` |
| node-ref handbook | `framework/api` + `framework/core` native Node binding |
| py-ref handbook | python binding over `libkungfu` |
| format spec (prose), conformance map, aggregation, manifest | `framework/spec` (this package) |

Storage is one of the load-bearing examples for this ownership split:
`libyijinjing` names the portable storage vocabulary, `libkungfu` implements
the runtime storage service, and Python/Node expose binding shims over that C++
service. The spec bundle should document those surfaces as bindings to the same
runtime contract, not as independent Python or Node storage models. Storage
backends such as the content-addressed file provider or RocksDB provider are
runtime implementation choices behind that contract.

## Build and verify the skeleton

The repository-level `./shifu build` path invokes `scripts/aggregate.js` to
produce a schema-valid bundle in `dist/`. The package's `scripts/verify.js` is
the active integration drift gate: it rejects manifest shape drift, missing
payloads, a domain-embedded `format_namespace`, or a `spec_version` that does
not match `docs_url_base`. Contributors should enter through `./shifu`, as
described in the repository [CONTRIBUTING guide](../../CONTRIBUTING.md), rather
than invoking the package manager directly.

The currently published skeleton surfaces are indexed here so a consumer can
reach every page from this package entrypoint:

- [Format overview](docs/overview.md)
- [CLI handbook](docs/handbooks/cli.md)
- [Node handbook](docs/handbooks/node.md)
- [Python handbook](docs/handbooks/python.md)

This is a **walking skeleton**: the pipeline produces and gates a real bundle,
but with minimal content. Only `categories.format_spec` carries real prose
(`docs/format-spec.md`), but that prose remains a non-normative historical 0.1
draft. The five machine categories and three handbooks are minimal or staged
surfaces, each tagged in the manifest with its owning package. See
[CONSUMING.md](CONSUMING.md) for how `site-libkungfu-dev` consumes the bundle.

## Not done here (follow-ups)

- Real generators + per-piece drift gates in each owning package
  (core / toolchain / node / python flows) — they replace the minimal stubs.
- Full JSON-Schema validation of the manifest via `ajv` (the gate is currently a
  focused structural check; the schema itself is already the pinned contract).
- Deep design of the schema registry mechanism.
- Wiring this package's `verify` into the root `verify` / `.buildchain/buildchain.toml`
  lifecycle once content is beyond the walking skeleton.
