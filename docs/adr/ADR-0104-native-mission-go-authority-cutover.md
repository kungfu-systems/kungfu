---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0104
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/978, https://github.com/kungfu-systems/kungfu/pull/997, https://github.com/kungfu-systems/kungfu/pull/1134]
qualification_refs: [framework/core/tests/python/test_atlas_storage.py, framework/core/tests/python/test_action_loop_adapter.py, framework/action/action-loop-source-dogfood.mjs, scripts/run-action-loop-native-authority-tests.mjs, extensions/mission-control/migrations/registry.json, framework/core/src/python/kungfu/agent/kfd3_api.registry.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-16
theme: native-mission-go-authority-cutover
confidence: high
evidence_grade: A
last_reviewed: 2026-07-19
---

# ADR-0104: Mission and Go authority cuts over once at an exact parity root

- Status: accepted; implementation stage-ready
- Date: 2026-07-16
- Category: Mission Control / KFD-1 migration / Project Cut
- Related: [ADR-0059](ADR-0059-mission-control-mission-go-responsibility-model.md),
  [ADR-0061](ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md),
  and [ADR-0097](ADR-0097-project-cut-spacetime-and-publication-boundary.md)

## Context

Mission Control v3 admits Atlas Mission and Go cards as content-addressed bridge
facts and also supports Kungfu-native authoring. That compatibility world is
useful for dogfood, but it cannot remain an open-ended dual-writer arrangement.
Moving authority without an exact source comparison could omit or reinterpret
work. Rewriting the imported facts would erase their original coordinates and
make rollback ambiguous.

The Go model also needs to distinguish containment from execution ordering. A
parent Go states responsibility scope; `depends_on` states prerequisites. The
two relations may coincide in a particular plan but one must not imply the
other.

## Decision

### 1. The migration is append-only and parity-bound

`authority-status` compares the latest completed Atlas import manifest with the
canonical admitted Atlas Mission/Go facts. The comparison pins source ids,
paths, payload hashes, import id, repository head, and a canonical parity root.
Unavailable, missing, extra, or hash-mismatched material degrades the result and
blocks cutover.

`authority-cutover` accepts that exact parity root plus one Project Cut root and
one successor Xinfa Atlas root. It appends a migration receipt to the existing
Mission Control fact world; it does not rewrite or bump the v3 Mission, Go, or
completion-claim surfaces.

### 2. Exactly one mutation authority is active

Before migration, the Atlas bridge remains compatible with the v3 dogfood
world. After a successful cutover, Kungfu-native Mission/Go actions are the only
writer and the Atlas import mutation path is frozen read-only. Its historical
facts and import Episodes remain queryable.

Rollback requires the exact active migration id. It appends another receipt,
restores the Atlas mutation path, and retains native facts read-only. It never
deletes facts or enables both writers.

### 3. Successor Go facts carry explicit responsibility and roots

A native Go may record `parent_goal_id`, `depends_on`, `responsibility`, an
acceptance root, the successor Atlas root, the Project Cut root, and supporting
Episode roots. Parent containment is stored independently from execution
dependencies. Hash roots are validated before admission and self-dependency is
rejected.

### 4. GUI, CLI, and agents share one Profile action boundary

The Mission Control Profile declares the cutover and rollback intents once.
Desktop projects those intents, the CLI applies them through the same authorized
Profile plan and decision receipt, and the public agent catalog is generated
from the KFD-3 API registry. No surface owns a private authority switch.

## Falsification and acceptance gates

- a stale parity root, unavailable source payload, or hash mismatch blocks
  cutover before a migration fact is admitted;
- the first successful cutover freezes Atlas imports and admits a native child
  Go with containment and dependencies preserved separately;
- rollback with a stale migration id fails, while exact rollback restores Atlas
  import and blocks further native mutation;
- migration history, imported facts, native facts, source coordinates, and roots
  remain inspectable after either transition; and
- CLI commands, Profile intents, GUI contributions, and agent API projections
  resolve to the same domain operations and receipts.

## Consequences

Kungfu can become the native Mission/Go authority without declaring Atlas JSON
to be runtime truth and without carrying a permanent dual-writer bridge. The
extra parity and root inputs make cutover deliberately explicit. Rollback is a
new forward event rather than state erasure, so a later re-cutover must prove a
fresh parity basis.

## Stage-ready qualification

The real-control-plane qualification imported 799 Atlas Mission/Go records,
proved exact parity, cut authority over once, and exercised the native
create/claim/review/continuation path before an append-only rollback restored
the Atlas adapter. The post-rollback native write failed closed and a later
Atlas import admitted newly observed facts without deleting native history.

The same run exposed two review-path defects that PR #997 repairs and retains:
the synchronous completion review was incorrectly classified as a live-runtime
assessment request, and a multi-batch Mission query omitted its composed row
count. The Profile action now uses the storage-only Episode append boundary and
the query receipt binds all 586 canonical facts seen by the independent
assessment. `test_agent_profile_sdk.py` and `test_atlas_storage.py` keep both
failures in the stage-ready gate.

The successor Action Loop qualification resolves the Project Cut Mission/Go
coordinates, exact source-built native binding, and active Mission Control
Profile root before mutation. Resume and settlement fail without writes when
that authority drifts; Mission Control reuse receipts retain their payload and
Episode roots; and a same-root initial Atlas refresh is accepted while an exact
later replay remains idempotent.
