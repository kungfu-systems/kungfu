# ADR-0059: Mission Control composes Mission and Go responsibility over runtime facts

- Status: accepted; initial Atlas Mission/Go admission implemented; query and
  assessment slices staged
- Date: 2026-07-11
- Category: architecture — product domain and authority composition
- Subsystem: Mission Control, Atlas adapter, runtime facts, Fact Manager,
  Episode, query, assessment, GUI, CLI/API, and commercial profiles
- Related: ADR-0033 defines Episode; ADR-0048 defines proof-carrying runtime-fact
  queries; ADR-0051 defines declaration and fact admission; ADR-0052 defines
  durable KFD-2 assessment; ADR-0053 defines self-contained Episode bundles.

## Context

Kungfu already has the local mechanisms needed to preserve and inspect agent
work: action facts, sealed Episodes, content-addressed material, declared fact
admission, historical queries with proof, saved views, and durable trust
assessment. The product also has a read-only Atlas adapter that imports Mission,
goal, and worktree-marker snapshots into sealed Episodes and shows their latest
projection in the Work Dashboard.

These mechanisms do not yet share one product-level responsibility model. A
run can expose cost, state, and proof without stating which long-running human
intent it advances. An imported Atlas goal can appear in a dashboard without
being admitted into a declared Mission/Go fact world or assessed through the
same query and trust path. Treating the dashboard projection as the solution
would promote adapter-specific JSON and latest-state rows into authority.

The missing decision is how Mission, delegated work, runtime action, proof, and
human/agent decisions compose without creating another storage, query, or trust
system.

## Decision

Kungfu Mission Control will be the product composition above the domain-neutral
runtime. It introduces a small Mission/Go responsibility domain whose state is
derived from admitted runtime facts and whose trust claims use ADR-0048 and
ADR-0052.

```text
Mission
  -> Go
  -> run / Episode
  -> claim
  -> proof-carrying query
  -> purpose-bound assessment
  -> decision and next responsibility
```

Kungfu Episodes Cost/State/Proof is the first commercial profile of this model,
not a separate product authority.

### 1. Mission is a durable intention context

A Mission has stable identity and an append-only history of declaration,
clarification, constraints, stage changes, pauses, decisions, and supersession.
It may begin incomplete. Its current state is a fold at a declared cut, not one
mutable row whose latest text rewrites prior intent.

The human remains authority for value, direction, and high-consequence
priorities. An assessor may evaluate whether facts support reasonable progress
under declared criteria; it cannot determine whether the Mission is valuable.

### 2. Go is a bounded delegated responsibility

A Go binds a Mission to an objective, executor, authority boundary, expected
evidence, completion claim, and assessment purpose. It is not identical to a
process, terminal session, Git branch, task row, or Episode.

A Go may span several runs and Episodes. Runs and artifacts remain independently
addressable evidence. Agent self-report is an admitted or diagnostic source
claim, never sufficient authority for its own completion assessment.

### 3. Stable identity joins the product layers

The first domain contract preserves stable coordinates across:

```text
mission -> go -> run -> episode -> claim -> query -> assessment -> decision
```

Relationships may be many-to-many where reality requires it. The public model
must not force one false containment tree. Every relationship carries source,
system time, valid time where applicable, causal reference, and declaration
coordinates.

### 4. Current state uses the existing truth path

Mission/Go observations are recorded and admitted under ADR-0051 declarations.
Current, historical, and differential state uses ADR-0048:

```text
FactState(contract_world, scope, perspective, cut, policy)
```

GUI cards, cost summaries, work boards, and attention rows are projections over
that result. They do not own state. Missing declarations, ranges, payloads,
causality, or freshness remain visible in proof and degraded presentation.

### 5. Progress and completion are purpose-bound claims

The initial claim families are:

```text
mission-progress-is-reasonable
task-completed
handoff-ready
```

Each assessment pins a purpose, claim identity, declarations, cut or sealed
root, QueryDefinition/result lineage, policy version, and residual risk.
`continue-delegation`, `stage-review`, `handoff`, and `release` may require
different evidence from the same Go.

Assessment outcomes are versioned and non-boolean. A new fact makes an older
report stale or creates a successor; it does not mutate the old report.

### 6. Atlas starts in bridge mode

Atlas remains authoritative for the Mission registry, goal cards, and markers
that Kungfu imports during dogfood. Kungfu records source coordinates, content
hashes, capture ranges, observer metadata, and sealed import Episodes. It may
admit, query, and assess the imported claims, but it must not silently write
back or describe the adapter projection as native Mission authority.

The existing Atlas importer and Work Dashboard are reused. The next slice adds
declared Mission/Go fact admission, an ADR-0048 query, and an ADR-0052 assessment
over the imported evidence rather than creating a second adapter.

If authority later moves to Kungfu, the transition is an explicit KFD-1
migration/cutover event. Atlas then becomes a projection or export consumer.
Long-lived dual writes with two canonical Mission/Go authorities are rejected.

