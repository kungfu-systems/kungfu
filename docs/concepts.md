# Concepts

The vocabulary used across kungfu's documentation and code, in one place. Most of
the coined names share the `kf` prefix, which simply stands for *kungfu*. For how
these pieces are layered see [`architecture.md`](architecture.md); for the
principles behind them see [`design-philosophy.md`](design-philosophy.md).

## The `kf*` command family

| Name | What it is |
|---|---|
| `kfx` | A **kungfu extension package** — the governed runtime artifact built on the extension contract. A kfx declares facets such as `view` or `adapter`; proposed `service` facets are documented in [`kfx-topology.md`](kfx-topology.md). |
| `Kungfu Skill` | The **agent-facing capability object above kfx**. The minimum source is a directory containing `SKILL.md`; Kungfu turns it into a compact skill catalog and context envelope for managed agent runs. Skills may reference kfx packages, but they do not grant those packages runtime authority. |
| `Kungfu config` | The **agent-facing global JSON configuration** resolved from the `config-contract` defaults plus optional `~/.kungfu/config.json` overrides. Its schema, defaults, and resolution rules live in one KFD-1 contract file. It is separate from `KF_HOME`, which stores runtime data such as journals and local databases. |
| `kungfu sdk` | The **application/extension SDK command**: scaffolds and builds `kfx` extensions, assembles applications, and produces packaged artifacts. |
| `kungfu` | The **kungfu runtime binary and end-user CLI command** — the canonical way to invoke kungfu from the command line. It embeds a Python and a Node runtime and exposes the journal/state APIs; it is the runtime everything else runs on. Operator-facing slices such as `kungfu cockpit`, managed runs, and skill context injection grow under this command. |
| `./kungfu-code` | The **development/build orchestrator** used while working on the repo (pins Node, Python, and the package manager so a fresh clone builds with one command). It is build-time only, not shipped. |

## Core building blocks

| Term | What it is |
|---|---|
| **libkungfu** | The C++ **runtime library** built above `yijinjing`, with C++/Python/Node bindings, runtime providers, projections, and process wiring. This is what the README calls the "zero-copy, multi-language runtime"; it is packaged as `@kungfu-tech/core` and is the foundation the `kungfu` runtime is built on. |
| **yijinjing schema** | The unified **runtime fact schema** under `kungfu/yijinjing/schema`. Its binary layout is the v4 cross-language and on-disk contract for closed runtime facts. |
| **yijinjing** | The append-only **journal and storage-semantic kernel** — frame/page mmap, reader/writer, locator/location, causal event ranges, payload references, manifests, source records, fsck reports, provider contracts, and the runtime fact schema. Runtime backends live above it in `libkungfu`. |
| **journal** | The append-only **event log**: one shared, strongly-typed stream of frames that every component consumes, rather than each inventing its own format. |
| **frame** | A single journal record: a fixed-size header (source / destination / nanosecond timestamp / carrier type) plus a variable-size payload. |
| **action recorder** | The language-neutral C++ core surface for writing action facts into the journal. Python and Node expose thin bindings over it; they must not implement separate causality, writer, or receipt semantics. See [ADR-0022](../framework/core/docs/adr/ADR-0022-core-action-recording-surface.md). |
| **location** | A runtime identity/address: role, namespace, name, mode, locator root, and uid. Locations identify who writes, who reads, and where journals live. |
| **channel** | A source/destination communication edge between locations. Channels are used for runtime read/write/request paths; they are transport, not fact authority. |
| **source** | A logical storage-sync registry entry: a local profile, imported bundle, remote Kungfu runtime, or adapter that can enumerate facts for import. |
| **manifest** | The trust root for a portable fact-ledger bundle or accepted segment: format version, capture boundary, source metadata, payload inventory, schema bindings, and checksums. |
| **Episode** | A first-class bounded causal segment in the fact ledger. It is the storage/export/import/fsck/timeline-slicing unit: frame-level causality closes inside it, and cross-Episode influence is declared as Episode dependencies. See [ADR-0033](../framework/core/docs/adr/ADR-0033-episode-causal-segment-object.md) and [`episode-object-model.md`](episode-object-model.md). |
| **observer timeline projection** | A deterministic user-visible order over accepted facts from one or more sources, produced from an explicit observer policy rather than a claimed universal clock. Causal links dominate policy; concurrent facts may be ordered by source priority and tie-breakers. |
| **zero-copy** | The same in-process journal bytes are shared across C++, Python, and Node **without serialization** on the hot path. |
| **replay** | Re-running recorded journals on the *same* runtime and the *same* semantics as live, so recorded streams reproduce with high precision. |

## Extension and agent-context concepts

| Term | What it is |
|---|---|
| **kfx facet** | What a kfx package contributes. Implemented facets include `view` (a GUI screen) and `adapter` (capture-side instrumentation injected into a traced child). A `service` facet is proposed for kfx-owned background processes. |
| **source authority** | The trust verdict for a kfx. Trust must come from verifiable origin such as the frozen first-party set and content pin, not from the filesystem path or extension root where the package was discovered. |
| **capability relay** | The host/guest protocol a sandboxed extension uses to reach declared capabilities. GUI views use a Chromium IPC transport; runtime/service guests use a child-process transport. The surface stays uniform across trust tiers. |
| **skill catalog** | A compact, machine-readable index of installed Kungfu Skills. It is what an agent sees by default before loading any full `SKILL.md`. |
| **skill context envelope** | The prompt/tool/audit wrapper a manager injects into a managed agent run. It carries the filtered skill catalog, the on-demand `kungfu.skill.read` operation, and audit identifiers. |
| **Kungfu agent entrypoint** | The local discovery surface for agents, currently `kungfu agent context --json`. Managed-run envelopes point here instead of embedding config, command inventories, or documentation paths in every prompt. |
| **skill audit** | Evidence that a skill catalog was advertised, a full skill was loaded, or dependencies were bound. Skill audit is part of the responsibility trail for delegated work, not just a debug log. |

## Runtime / engine concepts

These appear in the control-axis ADRs (0003–0005) and in the code.

| Term | What it is |
|---|---|
| **hero** | The reactive **engine core** (`runtime::practice::hero`): a participant on the journal bus that drives a single-threaded event loop and exposes journal events as an RxCpp observable stream. It is the base of the practice layer. |
| **apprentice** | A `hero` specialized as a **client/peer** (`apprentice : public hero`): the typical participant that attaches to the bus to consume and produce events. |
| **watcher** | The **Node (N-API) binding** (`Watcher : public apprentice`): it consumes the journal/state and exposes it to JavaScript for the reference UIs. |
| **coloop** | The **Python event-loop integration** (`KungfuEventLoop`): fuses the engine loop with Python `asyncio` on a single thread — see [ADR-0003](../framework/core/docs/adr/ADR-0003-control-axis-python-coroutine-integration.md). |

## Layers (in brief)

- **Capability SDK** — `framework/api`: typed, framework-neutral access to
  journal / state / replay, plus the capability host/guest relay.
- **KFX contract** — `framework/kfx`: extension package identity, facets and
  trust-tier decision helpers.
- **Skill contract** — `framework/skill`: schemas, fixtures and helpers for
  skill source parsing, catalogs and context envelopes.
- **Application SDK** — `developer/sdk` (the `kungfu sdk` subcommand).
- **Reference surfaces** — `framework/gui` (Electron + React) and `framework/tui`
  (terminal): minimal demonstrators over the capability SDK, not the product.
- **Distribution** — `artifact`: the installer that bundles the runtime, both
  reference UIs, and the SDK.

See [`architecture.md`](architecture.md) for how these fit together.
