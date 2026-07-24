---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/926, https://github.com/kungfu-systems/kungfu/pull/1398]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/926
qualification_refs: [crates/xinfa/qualification/context-ir-v1.json, crates/xinfa/qualification/standalone-smoke-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-15
theme: xinfa-dual-first-verified-context-contract
confidence: high
evidence_grade: B
last_reviewed: 2026-07-24
---

# KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7: Xinfa compiles one verified context for humans and Agents

- Status: accepted and implemented
- Date: 2026-07-15
- Category: Context IR / dual-first documentation / KFD-1/2/3
- Related: [KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8](KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8.md),
  [SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82](SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82.md),
  [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md), and
  [KF-ADR-019f86da-4f90-712d-b871-24090476e338](KF-ADR-019f86da-4f90-712d-b871-24090476e338.md)

## Context

For an Agent, carefully organized documentation is primary development input,
not an optional explanation after code. Reading an entire complex repository
destroys context budget; reading a stale guide can be worse because the Agent
acts confidently on a false implementation model. Human readers need a gentle,
progressive route through the same project and must not be sent to a separate,
less current truth source.

SHIFU-ADR-019f86da-4f90-7015-bdde-ae4cc649ed82 already separates document role from verification mode and gives
projects a conformance envelope. It intentionally does not own a semantic graph,
impact analysis, or context compiler. KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8 assigns those authorities to
Xinfa but its bootstrap language described only an Agent consumer. Treating the
human rendering as optional would violate the product requirement: one verified
authority must support both readers without forcing identical presentation.

## Decision

### 1. One authority graph, two first-class projections

Xinfa is **The Verified Context Compiler for Human-Agent Software Development**.
`xinfa.project/v1` compiles to `xinfa.context-ir/v1`. A human route and an Agent
route may have different entrypoints, prose density, ordering, selection budget,
and expansion handles, but routes in the same parity group must bind:

- the same project cut;
- the same selected authority node set;
- the same node identity, revision, provenance, and verification status;
- the same evidence and invalidation semantics; and
- therefore the same `authorityRoot`.

This is capability parity, not byte equality. Human progressive disclosure is
measured in bounded navigation hops; Agent task context is measured in bounded
tokens and expansion hops. Later Pack and Capsule formats consume this IR rather
than creating another graph.

### 2. V1 nodes and relations are intentionally small

V1 nodes are `document`, `subject`, `claim`, `invariant`, `decision`,
`implementation`, `probe`, and `evidence`. Every node has a stable id, SHA-256
revision, visibility, exact provider/path, and provenance kind. Relations are
limited to `defines`, `explains`, `constrains`, `decides`, `implements`,
`proves`, `depends-on`, `supersedes`, and `expands-to`.

The project declares exact provider paths. Globs, path traversal, undeclared
provider acquisition, visibility broadening, duplicate identity, unknown fields,
unknown versions, and graph cycles fail closed with stable diagnostics. The
compiler never scans prose and silently promotes sentences into claims.

### 3. Document role and verification truth remain orthogonal

Document presentation role is not a proof level. A README may be expressive and
`non-claim`; a guide or ADR may contain load-bearing claims. V1 verification
modes are `machine`, `human`, `mixed`, and `non-claim`. Their current positive
states are `machine-proved`, `human-reviewed`, `mixed`, and `non-claim`, with
explicit `waived`, `stale`, and `invalidated` states.

A node lists exact dependencies and the revision it was verified against. If a
declared implementation, probe, evidence, or upstream claim changes, affected
claims, explanatory documents, and routes become `stale`. A missing or
invalidated dependency makes them `invalidated`. Changing expressive
`non-claim` content does not imply implementation drift.

The compiler derives current state at the declared cut. It does not decide that
a claim fits a real-world purpose, execute probes, or invent human approval.

### 4. KFD responsibilities are executable

- **KFD-1:** project, cut, provider, node, route, revision, provenance, and
  compiled roots have stable identity.
- **KFD-2:** verification is cut-aware and falsifiable; declared dependency
  drift propagates and cannot remain silently current.
- **KFD-3:** humans and Agents receive equivalent inspect, status, evidence,
  route, and expansion authority over the same root and cut.

Positive and negative fixtures must falsify each statement. A KFD-3 claim is
not earned merely because both audiences have a command: route parity and
derived status must agree.

### 5. Shifu is a producer and Gate adapter, not the compiler

`shifu.documentation-project/v1` remains Shifu's conformance submission.
A thin producer adapter may resolve its document and verification profiles into
explicit Xinfa nodes, providers, and paired routes. That mapping must submit a
complete `xinfa.project/v1` object through the public Xinfa CLI and retain the
Xinfa roots. It may not fork canonicalization, status propagation, Context IR,
or human/Agent parity semantics.

A Shifu validation receipt proves only Shifu protocol conformance. A Xinfa
validation receipt proves only project-protocol and graph conformance. Probe
execution and qualification stay behind Shifu Gate and retained evidence.

### 6. Canonical and compatibility rules

V1 rejects unknown fields. Identity-bearing arrays are sorted by id, route and
provider member arrays are sorted lexically, edges are sorted by their typed
triple, object keys use deterministic order, and roots use SHA-256 over UTF-8
canonical JSON with a trailing newline. Repeated canonicalization is byte- and
root-stable.

New optional fields may enter v1 only when absence preserves current roots and
meaning. New required fields, changed canonicalization, broadened visibility,
new status meaning, or weakened route parity require v2. V1 does not promise
compatibility with pre-release experimental inputs that never matched the
published schema.

### 7. Standalone dependencies remain bounded

Reliable JSON handling and SHA-256 use checksum-locked public Rust registry
crates on a closed boundary allowlist. `path`, `git`, private registry,
host-product, and monorepo-relative dependencies remain forbidden. The clean
extraction smoke copies the schemas and fixtures, builds with `--locked`, runs
the complete tests, and exercises the public CLI without Kungfu or Shifu
runtime state.

## Public surface

```text
xinfa schema project|context-ir
xinfa validate --project FILE|- --json
xinfa canonicalize --project FILE|- --json
xinfa compile --project FILE|- --json
```

`validate` is diagnostic-only: its receipt is never self-certified or
qualifying. `canonicalize` and `compile` fail closed and emit the same stable
diagnostic receipt on invalid input.

## Consequences

- A project can organize Week/Day, Task/Job/Action, Mission/Go, or another
  domain without adding those concepts to Xinfa core.
- Human documentation quality and Agent context efficiency can improve
  independently while truth roots stay shared.
- Explicit dependency declarations cost authoring effort, but make drift and
  private-data leakage testable instead of heuristic.
- Shifu and later Kungfu adapters stay thin; neither becomes a second context
  compiler.

## Acceptance gates

- Two non-isomorphic projects validate and compile without core changes.
- Canonicalization is byte-stable; unknown version and fields fail closed.
- Implementation/evidence revision drift makes the dependent claim, document,
  and both routes stale; a non-claim revision change does not.
- Human and Agent routes in one parity group share authority root and state.
- Cycle, private visibility leak, undeclared provider path, and route mismatch
  fixtures emit stable diagnostic codes.
- Clean extraction builds and tests with no private or host-product dependency.

## Non-claims

This decision does not implement repository traversal, prose claim extraction,
task ranking, vector search, Pack/Capsule selection, GUI rendering, or Shifu and
Kungfu adapters. It does not certify real-world purpose or execute evidence.

## Version impact

Register the pre-release additive `xinfa-project-protocol` and
`xinfa-context-ir` surfaces. No stable line is opened. Future incompatible
canonical or semantic changes require an explicit pre-release version decision.
