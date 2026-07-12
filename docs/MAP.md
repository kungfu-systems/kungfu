# Documentation Map

Start here. Find the question you have; follow it to the document that answers
it. This map is meant to be readable by both a person skimming for the right doc
and an agent grounding a specific claim — it is the audit path to the question
behind all the others: *why can I trust this complex thing?*

Each row carries a **plane** — *why* (intent / rationale), *verify* (trust the
running artifact), *use* (consume / extend) — and a **status**:

- `stable` — current and holds.
- `draft` — exists, rough or incomplete.
- `to write` — planned; the material exists (pointer given) but is not yet a
  single doc.
- `blocked` — waits on the build/release infrastructure; cannot be written
  honestly until the artifacts it documents can actually be produced.

The planes are tags, not folders: some documents legitimately serve two planes,
and the map routes a question to whichever doc answers it.

## Map

| Your question | Document | Plane | Status |
|---|---|---|---|
| What is kungfu, in one idea? | [`../README.md`](../README.md) | — | stable |
| Do I need the whole Kungfu App, or which smaller product should I start with? | [`choose-your-kungfu.md`](choose-your-kungfu.md) | use | draft · adoption contract accepted; artifacts qualify independently in stages |
| What do the terms mean (`kungfu` / `yijinjing` / journal / schema …)? | [`concepts.md`](concepts.md) | use | stable |
| Why is it built this way? What is load-bearing? | [`design-philosophy.md`](design-philosophy.md) | why | stable |
| Why compare Kungfu to SQLite, Git, and a flight recorder — and why is it neither observability nor blockchain? | [`design-philosophy.md`](design-philosophy.md#the-missing-infrastructure-layer-runtime-facts) | why | stable |
| Why does Kungfu start from accountability? | [`facts-before-trust.md`](facts-before-trust.md) | why | stable |
| How do Missions, delegated Go work, runtime facts, proof, and decisions become one product? | [`mission-control.md`](mission-control.md) + [`mission-control-workspaces.md`](mission-control-workspaces.md) + [ADR-0059](../framework/core/docs/adr/ADR-0059-mission-control-mission-go-responsibility-model.md) | why, use, verify | draft · mechanisms implemented; workspace product composition and five-question Mission Home designed |
| How does Desktop open and remember a workspace without creating `.kungfu` on read? | [`mission-control-workspaces.md`](mission-control-workspaces.md) + [ADR-0060](../framework/core/docs/adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) | why, use, verify | proposed · product design complete; implementation sliced |
| How can a first-time user manage agent work without a repository or predeclared Mission? | [`mission-control-workspaces.md`](mission-control-workspaces.md) + [ADR-0060](../framework/core/docs/adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) | why, use, verify | proposed · Home Workspace and unassigned inbox designed |
| Why is agent-mediated guidance a first-class product interface rather than a later CLI integration? | [ADR-0061](../framework/core/docs/adr/ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md) + [`mission-control-workspaces.md`](mission-control-workspaces.md) | why, use, verify | proposed · dual-first advice/action/receipt contract designed |
| Why does the commercial product lead with Cost/State/Proof, and what does that profile guarantee? | [`cost-state-proof-profile.md`](cost-state-proof-profile.md) | why, use, verify | draft · first progress and completion qualification implemented |
| Why this versioning / release design (don't replace it naively)? | [`version-release-design.md`](version-release-design.md) | why | stable |
| When must a change open a minor or major (and when must it not)? | [`versioning.md`](versioning.md) (rule: KFD-1, adopted by ADR-0010) | verify | stable |
| Why was a past decision made? | [`../framework/core/docs/adr/`](../framework/core/docs/adr) | why | stable |
| How is the repository layered? | [`architecture.md`](architecture.md) | use | stable |
| Which Kungfu layer can I adopt independently, and what does each product promise? | [`product-layers.md`](product-layers.md) + [ADR-0049](../framework/core/docs/adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md) | why, use, verify | draft · principle accepted; qualifications staged |
| Which application domains guide the neutral core without expanding the current roadmap? | [`domain-horizons.md`](domain-horizons.md) | why | draft · agent runtime current; trading evidence; games/virtual worlds horizon |
| What are the known limits / what is *not* yet guaranteed? | [`known-limits.md`](known-limits.md) | verify | stable |
| Can my institution use Kungfu as an authoritative local ledger on one host, and what evidence and controls are required? | [`single-host-institutional-trust.md`](single-host-institutional-trust.md) | use, verify | draft · evaluation/shadow use only; strong local durability qualification pending |
| What end-to-end performance gate must the single-host institutional profile pass, and how may Aeron be used as a comparator? | [`single-host-performance-qualification.md`](single-host-performance-qualification.md) | verify | draft · contract defined; thresholds, harness, and retained reports not implemented |
| Does Kungfu provide strong durability and crash recovery without giving up mmap latency, and what is implemented today? | [`durability-and-crash-recovery.md`](durability-and-crash-recovery.md) + [ADR-0068](../framework/core/docs/adr/ADR-0068-tiered-durability-and-crash-recovery.md) | why, verify | draft · visibility foundations implemented; end-to-end durable receipts and power-loss qualification designed, not implemented |
| How do C++ / Python / Node share data zero-copy (the membrane)? | [`architecture.md`](architecture.md) (membrane diagram) | verify | stable |
| What does it actually guarantee (layout / replay / compatibility)? | [`contracts.md`](contracts.md) | verify | stable |
| What KFD-2 release claims can Buildchain audit? | [`contracts.md`](contracts.md) (KFD-2 release claims) + [`kfd-native-sdk-release-gates.md`](kfd-native-sdk-release-gates.md) | verify | draft |
| What is the event / journal / replay model? | [`event-model.md`](event-model.md) | use | stable |
| What does Rewind replay, and what must it never silently re-execute? | [ADR-0020](../framework/core/docs/adr/ADR-0020-agent-action-timeline-and-replay-boundary.md) + [`rewind.md`](rewind.md) | why, verify | stable |
| How does Kungfu persist user facts, sync sources, and maintain storage over time? | [`runtime-storage-service.md`](runtime-storage-service.md) | use, verify | draft |
| How do my domain facts enter Kungfu's declared fact world, remain replayable, and become eligible for trust assessment? | [`fact-surface-admission.md`](fact-surface-admission.md) + [ADR-0051](../framework/core/docs/adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I manage a long-running Mission, delegate Go work, inspect Cost/State/Proof, and move the evidence to another data root? | [`mission-control.md`](mission-control.md) + [ADR-0059](../framework/core/docs/adr/ADR-0059-mission-control-mission-go-responsibility-model.md) | why, use, verify | pre-release · native authoring and local full/thin bundle roundtrip implemented |
| When does KFD-2 assess a claim, what does the workspace coordinator do, and how do Desktop processes and embedded threads share the model? | [`kfd2-trust-assessment.md`](kfd2-trust-assessment.md) + [ADR-0052](../framework/core/docs/adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I query current or historical runtime facts, and what proves the answer? | [`querying-runtime-facts.md`](querying-runtime-facts.md) + [ADR-0048](../framework/core/docs/adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md) | use, verify | draft · semantics accepted; implementation staged |
| What is an Episode, why is it the atomic trust boundary, and how is that claim qualified under faults and load? | [`episode-object-model.md`](episode-object-model.md) + [`episode-atomicity-qualification.md`](episode-atomicity-qualification.md) + [ADR-0033](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md) + [ADR-0034](../framework/core/docs/adr/ADR-0034-yijinjing-episode-manifest-journal.md) + [ADR-0042](../framework/core/docs/adr/ADR-0042-episode-atomic-safety-and-qualification.md) | why, use, verify | draft |
| What is the supervisor/coordinator topology, and how can the coordinator stay alive after the GUI closes? | [`runtime-service.md`](runtime-service.md) + [ADR-0036](../framework/core/docs/adr/ADR-0036-supervisor-and-workspace-master-topology.md) | use, verify | draft |
| How can a multi-machine timeline stay stable without one global clock? | [ADR-0021](../framework/core/docs/adr/ADR-0021-observer-relative-timeline-projection.md) + [`event-model.md`](event-model.md) | why, verify | stable |
| Where must action-recording semantics live across C++ / Python / Node? | [ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md) + [`event-model.md`](event-model.md) | why, use | stable |
| What is a location role, and why does it not decide journal page size? | [ADR-0024](../framework/core/docs/adr/ADR-0024-location-role-and-journal-page-policy.md) + [`event-model.md`](event-model.md) | why, use | stable |
| Where are the Python / Node / framework adapter boundaries? | [`adapters.md`](adapters.md) | use | stable |
| How do I install Python packages (pandas/torch-class) into Kungfu's runtime? | [`python-environments.md`](python-environments.md) + [ADR-0046](../framework/core/docs/adr/ADR-0046-rust-host-trunk-and-assembled-runtime.md) | use | stable |
| How do I go from source to a binary? | [`buildchain.md`](buildchain.md) (+ [`../CONTRIBUTING.md`](../CONTRIBUTING.md)) | use | stable |
| Which C++ compiler/tool versions are supported, and why are Modules not in production? | [`cpp-toolchain.md`](cpp-toolchain.md) + [ADR-0066](../framework/core/docs/adr/ADR-0066-native-cpp-toolchain-contract-and-modules-hold.md) | why, use, verify | stable · machine contract and removable qualification slice implemented |
| What Python runtime ships inside the product, and what was pruned from it? | [ADR-0050](../framework/core/docs/adr/ADR-0050-assembled-runtime-stdlib-pruning-policy.md) + [`buildchain.md`](buildchain.md) | why, verify | stable |
| When (and when not) does a component get written in Rust, and how is one added? | [`rust-adoption.md`](rust-adoption.md) | why, use | stable |
| What must never change about the `shifu` entrypoints (and why)? | [ADR-0044](../framework/core/docs/adr/ADR-0044-shifu-delegation-protocol.md) | why, verify | stable |
| How does Shifu consume a central cache profile, who owns the schema, and how can a local binary expose it? | [`shifu/`](shifu/README.md) + [`shifu/cache-contract.json`](shifu/cache-contract.json) + [SHIFU-ADR-0001](shifu/adr/SHIFU-ADR-0001-cache-profile-contract-and-ownership.md) | why, use, verify | development · schema, fixtures, discovery, and repository conformance implemented |
| Where does a release binary come from, and how do I verify it? | `provenance.md` | verify | blocked · needs release infra |
| What gates must a release pass? | `provenance.md` + [`version-release-design.md`](version-release-design.md) | verify | partial |
| How do KFD-1/2/3 become SDK scaffolds and future release-gate evidence? | [`kfd-native-sdk-release-gates.md`](kfd-native-sdk-release-gates.md) | use, verify | draft |
| If kungfu itself misbehaves, how do I localize it? | [`debugging.md`](debugging.md) | verify | stable |
| How do I record an agent run and find why it failed (Rewind)? | [`rewind.md`](rewind.md) | use | stable · pre-release install path |
| What should an installed agent read first, which mode should it choose, and is the agent-facing control surface closed? | installed pack: `kungfu agent brief`, `kungfu agent capabilities --json`, `kungfu agent choose-mode --json`, `kungfu agent verify --json` | use, verify | stable |
| How do I write an extension (`kfx`)? | [`extensions.md`](extensions.md) | use | stable · view kfx; runtime facets mid-migration |
| Where is global config, and how do agents read it? | [`config.md`](config.md) | use | draft |
| How is a kfx loaded, trusted, and confined? (the topology) | [`kfx-topology.md`](kfx-topology.md) (design: ADR-0017; trust boundary ADR-0013; uniform capability surface ADR-0014) | use | draft · load plan + `service` facet proposed |
| How do I write an agent-facing Kungfu Skill? | [`skills.md`](skills.md) (first implementation slice; decided by ADR-0015) | use | draft |
| What license, trademark, service-use, and provider-compliance boundaries apply? | [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) + [`../TRADEMARK.md`](../TRADEMARK.md) + [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md) + [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md) | use | stable |

## Also asking about

The rows above are phrased as questions; if your wording differs, these keywords
route to the row that answers them:

- **arm64 / Apple Silicon / weak memory ordering / torn frames** → *what does it
  actually guarantee* ([`contracts.md`](contracts.md)) and *why was a decision
  made* ([ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)).
- **thread-safety / concurrency / single-writer multi-reader / lock-free** →
  *what does it actually guarantee* ([`contracts.md`](contracts.md)) and *where
  should writer, reader-cursor, and page-lifetime ownership end*
  ([ADR-0063](../framework/core/docs/adr/ADR-0063-yijinjing-concurrency-and-lifetime-contract.md),
  proposed).
- **SIGINT / replay exhaustion / subscriber error / loop stop / embedding error**
  → *who owns error propagation and process lifetime*
  ([ADR-0064](../framework/core/docs/adr/ADR-0064-runtime-error-propagation-and-stop-ownership.md),
  proposed).
- **determinism / reproducibility / record-and-replay** → *what does it actually
  guarantee* ([`contracts.md`](contracts.md)) and *the event / journal / replay
  model* ([`event-model.md`](event-model.md)).
- **agent action timeline / causal action chain / forensic replay / mocked
  replay / external side effects / rewind replay boundary** → *what does Rewind
  replay, and what must it never silently re-execute*
  ([ADR-0020](../framework/core/docs/adr/ADR-0020-agent-action-timeline-and-replay-boundary.md)).
- **action recorder / action recording / Python recorder / Node recorder /
  JS recorder / C++ recorder / polyglot action surface / binding-only logic** →
  *where must action-recording semantics live across C++ / Python / Node*
  ([ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md)).
- **location role / source / sink / actor / service / journal page size /
  mmap size / storage policy** → *what is a location role, and why does it not
  decide journal page size*
  ([ADR-0024](../framework/core/docs/adr/ADR-0024-location-role-and-journal-page-policy.md)).
- **observer-relative timeline / timeline projection / source priority /
  global clock / multi-machine ordering / perspective / concurrent facts** →
  *how can a multi-machine timeline stay stable without one global clock*
  ([ADR-0021](../framework/core/docs/adr/ADR-0021-observer-relative-timeline-projection.md)).
- **accountability / facts before trust / local proof before control** → *why
  does Kungfu start from accountability* ([`facts-before-trust.md`](facts-before-trust.md)).
- **Mission Control / Mission / Go / delegated responsibility / progress drift /
  completion claim / Atlas bridge / Cost State Proof / cost management profile**
  → *how Missions and delegated work become one proof-backed product*
  ([`mission-control.md`](mission-control.md)), *how the workspace product and
  five-question Mission Home behave* ([`mission-control-workspaces.md`](mission-control-workspaces.md)), then *what the first commercial
  profile packages* ([`cost-state-proof-profile.md`](cost-state-proof-profile.md))
  and [ADR-0059](../framework/core/docs/adr/ADR-0059-mission-control-mission-go-responsibility-model.md).
- **SQLite / Git for runs / flight recorder / runtime fact infrastructure /
  observability / OpenTelemetry / blockchain / polyglot semantic core** → *why
  Kungfu occupies a distinct runtime-fact layer*
  ([`design-philosophy.md`](design-philosophy.md#the-missing-infrastructure-layer-runtime-facts)).
- **query / SQL / historical state / time travel / temporal pattern / CEP /
  changelog / proof / lineage / QueryDefinition** → *how do I query current or
  historical runtime facts* ([`querying-runtime-facts.md`](querying-runtime-facts.md))
  and [ADR-0048](../framework/core/docs/adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md).
- **contract world / fact surface / fact admission / user facts / domain facts /
  KFD-1 facts / KFD-2 trust report** -> *how domain facts enter Kungfu and become
  eligible for trust assessment* ([`fact-surface-admission.md`](fact-surface-admission.md))
  and [ADR-0051](../framework/core/docs/adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md).
- **KFD-2 assessment / TrustReport refresh / claim trigger / assessment worker /
  Assessment Episode / process assessor / thread assessor** -> *when and where
  trust is assessed* ([`kfd2-trust-assessment.md`](kfd2-trust-assessment.md))
  and [ADR-0052](../framework/core/docs/adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md).
- **latency / performance / zero-copy / serialization** → *the membrane*
  ([`architecture.md`](architecture.md)) and *the event model*
  ([`event-model.md`](event-model.md)).
- **durability / fsync / power loss / crash recovery / durable receipt /
  durable watermark / projection watermark / data loss** → *what Kungfu
  guarantees now and the staged strong-durability design*
  ([`durability-and-crash-recovery.md`](durability-and-crash-recovery.md)) and
  [ADR-0068](../framework/core/docs/adr/ADR-0068-tiered-durability-and-crash-recovery.md).
- **institution / institutional adoption / local ledger / system of record /
  production approval / single host / RPO / restore drill** → *whether an
  institution can adopt Kungfu as an authoritative local ledger, what evidence
  is required, and which controls remain operator-owned*
  ([`single-host-institutional-trust.md`](single-host-institutional-trust.md)).
- **performance qualification / release gate / p99 / p99.9 / throughput /
  backpressure / soak / Aeron comparison / Aeron-class** → *which absolute
  performance and regression evidence admits the single-host institutional
  profile, and why Aeron is informative rather than release authority*
  ([`single-host-performance-qualification.md`](single-host-performance-qualification.md)).
- **lightweight / too heavy / minimal install / independent package / libkungfu
  only / CLI without GUI / layer deletion / assembled runtime** → *which
  Kungfu should I start with* ([`choose-your-kungfu.md`](choose-your-kungfu.md)),
  then *what does each layer guarantee* ([`product-layers.md`](product-layers.md))
  and [ADR-0049](../framework/core/docs/adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md).
- **quant trading / agent runtime / games / virtual reality / virtual worlds /
  domain-neutral core / future application horizon** →
  [`domain-horizons.md`](domain-horizons.md).
- **how do I run it / get started / install** → *source to a binary*
  ([`buildchain.md`](buildchain.md)) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
  (A one-command run-it path is planned — see the build/release work tracked
  in [`known-limits.md`](known-limits.md).)
- **Shifu cache / central cache / cache profile / mirror schema / runner cache /
  inventory projection / local Shifu binary** → *how Shifu cache policy is owned,
  projected, discovered, and verified* ([`shifu/`](shifu/README.md)).
- **N-API / pybind11 / bindings / FFI** → *adapter boundaries*
  ([`adapters.md`](adapters.md)).
- **KFX / source authority / frozen first-party set / content pin /
  capability relay / sandboxed view / OS sandbox / service facet / planKfx** →
  *kfx topology* ([`kfx-topology.md`](kfx-topology.md)) and *extensions*
  ([`extensions.md`](extensions.md)).
- **config / `.kungfu` / `~/.kungfu-config` / `KF_CONFIG_HOME` / `KF_HOME` / UI font / UI scale /
  shortcuts / agent entrypoint** → *Kungfu config* ([`config.md`](config.md)).
- **workspace data home / `.kungfu/` / data root / Git worktree data /
  machine fallback / Home Workspace / Agent Work Inbox / config home
  rename / Open Workspace / recent workspace / lazy initialization** → *Kungfu
  config and Desktop workspace product*
  ([`config.md`](config.md)) and
  [`mission-control-workspaces.md`](mission-control-workspaces.md),
  [ADR-0035](../framework/core/docs/adr/ADR-0035-workspace-local-kungfu-data-home.md),
  and [ADR-0060](../framework/core/docs/adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md).
- **agent-mediated guidance / dual-first UX / advice / impact preview /
  authorization / execution receipt / stale advice / agent-operable product** →
  *Mission Control workspace product* ([`mission-control-workspaces.md`](mission-control-workspaces.md))
  and [ADR-0061](../framework/core/docs/adr/ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md).
- **supervisor / per-user supervisor / workspace coordinator / data-root coordinator /
  coordinator singleton / live registry / idle shutdown / daemonless storage** →
  *Kungfu supervisor and coordinator service* ([`runtime-service.md`](runtime-service.md))
  and [ADR-0036](../framework/core/docs/adr/ADR-0036-supervisor-and-workspace-master-topology.md).
- **SKILL.md / agent skill / skill catalog / context injection / Node manager /
  Python manager / skill audit / skill-manager view / kfx dependency binding** →
  *agent-facing Kungfu Skill* ([`skills.md`](skills.md)).
- **agent onboarding / mode selection / choose-mode / report mode / trace mode /
  managed-run / remote sync / local agent facts** → the installed Agent
  Onboarding Pack (`kungfu agent brief`, `kungfu agent capabilities --json`).
- **runtime storage / source sync / location / channel / payload store / blob
  store / fsck / compact / garbage collection / range export / projection
  rebuild** → *runtime storage service*
  ([`runtime-storage-service.md`](runtime-storage-service.md)).
- **episode / causal segment / causal closure / atomic safety / graceful
  degradation / capability contraction / qualification / Trust Report /
  lifecycle unit / run slice / export unit / import unit / tombstone / episode
  manifest / episode fsck** →
  *Episode object model* ([`episode-object-model.md`](episode-object-model.md))
  plus [`episode-atomicity-qualification.md`](episode-atomicity-qualification.md),
  [ADR-0033](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md),
  and [ADR-0042](../framework/core/docs/adr/ADR-0042-episode-atomic-safety-and-qualification.md).
- **episode manifest journal / manifest record / manifest delta / manifest
  authority / yijinjing manifest / Hana manifest / JSON manifest** → *Episode
  object model* ([`episode-object-model.md`](episode-object-model.md)) and
  [ADR-0034](../framework/core/docs/adr/ADR-0034-yijinjing-episode-manifest-journal.md).
- **signature / checksum / supply chain / SBOM** → *verify a release binary*
  (`provenance.md`, `blocked` — see [`known-limits.md`](known-limits.md)).
- **KFD / SDK scaffold / release gate evidence / contract scaffold / fact
  surface scaffold / agent interface scaffold / release passport downgrade** →
  *KFD-native SDK and release gates*
  ([`kfd-native-sdk-release-gates.md`](kfd-native-sdk-release-gates.md)).
- **trademark / fork / hosted service / provider compliance / cost attribution
  boundary** → [`../TRADEMARK.md`](../TRADEMARK.md),
  [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md), and
  [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md).

## How this map is maintained

- A document becomes a row here the moment it is *named*, even before it exists —
  so the gap is visible (`to write` / `blocked`), not hidden.
- A row's status must never claim more than the artifact delivers. A document
  that asserts a guarantee should also say where to verify it and how mature that
  guarantee is.
- `why` documents explain intent and may be read as narrative; `verify` and
  `use` documents are reference paths and should state, per claim, *what it
  guarantees → where to verify → current maturity*.
