---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1817]
qualification_refs: [framework/core/tests/python/test_release_cut.py, framework/core/tests/python/test_distribution_release_cut.py, framework/core/tests/python/test_release_channel.py, product/scripts/upgrade-manifest.test.mjs, product/scripts/release-channel-index.test.mjs, product/scripts/bootstrap-installer.test.mjs, crates/shifu/src/native_update.rs, crates/shifu/src/promote.rs, crates/shifu/src/registrar.rs, scripts/kfd-support-matrix.test.mjs]
review_state: self-reviewed
sensitivity: public
last_reviewed: 2026-07-29
period: 2026-07
theme: product-release-cut-updater
sources: [local-files, user-consensus]
confidence: high
evidence_grade: A
ai_provenance: GPT-5 via Codex on 2026-07-29; based on the admitted Assignment, repository contracts, implementation, and local qualification; exact model build, hidden checkpoint, public release operation, and unobserved platform execution are not claimed
---

# KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239: Product Release Cut is the exact updater identity

- Status: accepted and staged in PR #1817; public publication remains separately authorized
- Date: 2026-07-29

## Context

Kungfu already had signed channel discovery, immutable runtime/frontend images,
side-by-side archive installation, Shifu local-build registration, and rollback
coordinates. Their identities did not close over the same product world.
SemVer remained too weak to distinguish two qualified builds with the same
label, while a manifest or desktop artifact root covered only one slice. Shifu
could select a desktop build but was at risk of becoming a second installer for
the CLI, and cache-resident source artifacts could be mistaken for rollback
authority.

The product needs one exact identity that covers source settlement, semantic
assembly, compatibility and migration contracts, every platform slice,
qualification/signing evidence, omissions, waivers, and publication policy. It
also needs an explicit movement object so a same-SemVer successor, divergence,
recovery, or unknown relation cannot be inferred from timestamps, Git order, or
the version label.

## Decision

`kungfu.product-release-cut/v1` is the exact immutable identity of one product
release world. `productVersion` remains a human-facing compatibility and
ordering label; it is not product identity. Each Cut binds sorted parent Cut
roots and one or more exact platform slices. A platform slice binds the
cut-independent manifest identity, artifact root, qualification roots, and
signing roots. Public and `shifu-local` trust domains are disjoint, and local
Cuts are structurally publication-ineligible.

`kungfu.product-release-cut-transition/v1` is the only authority for movement
between different Cuts. It binds the from/to Cut roots and versions, relation,
trust-domain-specific authorization, compatibility verdict, migration and
rollback plans, active-work policy, evidence, and diagnostics. Equal SemVer
with unequal Cut roots is a conflict unless a public signed supersession or
explicit local successor transition authorizes it. Diverged and unknown
relations never advance implicitly. Recovery requires an explicit recovery
transition.

The final release manifest and signed channel carry the Cut and platform-slice
roots. Public channel admission assembles all admitted macOS, Linux, and
Windows slices into one shared Product Release Cut before signing; a signed
channel with divergent per-platform Cuts fails closed. The archive-bundled
manifest carries a cut-independent identity, while the external signed
manifest binds the archive digest and final cross-platform Cut, avoiding an
impossible self-hash. Bootstrap receipts, installed image records, selection
records, update plans, and rollback receipts preserve those roots. Runtime
images may be reused when their own immutable runtime identity is unchanged;
the selected frontend image still carries the exact current Cut.

KFD-3 registers the desktop artifact, CLI archive, and final upgrade manifest
in one Shifu provenance slot. `shifu promote` remains the local selector and
desktop adapter. It performs a native-updater dry run and hands the exact
manifest/archive/evidence roots to the shipped `kungfu` updater. Native Core
alone installs and selects side-by-side CLI images and owns rollback. The
installed inventory, not Shifu source cache availability, is rollback
authority. Shifu preflights the native transition, retains a pending
transaction coordinate, places the desktop surface, and only then asks the
native updater to commit CLI selection. A desktop failure therefore cannot
advance native authority; a later native failure remains safely retryable from
the still-current installed receipt. Native selection retains the full Cut
Transition evidence, and the Shifu receipt binds the native receipt root.

The first adoption of a legacy local installation uses one explicit,
publication-ineligible bootstrap transition from the standardized legacy
sentinel root. This does not claim an exact historical Cut for pre-contract
bytes; it records the boundary where exact Cut identity begins.

## Consequences

Benefits:

- two builds with one SemVer remain distinguishable and independently
  installable;
- public publication and local dogfood cannot share authority accidentally;
- every update and rollback has a content-addressed explanation;
- Shifu selection no longer duplicates native installation semantics; and
- retained installed images can roll back after source archives and build
  caches are removed.

Costs:

- manifests and channel entries carry additional roots and must agree exactly;
- first local adoption must name the legacy bootstrap boundary;
- release tooling must produce a transition for same-SemVer supersession; and
- desktop promotion and native CLI selection remain two visible adapters, with
  a durable retry coordinate rather than a false atomic cross-platform
  filesystem claim.

This decision is falsified if an accepted path can select a different Cut
without a verified transition, publish a `shifu-local` Cut, roll back only
while source cache survives, or make Shifu itself the CLI installation
authority.
