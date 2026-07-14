---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0049
decision_status: accepted
implementation_status: implemented
review_state: legacy-unreviewed
sensitivity: public
implementation_commits: [360c1dfcaf12aa410158f22ff175e5c608b0a77a]
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/797]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/797
qualification_refs: [docs/qualification/layer-product-release-qualification.md, shifu.gates.json, tests/qualification/layers/run.mjs, tests/qualification/layers/release/run.mjs, tests/qualification/layers/surfaces/run.mjs, scripts/run-release-qualification.mjs]
---

# ADR-0049: every product layer is independently complete and the core remains domain-neutral

- Status: accepted; implemented
- Date: 2026-07-11
- Category: architecture — adoption closure, distribution boundaries, and
  domain neutrality
- Subsystem: `.kungfu` format, `libkungfu`, language SDKs, CLI/TUI, GUI,
  assembled distribution, release gates, and domain profiles
- Related: ADR-0009 defines load-bearing self-bootstrap; ADR-0011 defines the
  capability SDK contract; ADR-0035 defines workspace-local `.kungfu` data;
  ADR-0044 defines Shifu delegation; ADR-0046 defines the assembled runtime;
  ADR-0048 defines runtime-fact query semantics.

## Context

Kungfu deliberately carries substantial capability: a native journal and
storage substrate, polyglot bindings and runtimes, a host, CLI/TUI, Electron
GUI, extension system, build tooling, and assembled distributions. That breadth
is valuable only if users can adopt the smallest layer that closes their real
problem.

Otherwise the full product becomes the minimum installation and understanding
cost. A later product can then win by offering fewer capabilities behind a
smaller adoption closure, even if Kungfu's underlying mechanisms remain
stronger. This is a structural failure mode, not a packaging inconvenience.

The monorepo requirement preserves one contract and one discovery surface. It
must not be interpreted as a monolithic distribution requirement.

Kungfu also has evidence and plausible application horizons beyond its current
agent-runtime focus:

- quantitative trading engines are the historical proof of the journal,
  low-latency runtime, and polyglot membrane;
- accountable agent runtime is the current product and validation focus;
- games and virtual worlds are a future derivative horizon for causal
  timelines, checkpoints, replay, historical query, and fault reproduction.

If current product vocabulary enters the kernel as universal semantics, later
domains will require a rewrite or a competing core.

## Decision

Kungfu adopts **layer-complete products** and a **domain-neutral core** as root
architecture constraints.

```text
one authoritative repository
+ one semantic core
+ many independently complete adoption products
```

Higher layers add convenience and presentation. They do not acquire authority
that is unavailable through lower public contracts.

### 1. Each official layer closes a declared job

The official product layers are:

| Layer | Independent closure |
| --- | --- |
| `.kungfu` format and spec | portable, inspectable, verifiable fact artifact |
| `libkungfu` native core | own a `.kungfu` lifecycle: record, Episode, query, verify, export |
| language SDK package | perform the native-core closure idiomatically inside one language ecosystem |
| Kungfu CLI/TUI | complete headless host and human/agent/operator command surface |
| Kungfu GUI | complete human visual surface over public core/service contracts |
| assembled distribution | one-install convenience containing compatible official layers |

"Complete" means complete for the layer's declared job. It does not mean that
every layer duplicates every feature or user experience.

### 2. Dependencies point downward

- A lower layer must never require a higher layer to satisfy its contract.
- Sibling SDKs must not require one another.
- `libkungfu` must not require Python, Node, Rust host, Electron, a cloud
  account, or a database service to maintain a local `.kungfu` fact source.
- A language SDK may require its own language runtime and a compatible native
  core, but not another language SDK or the GUI.
- The CLI/TUI must remain usable without Electron.
- The GUI may use official SDK/service/CLI surfaces, but must not create a
  GUI-only authority, migration path, repair operation, or fact schema.

The full assembled runtime remains an important product. It is a convenience
closure for users who want everything, not the only valid way to use Kungfu.

### 3. Higher layers add convenience, never authority

Storage migration, `.kungfu` initialization, Episode identity, causality,
current/historical cuts, proof, fsck, and export semantics belong in the native
core and declared contracts.

GUI databases, CLI caches, SDK helper objects, and language-local types are
projections or adapters. A semantic operation offered by the GUI must have a
stable lower-level API or service expression. Visual composition itself may
remain GUI-specific.

### 4. Users pay only for the layer they use

Language runtimes, GUI frameworks, query accelerators, extension hosts, and
optional providers load only when their owning layer is selected.

Release artifacts must declare their dependency closure, installed size,
startup path, and capability set. A dependency that is merely "lazy" but still
forces every user to download and update the full assembled product does not
satisfy this decision.

### 5. Every layer must pass deletion and clean-environment tests

The release gates include:

```text
remove GUI       -> CLI, SDKs, libkungfu, and .kungfu remain usable
remove CLI       -> SDKs and libkungfu retain their declared closures
remove Python    -> Node, Rust, and native consumers remain usable
remove Node      -> Python, Rust, and native consumers remain usable
remove all language hosts -> libkungfu can record, query, verify, and export
```

Each official package also runs its own clean-environment qualification. The
assembled product must pass cross-layer compatibility, but it cannot substitute
for the independent qualifications.

### 6. One repository does not imply one artifact

