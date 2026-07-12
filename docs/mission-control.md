---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
doc_type: product-design
review_state: unreviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-12
theme: kungfu-mission-control
confidence: high
evidence_grade: B
last_reviewed: 2026-07-12
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-12
  unavailable_details: exact model checkpoint and hidden runtime parameters
---

# Kungfu Mission Control

Kungfu Mission Control is the local-first responsibility layer that connects a
person's long-running intent to delegated agent work, runtime facts, proof, and
purpose-bound trust decisions.

Its user promise is:

```text
What are we trying to achieve?
What actually happened?
What does the evidence establish at this cut?
Is the delegated work still fit for the purpose that matters?
Who should continue, adjust, stop, approve, or supply evidence next?
```

Kungfu Episodes and the Cost/State/Proof experience are the first commercial
profile of this capability. They provide a low-friction market entry without
creating a second product model.

## The product stack

```text
Kungfu Episodes: Cost / State / Proof
  market-entry profile for delegated agent work

Kungfu Mission Control
  Mission / Go / responsibility / drift / assessment / decision

Kungfu runtime
  Fact Manager / admission / Episode / query / TrustReport / timeline
```

Cost is therefore not an isolated spend meter. It is useful only when bound to
the work responsible for the cost, the current state of that work, the evidence
for claimed progress, and the Mission that gives the work value.

## Domain objects

### Mission

A Mission is a durable intention context. It may begin incomplete and become
more precise as reality supplies new facts. It has stable identity, a declared
owner, an initial intent, values and constraints, a horizon, and an append-only
history of clarification, stage changes, pauses, supersession, and decisions.

A Mission is not one mutable fact row. Its current state is a fold over admitted
facts at a declared cut. Clarifying a Mission creates a new fact; it does not
rewrite what the participant declared earlier.

### Go

A Go is a bounded delegated responsibility inside a Mission. It carries an
objective, executor, expected evidence, authority boundary, completion claim,
and assessment purpose. A Go can be proposed, accepted, active, blocked,
waiting for a decision, claimed complete, assessed, closed, or reopened.

A Go is not equivalent to one process, shell session, Git branch, or Episode.
Those are execution coordinates and evidence. One Go may contain several runs
and Episodes, and one Episode may produce evidence used by more than one claim.

### Episode, claim, assessment, and decision

- An **Episode** preserves a causal segment of actual work.
- A **claim** states what a participant says the work establishes, such as
  `task-completed` or `mission-progress-is-reasonable`.
- An **assessment** evaluates one claim for one purpose over pinned facts and
  proof. Agent self-report is evidence, not self-authorizing truth.
- A **decision** records the human or authorized agent response: continue,
  adjust, stop, approve, request evidence, hand off, archive, or reopen.

Stable identity links the chain:

```text
mission -> go -> run -> episode -> claim -> query -> assessment -> decision
```

The links are not required to form one strict tree. They form a bounded causal
and responsibility graph whose roots and cuts remain inspectable.

## How the KFD foundation applies

| Foundation | Mission Control responsibility |
| --- | --- |
| KFD-1 | Pin the Mission/Go fact world, schemas, source authority, identity, compatibility, and migration boundary so facts do not drift. |
| KFD-2 | Bind progress, completion, handoff, and resource claims to inspectable facts, proof, responsibility, residual risk, and purpose. |
| KFD-3 | Give people and agents first-class GUI and CLI/API participation over the same facts, choices, constraints, and receipts. |
| KFD-4 | Declare the observer, accepted sources and ranges, projection policy, causal constraints, and degraded state of every mixed-source timeline. |

[ADR-0051](../framework/core/docs/adr/ADR-0051-kfd-contract-world-fact-admission-and-trust.md)
connects declarations to admission. [ADR-0048](../framework/core/docs/adr/ADR-0048-runtime-fact-query-semantics-and-changelog.md)
reconstructs current or historical state under an explicit basis.
[ADR-0052](../framework/core/docs/adr/ADR-0052-kfd2-assessment-lifecycle-and-executors.md)
turns load-bearing claims into durable assessment jobs and TrustReports.

## The operating loop

```text
declare or clarify a Mission
  -> create or accept a Go
  -> record agent and human Episodes
  -> admit observations under pinned declarations
  -> query Mission/Go state at a declared cut
  -> assess a claim for a purpose
  -> decide and record the next responsibility
  -> repeat without rewriting history
```

The standard Mission progress claim is
`mission-progress-is-reasonable`. It is never meaningful without a purpose,
such as `continue-delegation`, `allocate-more-resources`, `stage-review`, or
`public-commitment`.

An assessment may return fit, warning, insufficient evidence, conflicted,
stale, unverifiable, or failed. It must expose the supporting facts, drifting
or blocked Go work, missing evidence, current responsibility, and suggested
decision surface. It cannot decide whether a person's Mission is valuable;
it evaluates declared criteria against available facts.

## Human and agent surfaces

