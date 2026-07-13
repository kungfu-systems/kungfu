---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0048
decision_status: accepted
implementation_status: staged
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0048: runtime fact queries use explicit bases, one logical plan, and a proof-carrying changelog

- Status: accepted; implementation staged
- Date: 2026-07-11
- Category: architecture — query semantics and result protocol
- Subsystem: runtime fact ledger, Episode fold, storage service, projections,
  CLI, Python/Node SDKs, GUI/TUI, and KFX consumers
- Related: ADR-0018 defines the runtime storage service; ADR-0021 defines
  observer-relative timelines; ADR-0033 makes Episode the causal segment
  object; ADR-0043 defines sealed Episode content roots; ADR-0047 defines
  schema authority and typed service boundaries.

## Context

Kungfu can reconstruct how work happened from ordered, causal runtime facts.
Users and agents also need to ask what the ledger establishes at the current
head, what it established at an earlier cut, what changed between two cuts, and
which facts support the answer.

Exposing SQLite directly would answer some tabular questions but would give a
rebuildable projection authority over truth semantics. Adding unrelated SQL,
event-pattern, graph, SDK, and GUI query implementations would instead create
several definitions of time, causality, conflict, and evidence.

The query layer therefore needs a semantic root above physical engines and
below every human or agent surface.

## Decision

Kungfu will provide a local runtime-fact query service whose result is defined
by an explicit query basis:

```text
FactState(scope, perspective, cut, policy)
  = fold(authoritative records admitted by that basis)
```

This is bounded canonical truth, not universal wall-clock truth. A query result
is unique and reproducible only under its declared authority scope, observer
perspective, cut, and fold policy.

### 1. Every query carries its basis

The basis identifies:

- the data root, source set, Episode set, or other authority scope;
- the observer perspective and ordering policy for concurrent facts;
- `head` or a reproducible historical cut/frontier;
- reducer/fold, schema, conflict, and redaction policy versions.

Conflicting source claims remain facts. A result may establish that two sources
disagree and no resolution exists; it must not silently manufacture consensus.

The model keeps three time axes distinct:

- valid/event time — when a claim applies in its external domain;
- system/knowledge time — when Kungfu learned, accepted, corrected, or
  retracted it;
- logical/causal time — journal order, causal closure, Episode boundary, and
  observer-relative cut.

Implementations may stage syntax and indexes, but they must not collapse these
axes into one timestamp.

### 2. Query artifacts have separate compatibility lifetimes

The service uses four distinct artifacts:

1. **QueryDefinition** is the durable, versioned, serializable user/agent
   artifact. It records the basis, relational operations, bounded causal
   traversal, temporal patterns, parameters, ordering, limits, and requested
   evidence.
2. **LogicalPlan** is the normalized semantic contract. Its algebra combines
   relational, temporal, causal-graph, pattern, and evidence operators.
3. **PhysicalPlan** is engine-private and ephemeral. It selects journal scans,
   checkpoints, SQLite indexes, Arrow batches, and execution operators.
4. **ViewSpec** is presentation only. It may define table, timeline, graph,
   metric, formatting, and drill-down behavior, but it cannot change query
   semantics.

Saved queries and GUI widgets persist `QueryDefinition`, not a physical plan or
an opaque engine-specific query string. `ViewSpec` remains thin and does not
become a general UI programming language.

### 3. All frontends compile to the same logical plan

Kungfu will support these query entry paths:

- semantic CLI verbs for common Episode and fact questions;
- a documented SQL subset for general relational queries;
- versioned QueryDefinition JSON at the external edge;
- typed C++, Python, Node/TypeScript, and KFX builders;
- GUI/TUI query and pattern builders.

SQL is required but is not the semantic root. SQL parses into
`QueryDefinition` and the shared logical plan.

Temporal event-pattern capability is also required, but Kungfu will not create
an independent EPL-like public language initially. Pattern operators live in
the shared algebra and may be exposed through SQL `MATCH_RECOGNIZE` or a
constrained extension, typed builders, saved templates, and GUI builders.

Causal traversal belongs in the algebra. A separate graph language waits for
workloads that cannot be served by bounded traversal operators. GraphQL may be
an application response adapter later; it is not the truth-query language.

### 4. Results carry proof, not only rows

Every result can expose a lineage envelope containing, as applicable:

- canonical QueryDefinition and logical-plan hashes;
- authority roots, source ids, accepted ranges, cut, and frontier;
- Episode ids and sealed content roots;
- schema, reducer, fold-policy, and engine versions;
- valid/system/causal-time basis and determinism classification;
- missing, redacted, tombstoned, corrupt, or unverifiable inputs;
- result schema and result hash.

`explain` describes planning and cost. `prove` describes authority and
derivation. The interfaces must keep those meanings separate.

### 5. Continuous results use a resumable changelog

One-shot queries return a proof-carrying snapshot. Continuous queries use a
versioned changelog with at least these semantic messages:

```text
SnapshotBegin(basis, schema, resume_token)
RowUpsert(key, row, evidence_ref)
RowRetract(key, before_or_hash, evidence_ref)
Progress(frontier, watermark, resume_token)
SchemaChange(old_schema, new_schema, compatibility)
SnapshotEnd(result_hash, frontier, resume_token)
Gap(expected, observed, recovery_hint)
```

