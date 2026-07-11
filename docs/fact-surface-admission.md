# Bringing domain facts into Kungfu

Kungfu can preserve and query facts from a product, user, extension, or domain
without pretending that every recorded event is automatically true.

The path is:

```text
declare the fact world -> record and admit observations -> preserve Episodes
-> query a declared cut -> assess a claim
```

This is the user-facing design accepted by
[ADR-0051](../framework/core/docs/adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md).
The implementation is staged; names and examples below describe the intended
contract, not a claim that every command already ships.

## Declare what can count as a fact

A KFD-1 contract world names the load-bearing world in which an answer is meant
to hold. Its fact-surface declarations identify schema ownership, accepted
sources, identity and time rules, correction/retraction behavior, conflicts,
redaction, compatibility, and known limits.

Kungfu ships declarations for its own core facts. Users and extensions can add
domain declarations. The core does not need domain-specific vocabulary: a game
can declare entity-state facts, an agent application can declare delegated-work
facts, and a trading application can declare orders and executions.

## Record first; admit explicitly

Kungfu preserves an observation even when it cannot yet use that observation in
a canonical fold. Admission reports whether it is admitted, unregistered,
schema-incompatible, authority-ambiguous, or unverifiable.

This distinction matters:

- **recorded** means Kungfu can preserve and inspect what arrived;
- **admitted** means it satisfied a pinned declaration at that cut;
- **trusted** is a later KFD-2 assessment of a particular claim and purpose.

None of these alone proves universal external truth. If two admitted sources
disagree, Kungfu preserves the disagreement.

## Replay uses the declaration that governed the history

Admission decisions and declaration changes are Episode facts. Historical
queries pin the declaration version/root effective at the requested cut. A new
declaration does not silently reinterpret an older Episode.

This makes schema and policy evolution inspectable: a migration or
reclassification is another explicit, evidenced transition rather than a
rewrite of history.

## Query and prove the bounded answer

The runtime-fact query basis includes the contract world as well as scope,
perspective, cut, and fold policy. Its proof identifies the exact declarations,
Episodes, roots, sources, accepted ranges, and missing or conflicting evidence.

Raw observations remain queryable for diagnosis. Only facts admitted under the
pinned declarations enter the canonical fact state for that contract world.

See [Querying runtime facts](querying-runtime-facts.md) for SQL, typed builders,
CLI, GUI, historical cuts, and proof-carrying results.

## Assess trust for a purpose

KFD-2 evaluates a claim over the admitted facts. A trust report binds the claim
to its declaration roots, Episode/query proof, responsibility, validation,
known gaps, and residual risk. Trust is therefore inspectable and purpose-bound,
not a boolean copied onto every row.

Assessment is claim-triggered rather than run after every recorded event. In a
Desktop workspace, the workspace master coordinates durable assessment jobs
and supervised workers. Embedded libkungfu consumers may execute the same job
contract in controlled threads. Both produce a separate Assessment Episode and
the same TrustReport semantics. See
[KFD-2 trust assessment in a live workspace](kfd2-trust-assessment.md).

## Intended developer path

The SDK target is one shared declaration consumed by local runtime checks,
packaged artifacts, and release evidence:

```text
kungfu sdk add fact-surface <name>
  -> declaration + schema owner + append/fold/readback fixture
  -> local admission and query proof
  -> optional KFD-2 trust report and Buildchain evidence
```

The CLI, SDKs, GUI/TUI, and Buildchain must inspect the same semantic object.
No GUI database or generated release file becomes a second fact authority.

## Current executable slice

The first executable declaration is the built-in
`kungfu.runtime.episode-manifest` fact surface inside the `kungfu.runtime`
contract world. Query normalization binds both content roots into the
QueryDefinition, LogicalPlan, and proof lineage. The authority scan returns
canonical rows only when those exact registered roots match; an unknown id,
incompatible version, ambiguous surface set, or changed root returns no
canonical rows and reports a typed admission outcome instead of consulting a
newer declaration implicitly.

This slice establishes the declaration and diagnostic contract for the Episode
authority oracle. General user/domain declaration registration and journaled
per-observation admission remain staged work; the current runtime does not
claim that arbitrary recorded observations are admitted facts.
