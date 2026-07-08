---
status: draft
period: 2026-07-08
theme: kungfu-v4-msg-type-registry
doc_type: design
source_level: local-files
confidence: high
sensitivity: internal
evidence_grade: B
review_state: active
last_reviewed: 2026-07-08
ai_provenance:
  generated_by: Codex
  product: Codex CLI
  generated_at: 2026-07-08T10:55:00+08:00
  visible_context: local Kungfu source tree and current user consensus
  invisible_context: exact model build and hidden system implementation are unknown
---

# Message Type Registry

`msg_type` remains a wire-level journal header field. It must stay positive for
published frames and it is still useful for low-level filtering, frame
validation, and compatibility with the yijinjing reader APIs.

v4 resets the business allocation rule: **new product/runtime facts do not get
one `msg_type` per business event.** They use a small carrier set at the journal
layer, and put domain semantics in the payload envelope:

```json
{
  "schema": "kungfu.action-envelope/v1",
  "action_type": "atlas.goal.snapshot",
  "schema_ref": {"id": "kungfu.atlas.GoalSnapshot", "version": 1}
}
```

## v4 Allocations

| Number | Owner | Meaning |
| --- | --- | --- |
| `0` | yijinjing/longfist core | Internal `frame_header`; not a user event. |
| `1` | yijinjing/longfist core | Internal `page_header`; not a user event. |
| `1000` | Kungfu v4 action runtime | `kungfu.action-envelope/v1`; business semantics come from `action_type` and `schema_ref`, not from `msg_type`. |
| `10051 – 10751` | yijinjing runtime service markers | Existing internal service/control tags such as `PageEnd`, `Time`, `Ping`, `Pong`, cache and socket markers. |

Rules:

- New v4 business features should use `1000` unless they can prove a separate
  carrier type is needed at the journal adapter layer.
- KFX and first-party features must not allocate a new raw `msg_type` merely to
  name a business action. Add an `action_type` / schema binding instead.
- `msg_type` may appear in fsck/export/debug output as `journal.msg_type`, but
  GUI/KFX/domain APIs should treat it as implementation metadata.
- `scripts/check-msg-type-allocations.mjs` enforces this rule by blocking new
  raw `300xx` / `400xx` allocations outside reviewed legacy paths.

## Legacy / Migration Context

The repository still contains compiled longfist trading tags and earlier
capability-slice demos. They are historical/runtime compatibility material, not
the v4 business allocation model.

| Legacy range | Status | Notes |
| --- | --- | --- |
| `101 – 799` | legacy compiled longfist/trading tags | Kept while code exists, not extended for v4 agent facts. |
| `20000 – 29999` | legacy capability-slice demos | May remain in isolated demos until each slice migrates to the v4 action envelope. |
| `30000` and above | pre-envelope open layer | Earlier rewind/work/atlas profiles allocated one number per event table. New v4 code should not copy that pattern. |

The Atlas import profile was migrated first: its former `30201 – 30205` event
numbers are replaced by `msg_type = 1000` plus `action_type` values
`atlas.import.begin`, `atlas.mission.snapshot`, `atlas.goal.snapshot`,
`atlas.marker.snapshot`, and `atlas.import.end`.
