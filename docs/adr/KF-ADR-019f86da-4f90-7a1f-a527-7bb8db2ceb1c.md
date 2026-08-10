---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7a1f-a527-7bb8db2ceb1c
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1114, https://github.com/kungfu-systems/kungfu/pull/1118, https://github.com/kungfu-systems/kungfu/pull/1120, https://github.com/kungfu-systems/kungfu/pull/1124, https://github.com/kungfu-systems/kungfu/pull/1134, https://github.com/kungfu-systems/kungfu/pull/2336, https://github.com/kungfu-systems/kungfu/pull/2348, https://github.com/kungfu-systems/kungfu/pull/2349, https://github.com/kungfu-systems/kungfu/pull/2354]
qualification_refs: [framework/action/action-loop.contract.json, framework/action/action-loop.mjs, framework/action/action-loop-begin.mjs, framework/action/action-loop-settle.mjs, framework/core/src/python/kungfu/agent/action_loop.py, framework/core/tests/python/test_action_loop_adapter.py, framework/action/action-loop-fixtures.json, framework/action/action-loop-contract.test.mjs, framework/action/action-loop-begin.test.mjs, framework/action/action-loop-settle.test.mjs, scripts/run-action-loop-native-authority-tests.mjs, framework/action/action-loop-qualification-adapters.mjs, framework/work-profile-conformance/qualification/kfd-7-product-gate.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-19
theme: recoverable-action-loop-coordination-contract
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-19; based on repository contracts, native adapter tests, and user-authorized source dogfood constraints; no claim about installed artifacts or multi-day qualification
---

# KF-ADR-019f86da-4f90-7a1f-a527-7bb8db2ceb1c: Action Loop coordination is receipt-driven and recoverable

- Status: accepted; source-native authority and recoverable settlement staged
- Date: 2026-07-19
- Category: Action / Agent Work Profile / recovery
- Related: [KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf](KF-ADR-019f86da-4f90-709e-8116-1c8ddf385fdf.md),
  [KF-ADR-019f86da-4f90-732e-826c-e994acc20716](KF-ADR-019f86da-4f90-732e-826c-e994acc20716.md),
  [KF-ADR-019f86da-4f90-786d-aa24-a97705e13917](KF-ADR-019f86da-4f90-786d-aa24-a97705e13917.md),
  [KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c](KF-ADR-019f86da-4f90-7c45-8d95-3745dcbbff1c.md), and
  [KF-ADR-019f86da-4f90-7809-898a-ccc0f52bd390](KF-ADR-019f86da-4f90-7809-898a-ccc0f52bd390.md),
  [KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md)
- Contract:
  [`action-loop.contract.json`](../../framework/action/action-loop.contract.json)

## Context

Kungfu already owns the necessary authorities separately: the native Fact
kernel owns objects, versions, relations, Cuts, named refs, CAS, and receipts;
Action Geometry owns Pursuit, Atlas, Warrant, and Episode responsibility
separation; the Agent Work Domain Profile owns its fields, lifecycle vocabulary,
and transitions; Xinfa owns Atlas compilation and verification; Runtime Episode
lifecycle owns occurrence; Work Control owns Completion Claim, assessment,
independent review, and continuation; Project Cut owns source settlement.

An Agent still has to compose those surfaces manually. A process can crash
after an external effect but before the next local projection, and a new Agent
must otherwise reconstruct the safe next action from chat. Collapsing the
surfaces into one transaction or mutable task would hide exactly the role and
partial-failure boundaries that KF-ADR-019f86da-4f90-786d-aa24-a97705e13917 preserves.

## Decision

### 1. One internal envelope carries five explicit bindings

The v0 envelope carries stable identities and roots for Pursuit, Atlas,
Warrant, Episode, and the current Fact Cut/ref. No binding may be inferred from
another role, the current process, workspace, provider session, or chat. The
Episode root may be pending only before seal; settled work always binds the
sealed Episode root and the exact expected-old Fact ref.

The v0 name is deliberately internal. Source dogfood must prove the shape
before a public CLI, API, GUI, or final Profile name is frozen.

### 2. Recovery follows accepted authority receipts

The ordered state path is:

```text
planned -> bound -> running -> episode-sealed
        -> atlas-refreshed -> reviewed -> settled
```

Each transition names one public adapter and accepts only that authority's
receipt. The coordinator derives the current state and first missing step from
the accepted receipt prefix. Projection state that disagrees with receipts is
rebuilt; an out-of-order receipt is refused; repeated identical receipts are
idempotent; conflicting receipts are an explicit conflict.

Checkpoint is repeatable and projection-only. It records roots, next actions,
and residual risk, but cannot promote transcript, exit status, Project Cut, or
Agent self-report to completion proof.

### 3. Partial failure is a protocol state, not a fake rollback

A known accepted receipt permits resume at the next step. A stale Fact ref
returns `stale-ref` and writes nothing. A changed Episode lifecycle returns
`episode-state-mismatch`. An external effect whose receipt is unknown enters
`external-effect-unknown` and requires inspection or compensation. Kungfu does
not represent Git, provider, runtime, and storage effects as one rollback-capable
transaction.

### 4. MJS plans; existing authorities mutate

Action MJS owns canonical validation, deterministic recovery classification,
pure transition planning, and projections. It does not read or write private
journal/CAS/runtime layouts and cannot mint Fact, Episode, Profile, Mission,
review, continuation, or Project Cut receipts.

Compatibility ports map current Mission/Go, Xinfa, bounded authority material,
the KFD-7 Work Profile, Runtime Episode lifecycle, Work Control completion,
and the Fact kernel into the coordinator. They are replacement seams for future
native Pursuit, Atlas, and Warrant implementations plus Domain Profiles, not
new authorities.

The first implementation slice validates explicit Mission/Go Pursuit, verified
Xinfa Atlas, and bounded Warrant inputs before mutation. It then requires the
Work Profile, Episode, and Fact checkpoint ports to return their own accepted
receipts. Re-entering the same loop ref reuses the persisted envelope; a fresh
process can recover the next missing step from that ref without chat or provider
session state. Adapter replacement changes authority implementations without
changing the envelope or recovery state machine.

The staged Core adapter binds the five Work Profile roles through the KFD-7
public action surface, opens the requested occurrence through
`RuntimeEpisodeLifecycle`, and stores checkpoint projections behind a native
Fact ref CAS. Its command transport is replaceable; it does not expose or write
private journal, CAS, or Episode layouts.

The settlement slice resumes that durable checkpoint, seals the same Runtime
Episode, refreshes the verified Atlas binding, consumes an independent Mission
Control review receipt, and settles the terminal Fact ref with expected-old
CAS. Each accepted external effect is checkpointed before the next one; unknown
Episode outcome, pending review, and stale final CAS remain typed recovery
states. A terminal envelope is recoverable from the final KFD-7 role details
after the begin-time Warrant has expired.

The source dogfood entry now resolves the exact loaded source-build native
extension and active Work Control Profile into one `nativeAuthority`
binding. It loads the checked-out source adapter ahead of a generated build
copy, refuses resume or settlement without mutation when either root drifts,
and roots reused Work Control receipts in their original payload and Episode.
The first same-root Atlas refresh creates its receipt; only a later exact replay
is idempotent, while a conflicting replay is rejected.

## Falsification and acceptance

- Removing any role identity or required root produces a typed refusal rather
  than a synthesized default.
- A stale Atlas, expired/revoked Warrant, stale Fact ref, Episode mismatch,
  out-of-order receipt, and conflicting duplicate have stable typed results.
- A crash after every accepted step resumes at exactly the next missing step.
- Repeating an identical completed settlement returns the existing result and
  performs no mutation.
- The packaged Action manifest binds the contract, planner, and fixtures; both
  source and installed hosts therefore receive the same pure coordination
  bytes under KF-ADR-019f86da-4f90-7809-898a-ccc0f52bd390.
- Tests exercise deterministic recovery, decision-required and stale-authority
  paths, adapter replacement, partial Episode uncertainty, stale Fact CAS, and
  cross-process loop-ref recovery without touching a real user home.
- The native-authority gate exercises extension/Profile drift, rooted reused
  receipts, same-root first refresh, exact replay, and a real source settlement.

## Non-claims

The staged source dogfood proves one real loop and idempotent settlement under
the checked-out source/native binding. It does not qualify P17/FO9/FO10,
installed artifacts, multi-day operation, or freeze a public product surface.
The staged coordinators still depend on public authority ports; they do not
make Action MJS an authority or replace any receipt source.

## Consequences

The two implementation lines can share one versioned state, port, idempotency,
and recovery contract while remaining independently testable. The cost is that
every external effect must retain its own receipt and recovery rule; the
coordinator cannot hide ambiguity behind a generic retry or a single mutable
"done" flag.
