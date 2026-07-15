# Documentation Map

This is Kungfu's exhaustive question and evidence index. It is optimized for a
person or agent grounding one specific claim, not for reading from top to
bottom. If you are new to Kungfu, start with the curated
[Documentation Guide](README.md), then return here when you need the complete
audit path behind a question.

Each row carries a **plane** — *why* (intent / rationale), *verify* (trust the
running artifact), *use* (consume / extend) — and a **status**:

- `stable` or `current` — current guidance or contract; guarantees remain
  limited by the status named in the document.
- `draft` — exists, rough or incomplete.
- `proposed` — a designed target that is not yet the current product contract.
- `to write` — planned; the material exists (pointer given) but is not yet a
  single doc.
- `blocked` — waits on the build/release infrastructure; cannot be written
  honestly until the artifacts it documents can actually be produced.

The planes are tags, not folders: some documents legitimately serve two planes,
and the map routes a question to whichever doc answers it.

## Directory index

The physical hierarchy expresses maintenance authority rather than the
why/use/verify planes. Browse [Concepts](concepts/README.md),
[Guides](guides/README.md), [Architecture](architecture/README.md),
[Profiles](profiles/README.md), [Qualification](qualification/README.md),
[Development](development/README.md), or [Research](research/README.md).
Load-bearing decisions remain in [ADR](adr/README.md), and Shifu's development
contracts remain in [Shifu](shifu/README.md).

## Map

