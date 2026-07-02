# Event Model — journal, frame, replay

How kungfu represents and moves data. This is the *use* reference for the data
plane: what an event is, how the journal carries it, and what replay means. For
the vocabulary see [`concepts.md`](concepts.md); for the guarantees this model
makes see [`contracts.md`](contracts.md); for the design rationale see
[`design-philosophy.md`](design-philosophy.md).

Every claim below can be verified against the cited source.

## The journal

The data plane is a single, append-only log of **frames** — `yijinjing`. A
single writer appends frames sequentially to memory-mapped pages; many readers
poll the same pages lock-free, with no serialization on the hot path (zero-copy).
Every component consumes the same frames rather than inventing its own format.

Source: [`framework/core/src/libyijinjing/src/journal/`](../framework/core/src/libyijinjing/src/journal).

## The frame

A frame is a fixed-size header followed by a variable-size payload. The header
fields (defined in
[`longfist/types.h`](../framework/core/src/libkungfu/include/kungfu/longfist/types.h),
`frame_header`):

| Field | Type | Meaning |
|---|---|---|
| `length` | `uint32` | Total frame length (header + body). Also the **publication token** — written last with `std::atomic_ref` release, read with acquire (see [ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)). |
| `header_length` | `uint32` | Header size. |
| `gen_time` | `int64` | When the frame was generated (nanoseconds). |
| `trigger_time` | `int64` | Trigger time, for latency statistics. |
| `msg_type` | `int32` | Message type of the payload. |
| `source` | `uint32` | Source of the frame. |
| `dest` | `uint32` | Destination of the frame. |
| `data_type` | enum | Payload encoding (raw struct vs json). |
| `initial_source` | `uint32` | The original writer of the frame. |
| `frame_uid` | `uint64` | Frame key. |
| `trigger_frame_uid` | `uint64` | The reader's current frame when this frame was generated. |
| `stream_id` | `uint64` | Stream identifier. |

The payload's type is identified by `msg_type` and laid out per the `longfist`
schema — the same bytes are read by C++, Python, and Node without parsing (see
[`contracts.md`](contracts.md)).

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

Source: the replay path in
[`framework/core/src/libkungfu/src/yijinjing/`](../framework/core/src/libkungfu/src/yijinjing).
