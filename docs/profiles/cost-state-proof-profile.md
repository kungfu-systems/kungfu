# Cost/State/Proof profile

Cost/State/Proof is a commercial Work Control profile. It is not
the first-contact contract: the first-release entry leads with continuity —
`Keep the work when the chat ends.` — then exposes this deeper profile when a
user asks a familiar delegated-agent question:

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

The first runtime projection is now exposed inside
`kungfu.work-control.trust-report/v1` as
`kungfu.profile.delegated-work-cost-state-proof/v1`. It composes the admitted
Initiative/Assignment state, linked Rewind `CostSnapshot` facts, verified Episode roots,
and the purpose-bound assessment. It does not copy cost into a second ledger.

## Cost

Cost includes only declared, attributable observations such as tokens, money,
runtime, compute, and human attention. It carries attribution strength,
confidence, source, capture boundary, and missing/ambiguous state.

Cost alone is a bill. The profile always binds cost to a stable run, Assignment, or
Episode coordinate and exposes whether the work is advancing, blocked, stale,
waiting, or unsupported by evidence.

For an external evidence adapter, a Rewind `CostSnapshot.work_id` matches either the
stable imported Assignment id or its namespaced subject key. Tokens remain visible when
the provider does not report money; unknown USD is rendered as unknown rather
than zero. Unsealed runs, unreadable runs, weak attribution, and ambiguous
windows degrade the cost status instead of disappearing.

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

## Relationship to Work Control

The profile may operate before a user explicitly creates an Initiative. In that
case a run or imported task is the visible starting object. As the user keeps
working, the same identity and facts can be attached to an Assignment and Initiative
without migration to another product model.

The natural adoption path is:

```text
control agent cost
  -> understand delegated-work state
  -> verify completion claims
  -> connect work to an Assignment
  -> manage long-running Initiatives
```

Other future profiles may select different fact surfaces, queries, assessors,
and views while sharing the same Work Control and runtime authority.

## First qualification

The first profile qualification should prove, in an isolated data root, that:

- one imported or managed run has stable cost attribution and an explicit
  degraded state when attribution is weak;
- its responsibility state is reconstructed from facts at a pinned cut;
- a completion claim produces a purpose-bound TrustReport;
- the GUI summary and agent CLI return equivalent state and proof coordinates;
- adding an Initiative/Assignment link does not copy or reinterpret the underlying run;
- missing evidence cannot render a trusted completion state.

The first implemented qualification now proves both progress and completion
paths. An exact-run CostSnapshot is joined to an admitted or native Assignment; the same
reported run uses one Episode for RunBegin, CostSnapshot, and RunEnd; its
frame-verified root is carried in profile proof; and unknown USD remains
explicit. A completion claim with no independent Episode remains insufficient,
while the same claim with a verified work Episode produces a purpose-bound
fresh report. GUI and CLI consume the same profile and assessment identities.
