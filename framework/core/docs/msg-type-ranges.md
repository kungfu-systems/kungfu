# Message Type Ranges

`msg_type` is a wire-level welded surface: the numbers travel inside journal
frames across processes, languages and years, so allocation needs a single
source of truth. This file is that source. Adding a type means taking a number
from the right range here — duplicate registrations are also rejected at
runtime by the schema registry, but the range discipline is what keeps
independent lines from colliding in the first place.

| Range | Owner | Notes |
| --- | --- | --- |
| `0 – 19999` | longfist closed set | Kernel and trading type registry (`kungfu/longfist`). Currently occupies `0 – 799` and `10051 – 10751`; the whole range is reserved for it. |
| `20000 – 29999` | capability slices | Demo/probe types used by `slices/*` (see `slices/README.md`). Never consumed by products. |
| `30000` and above | open layer | Application types registered at runtime with a self-describing schema (`.bfbs`); governed by the schema registry and per-run manifest bindings, not by this repository's compiled registry. |

Within the capability-slice range:

| Numbers | Slice |
| --- | --- |
| `20001` | `slices/embedding` |
| `20011 – 20013` | `slices/fact-ledger` |
| `20021 – 20022` | `slices/schema-registry` |

First-party allocations within the open layer (informative — the binding
authority remains each run's manifest, but first-party products reserve their
numbers here to avoid colliding with each other):

| Numbers | Product | Schema |
| --- | --- | --- |
| `30001 – 30099` | Kungfu Rewind capture events | `src/python/kungfu/rewind/rewind_events.fbs` (30001 RunBegin, 30002 RunEnd, 30003 ModelRequest, 30004 ModelResponse, 30005 ToolCall, 30006 ToolResult, 30007 RetryMarker) |
