---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0096
decision_status: accepted
implementation_status: unknown
qualification_refs: [xinfa/qualification/task-chart-v1.json, xinfa/qualification/standalone-smoke-v1.json, xinfa/fixtures/golden/projection-scenarios-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-15
theme: xinfa-bounded-projection-task-chart
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0096: Xinfa compiles bounded Human, Task Chart, and GUI projections from one Atlas

- Status: accepted; implementation evidence pending the delivery PR
- Date: 2026-07-15
- Category: derived projection / task selection / generated ownership
- Related: [ADR-0093](ADR-0093-xinfa-dual-first-verified-context-contract.md),
  [ADR-0094](ADR-0094-xinfa-repository-context-pack.md), and
  [ADR-0095](ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md)

## Context

ADR-0095 establishes one immutable, cut-bound Xinfa Atlas and ships basic
audience-filtered `xinfa.atlas-view/v1` files. Those files prove common object
identity but do not yet solve bounded reading or task selection. A user still
needs progressive navigation, an Agent still needs exact source payloads within
a token budget, and a GUI still needs summary/detail relationships and stable
expansion handles.

Implementing three independent knowledge models would immediately recreate the
drift that the Atlas primitive removes. Treating generated summaries as provider
input would be worse: compilation could reinforce its own output and make a
derived statement appear authoritative without a new source cut.

## Decision

### 1. Task Chart is the canonical bounded Agent object

`xinfa.task-chart/v1` is the canonical name for a disposable task/role/route/
budget selection. `xinfa chart create` and `xinfa context` produce identical
bytes for identical arguments; Context is the consumption surface, not a second
protocol or authority object.

Selection is deterministic and limited to a declared Agent route. Lexical
matching may order seeds inside that route, but it cannot broaden visibility,
change status, select another cut, or replace declared dependency closure.
Dependencies are emitted before their dependents. Selected units carry exact
source payloads, verification state, source roots, and `why_included`.

The v1 token accounting rule is `utf8-bytes-ceil-div-4-v1`. It is a stable,
provider-neutral budget measure, not a claim about one model tokenizer. If the
budget cannot carry required authority, the Chart returns `degraded`, explicit
required omissions, estimated cost, and expansion handles. Silent truncation is
not a valid complete result.

### 2. Human and GUI projections are bounded views of the same route facts

`xinfa.human-view/v1` chooses an intent-aware landing inside a declared Human
route and follows declared relationships up to `max_hops`.
`xinfa.gui-view/v1` exposes the same bounded selection as node summaries plus
detail relationships. Disconnected, non-selected route components remain
explicit optional omissions rather than disappearing.

Human, Task Chart, and GUI bytes may differ, but each contains an identical
parity vocabulary: Atlas root, cut root, visibility, parity group, route status,
authority root, evidence, Atlas omissions, and source roots. Search relevance
cannot override any field in that block.

### 3. Expansion is stable and cut-preserving

Every omitted node receives a content-addressed expansion handle bound to the
Atlas root, cut root, route root, projection policy root, node, and omission
reason. `xinfa expand` verifies the predecessor projection and handle, selects
the target dependency closure within an additional token budget, and emits a
successor projection with a predecessor root.

Expansion fails if the supplied Atlas root or cut differs. A changed Atlas must
produce an explicitly recompiled successor view; expansion never silently
crosses cuts.

### 4. Generated materialization is owned derived data

Projection recipes are versioned under `.xinfa/projection-recipes/`. The default
materialization prefix is `.xinfa/generated/`. Projection envelopes declare
`derived=true`, provider exclusion, no human-prose overwrite, and a promotion
contract that forbids same-cut promotion.

The Context Pack compiler rejects `.xinfa/generated/**` even when an exact-file
provider explicitly names it. Acceptance means moving or editing content into a
managed source path, declaring a new source cut, and compiling a successor
Atlas. Ordinary projection commands only print JSON and do not modify tracked
`.xinfa` files.

### 5. Atlas and Pack roots remain unchanged

The bounded schemas and compilers are additive consumers of a verified Atlas.
They do not enter the existing Atlas schema-root calculation or Atlas directory
manifest. The checked-in `xinfa.atlas/v1` and `xinfa.context-pack/v1` golden
roots therefore remain byte-for-byte unchanged.

## Consequences

- Humans, CLI Agents, and GUI consumers can optimize presentation without
  forking authority.
- Route declarations remain load-bearing; v1 deliberately does not use
  embeddings or arbitrary repository search to choose current truth.
- The token measure is portable and deterministic but only approximate for a
  specific provider tokenizer.
- Disconnected route components expose a useful authoring signal without making
  unrelated optional content fail an otherwise complete bounded task.
- Native CAS, incremental compilation, model-answer quality, and automatic
  acceptance remain outside this decision.

## Acceptance gates

- Architecture location, small code change, review, and incident diagnosis
  golden tasks pin projection roots, hops, token counts, selected nodes, and
  required omissions.
- A deliberately insufficient budget returns degraded status, required
  omissions, and stable expansion handles.
- Human, Task Chart, and GUI projections match Atlas/cut/status/authority/
  evidence/omission semantics for their parity group.
- Projection verification detects byte tampering and divergence from a verified
  Atlas.
- Expansion preserves root/cut and rejects a successor Atlas unless the view is
  explicitly recompiled.
- Provider acquisition rejects `.xinfa/generated/**`; ordinary projection CLI
  use creates no tracked project state.
- Standalone extraction builds and exercises read/chart/context/verify/expand
  without Kungfu or Shifu runtime dependencies.

## Version impact

Register additive pre-release `xinfa.human-view/v1`, `xinfa.task-chart/v1`,
`xinfa.gui-view/v1`, projection policy/recipe/handle/verification surfaces, and
the read/chart/context/expand CLI on Xinfa `0.1.0`. Existing Atlas and Context
Pack roots and semantics remain unchanged. No Kungfu alpha or stable line is
opened by this decision.
