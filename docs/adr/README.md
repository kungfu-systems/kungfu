---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: adr-index
review_state: unreviewed
sensitivity: public
---

# Kungfu Architecture Decision Records

This directory records the significant architecture and design decisions behind
Kungfu and its load-bearing development system. Each ADR captures not just
*what* was decided but *why* — the context at
the time, the alternatives weighed, and the cost of reversal — so a later reader
can understand a design before changing it. ADRs are append-only: a decision that
changes is superseded by a new record, not edited away.

A record's **Status** says where it stands:

- **accepted** — the decision is authoritative; implementation progress remains
  a separate, machine-checked state.
- **proposed** — an open design question recorded for traceability; the decision
  is not yet made. These are deliberately written down before they are resolved
  so the question, and its current progress, are visible rather than implicit.
- **superseded** — retained as historical decision evidence, but replaced for
  current design by the ADR it names.

ADR frontmatter is the machine authority. The body status and this index are
human-readable projections checked by `./shifu docs:check`. Decision state,
implementation state, and review state are separate fields; see the
[Document Metadata Contract](../development/document-metadata.md). Do not add
compound implementation notes to the index Status column.

All records in this directory carry equal governance weight. `ADR-*` identifies
decisions owned by Kungfu's product, runtime, and Core architecture;
`SHIFU-ADR-*` identifies decisions owned by the Shifu development and execution
surface. The namespace expresses ownership and future portability, not a weaker
review, evidence, or release obligation. Both namespaces pass the same metadata,
development intent, alpha settlement, and stable admission gates.

## Audit and historical reconstruction

The registry is executable rather than manually summarized:

```sh
./shifu adr:audit                 # structural pass plus current debt inventory
./shifu adr:audit -- --json       # complete machine-readable record set
./shifu adr:audit -- --strict     # fail on review and evidence debt
./shifu adr:audit -- --release stable # fail on every current stable blocker
```

The ordinary documentation gate runs the structural audit on every relevant
pull request. Historical completion is intentionally a separate, reviewable
program:

1. Reconstruct `unknown` implementation states in subsystem batches from Git,
   PR, test, and qualification evidence; never infer completion from prose.
2. Replace each legacy evidence exemption only when immutable implementation
   and closure evidence is complete.
3. Bind implemented claims to qualification evidence that actually exercises
   the accepted scope, then remove the corresponding stable blocker.
4. Resolve `legacy-unreviewed` and `unreviewed` only through maintainer review.
5. Use the exact-release promotion gate for waivers; the side-effect-free audit
   reports the unwaived balance sheet and never grants an exception.

This ordering keeps status debt visible without weakening ordinary development,
while making stable publication fail closed until every accepted decision is
implemented and qualified or explicitly waived for that release.

## Index

