---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0132
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [crates/xinfa/qualification/repository-onboarding-v1.json, crates/xinfa/fixtures/onboarding/ecosystem-corpus-v1.json, crates/xinfa/schema/repository-inventory-v1.schema.json, crates/xinfa/schema/onboarding-candidate-v1.schema.json, crates/xinfa/schema/onboarding-selection-v1.schema.json, crates/xinfa/schema/onboarding-acceptance-v1.schema.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: xinfa-generic-repository-onboarding-authority-transition
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
ai_provenance: GPT-5 via Codex on 2026-07-21; based on the accepted Xinfa compiler boundary, repository fixtures, Project Cut context, and user-authorized implementation; no claim about unobserved repositories or future heuristic adapters
---

# ADR-0132: Xinfa onboards unknown repositories through evidence, non-authoritative proposals, and an explicit authority transition

- Status: accepted; implementation and local qualification are staged pending
  independent review and merge
- Date: 2026-07-21
- Category: Xinfa / repository discovery / authority transition / safe initialization
- Related: [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md),
  [ADR-0126](ADR-0126-xinfa-trunk-linked-rust-component.md), and
  [ADR-0128](ADR-0128-xinfa-wasm-engine-and-native-minting-boundary.md)

## Context

The Xinfa compiler can compile any repository that already supplies a valid
`xinfa.project/v1`, but it previously had no authority-safe path for producing
the first declaration. The Shifu documentation inventory is an exact,
project-specific adapter and cannot stand in for a general unknown-repository
protocol. Automatically treating a manifest, README, first route, or inferred
owner as authority would contradict Xinfa's project/compiler separation.

## Decision

### 1. Onboarding is a five-stage protocol

`discover` records Git-tracked evidence and explicit exclusions; `candidate`
turns that inventory into bounded proposals; `explain` projects the observed
facts, inferences, alternatives, omissions, conflicts, and human decisions;
`accept` performs the sole authority transition; the ordinary Atlas compiler
then consumes the accepted `xinfa.project/v1`.

Inventory, candidate, and explanation objects carry `authoritative=false`.
They cannot be used as provider, route, completion, or content-truth evidence.

### 2. Discovery is static, tracked, bounded, and non-executing

The native and Node hosts use read-only Git plumbing to enumerate the exact
index, HEAD/tree identity when present, tracked modes, dirty state, and bounded
untracked/ignored names. They do not execute hooks, builds, package managers,
plugins, language servers, or repository binaries. The compiler core classifies
only injected paths, bytes, modes, and metadata.

Sensitive paths, `.xinfa` control-plane data, generated/vendor trees,
symlinks, gitlinks, conflicts, non-UTF-8/binary data, oversized files, invalid
paths, and bounded overflow are excluded with machine-readable reasons. Secret
content is never read to explain an exclusion.

### 3. Candidate generation may propose but never decide

Static versioned rules may propose exact source units, node kinds, provider
membership, parity-route membership, and non-claim verification. Each proposal
binds its supporting tracked evidence and states the remaining decision.
Unknowns, conflicts, omitted candidates, and empty candidate sets remain valid
outcomes. Confidence never becomes authorization.

### 4. Selection is the authority-bearing human input

A reviewer supplies a versioned selection that binds the exact candidate root,
accepted proposal ids, project identity, visibility, Human/Agent entrypoints,
route-resolution intent, and existing-project policy. Partial acceptance is an
exact subset. There is no first-match, ambient owner, or implicit route fallback.

An existing `.xinfa/project.json` can change only when the selection declares
`replace=true` and its `expectedRoot` matches the exact current project. This is
a constrained replacement, not a lossy merge of unknown project fields.

### 5. Acceptance is freshness-checked and compile-before-write

`accept` defaults to dry-run. It re-runs discovery with the candidate's exact
policy, rejects repository or candidate drift, validates the generated project,
compiles and verifies an Atlas in memory, and only then may publish
`.xinfa/project.json` by an atomic same-directory rename. Failures leave no
partial control-plane file. The receipt binds inventory, candidate, selection,
repository, project, and Atlas roots while stating that reviewer identity does
not prove source truth.

### 6. Host capabilities do not fork semantics

Native and WebAssembly execution share discovery, candidate, explanation,
selection, project construction, compile, and receipt functions. Hosts own Git
and filesystem acquisition plus atomic publication only. The WebAssembly host
injects a bounded repository snapshot and cannot access the filesystem from the
compiler core.

## Falsification and qualification

This decision is false if discovery executes repository code or reads excluded
secret content; identical repository evidence and policy produce different
roots; a candidate can become authority without an exact selection; stale or
conflicting input writes a project; native and WebAssembly receipts differ; an
existing declaration is overwritten without an exact prior root; or an
accepted project fails the ordinary Atlas compiler or verifier.

The retained corpus covers Rust/Cargo, Node, Python, CMake/C++, Go,
documentation-only, and polyglot monorepo shapes. Adversarial cases cover
sensitive, generated/vendor, `.xinfa`, symlink, binary, oversized, conflicted,
and untracked inputs. Rust and documentation-only fixtures independently
complete candidate, selection, compile, and verify; the native transaction test
proves dry-run, stale rejection, atomic new-file publication, and cleanup.

## Consequences

- A new repository can reach a reviewable Xinfa declaration without hand-writing
  the complete low-level project graph.
- Governance remains explicit; broader heuristic coverage increases proposals,
  not authority.
- Git is a required host capability for v1 discovery. Archive-only and remote
  discovery adapters remain future versioned inputs.
- Rich semantic bindings, dynamic ecosystem plugins, network enrichment, and
  LLM approval are outside this decision.

## Version impact

This is an additive pre-release minor surface: it adds public CLI operations and
versioned `xinfa.repository-*` schemas without changing `xinfa.project/v1`,
Context IR, Pack, Atlas, route, projection, or Episode byte semantics. The named
Atlas schema-set subset and all retained Atlas/Pack roots remain unchanged; the
complete published schema-set root intentionally advances.
