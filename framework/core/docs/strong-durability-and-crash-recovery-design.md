---
status: draft
period: 2026-07-12
theme: strong-durability-and-crash-recovery
doc_type: design
source_level: user-consensus + local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-12
  invisible_context_boundary: Exact hidden model build, future implementation behavior, and unqualified storage hardware guarantees are unknown
---

# Strong-durability and crash-recovery design

This document turns [ADR-0068](adr/ADR-0068-tiered-durability-and-crash-recovery.md)
into an implementation and qualification plan. The public, reader-first status
is [Strong durability and crash recovery](../../../docs/durability-and-crash-recovery.md).

## 1. Goals and non-goals

Goals:

- preserve mmap publication latency and zero-copy live reads;
- let each load-bearing operation select an explicit durability profile;
- provide monotonic, inspectable visible/durable/projected watermarks;
- make acknowledgements correspond to a proven recovery frontier;
- recover deterministically after process, OS, filesystem, and storage faults
  within a declared qualification envelope;
- keep typed journal facts authoritative and SQLite projections rebuildable;
- isolate coordinator availability from durable ingest and projection failures;
- give agents machine-readable status, lag, receipts, and recovery reports.

Non-goals for the first implementation:

- distributed consensus or multi-node linearizability;
- a universal guarantee across every filesystem, controller, drive, or VM;
- making every telemetry frame synchronously durable;
- treating a projection database as the fact authority;
- changing Hana POD versus FlatBuffers ownership or introducing JSON semantics
  into the service contract;
- silently upgrading existing `visible` callers to a slower durability profile.

## 2. Current implementation baseline

| Area | Current behavior | Architectural interpretation |
|---|---|---|
| frame publication | payload/header fields are completed before release-publishing frame length; readers acquire-load length | qualified live visibility boundary, not persistence |
| mmap policy | `visibility` accepted; `asynchronous` and `durable` rejected in production policy | correct fail-closed basis |
| mapped flush | platform flush primitive exists and is exercised by tests/qualification | visibility/writeback observation only; not an end-to-end power-loss receipt |
| frame integrity | CRC32C receipt metadata and container-epoch contracts exist | detects classes of corruption; does not create durability |
| content objects | immutable store can request sync-on-publish | useful backend primitive, not a journal-wide guarantee |
| projections | source, manifest, Episode, and state SQLite stores use WAL and are rebuildable; several use synchronous mode off | query accelerator, never durability authority |
| live topology | coordinator owns `state_cache`, joins business streams, stores/restores state | compatibility implementation to be split |
| Episode | typed manifests, qualification/capability/repair slices and fault matrix exist | semantic recovery boundary is staged, not fully durability-qualified |

The migration begins from this behavior. It does not relabel existing success as
durable.

## 3. Runtime topology

```text
                        +-------------------------------+
                        | coordinator                   |
peer control journals ->| membership / topology / ACL   |
                        +-------------------------------+

peer business writer
        |
        v
+------------------+        +----------------------------+
| hot mmap journal |------->| live readers               |
+------------------+        +----------------------------+
        |
        v
+------------------+        +----------------------------+
| durable_ingest   |------->| durable typed segments     |
| - subscriptions  |        | checkpoint + checksum data |
| - batching       |        +----------------------------+
| - sync barriers  |                    |
| - receipts       |                    +------> recovery/replay
+------------------+                    |
        |                               v
        |                   +----------------------------+
        +------------------>| projection_service         |
                            | SQLite/query/snapshots      |
                            +----------------------------+
```

There is one state-service instance per resolved data root. Operationally,
`durable_ingest` and `projection_service` may share that process at first, but
their queues, watermarks, errors, and restart behavior stay separate.

The coordinator subscribes to control-plane streams needed for membership and
topology. It authorizes/discovers business streams but does not consume all of
their payloads merely to build state.

### Current separation and single-host fencing slice

The first migration slice keeps the state service in the coordinator process
but removes direct `state_cache::manager` ownership from the coordinator. The
service owns projection construction, start/stop, ingestion, restore, and
status. Its lifecycle is independently testable and rejects mutation before
start or after stop.

Before opening projection storage, the service acquires an exclusive OS file
lock under the resolved data root. Every physical source/destination journal
writer acquires the same kind of exclusive lock for its stream resource before
it can issue a business write. The evidence records a monotonically increasing
generation, a new fence token, owner PID, acquisition time, and whether the
prior owner ended without a clean release. Process-local reservations close
the same-process gap where platform file-lock semantics may otherwise permit a
duplicate owner.

These locks implement the trusted single-host envelope only. The PID is
diagnostic, never the authority: possession of the live OS lock is required.
The JSON lock record and its `fsync`/`FlushFileBuffers` are operational fencing
evidence, not a durability receipt, durable watermark, network lease, or
defence against a malicious host administrator. A corrupt evidence record may
lose historical generation continuity and must not be used to claim a durable
fact frontier.

