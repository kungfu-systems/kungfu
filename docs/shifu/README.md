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
- [`qualified-assignment-core-platform-matrix.json`](qualified-assignment-core-platform-matrix.json)
  and its
  [`v1 schema`](schema/qualified-assignment-core-platform-matrix-v1.schema.json)
  bind the initial Qualified Core producer rows, hosted runner identities,
  payload closures, artifact names, and per-row promotion policy.
- [`schema/qualified-assignment-core-artifact-v1.schema.json`](schema/qualified-assignment-core-artifact-v1.schema.json)
  and
  [`schema/qualified-assignment-core-qualification-v1.schema.json`](schema/qualified-assignment-core-qualification-v1.schema.json)
  define the fail-closed manifest and receipt used to qualify reusable
  Assignment Core payloads.
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
- [`production-graph-contract.json`](production-graph-contract.json) defines the
  project-independent Production Graph v0 description, verification, and
  bounded local execution boundary. Its content-addressed graph, plan,
  execution-event, receipt, failure, recovery, executor-policy, local-execution,
  and verification-receipt schemas retain exact source,
  project-authority, and Xinfa selection roots without executing nodes or
  acquiring Assignment or Work Control authority. Kungfu's compiler seam in
  [`framework/production-graph/compiler/index.mjs`](../../framework/production-graph/compiler/index.mjs)
  accepts only an exact checkout, canonical authority roots and opaque IDs,
  and a source-matched verified Xinfa selection. Its polyglot fixture retains
  Cargo, pnpm, GYP, uv, Conan, CMake, wheel, freezer, KFX, TUI, GUI, product,
  and Buildchain handoff executor references while keeping execution external.
  The bounded
  [`core-production-subgraph-contract.json`](core-production-subgraph-contract.json)
  specializes that describe-only seam for the `journal` Core profile. It
  exposes exactly `dependency-bootstrap`, `native-build`, and `artifact-stage`
  in dependency order, gives each node one responsibility, and binds every
  source, toolchain, profile, project-authority, Xinfa-selection, and stage
  output declaration by root. These nodes are not independent commands: the
  unchanged `./shifu build:core` route remains the only execution owner, and
  the compiler and verifier start no stage and perform no cutover.
  Run
  `./shifu check:production-graph` to emit the exact protected-CI verification
  receipt over the deterministic conformance fixtures.
  The bounded
  [`native-build-lowering-contract.json`](native-build-lowering-contract.json)
  exploration reads that same `journal` node and existing Core authority into
  one backend-neutral Native Build IR, then lowers it to a non-executable Bazel
  data fixture. It emits rooted IR, projection, and receipt identities while
  leaving dependency labels, platform/toolchain constraints, and artifact
  staging as explicit provider prerequisites. It installs or invokes no Bazel,
  writes no build file, executes no node, and leaves `./shifu build:core`
  unchanged. The authority inventory, prerequisites, residual risks, and
  conditional-go boundary are recorded in the machine contract.
  Run `./shifu production-graph:native-build-lowering:verify` to print the
  exact fixture-only receipt.
  Before any node starts, `./shifu production-graph:admit --request REQUEST`
  verifies one exact native `kungfu.work-ref/v1`, Work Control query and run-gate
  roots, external authorization evidence, actor, attempt, executor policy,
  intended node set, source, graph, plan, project-authority, Xinfa selection,
  lease, and expiry. Missing, stale, drifted, expired, mismatched, replayed, or
  denied evidence produces a content-addressed rejection with
  `nodesStarted=false` and `authorityMutations=[]`. An admitted decision is
  only permission for its exact node set until `expiresAt`; admission itself
  never starts a node. Shifu does not mint or modify Assignment, Work Control,
  Warrant, approval, merge, or close authority.
  `./shifu production-graph:execute --graph GRAPH --plan PLAN
  --verification-receipt RECEIPT --execution-admission-request REQUEST
  --execution-admission-decision DECISION --executor-policy POLICY --execute`
  is the v0 local executor. It accepts only a clean exact source, the same
  rooted graph, plan, policy, and non-expired admitted node set, plus exact
  `production-graph:fixture:*` tasks allowlisted by the policy, plus exactly
  one bounded real `build:core` node only when the policy binds
  `KUNGFU_BUILD_PROFILE=journal`. Concurrency is fixed to one. It emits
  deterministic started, terminal, timeout, and
  dependency-skip events and one rooted receipt. Replaying the same inputs
  returns the existing exact receipt without starting a process. It is not a
  scheduler, and it cannot mutate Work or Assignment authority.
  `./shifu core-production-subgraph:execute` is the additive adapter for the
  typed journal Core slice. It re-verifies the typed subgraph and plan, the
  current describe-only verification receipt, the projected execution graph,
  policy, source, toolchain, and live execution admission before delegating
  `dependency-bootstrap`, `native-build`, and `artifact-stage` serially to the
  existing Core build internals. Each internal handler requires the exact
  admitted node and policy bindings; later stages are dependency-skipped after
  failure, timeout, or cancellation. The public `./shifu build:core` argv and
  package scripts remain unchanged and authoritative, while removing this
  adapter restores the prior describe-only state without a cutover.
  `./shifu production-graph:build-result --execution-receipt RECEIPT
  --output-dir DIR [--expected-receipt-root ROOT]` deterministically settles
  one exact terminal local-execution receipt into a content-addressed
  build-result projection and settlement receipt. Successful node output roots
  become typed-position digests bound to their node evidence and exact run;
  partial output, failure, cancellation, skipped nodes, retained evidence,
  completeness, and next action remain explicit. This projection is not a
  Core Cut or Project Cut, Buildchain or KFD evidence, stored artifact,
  signature, publication decision, or Release Cut. Those authorities must
  independently consume and qualify the projection if it is useful to them.
  `./shifu production-graph:local-ci-parity run --lane protected-ci
  --output-dir DIR` runs one fixture-safe, conformance-admitted Production
  Graph slice in the additive Linux shadow job of the protected PR workflow.
  The retained artifact binds the exact source, contract, graph, plan,
  verification, admission, executor policy, node set, events, outputs, local
  execution receipt, and build-result roots. From the exact source, use
  `./shifu production-graph:local-ci-parity replay --artifact-dir CI_DIR
  --output-dir LOCAL_DIR` to execute the same slice locally and emit a rooted
  parity report. Only platform, architecture, and Node version are declared
  environment variance; every semantic-root difference blocks parity. The
  lane has read-only repository permission, uses synthetic conformance
  evidence that grants no real Work authority, and cannot approve, merge,
  publish, release, or weaken another check.
  `./shifu build:core:graph-shadow` is an additive comparison route. After the
  same exact admission is reverified, it runs the unchanged
  `./shifu build:core` command once as the authoritative lane and once through
  the admitted one-node local executor, both with the bounded `journal`
  profile. Its rooted receipt retains exact command, environment, stdout,
  stderr, exit, event, failure, local receipt, and evidence roots and classifies
  every compared dimension as parity, explainable nondeterminism, authority or
  source drift, executor drift, or blocker. It does not cut over or modify the
  authoritative `build:core` route.
  The additive `./shifu core:affected:graph-shadow` route is the first bounded
  external consumer. It requires an exact graph, compiled plan,
  `./shifu production-graph:verify` receipt, execution-admission request, and
  matching admitted decision. Immediately before spawn it re-verifies the full
  request, exact decision, source, roots, node set, and live expiry; only then
  does it admit one dependency-free `core:affected` node with the Core native
  qualification authority and delegate to the unchanged `core:affected`
  command.
  Shadow events and receipts bind the current plan, toolchain, raw current
  receipt, exit status, and parity result under the operating system temporary
  root. Nonzero exits and cancellation remain non-qualifying. Removing or
  disabling this route leaves the independently authoritative
  `./shifu core:affected` path unchanged.
  `./shifu production-graph:feedback --graph GRAPH --plan PLAN
  --shadow-receipt RECEIPT [--json]` reads those bounded artifacts without
  executing recovery. Human and JSON modes expose the same source, authority,
  Xinfa selection, node, event, output, receipt, parity, failure owner,
  retained-evidence, and next-action facts while omitting receipt bodies. Its
  one decision is `complete`, `inspect`, `resume-eligible`,
  `restart-required`, or `blocked-by-drift`; source, graph, project-authority,
  selection, plan, toolchain, and retained-output drift always fail closed.
  Exit `0` means complete, `1` means a bounded human action is required, `2`
  means drift blocks recovery, and `3` means the command or input is invalid.
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

