---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0004
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/762, https://github.com/kungfu-systems/kungfu/pull/765, https://github.com/kungfu-systems/kungfu/pull/767, https://github.com/kungfu-systems/kungfu/pull/769, https://github.com/kungfu-systems/kungfu/pull/773, https://github.com/kungfu-systems/kungfu/pull/781, https://github.com/kungfu-systems/kungfu/pull/786]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/781
qualification_refs: [scripts/shifu-gate-runtime.test.mjs, scripts/check-kungfu-gate-catalog.test.mjs, scripts/shifu-cache-runtime.test.mjs, .github/workflows/dev-verify-patrol.yml]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: shifu-gate-control-plane
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# SHIFU-ADR-0004: Gate control plane contract

- Status: accepted and implemented
- Date: 2026-07-13
- Scope: Shifu quality and release gate declaration, explanation, planning,
  execution, and receipts
- Related: [SHIFU-ADR-0001](./SHIFU-ADR-0001-cache-profile-contract-and-ownership.md),
  [ADR-0044](./ADR-0044-shifu-delegation-protocol.md), and
  [ADR-0073](./ADR-0073-buildchain-adr-release-admissibility.md)

## Context

Kungfu gates currently exist across package tasks, aggregate scripts, and
workflow jobs. Some are light source checks; others build native products,
exercise cross-language membranes, qualify Episodes, fuzz targets, or release
artifacts. The distinction affects scheduling cost, but each gate still needs
the same answers: what problem it detects, what it runs, what it depends on,
where it can run, which release profiles require it, and what evidence it
produces.

Encoding those answers separately in package scripts, workflow YAML, prose,
and branch protection creates multiple policy authorities. Hard-coding the
Kungfu catalog into Shifu would avoid one local duplication while coupling a
general execution tool to one project forever.

## Decision

Shifu owns one versioned Gate contract and the commands that validate,
explain, compare, and plan it. Consuming projects own registry instances:
concrete ids, structured actions, dependencies, platforms, runner
capabilities, cost, documentation, artifacts, receipt expectations, and every
explicit profile decision.

Light and heavy gates share one schema. Cost is scheduling metadata, not a
separate command family. Profiles use `required`, `advisory`, and `off`; every
profile must decide every gate, and dependencies cannot be weaker than the
gates that require them.

Actions are structured Shifu tasks, argv vectors, or named handlers. Raw shell
strings are not the contract because they hide quoting, platform, and authority
semantics.

The inspection control surface is `shifu gate validate|list|show|explain|matrix|plan`.
Validation is independent of registry validity. Planning closes dependencies,
emits deterministic groups and platform constraints, and never turns a local
diagnostic selection override into qualifying policy evidence.

The execution control surface is `shifu gate run` plus
`shifu gate receipt validate`. Explicit gate runs are diagnostic. A profile run
executes its dependency closure once and emits a receipt bound to the source
SHA, dirty state, registry and plan digests, per-gate definition and action
digests, platform, capabilities, required action coverage, artifact presence,
and redacted evidence pointers. Child output and inherited environment values
are not receipt fields.

When a cache profile is projected, `gate run` enters Shifu cache application
once at this outer execution boundary. Task actions inherit the active cache
context, disposable tool configuration, and Conan storage lock; they do not
resolve or apply the profile again. Read-only Gate inspection remains outside
that boundary, and build-free source acceptance uses a distinct cache-bypass
context rather than pretending cache was applied.

Qualification is recomputed, not trusted: it requires a clean Git revision, a
current profile plan and gate definitions, and complete passing coverage for
every required action. Advisory failures remain visible without blocking
required qualification. Buildchain can schedule plan groups and aggregate these
receipts, but it cannot mint missing local evidence or reinterpret policy.

Buildchain may consume a later execution plan and receipts to allocate runners
and publish stable aggregate checks. It does not own or reinterpret Shifu Gate
fields. Project maintainers retain authority over concrete release policy,
required checks, and promotion.

## Compatibility

The registry and plan identities carry their major version. Unknown v1 fields
are rejected. Additive optional fields may extend v1; removals, new required
fields, changed meanings, or changed selection semantics require v2.

Existing `./shifu <task>` dispatch remains valid. During migration, old task
entrypoints may become compatibility aliases, but they cannot remain an
independent policy source. Existing required gates are not weakened while both
paths coexist.

## Current Kungfu projection

Kungfu's first project-owned registry contains 34 light and heavy gates and
five explicit profiles: `dev-pr`, `dev-patrol`, `alpha-pr`, `release-pr`, and
`release-promotion`. The generated matrix and per-gate documentation live in
the [Kungfu Gate catalog](../qualification/gates/README.md). A dedicated meta
gate validates the registry, task references, detailed documentation, exact
generated matrix, profile coverage, and current workflow bindings together.

Task-backed workflows now enter through `shifu gate run` for ADR delivery,
promotion rehearsal, documentation closure, development full verification,
the native membrane matrix, and the Shifu workspace matrix. Supply-chain-pinned
actions and Buildchain-owned orchestration remain explicit controller bindings;
named handlers remain non-executable until those controllers register them.
The workflow bindings make that remaining compatibility debt explicit and fail
closed when either the execution authority or recorded current source drifts.

Buildchain now provides a project-neutral reusable profile workflow. It asks
the consumer's Shifu registry for a platform plan, derives a capability-aware
runner matrix, validates every platform receipt, and publishes one stable
aggregate bound to the source, registry, plan, matrix, actions, and Gate
definitions. Planning and execution accept separate argv maps so a read-only
plan does not depend on a project cache or container wrapper. Kungfu supplies
only its profile id, runner preset, non-sensitive runtime environment, and
opaque cache reference; Buildchain contains no Kungfu Gate ids or policy rows.
PR 773 published the three-platform standing dev patrol after the consumer
canary recorded its Linux/macOS failures and Windows Actions transport failure
without rewriting them as passing. Buildchain then published the controller as
stable `v2.12.2`; PR 781 pins the patrol to that release's immutable commit and
closes the project-side rollout. Gates without a current qualification binding
remain explicit `off` policy decisions rather than implicit omissions.

## Consequences

- Developers and agents get one human-readable and machine-readable surface
  for understanding gate policy.
- A project can select different dev, alpha, and release policies as an
  explicit matrix without teaching Shifu those project-specific names.
- New gates fail profile validation until every policy explicitly decides
  them.
- Buildchain scheduling and receipt aggregation preserve project Gate meaning
  and expose a stable aggregate for branch protection and release passports.
- The contract adds a small validation and documentation burden, paid once to
  remove repeated workflow and prose reconstruction.

## Alternatives considered

- **Keep package scripts and workflows as the catalog** — rejected because
  neither can explain the complete policy and their overlap drifts.
- **Put the Kungfu gate matrix inside Shifu** — rejected because project policy
  would become engine code and prevent reuse.
- **Model heavy gates separately** — rejected because weight changes scheduling,
  not identity, dependencies, documentation, or evidence semantics.
- **Allow missing profile entries to mean off** — rejected because a new gate
  could silently bypass every release profile.
- **Implement execution before the contract** — rejected because a scheduler
  would freeze accidental current script structure as architecture.
