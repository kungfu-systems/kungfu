---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: protocol-guide
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-09-01
theme: assignment-runtime-public-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-09-01
ai_provenance: GPT-5 via Codex on 2026-09-01; updated from checked-in contracts and consumer inventory, with no access to invisible model internals
---

# Assignment Runtime API contract

This source-only boundary freezes the pre-release
`kungfu.assignment-runtime/v1` protocol. It is not an independent npm package.
The contract is implemented by the embedded Local Runtime and shared by GUI,
CLI, Agent, and KFX clients.

Repository tools import executable validation through [`index.mjs`](index.mjs).
Runtime clients receive the protocol through the existing Core, API, GUI and
KFX product surfaces; they do not import this directory as a separately
versioned distribution artifact.

The contract keeps Assignment state authority inside one declared realm. GUI,
CLI, Agent, and KFX callers are clients: they may discover capabilities, read
snapshots, resume events, and submit fenced commands, but they never own or
mutate journal, JSON, SQLite, PostgreSQL, Electron, or filesystem layouts.

Run the build-free contract checks with:

```sh
./shifu test:assignment-runtime
```

The positive and negative cases use only in-memory JSON fixtures. They do not
initialize or mutate a real Home Workspace.

Work Control also exposes domain-neutral Work semantics through fenced command
types `work.input.snapshot`, `work.run.record`, `work.effect.authorize`,
`work.effect.attempt`, and `work.effect.outcome`. They reuse the Runtime's
revision, generation, idempotency, Attempt, lease, restart, and recovery
semantics; they do not add another state store. The public protocol and CLI are
documented in [`docs/profiles/work-control.md`](../../docs/profiles/work-control.md).

[`work-authority-topology-v1.json`](work-authority-topology-v1.json) is the
machine-checked migration inventory for Assignment, WorkRef, recovery,
WorkConsole, SessionAttempt, lease, and continuation semantics. It classifies
every listed call site by semantic role, names one writer or deriver for each
identity, and records the exact debt that still prevents the target of zero
post-plan authority rediscovery. The inventory is qualification evidence only;
it is not runtime state, a reader status aggregate, or another Work authority.