The authoritative monorepo remains mandatory for schema, compatibility,
discovery, and release-gate coherence. It produces multiple independently
versioned or compatibility-locked artifacts from one source and one semantic
contract.

No satellite package may become a second authority. Ecosystem packages may
embed, download, or link a compatible native core according to their platform
conventions, but their generated bindings and capability manifests must trace
back to the same source contract.

### 7. The kernel remains neutral across application horizons

The core vocabulary is runtime facts, ordering, causality, Episodes, payload
commitments, schemas, cuts, queries, proof, and portability. Domain vocabulary
belongs in profiles, schemas, adapters, and reference applications.

In particular, core contracts must not require concepts such as:

- order, quote, account, or exchange from quantitative trading;
- prompt, token, model, agent, or tool call from agent runtime;
- entity, player, scene, physics body, or render frame from games and virtual
  worlds.

A domain may promote a mechanism into the core only when the promoted form is
expressed as a domain-neutral runtime-fact invariant and carries its general
compatibility cost explicitly.

The three horizons are architectural witnesses, not three simultaneous product
roadmaps. Agent runtime remains the current focus.

### 8. Layer qualification runs under a checked-in execution policy

Release qualification selects one checked-in execution profile rather than
embedding an implicit workload or timeout in CI. Each profile binds the
end-to-end wall-time budget, upstream build allowance, reserve, fuzz duration,
Episode workload, and timeout policy. The generated Gate receipt records the
selected profile, effective parameters, policy digest, and reuse tuple so a
passing result can be reproduced or rejected when its execution context drifts.

The default profiles distinguish fast alpha evidence, release-candidate
evidence, and the full patrol workload. Reducing the workload is allowed only
by selecting the declared profile; it does not silently weaken the canonical
full-patrol profile. A run that exceeds its selected end-to-end budget is
non-qualifying even when every individual semantic assertion passed.

## Qualification matrix

| Artifact | Minimum proof |
| --- | --- |
| format/spec | open, inspect, verify, and preserve declared unknowns without a GUI |
| libkungfu | create/open `.kungfu`; append and seal Episode; query head and historical cut; fsck; export, with no language host |
| PyPI/npm/Cargo SDK | install in a clean ecosystem environment and pass the shared semantic fixture without sibling SDKs |
| CLI/TUI | install a headless archive and complete init/record/query/verify/export plus agent discovery |
| GUI | complete human workflows through public contracts; uninstall without stranding or changing `.kungfu` |
| assembled distribution | prove exact component compatibility and preserve every lower-layer qualification |

Dependency, size, cold-start, and resident-memory budgets are recorded per
artifact. Budget changes are release-review inputs rather than invisible
consequences of adding a feature.

The current executable Gate, receipt, workflow-binding, and publication
boundary is documented in
[Layer-complete Product Release Qualification](../qualification/layer-product-release-qualification.md),
with the measured baseline and profile derivation recorded in
[Layer Gate Timing Baseline](../qualification/layer-gate-timing-baseline.md).

## Domain-horizon gate

Major additions to the native core answer these questions:

1. Is this a domain-neutral runtime-fact primitive, or should it remain in a
   profile/adapter?
2. Does it preserve the quantitative-trading evidence path?
3. Does it serve the current agent-runtime product without making agent
   vocabulary kernel authority?
4. Does it leave a credible low-friction adapter path for games and virtual
   worlds?
5. Which layer's dependency and qualification budget changes?

A feature that fails this gate may still be valuable, but it belongs above the
core.

## Relation to ADR-0046

ADR-0046's assembled Rust-host runtime stands. Its host-trunk and lazy satellite
runtime design is the top-level convenience product and a mechanism for keeping
unused runtimes dormant.

This ADR adds the complementary constraint: the assembled runtime cannot become
the minimum adoption closure. `libkungfu`, ecosystem SDKs, and the standalone
CLI must retain their independent contracts and qualifications.

## Consequences

- Kungfu can grow broad product capability without forcing every adopter to
  carry the broadest dependency closure.
- GUI quality can advance without making Electron part of fact authority.
- Language ecosystems can offer native adoption without semantic forks.
- Domain-focused product work contributes reusable pressure to the same kernel
  while domain vocabulary remains outside it.
- Release engineering becomes more demanding because each artifact needs an
  independent qualification and compatibility matrix.

## Alternatives considered

- **Require the assembled product for all supported workflows.** Rejected
  because it turns optional capability into mandatory adoption cost.
- **Split each layer into an independent authoritative repository.** Rejected
  because contract, schema, release, and agent-discovery drift would move the
  complexity back to users.
- **Treat package modularity as sufficient.** Rejected because packages can be
  physically separate while retaining hidden upward dependencies or GUI-only
  authority.
- **Optimize only binary size.** Rejected because conceptual, operational,
  update, startup, and dependency closures are also forms of weight.
- **Make agent work the permanent kernel vocabulary.** Rejected because the
  kernel already has historical evidence outside that domain and must remain a
  reusable runtime-fact substrate.

## Residual risk

- Independent products can drift unless shared conformance fixtures and
  generated contracts remain release gates.
- Too many artifacts can increase release cost; the answer is generated
  assembly and compatibility evidence, not collapsing all adoption paths.
- "Complete" can become marketing ambiguity unless each artifact keeps a
  narrow, executable qualification.
- Domain neutrality can become abstraction without users; current implementation
  priorities continue to be set by the agent-runtime product and real dogfood.
