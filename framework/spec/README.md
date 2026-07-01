# @kungfu-tech/spec

The portable fact-ledger **format spec** bundle for kungfu, and the **manifest
contract** that connects the monorepo to any consumer of the spec.

This package is the **alignment baseline** for the whole spec pipeline: it is
deliberately landed first, as a skeleton, so the generating flows (core /
toolchain / node / python) and the downstream site all agree on one contract
before any content exists.

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
| **spec / format version** | **`1.0`** | **the authoritative contract** (declared in the manifest, independent of the above) |

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
| node-ref handbook | `framework/api` |
| py-ref handbook | python binding |
| format spec (prose), conformance map, aggregation, manifest | `framework/spec` (this package) |

## Scripts (skeleton placeholders)

- `pnpm --filter @kungfu-tech/spec run build` → `scripts/aggregate.js`: builds a
  real, schema-valid bundle into `dist/` (`manifest.json` + the six category
  payloads + three handbook payloads) from `spec.meta.json`, `package.json`, and
  `docs/format-spec.md`.
- `pnpm --filter @kungfu-tech/spec run verify` → `scripts/verify.js`: the
  **integration drift gate**, active. Fails the build if the produced bundle
  drifts from the manifest contract (missing/extra fields, domain-embedded
  `format_namespace`, a referenced payload path that does not exist, or a
  `spec_version` not routed into `docs_url_base`).

This is a **walking skeleton**: the pipeline produces and gates a real bundle,
but with minimal content. Only `categories.format_spec` carries real prose
(`docs/format-spec.md`); the five machine categories and three handbooks are
minimal stubs, each tagged in the manifest with its owning package. See
[CONSUMING.md](CONSUMING.md) for how `site-libkungfu-dev` consumes the bundle.

## Not done here (follow-ups)

- Real generators + per-piece drift gates in each owning package
  (core / toolchain / node / python flows) — they replace the minimal stubs.
- Full JSON-Schema validation of the manifest via `ajv` (the gate is currently a
  focused structural check; the schema itself is already the pinned contract).
- Deep design of the schema registry mechanism.
- Wiring this package's `verify` into the root `verify` / `buildchain.toml`
  lifecycle once content is beyond the walking skeleton.
