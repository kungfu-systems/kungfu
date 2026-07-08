# ADR-0003: control axis — the Python coroutine integration layer (continue / redesign / drop)

- Status: proposed (open design question; under evaluation, not scheduled)
- Date: 2026-06-30
- Category: (b) improvement + latent fragility — control-axis design question
- Subsystem: Python binding — `coloop.py` (`KungfuEventLoop`), the fusion of the
  engine's single-threaded loop with Python `asyncio`
- Related: aggregated with [ADR-0004](ADR-0004-control-axis-node-watcher-snapshot-model.md)
  into the meta-assessment [ADR-0005](ADR-0005-control-event-axis-modernization-assessment.md);
  orthogonal to the data-axis work in [ADR-0002](ADR-0002-yijinjing-schema-runtime-layout.md).

## Context

The Python side integrates coroutines by fusing the engine's single-threaded
loop with `asyncio`: `KungfuEventLoop` (in `coloop.py`) implements
`asyncio.AbstractEventLoop` so that a single thread runs both the engine's event
stepping and Python coroutine scheduling, rather than running an `asyncio` loop
on a separate thread. The design goal — one thread, no cross-thread handoff
between engine events and coroutine continuations — is consistent with the
project's single-threaded execution model.

The open concern is *how* the coroutine stepping is driven. The current
implementation reaches into `asyncio`'s internal stepping (hand-reconstructing
the per-iteration run logic and leaning on internal `Handle` / timer / future
mechanics). That couples the layer to CPython's private `asyncio` internals,
which are not a stable API and have shifted across Python versions. Because v4
targets the latest LTS Python, this coupling surface grows rather than shrinks.

The coroutine integration is currently **incomplete**.

## The open decision

Record the question rather than pre-empt it. The choices:

- **Continue** — harden the current approach, accepting an explicit,
  test-pinned dependency on `asyncio` internals across the supported Python
  range.
- **Redesign** — drive coroutine continuations without relying on private
  `asyncio` internals (e.g. a public-API-only integration, or a narrower bridge
  that does not reimplement the run loop).
- **Drop** — do not offer in-engine coroutine integration on the Python side,
  and document the supported alternative.

## Evaluation axes

1. **Version robustness** — how much private-API surface each option pins, and
   the cost of tracking it across LTS Python upgrades.
2. **Maintenance surface** — how much hand-reconstructed runtime each option
   carries.
3. **Value** — how much the coroutine ergonomics are actually worth to extension
   authors, relative to the maintenance cost.

## Status / progress

Incomplete and not scheduled. The current behaviour and the coupling points are
visible in `coloop.py`. This ADR exists to make the design question explicit and
traceable; it does not yet commit to an option.
