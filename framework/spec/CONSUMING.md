# Consuming `@kungfu-tech/spec` (for `site-libkungfu-dev`)

This is the **connection contract** between the monorepo and the docs site. The
site depends on exactly one thing: the **manifest** of this package. It must not
vendor, submodule, or otherwise reach into the monorepo for spec content.

## 1. Pin the package

```jsonc
// site-libkungfu-dev package.json
{
  "dependencies": {
    "@kungfu-tech/spec": "4.0.0-alpha.0" // reproducible pickup coordinate (tracks lerna)
  }
}
```

```bash
pnpm add @kungfu-tech/spec
```

The npm package version is only a **pickup coordinate**. Everything the site
renders and routes by comes from inside the bundle, keyed on `spec_version`.

## 2. Read the manifest

```js
const { manifestPath } = require('@kungfu-tech/spec');
const manifest = require(manifestPath); // = dist/manifest.json
```

The manifest is the trust root. Its shape is pinned by
`@kungfu-tech/spec/schema/manifest.schema.json`. Relevant fields:

- `spec_version` — **route and render off this** (e.g. `/spec/0.1/`), never off the
  npm package version.
- `format_namespace` — stable, domain-free format identity.
- `docs_url_base` — the site's own public base for this spec version.
- `categories.*.path` — the six machine-addressable payload pieces, relative to
  the bundle root (the package's `dist/`).
- `handbooks.*` — the three per-binding handbooks, each with its own
  `binding_version` and `docs_url`.

## 3. Resolve payload paths

Paths in the manifest are relative to the bundle root (`dist/`):

```js
const path = require('path');
const bundleRoot = path.dirname(manifestPath);
const formatSpecDir = path.join(bundleRoot, manifest.categories.format_spec.path);
// -> render dist/format-spec/index.md to HTML
```

## 4. Walking-skeleton status (read this)

Today only `categories.format_spec` carries real (minimal) prose — that is the
document the site should render to HTML to prove the pipe. The other five
categories and the three handbooks are **minimal stubs** (each JSON carries a
`note` marking it pending its owning flow). The site should render them as
"planned / minimal" rather than assuming content — the manifest shape is stable,
the content grows behind it.

## Contract discipline

- The manifest schema is the only coupling point. A change to it is a change to
  this interface — treat as versioned.
- The site is a pure consumer: no spec truth lives in the site repo. Rendered
  HTML and any re-emitted machine artifacts are derived from this bundle.
