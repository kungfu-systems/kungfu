# Contracts — what kungfu actually guarantees

What you can rely on, stated as contracts you can verify, with each one's current
maturity. This is a *verify*-plane document: every entry says **what is
guaranteed → where to verify it → how mature the guarantee is**. For what is
*not* yet guaranteed, see [`known-limits.md`](known-limits.md); for the data
model these contracts are about, see [`event-model.md`](../architecture/event-model.md).

## Frame publication is tear-free (single-writer / multi-reader)

**Guarantee.** A reader never observes a frame before its payload is fully
written — no torn or stale frames — on both strong-memory (x86) and weak-memory
(ARM / Apple Silicon) targets. The writer publishes the `length` token last with
a release store; readers gate on it with an acquire load before reading the
payload.

**Verify.** Two things you can check in this repository: the implementation in
[`frame.h`](../../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h)
(`publish_data_length()` release / `acquire_length()` acquire) and
[`writer.cpp`](../../framework/core/src/libyijinjing/src/journal/writer.cpp); and
the decision plus reported stress-test results in
[ADR-0001](../adr/ADR-0001-yijinjing-publish-barrier.md)
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
[`kungfu/yijinjing/schema`](../../framework/core/src/libyijinjing/include/kungfu/yijinjing/schema)
and exposed through generated C++/Python/Node bindings, not a C++-internal
secret.

**Verify.** The schema headers under
[`kungfu/yijinjing/schema`](../../framework/core/src/libyijinjing/include/kungfu/yijinjing/schema),
the Python binding under `pykungfu.yijinjing`, the Node binding exposed as
`binding.Schema`, and [ADR-0008](../adr/ADR-0008-yijinjing-schema-layout-baseline.md).

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
(see [`event-model.md`](../architecture/event-model.md)), a recorded stream reproduces with high
precision.

**Verify.** [`replay_writer.cpp`](../../framework/core/src/libkungfu/src/runtime/journal/replay_writer.cpp)
and the shared journal runtime under
[`runtime/`](../../framework/core/src/libkungfu/src/runtime).

**Maturity.** `stable` for the mechanism (same-runtime replay). The precise
determinism boundary — what is and is not reproducible across machines and
runtime versions — is not yet written as a tested baseline; treat cross-version /
cross-machine bit-exactness as unverified until then
(see [`known-limits.md`](known-limits.md)).

## The config contract is a single source of truth

**Guarantee.** Kungfu global config has one contract source for schema,
defaults, and resolution rules:
[`kungfu-config.contract.json`](../../framework/config/kungfu-config.contract.json).
Python, Node, and the frozen product read that contract rather than carrying
separate defaults. Resolved config output reports the contract hash so users,
agents, and release gates can identify the exact contract world.
The contract also carries `contractSchema`, so resolution rules and required
metadata are schema-validated before defaults or user overrides are accepted.
Its `storage.durability` section is the KFD-1 requested-policy surface. The
canonical `storageDurability` digest is shared by Python and Node, while the
native state service independently re-derives admission and reports the
effective policy. Configuration cannot manufacture qualification, power-loss
evidence, or production eligibility; unsupported strong requests fail closed.

**Verify.** Run:

```sh
kungfu config contract --json
kungfu config schema --json
kungfu config defaults --json
kungfu config show --json
kungfu config durability --json
./shifu verify
```

`verify` checks that the frozen artifact copy under
`framework/core/dist/kungfu/config/` has the same SHA-256 as the repo contract,
then confirms the frozen runtime reports that same hash through
`kungfu config show --json`.
The living welded-surface register is [`versioning.md`](../development/versioning.md), surface
`config-contract`.

**Maturity.** `draft` while the GUI preference surface is still being wired.
The contract source, runtime loader, and artifact hash gate are intended to be
stable before GUI modules consume config.

## The kfx contract is a single source of truth

**Guarantee.** KFX package manifests (`package.json.kungfuConfig`),
first-party trust manifests, discovery defaults, and build-facet compatibility
rules have one machine-readable contract source:
[`kungfu-kfx.contract.json`](../../framework/kfx/kungfu-kfx.contract.json).
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
The living welded-surface register is [`versioning.md`](../development/versioning.md), surface
`kfx-contract`.

