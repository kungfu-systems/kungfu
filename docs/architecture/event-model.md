# Event Model — journal, frame, replay

How kungfu represents and moves data. This is the *use* reference for the data
plane: what an event is, how the journal carries it, and what replay means. For
the vocabulary see [`concepts.md`](../concepts/implementation-concepts.md); for the guarantees this model
makes see [`contracts.md`](../qualification/contracts.md); for the design rationale see
[`design-philosophy.md`](../concepts/design-philosophy.md).

Every claim below can be verified against the cited source.

The higher-level action-timeline decision is
[KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf](../adr/KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf.md):
Kungfu records the causal action chain and attached evidence, not a complete
snapshot of the outside world.

On the temporal plane, the first-class storage object for bounded causal work
is an Episode:
[KF-ADR-019f86da-4f90-791c-9b90-4888cca36327](../adr/KF-ADR-019f86da-4f90-791c-9b90-4888cca36327.md)
defines Episode as the causal-closure container and the future
export/import/fsck/timeline-slicing unit. Raw mmap pages are append blocks;
Episodes are the temporal semantic objects projected into user-visible
timelines. This does not make Episode the sole runtime substrate: admitted
state is preserved as Fact at explicit Cuts. The current relationship between
journal authority, Fact state, and Episode causal experience is defined in
[Fact, Episode, and Action Primitive Runtime](fact-episode-action-runtime.md).

The action-recording implementation boundary is
[KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81](../adr/KF-ADR-019f86da-4f90-70f3-9a0e-d502826fbc81.md):
architecture-level recording semantics live in the C++ core. Python and Node may
wrap the recorder and build payloads, but they must not own independent
causality, writer, timeline, or receipt logic.

Frame integrity starts at the same C++ boundary. [KF-ADR-019f86da-4f90-7d72-bf9f-1d5913bbb0d5](../adr/KF-ADR-019f86da-4f90-7d72-bf9f-1d5913bbb0d5.md)
defines the first receipt-based checksum slice and the rule that new v4 business
facts must not allocate raw `300xx` / `400xx` `carrier_type` numbers.
[KF-ADR-019f86da-4f90-7c76-bf49-3e804d3ba63f](../adr/KF-ADR-019f86da-4f90-7c76-bf49-3e804d3ba63f.md)
then completes that rename: `carrier_type` is transport metadata, and business
semantics live in `kungfu.action-envelope/v1`.
[KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3](../adr/KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3.md)
assigns each structured fact one schema owner: closed kernel records use Hana
POD, while the action envelope and open/domain payloads use `.fbs`. JSON is an
edge rendering or adapter format, not a third journal schema.

Location identity uses neutral roles, not trading categories. [KF-ADR-019f86da-4f90-71ac-bb91-32456981141a](../adr/KF-ADR-019f86da-4f90-71ac-bb91-32456981141a.md)
defines `source`, `sink`, `actor`, `system`, and `service`, and keeps journal
page sizing as storage policy rather than role-derived behavior.

For multi-machine views, frame time is not treated as a universal clock.
[KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48](../adr/KF-ADR-019f86da-4f90-704e-9488-a793b1c4bf48.md)
pins the rule: Kungfu stores causal facts, source provenance, accepted ranges,
and payload evidence; a user-visible mixed-source timeline is a deterministic
projection from an explicit observer policy. Causal links dominate that policy.

## The journal

The data plane is a single, append-only log of **frames** — `yijinjing`. A
single writer appends frames sequentially to memory-mapped pages; many readers
poll the same pages lock-free, with no serialization on the hot path (zero-copy).
Every component consumes the same frames rather than inventing its own format.

Source: [`framework/core/src/libyijinjing/src/journal/`](../../framework/core/src/libyijinjing/src/journal).

## The frame

A frame is a fixed-size header followed by a variable-size payload. The header
fields (defined in
[`frame.h`](../../framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/frame.h),
`frame_header`):

