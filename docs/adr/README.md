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

For human browsing, start with the generated [ADR Map](../architecture/adr-map.md). It hides
UUID filenames behind titles, shows a compact domain overview, and separates
frontmatter-authoritative relations from bounded navigation-only neighbors.

A record's **Status** says where it stands:

- **accepted** — the decision is authoritative; implementation progress remains
  a separate, machine-checked state.
- **proposed** — an open design question recorded for traceability; the decision
  is not yet made. These are deliberately written down before they are resolved
  so the question, and its current progress, are visible rather than implicit.
- **superseded** — retained as historical decision evidence, but replaced for
  current design by the ADR it names.

ADR frontmatter is the machine authority. The body status is always a checked
projection. This page is navigation and operating guidance, not a shared
identity registry; UUIDv7 ADRs are discovered directly from their files.
Decision state, implementation state,
and review state are separate fields; see the
[Document Metadata Contract](../development/document-metadata.md). Do not add
compound implementation notes to the index Status column.

All records in this directory carry equal governance weight. New records use
`KF-ADR-<UUIDv7>` for Kungfu product, runtime, and Core ownership or
`SHIFU-ADR-<UUIDv7>` for Shifu ownership. The retired sequential identity scheme
has no current parser or inventory; the gate rejects its tokens in current
authority. Create a record offline with
`./shifu adr:new -- --owner kungfu|shifu --title "..."`. The namespace expresses
ownership and future portability, not a weaker review, evidence, or release
obligation. The [distributed UUIDv7 identity decision](SHIFU-ADR-019f86ff-a8d6-7431-ae05-0ec95fdb7ace.md)
defines the ID-only filename and offline allocation contract.

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
2. Replace each historical evidence exemption only when immutable implementation
   and closure evidence is complete.
3. Bind implemented claims to qualification evidence that actually exercises
   the accepted scope, then remove the corresponding stable blocker.
4. Resolve `legacy-unreviewed` and `unreviewed` only through maintainer review.
5. Use the exact-release promotion gate for waivers; the side-effect-free audit
   reports the unwaived balance sheet and never grants an exception.

This ordering keeps status debt visible without weakening ordinary development,
while making stable publication fail closed until every accepted decision is
implemented and qualified or explicitly waived for that release.

## Reading by theme

- **Data axis (the journal & type system)** — [0001](KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md)
  (publish synchronization), [0008](KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md)
  (the closed POD layout as a compatibility invariant), and
  [0047](KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3.md) (one schema
  owner per structured fact: Hana POD closed set or FlatBuffers open layer).
  [0058](KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f.md) separates mmap
  authority from residency and durability requests without changing the wire
  or POD layouts.
  [0062](KF-ADR-019f86da-4f90-741b-8f16-b27fcd99d0df.md) derives the
  journal container epoch from the page/frame header layout itself, so an
  unversioned layout change cannot ship, and keeps cross-epoch replay off the hot
  path as deferred offline conversion.
  [0063](KF-ADR-019f86da-4f90-79ce-888e-6fd6476f10f4.md) narrows the
  lock-free claim to publication/tail reads and proposes explicit writer
  transactions, a thread-affine reader cursor, and ownership-driven page
  reclamation.
  [0068](KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md) keeps the hot mmap
  plane while adding explicit visible/durable/projected watermarks, typed
  receipts, an independent durable-ingest boundary, and crash qualification.
  [0080](KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c.md)
  classifies storage-only, live-optional, and live-required operations; binds
  readiness to a durable cut and one fenced generation; and keeps process
  topology behind a capability-driven RuntimeHost adapter.
  [0002](KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a.md) is retained as the
  superseded historical decision that preceded this split.
