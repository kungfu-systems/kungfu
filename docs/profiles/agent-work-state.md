# Agent Work State

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
kungfu contract show agent-work-state --json
kungfu agent capabilities --json
```

The generic contract query is the KFD-1 route to the welded fact. The
agent-specific work-model and capabilities commands are KFD-3 collaboration
interfaces over that same authority. The associated KFD-2 claim audits the
published `not-qualified` state and evidence debt; it does not assert that P17
has passed.

## Qualification status

The contract is a starting point for product gate P17, not proof that P17 has
passed. Its `qualification.checks` field reports `FO1` through `FO8` and the
remaining evidence for independent identity, end-to-end action, invalid
inference rejection, progressive disclosure, human/agent parity, recovery and
handoff, reality-pressure dogfood, and bounded release claims.

Kungfu does not currently claim that the four names are permanent, that every
workflow must display all four roles, that the model is universal for every
organization, or that it is an adopted numbered KFD.
