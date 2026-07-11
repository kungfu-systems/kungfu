# Architecture Decision Records

This directory records the significant architecture and design decisions behind
Kungfu. Each ADR captures not just *what* was decided but *why* — the context at
the time, the alternatives weighed, and the cost of reversal — so a later reader
can understand a design before changing it. ADRs are append-only: a decision that
changes is superseded by a new record, not edited away.

A record's **Status** says where it stands:

- **accepted** — decided and (unless noted) implemented.
- **proposed** — an open design question recorded for traceability; the decision
  is not yet made. These are deliberately written down before they are resolved
  so the question, and its current progress, are visible rather than implicit.
- **superseded** — retained as historical decision evidence, but replaced for
  current design by the ADR it names.

## Index

| ADR | Status | Title |
|---|---|---|
| [0001](ADR-0001-yijinjing-publish-barrier.md) | accepted | yijinjing journal publish protocol → `atomic_ref` release/acquire |
| [0002](ADR-0002-yijinjing-schema-runtime-layout.md) | superseded | historical FlatBuffers-over-POD runtime-schema decision; schema scope replaced by ADR-0047 |
| [0003](ADR-0003-control-axis-python-coroutine-integration.md) | proposed | control axis — the Python coroutine integration layer (continue / redesign / drop) |
| [0004](ADR-0004-control-axis-node-watcher-snapshot-model.md) | proposed | control axis — the Node watcher snapshot model |
| [0005](ADR-0005-control-event-axis-modernization-assessment.md) | proposed | control / event axis modernization — a meta-assessment |
| [0006](ADR-0006-v4-frontend-platform-architecture.md) | accepted | v4 frontend = platform (capability SDK + loose kfx contract) + minimal reference app |
| [0007](ADR-0007-v4-tui-platform-reference-surface.md) | accepted | v4 TUI = the platform's second reference surface |
| [0008](ADR-0008-yijinjing-schema-layout-baseline.md) | proposed | yijinjing schema binary layout as the true compatibility invariant; schema-evolution policy |
| [0009](ADR-0009-load-bearing-self-bootstrap.md) | accepted | load-bearing self-bootstrap — the adoption path is the validation path |
| [0010](ADR-0010-adopt-kfd-1-release-versioning.md) | accepted | adopt KFD-1 — welded-surface registers decide patch, minor, and major |
| [0011](ADR-0011-v4-capability-sdk-contract.md) | accepted | v4 capability SDK contract — two vocabulary domains, runtime-tier declaration, five consumer-driven handles |
| [0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md) | proposed | extension isolation and the trusted channel on the runtime plane — trust by verifiable origin, default-deny OS sandbox, zero-copy only for the trusted channel |
| [0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md) | proposed | the extension execution contract — one uniform capability surface across trust tiers, restriction as transparent interception, a binding-less guest host |
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
| [0036](ADR-0036-supervisor-and-workspace-master-topology.md) | accepted | Per-user supervisor manages per-data-root masters |
| [0037](ADR-0037-storage-records-hana-core-kernel-metadata.md) | accepted | ADR-0018 storage-service records are Hana-core kernel metadata; JSON is an edge projection, not the contract |
| [0038](ADR-0038-location-namespace-terminology.md) | accepted | Location middle identity segment is namespace |
| [0039](ADR-0039-unified-view-interface-encapsulates-flatbuffers.md) | proposed | a single kungfu view interface is the sole FlatBuffers access point; raw FB is not called elsewhere |
| [0040](ADR-0040-runtime-fact-ledger-content-addressed-kv.md) | proposed | a first-class content-addressed store is a runtime fact-ledger primitive, with mutable KV and fleet topology kept as separate capabilities |
| [0041](ADR-0041-episode-manifest-first-class-journal-structure.md) | proposed | the Episode manifest is the object's trust boundary — POD journal records, one typed fold, and JSON at the edge |
| [0042](ADR-0042-episode-atomic-safety-and-qualification.md) | proposed | Episode is the atomic safety and fault-containment unit, qualified by evidence under load |
| [0043](ADR-0043-episode-identity-sealed-content-root.md) | proposed | Episode identity is two layers — a local coordinate plus a sealed content root committed in the manifest |
| [0044](ADR-0044-shifu-delegation-protocol.md) | accepted | The shifu delegation protocol — what installed binaries bake in forever |
| [0045](ADR-0045-kfx-execution-profiles-native-rust-wasm.md) | accepted | KFX execution profiles — Rust-primary native, WebAssembly components, managed runtimes, and subprocesses |
| [0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md) | accepted | Rust host trunk, layered CLI, and the assembled runtime distribution |
| [0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) | accepted; staged | authoritative structured facts have one schema owner — Hana POD or FlatBuffers |
| [0048](ADR-0048-runtime-fact-query-semantics-and-changelog.md) | accepted; staged | runtime fact queries use explicit bases, one logical plan, and a proof-carrying changelog |
| [0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md) | accepted; staged | every product layer is independently complete and the core remains domain-neutral |
| [0050](ADR-0050-assembled-runtime-stdlib-pruning-policy.md) | accepted | stdlib pruning policy for the assembled runtime — family-level subtraction, declarative fail-closed manifest |
| [0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md) | accepted; staged | KFD contract worlds govern fact admission, historical interpretation, and trust assessment |
| [0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md) | accepted; staged | KFD-2 assessments are claim-triggered jobs coordinated by the workspace master |
| [0053](ADR-0053-self-contained-episode-bundles.md) | proposed | Episode bundles carry their owned bytes, and import materializes them |
| [0054](ADR-0054-retire-journal-session-and-separate-runtime-state-from-projection.md) | accepted | retire journal Session; separate live state from schema projections |

