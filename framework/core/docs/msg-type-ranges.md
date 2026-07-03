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
| `30101 – 30199` | Kungfu work items (default work profile) | `src/python/kungfu/work/work_events.fbs` (30101 WorkItemCreated, 30102 WorkStatusChanged, 30103 NextActionSet, 30104 CheckpointRecorded, 30105 DecisionRecorded, 30106 ValidationRecorded, 30107 ArtifactRecorded, 30108 RunLinked) |
| `30201 – 30299` | Kungfu Atlas import profile (read-only control-plane snapshots) | `src/python/kungfu/atlas/atlas_events.fbs` (30201 ImportBegin, 30202 MissionSnapshot, 30203 GoalSnapshot, 30204 MarkerSnapshot, 30205 ImportEnd) |
| `40000 – 49999` | Third-party kfx dynamic event schemas | No first-party `.fbs` — a kfx author compiles its own schema at runtime (`kungfu schema compile` / `pykungfu.yijinjing.compile_schema`) and registers the `.bfbs` into a run's manifest under a number in this band. The `sandboxed` trust tier is *constrained* to this band so an untrusted kfx cannot claim a first-party number (e.g. masquerade as `30005 ToolCall`); the `trusted` (node-integrated) tier may use any open-layer number but should still avoid the first-party sub-ranges above. |