The compatibility/split shadow comparator keys observations by logical stream
position and compares caller-supplied state digests. It reports duplicate,
missing, unequal, and equal observations and can restore its diagnostic state
after restart. Shadow equality does not make projection authoritative and does
not advance any durability watermark.

The in-process compatibility bridge may be deleted only when all of these gates
are mechanically evidenced:

1. business-stream joins and projection ownership have moved out of the
   coordinator;
2. split-path shadow comparison is converged across duplicate, missing,
   restart, and equality fixtures;
3. all state mutations require a current data-root ownership generation and
   stream writes require a current writer fence;
4. peer registration, visible-state restore, and control-plane behavior pass
   the retained characterization suite; and
5. durable ingest and projection recovery have independent qualified restart
   paths.

## 4. Typed contract

The exact Hana records and public SDK names are decided in the implementation
slice, but the semantic fields are fixed here.

### StreamPosition

```text
StreamPosition {
  stream_id
  container_epoch
  sequence
  frame_uid
}
```

Requirements:

- total order within one stream epoch;
- stable across page rollover and process restart;
- no dependence on wall-clock uniqueness;
- enough physical location data may be attached for efficient lookup, but a
  pathname/offset is not the semantic identity;
- comparison across streams requires an explicit observer/merge policy rather
  than pretending there is one global clock.

### DurabilityReceipt

```text
DurabilityReceipt {
  request_id
  position
  requested_profile
  achieved_profile
  durable_watermark
  barrier_id
  completed_at
  status / typed_error
}
```

`completed_at` is diagnostic; position and barrier identity establish the
contract. Batch receipts can share a `barrier_id`. The service deduplicates a
retry by `request_id` plus fact identity and rejects conflicting reuse.

### ServiceStatus

The machine-readable status reports at least:

- service/data-root identity and process generation;
- subscribed stream set and per-stream epochs;
- visible, durable, projection, and optional replicated watermarks;
- byte/frame lag and oldest lag age;
- active durability profile and batch policy;
- last successful barrier and last typed error;
- projection schema/version and rebuild state;
- recovery state and last recovery-report reference;
- qualification profile/reference for every claimed durability mode.

JSON may project this typed result at CLI/SDK edges; it is not the internal
service protocol.

## 5. Ingest and acknowledgement protocol

### Visible

1. writer finishes frame bytes and integrity metadata;
2. writer release-publishes the frame length;
3. live readers acquire-observe the frame;
4. `visible` completion may return.

No disk barrier is implied.

### Durable group

1. durable ingest consumes only fully published, structurally valid frames;
2. it appends exact typed frame data plus ordering/integrity metadata to the
   active durable segment;
3. a batch closes under a declared time/byte/frame policy;
4. data and required metadata are synchronized in the platform-specific order;
5. the durable checkpoint/watermark is atomically published and synchronized;
6. only then are receipts for positions in the batch completed.

### Durable sync

The same protocol uses a barrier that includes the requesting position without
waiting for the normal group interval. Implementations may coalesce concurrent
requests, but cannot delay beyond the declared timeout or report success before
the barrier completes.

The durable checkpoint must not point beyond synchronized segment data. A
segment may contain bytes beyond the checkpoint after a crash; those bytes are
unacknowledged candidates and require validation/classification before use.

## 6. Segment and checkpoint rules

The first durable backend may reuse yijinjing-compatible page/segment bytes or
introduce an archive container, but it must preserve typed frame semantics and
offline inspectability. The choice is subordinate to these invariants:

- append-only active segment; immutable sealed segments;
- versioned container epoch and checksum coverage;
- checkpoint publication never precedes its covered data barrier;
- segment creation/rename and parent-directory ordering are explicit;
- rollover cannot skip or duplicate a logical stream position;
- retention/compaction acts only on sealed, covered, and dependency-safe ranges;
- unknown tail bytes are retained or quarantined for diagnosis before any
  destructive repair policy is applied.

Native mmap `durable` mode may later optimize a supported backend, but the
receipt protocol remains above it so callers do not depend on one OS primitive.

## 7. Projection and bootstrap

Projection reads from the durable stream by default. A low-latency speculative
projection may read the visible tail only if it labels that state speculative
and can roll it back after recovery; it cannot advance `projection_watermark`
for durable query semantics beyond the durable cut.

Each projection transaction records its input end position. Snapshot delivery
returns:

```text
StateSnapshot {
  projection_id
  schema_version
  through_position T
  payload/reference
  integrity
}
```

A peer restores the snapshot through `T` and subscribes strictly after `T`.
Duplicate boundary delivery must be harmless and tested. Peers declare:

- `required`: do not start active work without a qualified snapshot/cut;
- `optional`: start with explicit degraded/lag status;
- `none`: no state bootstrap.

## 8. Failure behavior