| Your question | Document | Plane | Status |
|---|---|---|---|
| Which documentation route should I follow for my job? | [`README.md`](README.md) | use | current |
| What is kungfu, in one idea? | [`../README.md`](../README.md) | — | stable |
| Why is Episode the flagship object for real-world execution, and how do Facts, Receipts, Cuts, Claims, and Decisions fit around it? | [`the-episode.md`](concepts/the-episode.md) + [`vocabulary.md`](concepts/vocabulary.md) | why, use | current · vocabulary contract; guarantees remain maturity-scoped |
| Do I need the whole Kungfu App, or which smaller product should I start with? | [`choose-your-kungfu.md`](guides/choose-your-kungfu.md) | use | draft · adoption contract accepted; artifacts qualify independently in stages |
| What do the implementation terms mean (`kungfu` / `yijinjing` / journal / schema …)? | [`concepts.md`](concepts/implementation-concepts.md) | use | stable |
| Why is it built this way? What is load-bearing? | [`design-philosophy.md`](concepts/design-philosophy.md) | why | stable |
| Why compare Kungfu to SQLite, Git, and a flight recorder — and why is it neither observability nor blockchain? | [`design-philosophy.md`](concepts/design-philosophy.md#the-missing-infrastructure-layer-runtime-facts) | why | stable |
| Why does Kungfu start from accountability? | [`facts-before-trust.md`](concepts/facts-before-trust.md) | why | stable |
| How do Missions, delegated Go work, runtime facts, proof, and decisions become one product? | [`mission-control.md`](profiles/mission-control.md) + [`mission-control-workspaces.md`](profiles/mission-control-workspaces.md) + [ADR-0059](./adr/ADR-0059-mission-control-mission-go-responsibility-model.md) | why, use, verify | draft · mechanisms implemented; workspace product composition and five-question Mission Home designed |
| How does Desktop open and remember a workspace without creating `.kungfu` on read? | [`mission-control-workspaces.md`](profiles/mission-control-workspaces.md) + [ADR-0060](./adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) | why, use, verify | proposed · product design complete; implementation sliced |
| How can a first-time user manage agent work without a repository or predeclared Mission? | [`mission-control-workspaces.md`](profiles/mission-control-workspaces.md) + [ADR-0060](./adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) | why, use, verify | proposed · Home Workspace and unassigned inbox designed |
| Why is agent-mediated guidance a first-class product interface rather than a later CLI integration? | [ADR-0061](./adr/ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md) + [`mission-control-workspaces.md`](profiles/mission-control-workspaces.md) | why, use, verify | proposed · dual-first advice/action/receipt contract designed |
| Why does the commercial product lead with Cost/State/Proof, and what does that profile guarantee? | [`cost-state-proof-profile.md`](profiles/cost-state-proof-profile.md) | why, use, verify | draft · first progress and completion qualification implemented |
| Why this versioning / release design (don't replace it naively)? | [`version-release-design.md`](development/version-release-design.md) | why | stable |
| When must a change open a minor or major (and when must it not)? | [`versioning.md`](development/versioning.md) (rule: KFD-1, adopted by ADR-0010) | verify | stable |
| Why was a past decision made? | [`adr/`](adr/) | why | stable · Core and Shifu share one gated registry |
| Which frontmatter fields are authoritative, and how are ADR status projections checked? | [`document-metadata.md`](development/document-metadata.md) | use, verify | stable · executable contract |
| What is the complete ADR implementation, evidence, review, and stable-readiness balance sheet? | [`adr/`](adr/) + `./shifu adr:audit -- --json` | verify | live · Core and Shifu share one authority and gate |
| How is the repository layered? | [`architecture.md`](architecture/overview.md) | use | stable |
| Which Kungfu layer can I adopt independently, and what does each product promise? | [`product-layers.md`](concepts/product-layers.md) + [`layer-product-release-qualification.md`](qualification/layer-product-release-qualification.md) + [ADR-0049](./adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md) | why, use, verify | qualification implemented · publication remains a separate release action |
| Which application domains guide the neutral core without expanding the current roadmap? | [`domain-horizons.md`](concepts/domain-horizons.md) | why | draft · agent runtime current; trading evidence; games/virtual worlds horizon |
| What are the known limits / what is *not* yet guaranteed? | [`known-limits.md`](qualification/known-limits.md) | verify | stable |
| Can my institution use Kungfu as an authoritative local ledger on one host, and what evidence and controls are required? | [`single-host-institutional-trust.md`](qualification/single-host-institutional-trust.md) | use, verify | current-hardware candidate · production eligibility remains false |
| How do I configure visible, grouped durable, or synchronous durable writes, and what latency/throughput cost does each choice impose? | [`durability-configuration.md`](guides/durability-configuration.md) + [ADR-0084](./adr/ADR-0084-kfd1-durability-policy-and-runtime-admission.md) | use, why, verify | pre-release · explicit current-hardware candidate; fail-closed and production-ineligible |
| How do I upgrade Desktop or standalone CLI without interrupting active work, and when does the new runtime take effect? | [`upgrading.md`](guides/upgrading.md) + [`upgrade-compatibility.md`](development/upgrade-compatibility.md) + [ADR-0087](./adr/ADR-0087-versioned-product-runtime-upgrade-control-plane.md) | use, verify | pre-release · Core and archive CLI implemented; desktop transport, signed channels, native packages, and cross-platform qualification remain staged |
| What end-to-end performance gate must the single-host institutional profile pass, and how may Aeron be used as a comparator? | [`single-host-performance-qualification.md`](qualification/single-host-performance-qualification.md) | verify | one named agent-120 candidate slice qualified · wider product and production admission remain separate |
| Does Kungfu provide strong durability and crash recovery without giving up mmap latency, and what is implemented today? | [`durability-and-crash-recovery.md`](qualification/durability-and-crash-recovery.md) + [ADR-0068](./adr/ADR-0068-tiered-durability-and-crash-recovery.md) | why, verify | current-hardware candidate implemented and admitted · physical power loss and production eligibility remain false |
| How do C++ / Python / Node share data zero-copy (the membrane)? | [`architecture.md`](architecture/overview.md) (membrane diagram) | verify | stable |
| What does it actually guarantee (layout / replay / compatibility)? | [`contracts.md`](qualification/contracts.md) | verify | stable |
| What KFD-2 release claims can Buildchain audit? | [`contracts.md`](qualification/contracts.md) (KFD-2 release claims) + [`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md) | verify | draft |
| What is the event / journal / replay model? | [`event-model.md`](architecture/event-model.md) | use | stable |
| What do Rewind, Replay, Recovery, and explicit re-execution mean, and where are their authority boundaries? | [`rewind.md`](guides/rewind.md) + [ADR-0020](./adr/ADR-0020-agent-action-timeline-and-replay-boundary.md) | why, use, verify | current contract · agent-work capture slice remains pre-release |
| How does Kungfu persist user facts, sync sources, and maintain storage over time? | [`runtime-storage-service.md`](architecture/runtime-storage-service.md) | use, verify | draft |
| How do my domain facts enter Kungfu's declared fact world, remain replayable, and become eligible for trust assessment? | [`fact-surface-admission.md`](guides/fact-surface-admission.md) + [ADR-0051](./adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I manage a long-running Mission, delegate Go work, inspect Cost/State/Proof, and move the evidence to another data root? | [`mission-control.md`](profiles/mission-control.md) + [ADR-0059](./adr/ADR-0059-mission-control-mission-go-responsibility-model.md) | why, use, verify | pre-release · native authoring and local full/thin bundle roundtrip implemented |
| When does KFD-2 assess a claim, what does the workspace coordinator do, and how do Desktop processes and embedded threads share the model? | [`kfd2-trust-assessment.md`](qualification/kfd2-trust-assessment.md) + [ADR-0052](./adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I query current or historical runtime facts, and what proves the answer? | [`querying-runtime-facts.md`](guides/querying-runtime-facts.md) + [ADR-0048](./adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md) | use, verify | draft · semantics accepted; implementation staged |
| What is an Episode, why is it the atomic trust boundary, and how is that claim qualified under faults and load? | [`episode-object-model.md`](concepts/episode-object-model.md) + [`episode-atomicity-qualification.md`](qualification/episode-atomicity-qualification.md) + [ADR-0033](./adr/ADR-0033-episode-causal-segment-object.md) + [ADR-0034](./adr/ADR-0034-yijinjing-episode-manifest-journal.md) + [ADR-0042](./adr/ADR-0042-episode-atomic-safety-and-qualification.md) | why, use, verify | draft |
| What is the supervisor/coordinator topology, and how can the coordinator stay alive after the GUI closes? | [`runtime-service.md`](architecture/runtime-service.md) + [ADR-0036](./adr/ADR-0036-supervisor-and-workspace-master-topology.md) | use, verify | draft |
| How can a multi-machine timeline stay stable without one global clock? | [ADR-0021](./adr/ADR-0021-observer-relative-timeline-projection.md) + [`event-model.md`](architecture/event-model.md) | why, verify | stable |
| Where must action-recording semantics live across C++ / Python / Node? | [ADR-0022](./adr/ADR-0022-core-action-recording-surface.md) + [`event-model.md`](architecture/event-model.md) | why, use | stable |
| What is a location role, and why does it not decide journal page size? | [ADR-0024](./adr/ADR-0024-location-role-and-journal-page-policy.md) + [`event-model.md`](architecture/event-model.md) | why, use | stable |
| Where are the Python / Node / framework adapter boundaries? | [`adapters.md`](architecture/adapters.md) | use | stable |
| How do I install Python packages (pandas/torch-class) into Kungfu's runtime? | [`python-environments.md`](guides/python-environments.md) + [ADR-0046](./adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md) | use | stable |
| How do I go from source to a binary? | [`buildchain.md`](development/buildchain.md) (+ [`../CONTRIBUTING.md`](../CONTRIBUTING.md)) | use | stable |
| Which C++ compiler/tool versions are supported, and why are Modules not in production? | [`cpp-toolchain.md`](development/cpp-toolchain.md) + [ADR-0066](./adr/ADR-0066-native-cpp-toolchain-contract-and-modules-hold.md) | why, use, verify | stable · machine contract and removable qualification slice implemented |
| What Python runtime ships inside the product, and what was pruned from it? | [ADR-0050](./adr/ADR-0050-assembled-runtime-stdlib-pruning-policy.md) + [`buildchain.md`](development/buildchain.md) | why, verify | stable |
| When (and when not) does a component get written in Rust, and how is one added? | [`rust-adoption.md`](development/rust-adoption.md) | why, use | stable |
| What research evidence informed the Rust host and embedding boundaries? | [`rust-host-spike.md`](research/rust-host-spike.md) + [`libkungfu-embedding-membrane-spike.md`](research/libkungfu-embedding-membrane-spike.md) + [`libwasm-embedding-membrane-spike.md`](research/libwasm-embedding-membrane-spike.md) | why, verify | research · retained evidence, not current operative guidance |
| What must never change about the `shifu` entrypoints (and why)? | [ADR-0044](./adr/ADR-0044-shifu-delegation-protocol.md) | why, verify | stable |
| How does Shifu consume a central cache profile, who owns the schema, and how can a local binary expose it? | [`shifu/`](shifu/README.md) + [`shifu/cache-contract.json`](shifu/cache-contract.json) + [SHIFU-ADR-0001](./adr/SHIFU-ADR-0001-cache-profile-contract-and-ownership.md) | why, use, verify | development · schema, fixtures, discovery, and repository conformance implemented |
| How are light and heavy gates registered, explained, compared across profiles, and planned without hard-coding project policy into Shifu? | [Gate control plane](shifu/gates.md) + [`shifu/gate-contract.json`](shifu/gate-contract.json) + [SHIFU-ADR-0004](adr/SHIFU-ADR-0004-gate-control-plane-contract.md) | why, use, verify | development · read-only contract, validator, matrix, and planner implemented |
| How does a project submit documentation roles, verification obligations, providers, routes, and canonical roots without moving its semantics into Shifu? | [`shifu/documentation-contract.json`](shifu/documentation-contract.json) + [`../shifu.documentation.json`](../shifu.documentation.json) + [SHIFU-ADR-0006](adr/SHIFU-ADR-0006-documentation-protocol-and-provider-boundary.md) | why, use, verify | development · v1 contract, diagnostics, roots, fixtures, and compatibility projection implemented |
| What is Xinfa, how does an Atlas project compile one immutable Xinfa Atlas plus bounded Human, Task Chart, and GUI views while preserving legacy Pack roots, and how is the standalone boundary proved? | [`../xinfa/`](../xinfa/) + [ADR-0092](adr/ADR-0092-xinfa-product-and-incubation-boundary.md) + [ADR-0093](adr/ADR-0093-xinfa-dual-first-verified-context-contract.md) + [ADR-0094](adr/ADR-0094-xinfa-repository-context-pack.md) + [ADR-0095](adr/ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md) + [ADR-0096](adr/ADR-0096-xinfa-bounded-projection-and-task-chart.md) | why, use, verify | incubation · immutable Atlas/Pack roots, bounded-hop Human/GUI views, bounded-token Task Chart, cut-preserving expansion, provider-excluded generated materialization, offline verification, and clean extraction implemented |
| Which gates does Kungfu currently have, what does each protect, and which dev/alpha/release profiles select it? | [Kungfu Gate catalog and policy matrix](qualification/gates/README.md) | use, verify, audit | qualification · generated matrix plus workflow-bound current-state policy |
| How do exact artifacts from all seven ADR-0049 rows become one fail-closed release verdict? | [`layer-product-release-qualification.md`](qualification/layer-product-release-qualification.md) | use, verify, audit | implemented · Shifu Gate registry/profile/receipt closure; no publication implied |
| Where does a release binary come from, and how do I verify it? | `provenance.md` | verify | blocked · needs release infra |
| What gates must a release pass? | `provenance.md` + [`version-release-design.md`](development/version-release-design.md) | verify | partial |
| How do KFD-1/2/3 become SDK scaffolds and future release-gate evidence? | [`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md) | use, verify | draft |
| If kungfu itself misbehaves, how do I localize it? | [`debugging.md`](guides/debugging.md) | verify | stable |
| How does the current agent-work capture adapter create an Episode and provide a run-specific forensic view? | [`rewind.md`](guides/rewind.md) | use, verify | pre-release · executable source fixtures, not the identity of the whole product |
| What should an installed agent read first, which mode should it choose, and is the agent-facing control surface closed? | installed pack: `kungfu agent brief`, `kungfu agent capabilities --json`, `kungfu agent choose-mode --json`, `kungfu agent verify --json` | use, verify | stable |
| How do I write an extension (`kfx`)? | [`extensions.md`](architecture/extensions.md) | use | stable · view kfx; runtime facets mid-migration |
| How can an Agent create and operate my own KFD-1/KFD-2 Profile without rebuilding Kungfu? | [`profile-authoring.md`](profiles/profile-authoring.md) + [`profile-lifecycle.md`](profiles/profile-lifecycle.md) + [ADR-0069](./adr/ADR-0069-agent-first-kfx-profile-suite-runtime.md) | use, verify | pre-release · installed SDK, GUI manager, Mission reference Suite, and independent Week/Day qualification implemented on macOS ARM64 |
| Where is global config, and how do agents read it? | [`config.md`](guides/config.md) | use | draft |
| How is a kfx loaded, trusted, and confined? (the topology) | [`kfx-topology.md`](architecture/kfx-topology.md) (design: ADR-0017; trust boundary ADR-0013; uniform capability surface ADR-0014) | use | draft · load plan + `service` facet proposed |
| How do I write an agent-facing Kungfu Skill? | [`skills.md`](architecture/skills.md) (first implementation slice; decided by ADR-0015) | use | draft |
| What license, trademark, service-use, and provider-compliance boundaries apply? | [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) + [`../TRADEMARK.md`](../TRADEMARK.md) + [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md) + [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md) | use | stable |

## Also asking about

The rows above are phrased as questions; if your wording differs, these keywords
route to the row that answers them:

- **arm64 / Apple Silicon / weak memory ordering / torn frames** → *what does it
  actually guarantee* ([`contracts.md`](qualification/contracts.md)) and *why was a decision
  made* ([ADR-0001](./adr/ADR-0001-yijinjing-publish-barrier.md)).
- **thread-safety / concurrency / single-writer multi-reader / lock-free** →
  *what does it actually guarantee* ([`contracts.md`](qualification/contracts.md)) and *where
  should writer, reader-cursor, and page-lifetime ownership end*
  ([ADR-0063](./adr/ADR-0063-yijinjing-concurrency-and-lifetime-contract.md),
  proposed).
- **SIGINT / replay exhaustion / subscriber error / loop stop / embedding error**
  → *who owns error propagation and process lifetime*
  ([ADR-0064](./adr/ADR-0064-runtime-error-propagation-and-stop-ownership.md),
  proposed).
- **determinism / reproducibility / record-and-replay** → *what does it actually
  guarantee* ([`contracts.md`](qualification/contracts.md)) and *the event / journal / replay
  model* ([`event-model.md`](architecture/event-model.md)).
- **agent action timeline / causal action chain / forensic replay / mocked
  replay / external side effects / rewind replay boundary** → *what does Rewind
  replay, and what must it never silently re-execute*
  ([ADR-0020](./adr/ADR-0020-agent-action-timeline-and-replay-boundary.md)).
- **action recorder / action recording / Python recorder / Node recorder /
  JS recorder / C++ recorder / polyglot action surface / binding-only logic** →
  *where must action-recording semantics live across C++ / Python / Node*
  ([ADR-0022](./adr/ADR-0022-core-action-recording-surface.md)).
- **location role / source / sink / actor / service / journal page size /
  mmap size / storage policy** → *what is a location role, and why does it not
  decide journal page size*
  ([ADR-0024](./adr/ADR-0024-location-role-and-journal-page-policy.md)).
- **observer-relative timeline / timeline projection / source priority /
  global clock / multi-machine ordering / perspective / concurrent facts** →
  *how can a multi-machine timeline stay stable without one global clock*
  ([ADR-0021](./adr/ADR-0021-observer-relative-timeline-projection.md)).
- **accountability / facts before trust / local proof before control** → *why
  does Kungfu start from accountability* ([`facts-before-trust.md`](concepts/facts-before-trust.md)).
- **KUNGFU / UNGFU / Never Guess / Facts Unfold / recursive name / why Kungfu**
  → *where the name came from and how its recursive meaning maps to the
  architecture* ([`why-kungfu.md`](concepts/why-kungfu.md)).
- **Mission Control / Mission / Go / delegated responsibility / progress drift /
  completion claim / Atlas bridge / Cost State Proof / cost management profile**
  → *how Missions and delegated work become one proof-backed product*
  ([`mission-control.md`](profiles/mission-control.md)), *how the workspace product and
  five-question Mission Home behave* ([`mission-control-workspaces.md`](profiles/mission-control-workspaces.md)), then *what the first commercial
  profile packages* ([`cost-state-proof-profile.md`](profiles/cost-state-proof-profile.md))
  and [ADR-0059](./adr/ADR-0059-mission-control-mission-go-responsibility-model.md).
- **SQLite / Git for runs / flight recorder / runtime fact infrastructure /
  observability / OpenTelemetry / blockchain / polyglot semantic core** → *why
  Kungfu occupies a distinct runtime-fact layer*
  ([`design-philosophy.md`](concepts/design-philosophy.md#the-missing-infrastructure-layer-runtime-facts)).
- **query / SQL / historical state / time travel / temporal pattern / CEP /
  changelog / proof / lineage / QueryDefinition** → *how do I query current or
  historical runtime facts* ([`querying-runtime-facts.md`](guides/querying-runtime-facts.md))
  and [ADR-0048](./adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md).
- **contract world / fact surface / fact admission / user facts / domain facts /
  KFD-1 facts / KFD-2 TrustReport** -> *how domain facts enter Kungfu and become
  eligible for trust assessment* ([`fact-surface-admission.md`](guides/fact-surface-admission.md))
  and [ADR-0051](./adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md).
- **KFD-2 assessment / TrustReport refresh / claim trigger / assessment worker /
  Assessment Episode / process assessor / thread assessor** -> *when and where
  trust is assessed* ([`kfd2-trust-assessment.md`](qualification/kfd2-trust-assessment.md))
  and [ADR-0052](./adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md).
- **latency / performance / zero-copy / serialization** → *the membrane*
  ([`architecture.md`](architecture/overview.md)) and *the event model*
  ([`event-model.md`](architecture/event-model.md)).
- **durability / fsync / config / durable_group / durable_sync / power loss /
  crash recovery / durable receipt /
  durable watermark / projection watermark / data loss** → *what Kungfu
  guarantees now, how to request a profile, and the staged strong-durability
  design* ([`durability-configuration.md`](guides/durability-configuration.md),
  [`durability-and-crash-recovery.md`](qualification/durability-and-crash-recovery.md),
  [ADR-0068](./adr/ADR-0068-tiered-durability-and-crash-recovery.md), and
  [ADR-0084](./adr/ADR-0084-kfd1-durability-policy-and-runtime-admission.md)).
- **institution / institutional adoption / local ledger / system of record /
  production approval / single host / RPO / restore drill** → *whether an
  institution can adopt Kungfu as an authoritative local ledger, what evidence
  is required, and which controls remain operator-owned*
  ([`single-host-institutional-trust.md`](qualification/single-host-institutional-trust.md)).
- **performance qualification / release gate / p99 / p99.9 / throughput /
  backpressure / soak / Aeron comparison / Aeron-class** → *which absolute
  performance and regression evidence admits the single-host institutional
  profile, and why Aeron is informative rather than release authority*
  ([`single-host-performance-qualification.md`](qualification/single-host-performance-qualification.md)).
- **lightweight / too heavy / minimal install / independent package / libkungfu
  only / CLI without GUI / layer deletion / assembled runtime** → *which
  Kungfu should I start with* ([`choose-your-kungfu.md`](guides/choose-your-kungfu.md)),
  then *what does each layer guarantee* ([`product-layers.md`](concepts/product-layers.md))
  and [ADR-0049](./adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md).
- **quant trading / agent runtime / games / virtual reality / virtual worlds /
  domain-neutral core / future application horizon** →
  [`domain-horizons.md`](concepts/domain-horizons.md).
- **how do I run it / get started / install** → *source to a binary*
  ([`buildchain.md`](development/buildchain.md)) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
  (A one-command run-it path is planned — see the build/release work tracked
  in [`known-limits.md`](qualification/known-limits.md).)
- **Shifu cache / central cache / cache profile / mirror schema / runner cache /
  inventory projection / local Shifu binary** → *how Shifu cache policy is owned,
  projected, discovered, and verified* ([`shifu/`](shifu/README.md)).
- **N-API / pybind11 / bindings / FFI** → *adapter boundaries*
  ([`adapters.md`](architecture/adapters.md)).
- **KFX / source authority / frozen first-party set / content pin /
  capability relay / sandboxed view / OS sandbox / service facet / planKfx** →
  *kfx topology* ([`kfx-topology.md`](architecture/kfx-topology.md)) and *extensions*
  ([`extensions.md`](architecture/extensions.md)).
- **config / `.kungfu` / `~/.kungfu-config` / `KF_CONFIG_HOME` / `KF_HOME` / UI font / UI scale /
  shortcuts / agent entrypoint** → *Kungfu config* ([`config.md`](guides/config.md)).
- **workspace data home / `.kungfu/` / data root / Git worktree data /
  machine fallback / Home Workspace / Agent Work Inbox / config home
  rename / Open Workspace / recent workspace / lazy initialization** → *Kungfu
  config and Desktop workspace product*
  ([`config.md`](guides/config.md)) and
  [`mission-control-workspaces.md`](profiles/mission-control-workspaces.md),
  [ADR-0035](./adr/ADR-0035-workspace-local-kungfu-data-home.md),
  and [ADR-0060](./adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md).
- **agent-mediated guidance / dual-first UX / advice / impact preview /
  authorization / execution receipt / stale advice / agent-operable product** →
  *Mission Control workspace product* ([`mission-control-workspaces.md`](profiles/mission-control-workspaces.md))
  and [ADR-0061](./adr/ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md).
- **supervisor / per-user supervisor / workspace coordinator / data-root coordinator /
  coordinator singleton / live registry / idle shutdown / daemonless storage** →
  *Kungfu supervisor and coordinator service* ([`runtime-service.md`](architecture/runtime-service.md))
  and [ADR-0036](./adr/ADR-0036-supervisor-and-workspace-master-topology.md).
- **SKILL.md / agent skill / skill catalog / context injection / Node manager /
  Python manager / skill audit / skill-manager view / kfx dependency binding** →
  *agent-facing Kungfu Skill* ([`skills.md`](architecture/skills.md)).
- **agent onboarding / mode selection / choose-mode / report mode / trace mode /
  managed-run / remote sync / local agent facts** → the installed Agent
  Onboarding Pack (`kungfu agent brief`, `kungfu agent capabilities --json`).
- **runtime storage / source sync / location / channel / payload store / blob
  store / fsck / compact / garbage collection / range export / projection
  rebuild** → *runtime storage service*
  ([`runtime-storage-service.md`](architecture/runtime-storage-service.md)).
- **episode / causal segment / causal closure / atomic safety / graceful
  degradation / capability contraction / qualification / TrustReport /
  lifecycle unit / run slice / export unit / import unit / tombstone / episode
  manifest / episode fsck** →
  *Episode object model* ([`episode-object-model.md`](concepts/episode-object-model.md))
  plus [`episode-atomicity-qualification.md`](qualification/episode-atomicity-qualification.md),
  [ADR-0033](./adr/ADR-0033-episode-causal-segment-object.md),
  and [ADR-0042](./adr/ADR-0042-episode-atomic-safety-and-qualification.md).
- **episode manifest journal / manifest record / manifest delta / manifest
  authority / yijinjing manifest / Hana manifest / JSON manifest** → *Episode
  object model* ([`episode-object-model.md`](concepts/episode-object-model.md)) and
  [ADR-0034](./adr/ADR-0034-yijinjing-episode-manifest-journal.md).
- **signature / checksum / supply chain / SBOM** → *verify a release binary*
  (`provenance.md`, `blocked` — see [`known-limits.md`](qualification/known-limits.md)).
- **KFD / SDK scaffold / release gate evidence / contract scaffold / fact
  surface scaffold / agent interface scaffold / release passport downgrade** →
  *KFD-native SDK and release gates*
  ([`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md)).
- **trademark / fork / hosted service / provider compliance / cost attribution
  boundary** → [`../TRADEMARK.md`](../TRADEMARK.md),
  [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md), and
  [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md).

## How this map is maintained

- The curated [`README.md`](README.md) owns reader routes and document roles;
  this file owns exhaustive question and keyword lookup. Do not turn either one
  into a duplicate of the other.
- A document becomes a row here the moment it is *named*, even before it exists —
  so the gap is visible (`to write` / `blocked`), not hidden.
- A row's status must never claim more than the artifact delivers. A document
  that asserts a guarantee should also say where to verify it and how mature that
  guarantee is.
- `why` documents explain intent and may be read as narrative; `verify` and
  `use` documents are reference paths and should state, per claim, *what it
  guarantees → where to verify → current maturity*.
- Public URLs remain stable until an automated link check and a compatibility
  path exist for a physical move. Spike reports remain research evidence; their
  resulting ADRs and current architecture documents own operative guidance.
