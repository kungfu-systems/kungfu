---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f87e8-6b8b-735c-b036-fa42d7cee8cf
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1218, https://github.com/kungfu-systems/kungfu/pull/1225, https://github.com/kungfu-systems/kungfu/pull/1234, https://github.com/kungfu-systems/kungfu/pull/1241, https://github.com/kungfu-systems/kungfu/pull/1245, https://github.com/kungfu-systems/kungfu/pull/1309, https://github.com/kungfu-systems/kungfu/pull/2381]
qualification_refs: [framework/work-loop/work-api.contract.json, framework/work-loop/project-cut-product-loop.release-contract.json, scripts/project-cut-product-loop-release.mjs, scripts/project-cut-product-loop-release.test.mjs, scripts/run-project-cut-product-loop-release.mjs, framework/api/tests/work-loop.test.ts, framework/core/tests/python/test_project_cut_read_model.py, commit:d435ad578878d75839b27dff03ae82d3789d4870, framework/core/tests/python/test_action_envelope.py, framework/core/tests/python/test_agent_work_state_contract.py, extensions/work-dashboard/tests/work-loop-summary.test.ts, framework/tui/src/work-loop-contribution.test.ts, framework/report-projection/authority.json, framework/report-projection/authority.test.mjs, scripts/source-acceptance.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-22
theme: project-cut-public-work-loop
confidence: high
evidence_grade: B
last_reviewed: 2026-08-03
ai_provenance: GPT-5 via Codex on 2026-07-23; based on public Kungfu contracts and source tests, without claims about unobserved deployed runtimes
---

# KF-ADR-019f87e8-6b8b-735c-b036-fa42d7cee8cf: Project Cut is the public Work loop facade

- Status: accepted; implementation and qualification staged
- Date: 2026-07-22
- Category: Project Cut / Agent Work / product facade

## Context

Kungfu already has separate authorities for Fact, Episode, Work journal facts,
Action Geometry, Work Control, Xinfa Atlas, and Project Cut settlement. A
user who must manually coordinate every authority cannot use them as one
recoverable work loop, while a second convenience state machine would hide
gaps and split authority.

## Decision

Project Cut is the public continuity boundary for a high-level Work loop. The
default surface exposes the current Cut, current Work, confidence, gaps, and
next actions. `inspect`, `begin`, `checkpoint`, `complete`, `settle`, `resume`,
`recover`, `export`, and `import` are facade operations over existing
authorities, not new primitive records.

Human and machine consumers use one read model. A read never initializes a
runtime. Exactly one current Cut and one open Work may be selected implicitly;
zero or multiple candidates fail visibly. `complete` prepares evidence and a
claim candidate, while `settle` requires independent review, a continuation
decision, and exact Project Cut roots. Managed runs bind an existing WorkRef
idempotently and cannot create a Work implicitly.

## Falsification and qualification

This decision is false if a facade read writes runtime state, if multiple Cuts
or Work items are silently selected, if an Agent self-report settles Work, if
managed-run accepts an unknown WorkRef, or if CLI and Agent JSON disagree.
Qualification is owned by the Work API contract and its Cut/Work facade tests.

The staged multisurface slices project one operation manifest through CLI and
Agent, then expose the same public `work capabilities`, `work inspect`, and
`work recover` JSON through the shared TypeScript `openWorkLoop` adapter. The
Work Dashboard and Work Control TUI show the current Cut, Work, confidence,
gaps, next actions, and recovery plan. Their transports reject mutating Work
commands, and a missing project workspace fails visibly without substituting
the app launch directory. The release contract freezes the target Gate id,
complete scenario inventory, third-party profile proof, and fail-closed
evidence admission without claiming retained qualification evidence. The
evidence runner now derives a clean tracked source revision, verifies the exact
release-passport bytes and required platform artifacts, evaluates the complete
contract, and can retain Shifu Gate evidence. The retained platform campaign,
Gate measurement and registration, and operations still reported as
unavailable, degraded, or plan-only remain outside executable qualification.

The portability slice emits byte-stable Work semantics without local
timestamps and binds them to the exact tracked current Project Cut. Import is
verify-first and writes only after `--execute`; replay reuses an exact existing
Work, an interrupted prefix resumes from its first missing event, and a wrong
Cut, divergent Work, modified root, signed URL, or obvious credential-like
text fails before any append. It does not transport source bytes or acquire
Project Cut publication authority. `portableRoot` proves byte integrity, not
origin authenticity or that the Work existed in the bound Cut; `--execute` is
the explicit local admission decision. The envelope preserves the semantic
Work projection, not local timestamps or cross-type event ordering.

Repository-wide maintainability reports used by the delivery loop follow the
same authority boundary: tracked source and an explicit generator manifest are
authoritative, while the tracked report JSON files are read-only historical
snapshots. A protected projector may publish immutable, content-addressed
reports and receipts only for the exact admitted source revision. It cannot
rewrite a branch, reinterpret a historical snapshot as current, or acquire
Work, Project Cut, review, or settlement authority.

## Consequences

- Existing Work journal and authority receipts remain canonical.
- Simple sessions can use Cut and Work without learning the five-role model.
- Expert projections retain roots, receipts, gaps, and authority ownership.
- Clean-runtime continuation can restore one verified Work prefix against an
  already present tracked Project Cut without copying machine-local time or
  paths.
- Report consumers can distinguish exact-source projected evidence from
  historical tracked snapshots without creating a second state authority.
- Full `begin` and executable settlement remain gated on the native
  Initiative/Assignment orchestration reaching the shared dev baseline.