| Field | Type | Meaning |
|---|---|---|
| `length` | `uint32` | Total frame length (header + body). Also the **publication token** — written last with `std::atomic_ref` release, read with acquire (see [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](../adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md)). |
| `header_length` | `uint32` | Header size. |
| `gen_time` | `int64` | When the frame was generated (nanoseconds). |
| `trigger_time` | `int64` | Trigger time, for latency statistics. |
| `carrier_type` | `int32` | Wire-level carrier type. In v4 business facts normally use the generic action-envelope carrier and put semantics in `action_type` / `schema_ref`. |
| `source` | `uint32` | Source of the frame. |
| `dest` | `uint32` | Destination of the frame. |
| `data_type` | enum | Low-level payload encoding marker. Closed records use raw POD; the current JSON value remains a transitional/edge-compatible encoding, not schema authority. |
| `initial_source` | `uint32` | The original writer of the frame. |
| `frame_uid` | `uint64` | Frame key. |
| `trigger_frame_uid` | `uint64` | The reader's current frame when this frame was generated. |
| `stream_id` | `uint64` | Stream identifier. |

Closed yijinjing/runtime frames identify their Hana POD layout directly through
`carrier_type`. New v4 business facts use the generic action-envelope carrier:
the journal header keeps `carrier_type` for filtering and fsck, while the
FlatBuffers envelope names the domain action through `action_type` and
`schema_ref`. Its journal body is the verified `ActionEnvelope.fbs` `KFAE`
buffer; JSON/base64 is emitted or accepted only by named edge adapters. C++,
Python, and Node share the C++ recording and causality semantics (see
[`contracts.md`](../qualification/contracts.md)).

Current `frame_header` does not contain an in-frame checksum. New
`action_recorder` receipts carry `integrity_version`, `checksum_algorithm`,
`payload_checksum`, and `frame_checksum`; fsck can persist and verify those
receipt fields by reopening the recorded frame. The current checksum algorithm
is `fnv1a64`: a fast corruption detector, not a cryptographic authenticity
proof. Content payloads and manifests use explicit content hashes such as
`sha256`; internal yijinjing uid helpers use `fast_hash_*` / `xxh3_64` /
`xxh3_128` and must not be treated as content hashes. The taxonomy is pinned in
[KF-ADR-019f86da-4f90-7d2c-aaa5-974ca5e38654](../adr/KF-ADR-019f86da-4f90-7d2c-aaa5-974ca5e38654.md).
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
weak-memory (ARM) targets — is [KF-ADR-019f86da-4f90-7179-a900-c40bdb498910](../adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910.md):
the writer publishes `length` last with a release store; the reader gates on
`length` with an acquire load before reading the payload.

## Replay

Replay re-reads recorded journals on the **same runtime and the same semantics**
as live: there is no separate replay engine. Because the frames carry
nanosecond `gen_time`, the `trigger_frame_uid` causal links, and a fixed layout,
a recorded stream reproduces with high precision. The determinism this provides,
and its boundaries, are stated in [`contracts.md`](../qualification/contracts.md).

Across sources or machines, replay and inspection should prefer causal links,
accepted ranges, and observer projection metadata over wall-clock order alone.
Two observers may keep different stable projections of concurrent facts; the
view is trustworthy when its policy is explicit and reproducible.

Episode-aware replay and inspection select Episodes first and then walk the
closed frame-level causal chains inside them.
Cross-Episode influence should appear as declared Episode dependencies, not as
an undeclared frame-level chain that silently leaves the selected object.

For Episodes created by the Agent Work capture profile, Replay is layered.
Forensic Replay reopens, decodes, verifies, and walks the recorded causal tree
without re-executing external effects. Mocked Replay may substitute recorded
Receipts for external calls. Any mode that can repeat real-world side effects
must be explicit and confirmed. Rewind is the user-facing reopening operation;
it is not a synonym for re-execution. This boundary is pinned by
[KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf](../adr/KF-ADR-019f86da-4f90-7c8c-b8ef-5b46308541bf.md).

Source: the replay path in
[`framework/core/src/libkungfu/src/runtime/`](../../framework/core/src/libkungfu/src/runtime).
