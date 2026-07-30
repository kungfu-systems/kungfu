# Kungfu Evolution Map

The Evolution Map is Kungfu's first-party longitudinal entry. It explains how
the system repeatedly converted implementation pressure into a smaller set of
load-bearing abstractions, and how each compression made the next stage
possible. Start here when the current repository cross-section is too wide to
hold in working memory.

The map is deliberately not a second architecture or runtime authority:

- **Era and Stage records** are append-only historical interpretations backed
  by exact public evidence.
- **Era Candidates** are append-only hypothesis revisions. They can accumulate
  evidence, but they never allocate an Era sequence or alter current authority.
- **Current authority references** point into the contracts, architecture,
  code, and qualification surfaces that still own each domain.
- **Xinfa** remains the only semantic graph, impact, selection, and bounded
  context authority.
- **Generated projections** are disposable views that must rebuild byte for
  byte from the registered records.

## Read the map

1. Read the generated [timeline](timeline.md) for the bounded progression.
2. Use [current authority](current-authority.md) to cross from a historical
   compression into the current owning contract.
3. Choose a focused path in [reader routes](reader-routes.md).
4. Review the [Era Candidate ledger](candidates.md) when the current Era thesis
   may no longer explain the work.
5. Open [map.json](map.json) when a tool needs the same projection.

The initial spine covers the v4 restart: the shared polyglot mmap journal,
Rewind and the Fact ledger, sealed Episodes, Profile Suite composition, Project
Cut and Xinfa continuity, native Fact and Action authority, portable Work,
Primitive governance, native Work Control, and recursive first-party dogfood.

## Recommended system-understanding sequence

Use this order when the goal is to understand Kungfu across modules:

1. Read the project [README](../../README.md) for the current product promise.
2. Read the generated [timeline](timeline.md) to establish the longitudinal
   pressures and abstraction compressions.
3. Choose the closest pressure in [reader routes](reader-routes.md) and verify
   its owner in [current authority](current-authority.md).
4. Read the current [System Overview](../concepts/system-overview.md).
5. Enter only the relevant Concepts, Architecture, Profile, contract, and
   source modules.
6. Use ADRs, qualification, and exact evidence when auditing a decision or
   claim.

Do not reverse this order into an exhaustive directory walk unless a
cross-sectional inventory is itself the task. The map supplies orientation;
current contracts and source still supply authority. A bounded task with a
known owner can skip the historical prelude and use its verified Xinfa route
directly.

## Record protocol

An Era groups a sustained abstraction thesis. A Stage is created only when a
pressure has produced a meaningful capability compression or authority
transition; it is not one record per feature. Each Stage carries:

- stable identity, period, status, predecessors, amendment/supersession links;
- pressure, prior limitation, local capability, and the compression itself;
- explicit authority before and after, plus exact current authority refs;
- retired or compatibility surfaces, unlocked capabilities, and downstream
  consumers;
- public PR, commit, ADR, or document evidence; and
- a bounded reader route from historical context to current authority.

The machine contract is
[`evolution-map.contract.json`](evolution-map.contract.json). Era records live
under [`eras/`](eras/) and Stage records under [`stages/`](stages/).

Era Candidate revisions live under `candidates/<candidate-id>/`. Every update
is a new immutable revision chained to the previous content root. The generated
[candidate ledger](candidates.md) exposes the latest status while `map.json`
retains the complete revision chain. Candidate state progresses through
`observed`, `accumulating`, and `review-ready`, then ends as `promoted`,
`folded-back`, or `rejected`. Terminal revisions remain visible.

## Decide what to record

Use the smallest sufficient interpretation:

1. **Do nothing** when the change does not affect the abstraction history.
2. **Extend the current Stage** when new evidence fits its existing pressure,
   compression, and authority boundary.
3. **Open a Stage** when one load-bearing capability compression or authority
   transition is already clear within the current Era thesis.
4. **Open or update an Era Candidate** only when the current Era thesis is
   plausibly insufficient, the same emerging axis compresses more than one
   future Stage, and exact evidence plus counter-evidence can be retained.

A Candidate is deliberately cheap in authority and expensive in evidence. It
does not reserve the next Era number, settle a historical interpretation, or
permit broader execution. Agents may open candidates, append evidence and
counter-evidence, merge duplicates, and mark them `review-ready`. Promotion
requires an explicit maintainer decision or an appropriately scoped Warrant,
plus a linked canonical Era and initial Stage.

## Extend without rewriting history

First request the verified Agent route:

```sh
./shifu docs context --task "extend the Kungfu evolution map" --role implementer --budget 65536 --route kungfu-evolution-map-agent --json
```

Then declare one PR impact: `none`, `extends`, `opens`, `settles`, or
`supersedes`. Evidence can extend the current open Stage. A new Stage requires a
new abstraction compression or authority transition. Once a record exists on
the protected base, do not edit or delete it: add a record with `amends` or
`supersedes` and preserve both interpretations.

Candidate authoring is dry-run first. Prepare a JSON input with `operation`
`open` or `advance`, then inspect the exact file, revision root, and predecessor
root before appending it:

```sh
./shifu evolution:candidate -- --input /path/to/candidate-input.json
./shifu evolution:candidate -- --input /path/to/candidate-input.json --write
```

An opening input supplies `id`, `recordedAt`, `title`, `currentEra`, `thesis`,
`currentEraInsufficiency`, `compressionSignals`, at least two
`downstreamStageHypotheses`, `evidence`, optional `counterEvidence`,
`confidence`, and `reason`. An advance input supplies the candidate `id`, date,
the exact `expectedPreviousRoot`, new `status`, `reason`, and optional evidence,
counter-evidence, confidence, thesis refinements, resolution, or authorization.
Candidate-only PRs normally declare `extends`: observation is not a canonical
Era transition.

Evidence may bind a canonical Kungfu pull request, full commit SHA, repository
ADR/document/contract/qualification path, or an exact Assignment, Fact,
Episode, or Warrant `sha256` content root. Repeating one kind/root pair under a
different label does not create independent evidence.

Regenerate and validate only through Shifu:

```sh
./shifu evolution:map
./shifu evolution:map:check
./shifu docs:check
```

The generator validates identities, sequence and dependency DAGs, evidence
shape, exact local references, authority-transition continuity, PR impact
vocabulary, settled-history immutability, and generated-output drift.
