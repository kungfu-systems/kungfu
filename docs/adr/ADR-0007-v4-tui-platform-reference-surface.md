---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0007
decision_status: accepted
implementation_status: not-started
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0007: v4 TUI = the platform's second reference surface (shell-native, zero-copy, React/Ink)

- Status: accepted (decision 2026-06-29: Ink / React stack). Implementation pending; coexistence
  risk is low — the pure-Node in-process `require` of the binding has no renderer constraint
  (unlike ADR-0006) and is already exercised today.
- Date: 2026-06-29
- Category: (architecture) repositioning — `framework/tui` blessed TUI → modern terminal reference surface
- Subsystem: frontend — `framework/tui` (reference TUI), consuming `framework/api` (capability SDK)
- Related: parallels ADR-0006, which covered the GUI half only. Same platform/SDK model and the
  same in-process zero-copy N-API moat constraint. This ADR covers the TUI half ADR-0006 left open.

## Decision

Reposition the terminal surface from a hand-maintained quant-trading CLI to **the second minimal
reference surface of the v4 platform**. The GUI (Electron, ADR-0006) and the TUI (shell) are two
thin reference UIs over the **same** capability SDK: core provides capability, both surfaces only
demonstrate it.

1. **Two reference surfaces, one capability SDK.** The TUI consumes the same framework-neutral
   capability SDK (`framework/api`) as the GUI — typed, zero-copy access to journal / state /
   replay. A non-DOM consumer is the cleanest proof that the SDK is genuinely framework-agnostic
   (ADR-0006 §4).

2. **Shell-native, in-process, zero-copy by default — for free.** The TUI is a plain Node process
   and `require`s the `kungfu_node.node` binding directly in-process. There is no renderer / IPC
   boundary, so the zero-copy moat needs none of the GUI's `nodeIntegration` /
   `contextIsolation` handling (ADR-0006 §7). The terminal is therefore the lowest-friction
   moat-faithful surface.

3. **Stack convergence with the GUI: React via Ink.** ADR-0006 standardized the reference GUI on
   React + TS + biome. Adopt **Ink (React for the terminal)** for the reference TUI so both
   surfaces share one component model, mental model, and contributor skill set, and retire the
   legacy `blessed` stack (unmaintained). TS and biome tooling are shared.

4. **Minimal and consumer-driven; defer the TUI kfx contract.** Following ADR-0006 §3 and its
   anti-speculative discipline, v1 of the TUI is a reference surface only. The loose kfx
   contribution contract may later extend to terminal contribution points, but **only when a real
   consumer needs it** — not designed up front.

5. **Boundary: runtime CLI vs reference TUI.** `kfc` (and its planned product-grade successor
   `kungfu`, the reserved end-user shell entry) is the **runtime command surface**. The reference
   TUI is an **interactive terminal application** launched on top of that surface — kept distinct
   from `kfc` / `kungfu`, exactly as the reference GUI app is distinct from the runtime CLI.

6. **Drop legacy.** The existing blessed quant-terminal TUI is a reference built-in, not the
   point, and is not ported wholesale (mirrors ADR-0006 §8 for the Vue GUI).

## Context

ADR-0006 repositioned the frontend to "platform/SDK + one minimal reference app", but covered
only the Electron GUI. The product model needs **two** reference surfaces: a GUI and a
shell-native TUI. The TUI is not a nice-to-have — it is (a) the cheapest proof that the capability
SDK is surface-agnostic (terminal, not DOM), (b) the natural surface for headless / remote /
server-side / automation / developer use the GUI cannot serve, and (c) zero-copy-native with no
Electron constraints.

Current state (`dev/v4/v4.0`): `framework/tui` (`@kungfu-tech/tui`) is a `blessed` +
`inquirer` + `commander` terminal app over `@kungfu-tech/api`. `blessed` is
legacy / unmaintained, and the code carries the v3 quant-terminal model.

## Alternatives considered

- **Keep `blessed`** — rejected: unmaintained, and diverges from the GUI's React stack (two
  component models to maintain for one maintainer).
- **A TUI-specific API instead of the shared capability SDK** — rejected: it would fork the SDK
  surface and weaken the "framework-neutral capability SDK" guarantee. The TUI must consume the
  same `framework/api`.
- **Design the TUI kfx contribution contract up front** — rejected: deferred to a real consumer
  (ADR-0006 discipline).
- **Non-Node TUI (e.g. a native / Rust TUI)** — rejected: it would lose in-process zero-copy
  access to the N-API binding (the moat), exactly as Tauri was rejected for the GUI in
  ADR-0006 §6.

## Next (implementation)

1. Optionally run a small coexistence spike (an Ink app that `require`s `kungfu_node.node`
   in-process and reads a journal / state handle zero-copy). Lower priority than ADR-0006's spike:
   the pure-Node in-process path has no renderer constraint and is already exercised.
2. Stand up the modern reference TUI on Ink + React + TS + biome, wired to `framework/api`.
3. Retire the v3 blessed quant-terminal model and the trading-specific surface.

## Reversibility & cost / benefit

- Reversible: additive; the legacy TUI remains in history; the reference TUI is greenfield.
- Benefit: a single React mental model across both reference surfaces; a clean second proof of a
  surface-agnostic capability SDK; a zero-copy-native headless / developer surface.
- Cost: a second reference surface to maintain. Mitigated by stack convergence (shared
  React / TS / biome) and by keeping the TUI minimal and consumer-driven.

## Notes

This ADR covers only the TUI surface. The runtime-side `kfc → kungfu` shell evolution, the
`artifact` dogfood installer (bundling runtime + GUI + TUI + SDK), and the retirement of
trading-specific kfx (`xtp`, `sim`) are related but separate decisions, tracked elsewhere.
