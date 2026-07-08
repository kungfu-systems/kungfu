# Event Model — journal, frame, replay

How kungfu represents and moves data. This is the *use* reference for the data
plane: what an event is, how the journal carries it, and what replay means. For
the vocabulary see [`concepts.md`](concepts.md); for the guarantees this model
makes see [`contracts.md`](contracts.md); for the design rationale see
[`design-philosophy.md`](design-philosophy.md).

Every claim below can be verified against the cited source.

The higher-level action-timeline decision is
[ADR-0020](../framework/core/docs/adr/ADR-0020-agent-action-timeline-and-replay-boundary.md):
Kungfu records the causal action chain and attached evidence, not a complete
snapshot of the outside world.

The action-recording implementation boundary is
[ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md):
architecture-level recording semantics live in the C++ core. Python and Node may
wrap the recorder and build payloads, but they must not own independent
causality, writer, timeline, or receipt logic.

Frame integrity starts at the same C++ boundary. [ADR-0023](../framework/core/docs/adr/ADR-0023-frame-integrity-and-msg-type-allocation-gates.md)
defines the first receipt-based checksum slice and the rule that new v4 business
facts must not allocate raw `300xx` / `400xx` `carrier_type` numbers.
[ADR-0025](../framework/core/docs/adr/ADR-0025-carrier-type-and-action-envelope-semantics.md)
then completes that rename: `carrier_type` is transport metadata, and business
semantics live in `kungfu.action-envelope/v1`.

Location identity uses neutral roles, not trading categories. [ADR-0024](../framework/core/docs/adr/ADR-0024-location-role-and-journal-page-policy.md)
defines `source`, `sink`, `actor`, `system`, and `service`, and keeps journal
page sizing as storage policy rather than role-derived behavior.

For multi-machine views, frame time is not treated as a universal clock.
[ADR-0021](../framework/core/docs/adr/ADR-0021-observer-relative-timeline-projection.md)
pins the rule: Kungfu stores causal facts, source provenance, accepted ranges,
and payload evidence; a user-visible mixed-source timeline is a deterministic
projection from an explicit observer policy. Causal links dominate that policy.

## The journal

The data plane is a single, append-only log of **frames** — `yijinjing`. A
single writer appends frames sequentially to memory-mapped pages; many readers
poll the same pages lock-free, with no serialization on the hot path (zero-copy).
Every component consumes the same frames rather than inventing its own format.

Source: [`framework/core/src/libyijinjing/src/journal/`](../framework/core/src/libyijinjing/src/journal).

## The frame

A frame is a fixed-size header followed by a variable-size payload. The header
fields (defined in
[`frame.h`](../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h),
`frame_header`):

| Field | Type | Meaning |
|---|---|---|
| `length` | `uint32` | Total frame length (header + body). Also the **publication token** — written last with `std::atomic_ref` release, read with acquire (see [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)). |
| `header_length` | `uint32` | Header size. |
| `gen_time` | `int64` | When the frame was generated (nanoseconds). |
| `trigger_time` | `int64` | Trigger time, for latency statistics. |
| `carrier_type` | `int32` | Wire-level carrier type. In v4 business facts normally use the generic action-envelope carrier and put semantics in `action_type` / `schema_ref`. |
| `source` | `uint32` | Source of the frame. |
| `dest` | `uint32` | Destination of the frame. |
| `data_type` | enum | Payload encoding (raw struct vs json). |
| `initial_source` | `uint32` | The original writer of the frame. |
| `frame_uid` | `uint64` | Frame key. |
| `trigger_frame_uid` | `uint64` | The reader's current frame when this frame was generated. |
| `stream_id` | `uint64` | Stream identifier. |

Closed yijinjing/runtime frames may still identify their payload layout directly
through `carrier_type`. New v4 business facts should use the generic action
envelope carrier: the journal header keeps `carrier_type` for filtering and fsck,
while the payload names the domain action through `action_type` and
`schema_ref`. The same bytes are read by C++, Python, and Node without inventing
per-language causality logic (see [`contracts.md`](contracts.md)).

Current `frame_header` does not contain an in-frame checksum. New
`action_recorder` receipts carry `integrity_version`, `checksum_algorithm`,
`payload_checksum`, and `frame_checksum`; fsck can persist and verify those
receipt fields by reopening the recorded frame. The current checksum algorithm
is `fnv1a64`: a fast corruption detector, not a cryptographic authenticity
proof. Content payloads and manifests use explicit content hashes such as
`sha256`; internal yijinjing uid helpers use `fast_hash_*` / `xxh3_64` /
`xxh3_128` and must not be treated as content hashes. The taxonomy is pinned in
[ADR-0028](../framework/core/docs/adr/ADR-0028-hash-taxonomy-and-integrity-algorithms.md).
A full frame trailer or chain root is a future journal format surface, not
something older journals can be assumed to contain.

## Routing: source and dest

Frames carry `source` and `dest`, so the one journal is a shared bus: a reader
selects the frames addressed to it (or observes all of them). `initial_source`
preserves the original writer when a frame is forwarded, and `trigger_frame_uid`
links a frame to the input frame that produced it — which is what makes a causal
chain reconstructable.

## Publication and visibility

A reader must never see a frame before its payload is fully written. The contract
that guarantees this — and why a plain `volatile` flag was not enough on
weak-memory (ARM) targets — is [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md):
the writer publishes `length` last with a release store; the reader gates on
`length` with an acquire load before reading the payload.

## Replay

Replay re-reads recorded journals on the **same runtime and the same semantics**
as live: there is no separate replay engine. Because the frames carry
nanosecond `gen_time`, the `trigger_frame_uid` causal links, and a fixed layout,
a recorded stream reproduces with high precision. The determinism this provides,
and its boundaries, are stated in [`contracts.md`](contracts.md).

Across sources or machines, replay and inspection should prefer causal links,
accepted ranges, and observer projection metadata over wall-clock order alone.
Two observers may keep different stable projections of concurrent facts; the
view is trustworthy when its policy is explicit and reproducible.

For agent runs, replay is layered. Forensic replay reopens, decodes, verifies,
and walks the recorded causal tree without re-executing external effects.
Mocked replay may substitute recorded receipts for external calls. Any replay
mode that can repeat real-world side effects must be explicit and confirmed.
This boundary is pinned by
[ADR-0020](../framework/core/docs/adr/ADR-0020-agent-action-timeline-and-replay-boundary.md).

Source: the replay path in
[`framework/core/src/libkungfu/src/runtime/`](../framework/core/src/libkungfu/src/runtime).