| ADR | Status | Title |
|---|---|---|
| [0001](ADR-0001-yijinjing-publish-barrier.md) | accepted | yijinjing journal frame/page publish protocol → `atomic_ref` release/acquire |
| [0002](ADR-0002-yijinjing-schema-runtime-layout.md) | superseded | historical FlatBuffers-over-POD runtime-schema decision; schema scope replaced by ADR-0047 |
| [0003](ADR-0003-control-axis-python-coroutine-integration.md) | proposed | control axis — the Python coroutine integration layer (continue / redesign / drop) |
| [0004](ADR-0004-control-axis-node-watcher-snapshot-model.md) | proposed | control axis — the Node watcher snapshot model |
| [0005](ADR-0005-control-event-axis-modernization-assessment.md) | proposed | control / event axis modernization — a meta-assessment |
| [0006](ADR-0006-v4-frontend-platform-architecture.md) | accepted | v4 frontend = platform (capability SDK + loose kfx contract) + minimal reference app |
| [0007](ADR-0007-v4-tui-platform-reference-surface.md) | accepted | v4 TUI = the platform's second reference surface |
| [0008](ADR-0008-yijinjing-schema-layout-baseline.md) | accepted | yijinjing schema binary layout as the true compatibility invariant; schema-evolution policy |
| [0009](ADR-0009-load-bearing-self-bootstrap.md) | accepted | load-bearing self-bootstrap — the adoption path is the validation path |
| [0010](ADR-0010-adopt-kfd-1-release-versioning.md) | accepted | adopt KFD-1 — welded-surface registers decide patch, minor, and major |
| [0011](ADR-0011-v4-capability-sdk-contract.md) | accepted | v4 capability SDK contract — two vocabulary domains, runtime-tier declaration, five consumer-driven handles |
| [0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md) | proposed | extension isolation and the trusted channel on the runtime plane — trust by verifiable origin, default-deny OS sandbox, zero-copy only for the trusted channel |
| [0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md) | accepted | the extension execution contract — one uniform capability surface across trust tiers, restriction as transparent interception, a binding-less guest host |
| [0015](ADR-0015-kungfu-skill-agent-context-layer.md) | accepted | Kungfu Skill as the agent context layer above kfx |
| [0016](ADR-0016-managed-session-host-placement.md) | accepted | managed session host placement — move the durable session host to main so multiple OS windows share it |
| [0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md) | proposed | dual-host kfx loading — a host-agnostic load plan shared by GUI and CLI, and the background `service` facet as the first OS-sandbox caller |
| [0018](ADR-0018-runtime-storage-service-architecture.md) | accepted | runtime storage service as the persistence contract above journal, payloads, and projections |
| [0019](ADR-0019-git-like-source-sync-over-location-and-channel.md) | accepted | Git-like source sync over Kungfu location and channel |
| [0020](ADR-0020-agent-action-timeline-and-replay-boundary.md) | accepted | agent action timeline and rewind/replay boundary |
| [0021](ADR-0021-observer-relative-timeline-projection.md) | accepted | observer-relative timeline projection over causal facts |
| [0022](ADR-0022-core-action-recording-surface.md) | accepted | core action-recording surface lives in the C++ polyglot membrane |
| [0023](ADR-0023-frame-integrity-and-msg-type-allocation-gates.md) | accepted | frame integrity starts at the C++ recorder and raw carrier_type allocation is gated |
| [0024](ADR-0024-location-role-and-journal-page-policy.md) | accepted | location role replaces trading category and journal page size is storage policy |
| [0025](ADR-0025-carrier-type-and-action-envelope-semantics.md) | accepted | carrier type is transport metadata and business semantics live in action envelopes |
| [0026](ADR-0026-runtime-greenfield-core-surface.md) | accepted | runtime exposes a greenfield core surface, not trading typed helpers |
| [0027](ADR-0027-python-yijinjing-public-core-types.md) | accepted | Python yijinjing schema exposes only core public runtime types |
| [0028](ADR-0028-hash-taxonomy-and-integrity-algorithms.md) | accepted | hash taxonomy separates internal ids, frame checksums, and content hashes |
| [0029](ADR-0029-frame-checksum-v2-crc32c.md) | accepted | frame checksum v2 uses CRC32C receipt metadata |
| [0030](ADR-0030-manifest-scoped-sync-root-v1.md) | accepted | manifest-scoped sync root v1 |
| [0031](ADR-0031-fast-hash-xxh3.md) | accepted | fast internal hashes use XXH3 |
| [0032](ADR-0032-generic-source-service-v1.md) | accepted | generic source service v1 |
| [0033](ADR-0033-episode-causal-segment-object.md) | accepted | Episode is the first-class causal segment object |
| [0034](ADR-0034-yijinjing-episode-manifest-journal.md) | accepted | Episode manifest records live in the yijinjing journal format |
| [0035](ADR-0035-workspace-local-kungfu-data-home.md) | accepted | Workspace-local `.kungfu` is the default fact ledger home |
| [0036](ADR-0036-supervisor-and-workspace-master-topology.md) | superseded | Established the per-user supervisor and per-data-root coordinator topology |
| [0037](ADR-0037-storage-records-hana-core-kernel-metadata.md) | accepted | ADR-0018 storage-service records are Hana-core kernel metadata; JSON is an edge projection, not the contract |
| [0038](ADR-0038-location-namespace-terminology.md) | accepted | Location middle identity segment is namespace |
| [0039](ADR-0039-unified-view-interface-encapsulates-flatbuffers.md) | accepted | a single kungfu view interface is the sole FlatBuffers access point; raw FB is not called elsewhere |
| [0040](ADR-0040-runtime-fact-ledger-content-addressed-kv.md) | accepted | a first-class content-addressed store is a runtime fact-ledger primitive, with mutable KV and fleet topology kept as separate capabilities |
| [0041](ADR-0041-episode-manifest-first-class-journal-structure.md) | accepted | the Episode manifest is the object's trust boundary — POD journal records, one typed fold, and JSON at the edge |
| [0042](ADR-0042-episode-atomic-safety-and-qualification.md) | proposed | Episode is the atomic safety and fault-containment unit, qualified by evidence under load |
| [0043](ADR-0043-episode-identity-sealed-content-root.md) | proposed | Episode identity is two layers — a local coordinate plus a sealed content root committed in the manifest |
| [0044](ADR-0044-shifu-delegation-protocol.md) | accepted | The shifu delegation protocol — what installed binaries bake in forever |
| [0045](ADR-0045-kfx-execution-profiles-native-rust-wasm.md) | accepted | KFX execution profiles — Rust-primary native, WebAssembly components, managed runtimes, and subprocesses |
| [0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md) | accepted | Rust host trunk, layered CLI, and the assembled runtime distribution |
| [0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) | accepted | authoritative structured facts have one schema owner — Hana POD or FlatBuffers |
| [0048](ADR-0048-runtime-fact-query-semantics-and-changelog.md) | accepted | runtime fact queries use explicit bases, one logical plan, and a proof-carrying changelog |
| [0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md) | accepted | every product layer is independently complete and the core remains domain-neutral |
| [0050](ADR-0050-assembled-runtime-stdlib-pruning-policy.md) | accepted | stdlib pruning policy for the assembled runtime — family-level subtraction, declarative fail-closed manifest |
| [0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md) | accepted | KFD contract worlds govern fact admission, historical interpretation, and trust assessment |
| [0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md) | accepted | KFD-2 assessments are claim-triggered jobs coordinated by the workspace coordinator |
| [0053](ADR-0053-self-contained-episode-bundles.md) | proposed | Episode bundles carry their owned bytes, and import materializes them |
| [0054](ADR-0054-libwasm-production-runtime-and-release.md) | accepted | libwasm is a governed product runtime, not a copied spike library |
| [0055](ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md) | accepted | retire journal Session; separate live state from schema projections |
| [0056](ADR-0056-retire-legacy-journal-cli-lifecycle-tools.md) | accepted | journal lifecycle management belongs to Storage and Episode boundaries |
| [0057](ADR-0057-domain-neutral-live-runtime-terminology.md) | accepted | live runtime internals use reactor, peer, and coordinator; the public command is `kungfu runtime` |
| [0058](ADR-0058-yijinjing-explicit-mapping-policies.md) | accepted | yijinjing mmap behavior uses explicit access, creation, residency, and durability policies |
| [0059](ADR-0059-mission-control-mission-go-responsibility-model.md) | accepted | Mission Control composes Mission and Go responsibility over runtime facts; Atlas starts as a bridged authority |
| [0060](ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) | proposed | Desktop and CLI select Home or a project workspace and create its data home only on qualified write intent |
| [0061](ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md) | proposed | Agent-mediated guidance is a first-class interface over shared advice, preview, authorization, action, and receipt contracts |
| [0062](ADR-0062-journal-container-epoch-and-offline-conversion.md) | accepted | the journal container epoch is derived from its layout; cross-epoch replay is deferred offline conversion, not an online adapter |
| [0063](ADR-0063-yijinjing-concurrency-and-lifetime-contract.md) | proposed | yijinjing separates lock-free publication from cursor, write, and page-lifetime ownership |
| [0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md) | proposed | runtime libraries propagate structured errors; loop owners decide how execution stops |
| [0065](ADR-0065-schema-registry-consolidation.md) | accepted | the schema type registry has one authoritative set and trait-derived subsets; numeric tag comments retired; `msg_type` vocabulary finished except the frozen v1 embedding ABI |
| [0066](ADR-0066-native-cpp-toolchain-contract-and-modules-hold.md) | accepted | native compilers share one C++ contract; modules remain qualification-only |
| [0067](ADR-0067-schema-registry-compile-time-contract-welds.md) | accepted | schema contract invariants welded at compile time — `carrier_type` tag uniqueness and payload layout↔`schema_version` binding (reusing the ADR-0062 fingerprint) |
| [0068](ADR-0068-tiered-durability-and-crash-recovery.md) | accepted | tiered durability separates hot mmap visibility, durable fact admission, rebuildable projections, and later replication |
| [0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md) | accepted | Agent-first KFX Profile Suites carry domain semantics over a domain-neutral Core |
| [0070](ADR-0070-peer-communication-primitives-layering.md) | accepted | peer communication primitives are layered (channel routing vs outlet output); Band renamed Outlet; off-thread writing decoupled and establish-channel unification deferred, trigger-gated |
| [0071](ADR-0071-cli-language-split-and-membrane-diagnostic-surface.md) | accepted | CLI language fit is decided by where the work lives and what the embedding membrane reaches, not clap-vs-click; substrate diagnostics (fsck/verify) belong in Rust via a grown read-only membrane surface, not per-command rewrites; product/UI/orchestration stays Python |
| [0072](ADR-0072-frame-identity-layering-journal-local-vs-ledger-global.md) | accepted | frame identity is layered: frame_uid stays journal-local (fixing the deterministic page-8-bit wrap), while permanent ledger-global uniqueness is the Episode content root + structural stream_position (stream_id, container_epoch, sequence), not a widened probabilistic frame_uid |
| [0073](ADR-0073-buildchain-adr-release-admissibility.md) | accepted | Buildchain promotion is the settlement boundary for ADR implementation truth: dev declares bounded delivery, alpha settles qualified progress, and stable admits no unaccounted accepted decision |
| [0074](ADR-0074-canonical-adr-authority-and-lifecycle-audit.md) | accepted | `docs/adr/` is the sole Core and Shifu decision authority, with typed redirects and executable lifecycle, evidence, and release audit |
| [0075](ADR-0075-profile-level-kfd3-qualification.md) | accepted | conforming Profile Suites declare a content-bound collaboration facet; Kungfu projects and qualifies one shared Human/Agent protocol instead of making each Profile reimplement KFD-3 |
| [0076](ADR-0076-documentation-directory-authority.md) | accepted | canonical public documentation is organized by maintenance authority, and the source tree carries no speculative pre-release compatibility paths |
| [0077](ADR-0077-agent-coordination-on-live-runtime.md) | accepted | agent coordination on the live runtime: same-host bounded-mission peers with coloop-backed named locks/signals/instruct and audited Episodes replace git-based coordination; the first post-trading consumer ADR-0070 anticipated, v1 cooperative-trust with capability confinement deferred |
| [0078](ADR-0078-minimal-generic-core-closure-and-membrane-decode-checksum.md) | accepted | libkungfu owns the minimal closed set of generic `.kungfu` maintenance/self-describing primitives; domain interpretation of frames (rewind/work/atlas) stays in outer rings on the membrane; expose generic frame decode and frame checksum on pybind + the C-ABI membrane and de-dup the Python re-implementations |
| [0079](ADR-0079-native-work-agent-console-loop.md) | accepted | work authority and execution placement stay independent while a generic WorkRef, stable WorkConsole, machine-global Agent Runtime Profile and content-bound KFD-3 envelope join Mission Control, Agent Console, Episodes and external report into one product loop |
| [0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md) | accepted | live runtime activation is capability-driven and topology-neutral; readiness is cut-bound while process and GUI facts remain diagnostics |
| [0081](ADR-0081-durable-agent-session-capsule-control-plane.md) | accepted | one fenced AgentSessionCapsule owns each live attempt PTY and exposes a shared, receipt-bearing interaction port without turning terminal delivery into work proof |
| [0082](ADR-0082-cpp23-rx-core-language-strategy.md) | accepted | the core stays C++23 + Rx: the single-writer architecture removes the borrow-checker problem domain, registry welds provide set-level exhaustiveness, the Rx routing algebra is a net expressiveness advantage, and a three-tier error policy plus staged increments close the per-site gaps |
| [0083](ADR-0083-core-system-kfx-profile-kfx-capability-boundary.md) | accepted | capability ownership follows Core authority, replaceable System KFX projections, and domain-owning Profile KFX; first-class capability does not require a hard-coded Shell page |
| [0084](ADR-0084-kfd1-durability-policy-and-runtime-admission.md) | accepted | KFD-1 durability configuration records requested policy; native runtime admission derives the effective fail-closed policy |
| [0085](ADR-0085-codex-app-server-structured-hybrid-adapter.md) | accepted | Codex App Server is an exact-version structured-hybrid adapter over the shared Agent Interaction Port, with attempt-level PTY fallback and fail-closed schema drift |
| [0086](ADR-0086-live-peer-continuity-and-coordinator-authority.md) | accepted | live peers reconnect through a shared runtime-generation and coordinator-epoch authority fence, then rebootstrap before readiness |
| [0087](ADR-0087-versioned-product-runtime-upgrade-control-plane.md) | accepted | product upgrades install verified immutable runtime images first; Core alone plans, fences, activates, rolls back, and reference-collects generations for GUI and CLI |
| [0088](ADR-0088-core-native-multisurface-kfx-runtime.md) | accepted | one Core-native, fenced KFX runtime owns extension authority for GUI, TUI, CLI, and agents; language hosts remain replaceable projections |
| [0089](ADR-0089-transactional-kfx-package-and-lifecycle-authority.md) | accepted | KFX packages are immutable content-addressed artifacts and Core owns transactional install, activation, rollback, removal, and retained lifecycle facts |
| [0090](ADR-0090-kfd-aware-kfx-trust-and-buildchain-admission.md) | accepted | KFX admission consumes KFD facts and exact Buildchain attestations to reduce friction without confusing provenance, capability fitness, or Product System authority |
| [0091](ADR-0091-surface-neutral-kfx-contributions-and-thin-bindings.md) | accepted | KFX contributes semantics once while GUI, TUI, CLI, and agents use thin bindings and host-specific projections over the same plans and receipts |
| [0092](ADR-0092-xinfa-product-and-incubation-boundary.md) | accepted | Xinfa is an independently versioned and extractable context compiler product; Shifu and Kungfu may integrate only through thin public-contract adapters |
| [0093](ADR-0093-xinfa-dual-first-verified-context-contract.md) | accepted | Xinfa compiles one content-addressed, drift-aware authority graph into capability-equivalent human and Agent routes over the same cut and evidence status |
| [0094](ADR-0094-xinfa-repository-context-pack.md) | accepted | Xinfa compiles exact repository sources into a portable, dual-first Context Pack with layered roots, bidirectional coverage, offline verification, and explainable impact |
| [0095](ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md) | accepted | Xinfa Atlas is the immutable compiled context primitive; legacy Context Pack v1 remains a verified, non-reinterpreted input |
| [0096](ADR-0096-xinfa-bounded-projection-and-task-chart.md) | accepted | Xinfa compiles bounded Human, Task Chart, and GUI projections from one Atlas while generated outputs remain provider-excluded derived data |
| [0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md) | accepted | Project Cut binds source publication, one Xinfa Atlas, and admitted Kungfu Episode change without collapsing their authority or introducing a Git hash cycle |
| [0098](ADR-0098-project-cut-v1-canonical-root-and-source-projection.md) | accepted | Project Cut v1 freezes a closed canonical root input, explicit source projection policy, separate semantic/artifact/receipt identities, and fail-visible diagnostics |
| [0099](ADR-0099-git-workspace-episode-provider.md) | accepted | Git Workspace stores qualified sealed Episodes as immutable per-Episode JSONL segments without becoming Episode authority |
| [0100](ADR-0100-xinfa-qualified-episode-evidence-provider.md) | accepted | Xinfa admits qualified sealed Episode evidence into a deterministic successor Atlas without becoming Episode authority |
| [0101](ADR-0101-project-cut-agent-first-settlement.md) | accepted | An agent-first settlement CLI binds the Git index, successor Atlas, Episode providers, and Project Cut while hooks remain thin and non-authoritative |
| [0102](ADR-0102-project-cut-git-history-bindings.md) | accepted | Explicit rooted observations qualify N:M Project Cut and Episode publication across Git rewrites, merges, recovery, refs, and concurrent worktrees without changing Cut roots or treating ancestry as causal authority |
| [0103](ADR-0103-shadow-only-workspace-continuation.md) | accepted | Git-settled Episode and Project Cut shadows can open read-only without creating local runtime or becoming Episode authority; explicit continuation creates the write boundary |
| [0104](ADR-0104-native-mission-go-authority-cutover.md) | accepted | Mission/Go authority cuts over once at an exact Atlas parity, Project Cut, and successor Atlas root; rollback is append-only and never enables dual writers |
| [0105](ADR-0105-independent-review-and-exact-continuation.md) | accepted | Completion Claims bind exact Git, Atlas, Project Cut, Episode, proof, and availability roots; independent review seals a six-state verdict and bounded exact-root continuation plan |
| [0106](ADR-0106-destination-owned-episode-admission.md) | accepted | Episode Admission is destination-owned and transport-neutral; push and pull share one rooted, drift-aware protocol and proof receipt |
| [0107](ADR-0107-unified-read-only-product-diagnostics.md) | accepted | Product diagnostics are one read-only runtime, Peer, storage, and Episode projection with stable actionable problems and fail-closed unknown outcomes |
| [0108](ADR-0108-declared-event-route-topology.md) | accepted | Event routes record phase and shared-state access while composition stays imperative; a same-phase reader/writer assertion makes ordering intent falsifiable and attributes catch-all consumers no text search can find |
| [0109](ADR-0109-four-object-agent-work-state-contract.md) | accepted | Real-world agent work preserves Pursuit, Atlas, Warrant, and Episode as independently addressable roles with no silent semantic inheritance |
| [0110](ADR-0110-structured-go-route-resolution.md) | accepted | Automatic go context resolves project-declared structured task intent against one verified Xinfa Atlas and fails visibly on ambiguity or omitted authority |
| [0111](ADR-0111-fenced-unified-recovery-entry.md) | accepted | Unified recovery is a plan-first fenced orchestrator over existing runtime, Peer, storage, and Episode authorities |
| [0112](ADR-0112-backend-neutral-fact-cut-kernel.md) | accepted | Stable Fact identity, immutable versions, typed non-inheriting relations, clock-free Cuts, named refs, expected-old CAS, and receipts form one backend-neutral kernel |
| [0113](ADR-0113-authority-atomic-storage-backend-switch.md) | accepted | Storage backend changes are authority-atomic, resumable operations |
| [0114](ADR-0114-xinfa-native-semantic-project-authority.md) | accepted | Project declarations and Shifu exact discovery feed one Xinfa-owned semantic project materializer with no duplicate graph authority |
| [0115](ADR-0115-xinfa-context-quality-ratchet.md) | accepted | Xinfa context quality is a deterministic, adversarial, cut-bound qualification with frozen recall, omission, relevance, ambiguity, degradation, stale-root, correction, fallback, cost, and expansion ratchets |
| [0116](ADR-0116-project-cut-merge-safe-composition.md) | accepted | Scoped composition receipts bind concurrent task Cuts to merge candidates and fail closed without rewriting frozen Cut roots or disguising global DAG audit as a scoped pass |
| [0117](ADR-0117-action-mjs-dual-host-kernel-bootstrap.md) | accepted | One manifest-bound Action MJS package runs through Shifu pinned Node and installed Kungfu embedded libnode without host identity changing semantics or PATH Node fallback |
| [0118](ADR-0118-kungfu-single-entry-action-primitive-cli.md) | accepted | Kungfu is the only public CLI executable; Xinfa and the Atlas, Pursuit, Warrant, and Episode role groups remain independently bounded behind its command tree |
| [0119](ADR-0119-recoverable-action-loop-coordination-contract.md) | accepted | Action Loop recovery follows explicit five-role roots and the accepted authority-receipt prefix without creating a second fact store, receipt source, or cross-system transaction |
| [0120](ADR-0120-kfd7-library-boundary-and-successor-abi.md) | accepted | KFD-7 fixes the source/static reality kernel, installed action-runtime membrane, and one compatibility-preserving successor ABI |
| [0121](ADR-0121-portable-fact-root-canonical-encoding.md) | accepted | KFR2 freezes typed portable Fact Root preimages, independent byte-level conformance, and explicit legacy mapping without reinterpreting v1 Roots |
| [SHIFU-0001](SHIFU-ADR-0001-cache-profile-contract-and-ownership.md) | accepted | Cache profiles are Shifu-owned contracts; inventories project instances and Buildchain owns process |
| [SHIFU-0002](SHIFU-ADR-0002-local-artifact-catalog-and-safe-promotion.md) | accepted | Shifu and Kungfu product artifacts share provenance-aware, Git-safe local promotion semantics |
| [SHIFU-0003](SHIFU-ADR-0003-uv-effective-lock-cache-enforcement.md) | accepted | Strict uv cache execution uses a disposable effective lock while canonical locks stay public |
| [SHIFU-0004](SHIFU-ADR-0004-gate-control-plane-contract.md) | accepted | Shifu owns the project-independent Gate contract; projects own catalogs and explicit policy profiles |
| [SHIFU-0005](SHIFU-ADR-0005-repo-root-discovery-and-jurisdiction.md) | accepted | Two-level repo discovery; a buildchain-managed repo joins by declaring `registrar: shifu`, and shifu asks buildchain for the KFD-3 layout instead of copying it |
| [SHIFU-0006](SHIFU-ADR-0006-documentation-protocol-and-provider-boundary.md) | accepted | Shifu owns a project-independent documentation submission, canonical-root, diagnostics, and receipt contract while projects retain semantic providers and routes |
| [SHIFU-0007](SHIFU-ADR-0007-closed-world-workflow-release-admission.md) | accepted | Kungfu classifies the complete workflow execution surface and grants product or channel authority only through an independently reverified sealed capability |
| [SHIFU-0008](SHIFU-ADR-0008-human-surface-closure-and-xinfa-impact-authority.md) | accepted | Shifu closes exact human surfaces and delegates canonical drift, impact, and route authority to Xinfa |

