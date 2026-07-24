# Agent Work State

The first-release user outcome is:

```text
Keep the work when the chat ends.
```

A new user should see continuity before internal vocabulary. Cost/State/Proof
and the Pursuit, Atlas, Warrant, and Episode model remain inspectable deeper
profiles; neither is first-use ceremony. Release validation deliberately keeps
three artifacts separate:

| Artifact | What it establishes | What it cannot establish |
| --- | --- | --- |
| one-minute continuity smoke | the bounded fixture, context reset, oracle, report shape, capture path, and animation inputs work together | it does not pass `FO10` or support multi-hour, multi-day, or comparative superiority claims |
| matched long-task comparison | a feature-complete release candidate can be compared with the then-current native Agent baseline on the same task and oracle, under fresh context/process boundaries and independent review | it is phase-level attribution evidence, not an automatic permanent gate for every patch |
| public animation | the retained report can be explained in a time-compressed public projection | it is not independent proof and cannot exist without the exact source report and limitations |

The machine-readable profile, evidence schema, and Release Passport binding
rules live in
[`kungfu-agent-work-state.contract.json`](../../framework/agent-work/kungfu-agent-work-state.contract.json).
Kungfu qualification owns the benchmark semantics. Buildchain may bind the
exact artifact, copy, fixture, versions, reset method, oracle, raw report,
projection, limitations, and review; it may not create or strengthen the
claim.

Agent Work is Kungfu's first **Domain Profile** over the **Fact-Episode
Ontology** and **Action Geometry** defined by KFD-7, [KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b](../adr/KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b.md), and [KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8](../adr/KF-ADR-019f86da-4f90-7cb5-b65c-b463768e7ae8.md).
Fact and Episode bind admitted state and realized causal occurrence. Action
Geometry preserves the Pursuit, Atlas, and Warrant responsibility boundaries
and non-substitution invariants; this Domain Profile owns the concrete work
fields, lifecycle vocabulary, defaults, validation, evidence policy, and
presentation.

Real-world agent work stays coherent when five inspectable bindings answer two
ontology questions and three action questions:

| Layer | Binding | Question it answers |
| --- | --- | --- |
| Ontology | **Fact** | What state has been admitted at the declared Cut? |
| Ontology | **Episode** | What actually occurred, with which inputs, observations, consequences, and provenance? |
| Action Geometry | **Pursuit** | What intended change are we continuing, and what would count as success? |
| Action Geometry | **Atlas** | From whose perspective, from which sources, and at what cut are we understanding reality? |
| Action Geometry | **Warrant** | Who may do which bounded action against which exact state and constraints? |

Machine authority is intentionally split:

- [`action-geometry.contract.json`](../../framework/action/action-geometry.contract.json)
  owns the cross-domain responsibility separation and invariants;
- [`kungfu-agent-work-domain-profile.contract.json`](../../framework/agent-work/kungfu-agent-work-domain-profile.contract.json)
  owns Agent Work role schemas, lifecycle, validation, presentation, and
  evidence/success policy; and
- [`kungfu-agent-work-state.contract.json`](../../framework/agent-work/kungfu-agent-work-state.contract.json)
  retains the existing work-state and qualification surface.

All three are reached through the same KFD-1 registry. This page is their human
route, not a second specification.

## How the two-plus-three model uses the runtime substrates

The current semantic model distinguishes ontology from action:

```text
Fact-Episode Ontology
  -> Fact substrate: admitted state at explicit Cuts
  -> Episode substrate: causal experience across Fact Cuts

Action Geometry over an exact Fact Cut
  -> Pursuit: intent continuity and success conditions
  -> Atlas: declared perspective, sources, and Cut
  -> Warrant: bounded authority and responsibility
```

