# Architecture

How the Kungfu repository is layered, and the principle that shapes it. For the
two first principles the whole design follows from, see
[`design-philosophy.md`](design-philosophy.md); for the vocabulary
(`kfc`/`kfx`/`kfs`, `libkungfu`, `longfist`, `yijinjing`, …) see
[`concepts.md`](concepts.md); for the data-plane concepts
(journal, zero-copy, replay) see the [README](../README.md); for build and
contribution see [CONTRIBUTING](../CONTRIBUTING.md); for specific decisions see
the [ADRs](../framework/core/docs/adr).

## Guiding principle: the machine adapts to the person

This is the first of two coupled first principles; the second — *reality sets the
test, not the product* — and how the architecture follows from both are set out
in [`design-philosophy.md`](design-philosophy.md).

Kungfu absorbs toolchain and runtime complexity into the product so that its
users do not have to assemble it themselves. The `kfc` runtime embeds both a
Python and a Node runtime and bridges a full Python development lifecycle —
dependency management, formatting, and ahead-of-time compilation — so most
extension development needs no separately installed language runtimes or package
managers.

This is a deliberate trade: the project carries the complexity so the user does
not. It stays sustainable only while the absorbed tooling rests on mainstream,
well-maintained foundations — so "modernize" here means *reduce both user
friction and maintenance burden*, not chase convergence for its own sake.

## The polyglot membrane

At the bottom sits one C++ core, `libkungfu` (the `longfist` type system + the
`yijinjing` journal). C++, Python, and Node do not each reimplement it — they are
thin bindings over the *same in-process* core, reading the *same* journal bytes
with no serialization on the hot path. That shared, zero-copy, cross-language
surface is the membrane:

```
   C++ app / kfx        Python  (py_kungfu)      Node  (kungfu_node.node)
        │                     │                          │
        │   in-process, zero-copy — the same bytes       │
        └──────────────┬──────┴───────────┬──────────────┘
                ┌───────┴───────────────────┴───────┐
                │  libkungfu                          │
                │  longfist (layout) + yijinjing (journal)
                └───────────────────┬─────────────────┘
                                    │  mmap MAP_SHARED
                            ┌───────┴────────┐
                            │ cross-process  │   ← still no per-frame
                            │  journal bus   │     serialization
                            └────────────────┘
```

The layout *is* the wire format (see
[ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)
and [`contracts.md`](contracts.md)); the binding boundaries are detailed in
[`adapters.md`](adapters.md). Everything below is how this core is layered
into a platform.

## Layers

Kungfu is a platform plus a minimal reference application — the editor-platform
model: the core provides capability; products are built on top. The packages
group into the following layers.

### Runtime and core — `framework/core` (`@kungfu-tech/core`)

The foundation: the `longfist` type system and the `yijinjing` append-only
journal runtime in C++, with Python and Node (N-API) bindings, exposed zero-copy
in-process. It also produces `kfc`, the runtime that embeds the Python and Node
runtimes and bridges the development toolchain. `kfc` is the base for the
planned `kungfu` end-user shell.

### Capability SDK — `framework/api`

Typed, framework-neutral, publishable access to journal / state / replay over
the in-process zero-copy binding. This is the real value of the platform — the
surface external products consume, independent of any UI framework. See
[ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md).

### Application SDK — `developer/sdk` (`@kungfu-tech/sdk`)

Scaffolding that turns the core capabilities into development tooling: building
`kfx` extensions, assembling applications, and producing packaged artifacts
(the `kfs` command).

### Reference surfaces

Two minimal reference UIs over the same capability SDK — demonstrators, not the
product:

- **GUI** — `framework/gui` (`@kungfu-tech/gui`): a desktop application
  on Electron + React, loading the native binding in-process to preserve
  zero-copy. See
  [ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md).
- **TUI** — `framework/tui` (`@kungfu-tech/tui`): a terminal
  application. Pure Node, so it loads the binding in-process with no renderer
  boundary. See
  [ADR-0007](../framework/core/docs/adr/ADR-0007-v4-tui-platform-reference-surface.md).

### Extensions (kfx) — `extensions/*`

Plugins built on the extension contract. The repository keeps a small set of
reference extensions that double as build-time coverage probes — see
[*The build dogfoods the SDK*](#the-build-dogfoods-the-sdk) below.

### Distribution — `artifact` (`@kungfu-tech/artifact-kungfu`)

The dogfood installer: it bundles the runtime, both reference UIs and the SDK
into one package, so installing it yields the reference GUI and TUI, the
`kungfu` shell, and the SDK for zero-setup extension and product development.

### Build tooling — `developer/toolchain`, `kungfu-code`

Build-time only: `developer/toolchain` aggregates shared build dependencies, and
`./kungfu-code` is the development orchestrator that pins the toolchain (Node via
fnm, Python via uv, the package manager via Corepack) so a fresh clone builds
with one command.

## The build dogfoods the SDK

The repository's own build is a closed loop that exercises Kungfu's capabilities
end to end: if a core capability regresses, building Kungfu itself fails first.
This is one instance of a broader product-layer principle — *the adoption path is
the validation path, so upkeep of the core is a byproduct of use* — set out in
[ADR-0009](../framework/core/docs/adr/ADR-0009-load-bearing-self-bootstrap.md).

The reference extensions are coverage probes for this loop, not products — each
exercises a distinct extension path:

- a Python extension, through the bundled dependency-management and
  ahead-of-time compilation toolchain;
- a C++ extension, against the `libkungfu` API directly;
- a JavaScript / TypeScript extension.

`artifact` closes the loop at the top: assembling it is the real test that the
SDK can package a complete application from the runtime, the reference surfaces
and the extensions. Trading-specific reference extensions from earlier versions
are being retired, and their coverage role is being handed to neutral
replacements that exercise the same paths. The C++ path is covered by
[`extensions/probe-cpp`](../extensions/probe-cpp): a neutral probe that compiles
against the `libkungfu` API and its FlatBuffers data structures into a native
module (`kfs kfx build` drives CMake through the core toolchain). The remaining
paths — a Python extension through the bundled ahead-of-time toolchain, and a
JavaScript / TypeScript extension — are still being reinstated.

## Repository layout

```
framework/
  core        runtime + core (C++ longfist / yijinjing, bindings, kfc)
  api         capability SDK
  gui         reference GUI (Electron + React)
  tui         reference TUI
developer/
  sdk         application / extension SDK (kfs)
  toolchain   shared build dependencies
extensions/   kfx extensions
examples/     samples
artifact      dogfood installer
```

## Direction

The frontend is being rebuilt as a platform with two minimal reference surfaces
(GUI per ADR-0006, TUI per ADR-0007) over a framework-neutral capability SDK,
rather than a single hand-maintained application. Trading-specific surfaces from
earlier versions are reference built-ins at most, not the point.
