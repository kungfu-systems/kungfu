# Querying runtime facts

Kungfu's runtime fact ledger is designed to answer both current-state and
historical questions without promoting a cache or GUI database into the source
of truth.

This document describes the target service contract accepted by
[ADR-0048](./adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md).
The implementation is staged. QueryDefinition planning, proof-bearing Episode
queries, the agent CLI, a bounded SQL compiler, journal/SQLite conformance, a
resumable changelog, a bounded temporal-pattern operator, and
table/timeline/diff/causal-graph/attention reference views ship today. Broad
SQL and general complex-event processing remain outside the current surface.

## The query basis

A result is meaningful only with its basis:

```text
FactState(contract_world, scope, perspective, cut, policy)
  = fold(records admitted under the pinned declarations)
```

- **contract_world** pins the KFD-1 contract-world and fact-surface
  declarations that decide which observations may enter the fold;
- **scope** chooses the data root, sources, Episodes, or other authority set;
- **perspective** chooses the observer and ordering policy for concurrent facts;
- **cut** chooses `head` or a reproducible historical frontier;
- **policy** chooses reducer, schema, conflict, and redaction semantics.

Kungfu does not claim one universal wall-clock truth. It provides a canonical,
reproducible answer under a declared basis. If two authoritative sources
disagree, the answer can preserve that disagreement instead of silently
selecting one claim.

Recording is not automatic admission. Unregistered, schema-incompatible,
authority-ambiguous, or unverifiable observations remain inspectable for
diagnosis, but they do not enter canonical fact state. See
[Bringing domain facts into Kungfu](fact-surface-admission.md) and
[ADR-0051](./adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md).

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

The bounded `fact-state` object applies the same contract to admitted domain
facts. It selects a finite set of stable subject keys and supports `head` or an
exact system-time cut. The basis excerpt below omits the required declaration,
policy, and time-axis fields for readability:

```json
{
  "schema": "kungfu.query.definition/v1",
  "object": "fact-state",
  "subject_keys": ["atlas:mission-a", "atlas:goal-a"],
  "basis": {
    "scope": "domain-fact-ledger",
    "perspective": "system-time-then-observation-id",
    "cut": { "kind": "head" }
  }
}
```

The complete definition also pins contract-world and fact-surface roots,
policy versions, and all three time axes. The result returns payload hashes and
refs, verified fact Episode roots, a definition root, and a proof root. Payload
resolution stays content-addressed and cannot change the query basis.

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
- bounded SQL covers the current Episode row selection subset;
- typed SDK builders support C++, Python, Node/TypeScript, and KFX;
- GUI/TUI builders cover filters, tables, timelines, causal traversal, and
  temporal patterns.

All of these compile to one normalized logical plan. SQL is supported, but it
does not define the truth model. A GUI-saved query is not private GUI state; an
agent can inspect and modify the same QueryDefinition.

The current fail-closed SQL grammar is deliberately small:

```sql
SELECT * FROM episodes
  [WHERE episode_id = <unsigned integer>]
  [ORDER BY episode_id ASC]
  [LIMIT <1..1000>]
```

It also accepts one bounded pattern form:

```sql
SELECT * FROM episodes MATCH_RECOGNIZE (
  PARTITION BY source ORDER BY begin_time ASC
  PATTERN ((A B){2,8})
  DEFINE A AS title = 'alpha_published',
         B AS title = 'gate_failed'
  WITHIN 3600000000000 AS OF 7200000000000
  ABSENT title = 'stable_published'
) LIMIT 10
```

The equivalent `kungfu.query.temporal-pattern/v1` in QueryDefinition admits
exactly one partition field, one explicit order field, a two-predicate ordered
subsequence repeated 1–16 times, a 1 ns–30 day window, an explicit `as_of_time`,
and one optional absence predicate. Alternation, nesting, unbounded waits, and
inferred causality fail closed. The explicit as-of time makes absence
reproducible rather than a guess about whether enough time has passed.

Column projections, joins, subqueries, `OR`, non-equality predicates, and
descending order are rejected. SQL owns only row selection. A base
QueryDefinition still owns the declaration roots, scope, cut, policy, and time
basis. Both authoring forms must produce the same LogicalPlan hash.