## Reading by theme

- **Data axis (the journal & type system)** — [0001](ADR-0001-yijinjing-publish-barrier.md)
  (publish synchronization), [0008](ADR-0008-yijinjing-schema-layout-baseline.md)
  (the closed POD layout as a compatibility invariant), and
  [0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) (one schema
  owner per structured fact: Hana POD closed set or FlatBuffers open layer).
  [0058](ADR-0058-yijinjing-explicit-mapping-policies.md) separates mmap
  authority from residency and durability requests without changing the wire
  or POD layouts.
  [0062](ADR-0062-journal-container-epoch-and-offline-conversion.md) derives the
  journal container epoch from the page/frame header layout itself, so an
  unversioned layout change cannot ship, and keeps cross-epoch replay off the hot
  path as deferred offline conversion.
  [0063](ADR-0063-yijinjing-concurrency-and-lifetime-contract.md) narrows the
  lock-free claim to publication/tail reads and proposes explicit writer
  transactions, a thread-affine reader cursor, and ownership-driven page
  reclamation.
  [0068](ADR-0068-tiered-durability-and-crash-recovery.md) keeps the hot mmap
  plane while adding explicit visible/durable/projected watermarks, typed
  receipts, an independent durable-ingest boundary, and crash qualification.
  [0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md)
  classifies storage-only, live-optional, and live-required operations; binds
  readiness to a durable cut and one fenced generation; and keeps process
  topology behind a capability-driven RuntimeHost adapter.
  [0002](ADR-0002-yijinjing-schema-runtime-layout.md) is retained as the
  superseded historical decision that preceded this split.
