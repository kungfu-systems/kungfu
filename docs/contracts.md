# Contracts — what kungfu actually guarantees

What you can rely on, stated as contracts you can verify, with each one's current
maturity. This is a *verify*-plane document: every entry says **what is
guaranteed → where to verify it → how mature the guarantee is**. For what is
*not* yet guaranteed, see [`known-limits.md`](known-limits.md); for the data
model these contracts are about, see [`event-model.md`](event-model.md).

## Frame publication is tear-free (single-writer / multi-reader)

**Guarantee.** A reader never observes a frame before its payload is fully
written — no torn or stale frames — on both strong-memory (x86) and weak-memory
(ARM / Apple Silicon) targets. The writer publishes the `length` token last with
a release store; readers gate on it with an acquire load before reading the
payload.

**Verify.** Two things you can check in this repository: the implementation in
[`frame.h`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h)
(`publish_data_length()` release / `acquire_length()` acquire) and
[`writer.cpp`](../framework/core/src/libyijinjing/src/journal/writer.cpp); and
the decision plus reported stress-test results in
[ADR-0001](./adr/ADR-0001-yijinjing-publish-barrier.md)
(0 tears across hundreds of millions of reads on arm64 and x86). Note: the
standalone stress harness that produced those numbers is not shipped in this
repository — you can read the implementation and the reported results, but
re-running that specific proof from the repo alone is not currently possible.

**Maturity.** `stable` — implemented, and stress-validated on both architectures
per the results reported in ADR-0001.

## The yijinjing schema layout is the cross-language / on-disk contract

**Guarantee.** The same in-memory bytes are read by C++, Python, and Node without
parsing, and the same bytes are what is persisted to the journal. The layout
*is* the ABI: a consumer speaks a layout, it does not negotiate one. The closed
runtime schema is declared in
[`kungfu/yijinjing/schema`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/schema)
and exposed through generated C++/Python/Node bindings, not a C++-internal
secret.

**Verify.** The schema headers under
[`kungfu/yijinjing/schema`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/schema),
the Python binding under `pykungfu.yijinjing`, the Node binding exposed as
`binding.Schema`, and [ADR-0008](./adr/ADR-0008-yijinjing-schema-layout-baseline.md).

