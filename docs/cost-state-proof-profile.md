# Cost/State/Proof profile

Cost/State/Proof is the first commercial profile of Kungfu Mission Control. It
gives a new user an immediate answer to a familiar delegated-agent problem:

```text
Is this agent work producing a trustworthy result, or only continuing to spend?
```

The profile is a versioned composition of existing Kungfu contracts, not a new
fact authority or a separate spend product.

## Profile identity

The intended stable identity is:

```text
kungfu.profile.delegated-work-cost-state-proof/v1
```

Its release artifact should eventually declare:

- admitted run, cost, work-state, claim, artifact, validation, and decision
  fact surfaces;
- source-authority and attribution policies;
- saved QueryDefinitions and thin ViewSpecs;
- claim-triggered assessment policies;
- default observer and degraded-state behavior;
- the KFX selection and first-screen workflow;
- compatibility, known limits, and qualification evidence.

## Cost

Cost includes only declared, attributable observations such as tokens, money,
runtime, compute, and human attention. It carries attribution strength,
confidence, source, capture boundary, and missing/ambiguous state.

Cost alone is a bill. The profile always binds cost to a stable run, Go, or
Episode coordinate and exposes whether the work is advancing, blocked, stale,
waiting, or unsupported by evidence.

## State

State is a fold over admitted facts, not an agent-controlled mutable label. The
first responsibility vocabulary is intentionally bounded:

```text
proposed
active
blocked
waiting-for-decision
claimed-complete
assessed
closed
reopened
```

An adapter may map source-specific states into this vocabulary while preserving
the original source claim and mapping policy. Unknown or conflicting states do
not silently become `active` or `done`.

## Proof

Proof binds the visible state to its query basis and lineage: declarations,
accepted sources and ranges, observer, cut/frontier, Episode roots, result hash,
missing evidence, conflicts, redaction, and assessment freshness.

`claimed-complete` is visible before proof is sufficient. A KFD-2 TrustReport
states whether the claim is fit for a purpose such as handoff, user review, or
release. The profile never converts agent self-report into final authority.

## Default user progression

```text
cost and current responsibility state
  -> stuck / drifting / needs-decision attention
  -> completion or progress TrustReport
  -> proof and evidence
  -> Episode timeline and replay
```

The market message may lead with cost management. The product must not degrade
into a provider billing dashboard: every cost surface retains state, effective
progress, blocker, claim, proof, and next-responsibility links.

## Relationship to Mission Control

The profile may operate before a user explicitly creates a Mission. In that
case a run or imported task is the visible starting object. As the user keeps
working, the same identity and facts can be attached to a Go and Mission
without migration to another product model.

The natural adoption path is:

```text
control agent cost
  -> understand delegated-work state
  -> verify completion claims
  -> connect work to a Go
  -> manage long-running Missions
```

Other future profiles may select different fact surfaces, queries, assessors,
and views while sharing the same Mission Control and runtime authority.

## First qualification

The first profile qualification should prove, in an isolated data root, that:

- one imported or managed run has stable cost attribution and an explicit
  degraded state when attribution is weak;
- its responsibility state is reconstructed from facts at a pinned cut;
- a completion claim produces a purpose-bound TrustReport;
- the GUI summary and agent CLI return equivalent state and proof coordinates;
- adding a Mission/Go link does not copy or reinterpret the underlying run;
- missing evidence cannot render a trusted completion state.