- **Control / event axis** — [0003](KF-ADR-019f86da-4f90-7a30-8697-5c648120053d.md)
  (withdrawn Python coroutine redesign), [0004](KF-ADR-019f86da-4f90-7fb3-a803-393d3bbe6704.md)
  (withdrawn Node watcher redesign), with [0005](KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412.md)
  the accepted decision to freeze the control/event axis for v4.
  [0064](KF-ADR-019f86da-4f90-71cc-8fc7-58226b337d8b.md) proposes the
  narrower correctness boundary that libraries propagate structured errors and
  each loop owner controls stopping, without reopening KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412's frozen Rx
  routing/fan-out decision.
- **Frontend platform** — [0006](KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80.md)
  (platform + reference app), [0007](KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a.md)
  (the TUI reference surface).
- **Extension trust boundary** — [0011](KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1.md)
  (the tier declaration and the zero-copy-vs-serialized split for views),
  [0013](KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md) (extending
  that boundary to the runtime plane: trust by verifiable origin, an OS sandbox
  for the default tier, and a trusted channel for zero-copy), and
  [0014](KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md)
  (how an extension addresses that boundary: one uniform capability surface
  across tiers, restriction as transparent interception, so one source runs in
  either tier and a later confinement does not force a rewrite), and
  [0017](KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md)
  (who assembles it: one host-agnostic load plan shared by the GUI and CLI, and
  a background `service` facet as the first production caller of the OS sandbox).
  [0045](KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6.md) proposes the
  orthogonal execution-profile axis: Rust-primary native, WASM components,
  managed runtimes, and subprocesses, without weakening the trust decision.
  [0069](KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md) adds the
  domain-semantic Profile closure without giving Suite members authority over
  fact admission, assessment truth, or their own lifecycle.
- **Agent capability layer** — [0015](KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md)
  (Kungfu Skill as the agent-facing layer above kfx: `SKILL.md` as the minimum
  valid source, compact catalog injection, Node/Python manage modes, and kfx
  dependency composition without bypassing the kfx trust gate).
