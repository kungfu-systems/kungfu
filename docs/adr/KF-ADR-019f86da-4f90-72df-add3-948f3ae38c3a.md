---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019f86da-4f90-72df-add3-948f3ae38c3a
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/734, https://github.com/kungfu-systems/kungfu/pull/842, https://github.com/kungfu-systems/kungfu/pull/873, https://github.com/kungfu-systems/kungfu/pull/906, https://github.com/kungfu-systems/kungfu/pull/922, https://github.com/kungfu-systems/kungfu/pull/1137, https://github.com/kungfu-systems/kungfu/pull/1151, https://github.com/kungfu-systems/kungfu/pull/1202, https://github.com/kungfu-systems/kungfu/pull/1704, https://github.com/kungfu-systems/kungfu/pull/1718, https://github.com/kungfu-systems/kungfu/pull/1728, https://github.com/kungfu-systems/kungfu/pull/1744, https://github.com/kungfu-systems/kungfu/pull/1771, https://github.com/kungfu-systems/kungfu/pull/1784, https://github.com/kungfu-systems/kungfu/pull/3140, https://github.com/kungfu-systems/kungfu/pull/3395, https://github.com/kungfu-systems/kungfu/pull/3422]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/1784
qualification_refs: [framework/kfx/tooling/run-identity-neutral-terminal-qualification.mjs, docs/qualification/kfx-identity-neutral-terminal.md, framework/api/tests/kfx-host.test.ts, framework/gui/src/agent-work-lab.test.ts, framework/tui/src/agent-work-lab-view.test.ts, framework/core/src/libkungfu/tests/native_kfx_service_host_tests.cpp, framework/core/src/libkungfu/src/runtime/kfx/native_authority.cpp, framework/core/src/bindings/python/binding/py-runtime.cpp, framework/kfx/evidence/kfd-10/runtime-warrant-adopter.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: surface-neutral-kfx-contributions-thin-bindings
confidence: high
evidence_grade: B
last_reviewed: 2026-08-25
ai_provenance: GPT-5 via Codex on 2026-08-25; based on repository contracts, the exact feature diff, local source qualification, and the protected pull request; installed-product, cross-platform artifact, native Warrant, and public release qualification are not claimed
---

# KF-ADR-019f86da-4f90-72df-add3-948f3ae38c3a: KFX contributes semantics once; GUI, TUI, CLI, and agents project them

- Status: accepted; implemented and terminal-qualified
- Date: 2026-07-15
- Category: extension contract / multi-surface product / bindings
- Parent: [KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e](KF-ADR-019f86da-4f90-7ef4-b28b-ee1fbaf9e62e.md)
- Related: [KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a](KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a.md),
  [KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1](KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1.md),
  [KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md),
  [KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8](KF-ADR-019f86da-4f90-7667-b89e-18b1002e45f8.md),
  [KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1](KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md),
  and [KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708](KF-ADR-019f86da-4f90-79d7-a4b7-044fcf998708.md)

## Context

Moving lifecycle authority into C++ is insufficient if every product surface
still requires a separate business extension. A Profile action implemented for
GUI, another command implemented for CLI, and a third adapter implemented for
agents would recreate semantic duplication above the native runtime.

At the same time, one renderer cannot serve React, Ink, a line-oriented CLI,
and machine-readable agents equally. Surface parity must therefore mean one
semantic contribution and authority, not identical pixels or implementation
languages.

The partial baseline is the existing host-agnostic KFX plan/service facets,
Profile action interfaces, machine-readable CLI/agent entrypoints, and GUI/TUI
host surfaces. They do not yet consume one Core-owned contribution registry,
and binding parity is not yet enforced. This documentation change defines that
remaining contract without implementing it.

PR #906 defines the surface-neutral contribution kinds and native service
operations, then exposes the same contract and validation entrypoints through
Node and Python storage bindings. Binding tests compare both projections with
the native contract. The bindings intentionally retain existing loaders and do
not yet expose a Core-owned contribution registry or enforce cross-surface
plan/receipt parity.

PR #922 adds the Core-owned read-only registry operations for list, inspect,
resolve, plan, and status, with thin Node, Python, API, and CLI projections.
The shared parity corpus binds equivalent manifest and Suite inputs to the same
classification and roots. Authorize/apply/history operations, host placement,
and end-to-end action receipt parity remain subsequent stages.

PR #1137 adds the versioned CLI surface contract and metadata fold over the
live Click tree. It freezes stable identities, canonical paths, ownership,
audience, maturity, visibility, sections, aliases, KFD-3 API links,
mutation/approval policy, schema references, and availability for Core and
declared System/Profile KFX projections. Negative and topology-parity fixtures
fail closed on registry drift. This stage does not activate KFX contributions
or complete the remaining authorize/apply/history and cross-host receipt gates.

PR #1151 qualifies that contract from an extracted CLI archive and a clean
registered Product app. The installed-layout harness isolates HOME, workspace,
and PATH; binds human help and Agent catalog output to the exact catalog,
surface, contract, and registry roots; and exercises compatibility warnings,
KFD-3 linkage, Profile/KFX discovery, offline briefs, and reviewed mutation
plan/receipt execution. This stage proves macOS product assembly without
claiming Linux/Windows qualification, activating unavailable KFX
contributions, or silently promoting a build into `/Applications`.

PR #1202 adds the first qualified TUI consumer of a public Profile query. Its
generic shell renders the Work Control contribution at one, two, or three
columns, while discovery, CLI, TUI, and KFD-3 verification bind the same exact
Suite, member, query-definition, and proof roots.

PR #1704, reconciled from source PR #1624, adds the Core-owned semantic graph
for providers, extension points, contributions, dependencies, trust,
capabilities, and versions. Python and TypeScript host adapters consume the same
native descriptor without rescanning or deciding lifecycle policy. Automated
parity and isolation gates preserve the later Agent Work Lab cutover
as one bounded host migration.

PR #1718 extends that thin projection through the mutation boundary. Python,
CLI, and Node clients submit exact authority inputs and expose Core receipts;
they do not infer authorization from KFD, Product/System identity, or local
metadata. Core alone recomputes the Release Passport admission plan and
requires the purpose-bound Work/Warrant before side effects. Runtime
capability-grant enforcement and the remaining host cutover stay outside this
stage, so implementation remains partial.

PR #1728 carries the same explicit grant and confinement contract through the
native, Python, Node, Control API, GUI, TUI/CLI/Agent projection, and WASM
edges. Clients may present authority roots but cannot infer runtime tier,
admission grade, Product System status, or granted capabilities. Every host
launch matches the current package, Cut, revision, generation, authorization,
and capability-grant roots; integrated adapters remain disabled until a
separate confined path exists. The identity-neutral authority cutover and
recursive terminal dogfood remain later stages, so implementation remains
partial.

PR #1744 enforces one identity-neutral public host contract across those
surfaces, including the GUI session-window edge. No binding may branch on
first-party/System/Product System identity, a fixed package name, a bundled
path, installer origin, or signer to choose trust, friction, host placement,
capabilities, or confinement. Product roles project presentation and
distribution only. Reverse scans cover every public host/control edge, and all
executable manifests declare an explicit least capability set. The recursive
Control Suite dogfood and sole terminal qualification remain later stages, so
implementation remains partial.

The identity-neutral terminal campaign closes surface parity on the exact
public descriptor roots. GUI, TUI, CLI, and Agent preserve one catalog, action,
plan, Work/Warrant, capability, host authorization, Episode, Settlement, CAS,
and receipt identity. Agent Work Lab and every bundled reference KFX use the
same public manifest and host contract as ecosystem packages; no host has a
Product/System allowlist or compatibility mutation path.

PR #3140 keeps that projection boundary thin for leased Runtime Warrants.
Native Core owns issue, heartbeat, revoke, recovery, and settlement, while the
Python service and host dispatcher only carry exact requests and receipts.
Neither a surface nor the KFD-10 witness can infer a lease, widen capabilities,
replace a root, activate an adopter, or publish a release.

PR #3395 extends the thin projection to the public API edge, TUI Node/Python/C++
service host, native WASM host, and Rewind Node/Python adapters. Those hosts
adopt, heartbeat, fence, and settle only the exact Core receipt; they do not
rescan authority, recover a live holder, or collapse capability, Warrant,
Episode, and Settlement roots into a surface-private decision.

## Decision

### 1. Contributions are split into semantic and presentation facets

A KFX package or Suite may declare surface-neutral contributions including:

- commands and intent actions;
- input/output schemas and authorization requirements;
- facts, queries, assessments, reducers, and receipts;
- settings schemas and context predicates;
- diagnostics, recovery actions, and help metadata;
- activation conditions and service/adapter declarations.

It may additionally declare optional presentation facets for GUI, TUI, CLI
formatting, or another host. A Profile's required semantic closure must be able
to activate without a GUI member unless the Profile explicitly declares itself
as a GUI-only experience. Presentation absence produces a typed degraded view,
not missing authority.

### 2. Core owns the contribution registry, not rendering

The native runtime validates and indexes contribution identities, roots,
schemas, activation conditions, required capabilities, and owning package/Suite
roots. It resolves context and returns stable contribution/action plans.

Core does not own React component trees, Ink layout, CSS, terminal width, menu
pixel placement, window tabs/splits, or prose table formatting. Host code
renders a projection and invokes the same registered action.

### 3. Bindings are thin and generated or parity-checked

Node and Python bindings expose native registry, inspect, plan, authorize,
apply, receipt, status, and history operations with language-appropriate types
and asynchronous ergonomics. The CLI, TUI, GUI, and agent SDK build on those
bindings.

Bindings may provide authoring tools, scaffolds, packagers, and local developer
validation. They may not own trust, installation, activation, or an independent
contribution registry. Compatibility aliases call the native operation and
carry a removal boundary.

### 4. Hosts land admitted facets only

Core returns a host-placement plan that binds the exact member root, facet,
runtime tier, grants, generation, and expected host contract. A GUI host may
load a React view, a TUI host may load an Ink view, and a service host may run a
managed process or WASM component. The host reports readiness and health; it
does not reinterpret admission.

Closing a view or restarting a host cannot remove the underlying contribution,
action, query, Profile, or receipt. A host mismatch or missing optional facet
is visible and recoverable.

### 5. KFD-3 parity is mechanically testable

For every declared public action, qualification verifies that human-facing and
agent-facing clients can discover the same schema, plan the same intent,
observe the same required authorization, execute through the same authority,
and inspect the same receipt. GUI convenience may reduce interaction steps; it
cannot create a private mutation.

Profile-level KFD-3 qualification under KF-ADR-019f86da-4f90-712d-b871-24090476e338 binds the exact Profile root.
This ADR additionally requires the underlying KFX runtime and contribution
registry to preserve that parity across GUI, TUI, CLI, and agent clients.

### 6. Headless operation is a release gate

The assembled CLI product can discover and operate semantic contributions
without Electron, DOM, or GUI bundle evaluation. TUI and GUI are independently
complete higher surfaces. A KFX that declares only a custom GUI view may still
be installed, but its non-GUI availability and degraded behavior must be
declared rather than inferred.

## Acceptance gates

- One fixture package contributes an action, setting, query, diagnostic, GUI
  view, and TUI view; every surface reports the same owning roots and action
  receipt.
- Removing GUI and Node from the test environment still permits native/CLI
  inspection, lifecycle management, and semantic action execution where the
  declared host permits it.
- A GUI button, TUI command, CLI command, and agent invocation produce the same
  plan root for equivalent input.
- A missing optional renderer yields a typed degraded projection; it does not
  delete or disable the semantic contribution.
- No host evaluates a bundle that Core did not admit for that exact root,
  generation, facet, and capability set.
- Compatibility aliases contain no independent mutation or trust logic.

Pull request 3422 extends this implemented boundary with a bounded cleanup of
the native KFX authority bridge and Python runtime binding. The binding remains
a projection over the C++ runtime and storage owners; it does not acquire an
independent admission, mutation, or trust decision. Exact-head native, binding,
KFX impact, full source qualification, protected merge, and post-merge source
qualification remain required before this pull request becomes implementation
evidence.

## Consequences

- KFX authors define domain behavior once and add only genuinely different
  presentation facets.
- GUI and TUI remain free to use native interaction patterns without becoming
  separate product authorities.
- Generated/parity-checked bindings and a contribution registry become
  load-bearing compatibility surfaces.
- Some current GUI-only extension contracts must be split into semantic and
  renderer facets before they can qualify as multi-surface KFX.

## Rejected alternatives

- **Require one universal renderer.** Rejected because GUI, TUI, CLI, and agent
  clients have different interaction and accessibility constraints.
- **Implement each surface as a separate extension.** Rejected because it
  duplicates semantics and breaks receipt identity.
- **Keep commands in Core but views in arbitrary loaders.** Rejected because
  the host still needs an admitted, content-bound contribution identity.
- **Make headless support optional for the runtime.** Rejected because Kungfu
  CLI and agent operation are first-class adoption products under KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.

## Version impact and non-claims

The contribution registry and thin-binding contract are additive pre-release
minor surfaces. This decision does not define a no-code UI builder, a universal
layout DSL, or pixel-equivalent GUI/TUI experiences.