- **Control / event axis** — [0003](ADR-0003-control-axis-python-coroutine-integration.md)
  (Python coroutine integration), [0004](ADR-0004-control-axis-node-watcher-snapshot-model.md)
  (Node watcher snapshot model), with [0005](ADR-0005-control-event-axis-modernization-assessment.md)
  the meta-assessment of whether v4 should touch this axis at all.
  [0064](ADR-0064-runtime-error-propagation-and-stop-ownership.md) proposes the
  narrower correctness boundary that libraries propagate structured errors and
  each loop owner controls stopping, without reopening ADR-0005's frozen Rx
  routing/fan-out decision.
- **Frontend platform** — [0006](ADR-0006-v4-frontend-platform-architecture.md)
  (platform + reference app), [0007](ADR-0007-v4-tui-platform-reference-surface.md)
  (the TUI reference surface).
- **Extension trust boundary** — [0011](ADR-0011-v4-capability-sdk-contract.md)
  (the tier declaration and the zero-copy-vs-serialized split for views),
  [0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md) (extending
  that boundary to the runtime plane: trust by verifiable origin, an OS sandbox
  for the default tier, and a trusted channel for zero-copy), and
  [0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md)
  (how an extension addresses that boundary: one uniform capability surface
  across tiers, restriction as transparent interception, so one source runs in
  either tier and a later confinement does not force a rewrite), and
  [0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md)
  (who assembles it: one host-agnostic load plan shared by the GUI and CLI, and
  a background `service` facet as the first production caller of the OS sandbox).
  [0045](ADR-0045-kfx-execution-profiles-native-rust-wasm.md) proposes the
  orthogonal execution-profile axis: Rust-primary native, WASM components,
  managed runtimes, and subprocesses, without weakening the trust decision.
  [0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md) adds the
  domain-semantic Profile closure without giving Suite members authority over
  fact admission, assessment truth, or their own lifecycle.