- **Runtime facts, storage, sync, and replay** —
  [0018](KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de.md) (the storage service
  above journal, payloads and projections),
  [0019](KF-ADR-019f86da-4f90-76a1-8eda-6e49fa70e7d5.md)
  (source sync over `location` and `channel`),
  [0020](KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf.md) (the causal
  action timeline and replay boundary), and
  [0021](KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48.md) (stable
  observer-relative timeline projection without a universal global clock), and
  [0022](KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81.md) (the C++ core
  action-recording surface that Python/Node bindings wrap), and
  [0023](KF-ADR-019f86da-4f90-7d72-bf9f-1d5913bbb0d5.md) (the first
  frame-integrity receipt slice plus the source gate that prevents new raw
  business carrier allocations),
  [0024](KF-ADR-019f86da-4f90-71ac-bb91-32456981141a.md) (neutral location
  roles and the rule that journal page size is storage policy, not role
  identity), and
  [0025](KF-ADR-019f86da-4f90-7c76-bf49-3e804d3ba63f.md) (the rename
  from `msg_type` to `carrier_type` and the rule that business semantics live
  in action envelopes), and
  [0026](KF-ADR-019f86da-4f90-76b5-847e-1b56562d15cf.md) (the rule that runtime
  bindings expose neutral raw/envelope/runtime APIs instead of generated
  trading typed helpers), and
  [0027](KF-ADR-019f86da-4f90-7d53-b594-952ae035eb04.md) (the matching rule that
  Python `pykungfu.yijinjing.types` only exposes core public runtime structs,
  while the full compiled schema registry stays internal to runtime decode
  paths), and
  [0028](KF-ADR-019f86da-4f90-7d2c-aaa5-974ca5e38654.md) (the rule that
  fast internal hashes, frame checksums, content hashes, and future trust roots
  are separate algorithm surfaces), and
  [0029](KF-ADR-019f86da-4f90-7a7d-99ba-c5c18088d450.md) (the v2 frame receipt checksum
  algorithm selection and fsck metadata rules), and
  [0030](KF-ADR-019f86da-4f90-765c-9723-069718911491.md) (the first manifest-scoped
  sync root that binds payload/action/frame receipt evidence for export/fsck),
  [0031](KF-ADR-019f86da-4f90-764b-a1f8-90375260328c.md) (the v4 greenfield switch of internal
  fast hashes to XXH3_64 / XXH3_128), and
  [0032](KF-ADR-019f86da-4f90-7111-9165-691b834edbab.md) (the first generic source
  registry, accepted-range, bundle import/export, and fsck service slice), and
  [0033](KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md) (Episode as the first-class
  causal segment object for storage, sync, fsck, import/export, and timeline
  projection), and
  [0034](KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692.md) (Episode manifest
  records as yijinjing first-class data structures in a manifest journal, with
  JSON only as export/debug/folded view), and
  [0035](KF-ADR-019f86da-4f90-7e58-bb03-bee0f101dc01.md) (workspace-local
  `.kungfu/` as the default Episode/fact ledger home, with `~/.kungfu-config`
  as the user config home and `KF_HOME` retained as machine fallback), and
  [0036](KF-ADR-019f86da-4f90-730a-a068-06e8758324e1.md) (a per-user
  supervisor routes CLI/GUI/TUI entrypoints to per-data-root masters while
  storage remains daemonless), and
  [0037](KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md) (the KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de
  storage-service record family — source registry, import/export manifest,
  fsck report, accepted range — are Hana-core kernel metadata like the Episode
  manifest of KF-ADR-019f86da-4f90-762d-a677-5e8984cc6692, journal-backed and delta-append; JSON file authorities
  and unconsumed heap structs are retired, the remaining JSON-shaped semantic
  service interface is staged for typed conversion, and payload bodies are
  opaque content-addressed bytes, not `.json` text), and
  [0047](KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3.md) (the
  system-wide schema authority rule, typed-view/opaque-body boundaries, JSON
  edge-only policy, and exclusive Hana/FlatBuffers SQLite projection paths),
  [0048](KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.md) (the explicit
  current/historical query basis, shared logical plan, proof envelope, and
  resumable changelog contract),
  [0051](KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md) (the KFD-1
  declaration, replayable fact-admission, historical interpretation, and KFD-2
  trust-assessment path),
  [0052](KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302.md) (claim-triggered
  assessment jobs, workspace-coordinator coordination, Assessment Episodes, and
  equivalent process/thread executors), and
  [0060](KF-ADR-019f86da-4f90-7d61-8afa-33d66ca05d36.md) (Desktop
  Home/project workspace selection, global recent-workspace state,
  first-run Agent Work Inbox, and write-intent-bound data-home initialization),
  [0061](KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8.md)
  (the dual-first inspect/advice/preview/authorize/action/receipt protocol), and
  [0055](KF-ADR-019f86da-4f90-7fa3-8045-32c1220ecd72.md)
  (Episode replaces the retired Session replay anchor), and
  [0056](KF-ADR-019f86da-4f90-7f7f-b5cc-b4553aac9194.md) (journal
  lifecycle management belongs to Storage/Episode rather than loose-file CLI
  archive and clean commands),
  [0058](KF-ADR-019f86da-4f90-7f8a-9bff-e4f7683da35f.md) (explicit mapping and
  page-open policies, with coordinator-only pre-creation), and
  [0042](KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.md) (Episode atomic
  safety as evidence-bounded capability, graceful degradation, monotonic repair,
  fault containment, and qualification under scale).
- **Host & distribution** — [0044](KF-ADR-019f86da-4f90-7626-861e-3fdee887abd2.md)
  (what installed launcher binaries bake in forever) and
  [0046](KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md) (the target host
  topology: Rust trunk over satellite runtimes, the CLI layering law, and the
  assembled exact-runtime distribution contract that retires the freezer), and
  [0054](KF-ADR-019f86da-4f90-7171-9dde-411f02f55950.md) (the governed
  dual-engine WASM runtime, explicit capability grant, fact receipts, and
  release artifact qualification contract).
  Shifu-owned decisions that are not Kungfu Core decisions retain the
  `SHIFU-ADR-*` namespace in this same registry.