| Failure | Required behavior |
|---|---|
| durable service unavailable | `visible` work follows declared policy; durability-requiring writes wait, backpressure, or fail explicitly |
| ENOSPC / I/O / sync error | durable watermark does not advance; no success receipt; status names the blocking error |
| projection crash or schema error | durable ingest continues; projection watermark stops; queries report stale/unavailable and can rebuild |
| coordinator crash | membership/control may pause; already established durable facts and state-service recovery do not depend on coordinator memory |
| peer crash before durable receipt | retry by stable request/fact identity; result is deduplicated or explicitly unknown, never guessed |
| checkpoint ahead of valid data | treat checkpoint as invalid, fall back to last provable frontier, quarantine disagreement |
| valid data beyond checkpoint | classify as unacknowledged tail; never claim it was acknowledged without evidence |
| torn/corrupt tail | stop at last verified boundary, report exact range, preserve forensic bytes where safe |
| Episode interrupted across surfaces | fold durable evidence, expose missing side and safe capabilities, apply idempotent repair rules |

## 9. Recovery state machine

```text
START
  -> DISCOVER containers/checkpoints
  -> VERIFY identity, ordering, checksums, metadata
  -> SELECT last provable durable frontier
  -> CLASSIFY tail and interrupted Episodes
  -> REPAIR or QUARANTINE according to explicit policy
  -> REBUILD/RESUME projections from recorded cuts
  -> REPORT machine-readable result
  -> READY (or DEGRADED / BLOCKED)
```

Recovery is read-only through `CLASSIFY`. Any truncation, replacement, or
repair is an explicit maintenance action with preview, retained evidence, and
idempotence checks. Normal startup may ignore an untrusted tail for service
availability, but it must not silently delete that tail.

## 10. Migration from coordinator-owned state cache

1. **Contract-only slice** — add typed positions/status/receipts and adapters;
   all current paths report `visible` only.
2. **Interface split** — separate state-cache feed, store, projection, and
   restore interfaces inside the current process; retain observable behavior.
3. **Shadow ingest** — run durable ingest against selected test streams without
   returning durable receipts; compare sequence, checksum, restart, and lag.
4. **Shadow projection** — rebuild a separate projection from the durable cut
   and compare typed state with the compatibility state cache.
5. **State-service activation** — move the split components to the per-data-root
   service; coordinator keeps a temporary compatibility bridge.
6. **Bootstrap cutover** — peers use snapshot-at-`T` plus replay-after-`T`;
   remove coordinator business joins and restore ownership.
7. **Profile exposure** — expose `durable_group`, then `durable_sync`, only for
   platform profiles whose qualification reports pass.

Each cutover has counters for duplicate/missing frames, watermark monotonicity,
state mismatches, lag, barrier latency, and recovery result. Rollback switches
read authority back to the previous stage without rewriting journal facts.

## 11. Qualification plan

Keep mmap performance qualification and durability qualification separate.
Neither substitutes for the other.

### Correctness matrix

- crash before/after frame publication;
- crash before append, after append, during barrier, after data sync, during
  checkpoint publication, and after receipt emission;
- rollover and directory-entry ordering at every boundary;
- torn frame, torn checkpoint, corrupt checksum, stale duplicate checkpoint;
- ENOSPC and injected write/sync/rename failures;
- projector crash, projection deletion, incompatible projection schema, full
  rebuild, and repeated rebuild;
- producer retry before/after an unknown receipt;
- Episode seal across durable fact, manifest, content, and projection cuts;
- concurrent independent streams plus one overloaded stream;
- repeated recovery for idempotence and fault containment.

### Platform evidence

- Linux: disposable filesystem/device harness capable of controlled I/O faults
  and sudden termination, with filesystem/mount/device facts retained;
- macOS: disposable volume/VM or equivalent bounded harness, with unsupported
  controller-cache claims stated explicitly;
- Windows: disposable volume/VM harness validating mapped-view and file-handle
  flush ordering plus metadata behavior;
- all platforms: ordinary process-kill campaign as the fast inner tier.

The report records source revision, compiler/runtime, OS, filesystem, device or
VM facts, profile parameters, fault coverage, seeds, raw violations, latency
distributions, recovery output, and explicit non-claims.

### Acceptance gates

A profile may be advertised only when:

1. no acknowledged position is lost in the declared fault envelope;
2. no recovery run invents, duplicates, or silently reorders a fact;
3. durable and projection watermarks remain monotonic and honest;
4. injected storage failures never produce false success;
5. projection loss rebuilds to the same typed state at the same cut;
6. Episode capability decisions match the independent fault oracle;
7. performance distributions and supported workload envelope are retained;
8. known hardware/filesystem gaps remain visible in the report and public
   capability output.

## 12. Documentation and release contract

The public status page is updated at every stage. Release notes and capability
output name the precise implemented/qualified profile. ADR acceptance alone
does not move a stage to implemented; code, tests, retained evidence, and
machine-readable capability reporting must agree.
