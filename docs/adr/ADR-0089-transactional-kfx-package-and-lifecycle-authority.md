---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0089
decision_status: accepted
implementation_status: not-started
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: transactional-kfx-package-lifecycle-authority
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0089: KFX packages are immutable content; Core owns transactional lifecycle state

- Status: accepted; implementation not started
- Date: 2026-07-15
- Category: extension lifecycle / package store / recovery
- Parent: [ADR-0088](ADR-0088-core-native-multisurface-kfx-runtime.md)
- Related: [ADR-0040](ADR-0040-runtime-fact-ledger-content-addressed-kv.md),
  [ADR-0053](ADR-0053-self-contained-episode-bundles.md),
  [ADR-0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md),
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
  and [ADR-0087](ADR-0087-versioned-product-runtime-upgrade-control-plane.md)

## Context

An extension directory is not a lifecycle model. Directly extracting over an
existing directory or recursively deleting a package cannot distinguish
installed bytes, workspace policy, admitted activation, a live host instance,
or presentation focus. A crash between those file operations can leave a state
that no client can interpret honestly.

Profile lifecycle already separates plan, apply, receipt, and history in Core.
KFX package lifecycle must use the same authority pattern while preserving a
separate package identity: a Profile Suite may close over several KFX members,
and a non-Profile KFX may still be a service, adapter, or System projection.

## Decision

### 1. Installed package content is immutable and content addressed

Core normalizes a package manifest, verifies every declared member, computes a
canonical package root, and publishes verified bytes to an immutable package
store. Sources such as an npm tarball, local authoring directory, product
bundle, or imported bundle are transport edges; they do not become authority
until Core verifies and admits their exact content.

Publishing uses staging, full verification, and an atomic inventory update.
Partial, malformed, or conflicting content remains quarantined or absent. An
identical root is idempotent. A package id/version collision with different
bytes is a typed conflict, never an overwrite.

### 2. Lifecycle state is explicit

The lifecycle distinguishes at least:

| State | Meaning |
| --- | --- |
| `installed` | verified immutable content is present |
| `enabled` | installation/workspace policy permits consideration |
| `activated` | an activation plan admitted the member and its grants |
| `running` | a fenced host instance is currently live |
| `degraded` | authority is retained but required execution or evidence is unavailable |
| `stopped` | no current host instance is live |
| `removed` | active inventory references are withdrawn; history remains |

GUI/TUI focus, tab selection, and view visibility are presentation state and
never lifecycle truth. `qualified` remains a separate Profile/KFD result and
cannot be inferred from `installed` or `running`.

### 3. Suite closure and member lifecycle are both retained

Core computes the exact closure for a KFX Suite/Profile Suite and binds required
and optional member roots. The Suite lifecycle revision records the closure and
policy that were admitted. Each executable member still has its own host,
capability, and health state.

A required member failure can degrade or refuse Suite activation according to
the contract. An optional member failure cannot silently change the Suite root
or reinterpret persisted Profile facts.

### 4. Every mutation is plan, authorize, apply, receipt

Install, enable, activate, suspend, update, roll back, remove, repair, and
garbage-collect are explicit operations. A plan names exact source roots,
current revision, dependency closure, capability diff, trust assessment,
affected active instances, migration class, rollback target, and retained
history. Apply requires the expected plan root and rechecks all preconditions.

Update installs a new immutable root before changing activation references.
Rollback selects a retained root; it does not reconstruct or rewrite old bytes.
Remove withdraws references and stops eligible instances, but never deletes
Profile facts, Episodes, receipts, or artifacts still referenced by historical
interpretation, rollback, a process, or a lease.

### 5. One fenced writer owns a lifecycle scope

The native KFX service serializes lifecycle mutations for its installation and
workspace scopes. Plans and host instances carry a generation. Stale clients,
duplicate owners, and unknown generations fail closed. Readers may observe
through GUI, TUI, CLI, or agent bindings without becoming writers.

Activation host supervision follows ADR-0080 generation/readiness semantics.
Process liveness is an observation and does not manufacture `activated`, work
completion, or trust.

### 6. Lifecycle facts and payload bytes have different retention

Lifecycle transitions and receipts are durable facts. Package payload bytes may
eventually be collected only through a reference-aware, previewable plan. The
collector owns package-store roots only. Unknown references, paths outside its
root, or unavailable historical interpreter requirements block collection.

## Acceptance gates

- Failure injection at every staging/publish/reference step yields either the
  previous complete state or the new complete state, never a half installation.
- Concurrent GUI/CLI/agent mutations produce one ordered revision history and
  typed stale-plan refusals.
- Update and rollback preserve old facts and old-cut interpretation.
- Removing a view member cannot remove its Profile, QueryDefinition, receipts,
  or facts.
- Reinstalling the same root is idempotent and reproduces the same package and
  Suite closure identities.
- Python and JavaScript package commands contain no authoritative recursive
  delete or in-place replacement path after migration.

## Rejected alternatives

- **Mutable package directories.** Rejected because their identity and crash
  state are ambiguous.
- **One boolean `enabled`.** Rejected because content, policy, admission,
  process health, and presentation are different facts.
- **Delete facts when uninstalling code.** Rejected because executable
  availability cannot rewrite history.
- **Let each surface lock the filesystem independently.** Rejected because a
  filesystem lock alone does not define plans, generations, or receipts.

## Version impact and non-claims

The initial native lifecycle is additive. Existing package layouts may be
imported through an explicit migration/repair plan; they are not silently
declared authoritative. This decision does not define marketplace discovery,
cloud synchronization, or arbitrary native-code sandboxing.
