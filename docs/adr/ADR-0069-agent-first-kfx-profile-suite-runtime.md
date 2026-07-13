---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0069
decision_status: accepted
implementation_status: staged
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-13
theme: agent-first-kfx-profile-suite-runtime
confidence: high
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0069: Agent-first KFX Profile Suites carry domain semantics over a domain-neutral Core

- Status: accepted; staged
- Date: 2026-07-13
- Category: product architecture / extension contract / KFD runtime
- Subsystem: KFX contract, Profile lifecycle, KFD-1 admission, KFD-2
  assessment, query/view composition, GUI Profile Manager, Mission Control
- Related: [ADR-0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md),
  [ADR-0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md),
  [ADR-0048](ADR-0048-runtime-fact-query-semantics-and-changelog.md),
  [ADR-0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md),
  [ADR-0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md),
  [ADR-0052](ADR-0052-kfd2-assessment-lifecycle-and-executors.md),
  [ADR-0059](ADR-0059-mission-control-mission-go-responsibility-model.md),
  and [ADR-0061](ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md)
- Contract: [`kungfu-kfx.contract.json`](../../framework/kfx/kungfu-kfx.contract.json)
- Fixture: [`kfx-profile-suite-contract`](../../tests/fixtures/kfx-profile-suite-contract)

## Context

Kungfu already has generic runtime-fact admission, historical query, KFD-2
assessment, Episode timelines, capability confinement, KFX packages, and KFX
Suite grouping. Mission Control composes these foundations into a useful
Mission/Go product, but its domain vocabulary and operations currently live in
first-party Python/API/GUI code. The GUI also hard-codes a small list of
experience profiles.

Mission/Go is one operator model, not a universal vocabulary. Other users may
organize reality as Week/Day/Action, Task/Job, Customer/Case/Decision, or a
model Kungfu cannot predict. Requiring those users to adopt Mission/Go would
confuse one first-party product with the platform. Requiring every new model to
modify and rebuild Kungfu would make the extension system cosmetic.

The existing `kungfuConfig.suite` declaration is not enough. It contains only
`title` and `members`, so it groups packages for navigation, enable/disable,
and lockstep versioning. It does not close over fact contracts, reducers,
claims, purposes, assessment policies, actions, views, migrations,
permissions, or qualification evidence.

## Decision

### 1. Core owns mechanisms; Profiles own domain meaning

Kungfu Core remains domain-neutral. It owns:

- KFD-1 contract validation, fact-surface declaration, admission, identity,
  time, and historical interpretation;
- KFD-2 claim/purpose assessment, evidence requirements, responsibility, and
  TrustReport lifecycle;
- ADR-0048 query bases, plans, cuts, results, proof, and changelog;
- Episode/timeline persistence, capabilities, confinement, and Profile
  lifecycle facts.

A **Profile** owns the user-visible domain model and operating protocol. Core
must not branch on Mission, Go, Week, Day, Task, or another Profile noun.

### 2. A KFX Profile Suite is the semantic and distribution closure

A **KFX package** remains one development, distribution, trust, and execution
unit. A package may contribute a view, adapter, service, action provider,
assessor, or another bounded facet.

A **KFX Suite** remains a group of member packages. When its manifest binds a
Profile document through `kungfuConfig.suite.profile`, the Suite additionally
becomes a **Profile Suite**: the atomic semantic, version, qualification, and
lifecycle closure presented to users.

The Profile document uses `kungfu.profile-suite/v1`. It declares:

- required and optional member keys;
- KFD-1 contract world, fact surfaces, reducers, and compatibility policy;
- KFD-2 claims, purposes, and assessment policies;
- action, view, migration, permission, and qualification registries.

Every referenced artifact is a relative POSIX path plus a lowercase SHA-256.
Absolute paths, parent traversal, unbound content, and unknown authority fields
fail validation. Required and optional members cannot overlap, and the Profile
member set must match the package Suite member set.

### 3. The existing KFX contract remains the single schema authority

`framework/kfx/kungfu-kfx.contract.json` owns both the package-manifest schema
and `profileSuiteSchema`. Python, Node, installed CLI discovery, SDK tooling,
frozen products, and release evidence must read that contract. This decision
does not create a parallel Profile schema registry or a second KFD contract
world.

The edge Profile document is JSON because it is an authoring and interchange
contract. Admitted runtime facts, lifecycle state, query truth, and assessment
truth continue to use their existing Core schema owners under ADR-0047.

### 4. Core computes the installed Profile root

The source document binds every artifact hash but does not self-declare its own
authority. Core computes one
canonical `profile_suite_root` from the validated manifest and complete content
closure. The root binds the exact embedded KFX source-contract root, verified
facet bytes, and externally resolved canonical roots for every required and
optional Suite member. Lifecycle facts bind Profile id, version, root, member roots,
contract-world roots, granted permissions, qualification result, and runtime
compatibility.

An executable member cannot redefine the Profile identity or admit itself.
Removing a member cannot remove or reinterpret persisted facts. Historical
facts and assessments retain the Profile root active at their cut.

### 5. Installed, qualified, activated, and focused are different states

The lifecycle distinguishes:

