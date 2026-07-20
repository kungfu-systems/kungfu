---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0109
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1026, https://github.com/kungfu-systems/kungfu/pull/1079, https://github.com/kungfu-systems/kungfu/pull/1081, https://github.com/kungfu-systems/kungfu/pull/1091, https://github.com/kungfu-systems/kungfu/pull/1132]
qualification_refs: [framework/agent-work/kungfu-agent-work-state.contract.json, framework/agent-work/validate-profile.mjs, framework/agent-work/fixtures/manifest.json, framework/agent-work/kungfu-kfd-7-action-contract.json, framework/agent-work/kungfu-kfd-7-release-gate.json, framework/agent-work/evidence/kfd-7/, scripts/check-agent-work-state-contract.test.mjs, framework/core/tests/python/test_agent_work_state_contract.py, framework/core/tests/python/test_agent_work_profile_native.py, framework/core/tests/python/test_fact_kernel_dogfood.py, docs/qualification/evidence/fact-kernel-dogfood/generic-fact-kernel-v1/report.json, framework/core/src/python/kungfu/agent/kfd3_api.registry.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-17/2026-07-18
theme: four-object-agent-work-state-contract
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
---

# ADR-0109: Real-world agent work preserves four independently addressable roles

- Status: accepted; four-role contract v2 staged; KFD-7 Product Profile
  qualified and activated against KFD alpha.35 at the retained review cut;
  generic Fact kernel dogfood qualifies FO1, FO2, and FO6 while P17 remains
  not qualified
- Date: 2026-07-17
- Category: Agent Work Profile / product contract / KFD-3
- Related: [ADR-0033](ADR-0033-episode-causal-segment-object.md),
  [ADR-0059](ADR-0059-mission-control-mission-go-responsibility-model.md),
  [ADR-0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md),
  [ADR-0075](ADR-0075-profile-level-kfd3-qualification.md),
  [ADR-0095](ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md),
  [ADR-0105](ADR-0105-independent-review-and-exact-continuation.md), and
  [ADR-0123](ADR-0123-action-geometry-domain-profile-separation.md)
- Contract:
  [`kungfu-agent-work-state.contract.json`](../../framework/agent-work/kungfu-agent-work-state.contract.json)

## Context

Kungfu already carries several mature but separately named parts of real-world
agent work. Mission/Go preserves responsibility and continuity; Xinfa Atlas,
Project Cut, and runtime queries preserve declared context and cuts; Profile
plans, authorization, review, and continuation decisions preserve bounded
authority; Episode preserves causal experience.

These parts are not interchangeable. Treating a goal as authority, context as
complete reality, a plan as an occurrence, an occurrence as completion, or a
parent grant as descendant authority creates a different class of hidden
assumption each time. A product that exposes only one mutable "task" record
forces humans and agents to reconstruct those assumptions from chat or memory.

## Decision

### 1. The Agent Work Profile preserves four semantic roles

The public product contract names:

- **Pursuit**: durable continuity of intended real-world change;
- **Atlas**: the declared perspective and fact cut used to understand it;
- **Warrant**: bounded authority for a next action or continuation; and
- **Episode**: the causal experience of what occurred.

The commitment is to role separability and independently referenceable
identity. It is not a commitment to four databases, four screens, or permanent
names.

### 2. Relations are many-to-many and grant no silent inheritance

A Pursuit may reference several Atlases, Warrants, and Episodes. The same
Atlas, Warrant, or Episode may inform several Pursuits. A reference records why
the objects are related; it never converts one role into another.

The contract therefore publishes invalid-inference rules. Missing perspective,
authority, occurrence, or completion evidence must produce refusal,
uncertainty, or degraded trust rather than a synthesized fact.

### 3. Progressive disclosure reduces ceremony, not semantics

Low-consequence work may use explicit product defaults: a current work item,
the current workspace cut, a standing low-risk local authority, and an
automatically recorded Episode. Those defaults remain inspectable,
replaceable, exportable, and independently invalidatable.

Consequential work reveals the relevant role: external effects reveal the
Warrant, conflicting evidence reveals the Atlas, delegation reveals the
Pursuit, execution reveals the Episode, and handoff reveals all relevant
roots.

### 4. Core owns authority; Action Geometry and Domain Profiles divide the model

Kungfu Core continues to own generic fact identity, relations, authority
plans and receipts, storage, query, trust, and replay. Action Geometry owns the
four-role responsibility boundaries, typed relationships, non-substitution
invariants, and conservative session refinement. The Agent Work Domain Profile
owns concrete fields, lifecycle vocabulary, workflows, defaults, validation,
presentation, and domain-specific success policy.

Mission/Go remains one first-party Domain Profile projection. This decision
does not move Mission or Go into Core, rename existing records, or create a
second authority beside their current owners.

### 5. One welded contract serves humans, agents, and release evidence

`agent-work-state-contract` is registered in the KFD-1 contract registry and
copied byte-for-byte into assembled products. The generic
`kungfu contract show` route is therefore a KFD-1 query of the welded fact.
Humans reach it through [Agent Work State](../profiles/agent-work-state.md).
The agent-specific `work-model` and `capabilities` routes are KFD-3
collaboration interfaces over the same file:

```sh
kungfu agent work-model --json
kungfu contract show agent-work-state --json
```

The KFD-3 registry, command catalog, onboarding brief, and provider skills
declare the agent entrypoint. Neither prose nor the CLI owns a second role
definition. The bounded KFD-2 release claim audits only that this exact
contract preserves its explicit P17 status, exposes all `FO1`-`FO8` evidence
debt, and retains its residual non-claims. The separate KFD-7 release-gate
declaration qualifies the provisional product Action Profile against retained
runtime evidence; it does not silently upgrade the wider welded contract.

### 6. Exact versions meet at a derived ActionBinding

The Profile separates stable object identity, immutable version roots, and the
current ref at one Fact cut. Concrete lifecycle states remain Profile-owned:
Pursuit distinguishes continuation from settlement, Atlas distinguishes a
current view from degradation and staleness, and Warrant distinguishes an
active or attenuated grant from expiry, revocation, consumption, and refusal.

For a candidate action `u`, the Profile evaluates:

```text
U_valid(f, A, P, W)
  = Supported_A(f)
  intersect Advances_P(f)
  intersect Authorized_W(f)
```

`ActionBinding` records the exact Fact, Pursuit, Atlas, and Warrant roots used
for that decision. It is derived and has no independent direction,
perspective, authority, or lifecycle. A changed root or action requires a new
binding. An Episode may cite the binding but cannot retroactively authorize
it.

The contract embeds the machine schema for this Profile shape. A separate
semantic validator checks reference closure, current-cut alignment, lifecycle
eligibility, scope, expiry, and Warrant non-amplification. Positive and
negative fixtures make those claims falsifiable without claiming native
runtime completion.

## Invariants and falsification

- Removing any role must expose a typed gap; another role cannot fill it.
- A stale, expired, revoked, or out-of-scope Warrant cannot authorize action.
- A successful command or sealed Episode cannot complete a Pursuit without
  consequence review against its success conditions.
- A child action cannot inherit a parent Warrant without a checked scope.
- Human and agent routes must resolve to the same contract hash and
  qualification status.
- A simplified flow fails the model if its defaults cannot be inspected or
  invalidated.
- Two Profile states may expose identical context payloads while producing
  different valid-action sets because their Warrants differ.
- A derived Warrant must remain a subset of its parent across action,
  resource, target, time, and consequence dimensions.

## Qualification boundary

The welded Agent Work contract and the KFD-7 Product Profile have distinct
qualification boundaries. The v2 contract closes the in-repository object
schema and negative semantic fixtures while continuing to report its own P17
status and remaining `FO1`-`FO8` debt.

The retained generic
Fact kernel dogfood now qualifies `FO1`, `FO2`, and `FO6`: four distinct role
identities and relations survive a sealed successor Cut, independent no-chat
review, and clean-runtime export/import continuation. Negative authority and
substitution cases make `FO3` partial, and one rival-model witness makes `FO7`
partial. It still does not pass P17: fresh-product progressive-disclosure UX,
GUI/TUI parity, sustained multi-work-item dogfood, generic Warrant maturity,
and Release Passport binding remain open.

The Kungfu KFD-7 Product Profile is bound to KFD alpha.35 and an exact
implementation/evidence cut. Twelve retained categories cover
positive and negative transitions, export/import and backend recovery, role
deletion or fusion, Warrant decay, Atlas staleness, Pursuit and Episode
lifecycle, concurrency, session round-trip refinement, complexity breakpoints,
and context-insufficiency. The release declaration is `qualified` and its
activation decision is `activate`, bound to
[independent review 4728705815](https://github.com/kungfu-systems/kungfu/pull/1091#pullrequestreview-4728705815)
at exact qualification commit `8f6eff198751af109ddbeead8db4390d35303880`.
Those facts do not prove universal minimality, provider-wide correctness, or
completion of the wider P17 program.

## Consequences

Kungfu gains one public boundary for evaluating current and future Agent Work
features. Existing systems can be projected without destructive renaming, and
gaps become queryable qualification debt instead of private interpretation.
The cost is that product work must preserve four identities and cannot use
task, context, authorization, run, or completion as convenient synonyms.