### 7. Cost/State/Proof is a profile

The first commercial profile packages a declared set of fact surfaces, source
and attribution policies, saved queries, assessment policies, ViewSpecs, KFX
selection, onboarding, and qualification evidence.

Cost never appears without responsibility state and evidence links. State is a
fold, not an agent-controlled label. Proof binds the visible result to observer,
cut, declarations, Episodes, lineage, missing evidence, and assessment
freshness.

The profile may start from a run before the user declares a Mission. Attaching
that run to a later Go reuses its identity and evidence; it does not migrate to
a different data model.

### 8. Human and agent surfaces are peers

The GUI and installed CLI/API operate the same Mission/Go commands,
QueryDefinitions, and assessment requests. The GUI uses progressive disclosure
from state to TrustReport, proof, Episode, and raw observation. Agents use
self-describing intent-level operations and receipts. Neither surface gains a
private authority.

## Implementation sequence

1. Publish the Mission Control and Cost/State/Proof product contracts.
2. Define the bounded Mission/Go fact surfaces and stable relationship
   coordinates without adding a general ontology engine.
3. Map the existing Atlas import envelopes into the declared fact world while
   preserving Atlas bridge authority and diagnostic raw observations.
4. Add one proof-carrying Mission/Go state query at head and one exact cut.
   **Implemented:** ADR-0048 now accepts the domain-neutral `fact-state` object,
   bounded `subject_keys`, and exact `system_time` cuts over the admission
   journal.
5. Add one deterministic completion or reasonable-progress assessor and expose
   its TrustReport through CLI and Work Dashboard progressive disclosure.
   **Implemented for reasonable progress:** the saved Mission Control profile
   persists an ADR-0052 assessment and maps its state to an explicit
   purpose-bound fitness view without treating Atlas self-report as universal
   truth.
6. Qualify the full path in a temporary data root, then expand GUI authoring and
   portable Mission bundles only from observed dogfood needs.

Step 3's initial slice is implemented: every explicit Atlas import still seals
its source snapshot Episode first, then idempotently admits present Mission and
Go cards into the shared Fact Library under the `kungfu.mission-control` world.
The admitted payload binds the Atlas source id/path/time, repository head,
content hash, import id, and sealed Episode root. Admission failure cannot
rewrite or abort the already sealed import and is returned as an explicit
degraded receipt. Steps 4 and 5 now form the first executable trust slice;
completion and handoff policies remain later profiles requiring stronger
independent evidence.

## Acceptance gates

- The same imported Atlas source records and pinned declarations reproduce the
  same Mission/Go state and proof.
- Updating or reimporting Atlas cannot retroactively reinterpret an older cut.
- The latest Work Dashboard projection can be deleted and rebuilt without
  losing Mission/Go authority or assessment lineage.
- A completion self-report remains distinguishable from a trusted-for-purpose
  completion assessment.
- Cost, state, and proof share stable run/Go coordinates and disclose weak or
  ambiguous attribution.
- GUI and CLI/API return equivalent Mission/Go state, cut, and TrustReport
  identities.
- Missing, conflicting, stale, redacted, or unverifiable evidence cannot render
  an unqualified successful state.
- All initial dogfood writes use isolated temporary data roots and do not modify
  a user's existing `.kungfu` or runtime home.

## Consequences

- Kungfu gains a coherent product above its existing runtime mechanisms without
  making the domain-neutral core understand Atlas files or one provider.
- The market can lead with cost management while retaining Mission-level
  responsibility as the real capability.
- Atlas dogfood becomes implementation evidence instead of an unrelated control
  plane example.
- Mission/Go declarations, reducers, queries, assessors, and views add a bounded
  maintenance surface. Their growth must be justified by real product questions.

## Alternatives considered

- **Make Cost/State/Proof a standalone spend dashboard.** Rejected because cost
  without responsibility and proof cannot establish useful progress.
- **Treat Atlas JSON cards or the latest dashboard projection as native truth.**
  Rejected because adapter snapshots and rebuildable projections cannot own
  Mission semantics.
- **Model Mission and Go as single mutable database rows.** Rejected because
  clarification, correction, historical intent, and trust would drift.
- **Run KFD-2 after every agent event.** Rejected by ADR-0052; assessments are
  claim-triggered at material boundaries.
- **Create a universal ontology or arbitrary workflow engine first.** Rejected
  because the first Atlas dogfood only needs a bounded responsibility domain.
- **Keep Atlas and Kungfu as permanent dual authorities.** Rejected because
  conflict and replay semantics would become undefined.

## Residual risk

- Mission semantics can expand without bound. Only fields and relations needed
  by executable admission, query, assessment, or a proved user workflow belong
  in the first contract.
- Imported source claims may be internally consistent while not matching
  external reality. Kungfu can prove declaration, capture, admission, and
  derivation, not universal truth.
- A compelling dashboard can hide weak evidence. Every summary must retain a
  direct proof and degraded-state path.