**Maturity.** `draft` while the service facet continues to harden. The
manifest schema, shared loaders, Python/Node validation, and artifact hash gate
are intended to be stable before published third-party packages bind to the
surface.

## Runtime activation is capability-driven and cut-bound

**Guarantee.** Runtime consumers classify an operation as storage-only,
live-optional, or live-required and use one topology-neutral requirement,
handle, readiness, generation, lease, receipt, and error vocabulary. A ready
handle binds a verified durable cut; process, route, service-install, and GUI
facts remain diagnostics. Live-required fails closed, and storage-only does not
activate a host as a side effect.

**Verify.** Inspect
[kungfu-runtime.contract.json](../../framework/runtime/kungfu-runtime.contract.json)
and [ADR-0080](../adr/ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
then run:

    kungfu contract show runtime --json
    ./shifu check:source

The source gate validates four positive contract cases and rejects PID-as-
readiness, dual active generations, ready without a cut, authority broadening,
GUI-only activation, and silent live-required downgrade.

**Maturity.** Qualified for the named current-platform process-host envelope;
not a universal host or platform claim. The contract, registry integration,
fixtures, source gate,
ProcessRuntimeHost placement adapter, directly callable CoordinatorEngine
no-fork seam, contract-owned operation registry, and RuntimeCapabilityBroker
atomic invocation seam are implemented. Storage-only qualification proves that
no activation client is constructed; live-required qualification proves that a
callback is not accepted without an exact semantic ready receipt. Four-process
first-call qualification proves one host activation and one accepted
generation; replacement diagnostics advance the generation, while native
durability/projection evidence behind the requested cut fails closed. Lease and
restart lifecycle qualification now covers deterministic acquire/renew/release
and expiry, capability non-broadening, atomic idle-drain fencing, exact-
generation plus process-start supervisor adoption, fail-closed preservation of
unowned or PID-reused processes, 100-round on-demand supervisor route cleanup,
and a bounded crash restart window using
[`runtime-lease-recovery`](../../tests/fixtures/runtime-lease-recovery). The
route heartbeat TTL remains diagnostic and does not satisfy the semantic lease
contract. The language/product projection and retained product qualification
are defined by
[Runtime activation and product delivery](runtime-activation-and-product-delivery.md).
Native readiness coordinates are published only after the existing authorities
establish the exact cut and are revalidated again when consumed. Cross-machine
leases, distributed election, high availability, other unexecuted platforms,
and EmbeddedRuntimeHost remain explicit non-claims.

## Agent session control has one PTY owner and one interaction port

**Guarantee.** A live `SessionAttempt` has exactly one generation-fenced
`AgentSessionCapsule` as its PTY-master owner. CLI, GUI, and KFX/Agent clients
share the same plan, action, status, and receipt schemas; only the current
controller lease may write. Coordinator restart does not reset the session
stream epoch, duplicate `inputId` cannot produce a second write, and bounded
output loss is returned as an explicit gap with a recovery snapshot.

A delivery receipt proves only that validated input was written to the PTY. It
does not prove provider understanding, semantic outcome, work progress, or
closeout. Those claims remain under provider structured events and
Profile/KFD/Episode authority. Provider exit closes input admission so queued
text cannot fall through into a shell.

**Verify.** Inspect
[kungfu-agent-session.contract.json](../../framework/agent-session/kungfu-agent-session.contract.json)
and
[ADR-0081](../adr/ADR-0081-durable-agent-session-capsule-control-plane.md),
then run:

    kungfu contract show agent-session --json
    ./shifu test:agent-session-contract
    ./shifu test:agent-session-capsule-host
    ./shifu test:agent-session-peer-transport
    ./shifu build:core
    ./shifu test:agent-session-peer-transport:native
    ./shifu test:agent-session-interaction-adapters
    ./shifu test:agent-session-interaction-adapters:native
    ./shifu check:source

The fixture gate accepts seven canonical plan/status/receipt cases and rejects
dual Capsule ownership, stale controller lease, wrong stream epoch, duplicate
input write, blind instruction in unknown modal state, provider-exit shell
fallthrough, silent replay gaps, and terminal delivery promoted to work proof.

**Maturity.** Partial. The registered contract, schemas, canonical policy,
fixtures, source gate, independent synthetic Capsule PTY host, and injectable
journal/notice transport authority state machine are implemented. The host
proves direct executable/argv spawn, exact process fencing, bounded replay with
explicit gaps, text-grid VT snapshots, client-loss reattachment, input closure
on provider exit, and delivery/lifecycle proof boundaries. The transport tests
prove multi-reader cursors, one-controller arbitration, input dedup, explicit
takeover, Coordinator re-registration, exact-identity Supervisor adoption,
bounded slow-reader recovery, resize coalescing, and no writer fanout by reader
count. The native ADR-0077 adapter is also implemented and qualified with a
real Coordinator plus separate writer and reader Watcher processes: action
envelopes traverse the writer's public mmap journal, the existing nng notice
wakes the reader, and the Coordinator does not proxy payload bytes. Provider
adapters now implement versioned redacted state classification,
when-ready/queue/interrupt policy, atomic bracketed paste, manual-only keys,
provider-exit closure, opaque-shell fallback, and delivery/outcome separation.
Local no-private-state version probes match Codex `0.144.3` and Claude Code
`2.1.209`; they do not prove authenticated interaction, approval outcome, or
provider semantic response. Product surfaces, machine restart, and real
Codex/Claude dogfood remain staged; this contract does not claim those behaviors
already exist.

## The KFD-1 contract registry is the packaging source of truth

**Guarantee.** Registered machine-readable contracts are indexed by
[`kungfu-contracts.registry.json`](../../framework/contract/kungfu-contracts.registry.json).
Build, freeze, and verify use that registry rather than separate hard-coded
contract lists. The frozen runtime ships the registry under
`dist/kungfu/config/kungfu-contracts.registry.json` next to each registered
contract artifact, so agents and release gates can ask one local entrypoint
which KFD-1 contract world they are in.

The registry also points to the agent-first canonical policy:
[`kungfu-agent-first-canonical-policy.json`](../../framework/contract/kungfu-agent-first-canonical-policy.json).
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

## Exit Bundle composition is one registered vocabulary, not another fact authority

**Guarantee.** The registered
[`kungfu-exit-bundle.contract.json`](../../framework/exit/kungfu-exit-bundle.contract.json)
defines the top-level scope, member-root, full/thin closure, omission/loss,
compatibility, equivalence, and verification vocabulary for bounded exit
artifacts. Fact, Episode, Fact Library, Mission, Profile, source-export, and
recovery-backup contracts retain their own roots, material semantics, import
rules, and receipts.

**Verify.** Run:

```sh
./shifu check:exit-bundle-contract
kungfu contract show exit-bundle --json
```

The gate validates the embedded schemas, the positive/negative corpus, the
machine inventory against live source authorities, KFD-1 packaging
registration, and known ADR/schema metadata drift. A thin artifact can expose
only inventory inspection; it cannot claim materialization, projection rebuild,
continuation, or capability equivalence.

The same authority also carries the public version-support policy. Qualified
stable releases on one `major.minor` line preserve registered authoritative
semantics; pre-release builds remain exact-evidence-only, and cross-minor
support requires a declared historical reader or qualified migration. Inspect
the policy shipped with an artifact using:

```sh
kungfu exit verify --info --json
```

**Maturity.** Composition and the installed registry-free verifier are
implemented. One exact `darwin-arm64` official CLI artifact has retained
clean-runtime Exit and File↔RocksDB provider-migration qualification. The
current v4 line is still pre-release and not release-qualified; Linux, Windows,
GUI/TUI parity, cross-machine migration, physical-media durability, and the
stable cross-minor support window remain unqualified or undecided. See
[Exit, Migration, and Version Compatibility](../guides/exit-and-version-compatibility.md).

## KFD-2 release claims use the Buildchain product registry contract

**Guarantee.** Public KFD-2 release trust claims are declared in one tracked
registry:
[`registry.json`](../../.buildchain/kfd/kfd-2/registry.json).
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

The root [`.buildchain/kfd/kfd-3/surfaces.json`](../../.buildchain/kfd/kfd-3/surfaces.json) file is the product's
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

## Shifu asks Buildchain for its KFD-3 layout — two welded seams

**Guarantee.** Shifu holds no copy of where a repository's KFD-3 surface
registry lives. The location is Buildchain's to define, and shifu obtains it by
asking the repo-pinned `buildchain` binary at runtime, not by embedding a path.
Shifu's compiled knowledge of Buildchain is exactly two seams: the pin file name
`.buildchain-version` and the self-describe verb `buildchain layout --json`
(contract `kungfu-buildchain-layout-discovery`), from which shifu reads
`kfd.registries."kfd-3".path`. Changing either seam — the pin name, the verb, or
that contract's shape — is a breaking change and follows Buildchain's
major-version discipline. On this basis a buildchain-managed repository can join
shifu's management by declaring `distribution.registrar = "shifu"` in that
registry, with no in-repo executables added.

**Verify.** The consumer is `resolve_kfd3_registry` and `declares_shifu_jurisdiction`
in [`crates/shifu/src/registrar.rs`](../../crates/shifu/src/registrar.rs) and the
two-level `find_repo_root` in
[`crates/shifu/src/main.rs`](../../crates/shifu/src/main.rs); the producer is
`buildchain layout --json` (Buildchain `packages/core/buildchain-layout.js`). The
decision and its boundaries are
[SHIFU-ADR-0005](../adr/SHIFU-ADR-0005-repo-root-discovery-and-jurisdiction.md);
the narrative is in [`rust-adoption.md`](../development/rust-adoption.md). Shifu reads the
registry's own `registryPath` self-attestation back and warns on drift.

**Maturity.** `development` — implemented in the launcher and unit-tested, with
the discovery path exercised end to end against the pinned Buildchain binary; the
downstream-repo onboarding surface is still maturing.

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
[`kungfu-skill.contract.json`](../../framework/skill/kungfu-skill.contract.json).
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
The living welded-surface register is [`versioning.md`](../development/versioning.md), surface
`skill-contract`.

**Maturity.** `draft`. The first slice now has a contract wrapper, schema
bundle, Python/Node validators, frozen artifact hash gate, and CLI inspection.
Marketplace acquisition and permission elevation remain outside this contract.

## First real release carries the mark on acquisition and product surfaces

**Guarantee.** Kungfu does not claim released-software use while v4 remains
Coming Soon. A future claim must bind the exact **Kungfu UNGFU™** mark to both a
real public download or package-install path and at least one stable
product-controlled surface. Source checkouts, previews, and staging do not
satisfy the acquisition requirement.

**Verify.** Read [Trademark public-use qualification](trademark-public-use.md)
and
[`kungfu-trademark-public-use.contract.json`](../../framework/release/kungfu-trademark-public-use.contract.json),
then run:

```sh
node scripts/check-trademark-public-use.mjs
node --test scripts/check-trademark-public-use.test.mjs
```

The negative fixtures reject the registered symbol, unsupported registration
claims, a replacement primary product name, missing exact-mark surfaces, and
preview or staging evidence presented as a real release. They also reject
technical-identifier renames, incomplete or non-public evidence coordinates,
future access dates, and acquisition/product evidence that does not bind one
exact release.

**Maturity.** The brand surfaces and release gate are implemented. Public
release artifacts, actual released-software use evidence, a first-use date, and
legal conclusions are not claimed.

## How to read a guarantee here

A contract is only as strong as its maturity tag. `stable` means implemented and
checkable today against the cited source. Anything weaker names exactly what is
missing and links to where it is tracked — so you can tell a guarantee you can
build on from an intention that is still being built, without reading the source
to find out.