The GUI follows progressive disclosure:

1. **Mission Home** — the five-question workspace home: intent, material events,
   evidence at the selected cut, purpose-bound fitness, and next responsibility.
   Mission/Go creation lives in compact top-bar actions and modal/drawer flows,
   not expanded forms on the default canvas. The complete workspace product
   behavior is defined in
   [Mission Control Workspace Product Design](mission-control-workspaces.md).
2. **Go Board** — delegated work grouped by responsibility state, not a generic
   kanban status string.
3. **Observer Timeline** — accepted sources, cut/frontier, causal order,
   policy order, missing ranges, and replay.
4. **Fact Manager** — reusable fact types, material, source authority,
   corrections, retractions, conflicts, and portable bundles.
5. **Trust Inspector** — state -> TrustReport -> query proof -> Episode -> raw
   observation.

The installed CLI/API exposes intent-level operations for agents. A person may
ask an agent to create or clarify a Mission, open a Go, add material, request an
assessment, or close work without hand-authoring low-level declarations. GUI
and agent surfaces consume the same domain objects, QueryDefinitions, and
assessment contracts; no GUI-private database owns Mission state.

Agent-mediated use is a first-class product path, not an integration added
after GUI design. Kungfu owns typed inspection, evidence-backed advice, impact
preview, authorization, execution, receipt, and verification semantics. The
agent explains the options and may execute an authorized intent; its prose
cannot create facts or expand authority. A minimal direct GUI remains available
for the same decisions and recovery path. This product principle is fixed by
[ADR-0061](../framework/core/docs/adr/ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md).

A first-time user does not need an Atlas-style Markdown repository or a fully
formed Mission. **Start managing agent work** selects the logical Home Workspace
at `~/.kungfu`; its first managed run lazily initializes the
fact world and appears in an unassigned Agent Work Inbox. Kungfu can establish
exact attribution only for managed or explicitly integrated runs. Imported
external traces remain observed or ambiguous, and purpose-bound fitness stays
insufficient until the work is attached to a declared purpose.

## Authority and Atlas dogfood

Kungfu already ships a read-only Atlas import profile. It records content-
addressed Mission, goal, and marker snapshots in a sealed Episode and presents
the latest completed import through the Work Dashboard. This is the correct
bridge baseline, but it is not yet the complete Mission Control truth path.

### Bridge mode

During dogfood, Atlas remains authoritative for imported Mission/Go cards and
worktree records. Kungfu records observations with source coordinates, hashes,
capture boundaries, and import Episodes. It may query and assess those facts,
but it does not silently write them back to Atlas.

The initial bridge connects each explicit import to declared Mission/Go fact
admission after the source snapshot Episode is sealed. The first trust slice
now runs the same ADR-0048 `fact-state` QueryDefinition at head or an exact
system-time cut, then persists an ADR-0052 `mission-progress-is-reasonable`
assessment. `kungfu atlas assess-mission` and the Work Dashboard consume the
same report identity and proof root.

The TrustReport also resolves five versioned `kungfu.mission-control` saved
views over that same QueryDefinition. Their ViewSpec selects one of the five
Mission Home questions; `kungfu.mission-control.reducer/v1` owns the
purpose-bound answer and never moves query semantics into React. The resolved
views are journal-backed in the selected workspace Saved Query Catalog, so an
agent can inspect, run, export, or fork them with `kungfu query saved ...` and
the GUI can manage the same revisions. Rows, proof, and resume tokens remain
rebuildable runtime state rather than portable authority.

The visual Go-card field adds a versioned
`kungfu.mission-control.goal-card-query/v1` presentation query to that same
saved-view artifact. It can combine text, lifecycle, KFD-2 state, actor, track,
role, importance, stage, update window, hierarchy, and closed-work filters, then
sort parent-child clusters by decision priority, freshness, importance, trust
risk, next actor, lifecycle, or name. A matching child retains its parent
context, while child risk still promotes the cluster. The query changes which
already-proved Go rows are shown; it does not change the QueryDefinition cut,
KFD-2 result, or proof. GUI changes are saved in the selected workspace
catalog, and agents use the existing `kungfu query saved import|update|export`
surface to operate the same view without rebuilding Kungfu.

Mission Home now resumes the fact-state changelog with stable logical fact
keys and a system-time frontier. A correction to one source claim is therefore
an upsert of that claim, not a retract plus an unrelated identity. The desktop
refresh bus advances the stream and re-runs the purpose-bound assessment so
newly admitted Mission/Go subjects are discovered. A stream `Gap`, schema
failure, or interrupted resume remains visible and falls back to the bounded
assessment snapshot; it does not blank the renderer or silently claim live
freshness.

