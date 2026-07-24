---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/842, https://github.com/kungfu-systems/kungfu/pull/873, https://github.com/kungfu-systems/kungfu/pull/885, https://github.com/kungfu-systems/kungfu/pull/906, https://github.com/kungfu-systems/kungfu/pull/922]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: core-native-multisurface-kfx-runtime
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e: one Core-native KFX runtime serves GUI, TUI, CLI, and agents

- Status: accepted; implementation partial
- Date: 2026-07-15
- Category: extension runtime / Core authority / product layers
- Related: [KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9](KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md),
  [KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md),
  [KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md),
  [KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1](KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md),
  [KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c](KF-ADR-019f86da-4f90-7bc8-a3ed-a7b0a6363d6c.md),
  and [KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708](KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708.md)
- Child decisions: [KF-ADR-019f86da-4f90-73f3-b027-c343b2bc8bcc](KF-ADR-019f86da-4f90-73f3-b027-c343b2bc8bcc.md),
  [KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab](KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab.md), and
  [KF-ADR-019f86da-4f90-72df-add3-948f3ae38c3a](KF-ADR-019f86da-4f90-72df-add3-948f3ae38c3a.md)

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

The partial baseline is the existing Core Profile lifecycle, package discovery,
KFX load planning, and Core/System/Profile boundary. Those parts establish
useful seams but do not yet form the single fenced native authority required by
this decision. This documentation change records the target; it adds no runtime
implementation.

PR #906 advances that partial baseline by freezing native contract version 1,
adding a C++ service interface and dispatcher for inspect/plan/apply/status/
history, and exposing contract negotiation through the existing Core storage
edge. It does not move package discovery or lifecycle mutation authority out of
the existing TypeScript and Python implementations, so the single-writer
runtime and migration acceptance gates remain open.

PR #922 moves bounded manifest discovery, canonical package and Suite closure,
and deterministic read-only registry/load-plan identity into Core. Node,
Python, API, and CLI code project that native result, while shared fixtures
classify parity with the legacy TypeScript and Python paths. Lifecycle mutation,
authorization, fenced writer ownership, and migration off the legacy mutation
paths remain outside this stage.

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

1. KF-ADR-019f86da-4f90-73f3-b027-c343b2bc8bcc defines transactional package storage and lifecycle state.
2. KF-ADR-019f86da-4f90-7d6c-926a-ddd27dbde8ab defines KFD-aware trust and Buildchain-attested admission.
3. KF-ADR-019f86da-4f90-72df-add3-948f3ae38c3a defines surface-neutral contributions and thin binding/host edges.

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
