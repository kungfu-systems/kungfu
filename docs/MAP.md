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
[Development](development/README.md), [Evolution](evolution/README.md), or
[Research](research/README.md).
Load-bearing decisions remain in [ADR](adr/README.md), and Shifu's development
contracts remain in [Shifu](shifu/README.md). Use the generated
[ADR Map](architecture/adr-map.md) when you want a visual domain overview or a bounded
decision neighborhood instead of the exhaustive question index.

## Map

| Your question | Document | Plane | Status |
|---|---|---|---|
| Which documentation route should I follow for my job? | [`README.md`](README.md) | use | current |
| How should an Agent explain or evaluate Kungfu without turning internal implementation density into the person's required mental model? | [`agent-analysis-protocol.md`](architecture/agent-analysis-protocol.md) | use, verify | current · task-specific compression required; relevant risks and uncertainty remain visible |
| How did Kungfu grow from the v4 polyglot mmap journal into Fact, Episode, Profile, Project Cut, Xinfa, native Work Control, Primitive governance, and recursive dogfood without making the current repository cross-section the onboarding path? | [`evolution/README.md`](evolution/README.md) + [`evolution/timeline.md`](evolution/timeline.md) + [`evolution/current-authority.md`](evolution/current-authority.md) | why, use, verify | generated from append-only first-party Era and Stage records; exact current contracts remain authoritative |
| What problem does Kungfu solve for an agent user, and what is the intended first-release experience? | [`../README.md`](../README.md) | use | pre-release |
| Where does Kungfu sit in the Agent Supply Chain, what is proved now, what is only protocol-enabled, and how should a vendor evaluate it? | [`agent-supply-chain.md`](architecture/agent-supply-chain.md) + [`vendor-agent-hub-embedding.md`](qualification/vendor-agent-hub-embedding.md) | why, use, verify | pre-release · exact-source and first-party qualification only; external adoption and a second independent production Hub are not claimed |
| Can this installed Kungfu act as the tested local KFD Agent Hub, what exactly was exercised, and how can a human or agent verify and explain the result? | [`kfd-agent-hub-20.md`](qualification/kfd-agent-hub-20.md) + `kungfu agent hub qualify --output-dir <new-directory> [--json]` | use, verify | experimental · exact installed artifact and two isolated local authority domains only; non-certifying |
| What would a safe one-command Docker Hub Starter own, how are protocol/demo/product responsibilities separated, and which evidence tiers still block an image or production claim? | [`hub-starter-docker.md`](architecture/hub-starter-docker.md) + [KF-ADR-019f9388-a139-7355-b9f2-f6dd9aa91042](./adr/KF-ADR-019f9388-a139-7355-b9f2-f6dd9aa91042.md) + [`kungfu-hub-starter-docker.contract.json`](../framework/hub-starter/kungfu-hub-starter-docker.contract.json) | why, use, verify | concept-only · static source contract passes; no Compose bundle, image, daemon qualification, recovery campaign, or production admission exists |
| How does the complete Kungfu system fit together behind that simple entry? | [`system-overview.md`](concepts/system-overview.md) | why, use | current |
| How do journal authority, Fact state, and Episode causal experience fit together, and why can Episode remain the flagship temporal object without becoming the only substrate? | [`fact-episode-action-runtime.md`](architecture/fact-episode-action-runtime.md) + [`the-episode.md`](concepts/the-episode.md) + [`vocabulary.md`](concepts/vocabulary.md) | why, use, verify | current integration model · Fact kernel writer and wider qualification remain staged |
| How is a new Primitive born with exact Agent context, discovered anywhere in the repository, queried from an installed product, promoted by evidence, and prevented from bypassing source acceptance? | [`primitive-management-plane.md`](architecture/primitive-management-plane.md) + [`incubation-passport-governance.md`](architecture/incubation-passport-governance.md) + [`../CONTRIBUTING.md`](../CONTRIBUTING.md#adding-or-promoting-a-primitive) + `kungfu primitive list --json` | use, verify | implemented · Task Chart-bound authoring, passport-only intake, repository-wide machine markers, generated catalog, read-only product CLI, and protected merge gate |
| Do I need the whole Kungfu App, or which smaller product should I start with? | [`choose-your-kungfu.md`](guides/choose-your-kungfu.md) | use | draft · adoption contract accepted; artifacts qualify independently in stages |
| If I leave or upgrade, what data and semantics stay portable, does one stable minor preserve meaning, and which versions and platforms are qualified? | [`exit-and-version-compatibility.md`](guides/exit-and-version-compatibility.md) + [`contracts.md`](qualification/contracts.md) + `kungfu exit verify --info --json` | use, verify | pre-release · public policy and installed discovery implemented; stable window and cross-platform release qualification remain open |
| What do the implementation terms mean (`kungfu` / `yijinjing` / journal / schema …)? | [`concepts.md`](concepts/implementation-concepts.md) | use | stable |
| Why is it built this way? What is load-bearing? | [`design-philosophy.md`](concepts/design-philosophy.md) | why | stable |
| Why compare Kungfu to SQLite, Git, and a flight recorder — and why is it neither observability nor blockchain? | [`design-philosophy.md`](concepts/design-philosophy.md#the-missing-infrastructure-layer-runtime-facts) | why | stable |
| Why does Kungfu start from accountability? | [`facts-before-trust.md`](concepts/facts-before-trust.md) | why | stable |
| Why does Kungfu begin with a minimal human sovereign core, which hidden Work Runtime responsibilities must leave human heads before participation scales, and what does the bounded public sample show or leave unproved? | [`bootstrapping-agent-work.md`](concepts/bootstrapping-agent-work.md) + [public work sample](https://kungfu.tech/about/bootstrapping/evidence/) + [evidence manifest](https://kungfu.tech/about/bootstrapping/evidence/data/manifest.json) | why, verify | current thesis · public activity and first-party declaration are separated · causality, general validity, release maturity, and independent adoption remain unproved |
| How does the complete product reduce Fact, Episode, Action Geometry, and trust machinery to a current-cut -> work -> next-cut loop? | [`project-cut-product-loop.md`](concepts/project-cut-product-loop.md) + [`project-cut-product-loop.md`](architecture/project-cut-product-loop.md) + [KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173](./adr/KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173.md) + [`project-cut-product-loop.md`](qualification/project-cut-product-loop.md) | why, use, verify | accepted product direction; initial design and prerequisites present, public product surface and release qualification incomplete |
| How do Initiatives, delegated Assignment work, runtime facts, proof, independent review, and decisions become one product, and how does authority leave the Atlas bridge? | [`work-control.md`](profiles/work-control.md) + [compatibility history](profiles/compatibility/README.md) + [KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8](./adr/KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8.md) + [KF-ADR-019f86da-4f90-719a-866a-28afd48c21dc](./adr/KF-ADR-019f86da-4f90-719a-866a-28afd48c21dc.md) + [KF-ADR-019f86da-4f90-732e-826c-e994acc20716](./adr/KF-ADR-019f86da-4f90-732e-826c-e994acc20716.md) | why, use, verify | pre-release · native authority, independent six-state review, and exact bounded continuation implemented |
| How does Desktop open and remember a workspace without creating `.kungfu` on read? | [compatibility history](profiles/compatibility/README.md) + [KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36](./adr/KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36.md) | why, use, verify | proposed · product design complete; implementation sliced |
| How can a first-time user manage agent work without a repository or predeclared Initiative? | [compatibility history](profiles/compatibility/README.md) + [KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36](./adr/KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36.md) | why, use, verify | proposed · Home Workspace and unassigned inbox designed |
| Why is agent-mediated guidance a first-class product interface rather than a later CLI integration? | [KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8](./adr/KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8.md) + [compatibility history](profiles/compatibility/README.md) | why, use, verify | proposed · dual-first advice/action/receipt contract designed |
| Where does the deeper Cost/State/Proof profile fit after the continuity-first entry, and what does it guarantee? | [`cost-state-proof-profile.md`](profiles/cost-state-proof-profile.md) | why, use, verify | draft · first progress and completion qualification implemented |
| Why this versioning / release design (don't replace it naively)? | [`version-release-design.md`](development/version-release-design.md) | why | stable |
| How does Kungfu consume a sealed candidate without adding a second publication authority? | [`publication-closure.md`](development/publication-closure.md) | use, verify | implemented · Buildchain owns the transaction; Kungfu checks its exact manifest, asset, channel, installer, and KFD closure |
| When must a change open a minor or major (and when must it not)? | [`versioning.md`](development/versioning.md) (rule: KFD-1, adopted by [KF-ADR-019f86da-4f90-7463-89b2-78cb94de9a0b](./adr/KF-ADR-019f86da-4f90-7463-89b2-78cb94de9a0b.md)) | verify | stable |
| When is a deprecated surface actually eligible for removal, what blocks Alpha or stable, and how is history retained? | [`deprecation-lifecycle.md`](development/deprecation-lifecycle.md) + [KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c](./adr/KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c.md) + `./shifu deprecation:audit -- --json` | use, verify | implemented source governance · release candidates fail closed on due or invalid applicable debt |
| Why was a past decision made? | [`adr/`](adr/) | why | stable · Core and Shifu share one gated registry |
| Which frontmatter fields are authoritative, and how are ADR status projections checked? | [`document-metadata.md`](development/document-metadata.md) | use, verify | stable · executable contract |
| What is the complete ADR implementation, evidence, review, and stable-readiness balance sheet? | [`adr/`](adr/) + `./shifu adr:audit -- --json` | verify | live · Core and Shifu share one authority and gate |
| How can I browse every ADR without reading UUID filenames or reconstructing the relationship graph? | [`architecture/adr-map.md`](architecture/adr-map.md) | use, why, verify | generated · complete corpus coverage with authoritative and navigation-only relations kept separate |
| How is the repository layered? | [`architecture.md`](architecture/overview.md) | use | stable |
| Which Kungfu layer can I adopt independently, and what does each product promise? | [`product-layers.md`](concepts/product-layers.md) + [`layer-product-release-qualification.md`](qualification/layer-product-release-qualification.md) + [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](./adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md) | why, use, verify | qualification implemented · publication remains a separate release action |
| Which application domains guide the neutral core without expanding the current roadmap? | [`domain-horizons.md`](concepts/domain-horizons.md) | why | draft · agent runtime current; trading evidence; games/virtual worlds horizon |
| What are the known limits / what is *not* yet guaranteed? | [`known-limits.md`](qualification/known-limits.md) | verify | stable |
| How do I launch a third-party PTY Agent without adding provider-specific code to Kungfu? | [`native-agent-adapters.md`](guides/native-agent-adapters.md) | use, verify | pre-release · declarative adapter and synthetic real-PTY qualification implemented |
| Can my institution use Kungfu as an authoritative local ledger on one host, and what evidence and controls are required? | [`single-host-institutional-trust.md`](qualification/single-host-institutional-trust.md) | use, verify | current-hardware candidate · production eligibility remains false |
| How do I configure visible, grouped durable, or synchronous durable writes, and what latency/throughput cost does each choice impose? | [`durability-configuration.md`](guides/durability-configuration.md) + [KF-ADR-019f86da-4f90-7585-ab0e-eea95d65b0d5](./adr/KF-ADR-019f86da-4f90-7585-ab0e-eea95d65b0d5.md) | use, why, verify | pre-release · explicit current-hardware candidate; fail-closed and production-ineligible |
| How do I upgrade Desktop or standalone CLI without interrupting active work, and when does the new runtime take effect? | [`upgrading.md`](guides/upgrading.md) + [`upgrade-compatibility.md`](development/upgrade-compatibility.md) + [KF-ADR-019f86da-4f90-7718-8d1f-6402a87408a7](./adr/KF-ADR-019f86da-4f90-7718-8d1f-6402a87408a7.md) | use, verify | pre-release · Core and archive CLI implemented; desktop transport, signed channels, native packages, and cross-platform qualification remain staged |
| What end-to-end performance gate must the single-host institutional profile pass, and how may Aeron be used as a comparator? | [`single-host-performance-qualification.md`](qualification/single-host-performance-qualification.md) | verify | one named agent-120 candidate slice qualified · wider product and production admission remain separate |
| Does Kungfu provide strong durability and crash recovery without giving up mmap latency, and what is implemented today? | [`durability-and-crash-recovery.md`](qualification/durability-and-crash-recovery.md) + [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](./adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md) | why, verify | current-hardware candidate implemented and admitted · physical power loss and production eligibility remain false |
| How do C++ / Python / Node share data zero-copy (the membrane)? | [`architecture.md`](architecture/overview.md) (membrane diagram) | verify | stable |
| What does it actually guarantee (layout / replay / compatibility)? | [`contracts.md`](qualification/contracts.md) | verify | stable |
| What KFD-2 release claims can Buildchain audit? | [`contracts.md`](qualification/contracts.md) (KFD-2 release claims) + [`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md) | verify | draft |
| What is the event / journal / replay model? | [`event-model.md`](architecture/event-model.md) | use | stable |
| What do Rewind, Replay, Recovery, and explicit re-execution mean, and where are their authority boundaries? | [`rewind.md`](guides/rewind.md) + [KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf](./adr/KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf.md) | why, use, verify | current contract · agent-work capture slice remains pre-release |
| How do I check whether runtime, Peers, storage, and Episodes are safe before ordinary work? | [`health.md`](guides/health.md) + [KF-ADR-019f86da-4f90-7b1a-8633-b9153e586424](./adr/KF-ADR-019f86da-4f90-7b1a-8633-b9153e586424.md) | use, verify | pre-release · fast/deep read-only contract and three-platform CI gate implemented |
| How do I plan and execute safe recovery without learning every internal service command? | [`recovery.md`](guides/recovery.md) + [`unified-recovery.md`](qualification/unified-recovery.md) + [KF-ADR-019f86da-4f90-7d58-b5b3-b6d5041dcab6](./adr/KF-ADR-019f86da-4f90-7d58-b5b3-b6d5041dcab6.md) | use, verify | pre-release · single-host fenced CLI candidate with exact portable macOS/Linux/Windows evidence; native product qualification and integration remain pending |
| How does Kungfu persist user facts, sync sources, and maintain storage over time? | [`runtime-storage-service.md`](architecture/runtime-storage-service.md) | use, verify | draft |
| What is the backend-neutral identity and history contract for Fact objects, versions, relations, Cuts, refs, CAS, receipts, and portable cross-language Root bytes? | [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](./adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) + [KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367](./adr/KF-ADR-019f86da-4f90-7acc-b6dc-d560f0fab367.md) + `kungfu contract show fact-cut-kernel --json` | why, use, verify | KFR2 is the explicit native writer authority · v1 remains an exact legacy reader · release qualification remains separate |
| Which Fact and Episode invariants exist, who owns them, how are they verified, and what exact evidence is required for release? | [`invariant-verification-system.md`](architecture/invariant-verification-system.md) + [`invariant-verification.md`](qualification/invariant-verification.md) + [KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00](./adr/KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00.md) + `./shifu invariant:verify -- --list --json` | why, use, verify, audit | source control plane and adversarial qualification implemented · release verdict requires the complete exact three-platform matrix |
| How do my domain facts enter Kungfu's declared fact world, remain replayable, and become eligible for trust assessment? | [`fact-surface-admission.md`](guides/fact-surface-admission.md) + [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](./adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I manage a long-running Mission, delegate Go work, inspect Cost/State/Proof, move evidence, cut over from Atlas, and hand an exact completion review to another agent? | [`work-control.md`](profiles/work-control.md) + [KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8](./adr/KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8.md) + [KF-ADR-019f86da-4f90-719a-866a-28afd48c21dc](./adr/KF-ADR-019f86da-4f90-719a-866a-28afd48c21dc.md) + [KF-ADR-019f86da-4f90-732e-826c-e994acc20716](./adr/KF-ADR-019f86da-4f90-732e-826c-e994acc20716.md) | why, use, verify | pre-release · native authority, full/thin portability, independent review, and mechanical continuation implemented |
| When does KFD-2 assess a claim, what does the workspace coordinator do, and how do Desktop processes and embedded threads share the model? | [`kfd2-trust-assessment.md`](qualification/kfd2-trust-assessment.md) + [KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302](./adr/KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md) | why, use, verify | draft · semantics accepted; implementation staged |
| How do I query current or historical runtime facts, and what proves the answer? | [`querying-runtime-facts.md`](guides/querying-runtime-facts.md) + [KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104](./adr/KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.md) | use, verify | draft · semantics accepted; implementation staged |
| What is an Episode, why is it the atomic trust boundary, and how is that claim qualified under faults and load? | [`episode-object-model.md`](concepts/episode-object-model.md) + [`episode-atomicity-qualification.md`](qualification/episode-atomicity-qualification.md) + [KF-ADR-019f86da-4f90-791c-9b90-4888cca36327](./adr/KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md) + [KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692](./adr/KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692.md) + [KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb](./adr/KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.md) | why, use, verify | draft |
| How do Fact and Episode form the contract-world ontology while Pursuit, Atlas, and Warrant form Action Geometry, and how does this preserve the combined-v1 Agent Work contract? | [`fact-episode-action-runtime.md`](architecture/fact-episode-action-runtime.md) + [`agent-work-state.md`](profiles/agent-work-state.md) + [KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8](./adr/KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8.md) + [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](./adr/KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md) | why, use, verify | accepted ontology boundary with staged compatibility migration and product qualification |
| What belongs to the Fact-Episode Ontology, Action Geometry, or a Domain Profile, and how are their machine identities kept separate? | [`fact-episode-action-runtime.md`](architecture/fact-episode-action-runtime.md) + [`agent-work-state.md`](profiles/agent-work-state.md) + [KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](./adr/KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md) + [KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8](./adr/KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8.md) | why, use, verify | accepted boundary · machine split and compatibility migration staged |
| Which library owns the KFD-7 reality substrate, which library owns the action-runtime membrane, and how do existing native bootstraps migrate without breaking callers? | [`kfd7-library-boundary.md`](architecture/kfd7-library-boundary.md) + [KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb](./adr/KF-ADR-019f86da-4f90-7b96-bc7d-4555833303eb.md) + [`libkungfu-abi-consumer.md`](guides/libkungfu-abi-consumer.md) | why, use, verify | implemented · consumer-ready pre-release successor ABI and compatibility façade qualified on Darwin arm64, Linux x64, and Windows x64 |
| What is the supervisor/coordinator topology, and how can the coordinator stay alive after the GUI closes? | [`runtime-service.md`](architecture/runtime-service.md) + [KF-ADR-019f86da-4f90-730a-a068-06e8758324e1](./adr/KF-ADR-019f86da-4f90-730a-a068-06e8758324e1.md) | use, verify | draft |
| How can a multi-machine timeline stay stable without one global clock? | [KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48](./adr/KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48.md) + [`event-model.md`](architecture/event-model.md) | why, verify | stable |
| Where must action-recording semantics live across C++ / Python / Node? | [KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81](./adr/KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81.md) + [`event-model.md`](architecture/event-model.md) | why, use | stable |
| What is a location role, and why does it not decide journal page size? | [KF-ADR-019f86da-4f90-71ac-bb91-32456981141a](./adr/KF-ADR-019f86da-4f90-71ac-bb91-32456981141a.md) + [`event-model.md`](architecture/event-model.md) | why, use | stable |
| Where are the Python / Node / framework adapter boundaries? | [`adapters.md`](architecture/adapters.md) | use | stable |
| How do I install Python packages (pandas/torch-class) into Kungfu's runtime? | [`python-environments.md`](guides/python-environments.md) + [KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05](./adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md) | use | stable |
| How do I go from source to a binary? | [`buildchain.md`](development/buildchain.md) (+ [`../CONTRIBUTING.md`](../CONTRIBUTING.md)) | use | stable |
| Is a Kungfu product Alpha available, what is currently blocked, where should public feedback go, and how is launch attention handled? | [`alpha-status.md`](guides/alpha-status.md) + [`known-issues.md`](guides/known-issues.md) + [`alpha-attention-operations.md`](development/alpha-attention-operations.md) | use, verify | available prerelease · `v4.0.0-alpha.1` published; later Alpha promotions remain separately gated |
| Which community-health defaults are shared across Kungfu Systems, and which intake authority remains repository-local? | [`community-health-baseline.md`](development/community-health-baseline.md) + [`community-health-baseline.json`](../.github/community-health-baseline.json) | why, use, verify | candidate · organization repository creation remains human-gated |
| Which C++ compiler/tool versions are supported, and why are Modules not in production? | [`cpp-toolchain.md`](development/cpp-toolchain.md) + [KF-ADR-019f86da-4f90-74d7-9ddd-84adc0f38f82](./adr/KF-ADR-019f86da-4f90-74d7-9ddd-84adc0f38f82.md) | why, use, verify | stable · machine contract and removable qualification slice implemented |
| What Python runtime ships inside the product, and what was pruned from it? | [KF-ADR-019f86da-4f90-7ecd-9660-81f9f74dc416](./adr/KF-ADR-019f86da-4f90-7ecd-9660-81f9f74dc416.md) + [`buildchain.md`](development/buildchain.md) | why, verify | stable |
| Where do disposable product caches and Python bytecode live without mutating a signed app or selected workspace? | [`product-cache-home.md`](architecture/product-cache-home.md) + [KF-ADR-019f9ec5-fa5d-76a3-9adb-71611ee67005](./adr/KF-ADR-019f9ec5-fa5d-76a3-9adb-71611ee67005.md) | use, why, verify | implemented · signed macOS directory Product qualified; cross-platform resolution source-qualified |
| When (and when not) does a component get written in Rust, and how is one added? | [`rust-adoption.md`](development/rust-adoption.md) | why, use | stable |
| What research evidence informed the Rust host and embedding boundaries? | [`rust-host-spike.md`](research/rust-host-spike.md) + [`libkungfu-embedding-membrane-spike.md`](research/libkungfu-embedding-membrane-spike.md) + [`libwasm-embedding-membrane-spike.md`](research/libwasm-embedding-membrane-spike.md) | why, verify | research · retained evidence, not current operative guidance |
| What must never change about the `shifu` entrypoints (and why)? | [KF-ADR-019f86da-4f90-7626-861e-3fdee887abd2](./adr/KF-ADR-019f86da-4f90-7626-861e-3fdee887abd2.md) | why, verify | stable |
| How does Shifu consume a central cache profile, who owns the schema, and how can a local binary expose it? | [`shifu/`](shifu/README.md) + [`shifu/cache-contract.json`](shifu/cache-contract.json) + [SHIFU-ADR-019f86da-4f90-7222-b238-9683f61e7288](./adr/SHIFU-ADR-019f86da-4f90-7222-b238-9683f61e7288.md) | why, use, verify | development · schema, fixtures, discovery, and repository conformance implemented |
| How are light and heavy gates registered, explained, compared across profiles, and planned without hard-coding project policy into Shifu? | [Gate control plane](shifu/gates.md) + [`shifu/gate-contract.json`](shifu/gate-contract.json) + [SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011](adr/SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011.md) | why, use, verify | development · read-only contract, validator, matrix, and planner implemented |
| How does a project submit documentation roles, verification obligations, providers, routes, and canonical roots without moving its semantics into Shifu? | [`shifu/documentation-contract.json`](shifu/documentation-contract.json) + [`../shifu.documentation.json`](../shifu.documentation.json) + [SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82](adr/SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82.md) | why, use, verify | development · v1 contract, diagnostics, roots, fixtures, and compatibility projection implemented |
| How does an Agent discover Xinfa, choose an exact route, obtain accurate CLI/schema help, distinguish source compilation from installed read-only projections, and fail closed on incomplete context? | [`xinfa-agent-context.md`](guides/xinfa-agent-context.md) + [`../crates/xinfa/`](../crates/xinfa/) + [`shifu/`](shifu/README.md) | use, verify | source Task Chart and installed precompiled Atlas paths documented and machine-gated |
| What is Xinfa, how does an Atlas project compile one immutable Xinfa Atlas plus bounded Human, Task Chart, and GUI views while preserving legacy Pack roots, how can a Project Cut bind source publication, Atlas state, Episode change, and explicit Git history without a hash cycle, and how does a clean clone continue from that settled shadow without promoting Git JSON to runtime authority? | [`xinfa-agent-context.md`](guides/xinfa-agent-context.md) + [`../crates/xinfa/`](../crates/xinfa/) + [`../framework/project-cut/`](../framework/project-cut/) + [KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8](adr/KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8.md) + [KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7](adr/KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7.md) + [KF-ADR-019f86da-4f90-79e3-8411-bbd133d55fff](adr/KF-ADR-019f86da-4f90-79e3-8411-bbd133d55fff.md) + [KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f](adr/KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f.md) + [KF-ADR-019f86da-4f90-7b52-a878-2326be81c03b](adr/KF-ADR-019f86da-4f90-7b52-a878-2326be81c03b.md) + [KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623](adr/KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623.md) + [KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be](adr/KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be.md) + [KF-ADR-019f86da-4f90-7b89-895f-21b4008bc732](adr/KF-ADR-019f86da-4f90-7b89-895f-21b4008bc732.md) + [KF-ADR-019f86da-4f90-77ba-8f80-470856cedce4](adr/KF-ADR-019f86da-4f90-77ba-8f80-470856cedce4.md) + [KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf](adr/KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf.md) + [KF-ADR-019f86da-4f90-7272-b883-cb90fc4613b1](adr/KF-ADR-019f86da-4f90-7272-b883-cb90fc4613b1.md) + [KF-ADR-019f86da-4f90-7d75-949b-4b5de42226ba](adr/KF-ADR-019f86da-4f90-7d75-949b-4b5de42226ba.md) + [KF-ADR-019f86da-4f90-72e8-8000-db544fb35a56](adr/KF-ADR-019f86da-4f90-72e8-8000-db544fb35a56.md) + [KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540](adr/KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540.md) | why, use, verify | immutable Atlas/Pack roots, bounded projections, qualified Git Episode and Xinfa providers, agent-first Project Cut settlement, lock-free Git history reconciliation, explicit shadow-only continuation, unified Rust workspace ownership, and witness-only baseline publication are implemented |
| Which gates does Kungfu currently have, what does each protect, and which dev/alpha/release profiles select it? | [Kungfu Gate catalog and policy matrix](qualification/gates/README.md) | use, verify, audit | qualification · generated matrix plus workflow-bound current-state policy |
| How do exact artifacts from all seven [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](./adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md) rows become one fail-closed release verdict? | [`layer-product-release-qualification.md`](qualification/layer-product-release-qualification.md) | use, verify, audit | implemented · Shifu Gate registry/profile/receipt closure; no publication implied |
| Where does a release binary come from, and how do I verify it? | [`installing-cli.md`](guides/installing-cli.md) + [`alpha-status.md`](guides/alpha-status.md) + the exact GitHub Release Passport | use, verify | available for `v4.0.0-alpha.1` · prerelease and exact-release boundaries apply |
| What gates must a release pass? | `provenance.md` + [`version-release-design.md`](development/version-release-design.md) | verify | partial |
| How do KFD-1/2/3 become SDK scaffolds and future release-gate evidence? | [`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md) | use, verify | draft |
| If kungfu itself misbehaves, how do I localize it? | [`debugging.md`](guides/debugging.md) | verify | stable |
| How does the current agent-work capture adapter create an Episode and provide a run-specific forensic view? | [`rewind.md`](guides/rewind.md) | use, verify | pre-release · executable source fixtures, not the identity of the whole product |
| What should an installed agent read first, which mode should it choose, and is the agent-facing control surface closed? | installed pack: `kungfu agent brief`, `kungfu agent capabilities --json`, `kungfu agent choose-mode --json`, `kungfu agent verify --json` | use, verify | stable |
| How does Kungfu keep intent, perspective, authority, and occurrence separate, and what remains before P17 is qualified? | [Agent Work State](profiles/agent-work-state.md) + [KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](adr/KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md) + `kungfu agent work-model --json` | why, use, verify | pre-release · public contract and discovery implemented; runtime and release qualification partial |
| How does a new Agent recover the next safe Action Loop step without the original chat? | [KF-ADR-019f86da-4f90-7a1f-a527-7bb8db2ceb1c](adr/KF-ADR-019f86da-4f90-7a1f-a527-7bb8db2ceb1c.md) + [`action-loop.contract.json`](../framework/action/action-loop.contract.json) | why, verify | pre-release · begin/checkpoint/resume and receipt-driven settlement staged with native cross-process recovery; source dogfood qualification pending |
| How do I write an extension (`kfx`)? | [`extensions.md`](architecture/extensions.md) + [stable service/webhook host ADR](adr/KF-ADR-019f9f8a-9f40-7d6e-a4d2-5a334a9ab201.md) | use | stable · view and service/webhook host v1; other runtime facets mid-migration |
| How can an Agent create and operate my own KFD-1/KFD-2 Profile without rebuilding Kungfu? | [`profile-authoring.md`](profiles/profile-authoring.md) + [`profile-lifecycle.md`](profiles/profile-lifecycle.md) + [KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1](./adr/KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md) | use, verify | pre-release · installed SDK, GUI manager, Mission reference Suite, and independent Week/Day qualification implemented on macOS ARM64 |
| Which parts of `.kungfu` are specified now, which version axis applies, and what remains before a portable semantic format is normative? | [`kungfu-format-contract.md`](architecture/kungfu-format-contract.md) + [`config.md`](guides/config.md) | use, verify | layout and journal contracts current or staged · standalone portable semantic format pre-normative |
| Where is global config, and how do agents read it? | [`config.md`](guides/config.md) | use | draft |
| How is a kfx loaded, trusted, and confined? (the topology) | [`kfx-topology.md`](architecture/kfx-topology.md) (design: [KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](./adr/KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md); trust boundary [KF-ADR-019f86da-4f90-79f1-8716-aca36b142847](./adr/KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md); uniform capability surface [KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9](./adr/KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md)) | use | draft · load plan + `service` facet proposed |
| How do I write an agent-facing Kungfu Skill? | [`skills.md`](architecture/skills.md) (first implementation slice; decided by [KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf](./adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md)) | use | draft |
| What license, trademark, service-use, and provider-compliance boundaries apply? | [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) + [`../TRADEMARK.md`](../TRADEMARK.md) + [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md) + [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md) | use | stable |

## Also asking about

The rows above are phrased as questions; if your wording differs, these keywords
route to the row that answers them:

- **arm64 / Apple Silicon / weak memory ordering / torn frames** → *what does it
  actually guarantee* ([`contracts.md`](qualification/contracts.md)) and *why was a decision
  made* ([KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](./adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md)).
- **thread-safety / concurrency / single-writer multi-reader / lock-free** →
  *what does it actually guarantee* ([`contracts.md`](qualification/contracts.md)) and *where
  should writer, reader-cursor, and page-lifetime ownership end*
  ([KF-ADR-019f86da-4f90-79ce-888e-6fd6476f10f4](./adr/KF-ADR-019f86da-4f90-79ce-888e-6fd6476f10f4.md),
  proposed).
- **SIGINT / replay exhaustion / subscriber error / loop stop / embedding error**
  → *who owns error propagation and process lifetime*
  ([KF-ADR-019f86da-4f90-71cc-8fc7-58226b337d8b](./adr/KF-ADR-019f86da-4f90-71cc-8fc7-58226b337d8b.md),
  proposed).
- **determinism / reproducibility / record-and-replay** → *what does it actually
  guarantee* ([`contracts.md`](qualification/contracts.md)) and *the event / journal / replay
  model* ([`event-model.md`](architecture/event-model.md)).
- **agent action timeline / causal action chain / forensic replay / mocked
  replay / external side effects / rewind replay boundary** → *what does Rewind
  replay, and what must it never silently re-execute*
  ([KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf](./adr/KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf.md)).
- **action recorder / action recording / Python recorder / Node recorder /
  JS recorder / C++ recorder / polyglot action surface / binding-only logic** →
  *where must action-recording semantics live across C++ / Python / Node*
  ([KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81](./adr/KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81.md)).
- **location role / source / sink / actor / service / journal page size /
  mmap size / storage policy** → *what is a location role, and why does it not
  decide journal page size*
  ([KF-ADR-019f86da-4f90-71ac-bb91-32456981141a](./adr/KF-ADR-019f86da-4f90-71ac-bb91-32456981141a.md)).
- **observer-relative timeline / timeline projection / source priority /
  global clock / multi-machine ordering / perspective / concurrent facts** →
  *how can a multi-machine timeline stay stable without one global clock*
  ([KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48](./adr/KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48.md)).
- **accountability / facts before trust / local proof before control** → *why
  does Kungfu start from accountability* ([`facts-before-trust.md`](concepts/facts-before-trust.md)).
- **KUNGFU / UNGFU / Never Guess / Facts Unfold / recursive name / why Kungfu**
  → *where the name came from and how its recursive meaning maps to the
  architecture* ([`why-kungfu.md`](concepts/why-kungfu.md)).
- **Work Control / Mission / Go / delegated responsibility / progress drift /
  completion claim / Atlas bridge / Cost State Proof / cost management profile**
  → *how Initiatives and delegated work become one proof-backed product*
  ([`work-control.md`](profiles/work-control.md)), *how the workspace product and
  five-question Initiative Home behave* ([compatibility history](profiles/compatibility/README.md)), then *what the first commercial
  profile packages* ([`cost-state-proof-profile.md`](profiles/cost-state-proof-profile.md))
  and [KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8](./adr/KF-ADR-019f86da-4f90-71be-a2aa-c8744fa340d8.md).
- **SQLite / Git for runs / flight recorder / runtime fact infrastructure /
  observability / OpenTelemetry / blockchain / polyglot semantic core** → *why
  Kungfu occupies a distinct runtime-fact layer*
  ([`design-philosophy.md`](concepts/design-philosophy.md#the-missing-infrastructure-layer-runtime-facts)).
- **query / SQL / historical state / time travel / temporal pattern / CEP /
  changelog / proof / lineage / QueryDefinition** → *how do I query current or
  historical runtime facts* ([`querying-runtime-facts.md`](guides/querying-runtime-facts.md))
  and [KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104](./adr/KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.md).
- **contract world / fact surface / fact admission / user facts / domain facts /
  KFD-1 facts / KFD-2 TrustReport** -> *how domain facts enter Kungfu and become
  eligible for trust assessment* ([`fact-surface-admission.md`](guides/fact-surface-admission.md))
  and [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](./adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md).
- **KFD-2 assessment / TrustReport refresh / claim trigger / assessment worker /
  Assessment Episode / process assessor / thread assessor** -> *when and where
  trust is assessed* ([`kfd2-trust-assessment.md`](qualification/kfd2-trust-assessment.md))
  and [KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302](./adr/KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md).
- **latency / performance / zero-copy / serialization** → *the membrane*
  ([`architecture.md`](architecture/overview.md)) and *the event model*
  ([`event-model.md`](architecture/event-model.md)).
- **durability / fsync / config / durable_group / durable_sync / power loss /
  crash recovery / durable receipt /
  durable watermark / projection watermark / data loss** → *what Kungfu
  guarantees now, how to request a profile, and the staged strong-durability
  design* ([`durability-configuration.md`](guides/durability-configuration.md),
  [`durability-and-crash-recovery.md`](qualification/durability-and-crash-recovery.md),
  [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](./adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md), and
  [KF-ADR-019f86da-4f90-7585-ab0e-eea95d65b0d5](./adr/KF-ADR-019f86da-4f90-7585-ab0e-eea95d65b0d5.md)).
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
  and [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](./adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md).
- **.kungfu / workspace layout / portable format / format version / journal
  epoch / persistence class / first-party manifest** → *which contracts exist
  now and which portable-format claims remain pre-normative*
  ([`kungfu-format-contract.md`](architecture/kungfu-format-contract.md)).
- **quant trading / agent runtime / games / virtual reality / virtual worlds /
  domain-neutral core / future application horizon** →
  [`domain-horizons.md`](concepts/domain-horizons.md).
- **how do I run it / get started / install** → the current Alpha
  [installation guide](guides/installing-cli.md), with the source/build path in
  [`buildchain.md`](development/buildchain.md) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
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
  [compatibility history](profiles/compatibility/README.md),
  [KF-ADR-019f86da-4f90-7e58-bb03-bee0f101dc01](./adr/KF-ADR-019f86da-4f90-7e58-bb03-bee0f101dc01.md),
  and [KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36](./adr/KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36.md).
- **agent-mediated guidance / dual-first UX / advice / impact preview /
  authorization / execution receipt / stale advice / agent-operable product** →
  *Work Control workspace product* ([compatibility history](profiles/compatibility/README.md))
  and [KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8](./adr/KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8.md).
- **supervisor / per-user supervisor / workspace coordinator / data-root coordinator /
  coordinator singleton / live registry / idle shutdown / daemonless storage** →
  *Kungfu supervisor and coordinator service* ([`runtime-service.md`](architecture/runtime-service.md))
  and [KF-ADR-019f86da-4f90-730a-a068-06e8758324e1](./adr/KF-ADR-019f86da-4f90-730a-a068-06e8758324e1.md).
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
  [KF-ADR-019f86da-4f90-791c-9b90-4888cca36327](./adr/KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md),
  and [KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb](./adr/KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.md).
- **episode manifest journal / manifest record / manifest delta / manifest
  authority / yijinjing manifest / Hana manifest / JSON manifest** → *Episode
  object model* ([`episode-object-model.md`](concepts/episode-object-model.md)) and
  [KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692](./adr/KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692.md).
- **signature / checksum / supply chain / SBOM** → *verify a release binary*
  (`provenance.md`, `blocked` — see [`known-limits.md`](qualification/known-limits.md)).
- **KFD / SDK scaffold / release gate evidence / contract scaffold / fact
  surface scaffold / agent interface scaffold / release passport downgrade** →
  *KFD-native SDK and release gates*
  ([`kfd-native-sdk-release-gates.md`](qualification/kfd-native-sdk-release-gates.md)).
- **invariant / constitutional / protocol / profile / policy / falsified /
  unqualified / object qualification receipt / Invariant Passport / semantic
  successor / refinement gate** → *Invariant Verification System*
  ([`invariant-verification-system.md`](architecture/invariant-verification-system.md),
  [`invariant-verification.md`](qualification/invariant-verification.md), and
  [KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00](./adr/KF-ADR-019f86da-4f90-77b2-863d-f04dbb185e00.md)).
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