That report now embeds the first `Cost/State/Proof` profile projection. Cost
comes from linked Rewind `CostSnapshot` journal facts, responsibility state is
a conservative mapping of admitted Go source states, and proof carries both the
ADR-0048 roots and verified Rewind Episode roots. Missing or ambiguous cost
attribution remains visible; the profile does not create another spend ledger.
Mission scopes larger than the ADR-0048 256-subject bound are evaluated as a
deterministic set of bounded subqueries and expose a composite definition and
proof root; the runtime does not silently truncate the Mission.

The pre-release Mission Control contract is now v3. It keeps Atlas-imported
Mission/Go facts and admits explicitly sourced Kungfu-native Mission and Go
facts plus completion claims under the same declared world. A user can author
them in the Work Dashboard, while an agent can call the same operations:

```sh
kungfu atlas create-mission <mission-id> \
  --title <title> --intent <intent> --actor <actor> --json
kungfu atlas create-go <mission-id> <goal-id> \
  --title <title> --objective <objective> --actor <actor> --json
kungfu atlas claim-completion <mission-id> <goal-id> \
  --statement <claim> --actor <actor> --evidence-episode <id> --json
kungfu atlas assess-completion <mission-id> <goal-id> --json
```

These operations do not write back to Atlas. The imported Mission remains an
Atlas-authority fact; the new Go and claim identify `kungfu-user` or
`kungfu-agent` as their source authority. A completion claim without a
frame-verified, sealed work Episode remains visible but fails closed as
insufficient. The GUI and CLI return the same assessment key and composite
proof root.

The earlier pre-release v1/v2 Mission Control declarations cannot be silently
mixed with v3 because their authority sets differ. Those data roots therefore
report an explicit migration/re-import requirement. No released format is
affected; this boundary must become a durable migration before stable release.

### Native mode

If Kungfu later becomes authoritative for Mission/Go state, the cutover is an
explicit KFD-1 migration event. Atlas then becomes a projection, index, or
export consumer. Long-lived dual writes with two authorities are forbidden.

## Storage and portability

Project workspace state lives under its resolved `<project>/.kungfu/`; the
Home Workspace lives at `~/.kungfu`. Machine fallback and
`~/.kungfu-config` remain separate service/config homes. Journal records,
Episodes, schemas, payloads, saved queries, assessment Episodes, TrustReports,
and observer metadata belong to the selected fact-world authority.

Desktop remembers the last selected workspace under `KF_CONFIG_HOME`, but that
registry is only global GUI session state. Opening a directory remains
read-only; `.kungfu` initializes on the first operation that changes the
workspace fact world. [ADR-0060](../framework/core/docs/adr/ADR-0060-desktop-workspace-selection-and-lazy-data-home.md)
defines the lifecycle and prevents recent-workspace convenience from becoming
Mission authority.

A full bundle carries the bounded content closure needed for offline replay and
proof. A thin bundle carries declared roots and references and reports missing
material honestly. Copying a GUI cache is never a portability mechanism.

The first portable contract is `kungfu.mission-control.bundle/v1`. It composes
the existing self-contained Episode bundles for declarations, Mission/Go/claim
facts, linked cost/work evidence, and assessment, then pins the expected Mission
query definition, proof, result, and Cost/State/Proof profile identities:

```sh
kungfu atlas export-mission <mission-id> \
  --out <mission.kfmission.json> --mode full --json
kungfu atlas export-mission <mission-id> \
  --out <mission.thin.kfmission.json> --mode thin --json
kungfu atlas import-mission --from <mission.kfmission.json> --json
kungfu atlas import-mission --from <mission.kfmission.json> --execute --json
```

Validation is the default. `--execute` materializes only a full closure, in
journal-time order, and accepts it only if the fresh data root reproduces all
three Mission state roots. A thin bundle always remains a degraded reference
with a diagnosis that a full bundle is required. Rewind run discovery uses the
restored Episode source, so cost facts survive transfer without copying the
old runtime directory or GUI projection.

## Current maturity

The individual mechanisms exist today: Atlas snapshot import and projection,
sealed Episodes, domain fact declaration/admission, Fact Manager, historical
proof-carrying queries, saved views and changelogs, and durable KFD-2
assessments. Atlas Mission and Go snapshots now enter the shared Fact Library
under an explicit bridge authority while retaining their source coordinates and
sealed import root. Mission Control is the product composition that connects
these mechanisms into proof-backed progress and decision workflows.

The first implementation target is intentionally narrow:

1. import one real Atlas Mission and at least one linked Go;
2. admit the pinned Mission/Go facts without changing Atlas authority
   (**implemented**);
3. query current state with observer, cut, declaration roots, and proof
   (**implemented for bounded Mission/Go subject sets**);
4. assess one reasonable-progress claim for a declared purpose
   (**implemented**);
5. show the result through the existing Work Dashboard/Trust progression
   (**implemented**);
6. run entirely in an isolated temporary data root (**implemented**).
7. create a native Mission and move its Mission/Go/cost/claim/proof closure to
   a fresh data root (**implemented for full and thin local bundles**).

This slice does not require a general ontology, unrestricted rule engine,
cloud-only control plane, or full visual query builder.
