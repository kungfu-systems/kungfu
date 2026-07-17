# Kungfu Documentation

Kungfu is execution infrastructure for real-world agent work. Its flagship
object is the **Episode**: a bounded causal unit whose Facts, Artifacts,
Receipts, dependencies, and verification roots can be inspected, sealed,
exported, replayed, recovered, and used to support Decisions.

This page is the curated route through the documentation. It is intentionally
shorter than the exhaustive [Documentation Map](MAP.md): choose the route that
matches your job, then go deeper only when you need to.

## Browse by responsibility

| Section | What it owns |
| --- | --- |
| [Concepts](concepts/README.md) | Episode, vocabulary, principles, implementation concepts, and product layers |
| [Guides](guides/README.md) | task-oriented selection, operation, inspection, and extension |
| [Architecture](architecture/README.md) | current runtime, service, adapter, SDK, and extension structure |
| [Profiles](profiles/README.md) | concrete agent-work and application profiles above the neutral core |
| [Qualification](qualification/README.md) | guarantees, limits, retained evidence, and institutional adoption |
| [Development](development/README.md) | build, toolchain, versioning, release, and documentation governance |
| [Research](research/README.md) | measured options and spikes that inform, but do not replace, decisions |
| [Architecture Decisions](adr/README.md) | accepted and proposed load-bearing decisions with lifecycle evidence |
| [Shifu](shifu/README.md) | development entrypoint, cache profiles, artifacts, and Gate contracts |

## Understand Kungfu

Read these in order for the product model:

1. [The Episode](concepts/the-episode.md) — why real-world work needs a stable object
   beyond a run, process, log, trace, workflow, or chat session.
2. [Facts Before Trust](concepts/facts-before-trust.md) — why evidence, responsibility,
   and local proof come before control decisions.
3. [Design Philosophy](concepts/design-philosophy.md) — the principles and trade-offs
   behind the architecture.
4. [Vocabulary Reference](concepts/vocabulary.md) — canonical definitions for Episode,
   Fact, Artifact, Receipt, Cut, Watermark, Projection, Timeline, Claim, Proof,
   TrustReport, Decision, Replay, Rewind, and Recovery.
5. [Known Limits](qualification/known-limits.md) — what is not yet implemented, qualified, or
   released.

The product model does not require understanding the name first. When you want
the deeper brand and architecture connection, read
[Why Kungfu?](concepts/why-kungfu.md).

Use [Implementation Concepts](concepts/implementation-concepts.md) when you need repository and runtime
names such as `kungfu`, `libkungfu`, `yijinjing`, `kfx`, Hana POD, and
FlatBuffers. Those terms describe the implementation; they do not replace the
public execution vocabulary.

## Try or operate Kungfu

- [Choose Your Kungfu](guides/choose-your-kungfu.md) — select the smallest complete
  product surface for your job.
- [Check Kungfu Health](guides/health.md) — run one read-only preflight across
  runtime, Peer, storage, and Episode state and get actionable problems.
- [Rewind an Episode](guides/rewind.md) — distinguish Rewind, Replay, Recovery, and
  explicit re-execution; use the current agent-work capture slice.
- [Configuration](guides/config.md) — understand workspace, user, and machine data
  homes.
- [Durability Configuration](guides/durability-configuration.md) — choose a
  requested persistence profile and understand admission, effects, costs,
  receipts, timeouts, and recovery.
- [Upgrade Kungfu](guides/upgrading.md) — check, download, install, defer,
  activate, recover, and retain versioned desktop/CLI runtime images safely.
- [Debugging](guides/debugging.md) — localize failures in the runtime and build.
- [Python Environments](guides/python-environments.md) — manage packages inside the
  assembled runtime.

The installed runtime is also self-describing through `kungfu agent brief`,
`kungfu agent capabilities --json`, and `kungfu agent choose-mode --json`.

## Embed or extend Kungfu

- [Architecture](architecture/overview.md) — runtime and repository layers.
- [Event Model](architecture/event-model.md) — journal, frames, schema ownership, and Replay.
- [Adapters](architecture/adapters.md) — C++, Python, Node, and framework boundaries.
- [Product Layers](concepts/product-layers.md) — independent adoption and qualification
  contracts.
- [Extensions](architecture/extensions.md) and [kfx Topology](architecture/kfx-topology.md) — package,
  trust, host, and capability boundaries.
- [KFX Profile Suite Lifecycle](profiles/profile-lifecycle.md) — content roots,
  append-only lifecycle facts, plans, authorization, receipts, and current
  product limits for user-defined domain Profiles.
- [Agent-first Profile Authoring](profiles/profile-authoring.md) — scaffold, build,
  compose, assess, export, import, and operate a user-specified KFD-1/KFD-2
  Profile without rebuilding Kungfu.
- [Kungfu Skills](architecture/skills.md) — the agent-facing capability layer above `kfx`.
- [Querying Runtime Facts](guides/querying-runtime-facts.md) — Cuts, lineage,
  historical queries, and proof-carrying results.
- [Bringing Domain Facts Into Kungfu](guides/fact-surface-admission.md) — declaration,
  admission, correction, and trust eligibility.

## Evaluate Kungfu for institutional use

Start with the decision document, then follow its evidence chain:

1. [Single-host Institutional Trust Profile](qualification/single-host-institutional-trust.md)
   — current adoption status, deployment envelope, evidence, controls, and
   operator responsibilities.
