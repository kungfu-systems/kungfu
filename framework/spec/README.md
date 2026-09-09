# @kungfu-tech/spec

`@kungfu-tech/spec` is the portable, agent-readable projection of Kungfu's
accepted `.kungfu` format authorities. It packages exact authority, reader,
compatibility, migration, and retained-vector evidence without turning the npm
package into a second semantic owner.

The package is content-addressed and deterministic:

- every normative artifact names its owning source files and their exact
  `sha256` roots;
- the manifest binds each generated artifact by exact byte length and artifact
  root;
- one canonical preimage binds all normative artifacts into
  `manifest.normative.root`;
- mutable build provenance is separate and excluded from that normative root;
- committed generated artifacts are a cache: source drift or a hand edit fails
  `generate:check`.

The standalone format is still pre-release. That status is explicit in the
manifest and its non-claims; it is not hidden behind empty registries, seed
tables, or walking-skeleton language.

## Read in layers

Do not start with the complete artifact inventory. Begin with the
[reader journey](docs/guides/index.md):

1. choose Site for rendering or Spec for direct tooling;
2. verify one installed authority;
3. open only the Node API, CLI, or Python task guide you need;
4. interpret conformance evidence when required;
5. use the complete reference for exact routes and trust rules.

The same rooted guide set is emitted under `dist/guides/` and projected
byte-for-byte into `@kungfu-tech/site`, so human pages and agent navigation
share one reading order.

## Authority graph

The source of truth remains under `framework/spec/format` and each listed protocol
owner. This package generates eight projections:

Cross-domain invariant declarations are documented in the
[invariant system reference](invariant/README.md).

| Artifact | Meaning |
| --- | --- |
| `authority.json` | composition boundary, terminology, version axes, status, and non-claims |
| `registry.json` | non-empty protocol registry with exact owner source roots |
| `errors.json` | required-reader and migration error dictionaries |
| `capabilities.json` | reader outcomes, capabilities, and material states |
| `reader-matrix.json` | profile preconditions, allowed outcomes, semantic scope, and failure codes |
| `compatibility.json` | current compatibility tuple and reader outcome map |
| `migration.json` | directed migration graph, receipts, repair rules, and refusals |
| `vectors/index.json` | retained real-byte corpus with release and byte roots |

The package also carries a stdlib-only independent Python reader at
`reference-readers/python/portable_format_reader.py`. It verifies every rooted
artifact and retained vector using only installed package bytes:

```bash
python3 node_modules/@kungfu-tech/spec/reference-readers/python/portable_format_reader.py --json
```

The six legacy category routes remain available in `manifest.categories`, but
they now point at these rooted generated artifacts. Additional machine routes
live in `manifest.artifacts`.

Historical Spec 0.1 prose is packaged only at
`history/spec-0.1-draft.md` with status `historical-non-normative`. It is not
the `format_spec` route and must not be used to implement a reader.

## Inspect an installed package

An agent does not need the monorepo:

```bash
kungfu-spec authority
kungfu-spec authority-verify
kungfu-spec corpus
kungfu-spec corpus-verify
kungfu-spec corpus-vector journal-v1-unknown-carrier
```

The Node API exposes the same boundary:

```js
const {
  inspectAuthority,
  verifyAuthorityBundle,
} = require('@kungfu-tech/spec');

const authority = inspectAuthority();
const proof = verifyAuthorityBundle();
console.log(authority.normative_root, proof.artifact_count);
```

`inspectAuthority()` returns the exact authority, compatibility, migration,
vector, source-root, artifact-root, and non-claim projections.
`verifyAuthorityBundle()` recomputes the normative root and every installed
artifact root before returning.

`inspectConformance()`, `verifyConformanceCorpus()`, and
`conformanceVector(id)` expose the same retained corpus boundary through the
Node API. See the [complete API guide](docs/guides/api.md).

The existing portable-fixture operations remain available:

```bash
kungfu-spec inspect BUNDLE
kungfu-spec verify BUNDLE
kungfu-spec preserve BUNDLE OUTPUT
```

## Generate, build, and verify

Enter through `./shifu`; direct package-manager lifecycle commands are rejected
by repository policy.

```bash
./shifu exec pnpm --filter @kungfu-tech/spec run generate:check
./shifu exec pnpm --filter @kungfu-tech/spec run build
./shifu exec pnpm --filter @kungfu-tech/spec run verify
./shifu pack:spec
./shifu layers:qualify:format
```

To intentionally refresh the committed projection after an owning authority
changes:

```bash
./shifu exec pnpm --filter @kungfu-tech/spec run generate
```

Review the source-root and artifact-root diff. A generated file is never an
independent edit surface.

## Reproducibility policy

Normative JSON is rendered as sorted-key UTF-8 JSON with two-space indentation
and one terminal LF:

```text
canonical-json-sorted-keys-utf8-lf/v1
```

Artifact roots use `sha256:opaque-bytes/v1`. The bundle root hashes the
canonical `kungfu.spec.normative-root/v1` preimage. `git_commit` is forensic
provenance only; time, host paths, operating system, and architecture are not
normative inputs.

## Consumer boundary

The manifest is the package-to-consumer interface. A site or tool may route,
render, verify, or re-emit it, but may not redefine protocol identity,
compatibility, migration, failure semantics, or release status. See
[CONSUMING.md](CONSUMING.md).
