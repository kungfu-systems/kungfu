---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0111
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1048]
qualification_refs: [framework/runtime/kungfu-diagnostics.contract.json, scripts/check-health-diagnostics-contract.test.mjs, framework/core/tests/python/test_recovery.py, framework/core/tests/python/test_episode_control.py, docs/qualification/unified-recovery.md]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-17
theme: fenced-unified-recovery-entry
confidence: high
evidence_grade: B
last_reviewed: 2026-07-17
---

# ADR-0111: Unified recovery is a fenced orchestrator over existing authorities

- Status: accepted; implementation pending integration
- Date: 2026-07-17
- Category: recovery / product diagnostics / runtime / storage
- Related: [ADR-0107](ADR-0107-unified-read-only-product-diagnostics.md),
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
  [ADR-0086](ADR-0086-live-peer-continuity-and-coordinator-authority.md), and
  [ADR-0041](ADR-0041-episode-manifest-first-class-journal-structure.md)

## Context

Kungfu already has authoritative recovery operations for runtime activation,
Peer lifecycle control, rebuildable storage projections, and stale Episodes.
The health contract can explain the corresponding problems, but users still
have to discover several commands, authorization rules, and receipts. Copying
those operations into a wizard would create a second lifecycle authority and
would weaken their generation, ownership, writer, and manifest fences.

Recovery also cannot be represented as one transaction. A runtime activation
may succeed before a later projection rebuild fails, and pretending otherwise
would hide a real partial outcome that an operator needs to see.

## Decision

### 1. One entry orchestrates; existing components remain authoritative

`kungfu recover` consumes a fresh deep health report and maps only registered
problem codes to existing authority operations. It may call runtime activation,
Peer lifecycle, Storage projection rebuild, or Episode recovery services, but it
does not reproduce their state machines or declare success on their behalf.

An unknown problem, missing identity, unknown projection, or authority that
cannot produce a safe plan becomes `manual-blocked`. It is never executable.

### 2. Planning is the default and is read-only

The default command emits `kungfu.recovery-plan/v1` and performs no recovery
write. Each action has a deterministic identity, target, expected facts,
preconditions, and one of three authorization classes:

- `automatic-safe`: an idempotent operation over a declared derived or
  daemonless state;
- `confirmation-required`: an operation that changes Peer lifecycle or appends
  a stale Episode terminal fact;
- `manual-blocked`: ownership, authority, or outcome cannot be proved safe.

Execution requires the exact reviewed `planId`. Confirmation-required actions
also require their action identity or an explicit `all` approval.

### 3. Execution regenerates the plan and retains write-point fences

Before the first write, execution regenerates the complete plan and rejects a
different root. The delegated authority then rechecks its own execution fence:

- runtime activation retains route, generation, PID, and process-start identity
  checks in `ProcessRuntimeHost`;
- Peer start or restart retains declaration-plan, host generation, and process
  identity checks;
- storage rebuild is restricted to the declared `source-registry` and
  `episode-manifest` derived projections and rebuilds from journals;
- Episode recovery reacquires the exact writer lease, rechecks stale/open facts,
  and requires the planned manifest frame UID at the native append boundary.

The unified plan is authorization evidence, not a replacement for these
time-of-check/time-of-use fences.

### 4. Receipts expose partial outcomes and always postflight

Execution is ordered and fail-closed. After the first failed action, later
actions are recorded as `not-run`. Every attempted action retains its result or
technical error, and the command emits `kungfu.recovery-receipt/v1` followed by
a fresh deep health postflight.

The receipt is not a global commit or rollback claim. A succeeded action remains
visible if a later action fails, and unresolved manual actions keep the overall
result blocked.

## Falsification and acceptance gates

- first-use planning must not create a runtime directory;
- the same facts must produce the same plan root;
- stale plan identity or missing confirmation must reject before any write;
- unknown projections and unknown authority outcomes must be non-executable;
- an Episode manifest-frame change between plan and append must reject;
- an action failure must stop later actions and preserve a per-action receipt;
- postflight must use the same deep diagnostics contract;
- the exact candidate commit must pass the portable recovery tests and CLI
  smoke on macOS, Linux, and Windows before integration.

## Consequences

Users gain one discoverable recovery route without learning the internal
topology first. GUI and agent-guided flows may consume the same schemas later,
but they must preserve the plan identity, authorization class, receipts, and
underlying fences.

This decision does not promise unattended repair for unknown state, rollback
across components, recovery from corrupted authoritative journals, or recovery
from physical media loss. The current entry is single-host: it does not provide
cross-host ownership transfer, network-partition healing, distributed
consensus, replication, or HA. Those outcomes remain manual or require a
different distributed, durability, and restore contract.
