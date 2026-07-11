# Querying runtime facts

Kungfu's runtime fact ledger is designed to answer both current-state and
historical questions without promoting a cache or GUI database into the source
of truth.

This document describes the target service contract accepted by
[ADR-0048](../framework/core/docs/adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md).
The implementation is staged; command examples below describe the intended
surface and must not be read as a claim that every command already ships.

## The query basis

A result is meaningful only with its basis:

```text
FactState(scope, perspective, cut, policy)
  = fold(authoritative records admitted by that basis)
```

- **scope** chooses the data root, sources, Episodes, or other authority set;
- **perspective** chooses the observer and ordering policy for concurrent facts;
- **cut** chooses `head` or a reproducible historical frontier;
- **policy** chooses reducer, schema, conflict, and redaction semantics.

Kungfu does not claim one universal wall-clock truth. It provides a canonical,
reproducible answer under a declared basis. If two authoritative sources
disagree, the answer can preserve that disagreement instead of silently
selecting one claim.

Queries also distinguish:

- valid/event time — when a claim applies externally;
- system/knowledge time — when Kungfu accepted or corrected it;
- logical/causal time — journal order and causal/Episode closure.

## Current, historical, and differential queries

The current state is a query at `head`. Historical state uses the same query at
an earlier cut. A diff compares two declared cuts.

Conceptually:

```text
query(definition, cut=head)
query(definition, cut=episode-root:...)
diff(definition, from=cut-a, to=cut-b)
```

Checkpoints and SQLite projections may make these operations fast. They are
rebuildable accelerators; the authoritative records and fold semantics still
determine the result.

The existing `kungfu storage query` surface is a lower-level projection
inspection tool. It does not yet provide the explicit basis, lineage, and
authority-scan conformance described here.

## One query, several authoring surfaces

Humans and agents do not need to use the same syntax. They do share the same
durable query object.

- common CLI verbs cover Episode lists, state, diffs, and evidence;
- SQL covers general relational queries;
- typed SDK builders support C++, Python, Node/TypeScript, and KFX;
- GUI/TUI builders cover filters, tables, timelines, causal traversal, and
  temporal patterns.

All of these compile to one normalized logical plan. SQL is supported, but it
does not define the truth model. A GUI-saved query is not private GUI state; an
agent can inspect and modify the same QueryDefinition.

Temporal pattern matching is part of the shared plan. The target is to expose
it through SQL, typed builders, saved templates, and visual builders rather
than require a separate EPL-like language.

## Query results include proof

A result may include rows, but it also carries the evidence needed to interpret
them:

- authority roots, source ids, accepted ranges, cut, and frontier;
- Episode ids and sealed content roots;
- query-definition and logical-plan hashes;
- schema, reducer, fold-policy, and engine versions;
- missing, redacted, corrupt, tombstoned, or unverifiable inputs;
- result schema and hash.

Planning and proof are different questions:

```text
explain -> how Kungfu plans to execute the query
prove   -> which authority and derivation support the result
```

## Continuous queries

Continuous queries start with a snapshot and continue as a resumable changelog.
The contract includes row upserts and retractions, progress/frontier messages,
schema changes, resume tokens, and explicit gaps.

This allows a GUI, agent, or external consumer to distinguish:

- no matching change has happened;
- the source has not advanced;
- a row was corrected or retracted;
- the connection resumed successfully;
- updates were missed and recovery is required.

NDJSON is the intended CLI stream representation. Bulk tabular results may use
Apache Arrow, while ADBC or Flight SQL may provide external database adapters.
None of those representations becomes fact authority.

## Agent-facing shape

The target discovery and diagnostic surface is:

```sh
kungfu query capabilities --json
kungfu query schema --json
kungfu query examples --json
kungfu query validate --file query.json --json
kungfu query explain --file query.json --json
kungfu query prove --file query.json --json
```

Stable JSON carries proof envelopes, NDJSON carries changelogs, and TSV exists
for shell and `awk` composition. Data is written to stdout and diagnostics to
stderr. Pagination, truncation, error codes, and exit status are explicit.

The release target is that an offline fresh agent can discover, validate, and
run a useful query without requiring a human to teach it SQL or locate web
documentation.

## Human-facing shape

Humans can build and save queries through reference components:

- table and grouped state views;
- Episode timelines;
- before/after diffs;
- causal graphs and evidence drill-down;
- temporal pattern builders;
- metrics backed by inspectable QueryDefinitions.

Presentation is stored separately as a ViewSpec. Changing a chart, visible
column, or layout cannot silently change the query basis.

## Current maturity

ADR-0048 accepts the target semantics and staged sequence. It does not claim a
complete SQL dialect, CEP engine, changelog implementation, or GUI builder is
already present.

The first implementation slice must prove one bounded Episode/fact query at
`head` and at a historical cut, including its lineage. Later slices add the
planner and CLI, projection/SQL conformance, changelog/GUI components, and the
smallest temporal-pattern set justified by dogfood.
