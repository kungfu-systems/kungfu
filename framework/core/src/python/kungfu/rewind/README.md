# kungfu.rewind — capture event model

The event contract for Kungfu Rewind's capture layer (`kungfu trace`). This
package will grow the capture supervisor; today it owns the schema.

## Event model

One traced run = one supervisor process = one journal writer. The supervisor
assigns `run_id`, injects capture environments into the child process tree, and
writes every event as an open-layer journal frame:

| msg_type | Table | Fact |
|---|---|---|
| 30001 | `RunBegin` | run identity, traced command, runtime |
| 30002 | `RunEnd` | terminal status, exit code |
| 30003 | `ModelRequest` | provider, model, request body, attempt |
| 30004 | `ModelResponse` | status, response body, error, tokens, latency |
| 30005 | `ToolCall` | tool name, input, parent span |
| 30006 | `ToolResult` | status, output, error, latency |
| 30007 | `RetryMarker` | retry edge (attempt N of span X) |
| 30008 | `CostSnapshot` | normalized token/cost usage with attribution + confidence |

Allocation is recorded in [`docs/msg-type-ranges.md`](../../../../../../docs/msg-type-ranges.md);
the schema surface is registered in [`docs/versioning.md`](../../../../../../docs/versioning.md).

## How the minimal facts are carried

- **Timing** — the frame header's nanosecond `gen_time` (event time) plus
  `latency_ns` on responses/results.
- **Causality** — two layers, deliberately redundant: the frame header's
  `trigger_frame_uid` (frame-level, what replay walks) and `span_id` /
  `parent_span_id` (semantic, what survives export).
- **Error and retry** — `CallStatus` + `error` on results; `attempt` and
  `RetryMarker` for retry edges.
- **Cross-runtime identity** — `run_id` is shared by every runtime feeding the
  same supervisor journal; `CaptureLayer` keeps provenance (wire truth vs
  in-process semantics vs adapters).

Payload bodies (`request_body`, `input`, ...) are JSON strings: capture keeps
full local fidelity; redaction is an export-time concern, never a capture-time
one.

## Decode without the writer

Rewind events are open-layer: each run's manifest binds these msg_types to the
content-addressed `.bfbs` of this schema, so a trace bundle is decodable by
reflection alone — no generated code, no compiled registry. The mechanism (and
its regression probe) is `slices/schema-registry`.
