---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-31
theme: node-watcher-runtime-boundary
doc_type: qualification-evidence
sources: [executable-probe, local-files]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-31
ai_provenance: OpenAI GPT-5 via Codex on 2026-07-31; based on repository source, local executable probes, and user-authorized implementation; exact hidden model checkpoint and future protected platform results are not claimed
---

# Node Watcher Runtime Boundary Qualification

## Claim

The Node watcher is a thin, product-neutral bridge over the existing Kungfu
journal, reactor, and RxCpp event mechanism. Long-lived consumption runs on one
dedicated native thread, not a `uv_queue_work` job. Native-to-Node snapshot
wakeups use a one-slot queue and coalesce while the Node consumer is slow.
Product snapshot meaning remains owned by System KFX and Domain Profiles.

This is an implementation and qualification claim, not a claim that Core owns
product state semantics or that every product surface has migrated to the
watcher.

## Measured baseline

The pre-change watcher held one libuv worker for its complete lifetime. With
`UV_THREADPOOL_SIZE=1`, a 1,000-iteration `crypto.pbkdf2` submitted after
`watcher.start()` remained starved at the 1.5-second deadline. The same probe
completes after the dedicated-thread change while the watcher remains live.

The dispatch bench also had a stale `"quote"` argument even though its Python
driver accepts only numeric carrier ids. The harness now uses closed Core
`SyntheticData` carrier `601`; open carrier `1000` remains the intentional
pre-dispatch control.

## Runtime contract

`Watcher.runtimeStats()` returns
`kungfu.node-watcher-runtime-stats/v1` with:

- step count, mean and maximum step duration;
- worker and snapshot mutex wait, plus snapshot mutex hold duration;
- snapshot request, delivery, coalescing, queue depth, and bridge failures;
- the fixed bridge capacity of one;
- custom-frame queue frames, bytes, fixed byte capacity, and explicit drops.

The snapshot callback queue cannot exceed one entry. A newer wakeup supersedes
an already-pending wakeup because the state bank is a current-state fold, while
journal order and custom transport frames remain in their existing ordered
paths. Fatal worker errors retain the existing typed JavaScript error mapping.
Quit, fatal error, and environment cleanup all stop and join the native thread;
the stopped event is ordered after any pending snapshot event.

## Qualification

Run the focused lifecycle and worker-pool probes:

```sh
./shifu test:node-watcher-runtime-boundary
```

Run the real two-Peer mmap journal plus nng-notice qualification:

```sh
./shifu test:agent-session-peer-transport:native
```

The native transport fixture writes a 512-frame burst, stalls the Node reader
for 250 milliseconds, and then proves:

- the last cursor and payload arrive in order;
- the one-slot snapshot bridge coalesced wakeups;
- step and snapshot timing probes observed real work;
- the bridge reported no delivery failure; and
- the existing bounded custom-frame queue did not become a callback fanout.

The qualified Core candidate action runs both commands after `rebuild:core` on
Darwin arm64/x64, Linux x64, and Windows x64 merge-group candidates. The
retained candidate reports bind results to the exact source revision; a local
pass is not a substitute for those platform reports.

## Known limits

- Timings are observational nanoseconds for comparison and diagnosis, not a
  real-time scheduling guarantee.
- Snapshot coalescing applies to Node wakeups, not to journal facts or custom
  transport frame ordering.
- The existing four-MiB custom-frame queue reports overflow explicitly; slow
  consumers must handle the resulting gap.
- Platform support is admitted only when the exact-revision candidate jobs
  pass. Until then, local macOS evidence remains provisional.
