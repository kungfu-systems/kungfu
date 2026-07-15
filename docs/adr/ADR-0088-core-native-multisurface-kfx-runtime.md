---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0088
decision_status: accepted
implementation_status: not-started
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: core-native-multisurface-kfx-runtime
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0088: one Core-native KFX runtime serves GUI, TUI, CLI, and agents

- Status: accepted; implementation not started
- Date: 2026-07-15
- Category: extension runtime / Core authority / product layers
- Related: [ADR-0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md),
  [ADR-0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md),
  [ADR-0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md),
  [ADR-0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md),
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
  and [ADR-0083](ADR-0083-core-system-kfx-profile-kfx-capability-boundary.md)
- Child decisions: [ADR-0089](ADR-0089-transactional-kfx-package-and-lifecycle-authority.md),
  [ADR-0090](ADR-0090-kfd-aware-kfx-trust-and-buildchain-admission.md), and
  [ADR-0091](ADR-0091-surface-neutral-kfx-contributions-and-thin-bindings.md)

## Context

KFX is not only a desktop-GUI extension mechanism. Kungfu exposes the same
runtime, facts, Profiles, actions, queries, and recovery capabilities through
GUI, TUI, CLI, and agent clients. A KFX package may contribute a Profile,
service, adapter, action, assessor, command, or presentation to more than one
of those surfaces.

The current implementation already points in this direction but divides
authority across languages. C++ owns the storage service and Profile lifecycle
operations. TypeScript owns substantial KFX discovery, trust, and load-plan
decisions. Python CLI code still performs package-directory installation and
removal. GUI code lands renderer bundles. Reusing those implementations from a
second surface is possible, but it does not establish one runtime authority:
two clients can scan different roots, make different trust decisions, or race
while mutating the same installation.

VS Code's Node extension host is optimized around an editor and its desktop
product. Kungfu needs a lower, surface-neutral extension control plane because
headless CLI/TUI operation and agent-mediated operation are first-class product
modes rather than compatibility accessories.

## Decision

### 1. KFX lifecycle authority belongs to Core

Kungfu will provide one Core-native KFX runtime, implemented in C++ above the
journal, content store, capability broker, and runtime host. It owns canonical
manifest normalization, package and Suite identity, dependency closure,
content roots, trust inputs, lifecycle plans, authorization preconditions,
activation placement, receipts, history, and diagnostics.

The runtime is a control-plane subsystem. It does not enter the yijinjing
low-latency fact hot path and must not make ordinary frame publication depend
on extension discovery or package I/O.

### 2. Native means one authority, not merely one shared library

Linking the same C++ functions into GUI, TUI, and CLI processes would remove
language duplication but still permit concurrent writers and divergent live
state. Mutating operations therefore execute through one fenced authority per
installation/data-root scope. Clients may use an in-process implementation
only when they can prove equivalent single-writer ownership.

Plans bind the expected generation, package roots, policy roots, capability
requests, and current lifecycle revision. Apply re-derives the plan and rejects
stale callers. Every successful or refused mutation returns a durable receipt.

### 3. The public contract is language neutral

The authoritative model is a versioned native contract with generated or
mechanically checked C++, Node, Python, and CLI projections. JSON remains a
supported edge representation for agents, diagnostics, and process boundaries;
it is not an independent schema or lifecycle authority.

No binding may rescan package roots, decide trust, mutate installation
directories, or maintain a second enabled/activated state. A binding can
validate edge syntax early, but Core returns the authoritative verdict.

### 4. Execution and presentation remain replaceable hosts

Core decides whether a member is admitted and where it may run. The actual
guest can still execute in a GUI host, TUI host, service process, adapter
process, native host, or WebAssembly host according to its declared facet and
capabilities. React, Ink, terminal formatting, and provider-specific UI remain
outside Core.

Removing every GUI host must leave package identity, lifecycle facts, Profile
facts, actions, receipts, queries, and recovery inspectable through CLI or
another authorized client.

### 5. The authority hierarchy is explicit

This umbrella decision is completed by three narrower decisions:

1. ADR-0089 defines transactional package storage and lifecycle state.
2. ADR-0090 defines KFD-aware trust and Buildchain-attested admission.
3. ADR-0091 defines surface-neutral contributions and thin binding/host edges.

Those decisions may evolve independently, but none may create a language- or
surface-private mutation path around this Core authority.

## Acceptance gates

- One manifest and Suite closure produces the same canonical roots from C++,
  Node, Python, GUI, TUI, CLI, and agent projections.
- The same plan applied from any client produces the same receipt identity or
  the same typed stale/refusal result.
- A headless installed product can inspect, install, activate, suspend, and
  diagnose eligible KFX without Electron or a repository checkout.
- No JavaScript or Python code directly deletes, replaces, or blesses an
  authoritative installed package.
- Multiple clients cannot create two active lifecycle writers for one scope.
- KFX control-plane work does not regress journal publication latency or add
  extension dependencies to the Core fact hot path.

## Consequences

- C++ gains a larger but coherent control-plane responsibility.
- Node and Python become easier to reason about because they project one
  contract instead of implementing policy.
- GUI/TUI/CLI/agent parity becomes an architectural invariant rather than a
  test convention.
- Existing TypeScript and Python paths require staged shadow comparison before
  removal; this is not a big-bang rewrite.

## Rejected alternatives

- **Keep TypeScript as the KFX authority and call it from every surface.**
  Rejected because it makes Node/Electron a prerequisite for the lowest
  extension layer and leaves Python/native clients dependent on a product host.
- **Duplicate lifecycle logic per client.** Rejected because equal schemas do
  not prevent divergent policy, races, or receipts.
- **Move rendering and all guest code into C++.** Rejected because Core owns
  authority, not every implementation language or presentation toolkit.
- **Treat a shared C++ library as sufficient.** Rejected because single-writer
  lifecycle and fenced process ownership are runtime properties.

## Version impact and non-claims

This is an additive pre-release minor architecture. It does not remove current
bindings until parity and migration gates pass. It does not promise a public
marketplace, arbitrary in-process native code safety, distributed consensus,
or a universal GUI framework.
