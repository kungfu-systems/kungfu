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

1. **Mission Home** — intent, stage, progress assessment, active Go work,
   decisions required, drift, and next responsibility.
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

That report now embeds the first `Cost/State/Proof` profile projection. Cost
comes from linked Rewind `CostSnapshot` journal facts, responsibility state is
a conservative mapping of admitted Go source states, and proof carries both the
ADR-0048 roots and verified Rewind Episode roots. Missing or ambiguous cost
attribution remains visible; the profile does not create another spend ledger.
Mission scopes larger than the ADR-0048 256-subject bound are evaluated as a
deterministic set of bounded subqueries and expose a composite definition and
proof root; the runtime does not silently truncate the Mission.

The pre-release Mission Control contract is now v2. It keeps Atlas-imported
Mission/Go facts and adds two native surfaces under the same declared world:
Kungfu-native Go facts and explicit completion claims. A user can create a Go
in the Work Dashboard, while an agent can call the same operations:

```sh
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

The earlier pre-release v1 Mission Control declaration cannot be silently mixed
with v2 because its open-ended declarations did not include native sources or
the completion-claim surface. A v1 data root therefore reports an explicit
migration/re-import requirement. No released format is affected; a durable
migration tool is required before this contract leaves pre-release status.

### Native mode

If Kungfu later becomes authoritative for Mission/Go state, the cutover is an
explicit KFD-1 migration event. Atlas then becomes a projection, index, or
export consumer. Long-lived dual writes with two authorities are forbidden.

## Storage and portability

Workspace state lives under the resolved workspace `.kungfu/`; personal or
machine state uses the resolved runtime home. Journal records, Episodes,
schemas, payloads, saved queries, assessment Episodes, TrustReports, and
observer metadata share that authority.

A full bundle carries the bounded content closure needed for offline replay and
proof. A thin bundle carries declared roots and references and reports missing
material honestly. Copying a GUI cache is never a portability mechanism.

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

This slice does not require a general ontology, unrestricted rule engine,
cloud-only control plane, or full visual query builder.