2. [Strong Durability and Crash Recovery](qualification/durability-and-crash-recovery.md) —
   the design, current stage, Receipts, Watermarks, and power-loss non-claims.
3. [Contracts](qualification/contracts.md) — verifiable guarantees and their maturity.
4. [Known Limits](qualification/known-limits.md) — unresolved qualification and release gaps.
5. [Single-host End-to-End Performance Qualification](qualification/single-host-performance-qualification.md)
   — the release gate that preserves visibility, durability, recovery, and
   meaning under load.
6. [Episode Atomicity Qualification](qualification/episode-atomicity-qualification.md) — the
   fault and load evidence contract for Episode closure.

Kungfu v4 currently supports engineering evaluation and controlled shadow use
for the institutional profile. The documentation does not turn an unqualified
design target into a production guarantee.

## Maintain or contribute to Kungfu

- [Contributing](../CONTRIBUTING.md) — build, style, tests, DCO, and pull
  requests.
- [Buildchain](development/buildchain.md) and [C++ Toolchain](development/cpp-toolchain.md) — source to
  binary and the native compiler contract.
- [Rust Adoption](development/rust-adoption.md) — where Rust is an option and where it is
  not the migration target.
- [Versioning](development/versioning.md) and
  [Version/Release Design](development/version-release-design.md) — welded surfaces,
  channel intent, and release mechanics.
- [Upgrade Compatibility Reference](development/upgrade-compatibility.md) — release
  identity, protocol/schema windows, Core plans, reason messages, and non-claims.
- [Shifu Documentation](shifu/README.md) — development/build execution and
  versioned cache contracts.
- [Document Metadata Contract](development/document-metadata.md) — reader-hidden public
  metadata, inline engineering evidence, lifecycle axes, and ADR projections.
- [Architecture decisions](adr/) — one canonical registry for load-bearing
  Kungfu and Shifu decisions.
- [Documentation Map](MAP.md) — the complete question and keyword index.

## Document roles and authority

| Role | Job | Examples |
| --- | --- | --- |
| overview | establish the product and route the reader | repository README, this guide |
| guide | help a reader complete a job | Choose Your Kungfu, Rewind, Config, Debugging |
| explanation | explain principles and boundaries | The Episode, Facts Before Trust, Why Kungfu, Design Philosophy |
| reference | define exact terms or surfaces | Vocabulary, Concepts, Event Model, Contracts |
| qualification | state evidence, profiles, and release gates | Known Limits, institutional trust, durability, performance, atomicity |
| decision | preserve load-bearing architecture choices | Core and Shifu ADRs |
| research | preserve measured options without becoming current guidance | embedding and host spike reports |

When two documents overlap, the role determines ownership: Vocabulary owns
public term definitions; Concepts owns implementation names; Event Model owns
journal and Replay mechanics; Contracts and Known Limits own guarantee
maturity; ADRs own why a load-bearing decision was made.

Mission, Go, Cost/State/Proof, and Mission Control belong to the current Agent
Work profile. They are important product-design terms, but they do not redefine
the domain-neutral Episode core. See [Domain Horizons](concepts/domain-horizons.md),
[Mission Control](profiles/mission-control.md), and
[Mission Control Workspace Design](profiles/mission-control-workspaces.md).

Spike reports such as the Rust host and embedding-membrane studies are retained
as research evidence. Read their resulting ADRs and current architecture docs
for operative guidance.

## Full index and maintenance boundary

Use [MAP.md](MAP.md) when you need every question, keyword, planned document,
or evidence route. The Map is optimized for lookup and audit, not for reading
from top to bottom.

Canonical documents live in the responsibility directories listed above.
`docs/README.md` and `docs/MAP.md` are the only Markdown files at the root.
Kungfu has not published a documentation compatibility contract, so former
flat paths are removed rather than retained as repository redirects.

Place a new document in the section that owns its long-term maintenance
question, add it to that section's `README.md`, and update this guide or the Map
only when the reader route changes. Do not add a new root-level canonical page.
Research belongs in `research/` until an ADR or current architecture document
adopts its result; profile-specific semantics belong in `profiles/`, not in the
domain-neutral concepts layer.

Repository validation makes this boundary executable. Run
`./shifu docs:check` for Markdown structure, every local target and cross-file
anchor, publication reachability, bounded executable examples, canonical
entrypoint pointers, and consistency between the public
Vocabulary reference and its machine-readable registry. Run
`./shifu docs:prose` to apply the generated Vale policy for canonical names,
retired positioning, preferred terms, and load-bearing guarantee language.
Objective prose errors block pull requests through `docs:prose:required`;
warning-level policy remains advisory until its false-positive behavior is
qualified. `docs.contract.json` owns the directory taxonomy, stable entry
files, publication topology, and executable examples;
[`document-metadata.contract.json`](document-metadata.contract.json) owns
metadata routing and ADR projections;
[`document-metadata.registry.json`](document-metadata.registry.json) keeps
public entry and guide metadata out of rendered pages, while
[`vocabulary.registry.json`](vocabulary.registry.json) owns executable language
policy; generated Vale files are disposable projections of that registry.
External URL health is deliberately separate because remote availability is
not a deterministic property of a commit; maintainers use
`./shifu docs:check:external`, backed by the scheduled Lychee workflow.
For a cold or read-only source checkout, `./shifu docs:check:readonly` keeps
lock-derived documentation modules in the user cache and verifies that the
source tree does not change. Immutable Action SHAs, the Vale container digest,
and audited release-archive checksums live in
[`toolchain.contract.json`](toolchain.contract.json).
