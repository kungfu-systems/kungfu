# Bringing domain facts into Kungfu

Kungfu can preserve and query facts from a product, user, extension, or domain
without pretending that every recorded event is automatically true.

The path is:

```text
declare the fact world -> record and admit observations -> preserve Episodes
-> query a declared cut -> assess a claim
```

This is the user-facing design accepted by
[KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](../adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md).
The declaration/admission slice is executable; KFD-2 assessment and SDK
scaffolding remain staged. The boundary is listed below so an intended command
is not mistaken for a shipped guarantee.

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

KFD-2 evaluates a claim over the admitted facts. A TrustReport binds the claim
to its declaration roots, Episode/query proof, responsibility, validation,
known gaps, and residual risk. Trust is therefore inspectable and purpose-bound,
not a boolean copied onto every row.

Assessment is claim-triggered rather than run after every recorded event. In a
Desktop workspace, the workspace coordinator coordinates durable assessment jobs
and supervised workers. Embedded libkungfu consumers may execute the same job
contract in controlled threads. Both produce a separate Assessment Episode and
the same TrustReport semantics. See
[KFD-2 trust assessment in a live workspace](../qualification/kfd2-trust-assessment.md).

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

The general user/domain slice adds one FlatBuffers-owned event contract in
libkungfu. Contract-world declarations, fact-surface declarations,
observations, and admission decisions are journaled and attached to sealed
Episodes. The C++ fold selects the declaration effective at each observation's
system time and exposes the same thin edge through Python, Node, the native
Rust ABI, and the CLI:

```text
kungfu facts capabilities
kungfu facts declare-world --file world.json --system-time 100
kungfu facts declare-surface --file surface.json --system-time 101
kungfu facts observe --file observation.json --system-time 110
kungfu facts state --cut-system-time 150 --subject-key sku-42
```

`facts state` keeps valid, system, and causal time separate; rejected
observations stay in `observation_history` but never enter `canonical_facts`.
Corrections and retractions name an admitted target observation. Concurrent
admitted source claims remain visible and produce a conflict instead of being
silently resolved.

## Managed Fact Library

Built Kungfu Episodes exposes the same authority through an end-user Fact
Library. `Fact Manager` is a first-party GUI view; the installed CLI is the
agent-facing intent surface:

```text
kungfu facts library
kungfu facts type create --id goal-status --version 1 \
  --source agent --source human --schema-file goal-status.schema.json
kungfu facts type list
kungfu facts material put --type goal-status --type-version 1 \
  --source agent --subject current-goal --payload-file status.json
kungfu facts material list --type goal-status --subject current-goal
kungfu facts export --out fact-library.full.json
kungfu facts export --out fact-library.thin.json --thin
kungfu facts import --file fact-library.full.json
kungfu facts import --file fact-library.full.json --execute
```

The selected Kungfu data root remains the authority. A workspace uses its
resolved `.kungfu/`; a personal/machine library uses the resolved `KF_HOME`.
The GUI shows that root and never keeps a private fact database. Type versions
are immutable and exact: a workspace adopts or imports a concrete version, not
a mutable global "latest" pointer.

Managed JSON schemas and JSON payloads are immutable content-addressed objects
under the existing `schemas` and `payloads` namespaces. Their declaration and
observation Episodes own corresponding refs. A full Fact Library bundle carries
the journal frames plus schema and payload bytes; a thin bundle carries the
declared refs and fails honestly if material is unavailable. Import validates
by default and writes only with explicit `--execute`; replay is append-only,
idempotent for the same Episode root, and refuses identity conflicts.

The first product slice intentionally exposes only `declared-facts-v1`: the
runtime's implemented subject-key identity, explicit valid time, journal system
time, event-parent causality, latest-admitted-per-source fold, explicit-target
correction/retraction, preserved source conflicts, hash/ref redaction, and
exact-schema compatibility. It does not pretend arbitrary policy strings are a
general rule engine, define a universal ontology, or decide external truth.
