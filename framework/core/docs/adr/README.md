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

## Index

| ADR | Status | Title |
|---|---|---|
| [0001](ADR-0001-yijinjing-publish-barrier.md) | accepted | yijinjing journal publish protocol → `atomic_ref` release/acquire |
| [0002](ADR-0002-longfist-flatbuffers-runtime-schema.md) | accepted | longfist serialization → a FlatBuffers runtime schema over the zero-copy POD layout |
| [0003](ADR-0003-control-axis-python-coroutine-integration.md) | proposed | control axis — the Python coroutine integration layer (continue / redesign / drop) |
| [0004](ADR-0004-control-axis-node-watcher-snapshot-model.md) | proposed | control axis — the Node watcher snapshot model |
| [0005](ADR-0005-control-event-axis-modernization-assessment.md) | proposed | control / event axis modernization — a meta-assessment |
| [0006](ADR-0006-v4-frontend-platform-architecture.md) | accepted | v4 frontend = platform (capability SDK + loose kfx contract) + minimal reference app |
| [0007](ADR-0007-v4-tui-platform-reference-surface.md) | accepted | v4 TUI = the platform's second reference surface |
| [0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md) | proposed | longfist binary layout as the true compatibility invariant; schema-evolution policy |
| [0009](ADR-0009-load-bearing-self-bootstrap.md) | accepted | load-bearing self-bootstrap — the adoption path is the validation path |
| [0010](ADR-0010-adopt-kfd-1-release-versioning.md) | accepted | adopt KFD-1 — welded-surface registers decide patch, minor, and major |
| [0011](ADR-0011-v4-capability-sdk-contract.md) | accepted | v4 capability SDK contract — two vocabulary domains, runtime-tier declaration, five consumer-driven handles |
| [0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md) | proposed | extension isolation and the trusted channel on the runtime plane — trust by verifiable origin, default-deny OS sandbox, zero-copy only for the trusted channel |
| [0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md) | proposed | the extension execution contract — one uniform capability surface across trust tiers, restriction as transparent interception, a binding-less guest host |

## Reading by theme

- **Data axis (the journal & type system)** — [0001](ADR-0001-yijinjing-publish-barrier.md)
  (publish synchronization), [0002](ADR-0002-longfist-flatbuffers-runtime-schema.md)
  (FlatBuffers runtime schema), [0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)
  (the layout as true invariant and its evolution policy). This axis is
  schema-driven and codegen-validated.
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
  either tier and a later confinement does not force a rewrite).
- **Cross-cutting principle** — [0009](ADR-0009-load-bearing-self-bootstrap.md)
  (load-bearing self-bootstrap), which also names the general law that
  [`docs/architecture.md` § The build dogfoods the SDK](../../../../docs/architecture.md)
  is one instance of.

## Related design documents

- [`docs/architecture.md`](../../../../docs/architecture.md) — how the repository
  is layered and the principle that shapes it.
- [`docs/version-release-design.md`](../../../../docs/version-release-design.md) —
  the versioning / release mechanism rationale, and the compatibility invariant
  below the tag.
