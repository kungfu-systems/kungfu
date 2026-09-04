# Project Cut Product Loop Qualification

This is the v4 product gate for the Project Cut-centered loop accepted by
[KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173](../adr/KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173.md). It defines
what must be demonstrated before Kungfu may claim that ordinary users and
agents can manage real project work through Project Cuts.

The current Project Cut protocol, Mission/Go authority cutover, Fact/Episode
runtime, and Agent Work contracts are prerequisites. None independently proves
this product loop.

## Release claim

A conforming v4 product lets a user install Kungfu in a clean project and
complete this loop through public interfaces:

```text
inspect current Project Cut
-> accept bounded Assignment in a continuing Initiative
-> execute with exact Atlas and Warrant roots
-> preserve admitted Episode evidence
-> submit and independently assess a completion Claim
-> settle the next Project Cut explicitly
-> continue from that exact cut in a fresh agent context
```

The release claim is false if a maintainer must repair hidden state, edit an
internal JSON file, reconstruct context from chat, or use a private API.

## Required scenarios

### 1. Clean-project first minute

- Install a supported CLI artifact in a clean environment.
- Run `kungfu cut` in a project with no `.kungfu` data root.
- Observe `absent` plus an actionable explicit bootstrap route.
- Prove that the command did not create files, start a writer, or mutate Git.
- Bootstrap only after an explicit user or agent action, then obtain a
  verifiable initial Project Cut.

### 2. Exact cut-to-cut work

- Start from a verified current Project Cut.
- Accept an Assignment bound to exact Initiative/Pursuit, Atlas, Warrant, and
  current-cut roots.
- Record execution in one or more admitted Episodes.
- Produce a completion Claim and an independent Assessment/Decision.
- Prepare the same candidate twice and obtain identical semantic roots with no
  mutation in dry-run mode.
- Settle only the exact verified candidate and prove the successor relation.

### 3. Context and agent replacement

- Terminate the original chat, process, and agent adapter after settlement.
- Remove rebuildable caches and projections.
- Start a supported fresh agent context from the settled cut.
- Recover the accepted project state, active Initiative/Assignment relations,
  Atlas basis, authority boundaries, causal evidence, known omissions, and
  next valid actions without relying on the prior transcript.

### 4. Independent verification and portability

- Export a complete bundle and a declared thin bundle.
- Verify both on a clean runtime using only public contracts and declared
  providers.
- Import the complete bundle exactly and reproduce the same current Project
  Cut and required roots.
- Report every unavailable thin-bundle dependency and residual risk without
  upgrading it to verified.

### 5. Cross-surface parity

For the same cut and policy, CLI, TUI, GUI, and agent interfaces must expose
the same:

- current/candidate roots and health state;
- active Initiative and Assignment identities;
- blocking problems and residual risks;
- allowed next actions and authority requirements; and
- operation and settlement receipt roots.

Presentation may differ. Semantic status, authority, and proof may not.

### 6. Third-party Domain Profile

- Run the complete loop with one built-in software profile and one independently
  maintained third-party profile.
- Prove that the third-party profile supplies only declared extension contracts
  and requires no product-core source change.
- Retain the exact profile identity, artifact digest, admission receipts, and
  scenario evidence for both runs.
- Reject a profile that widens authority, bypasses the shared Work model, or
  requires a surface-only path.

## Required negative cases

The gate fails closed when any of these occur:

- source, Atlas, Episode, Assignment, Warrant, policy, or current-cut drift;
- an unavailable body or provider required by the candidate;
- a Claim without independent Assessment or an Assessment over different
  roots;
- a successful process exit or sealed Episode presented as completion;
- insufficient, expired, revoked, or widened Warrant authority;
- conflicting candidate successors or unresolved omissions;
- canonical-root, serialization, artifact, receipt, or publication mismatch;
- an interrupted preparation presented as settlement;
- a GUI, TUI, CLI, or agent-only authority path; or
- a read-only command that creates or mutates project state.

Every failure reports the exact observed roots, unmet contract, authority that
can resolve it, and safe next action. Unknown is not success.

## Concept-budget gate

The first useful loop must be understandable with three visible concepts:

```text
current Project Cut
work in progress
next Project Cut
```

Initiative and Assignment appear when work spans responsibility or time.
Fact, Episode, Pursuit, Atlas, Warrant, Claim, Assessment, and Decision remain
available for inspection and debugging but are not mandatory peer controls for
the simple path.

Qualification must test both limits:

- the simple path does not require manual management of the lower objects; and
- the expanded path exposes enough exact information to diagnose and resolve a
  consequential or degraded case without hidden maintainer knowledge.

## Evidence contract

The machine-readable contract is
[`project-cut-product-loop.release-contract.json`](../../framework/work/work-loop/project-cut-product-loop.release-contract.json).
It freezes the target Gate id as `product.project-cut-loop`, the complete case
inventory, cross-platform and cross-surface scope, third-party profile proof,
and fail-closed admission rules. A verifier rejects incomplete reports,
self-review, source/passport drift, unknowns, and residual risks.

The eventual release Gate must bind:

- exact source commit and Buildchain release passport;
- platform artifact digests and clean-install coordinates;
- machine-readable scenario and negative-case reports;
- Project Cut, Initiative, Assignment, Atlas, Warrant, Episode, Claim,
  Assessment, Decision, and operation receipt roots used in each scenario;
- filesystem and Git before/after evidence for read-only operations;
- clean-runtime continuation and independent verification reports; and
- cross-surface parity fixtures.

The executable runner is available as:

```sh
./shifu project-cut-loop:qualify -- \
  --evidence product/release/qualification/project-cut-product-loop.json \
  --passport product/release/qualification/buildchain.release.json \
  --json
```

It derives the exact source commit from the clean tracked checkout, hashes and
opens the supplied Buildchain passport, verifies its source and platform
artifact bindings, applies the complete evidence contract, and emits
digest-bound Shifu evidence when invoked by a Gate executor. It does not create
or repair campaign evidence.

This document and the contract still do not register the target Gate or claim
current release evidence. `product.project-cut-loop` remains `pending` until a
retained three-platform campaign supplies real measurements and the Gate
catalog change can be reviewed without weakening its closed-world policy.
Synthetic verifier tests are contract tests only and are never qualification
evidence.

## Current status

**Product loop incomplete.** The repository now provides the fail-closed
release evidence runner in addition to the read-only
`kungfu cut` product entrypoint, a high-level Work read/recovery facade,
plan-only completion/settlement, managed-run Work binding, and one shared
CLI/Agent capability manifest. The manifest truthfully reports GUI/TUI,
executable begin/settlement, portability, and Domain Profile projection as
unavailable or degraded. Native Initiative/Assignment orchestration and the
complete retained cross-platform evidence defined here remain prerequisites
for Gate registration and a qualified release claim.
