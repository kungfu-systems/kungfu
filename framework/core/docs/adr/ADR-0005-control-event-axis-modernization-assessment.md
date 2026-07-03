# ADR-0005: control / event axis modernization — a meta-assessment

- Status: proposed (meta; aggregates ADR-0003 + ADR-0004 + the reactive event layer)
- Date: 2026-06-30
- Category: (b) improvement — meta design question for v4 scope
- Subsystem: the control and event axes — Python coroutine integration
  (`coloop.py`), the Node watcher (`watcher.cpp`), and the RxCpp-based reactive
  event layer (`yijinjing` `hero` / `apprentice`). Terms `hero` / `apprentice` /
  `watcher` / `coloop` are defined in [`docs/concepts.md`](../../../../docs/concepts.md).
- Related: aggregates [ADR-0003](ADR-0003-control-axis-python-coroutine-integration.md)
  and [ADR-0004](ADR-0004-control-axis-node-watcher-snapshot-model.md); contrasts
  with the completed data-axis work in
  [ADR-0002](ADR-0002-longfist-flatbuffers-runtime-schema.md).

## Context

v4's modernization so far has de-risked the **data axis**: longfist moved to a
FlatBuffers runtime schema and the transport moved `nanomsg` → `nng`
([ADR-0002](ADR-0002-longfist-flatbuffers-runtime-schema.md)). That axis is
codegen-validated and is the well-understood part of the system.

The **control and event axes** were largely untouched in v4:

- the Python coroutine integration ([ADR-0003](ADR-0003-control-axis-python-coroutine-integration.md));
- the Node watcher snapshot model ([ADR-0004](ADR-0004-control-axis-node-watcher-snapshot-model.md));
- the **RxCpp-based reactive event layer** (`hero` / `apprentice`), which v4 did
  not modify.

The pattern worth naming: the open design questions cluster on the control /
event axis, while the data axis — being schema-driven and codegen-validated — is
the safe zone. This axis is the part of v4 whose scope has not yet been decided.

## The open meta-decision

A single question above the individual ADRs: **should v4 deliberately touch the
control / event axis at all, or freeze it for this major and defer to a later
line?**

The trade is asymmetric. The data-axis work was comparatively safe (a schema
migration with codegen validation). Control-axis changes are higher-risk —
concurrency semantics, private-runtime coupling
([ADR-0003](ADR-0003-control-axis-python-coroutine-integration.md)), and
large-state behaviour ([ADR-0004](ADR-0004-control-axis-node-watcher-snapshot-model.md)) —
and the reactive event layer is load-bearing, so changing it is not local.

## Options

- **Freeze the control/event axis for v4** — ship v4 on the de-risked data axis,
  keep the current control axis, and schedule ADR-0003 / ADR-0004 / a reactive
  layer review onto a later line.
- **Selectively modernize** — take only the changes whose trigger is already
  near (per the evaluation axes in ADR-0003 / ADR-0004), leaving the rest frozen.
- **Full control-axis pass in v4** — treat the control/event axis as in-scope for
  this major, accepting the higher risk and coordination cost.

## Measured baseline (2026-07-03)

The reactive layer now carries a permanent opt-in probe (`KF_DISPATCH_PROBE=1`,
`hero::drain`) that times each frame's synchronous fan-out through every rx
filter chain; `tests/bench/` holds the reproducible harness. Numbers from
macOS arm64 (M-series), 200k typed `Quote` frames through a live master:

| Form | Scenario | Per-frame mean | Max |
| --- | --- | --- | --- |
| master (19 chains) | rx only (`KF_BYPASS_CACHED=1`) | 412 ns | 84 µs |
| master (19 chains) | with storage feed | 488 ns | 147 µs |
| node watcher | control/state events (n=75) | 36 µs | 465 µs |

Structural findings that bound any optimization upside:

- Both master and the node watcher already pre-filter open-layer events in
  `is_reactable` before rx — a cheap pre-dispatch that exists today.
- The watcher's bulk trading data bypasses rx entirely
  (`drain_from_trading_data_reader`), and market data does not reach the
  watcher; its rx path carries low-rate control events whose cost is
  dominated by the N-API/JS handlers, not chain traversal.
- The single per-frame `dynamic_cast` (the `instanceof` chain, master only)
  is included in the 412 ns figure; its live semantic role is distinguishing
  journal frames from socket notice events.

Reading: at ~0.4 µs per frame the full chain scan sustains ~2.4M frames/s
per core on the only high-rate rx surface (master), two orders of magnitude
above observed journal ingest rates. If a future trigger (frame-rate growth
or chain-count growth) changes this, the only optimization shape on the
table keeps the filter-chain declarations as the single source of truth and
derives a msg_type index from them for single-tag chain pre-dispatch —
replacing the rx algebra is off the table (multi-dimensional routing, open
extension, and the step primitive documented in `rx.h` are load-bearing).

## Status / progress

Meta and not scheduled; its resolution depends on the outcomes of ADR-0003 and
ADR-0004 and on a decision about the reactive event layer. The measured
baseline above removes the reactive layer's per-frame cost from the list of
unknowns: the freeze option is now evidence-backed for the event axis. This
ADR exists to keep the v4-scope question explicit and traceable rather than
implicit.