- **Agent capability layer** — [0015](ADR-0015-kungfu-skill-agent-context-layer.md)
  (Kungfu Skill as the agent-facing layer above kfx: `SKILL.md` as the minimum
  valid source, compact catalog injection, Node/Python manage modes, and kfx
  dependency composition without bypassing the kfx trust gate).
- **Runtime facts, storage, sync, and replay** —
  [0018](ADR-0018-runtime-storage-service-architecture.md) (the storage service
  above journal, payloads and projections),
  [0019](ADR-0019-git-like-source-sync-over-location-and-channel.md)
  (source sync over `location` and `channel`),
  [0020](ADR-0020-agent-action-timeline-and-replay-boundary.md) (the causal
  action timeline and replay boundary), and
  [0021](ADR-0021-observer-relative-timeline-projection.md) (stable
  observer-relative timeline projection without a universal global clock), and
  [0022](ADR-0022-core-action-recording-surface.md) (the C++ core
  action-recording surface that Python/Node bindings wrap), and
  [0023](ADR-0023-frame-integrity-and-msg-type-allocation-gates.md) (the first
  frame-integrity receipt slice plus the source gate that prevents new raw
  business carrier allocations),
  [0024](ADR-0024-location-role-and-journal-page-policy.md) (neutral location
  roles and the rule that journal page size is storage policy, not role
  identity), and
  [0025](ADR-0025-carrier-type-and-action-envelope-semantics.md) (the rename
  from `msg_type` to `carrier_type` and the rule that business semantics live
  in action envelopes), and
  [0026](ADR-0026-runtime-greenfield-core-surface.md) (the rule that runtime
  bindings expose neutral raw/envelope/runtime APIs instead of generated
  trading typed helpers), and
  [0027](ADR-0027-python-yijinjing-public-core-types.md) (the matching rule that
  Python `pykungfu.yijinjing.types` only exposes core public runtime structs,
  while the full compiled schema registry stays internal to runtime decode
  paths), and
  [0028](ADR-0028-hash-taxonomy-and-integrity-algorithms.md) (the rule that
  fast internal hashes, frame checksums, content hashes, and future trust roots
  are separate algorithm surfaces), and
  [0029](ADR-0029-frame-checksum-v2-crc32c.md) (the v2 frame receipt checksum
  algorithm selection and fsck metadata rules), and
  [0030](ADR-0030-manifest-scoped-sync-root-v1.md) (the first manifest-scoped
  sync root that binds payload/action/frame receipt evidence for export/fsck),
  [0031](ADR-0031-fast-hash-xxh3.md) (the v4 greenfield switch of internal
  fast hashes to XXH3_64 / XXH3_128), and
  [0032](ADR-0032-generic-source-service-v1.md) (the first generic source
  registry, accepted-range, bundle import/export, and fsck service slice), and
  [0033](ADR-0033-episode-causal-segment-object.md) (Episode as the first-class
  causal segment object for storage, sync, fsck, import/export, and timeline
  projection), and
  [0034](ADR-0034-yijinjing-episode-manifest-journal.md) (Episode manifest
  records as yijinjing first-class data structures in a manifest journal, with
  JSON only as export/debug/folded view), and
  [0035](ADR-0035-workspace-local-kungfu-data-home.md) (workspace-local
  `.kungfu/` as the default Episode/fact ledger home, with `~/.kungfu-config`
  as the user config home and `KF_HOME` retained as machine fallback), and
  [0036](ADR-0036-supervisor-and-workspace-master-topology.md) (a per-user
  supervisor routes CLI/GUI/TUI entrypoints to per-data-root masters while
  storage remains daemonless), and
  [0037](ADR-0037-storage-records-hana-core-kernel-metadata.md) (the ADR-0018
  storage-service record family — source registry, import/export manifest,
  fsck report, accepted range — are Hana-core kernel metadata like the Episode
  manifest of ADR-0034, journal-backed and delta-append; JSON file authorities
  and unconsumed heap structs are retired, the remaining JSON-shaped semantic
  service interface is staged for typed conversion, and payload bodies are
  opaque content-addressed bytes, not `.json` text), and
  [0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) (the
  system-wide schema authority rule, typed-view/opaque-body boundaries, JSON
  edge-only policy, and exclusive Hana/FlatBuffers SQLite projection paths),
  [0048](ADR-0048-runtime-fact-query-semantics-and-changelog.md) (the explicit
  current/historical query basis, shared logical plan, proof envelope, and
  resumable changelog contract),
  [0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md) (the KFD-1
  declaration, replayable fact-admission, historical interpretation, and KFD-2
  trust-assessment path),
  [0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md) (claim-triggered
  assessment jobs, workspace-coordinator coordination, Assessment Episodes, and
  equivalent process/thread executors), and
  [0059](ADR-0059-mission-control-mission-go-responsibility-model.md) (the
  Mission/Go responsibility domain, Atlas bridge authority, and Cost/State/Proof
  profile composition),
  [0060](ADR-0060-desktop-workspace-selection-and-lazy-data-home.md) (Desktop
  Home/project workspace selection, global recent-workspace state,
  first-run Agent Work Inbox, and write-intent-bound data-home initialization),
  [0061](ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md)
  (the dual-first inspect/advice/preview/authorize/action/receipt protocol), and
  [0055](ADR-0055-retire-journal-session-and-separate-runtime-state-from-projection.md)
  (Episode replaces the retired Session replay anchor), and
  [0056](ADR-0056-retire-legacy-journal-cli-lifecycle-tools.md) (journal
  lifecycle management belongs to Storage/Episode rather than loose-file CLI
  archive and clean commands),
  [0058](ADR-0058-yijinjing-explicit-mapping-policies.md) (explicit mapping and
  page-open policies, with coordinator-only pre-creation), and
  [0042](ADR-0042-episode-atomic-safety-and-qualification.md) (Episode atomic
  safety as evidence-bounded capability, graceful degradation, monotonic repair,
  fault containment, and qualification under scale).
