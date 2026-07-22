# Shifu

Shifu is Kungfu's development and build execution tool. It opens a checkout,
resolves the pinned toolchain, applies local execution policy, and delegates the
declared task. Buildchain owns the build and release process around that
execution; Shifu owns how the task is executed after source checkout.

## Start here

- [Cache profiles](cache-profiles.md) explains how a private inventory projects
  a secret-free profile for development or a self-hosted runner.
- [`cache-contract.json`](cache-contract.json) is the machine-readable contract
  manifest and the discovery root for schema paths, schema IDs, ownership, and
  compatibility rules.
- [`artifact-contract.json`](artifact-contract.json) is the machine-readable
  discovery root for local build provenance and safe promotion semantics shared
  by `self-update` and `builds/promote`.
- [Gate control plane](gates.md) explains the project-independent registry,
  explicit profile matrix, validation, deterministic planning, bounded
  execution, and source-bound receipt contract.
  [`gate-contract.json`](gate-contract.json) is its discovery root.
  Kungfu's concrete [Gate catalog and policy matrix](../qualification/gates/README.md)
  consume that contract without moving project policy into Shifu.
- [`documentation-contract.json`](documentation-contract.json) is the
  project-independent Documentation Protocol discovery root. It keeps document
  roles separate from verification profiles, accepts exact project-owned
  subject/claim/probe/artifact providers, and computes deterministic contract,
  content, and submission roots. Kungfu's compatibility submission is
  [`../../shifu.documentation.json`](../../shifu.documentation.json).
- [`.xinfa/project.json`](../../.xinfa/project.json) is the project-owned semantic declaration consumed by Xinfa. [`shifu.documentation.surfaces.json`](../../shifu.documentation.surfaces.json) is only a compatibility alias and carries no independent policy.
  classifies every tracked human-readable surface plus explicit product and
  Agent surfaces. Shifu closes the exact-path inventory; Xinfa remains the sole
  graph, impact, stale-propagation, and dual-first projection authority.
- [`schema/cache-profile-v1.schema.json`](schema/cache-profile-v1.schema.json)
  is the single source of truth for cache profile fields.
- [`schema/cache-resolution-v1.schema.json`](schema/cache-resolution-v1.schema.json)
  is the single source of truth for redacted resolution evidence.
- [`schema/cache-diagnostic-v1.schema.json`](schema/cache-diagnostic-v1.schema.json)
  governs `cache status` and `cache doctor` output.
- [`schema/cache-config-plan-v1.schema.json`](schema/cache-config-plan-v1.schema.json)
  governs dry-run and executed `cache use/unset` receipts.
- [Shifu ADRs](../adr/README.md) contain Shifu-specific decisions in an independent
  `SHIFU-ADR-*` namespace.

The checked-out Shifu exposes these sources without requiring a published
package:

```sh
./shifu cache contract
./shifu cache schema profile
./shifu cache schema resolution
./shifu cache schema diagnostic
./shifu cache schema configPlan
./shifu cache validate profile path/to/cache-profile.json
./shifu cache resolve --profile path/to/cache-profile.json --digest sha256:...
./shifu cache apply --profile path/to/cache-profile.json --digest sha256:... -- ./shifu check
./shifu cache status --json
./shifu cache doctor --json [--probe]
./shifu cache use --profile path/to/cache-profile.json --digest sha256:... [--execute]
./shifu cache unset [--execute]
./shifu artifacts contract
./shifu artifacts schema
./shifu artifacts receipt-schema
./shifu docs contract
./shifu docs schema submission
./shifu docs schema receipt
./shifu docs validate --json
./shifu docs show --json
./shifu docs inventory --json
./shifu docs inventory --format xinfa-project --json
./shifu docs graph --output /tmp/kungfu-documentation-atlas --json
./shifu docs pack --output /tmp/kungfu-product-documentation --json
./shifu docs impact --since /tmp/kungfu-documentation-atlas --json
./shifu docs authoring --since HEAD~1 --json
./shifu docs final-ready --since HEAD~1 --json
./shifu docs read --intent "understand documentation control" --route kungfu-documentation-control-human --json
./shifu docs context --task "change documentation control safely" --budget 66560 --route kungfu-documentation-control-agent --json
./shifu docs inventory --format xinfa-project --json
./shifu docs xinfa compile --project .xinfa/dogfood-project.json --root . --output /tmp/xinfa-atlas --json
KUNGFU_DOCUMENTATION_ATLAS=/tmp/kungfu-product-documentation kungfu agent docs --verify --json
KUNGFU_DOCUMENTATION_ATLAS=/tmp/kungfu-product-documentation kungfu agent docs --catalog --json
KUNGFU_DOCUMENTATION_ATLAS=/tmp/kungfu-product-documentation kungfu agent docs --read docs/MAP.md
./shifu gate contract
./shifu gate schema registry
./shifu gate schema plan
./shifu gate schema receipt
./shifu gate validate --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate matrix --registry docs/shifu/examples/gates/minimal.gate-registry.json
./shifu gate plan release --platform linux --registry docs/shifu/examples/gates/minimal.gate-registry.json --json
./shifu gate run --profile success --registry docs/shifu/examples/gates/execution.gate-registry.json --json
./shifu gate receipt validate build/gate-receipts/success.json --registry docs/shifu/examples/gates/execution.gate-registry.json --json
```

