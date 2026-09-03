---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/962, https://github.com/kungfu-systems/kungfu/pull/1165, https://github.com/kungfu-systems/kungfu/pull/3650, https://github.com/kungfu-systems/kungfu/pull/3665, https://github.com/kungfu-systems/kungfu/pull/3690]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/962
qualification_refs: [framework/project-cut/fixtures/golden/project-cut-v1.json, framework/project-cut/fixtures/negative/cases-v1.json, framework/project-cut/src/settlement.mjs, framework/project-cut/publication.mjs, framework/format/project-cut-canonical-json.mjs, framework/layout.manifest.json, scripts/check-project-cut-settlement.test.mjs, scripts/check-project-cut-publication.test.mjs, scripts/check-native-loop-qualification.test.mjs, scripts/check-framework-layout.test.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-15
theme: project-cut-v1-canonical-root-source-projection
confidence: high
evidence_grade: B
last_reviewed: 2026-09-03
ai_provenance: GPT-5 via Codex on 2026-09-02 and 2026-09-03 added the source-boundary, canonical-JSON extraction, stable-entrypoint import-convergence, and publication-boundary implementation evidence from the user-authorized framework public-boundary Assignments; protected merge, exact protected-head qualification, and native Assignment seal for pull request 3690 are not yet claimed
---

# KF-ADR-019f86da-4f90-7410-a3fc-f9cdeb55d2be: Project Cut v1 uses a closed canonical root input and an explicit source projection

- Status: accepted; implementation implemented
- Date: 2026-07-15
- Category: cross-product protocol / canonicalization / source projection
- Related: [KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9](KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9.md),
  [KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f](KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f.md),
  and [KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623](KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623.md)

## Context

KF-ADR-019f86da-4f90-77d5-a9ce-e7c798e3a623 establishes that a Project Cut binds independently authoritative Git
material, Xinfa Atlas state, and Kungfu Episode change without becoming a fact
engine or referring to its containing Git commit. That boundary is not yet
machine-executable until field spelling, canonicalization, source projection,
receipt identities, and failures are versioned.

Using a whole Git tree would recreate the hash cycle because the tree contains
the Project Cut being calculated. Broadly excluding `.xinfa` or `.kungfu` would
avoid the cycle by hiding legitimate authority input. Reusing an existing Atlas
or Episode root algorithm would silently reinterpret an identity that owns a
different semantic object.

## Decision

### 1. `project.cut/v1` is a closed binding object

The schema binds project identity, explicit semantic parent cuts, a source
projection and policy root, one Atlas and compiler root, an explicit empty or
non-empty Episode delta, interpretation roots, visibility, omissions,
conflicts, unknowns, compatibility relations, and `cutRoot`. Unknown fields and
unknown versions fail closed.

Provider-native Episode roots remain separate from an optional semantic root.
A semantic root and its equivalence-profile root must appear together. An
`equal` compatibility verdict without a profile is invalid.

### 2. The semantic preimage is `project.cut.root-input/v1`

`cutRoot` uses `sha256-project-cut-canonical-json-v1`: lowercase SHA-256 over
canonical UTF-8 JSON without a trailing newline, after projecting the exact
root-input fields, omitting `cutRoot`, and replacing the outer schema tag with
`project.cut.root-input/v1`. Publication, receipt, unknown fields, and
containing Git OID fields are not members of the projection and therefore
cannot enter the preimage. Exact artifact bytes use a separate digest.

Canonical JSON orders object keys by UTF-8 bytes, preserves array order, accepts
valid NFC Unicode scalar strings, and accepts non-negative safe integers. Every
set-like array is required to be UTF-8-byte sorted and unique. Implementations
reject non-canonical order, text, path, number, and null placement rather than
normalizing an ambiguous object after the fact.

Breaking any of these rules requires a new Project Cut protocol version.

### 3. Source material has its own declared projection root

`project.source-projection/v1` inventories NFC POSIX-relative paths, kind,
visibility, byte digest, and size, plus explicit omissions. Its root commits to
the exact `project.source-projection-policy/v1` root.

The policy may include tracked `.xinfa` and `.kungfu` authority inputs. It must
exclude Git internals; Xinfa stores, baselines, indexes, caches, generated
output, and temporary state; Kungfu runtime, locks, caches, and projections;
private raw payload prefixes; and `.kungfu/project-cuts`, where protocol output
may be published. This precise exclusion avoids self-feedback without turning
authority directories into blanket omissions.

Committed and staged source projections read Git blobs in deterministic,
size-aware batches. The implementation must not impose a fixed aggregate
repository-size ceiling: a single batch remains bounded while every admitted
regular file still contributes its exact byte digest and size.

### 4. Semantic, serialization, artifact, and receipt identities differ

`cutRoot` identifies the semantic binding. `serializationRoot` identifies the
canonical complete Project Cut. `artifactDigest` identifies exact inspected
bytes, so pretty printing can change it without changing the semantic or
serialization root. `receiptRoot` identifies a non-self-certifying verification
receipt. A publication coordinate is deliberately `null` in v1 receipts; a
successor publication receipt may bind a Git OID after the commit exists.

### 5. Stable diagnostics are part of the contract

The verifier fails visibly on missing roots, unknown versions or fields,
privacy denial, generated feedback, provider drift, unavailable semantic
parents, cycles, root drift, unqualified equivalence, schema/protocol drift,
non-canonical order/text/path/number input, and receipt mismatch. Git ancestry
is not consulted when resolving semantic parents.

## Falsification and acceptance gates

- Reordering object fields leaves all semantic and serialization roots stable.
- Non-NFC text, backslash/absolute/dot-segment paths, floats, negative numbers,
  negative zero, unordered sets, and duplicate entries are rejected.
- Adding a containing Git OID is an unknown field and cannot produce a valid
  Project Cut.
- `.kungfu/project-cuts` and declared private prefixes cannot enter a source
  projection, while declared `.xinfa` and `.kungfu` authority files can.
- Parent availability, provider evidence, schema root, protocol root, Project
  Cut root, exact artifact bytes, and receipt root can drift independently and
  produce distinct diagnostics.
- JSON schemas, the schema-bundle root, protocol root, golden roots, and all
  named negative fixtures are recomputed in the build-free source gate.

## Consequences

- Provider and settlement stages receive one stable, zero-dependency semantic
  contract instead of inventing their own canonicalizers.
- The protocol is stricter than ordinary JSON and requires producers to sort
  declared sets before settlement. That cost buys cross-platform replay without
  locale or implicit-normalization ambiguity.
- A Project Cut can be published by multiple Git commits without changing its
  semantic identity, while exact artifact-byte changes remain observable.

## 2026-09-02 source-boundary implementation evidence

Pull request 3650 supersedes pull request 3645 and moves the canonical JSON
implementation behind the shared
`framework/format` source boundary so Evidence and Project Cut no longer form a
source dependency cycle. Project Cut remains the protocol owner: the extracted
helper preserves the frozen canonical JSON algorithm, and existing golden-root,
receipt, settlement, and explicit before/after compatibility checks continue to
require byte-identical results. The framework layout manifest and its fail-closed
validator additionally prevent new private deep imports or accidental npm
package ownership. This is implementation evidence for the existing decision,
not a new Project Cut version or a new public package contract.

Pull request 3665 proposes the first stable-entrypoint import-convergence wave:
44 exact cross-directory consumers move from `framework/project-cut/src/project-cut.mjs`
to `framework/project-cut/index.mjs`, while the retained private-import ratchet
contracts from 56 to 12. The remaining 12 imports are deliberate internal or
deferred consumers in settlement, composition, publication, history,
native-loop qualification, and receipt evidence. The change does not alter the
Project Cut export set, protocol schemas, root algorithms, or runtime behavior;
the framework layout ratchet and existing Project Cut source gates qualify that
boundary-only claim. Until the pull request is protected-merged and qualified
at the protected head, this paragraph records proposed delivery evidence only.

## 2026-09-03 publication-boundary implementation evidence

Pull request 3690 proposes a stable source-only publication facade at
`framework/project-cut/publication.mjs` with exactly eight publication
operations. Two external consumers move off the private Project Cut
implementation, and the publication-related deep-import ratchet contracts from
five to three retained internal or deferred consumers. Schema constants,
root/status helpers, bounds, and implementation details remain private. The
framework layout gate, publication contract and behavior tests, native-loop
qualification, and full source acceptance qualify this boundary-only claim;
protocol schemas, root algorithms, and publication behavior remain unchanged.
Until the pull request is protected-merged and qualified at the protected head,
this paragraph records proposed delivery evidence only.

Pull request 3689 was superseded before merge after its immutable submission
head proved incomplete for the required ADR delivery evidence. Pull request
3690 carries the corrected successor head and is the authoritative delivery
candidate for this boundary stage.

## Non-claims

This decision does not walk Git, create a Project Cut file, write a hook, seal
or qualify an Episode provider, compile Xinfa, move Mission/Go authority, or
claim a release. Optional JSON Schema validation may be unavailable in a
dependency-free stage-0 checkout; the built-in semantic and root verifier
remains authoritative for this protocol implementation.

## Version impact

Add and freeze the pre-release `project.cut/v1`,
`project.source-projection/v1`, and receipt contracts. Existing Git, Xinfa
Atlas, Context Pack, and Kungfu Episode roots are referenced without changing
their meaning. No alpha or stable release line opens.