## Qualified Assignment Core artifacts

A reusable native Core payload is authoritative only as the composition of
four content-addressed objects: its manifest, payload entry set, qualification
receipt, and one current promotion-authority receipt. The manifest binds the
producer repository, commit and source tree; the intended target revision; all
native inputs; operating system, architecture and Python ABI; build profile,
toolchain and dependency locks; and exact Shifu and Buildchain contract
versions and roots. Roots use UTF-8 JSON with recursively sorted object keys,
preserved array order, `JSON.stringify` scalar encoding, and no insignificant
whitespace.

The production matrix contains exactly three isolated CPython 3.13 rows:
macOS ARM64, Linux x86_64, and Windows x86_64. Candidate and
promoted transport names bind both the exact source commit and row identity.
Each row has its own runner, build identity, payload closure, and single active
promotion authority. An absent row is reported as `unqualified`; another
platform's bytes can never substitute for it. Intel macOS (`darwin-x64`) is
explicitly unsupported and cannot select transport or source-build fallback.
The automatic checkout consumer admits all three declared rows and rejects
every other host as `unsupported-host`.

The consumer verifies every declared byte, mode, bounded POSIX path and safe
relative symlink while staging outside the target. It then verifies all current
target expectations and publishes by atomic replacement. A rejected, partial,
or unqualified payload is never runnable. The target checkout must be clean.
Exact mode requires the producer commit to equal the target commit. Explicit
equivalence keeps those identities distinct, requires an immutable equivalence
receipt root, and forbids rewriting producer metadata.