- **Host & distribution** — [0044](ADR-0044-shifu-delegation-protocol.md)
  (what installed launcher binaries bake in forever) and
  [0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md) (the target host
  topology: Rust trunk over satellite runtimes, the CLI layering law, and the
  assembled exact-runtime distribution contract that retires the freezer), and
  [0054](ADR-0054-libwasm-production-runtime-and-release.md) (the governed
  dual-engine WASM runtime, explicit capability grant, fact receipts, and
  release artifact qualification contract).
  Shifu-owned decisions that are not Kungfu Core decisions retain the
  `SHIFU-ADR-*` namespace in this same registry.
- **Cross-cutting principle** — [0009](ADR-0009-load-bearing-self-bootstrap.md)
  (load-bearing self-bootstrap), which also names the general law that
  [`docs/architecture/overview.md` § The build dogfoods the SDK](../architecture/overview.md)
  is one instance of, and
  [0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md) (the
  independent adoption closure, downward dependency, layer-deletion, and
  domain-neutral kernel constraints).

## Related design documents

- [`docs/architecture/overview.md`](../architecture/overview.md) — how the repository
  is layered and the principle that shapes it.
- [`docs/development/version-release-design.md`](../development/version-release-design.md) —
  the versioning / release mechanism rationale, and the compatibility invariant
  below the tag.
