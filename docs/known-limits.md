# Known Limits

What kungfu does *not* yet guarantee, stated plainly. This is part of answering
"why can I trust this complex thing?" — a system you can trust is one that is
honest about its edges, not one that hides them. Each entry says what is not yet
guaranteed, its current status, and where it is tracked.

This document is curated from the project's own decision records and is kept
current; if a limit here is resolved, the entry moves to a guarantee elsewhere
(and links back). See the [documentation map](MAP.md) for how this fits the rest
of the docs.

## Compatibility governance is designed, not yet enforced

The longfist binary layout is the real compatibility contract, and the policy for
how it may evolve is decided
([ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)).
What is **not yet built**:

- a CI check that blocks breaking schema changes (modifying an existing field,
  renumbering);
- a "load only if runtime ≥ schema" gate;
- per-minor compatibility-window declarations;
- a cold-path replay cross-version decode test baseline.

So today the invariant exists physically (zero-copy layout), but the *enforcement*
that would let an external consumer rely on a stated compatibility window is
pending. Treat compatibility promises as per-minor and verify against the layout,
not against a version number alone.

## The control / event axis is unmodernized, with open questions

v4 de-risked the data axis (longfist → FlatBuffers, transport modernization). The
control and event axes carry recorded, **unscheduled** design questions:

- the Python coroutine integration couples to private `asyncio` internals and is
  incomplete
  ([ADR-0003](../framework/core/docs/adr/ADR-0003-control-axis-python-coroutine-integration.md));
- the Node watcher snapshot model has a state-scale consideration (a whole-state
  copy under lock) that becomes relevant at large state sizes, not at current
  scale
  ([ADR-0004](../framework/core/docs/adr/ADR-0004-control-axis-node-watcher-snapshot-model.md));
- whether v4 should touch this axis at all is itself an open meta-decision
  ([ADR-0005](../framework/core/docs/adr/ADR-0005-control-event-axis-modernization-assessment.md)).

These are identified and tracked, not silently shipped. They do not affect the
data-plane correctness covered by
[ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md).

## The GitHub build-and-release path is still being brought up

The release mechanism is designed and has a long tag history, but the current v4
build-and-release pipeline on this repository is not yet fully operational —
there is outstanding infrastructure work. Until it is, treat published v4
artifacts as pre-release, and note that the consumer-side provenance
documentation (how to verify a downloaded binary's signature and that it matches
its tag) is intentionally deferred rather than written ahead of the
infrastructure it would describe (see [`MAP.md`](MAP.md), `provenance.md` —
`blocked`).

## The end-user shell is partial, not complete

The `kungfu` command is the runtime today and the canonical CLI over it. Several
operator-facing slices have landed — for example `kungfu cockpit`,
`kungfu managed-run`, Kungfu Skill context injection, and the first skill-manager
view. That is not yet the same as a complete end-user shell.

What is **not yet guaranteed**:

- a polished one-command user install / launch path for non-contributors;
- full parity between GUI-launched and CLI-launched managed sessions;
- all planned multi-window/session workspace behavior being default-on;
- a final product surface that hides internal implementation terms such as tmux,
  provider CLI details, or development worktree paths.

Treat these as usable pre-release slices, not a finished shell promise.

## Runtime storage service is designed, not complete

Kungfu has the grounded pieces for a local runtime fact ledger: append-only
journals, frame provenance, location/channel runtime identity, portable export
direction, schema registry direction, SQLite projections, and a first
Atlas-scoped payload import/fsck/export/verify loop. The unified storage service
described in [`runtime-storage-service.md`](runtime-storage-service.md) is still
staged.

What is **not yet guaranteed**:

- large payload bodies are not yet uniformly stored behind hash-addressed
  references across every runtime scope;
- generic `kungfu source sync` across machines by range/session/hash inventory;
- complete `storage fsck` coverage for all journal, payload, manifest, schema,
  projection, and remote cursor classes;
- range/session/hash import-export is not yet the remote sync substrate;
- destructive-safe `gc` / `compact` with archive and rollback reporting;
- repair of arbitrary journal corruption;
- an authority migration path where an imported source becomes the single source
  of truth.

Treat current journal archive/clean/rebuild primitives, Atlas storage commands,
and source import/export slices as proof surfaces for the storage contract, not
as a completed distributed storage protocol.

## KFX runtime confinement is staged

The trust boundary is decided in
[ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md)
and the uniform capability surface is decided in
[ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md).
The first guest-host and sandbox primitives exist, but the ecosystem-facing
surface is still staged.

What is **not yet guaranteed**:

- the proposed `service` facet is not a stable published extension surface yet
  ([ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md));
- stronger read-scope narrowing, shadow-file reconciliation, and resource
  ceilings are follow-ups beyond the permissive first delivery;
- untrusted instrumentation adapters are refused rather than sandboxed, because
  capture-side instrumentation must run inside the traced process.

So "sandboxed" should be read as a precise tier/property for the relevant host
and facet, not as a blanket statement that every extension form is safely
contained.

## Kungfu Skills have a first slice, not a marketplace

Kungfu Skills are accepted as the agent-facing context layer above kfx
([ADR-0015](../framework/core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md)).
The first slices cover `SKILL.md` parsing, compact catalogs, context envelopes,
managed-run injection, audit sidecars, SDK scaffolding, and a first skill-manager
view.

What is **not yet guaranteed**:

- marketplace discovery and remote publishing;
- automatic permission elevation;
- kfx artifact acquisition for unresolved skill dependencies;
- third-party runtime facet execution through a skill wrapper;
- uninstalling shared kfx dependencies as a side effect of removing a skill.

A skill can request, explain, and compose. It cannot bypass the kfx trust gate.

## Reference extensions are mid-migration

The repository's reference extensions double as build-time coverage probes.
Trading-specific ones from earlier versions are being retired and their coverage
role moved to neutral replacements that exercise the same paths; during this
migration both may be present.