Temporal pattern matching is part of the shared plan and is exposed through
QueryDefinition, bounded SQL, typed TypeScript contracts, saved views, and the
System Status attention reference. It does not require a separate EPL-like
language.

### Attention qualification dogfood

The first fixture encodes the observed Buildchain question as ordinary Episode
manifest rows: `title` is the recorded event type, `source` is the release or
feature correlation key, `actor` is the recorded attribution class, and
`begin_time` is the declared event time. Repeated
`alpha_published -> gate_failed` pairs within a closed window, with no
`stable_published`, yield one proof-bearing attention row. A later stable event
inside that valid-time window retracts the row through the existing changelog.

The same operator is exercised by an unrelated corpus-import fixture using
`stage_started -> validation_failed` and the absence of
`human_decision_required`. This guards against embedding Buildchain-specific
logic in the query engine. Attribution counts report recorded actors; temporal
proximity alone never becomes a causal claim.

## Query results include proof

A result may include rows, but it also carries the evidence needed to interpret
them:

- authority roots, source ids, accepted ranges, cut, and frontier;
- contract-world and fact-surface declaration ids, versions, and roots;
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

The current Episode implementation returns deterministic bounded pages. A
resume token pins the shared QueryDefinition and logical-plan hashes, the
source and target frontiers (opaque frame UID plus monotonic authority-record
count), both result hashes, the batch id, and the next message index. Reconnect
re-runs the exact authority cuts before continuing.
Message ids are stable within a batch, so replay is idempotent; a consumer that
cannot reproduce a pinned result receives `Gap` and must request a new full
snapshot. The token is integrity-hashed and cannot be moved to another query.

NDJSON is the intended CLI stream representation. Bulk tabular results may use
Apache Arrow, while ADBC or Flight SQL may provide external database adapters.
None of those representations becomes fact authority.

## Agent-facing shape

The target discovery and diagnostic surface is:

```sh
kungfu query capabilities --json
kungfu query schema --json
kungfu query examples --json
kungfu query compile-sql --file basis.json \
  --sql 'SELECT * FROM episodes WHERE episode_id = 1048 LIMIT 10' --json
kungfu query validate --file query.json --json
kungfu query explain --file query.json --json
kungfu query prove --file query.json --json
kungfu query changelog --file query.json --max-messages 100 --json
kungfu query saved-view --file saved-view.json --json
kungfu query saved import --file saved-view.json --json
kungfu query saved list --json
kungfu query saved run <id> --json
kungfu query saved export <id>
kungfu storage episode rebuild-projection --json
kungfu query prove --file query.json --engine sqlite --json
```

The SQLite engine requires an explicit Episode projection rebuild and fails
closed when the projection is absent or stale. Its append-preserving record
table retains journal order, exact frame-uid cuts, duplicates, unknown records,
and packed record bodies. The journal remains the authority. Conformance checks
compare normalized definitions/plans, result schema, rows, result hash,
authority/cut lineage, admission outcomes, and canonical state; physical engine
identity is reported separately as execution evidence.

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

The System Status KFX contains table, timeline, diff, causal-graph, and
attention references. It imports the same `kungfu.query.saved-view/v1` JSON that
the CLI inspects. The native saved-query catalog journals create, update, and
delete revisions under the resolved workspace `.kungfu` runtime home; CLI, GUI,
and agents address the same stable query id. Only the QueryDefinition and thin
ViewSpec are saved. Result rows and proof are rebuilt from the native query
capability, and missing or unverifiable evidence remains visible in every view.
The GUI does not open or own a database, and portable sharing uses explicit
JSON export rather than copying raw `.kungfu` storage.
- metrics backed by inspectable QueryDefinitions.

Presentation is stored separately as a ViewSpec. Changing a chart, visible
column, or layout cannot silently change the query basis.

## Current maturity

ADR-0048 accepts the target semantics and staged sequence. It does not claim a
complete SQL dialect, general CEP engine, or full visual query builder.

The current implementation proves bounded Episode, admitted `fact-state`, and
temporal-attention queries. Episode queries support `head` and exact historical
manifest-frame cuts; fact-state queries support `head` and exact system-time
cuts. Both include
declaration coordinates, typed admission outcomes, proof lineage, one
normalized LogicalPlan, authority/SQLite conformance, changelog retractions,
and thin GUI presentation. The admitted temporal algebra stays intentionally
small until more dogfood questions justify expanding it.
