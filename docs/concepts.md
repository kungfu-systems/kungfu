# Concepts

The vocabulary used across kungfu's documentation and code, in one place. Most of
the coined names share the `kf` prefix, which simply stands for *kungfu*. For how
these pieces are layered see [`architecture.md`](architecture.md); for the
principles behind them see [`design-philosophy.md`](design-philosophy.md).

## The `kf*` command family

| Name | What it is |
|---|---|
| `kfx` | A **kungfu extension** — a plugin built on the extension contract (the units under `extensions/`). |
| `kfs` | The **application/extension SDK command**: scaffolds and builds `kfx` extensions, assembles applications, and produces packaged artifacts. |
| `kungfu` | The **kungfu runtime binary and end-user CLI command** — the canonical way to invoke kungfu from the command line. It embeds a Python and a Node runtime and exposes the journal/state APIs; it is the runtime everything else runs on. The richer end-user shell is planned to grow under this name. |
| `./kungfu-code` | The **development/build orchestrator** used while working on the repo (pins Node, Python, and the package manager so a fresh clone builds with one command). It is build-time only, not shipped. |

## Core building blocks

| Term | What it is |
|---|---|
| **libkungfu** | The C++ **core library**: the `longfist` type system and the `yijinjing` journal runtime, with C++/Python/Node bindings. This is what the README calls the "zero-copy, multi-language runtime"; it is packaged as `@kungfu-tech/core` and is the foundation the `kungfu` runtime is built on. |
| **longfist** | The unified **type system / schema** (FlatBuffers-based). Its binary layout *is* the cross-language and on-disk contract — see [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md). |
| **yijinjing** | The append-only **journal runtime** — the event bus that carries the data plane. |
| **journal** | The append-only **event log**: one shared, strongly-typed stream of frames that every component consumes, rather than each inventing its own format. |
| **frame** | A single journal record: a fixed-size header (source / destination / nanosecond timestamp / message type) plus a variable-size payload. |
| **zero-copy** | The same in-process journal bytes are shared across C++, Python, and Node **without serialization** on the hot path. |
| **replay** | Re-running recorded journals on the *same* runtime and the *same* semantics as live, so recorded streams reproduce with high precision. |

## Runtime / engine concepts

These appear in the control-axis ADRs (0003–0005) and in the code.

| Term | What it is |
|---|---|
| **hero** | The reactive **engine core** (`yijinjing::practice::hero`): a participant on the journal bus that drives a single-threaded event loop and exposes journal events as an RxCpp observable stream. It is the base of the practice layer. |
| **apprentice** | A `hero` specialized as a **client/peer** (`apprentice : public hero`): the typical participant that attaches to the bus to consume and produce events. |
| **watcher** | The **Node (N-API) binding** (`Watcher : public apprentice`): it consumes the journal/state and exposes it to JavaScript for the reference UIs. |
| **coloop** | The **Python event-loop integration** (`KungfuEventLoop`): fuses the engine loop with Python `asyncio` on a single thread — see [ADR-0003](../framework/core/docs/adr/ADR-0003-control-axis-python-coroutine-integration.md). |

## Layers (in brief)

- **Capability SDK** — `framework/api`: typed, framework-neutral access to
  journal / state / replay.
- **Application SDK** — `developer/sdk` (the `kfs` command).
- **Reference surfaces** — `framework/gui` (Electron + React) and `framework/tui`
  (terminal): minimal demonstrators over the capability SDK, not the product.
- **Distribution** — `artifact`: the installer that bundles the runtime, both
  reference UIs, and the SDK.

See [`architecture.md`](architecture.md) for how these fit together.
