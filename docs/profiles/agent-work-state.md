# Agent Work State

Agent Work is Kungfu's first **Domain Profile** over the cross-domain **Action
Geometry** defined by KFD-7 and ADR-0123. Action Geometry preserves the
responsibility boundaries and non-substitution invariants below; this Domain
Profile owns the concrete work fields, lifecycle vocabulary, defaults,
validation, evidence policy, and presentation. Pursuit, Atlas, and Warrant are
Action Primitives, not Profiles.

Real-world agent work stays coherent when four different questions have four
independently inspectable answers:

| Role | Question it answers |
| --- | --- |
| **Pursuit** | What intended change are we continuing, and what would count as success? |
| **Atlas** | From whose perspective, from which sources, and at what cut are we understanding reality? |
| **Warrant** | Who may do which bounded action against which exact state and constraints? |
| **Episode** | What actually occurred, with which inputs, observations, consequences, and provenance? |

The machine authority for the definitions, relations, implementation mappings,
invalid inferences, defaults, and qualification status is
[`kungfu-agent-work-state.contract.json`](../../framework/agent-work/kungfu-agent-work-state.contract.json).
This page is its human route, not a second specification.

## How the four roles use the runtime substrates

The four-role product model and the lower runtime ontology answer different
questions:

```text
Fact substrate
  -> Pursuit: intent continuity and success conditions
  -> Atlas: declared perspective, sources, and Cut
  -> Warrant: bounded authority and responsibility

Episode substrate
  -> causal experience of what occurred across Fact Cuts
```

Pursuit, Atlas, and Warrant are not three special databases or aliases for any
arbitrary Fact. They are independently identified action objects whose
versions, relations, and current views use the generic Fact kernel. Episode is
both the fourth independently addressable Agent Work role and the temporal
substrate. It may produce evidence for new Facts but cannot substitute for
state, perspective, authority, or completion.

## Identity, versions, and one action

Each Fact-backed role separates three things:

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

A low-risk flow may present one action instead of four forms. Its defaults must
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
kungfu agent capabilities --json
```

The provisional combined-v1 implementation adds an independently queryable
Fact mapping beside Pursuit, Atlas, Warrant, and Episode. Every mutation uses
`kungfu.kfd7.profile-action/v1` and returns
`kungfu.kfd7.profile-action-receipt/v1`; the same installed CLI path is used
by Python, Node, Agent, and GUI adapters. Product transition names remain an
outer-ring vocabulary and map to KFD-7's closed action geometry in
[`kungfu-kfd-7-action-contract.json`](../../framework/agent-work/kungfu-kfd-7-action-contract.json).
These existing names retain their original compatibility meaning. The staged
successor must separately expose `actionGeometryRoot`, `domainProfileRoot`, and
per-role `roleSchemaRoots`; it may not relabel existing roots. The declaration
remains provisional and non-qualifying until dogfood, migration, artifact, and
independent-review evidence close.

Projection rebuild is supported from the native Fact journal plus verified
body bytes. A clean home without a qualified Fact export reports
`profile-authority-unavailable`; export/import remains explicit loss until a
Fact bundle that preserves the journal, body namespace, refs, and exact Cuts
is qualified. Backend switching is delegated to the existing storage service
and must conserve those identities.

The generic contract query is the KFD-1 route to the welded fact. The
agent-specific work-model and capabilities commands are KFD-3 collaboration
interfaces over that same authority. The associated KFD-2 claim audits the
published `not-qualified` state and evidence debt; it does not assert that P17
has passed.

## Qualification status

The contract remains below product gate P17. Retained generic Fact kernel
dogfood now qualifies `FO1`, `FO2`, and `FO6`: all four roles have independent
persisted identities and relations, one real qualification work item reaches a
sealed successor Cut, and two exact-root files support no-chat review plus
clean-runtime continuation. `FO3` and `FO7` are partial; fresh-product
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

Kungfu does not currently claim that the four names are permanent, that every
workflow must display all four roles, that the model is universal for every
organization, or that it is an adopted numbered KFD.