**Maturity.** The v4 greenfield baseline is `stable` as the current contract
root. Pre-v4 layouts are not compatibility targets. The **enforcement** that
will let external consumers rely on a stated v4+ compatibility window (schema
change gates, runtime/schema load checks, cross-version replay/import tests) is
**not yet built** — see [`known-limits.md`](known-limits.md#v4-schema-compatibility-enforcement-is-designed-not-yet-complete).
Until then: verify against the current v4 layout and treat breaking pre-release
schema cleanup as allowed only before the first stable v4 release.

## Replay runs on the same runtime as live

**Guarantee.** Recorded journals are re-read on the *same* runtime and the *same*
semantics as live — there is no separate replay engine. Combined with the
nanosecond `gen_time` and the `trigger_frame_uid` causal links in each frame
(see [`event-model.md`](event-model.md)), a recorded stream reproduces with high
precision.

**Verify.** [`replay_writer.cpp`](../framework/core/src/libkungfu/src/runtime/journal/replay_writer.cpp)
and the shared journal runtime under
[`runtime/`](../framework/core/src/libkungfu/src/runtime).

**Maturity.** `stable` for the mechanism (same-runtime replay). The precise
determinism boundary — what is and is not reproducible across machines and
runtime versions — is not yet written as a tested baseline; treat cross-version /
cross-machine bit-exactness as unverified until then
(see [`known-limits.md`](known-limits.md)).

## The config contract is a single source of truth

**Guarantee.** Kungfu global config has one contract source for schema,
defaults, and resolution rules:
[`kungfu-config.contract.json`](../framework/config/kungfu-config.contract.json).
Python, Node, and the frozen product read that contract rather than carrying
separate defaults. Resolved config output reports the contract hash so users,
agents, and release gates can identify the exact contract world.
The contract also carries `contractSchema`, so resolution rules and required
metadata are schema-validated before defaults or user overrides are accepted.

**Verify.** Run:

```sh
kungfu config contract --json
kungfu config schema --json
kungfu config defaults --json
kungfu config show --json
./shifu verify
```

`verify` checks that the frozen artifact copy under
`framework/core/dist/kungfu/config/` has the same SHA-256 as the repo contract,
then confirms the frozen runtime reports that same hash through
`kungfu config show --json`.
The living welded-surface register is [`versioning.md`](versioning.md), surface
`config-contract`.

**Maturity.** `draft` while the GUI preference surface is still being wired.
The contract source, runtime loader, and artifact hash gate are intended to be
stable before GUI modules consume config.

## The kfx contract is a single source of truth

**Guarantee.** KFX package manifests (`package.json.kungfuConfig`),
first-party trust manifests, discovery defaults, and build-facet compatibility
rules have one machine-readable contract source:
[`kungfu-kfx.contract.json`](../framework/kfx/kungfu-kfx.contract.json).
Node hosts (`@kungfu-tech/kfx`, GUI, TUI, first-party manifest generation), the
Python CLI (`kungfu kfx`), Skill dependency binding, and frozen products read
that contract rather than carrying separate manifest shapes. The same source
owns `profileSuiteSchema`: KFX Suites may bind a
`kungfu.profile-suite/v1` semantic closure without introducing another schema
or trust authority. Libkungfu embeds this exact document at build time, records
its canonical root in Profile closure/lifecycle evidence, and evaluates
`profileSuiteSchema` before lifecycle normalization.

The contract carries `contractSchema`, `packageManifestSchema`,
`profileSuiteSchema`, and `firstPartyManifestSchema`. A package can still use
current compatibility surfaces such as `kungfuBuild.python` or a package-root
`CMakeLists.txt`, but the accepted manifest envelope and kind classification
are described by this contract, not by ad hoc consumers.

**Verify.** Run:

```sh
kungfu kfx contract --json
kungfu kfx schema --json
kungfu kfx profile-schema --json
kungfu kfx inspect <package-dir-or-tgz> --json
./shifu verify
```

`verify` checks that the frozen artifact copy under
`framework/core/dist/kungfu/config/` has the same SHA-256 as the repo contract,
then confirms the frozen runtime reports the same hash through
`kungfu kfx contract --json`.
The living welded-surface register is [`versioning.md`](versioning.md), surface
`kfx-contract`.

**Maturity.** `draft` while the service facet continues to harden. The
manifest schema, shared loaders, Python/Node validation, and artifact hash gate
are intended to be stable before published third-party packages bind to the
surface.

## The KFD-1 contract registry is the packaging source of truth

**Guarantee.** Registered machine-readable contracts are indexed by
[`kungfu-contracts.registry.json`](../framework/contract/kungfu-contracts.registry.json).
Build, freeze, and verify use that registry rather than separate hard-coded
contract lists. The frozen runtime ships the registry under
`dist/kungfu/config/kungfu-contracts.registry.json` next to each registered
contract artifact, so agents and release gates can ask one local entrypoint
which KFD-1 contract world they are in.

The registry also points to the agent-first canonical policy:
[`kungfu-agent-first-canonical-policy.json`](../framework/contract/kungfu-agent-first-canonical-policy.json).
That file is generated by the SDK from the registry, KFD metadata
(`@kungfu-tech/kfd`), and Buildchain release-gate metadata
(`@kungfu-tech/buildchain`). It records the upstream KFD package version,
Buildchain JSON formatting policy, the contract-world digest, the source
recipes, and the frozen artifact paths. The standard key, schema ids, and JSON
formatting policy are not local Kungfu constants.

**Verify.** Run:

```sh
kungfu contract list --json
kungfu contract show config --json
kungfu contract show kfx --json
kungfu contract show skill --json
kungfu contract verify --json
kungfu sdk contract policy --check --json
kungfu sdk contract witness --json
kungfu sdk contract audit --json
./shifu verify
```

`verify` walks the same registry and compares every shipped contract artifact
with its source hash. Adding a KFD-1 surface means adding it to the registry,
not adding another private copy loop in a build script. Release workflows pass
the SDK witness to Buildchain as declarative input, for example:

```sh
mkdir -p .buildchain/kfd-1
kungfu sdk contract witness --json > .buildchain/kfd/kfd-1/contract-world.witness.json
buildchain collect github-release \
  --kfd-1-witness-json .buildchain/kfd/kfd-1/contract-world.witness.json
```

Buildchain then freezes the pre-build witness and independently checks the
post-build artifact bytes before writing the KFD-provided top-level passport key
currently named `kfd-1`.

**Maturity.** `draft` while more welded surfaces move onto machine-readable
contracts. The registry/tooling path is intended to be the stable KFD-1
infrastructure before third-party contract surfaces are published.

## KFD-2 release claims use the Buildchain product registry contract

**Guarantee.** Public KFD-2 release trust claims are declared in one tracked
registry:
[`registry.json`](../.buildchain/kfd/kfd-2/registry.json).
The registry binds each claim to source files, machine-readable evidence,
artifact coordinates, a local verification command, audit boundary,
responsibility state, and residual risk. Kungfu owns those product facts;
Buildchain owns the generic registry validation and deterministic projection
mechanism. The other files under `.buildchain/kfd/kfd-2/` are generated release
inputs, not a second source of truth.

**Verify.** Run:

```sh
pnpm run kfd2:claims:check
pnpm run kfd2:claims
```

`product-claims check` validates the registry and fails on missing, stale, or
unexpected generated claim files without writing. `product-claims write` emits
the KFD canonical wrapper at `.buildchain/kfd/kfd-2/release-claims.json`, raw
claim files under `.buildchain/kfd/kfd-2/claims/`, and the release-passport
argument list. Release collection continues to pass the raw files through
Buildchain's compatible `--kfd-2-claim-json` input.

**Maturity.** `draft`. The first claim set covers the agent onboarding pack,
Codex report receipts, and the remote fact boundary. The release workflow now
generates these files through Buildchain before release-passport collection and
passes the raw claim inputs to the release gate.

## Buildchain KFD release evidence is generated from Kungfu facts

**Guarantee.** Kungfu exposes one root command set for Buildchain KFD release
passport inputs:

```sh
kungfu kfd query --json
kungfu kfd upstream --json
kungfu kfd aggregate --json
kungfu sdk kfd query --json
kungfu sdk kfd upstream --json
kungfu sdk kfd aggregate --json
./shifu kfd:buildchain
./shifu kfd:buildchain:check
./shifu kfd:query
node scripts/buildchain-kfd-evidence.mjs --artifact-witness --json
```

`kungfu kfd ...` is the installed-runtime bridge for users and agents;
`kungfu sdk kfd ...` exposes the same SDK-distributed Buildchain bridge directly.
The `./shifu kfd:*` commands are the repository development and release
evidence generators. `query` reports Kungfu's own declared surfaces, while
`upstream` and `aggregate` expose the packaged KFD/libnode/Buildchain upstream
KFD aggregate.

During `./shifu product gui dev` and `./shifu product tui dev`, the
product wrapper exports `KUNGFU_SDK_ENTRY`, `KUNGFU_KFD3_REGISTRY`, and
`KUNGFU_KFD_UPSTREAM_AGGREGATE` for the launched dev process. This lets a local
dev run query the working tree's KFD facts through the normal `kungfu kfd`
bridge instead of waiting for a packaged release artifact.

The root [`.buildchain/kfd/kfd-3/surfaces.json`](../.buildchain/kfd/kfd-3/surfaces.json) file is the product's
Buildchain-managed KFD-3 registry and is the Buildchain-facing source of truth
for participant-facing surfaces. Kungfu-specific subregistries and entrypoint
lists, such as the installed agent registry, are inputs that must project into
that root registry through `./shifu kfd:buildchain:check`.

The generator keeps the root registry current, writes a packaged SDK copy at
`developer/sdk/kfd/kfd-3-surfaces.json`, writes the SDK-packaged upstream
aggregate at `developer/sdk/kfd/upstream-aggregate.json`, then writes ignored
release evidence under `.buildchain/`:

```text
.buildchain/kfd/kfd-1/contract-world.witness.json
.buildchain/kfd/kfd-2/claims/*.json
.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json
.buildchain/kfd/kfd-3/collaboration-interface.artifact.json
.buildchain/kfd/kfd-3/capability-query.json
```

The `.buildchain/` files are generated release evidence, not a second source of
truth. The strict registry audit verifies that the root registry uses
Buildchain's managed path and contract, declares `.buildchain/kfd/kfd-3/surfaces.json` as its
source of truth, carries per-surface declaration metadata, and includes every
agent registry plus SDK/product surface generated by Kungfu.

**Verify.** Run:

```sh
./shifu kfd:buildchain:check
./shifu verify
```

The release workflow runs `node scripts/buildchain-custom-publish-evidence.mjs`;
that script generates KFD evidence before writing custom publish evidence.
Buildchain 2.10 then collects:

- KFD-1 witness `.buildchain/kfd/kfd-1/contract-world.witness.json`;
- KFD-2 raw claims under `.buildchain/kfd/kfd-2/claims/`;
- KFD-3 prebuild witness `.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json`;
- KFD-3 artifact witness from
  `node scripts/buildchain-kfd-evidence.mjs --artifact-witness --json`.

**Maturity.** `draft` for the breadth of the declared interface, because the
current surface set is agent/SDK/product focused. The Buildchain release
passport wiring is active and is now part of `./shifu verify`.

## The agent-first bridge is Kungfu's current KFD-3 profile

**Guarantee.** The installed runtime carries a local Agent Onboarding Pack and
machine-readable commands that let an agent start from a minimal artifact-local
entrypoint instead of guessing from external notes:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
```

This is Kungfu's current concrete profile of KFD-3: cooperation starts from
transparent value and constraints. KFD-3 itself is not agent-only; the general
participant-facing schema belongs in the KFD repository as a collaboration
interface. Kungfu's first profile is agent-first because agents are the current
non-human collaborators that need local discovery, mode choice, safety
boundaries, and receipt/closeout instructions.

The target implementation is a closed participant-facing API surface:

- one Kungfu-owned registry declares public-agent, public-human, experimental,
  deprecated, internal, and unsupported entrypoints;
- CLI/help/docs/skills/JSON command catalogs are generated from that registry
  or explicitly anchored to it in implementation code;
- Markdown operation manuals are generated or linted against the same registry;
- reverse audit enumerates the shipped command tree and fails if a reachable
  entrypoint is not classified;
- `kungfu agent verify --json` proves the installed artifact can expose the
  same first-party facts it asks agents to use.

In other words, KFD-3 is not satisfied by "there is documentation." It requires
proof that the artifact's participant-facing API is discoverable, constraint
transparent, and closed against hidden usable APIs.

**Verify today.** Run:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
node scripts/verify-agent-pack.mjs
```

`verify-agent-pack` is the current packaging gate: it checks the installed pack
files, command catalog, provider skills, package data, and GUI/TUI pointers.
The planned KFD-3 closure gate should extend this into registry/code-anchor
verification, Markdown reference linting, and Buildchain witness generation.

**Maturity.** `draft`. The installed pack and packaging check exist. The
single-source registry, CLI anchors, reverse command-tree audit,
`kungfu agent verify --json`, docs projection checks, and Buildchain KFD-3
witness remain future implementation work. See
[`kfd-native-sdk-release-gates.md`](kfd-native-sdk-release-gates.md).

## The Skill contract is a single source of truth

**Guarantee.** Kungfu Skill source metadata, compact catalogs, context
envelopes, kfx dependency binding, and manager documents are governed by
[`kungfu-skill.contract.json`](../framework/skill/kungfu-skill.contract.json).
The contract names the schema files under `framework/skill/schema/`; Python and
Node managers validate their generated outputs against those schemas. Frozen
products ship both the contract and its schema files from the contract registry.

**Verify.** Run:

```sh
kungfu skill contract --json
kungfu skill schema --json
kungfu skill validate <skill-dir> --json
kungfu skill context --path <skill-root> --json
./shifu verify
```

`verify` checks the frozen Skill contract artifact and smoke-tests that the
frozen runtime reports the same contract hash through
`kungfu skill contract --json`.
The living welded-surface register is [`versioning.md`](versioning.md), surface
`skill-contract`.

**Maturity.** `draft`. The first slice now has a contract wrapper, schema
bundle, Python/Node validators, frozen artifact hash gate, and CLI inspection.
Marketplace acquisition and permission elevation remain outside this contract.

## How to read a guarantee here

A contract is only as strong as its maturity tag. `stable` means implemented and
checkable today against the cited source. Anything weaker names exactly what is
missing and links to where it is tracked — so you can tell a guarantee you can
build on from an intention that is still being built, without reading the source
to find out.
