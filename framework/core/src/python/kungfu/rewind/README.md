# kungfu.rewind — capture event model

The event contract for Kungfu Rewind's capture layer (`kungfu trace`). This
package will grow the capture supervisor; today it owns the schema.

## Event model

One traced run = one supervisor process = one journal writer. The supervisor
assigns `run_id`, injects capture environments into the child process tree, and
writes every event as an open-layer journal frame:

| carrier_type | Table | Fact |
|---|---|---|
| action envelope | `RunBegin` | run identity, traced command, runtime |
| action envelope | `RunEnd` | terminal status, exit code |
| action envelope | `ModelRequest` | provider, model, request body, attempt |
| action envelope | `ModelResponse` | status, response body, error, tokens, latency |
| action envelope | `ToolCall` | tool name, input, parent span |
| action envelope | `ToolResult` | status, output, error, latency |
| action envelope | `RetryMarker` | retry edge (attempt N of span X) |
| action envelope | `CostSnapshot` | normalized token/cost usage with attribution + confidence |
| action envelope | `ApprovalDecision` | human approve/deny/interrupt/resume decision, linked to run_id |

Allocation is recorded in [`docs/carrier-type-registry.md`](../../../../docs/carrier-type-registry.md);
the schema surface is registered in [`docs/development/versioning.md`](../../../../../../docs/development/versioning.md).

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

## Managed-run response evidence

`kungfu managed-run` drives provider CLIs through their structured-output
surfaces (`codex exec --json`, `claude --print --output-format json`). Besides
the `CostSnapshot` cost fact, it emits a Supervisor-layer `ModelResponse` with
the provider's response body and writes `response.json` next to the run
`manifest.json` in the rewind bundle. Use `--print-response` when a smoke test
needs to assert the provider's answer text directly.

## Decode without the writer

Rewind events are open-layer: each run's manifest binds these carrier_types to the
content-addressed `.bfbs` of this schema, so a trace bundle is decodable by
reflection alone — no generated code, no compiled registry. The mechanism (and
its regression probe) is `slices/schema-registry`.