The contract and schema discovery commands print the exact checked-in JSON.
Consumers should pin the checkout or binary source revision when they use the
result as a generation input. Runtime commands consume profile instances and
never modify the checked-in contract. Documentation validation is diagnostic
and non-qualifying; it never executes document commands or provider probes.
`docs xinfa compile` first validates the named Documentation Protocol
submission, then delegates Atlas compile and verify to the public Xinfa binary.
Its adapter receipt retains both root sets, remains non-qualifying, and owns no
Context IR, selection, or projection semantics.
`docs inventory` fails closed when an eligible tracked surface is unclassified
or a declared route entrypoint is missing. Its exact-path Xinfa submission
includes explicit document-to-implementation or artifact revision bindings.
`docs graph` and `docs impact` are thin invocations of the public Xinfa CLI;
they do not introduce a Shifu graph, cache authority, or inferred semantic
edge. Generated, managed-block, authored, historical-append-only, and non-claim
lifecycles control how a diagnosed surface may be maintained; inventory
membership alone never authorizes a prose rewrite.
`docs pack` uses that same compile-and-verify path to emit the public product
Atlas. The selected content-addressed baseline is declared by
`.xinfa/product-documentation-pack.json`; product assembly copies its exact
bytes into the installed package. `kungfu agent docs` verifies Atlas, manifest,
receipt, Context Pack, and both projection roots before exposing exact catalog,
read, or precompiled Human/Agent projection operations. The runtime is
read-only, works offline without Shifu or a repository checkout, and contains
no selector, compiler, or document-command executor.

`docs read` and `docs context` are thin dual-reader adapters over the public
Xinfa compiler. Paired Human and Agent routes select the same exact authority
nodes and declare the same value, use, authority, constraints, known limits,
evidence, and next-action capabilities. The current bounded dogfood routes are
`kungfu-documentation-control`, `kungfu-kfx-development`,
`kungfu-core-development`, and `kungfu-user-guide`; append `-human` or `-agent`
to select a surface. The documentation-control Agent route has a measured
complete budget of 66,560 tokens; KFX, Core, and user-guide routes complete
within 16,384. A smaller budget remains valid but reports required omissions
and expansion handles instead of silently dropping authority. `--since` adds
Xinfa's bounded impact receipt; Shifu does not reinterpret that graph.
`docs authoring --since` is the source-diff side of the same workflow. It emits
a bounded, content-addressed obligation receipt without editing prose:
generated surfaces require regeneration and a dirty check; declared managed
regions allow only a mixed-review refresh; authored surfaces require review;
historical surfaces require append/supersede review and cannot be deleted; and
non-claims explicitly carry no implementation-claim impact. The current Kungfu
policy also conserves the existing `docs:check`, `docs:check:readonly`, and
`check:source` capabilities as composed project probes with owners and explicit
sunset conditions. These compatibility commands remain stricter project checks,
not a second graph or Documentation Protocol authority.

`docs final-ready --since` compiles the exact inventory once, then asks Xinfa
for the paired Human view and Agent Task Chart. Its content-addressed receipt
binds the authoring-impact root, inventory root, Atlas root, both projections,
and the shared parity authority. Implementation drift, an incomplete required
projection, a one-sided/mismatched parity group, or an authoring violation
fails closed. Human or mixed obligations produce `review-required`, not a
self-review: Atlas `go` binds the receipt root into the native Completion Claim
as a proof root, and only the independent exact-claim review may close it.
Project Cut v1 remains unchanged and never becomes a second documentation
authority.
Buildchain receives the separate project-owned
`.buildchain/kfd/kfd-1/documentation-pack.witness.json`. It binds the release
passport target SHA and packaged bytes to the same Atlas, Context Pack, cut,
claim-graph, manifest, and qualification roots; it attests those identities but
does not interpret prose or compile documentation. The conformance and final
qualification harnesses exercise an engineering consumer and a publication
consumer without changing Xinfa, and reject parallel compiler/selector
authorities or unbounded compatibility aliases. The retained matrix is
`docs/qualification/documentation-control-plane.json`.
`status` is local-only, `doctor` probes
endpoints only when explicitly requested, and local configuration changes are
dry-run unless `--execute` is present.

## Boundary

Shifu profiles are configuration projections, not infrastructure inventories.
Do not commit private endpoint inventories, credentials, organization variables,
or host-specific secrets here. An inventory controller may generate profiles,
validate them against the Shifu schema, and place them in approved local or CI
configuration surfaces.

Phase-0 locked source checkout remains a Buildchain concern. The Shifu cache
contract starts after the checkout is available and covers toolchain,
dependency, artifact, compiler, and generic download caches used during task
execution.