The boundaries are deliberately separate:

- Shifu defines schema, canonical roots, local verification, safe staging, and
  publication semantics.
- Buildchain supplies the exact build/toolchain/dependency identities and
  delivery evidence; it does not reinterpret Shifu roots.
- Assignment supplies the requested producer and target context; it does not
  make payload bytes qualified by naming them.
- CAS retains bytes by verified content root. A CAS hit is storage evidence,
  not qualification or promotion authority.
- Qualification receipts prove the declared checks for one exact manifest and
  payload. A receipt cannot select itself for reuse.
- The single active protected-development promotion receipt selects the one
  currently admissible candidate. Stale, missing, or ambiguous authority fails
  closed.
- GitHub Actions cache and workflow artifacts are replaceable transport only.
  A cache miss, eviction, or rejected candidate falls back to a current-source
  build and cannot affect merge correctness.

The consumer may use
`KUNGFU_QUALIFIED_CORE_HTTP_BASE_URL=http://cache.example/` to fetch the exact
artifact bytes from a closer HTTP cache after GitHub has supplied and validated
the unique artifact, successful protected-branch workflow run, source commit,
and workflow path. The HTTP endpoint never grants qualification or promotion
authority. Failed HTTP transport falls back to GitHub transport; all downloaded
bytes still pass the same manifest, receipt, payload, compatibility, and
promotion verification.

Interrupted HTTP bytes live only under the local cache's artifact-identity-bound
`transfers/` root. A retry resumes only when the server returns the exact
`Content-Range`; a server that ignores Range causes a verified restart from
byte zero. No partial is published as a runnable Core. Successful or rejected
verification removes the completed transfer staging root. Usage observations
attribute `discovery`, `transfer`, `verification`, `retention`, and
`publication` separately while preserving the earlier aggregate phase names
for existing readers.

The reference harness runs three independent cold CAS/checkouts followed by
three fresh checkouts against one retained verified CAS object:

```sh
node tests/qualification/qualified-assignment-core/cold-path-benchmark.mjs \
  --source-repository /path/to/kungfu \
  --commit <qualified-commit> \
  --http-base-url http://cache.example/ \
  --output /tmp/qualified-core-cold-path.json
```

`scripts/check-shifu-cache-contract.mjs` exports the contract verifier used by
the conformance fixtures. It rejects unsupported or unknown fields, byte and
metadata tamper, traversal, escaping symlinks, platform/ABI and build identity
drift, dirty targets, and stale or ambiguous promotion authority.

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
