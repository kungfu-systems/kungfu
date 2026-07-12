# Kungfu Documentation

Kungfu is execution infrastructure for real-world agent work. Its flagship
object is the **Episode**: a bounded causal unit whose Facts, Artifacts,
Receipts, dependencies, and verification roots can be inspected, sealed,
exported, replayed, recovered, and used to support Decisions.

This page is the curated route through the documentation. It is intentionally
shorter than the exhaustive [Documentation Map](MAP.md): choose the route that
matches your job, then go deeper only when you need to.

## Understand Kungfu

Read these in order for the product model:

1. [The Episode](the-episode.md) — why real-world work needs a stable object
   beyond a run, process, log, trace, workflow, or chat session.
2. [Facts Before Trust](facts-before-trust.md) — why evidence, responsibility,
   and local proof come before control decisions.
3. [Design Philosophy](design-philosophy.md) — the principles and trade-offs
   behind the architecture.
4. [Vocabulary Reference](vocabulary.md) — canonical definitions for Episode,
   Fact, Artifact, Receipt, Cut, Watermark, Projection, Timeline, Claim, Proof,
   TrustReport, Decision, Replay, Rewind, and Recovery.
5. [Known Limits](known-limits.md) — what is not yet implemented, qualified, or
   released.

Use [Implementation Concepts](concepts.md) when you need repository and runtime
names such as `kungfu`, `libkungfu`, `yijinjing`, `kfx`, Hana POD, and
FlatBuffers. Those terms describe the implementation; they do not replace the
public execution vocabulary.

## Try or operate Kungfu

- [Choose Your Kungfu](choose-your-kungfu.md) — select the smallest complete
  product surface for your job.
- [Rewind an Episode](rewind.md) — distinguish Rewind, Replay, Recovery, and
  explicit re-execution; use the current agent-work capture slice.
- [Configuration](config.md) — understand workspace, user, and machine data
  homes.
- [Debugging](debugging.md) — localize failures in the runtime and build.
- [Python Environments](python-environments.md) — manage packages inside the
  assembled runtime.

The installed runtime is also self-describing through `kungfu agent brief`,
`kungfu agent capabilities --json`, and `kungfu agent choose-mode --json`.

## Embed or extend Kungfu

- [Architecture](architecture.md) — runtime and repository layers.
- [Event Model](event-model.md) — journal, frames, schema ownership, and Replay.
- [Adapters](adapters.md) — C++, Python, Node, and framework boundaries.
- [Product Layers](product-layers.md) — independent adoption and qualification
  contracts.
- [Extensions](extensions.md) and [kfx Topology](kfx-topology.md) — package,
  trust, host, and capability boundaries.
- [KFX Profile Suite Lifecycle](profile-lifecycle.md) — content roots,
  append-only lifecycle facts, plans, authorization, receipts, and current
  product limits for user-defined domain Profiles.
- [Kungfu Skills](skills.md) — the agent-facing capability layer above `kfx`.
- [Querying Runtime Facts](querying-runtime-facts.md) — Cuts, lineage,
  historical queries, and proof-carrying results.
- [Bringing Domain Facts Into Kungfu](fact-surface-admission.md) — declaration,
  admission, correction, and trust eligibility.

## Evaluate Kungfu for institutional use

Start with the decision document, then follow its evidence chain:

1. [Single-host Institutional Trust Profile](single-host-institutional-trust.md)
   — current adoption status, deployment envelope, evidence, controls, and
   operator responsibilities.
2. [Strong Durability and Crash Recovery](durability-and-crash-recovery.md) —
   the design, current stage, Receipts, Watermarks, and power-loss non-claims.
3. [Contracts](contracts.md) — verifiable guarantees and their maturity.
4. [Known Limits](known-limits.md) — unresolved qualification and release gaps.
5. [Single-host End-to-End Performance Qualification](single-host-performance-qualification.md)
   — the release gate that preserves visibility, durability, recovery, and
   meaning under load.
6. [Episode Atomicity Qualification](episode-atomicity-qualification.md) — the
   fault and load evidence contract for Episode closure.

Kungfu v4 currently supports engineering evaluation and controlled shadow use
for the institutional profile. The documentation does not turn an unqualified
design target into a production guarantee.

## Maintain or contribute to Kungfu

- [Contributing](../CONTRIBUTING.md) — build, style, tests, DCO, and pull
  requests.
- [Buildchain](buildchain.md) and [C++ Toolchain](cpp-toolchain.md) — source to
  binary and the native compiler contract.
- [Rust Adoption](rust-adoption.md) — where Rust is an option and where it is
  not the migration target.
- [Versioning](versioning.md) and
  [Version/Release Design](version-release-design.md) — welded surfaces,
  channel intent, and release mechanics.
- [Shifu Documentation](shifu/README.md) — development/build execution and
  versioned cache contracts.
- [Core ADRs](../framework/core/docs/adr/) — load-bearing decisions.
- [Documentation Map](MAP.md) — the complete question and keyword index.

## Document roles and authority

| Role | Job | Examples |
| --- | --- | --- |
| overview | establish the product and route the reader | repository README, this guide |
| guide | help a reader complete a job | Choose Your Kungfu, Rewind, Config, Debugging |
| explanation | explain principles and boundaries | The Episode, Facts Before Trust, Design Philosophy |
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
the domain-neutral Episode core. See [Domain Horizons](domain-horizons.md),
[Mission Control](mission-control.md), and
[Mission Control Workspace Design](mission-control-workspaces.md).

Spike reports such as the Rust host and embedding-membrane studies are retained
as research evidence. Read their resulting ADRs and current architecture docs
for operative guidance.

## Full index and maintenance boundary

Use [MAP.md](MAP.md) when you need every question, keyword, planned document,
or evidence route. The Map is optimized for lookup and audit, not for reading
from top to bottom.

Public document URLs remain stable in this documentation phase. Later physical
reorganization should happen only with automated link checking, a compatibility
path for existing URLs, and evidence that moving files improves discovery more
than this curated hierarchy already does. When adding or changing a public
claim, update its canonical document first, then this guide or the Map only if
the reader route changes.

Repository validation makes this boundary executable. Run
`./shifu docs:check` for Markdown structure, every local target and cross-file
anchor, publication reachability, bounded executable examples, canonical
entrypoint pointers, and consistency between the public
Vocabulary reference and its machine-readable registry. Run
`./shifu docs:prose` to apply the generated Vale policy for canonical names,
retired positioning, preferred terms, and load-bearing guarantee language.
Objective prose errors block pull requests through `docs:prose:required`;
warning-level policy remains advisory until its false-positive behavior is
qualified. `docs.contract.json` owns document topology, while
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
