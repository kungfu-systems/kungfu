# Consuming `@kungfu-tech/spec`

This package is the only portable bundle boundary a site or independent tool
needs. Consumers must not reach into the Kungfu monorepo or copy semantic
tables into their own source.

## Pin and load

The package version is a pickup coordinate, not a format compatibility
decision. Until a release is published, use an exact source-built package from
the release qualification flow.

```js
const path = require('node:path');
const {
  inspectAuthority,
  manifestPath,
  verifyAuthorityBundle,
} = require('@kungfu-tech/spec');

const manifest = require(manifestPath);
const proof = verifyAuthorityBundle();
const authority = inspectAuthority();

if (proof.normative_root !== manifest.normative.root) {
  throw new Error('authority bundle root mismatch');
}
```

## Trust and routing rules

- Route by `spec_version`, never `package.version`.
- Key format identity by the domain-free `format_namespace`.
- Treat `manifest.normative.root` as the exact root of the packaged normative
  projection.
- Verify `artifacts.*.artifact_root` before consuming an artifact.
- Preserve `artifacts.*.source_roots` so a result can be traced back to its
  owning source.
- Honor `normative.status` and `normative.non_claims`; pre-release is not a
  stable compatibility promise.
- Resolve paths relative to `path.dirname(manifestPath)` and reject traversal.

`manifest.categories` preserves the six established category routes.
`manifest.artifacts` is the complete authority surface, including the required
reader matrix and migration graph.

## Site behavior

A site is a rebuildable projection:

1. verify the installed package;
2. render the rooted artifacts and their exact status;
3. expose source and artifact roots for independent inspection;
4. place historical material under an explicit history route;
5. never promote a package status beyond the status in the authority bundle.

Historical Spec 0.1 prose lives at `history.spec_0_1_draft.path` and is marked
`historical-non-normative`. It must not appear as the current format
specification.

Handbooks remain non-normative binding guides. Python and Node storage surfaces
must be described as bindings over the same `libkungfu` runtime storage
contract, not as independent language-owned storage semantics.

## What consumers must not infer

- npm integrity alone is not format trust;
- package semver is not a compatibility algorithm;
- JSON projection does not make JSON the universal authority encoding;
- retained vectors do not prove unsupported future versions;
- a site domain is not part of the format identity;
- the package does not supersede the owning protocol sources.