- [`docs/architecture/skills.md`](../architecture/skills.md) — the user-facing and
  implementation-facing design for Kungfu Skills.
- [`docs/architecture/runtime-storage-service.md`](../architecture/runtime-storage-service.md) —
  the staged storage command surface, fsck/export path, and source-adapter
  direction.
- [`docs/concepts/episode-object-model.md`](../concepts/episode-object-model.md) —
  the Episode object model, causal closure invariant, and storage migration
  direction.
- [`docs/research/journal-page-sizing-and-episode-reclamation.md`](../research/journal-page-sizing-and-episode-reclamation.md) —
  the design judgment constraining the future Episode-aware physical layout:
  page-size variation only for max-frame, packing over per-Episode pages, and
  tombstone-then-cold-path GC (ADR-0033/0034, ADR-0055/0056).
- [`docs/qualification/episode-atomicity-qualification.md`](../qualification/episode-atomicity-qualification.md) —
  the evolving semantic oracle, fault matrix, scale tiers, metrics, and Episode
  Trust Report design required by ADR-0042.
- [`docs/guides/querying-runtime-facts.md`](../guides/querying-runtime-facts.md) —
  the staged human and agent service surface defined by ADR-0048.
- [`docs/guides/fact-surface-admission.md`](../guides/fact-surface-admission.md) —
  how product and user facts enter a KFD-declared contract world and become
  eligible for historical query and trust assessment.
- [`docs/qualification/kfd2-trust-assessment.md`](../qualification/kfd2-trust-assessment.md) —
  when KFD-2 runs, how the workspace coordinator coordinates it, and how Desktop and
  embedded executors share one contract.
- [`docs/concepts/product-layers.md`](../concepts/product-layers.md) — independent
  adoption products and their qualification boundaries.
- [`docs/concepts/domain-horizons.md`](../concepts/domain-horizons.md) — the
  quantitative-trading, agent-runtime, and games/virtual-world architecture
  horizons.