- **Cross-cutting principle** — [0009](KF-ADR-019f86da-4f90-7739-aa31-52af27bc4470.md)
  (load-bearing self-bootstrap), which also names the general law that
  [`docs/architecture/overview.md` § The build dogfoods the SDK](../architecture/overview.md)
  is one instance of, and
  [0049](KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md) (the
  independent adoption closure, downward dependency, layer-deletion, and
  domain-neutral kernel constraints).

- **Initiative and Assignment terminology** —
  [Initiative and Assignment L3 contract](KF-ADR-019f8759-ab29-7627-bc04-6aba547ea45f.md) names Initiative
  and Assignment as the canonical L3 control-plane records, gives their
  successor contract world an independent identity, preserves legacy
  Mission/Go evidence as exact read-only history, and leaves KFD-7 Pursuit
  unchanged.
  [Build-free Assignment request capture](KF-ADR-019f878c-5480-7890-bc64-9b2aab7e9aa5.md) adds the preceding
  capture boundary: lossless request material may enter a project inbox or
  unassigned Home without creating runtime, journal, Initiative, or Assignment
  authority.
  [Portable sealed Assignment orchestration state](KF-ADR-019f87cc-bd1f-786d-896d-07ea9245861e.md)
  makes the native phase machine and closeout evidence survive worktree cleanup.
  [Assignment claim owner, agent, slot, and lease](KF-ADR-019f87cc-bd45-7a5c-9b37-1d6b5917928a.md)
  separates accountability, runtime identity, execution placement, and bounded
  authorization.
  [Workspace Federation and Assignment Graph](KF-ADR-019f8e99-9354-7ab6-a9ba-b166f83f25a3.md)
  adds path-independent workspace identity, exact WorkRefs, typed graph
  qualification, retryable cross-workspace handshakes, and component-cut
  federation without introducing Home/project dual writes.

- **Layered API and Work-loop boundaries** —
  [Layered APIs and protocol-owned canonical encoding](KF-ADR-019f87cb-b4e7-7cda-80ec-be5aceb7b500.md)
  keeps one public C ABI waist while each identity protocol owns its canonical
  bytes.
  [Project Cut as the public Work-loop facade](KF-ADR-019f87e8-6b8b-735c-b036-fa42d7cee8cf.md)
  exposes one recoverable product loop over the existing Work and settlement
  authorities without creating a second state machine.
  [Domain Profile authoring is declarative, qualified, and Core-neutral](KF-ADR-019f8822-1d7a-7594-adea-65ad12c47733.md)
  makes third-party domain packages versioned, jointly rooted, and admissible
  without editing or recompiling Core.
  [Core Cut and the Work lifecycle waist](KF-ADR-019f8c53-6105-71e5-8f34-53f2a81ee61c.md)
  makes `Cut` domain-neutral, retains `project.cut/v1` as legacy identity, and
  projects one receipt-bound operation set to C++, Node.js, Python, and Rust.
  [Derived Primitive Management Plane](KF-ADR-019f917f-d116-70e8-b4a1-2e0209598aec.md)
  keeps primitive birth passport-owned while one six-facet generated catalog
  serves KFD, native runtime, source acceptance, and release admission.

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
  tombstone-then-cold-path GC (KF-ADR-019f86da-4f90-791c-9b90-4888cca36327/0034, KF-ADR-019f86da-4f90-7fa3-8045-32c1220ecd72/0056).
- [`docs/qualification/episode-atomicity-qualification.md`](../qualification/episode-atomicity-qualification.md) —
  the evolving semantic oracle, fault matrix, scale tiers, metrics, and Episode
  Trust Report design required by KF-ADR-019f86da-4f90-7516-b7ed-5b39a527cefb.
- [`docs/guides/querying-runtime-facts.md`](../guides/querying-runtime-facts.md) —
  the staged human and agent service surface defined by KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.
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