## Reading by theme

- **Data axis (the journal & type system)** — [0001](ADR-0001-yijinjing-publish-barrier.md)
  (publish synchronization), [0008](ADR-0008-yijinjing-schema-layout-baseline.md)
  (the closed POD layout as a compatibility invariant), and
  [0047](ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md) (one schema
  owner per structured fact: Hana POD closed set or FlatBuffers open layer).
  [0002](ADR-0002-yijinjing-schema-runtime-layout.md) is retained as the
  superseded historical decision that preceded this split.
- **Control / event axis** — [0003](ADR-0003-control-axis-python-coroutine-integration.md)
  (Python coroutine integration), [0004](ADR-0004-control-axis-node-watcher-snapshot-model.md)
  (Node watcher snapshot model), with [0005](ADR-0005-control-event-axis-modernization-assessment.md)
  the meta-assessment of whether v4 should touch this axis at all.
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
  assessment jobs, workspace-master coordination, Assessment Episodes, and
  equivalent process/thread executors), and
  [0042](ADR-0042-episode-atomic-safety-and-qualification.md) (Episode atomic
  safety as evidence-bounded capability, graceful degradation, monotonic repair,
  fault containment, and qualification under scale).
- **Host & distribution** — [0044](ADR-0044-shifu-delegation-protocol.md)
  (what installed launcher binaries bake in forever) and
  [0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md) (the target host
  topology: Rust trunk over satellite runtimes, the CLI layering law, and the
  assembled exact-runtime distribution contract that retires the freezer).
- **Cross-cutting principle** — [0009](ADR-0009-load-bearing-self-bootstrap.md)
  (load-bearing self-bootstrap), which also names the general law that
  [`docs/architecture.md` § The build dogfoods the SDK](../../../../docs/architecture.md)
  is one instance of, and
  [0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md) (the
  independent adoption closure, downward dependency, layer-deletion, and
  domain-neutral kernel constraints).

## Related design documents

- [`docs/architecture.md`](../../../../docs/architecture.md) — how the repository
  is layered and the principle that shapes it.
- [`docs/version-release-design.md`](../../../../docs/version-release-design.md) —
  the versioning / release mechanism rationale, and the compatibility invariant
  below the tag.
- [`docs/skills.md`](../../../../docs/skills.md) — the user-facing and
  implementation-facing design for Kungfu Skills.
- [`docs/runtime-storage-service.md`](../../../../docs/runtime-storage-service.md) —
  the staged storage command surface, fsck/export path, and source-adapter
  direction.
- [`docs/episode-object-model.md`](../../../../docs/episode-object-model.md) —
  the Episode object model, causal closure invariant, and storage migration
  direction.
- [`docs/episode-atomicity-qualification.md`](../../../../docs/episode-atomicity-qualification.md) —
  the evolving semantic oracle, fault matrix, scale tiers, metrics, and Episode
  Trust Report design required by ADR-0042.
- [`docs/querying-runtime-facts.md`](../../../../docs/querying-runtime-facts.md) —
  the staged human and agent service surface defined by ADR-0048.
- [`docs/fact-surface-admission.md`](../../../../docs/fact-surface-admission.md) —
  how product and user facts enter a KFD-declared contract world and become
  eligible for historical query and trust assessment.
- [`docs/kfd2-trust-assessment.md`](../../../../docs/kfd2-trust-assessment.md) —
  when KFD-2 runs, how the workspace master coordinates it, and how Desktop and
  embedded executors share one contract.
- [`docs/product-layers.md`](../../../../docs/product-layers.md) — independent
  adoption products and their qualification boundaries.
- [`docs/domain-horizons.md`](../../../../docs/domain-horizons.md) — the
  quantitative-trading, agent-runtime, and games/virtual-world architecture
  horizons.
