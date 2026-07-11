---
status: draft
period: 2026-07-08
theme: kungfu-v4-carrier-type-registry
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
  generated_at: 2026-07-08T12:20:00+08:00
  visible_context: local Kungfu source tree and current user consensus
  invisible_context: exact model build and hidden system implementation are unknown
---

# Carrier Type Registry

`carrier_type` is the low-level journal header classifier. It must stay positive
for published frames and remains useful for reader filtering, frame validation,
and fsck/export metadata.

`carrier_type` is not a business event name. In v4, business semantics live in
the `.fbs`-owned action envelope. Its edge JSON rendering is:

```json
{
  "schema": "kungfu.action-envelope/v1",
  "action_type": "atlas.goal.snapshot",
  "schema_ref": {"id": "kungfu.atlas.GoalSnapshot", "version": 1}
}
```

The JSON object is not the on-journal schema. ADR-0047 requires the current
pre-release JSON/base64 implementation to migrate to `ActionEnvelope.fbs`
before the stable v4 baseline.

## v4 Allocations

| Number | Owner | Meaning |
| --- | --- | --- |
| `0` | yijinjing core | Internal `frame_header`; not a user event. |
| `1` | yijinjing core | Internal `page_header`; not a user event. |
| `1000` | Kungfu action runtime | `kungfu.action-envelope/v1`; business semantics come from `action_type` and `schema_ref`. |
| `10051-10751` | runtime service markers | Existing internal service/control tags such as `PageEnd`, `Time`, `Ping`, `Pong`, cache, and socket markers. |

Rules:

- New v4 business features should use `1000` unless they can prove a separate
  carrier is needed at the journal adapter layer.
- KFX and first-party features must not allocate a raw carrier merely to name a
  business action. Add an `action_type` and schema binding instead.
- Rewind, Work, Atlas import, and KFX dynamic events all dispatch business
  semantics through action envelopes.
- `carrier_type` may appear in fsck/export/debug output as journal metadata.
  GUI/KFX/domain APIs should treat it as implementation metadata.
- `scripts/check-carrier-action-envelope.mjs` blocks new raw `300xx` / `400xx`
  allocation patterns and `MSG_*` business vocabulary in the first-party
  envelope domains.

## Legacy Context

The repository still contains earlier capability-slice demos. They are
historical/runtime compatibility material, not the v4 business allocation model.

| Legacy range | Status | Notes |
| --- | --- | --- |
| `20000-29999` | legacy capability-slice demos | May remain in isolated demos until each slice migrates to the v4 action envelope. |
| `30000+` | deprecated pre-envelope open layer | Earlier profiles allocated one number per event table. New v4 code must not copy this pattern. |

The Atlas, Rewind, Work, and KFX first-party runtime facts now use
`carrier_type=1000` plus action types such as `atlas.goal.snapshot`,
`rewind.model.response`, and `work.item.created`.
