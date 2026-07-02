# ADR-0010: adopt KFD-1 — welded-surface registers decide patch, minor, and major

- Status: accepted
- Date: 2026-07-02
- Category: (principle) version governance — adoption of an organization-wide rule
- Subsystem: whole repository (release lines, longfist layout, capability SDK, kfx contract, kfc CLI)
- Related: generalizes [ADR-0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)
  (the longfist layout as the true invariant) from one surface to a register of
  surfaces; complements `docs/version-release-design.md` (the mechanism that
  opens and maintains lines; KFD-1 decides *when* a line must or must not open).

## Decision

Adopt [KFD-1](https://github.com/kungfu-systems/kfd/blob/dev/v1/v1.0/decisions/kfd-0001-release-versioning.md)
as this repository's versioning rule. KFD-1 classifies every change against a
**welded-surface register**: breaking a registered surface forces a major;
additively evolving a surface or adding one opens a minor; a change that
touches no registered surface is a patch regardless of size; an unclassifiable
change means the register itself is deficient and must be fixed first.

This repository's living register and decision log are kept in
[`docs/versioning.md`](../../../../docs/versioning.md). This ADR is the
immutable adoption record; the rule text itself lives in the KFD registry and
is not restated here.

## Context

ADR-0008 already established that the longfist binary layout is the true
compatibility invariant beneath the tag, and that minor lines pin layout
epochs. It answered "what happens when the layout changes" but left open what
a breaking change to any *other* contract surface — the capability SDK, the
kfx extension contract, the kfc CLI — implies for version lines, and when a
new line should *not* be opened. KFD-1 generalizes ADR-0008's move: the layout
becomes one entry in a register of welded surfaces, and the decision procedure
covers all of them uniformly.

## Consequences

- The longfist layout keeps its ADR-0008 semantics as the register entry
  `longfist-layout`; nothing about hot-path pinning or cold-path additive
  evolution changes.
- Breaking the capability SDK or the kfx contract without touching the layout
  is now, explicitly, a major.
- Feature volume no longer has version semantics: features ride patches on the
  current line unless a registered surface changed.
- Line openings and register changes must be recorded in the decision log in
  `docs/versioning.md`; patches stay silent by design.

## Reversibility

Adopting a classification rule is process, not code: reversal means recording
a superseding decision, not migrating data. The register and decision log
remain useful history either way.