The protocol defines ordering, replay/idempotency, reconnect/resume,
backpressure, gap detection, and schema evolution. A stream of unqualified JSON
objects is not a continuous-query contract.

### 6. Projections and engines remain replaceable

The authoritative journal and Episode records determine facts. Checkpoints,
SQLite tables, search indexes, caches, and GUI databases are rebuildable
accelerators.

The same logical plan must be executable by an authority-scan reference path
and by accelerated projections. Shared conformance fixtures compare their
results and lineage.

Bulk tabular results may use Apache Arrow. ADBC and Flight SQL may provide
external database interoperability. These are data-plane or adapter choices,
not owners of query meaning or fact authority.

### 7. The existing storage query remains a projection diagnostic

ADR-0018's current `storage query` operation inspects named SQLite projection
tables through the C++ storage service. It remains useful for diagnostics and
for proving that bindings do not open SQLite independently, but it is not the
runtime-fact truth-query contract defined here.

The staged query service may reuse that operation as an early physical path.
It must add an explicit basis, normalized plan, typed result/lineage contract,
and authority-scan conformance before a result is described as canonical fact
state. Existing JSON rows remain an edge representation per ADR-0047, not the
internal semantic currency of the new service.

## Agent and human contract

The agent-facing CLI must be self-describing and shell-composable:

```text
kungfu query capabilities --json
kungfu query schema --json
kungfu query describe <object> --json
kungfu query examples --json
kungfu query validate --file query.json --json
kungfu query explain --file query.json --json
kungfu query prove --file query.json --json
```

Stable JSON is the default proof envelope, NDJSON carries changelogs, and TSV
supports shell/`awk` workflows. Data goes to stdout, diagnostics to stderr;
pagination, truncation, error codes, and exit statuses are explicit.

Humans are not expected to author SQL. GUI/TUI components consume the same
`QueryDefinition + ViewSpec -> snapshot/changelog + proof` contract used by the
CLI and SDKs. A visual query can be inspected or changed by an agent without
translation into a private GUI format.

## Implementation sequence

1. Define typed query-basis, cut, QueryDefinition, result-schema, and lineage
   contracts. Implement one bounded Episode/fact query over authority records,
   including `head` and one historical cut.
2. Add the minimal logical planner, semantic CLI verbs, JSON/NDJSON/TSV output,
   and separate `validate`, `explain`, and `prove` surfaces.
3. Execute the same plan through authority scan and SQLite projection, then add
   a constrained SQL frontend and cross-engine conformance fixtures.
4. Add the changelog protocol and reference table, timeline, diff, and causal
   graph components. Prove reconnect without silent loss or duplication.
5. Add the smallest temporal-pattern operator set justified by real dogfood,
   exposed through QueryDefinition, SDK, GUI, and one SQL form.

The first physical query engine and SQL parser are implementation choices. They
must not change the accepted basis, logical-plan, lineage, or changelog
contracts.

## Acceptance gates

The staged implementation is complete only when:

- equivalent SQL, QueryDefinition, typed SDK, and GUI inputs normalize to
  equivalent logical plans;
- authority-scan and projection engines return equivalent results and lineage;
- current and historical cuts remain reproducible after projection rebuild;
- reconnect tests prove no silent loss, duplication, or frontier regression;
- missing/redacted/unverifiable evidence remains visible;
- an offline fresh agent can discover, validate, and run a useful query without
  web documentation;
- a human can construct and reopen useful queries without writing SQL;
- replacing a physical engine does not change public query semantics.

## Consequences

- Kungfu becomes a truth-query substrate over runtime facts rather than only a
  recorder or viewer.
- SQL and temporal-pattern queries can be added without creating competing
  semantic roots.
- GUI and agent surfaces can exchange durable query artifacts directly.
- Historical state, continuous updates, and proof share one declared basis.
- The implementation carries database-like conformance obligations; a smaller
  first slice is preferable to a broad but ambiguous dialect.

## Alternatives considered

- **Expose SQLite/SQL as the truth API.** Rejected because SQLite is a
  rebuildable projection and cannot own authority, causal closure, redaction,
  or historical-cut semantics.
- **Use one universal QuerySpec for intent, planning, execution, and UI.**
  Rejected because those artifacts have different stability and replacement
  lifetimes.
- **Adopt EPL as a second primary language.** Rejected initially because it
  would create another public semantic root before shared pattern operators are
  proven insufficient.
- **Return snapshot plus ad-hoc deltas.** Rejected because retraction, progress,
  resume, gaps, and schema evolution would remain undefined.
- **Let each GUI or SDK define its own queries.** Rejected because it creates
  drift and prevents humans and agents from sharing the same saved object.

## Residual risk

- The logical algebra can grow into an unbounded database project; each slice
  must be justified by observed product questions.
- SQL compatibility can be overstated; the supported dialect and rejected
  syntax must remain explicit.
- Bitemporal and causal semantics may be flattened by convenience APIs unless
  conformance fixtures exercise them.
- Full CEP, unrestricted graph queries, distributed execution, and arbitrary
  federation remain out of scope until the local proof path is mature.
