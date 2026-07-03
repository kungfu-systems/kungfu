# Dispatch Latency Bench

Measurement harness for the reactive event layer's per-frame dispatch cost —
the evidence feed for
[ADR-0005](../../docs/adr/ADR-0005-control-event-axis-modernization-assessment.md)
(freeze vs. modernize the control / event axis).

## What is measured

`hero::drain` pushes every reactable journal frame through `sb.on_next`,
which fans it synchronously through **all** rx filter chains subscribed on
`events_`. The `KF_DISPATCH_PROBE=1` instrument in `hero.cpp` times exactly
that call per frame and aggregates count / mean / max per `msg_type`,
reporting through the process log every 5 seconds and at journal end. The
probe is opt-in; when the env var is unset the per-frame cost is a single
predictable branch.

Both runtime forms pump through the same site: master and apprentice via
`hero::run`, the node watcher via `hero::step` (its trading-data side reader
deliberately bypasses rx and is out of scope here — it is already the
pre-dispatched fast path).

## Runs

Master form (requires built `dist/kfc`):

```sh
KF_BYPASS_CACHED=1 tests/bench/dispatch_bench.sh   # rx-isolated: no storage feed
tests/bench/dispatch_bench.sh                      # storage-on: deployment shape
```

The two runs bracket the rx layer's share: the rx-isolated run is chain scan
+ `instanceof` (one `dynamic_cast` per frame, master only) + feed guards;
the storage-on delta is cached/sqlite work that no rx change can recover.

Load shape: `dispatch_load.py` registers a real apprentice and writes typed
longfist `Quote` frames. Typed frames are the right load because **both**
runtime forms already pre-filter open-layer events before rx: master's
`is_reactable` is `not is_custom_event` and the watcher's rejects custom
events too. Open-layer traffic therefore never touches the filter chains —
an existing cheap pre-dispatch worth noting as ADR-0005 evidence in its own
right (`frames_seen` vs `dispatched` in the probe report quantifies it; use
load-type `30001` as a control run to see it).

## Reading the result for ADR-0005

- If the rx-isolated mean per frame is small against the journal write cost
  and the storage delta, the rx algebra is not the hot layer: **freeze**.
- If it is material, the only optimization shape on the table keeps the
  filter-chain declarations as the single source of truth and derives a
  msg_type index from them for single-tag chain pre-dispatch. Replacing the
  rx algebra is off the table: the multi-dimensional routing (`is`/`from`/
  `to` composition), open extension, and subscription-lifetime semantics it
  provides are load-bearing (see the notes in `rx.h` — `steppable`/`holdon`
  is the step primitive both hosts rely on, and the error path is structured
  stop, not silent chain death).
