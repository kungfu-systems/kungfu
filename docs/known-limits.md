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

## The end-user shell is planned, not shipped

The `kungfu` command is the runtime today and the canonical CLI over it.
The richer end-user *shell* under that name is still planned; the zero-setup
experience is fully real for `kfx` *development* (the runtime absorbs the
toolchain), and the shell is the part still to come.

## Reference extensions are mid-migration

The repository's reference extensions double as build-time coverage probes.
Trading-specific ones from earlier versions are being retired and their coverage
role moved to neutral replacements that exercise the same paths; during this
migration both may be present.