1. **installed** — content is present and its declared hashes match;
2. **qualified** — deterministic fixtures and compatibility checks passed;
3. **activated** — the workspace admits the Profile root and its permissions;
4. **focused** — a GUI chooses that Profile's experience as the current view.

A workspace may activate multiple compatible Profiles. Changing GUI focus
does not deactivate facts or policies owned by another active Profile.

Core now records these lifecycle states. GUI focus remains a later product
concern and is deliberately absent from the lifecycle fold.

### 6. Agent-first is the v1 authoring path

V1 does not include a no-code ontology or workflow builder. An installed
Kungfu must progressively expose machine-readable schema, examples,
capabilities, validation failures, plans, receipts, and diagnostics so an
agent can create and operate a Profile without a Kungfu source checkout or
product rebuild.

The final interaction follows ADR-0061:

```text
inspect -> scaffold/edit -> validate -> qualify -> plan -> authorize -> install/upgrade -> receipt -> verify
```

The GUI is a Profile Manager for discovery, semantic diff, permission review,
qualification status, activation, health, and recovery. It is not a private
builder or a second action implementation. GUI and agent clients use the same
action registry, plans, receipts, queries, and TrustReports.

### 7. Mission Control must use the public Profile path

Mission/Go becomes the first first-party reference Profile Suite. It receives
no private admission, query, assessment, action, migration, or GUI authority.
Current v3 facts are not rewritten. Migration introduces an explicit new
Profile root/cutover and compatibility readers that preserve old-cut
interpretation.

An independently authored Week/Day/Action Profile is the release oracle. Open
Profile support cannot be claimed until that Profile can coexist with Mission
Control, qualify, activate, export/import, upgrade, roll back, and retain
historical interpretation without rebuilding Kungfu.

## Consequences

- Kungfu can serve user-defined reality models without turning domain nouns
  into Core concepts.
- KFX Suite gains a load-bearing semantic role while member packages retain
  separate trust and capability boundaries.
- Agents can perform the mechanical implementation work; users retain control
  over identity, authority, permissions, evidence strength, migration, and
  activation.
- Mission Control becomes both a product and a continuous conformance test for
  the public platform.
- The Profile lifecycle, root computation, qualification harness, SDK, generic
  renderer, and migration path add real maintenance surface; each is staged
  separately and must not become a second fact or trust system.

## Rejected alternatives

- **Make Mission/Go the universal workflow model.** Rejected because a
  first-party operator vocabulary is not a domain-neutral fact contract.
- **Put every Profile facet in one monolithic KFX.** Rejected because complex
  Profiles need independently confined, replaceable, and optional members.
- **Treat a Suite as navigation grouping only.** Rejected because distribution
  without semantic closure cannot preserve facts, trust, or migration.
- **Let Profile code own persistence or assessment truth.** Rejected because it
  creates competing authorities and lets extensions self-certify.
- **Build a no-code Builder first.** Rejected because it freezes immature
  abstractions and duplicates work an agent can perform through contracts.
- **Special-case first-party Mission Control.** Rejected because it hides
  platform gaps and makes third-party Profiles permanently weaker.
- **Rewrite v3 Mission Control facts during migration.** Rejected because
  historical interpretation must remain stable at its original cut.

## Staged acceptance gates

### S0: contract gate

- `kungfu.kfx.contract/v1` exposes `profileSuiteSchema` and a Suite-relative
  Profile binding.
- Python and Node share the same schema and semantic member checks.
- A complete Week/Day fixture passes; unknown authority, missing KFD-2,
  escaping paths, malformed hashes, overlapping roles, and package-member
  drift fail closed.
- The CLI can expose the exact Profile schema through `kfx profile-schema`.

### S1-S3: generic runtime and product gate

- Core records install/qualification/activation/upgrade/rollback facts and
  computes the Profile root.
- The installed Agent SDK exposes schema, examples, scaffold, validation,
  qualification, plan, action, diff, export/import, and diagnostics.
- Query/assessment/view composition and Profile Manager are Profile-driven,
  with no domain noun branching in Core.

### S4-S6: dogfood and release gate

- Mission Control migrates through the public path without rewriting v3 facts.
- Week/Day/Action passes coexistence, rollback, and full/thin portability.
- Product artifacts and public documentation state supported claims and known
  limits; source-only fixtures do not count as shipped runtime support.

## Current implementation status

S0 and S1 are implemented. The KFX contract v3 additive surface, shared
Python/Node validators, CLI schema discovery, and retained Week/Day fixtures
own the source contract. Core embeds that exact contract, verifies the complete
facet closure and explicit member roots, computes `profile_suite_root`, and
records Installed, Qualified, Activated, Superseded, RolledBack, and Removed
facts through ActionEnvelope + Episode. Python, Node, and `kungfu kfx profile`
use the same storage-service operation and fail-closed plan/apply receipts.

S1 qualification is deliberately limited to source-contract, content-closure,
and runtime-contract checks that Core can execute itself. The installed Agent
SDK, semantic fixture harness, Profile Manager, Mission Control migration,
portable export/import, and open-Profile release qualification remain future
stages. A schema-valid source still proves no lifecycle state; only journal
facts and receipts establish installation, qualification, or activation.
