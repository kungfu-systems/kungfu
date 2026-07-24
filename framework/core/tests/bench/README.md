# Dispatch Latency Bench

Measurement harness for the reactive event layer's per-frame dispatch cost —
the evidence feed for
[KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412](../../../../docs/adr/KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412.md)
(freeze vs. modernize the control / event axis).

## What is measured

`reactor::drain` pushes every reactable journal frame through `sb.on_next`,
which fans it synchronously through **all** rx filter chains subscribed on
`events_`. The `KF_DISPATCH_PROBE=1` instrument in `reactor.cpp` times exactly
that call per frame and aggregates count / mean / max per `carrier_type`,
reporting through the process log every 5 seconds and at journal end. The
probe is opt-in; when the env var is unset the per-frame cost is a single
predictable branch.

Both runtime forms pump through the same site: coordinator and peer via
`reactor::run`, the node watcher via `reactor::step` (its trading-data side reader
deliberately bypasses rx and is out of scope here — it is already the
pre-dispatched fast path).

## Runs

Coordinator form (requires built `dist/kungfu`; run under the repo-pinned node, e.g.
via `./shifu` or `fnm exec`, so the load binding ABI matches):

```sh
KF_BYPASS_CACHED=1 node tests/bench/dispatch_bench.mjs   # rx-isolated: no storage feed
node tests/bench/dispatch_bench.mjs                      # storage-on: deployment shape
```

The node watcher form is `node tests/bench/dispatch_bench_watcher.mjs`.

The two runs bracket the rx layer's share: the rx-isolated run is chain scan
+ `instanceof` (one `dynamic_cast` per frame, coordinator only) + feed guards;
the storage-on delta is cached/sqlite work that no rx change can recover.

Load shape: `dispatch_load.py` registers a real peer and writes typed
schema `Quote`-style frames. Typed frames are the right load because **both**
runtime forms already pre-filter open-layer events before rx: coordinator's
`is_reactable` is `not is_custom_event` and the watcher's rejects custom
events too. Open-layer traffic therefore never touches the filter chains —
an existing cheap pre-dispatch worth noting as KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412 evidence in its own
right (`frames_seen` vs `dispatched` in the probe report quantifies it; use
load-type `1000` as a control run to see it).

## Reading the result for KF-ADR-019f86da-4f90-7f7b-90be-c002b024d412

- If the rx-isolated mean per frame is small against the journal write cost
  and the storage delta, the rx algebra is not the hot layer: **freeze**.
- If it is material, the only optimization shape on the table keeps the
  filter-chain declarations as the single source of truth and derives a
  carrier index from them for single-tag chain pre-dispatch. Replacing the
  rx algebra is off the table: the multi-dimensional routing (`is`/`from`/
  `to` composition), open extension, and subscription-lifetime semantics it
  provides are load-bearing (see the notes in `rx.h` — `steppable`/`holdon`
  is the step primitive both hosts rely on, and the error path is structured
  stop, not silent chain death).
