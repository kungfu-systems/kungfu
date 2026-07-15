---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0091
decision_status: accepted
implementation_status: not-started
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: surface-neutral-kfx-contributions-thin-bindings
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0091: KFX contributes semantics once; GUI, TUI, CLI, and agents project them

- Status: accepted; implementation not started
- Date: 2026-07-15
- Category: extension contract / multi-surface product / bindings
- Parent: [ADR-0088](ADR-0088-core-native-multisurface-kfx-runtime.md)
- Related: [ADR-0007](ADR-0007-v4-tui-platform-reference-surface.md),
  [ADR-0011](ADR-0011-v4-capability-sdk-contract.md),
  [ADR-0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md),
  [ADR-0061](ADR-0061-agent-mediated-guidance-is-a-first-class-product-interface.md),
  [ADR-0069](ADR-0069-agent-first-kfx-profile-suite-runtime.md),
  and [ADR-0083](ADR-0083-core-system-kfx-profile-kfx-capability-boundary.md)

## Context

Moving lifecycle authority into C++ is insufficient if every product surface
still requires a separate business extension. A Profile action implemented for
GUI, another command implemented for CLI, and a third adapter implemented for
agents would recreate semantic duplication above the native runtime.

At the same time, one renderer cannot serve React, Ink, a line-oriented CLI,
and machine-readable agents equally. Surface parity must therefore mean one
semantic contribution and authority, not identical pixels or implementation
languages.

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

Profile-level KFD-3 qualification under ADR-0075 binds the exact Profile root.
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
  CLI and agent operation are first-class adoption products under ADR-0049.

## Version impact and non-claims

The contribution registry and thin-binding contract are additive pre-release
minor surfaces. This decision does not define a no-code UI builder, a universal
layout DSL, or pixel-equivalent GUI/TUI experiences.