Pursuit, Atlas, and Warrant are not three special databases or aliases for any
arbitrary Fact. They are independently identified action objects whose
versions, relations, and current views use the generic Fact kernel. Episode is
the independently addressable occurrence binding and temporal runtime
substrate, not a fourth Action Geometry Primitive. It may produce evidence for
new Facts but cannot substitute for state, perspective, authority, or
completion.

## Identity, versions, and one action

Each Fact-backed action Primitive separates three things:

```text
stable role identity
  -> immutable version root
  -> current ref at one admitted Fact cut
```

Moving a current ref never rewrites the version used by an earlier action.
Pursuit relations form a typed graph rather than one universal task tree.
Atlas successors preserve observer, source cut, omissions, conflicts, and
declared transformation loss. Derived Warrants may only attenuate action,
resource, target, time, and consequence scope.

Before execution, Kungfu may derive an `ActionBinding` over one exact Fact cut,
Pursuit version, Atlas version, Warrant version, candidate action, and
resource. It is a decision receipt, not a fifth state Primitive:

```text
valid action
  = Atlas-supported
  intersect Pursuit-advancing
  intersect Warrant-authorized
```

Changing any root or the candidate action invalidates the binding. An Episode
may reference the binding used when an action occurred, but occurrence cannot
repair a stale Atlas or invalid Warrant.

## Why the roles remain separate

Each collapse creates an unsafe inference:

- an active goal does not grant authority;
- available context is not complete reality;
- a plan or authorization does not prove occurrence;
- an Episode or successful command does not prove completion; and
- a parent Warrant does not automatically authorize a descendant action.

Kungfu must refuse, report uncertainty, or degrade trust when a required role
is missing or stale. It must not reconstruct the missing fact from chat,
provider memory, or a nearby object.

Separation here is semantic. A single stored document, service call, command,
or interface may carry several bindings and mappings when each remains
traceable and
can be varied, invalidated, expired, revoked, or made stale without silently
changing the others. Qualification tests those counterfactual and negative
cases. It does not require five physical objects, APIs, forms, or interface
components.

## The work loop

A complete loop selects a Pursuit, declares the Atlas used for the next
decision, verifies or obtains a Warrant, records the action as an Episode, then
reviews consequence from an explicit perspective before continuing, revising,
pausing, escalating, or stopping.

The roles are many-to-many. A Pursuit may use several Atlases, Warrants, and
Episodes; any of those may support more than one Pursuit. References preserve
the relation and exact roots but grant no semantic inheritance.

## Simple use remains simple

Kungfu applies progressive disclosure:

```text
Pursuit  -> current inbox or work item
Atlas    -> current workspace and declared source cut
Warrant  -> explicit standing low-risk local authority
Episode  -> automatically opened and sealed action record
```

A low-risk flow may present one action instead of five forms. Its defaults must
remain inspectable, replaceable, exportable, and independently invalidatable.
External effects, uncertain evidence, delegation, consequential execution, and
handoff reveal the additional roots required by their consequence.

The contract embeds the transitional combined-v1 Domain Profile object schema
and publishes executable
positive and negative examples under
[`framework/agent-work/fixtures`](../../framework/agent-work/fixtures/).
One paired example preserves the same context payload and candidate action
while changing only the Warrant boundary; one action is valid and the other is
denied. That is a concrete proof that context alone cannot recover intent,
perspective, and authority.

## Current product mapping

- Mission/Go is the first-party Pursuit projection in the Mission Control
  Profile. It is not universal Core vocabulary.
- Xinfa Atlas, Project Cut, and runtime query cuts provide current Atlas
  mappings.
- Profile plans and authorizations plus Mission Control claim, independent
  review, and continuation decisions provide current Warrant mappings. A
  generic first-class Warrant remains incomplete.
- Kungfu Episode is the causal-experience authority.

The exact mappings and maturity are intentionally machine-readable. Inspect
the installed product rather than relying on this summary:

```sh
kungfu agent work-model --json
kungfu agent work capabilities --json
kungfu agent work inspect --ref profiles/work/main --json
kungfu contract show agent-work-state --json
kungfu contract show action-geometry --json
kungfu contract show agent-work-domain-profile --json
kungfu agent capabilities --json
```

The combined-v1 compatibility surface still adds an independently queryable
Fact mapping beside Pursuit, Atlas, Warrant, and Episode. Requests continue to
use `kungfu.kfd7.profile-action/v1`, receipts continue to use
`kungfu.kfd7.profile-action-receipt/v1`, object types remain
`kfd7.profile.<role>`, and retained v1 role bodies keep their original meaning.

Fact and Episode remain ontology bindings, while Pursuit, Atlas, and Warrant
are Action Geometry mappings. Product transition names remain an outer-ring
vocabulary and map to KFD-7's closed action geometry in
[`kungfu-kfd-7-action-contract.json`](../../framework/agent-work/kungfu-kfd-7-action-contract.json).
These existing names retain their original compatibility meaning.

Newly persisted role bodies use per-role `/v2` schemas and bind the exact
`actionGeometryRoot`, `domainProfileRoot`, and `roleSchemaRoot`. Missing or
wrong successor bindings fail closed. `kungfu agent work capabilities --json`
publishes those roots while retaining `roleBodySchema` as the legacy reader
identity and adding `roleBodySchemas` for successor writers. The same
registered authority is discoverable by generic contract, Agent, and
per-primitive capability routes. This separation remains release-staged until
cross-platform, independent-review, migration, and Release Passport evidence
close.

In new documentation, **Action Geometry Contract** names the separately rooted
geometry artifact and **Domain Profile Declaration** names the adopter artifact.
`Action Profile`, unqualified `Action Contract`, the existing
`kungfu-kfd-7-action-contract.json` path, and current Profile protocol ids are
combined-v1 compatibility terms only. They remain readable with no scheduled
removal version and are not reused for successor semantics.

Projection rebuild is supported from the native Fact journal plus verified
body bytes. A clean home without a qualified Fact export reports
`profile-authority-unavailable`; export/import remains explicit loss until a
Fact bundle that preserves the journal, body namespace, refs, and exact Cuts
is qualified. Backend switching is delegated to the existing storage service
and must conserve those identities.

The generic contract query is the KFD-1 route to the welded fact. The
agent-specific work-model and capabilities commands are KFD-3 collaboration
interfaces over that same authority. The associated KFD-2 claim audits the
published `not-qualified` state and `FO1`-`FO10` evidence debt; it does not
assert that P17 has passed.

## Qualification status

The contract remains below product gate P17. Retained generic Fact kernel
dogfood now qualifies `FO1`, `FO2`, and `FO6`: Pursuit, Atlas, Warrant, and
Episode have independent persisted identities and relations over exact Fact
Cuts, one real qualification work item reaches a sealed successor Cut, and two
exact-root files support no-chat review plus clean-runtime continuation. `FO3`
and `FO7` are partial; fresh-product
progressive disclosure, GUI/TUI parity, sustained multi-work-item dogfood,
generic Warrant maturity, and release binding remain explicit debt. Inspect the
machine contract and retained report rather than inferring P17 from this prose.

The retained KFD-7 release-gate declaration is
[`kungfu-kfd-7-release-gate.json`](../../framework/agent-work/kungfu-kfd-7-release-gate.json).
Buildchain verifies its frozen action contract, positive and negative runtime
reports, packaged contract surface, and required experiment inventory. The
current result is deliberately `warning`: export/import, backend migration,
clean-home continuation, and independent activation review remain explicit
qualification debt even though the retained evidence is internally closed.

Schema closure and semantic fixtures strengthen the contract but do not
qualify native persistence, recovery, product interaction, or sustained
dogfood. The release status therefore remains explicitly `not-qualified`.

Kungfu does not currently claim that every workflow must display all five
bindings, that the model is universal for every organization, or that current
combined-v1 labels are the final successor interface.
