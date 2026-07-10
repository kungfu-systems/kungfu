# Architecture

How the Kungfu repository is layered, and the principle that shapes it. For the
accountability stance behind the product, see
[`facts-before-trust.md`](facts-before-trust.md); for the two first principles
the whole design follows from, see
[`design-philosophy.md`](design-philosophy.md); for the vocabulary
(`kungfu`/`kfx`/`skill`/`sdk`, `libkungfu`, `yijinjing`, schema, …) see
[`concepts.md`](concepts.md); for the data-plane concepts
(journal, zero-copy, replay) see the [README](../README.md); for build and
contribution see [CONTRIBUTING](../CONTRIBUTING.md); for specific decisions see
the [ADRs](../framework/core/docs/adr).

## Guiding principle: the machine adapts to the person

This is the first of two coupled first principles; the second — *reality sets the
test, not the product* — and how the architecture follows from both are set out
in [`design-philosophy.md`](design-philosophy.md).

Kungfu absorbs toolchain and runtime complexity into the product so that its
users do not have to assemble it themselves. The `kungfu` runtime embeds both a
Python and a Node runtime and bridges a full Python development lifecycle —
dependency management, formatting, and ahead-of-time compilation — so most
extension development needs no separately installed language runtimes or package
managers.

This is a deliberate trade: the project carries the complexity so the user does
not. It stays sustainable only while the absorbed tooling rests on mainstream,
well-maintained foundations — so "modernize" here means *reduce both user
friction and maintenance burden*, not chase convergence for its own sake.

## The polyglot membrane

At the bottom sits one C++ core, `libkungfu` above the `yijinjing` journal and
runtime schema. C++, Python, and Node do not each reimplement it — they are
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
                │  yijinjing (journal + schema layout)
                └───────────────────┬─────────────────┘
                                    │  mmap MAP_SHARED
                            ┌───────┴────────┐
                            │ cross-process  │   ← still no per-frame
                            │  journal bus   │     serialization
                            └────────────────┘
```

The layout *is* the wire format (see
[ADR-0008](../framework/core/docs/adr/ADR-0008-yijinjing-schema-layout-baseline.md)
and [`contracts.md`](contracts.md)); the binding boundaries are detailed in
[`adapters.md`](adapters.md). Everything below is how this core is layered
into a platform.

## Layers

Kungfu is a platform plus a minimal reference application — the editor-platform
model: the core provides capability; products are built on top. The packages
group into the following layers.

### Runtime and core — `framework/core` (`@kungfu-tech/core`)

The foundation: the `yijinjing` append-only journal runtime and schema layout in
C++, with Python and Node (N-API) bindings, exposed zero-copy in-process. It
also produces the `kungfu` runtime, which embeds the Python and Node runtimes
and bridges the development toolchain; it is the base for
operator-facing surfaces such as `kungfu cockpit`, managed runs, skill context
injection, and the richer end-user shell as it matures.

### Capability SDK — `framework/api`

Typed, framework-neutral, publishable access to journal / state / replay over
the in-process zero-copy binding. This is the real value of the platform — the
surface external products consume, independent of any UI framework. See
[ADR-0006](../framework/core/docs/adr/ADR-0006-v4-frontend-platform-architecture.md).

### Contracts — `framework/kfx`, `framework/skill`, `framework/spec`

Publishable, framework-neutral contracts others build against, siblings of the
capability SDK:

- `kfx` is the extension contract: package identity, manifest fields, facets,
  trust-tier inputs and UI tokens shared by hosts and extensions. Its current
  shipped facets include `view` and `adapter`; a background `service` facet is
  proposed in
  [ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md).
- `skill` is the agent-facing contract above kfx: `SKILL.md` parsing, compact
  catalogs, context envelopes, dependency binding and manager fixtures. A skill
  may reference kfx packages, but kfx remains the runtime trust artifact. See
  [ADR-0015](../framework/core/docs/adr/ADR-0015-kungfu-skill-agent-context-layer.md).
- `spec` is the portable fact-ledger format spec — the manifest contract plus
  the versioned spec bundle — that lets external tools decode the journal
  without the runtime.

Like `api`, these are surfaces you build *on*, not tools.

### Application SDK — `developer/sdk` (`@kungfu-tech/sdk`)

Scaffolding that turns the core capabilities into development tooling: building
`kfx` extensions, scaffolding Kungfu Skills, assembling applications, and
producing packaged artifacts (the `kungfu sdk` subcommand).

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

The journal/state runtime stays in-process on the trusted path so the zero-copy
moat is preserved. Untrusted `view` kfx are isolated by the GUI shell as
sandboxed Electron `WebContentsView`s that reach their declared capabilities
only through an IPC relay. Runtime-plane isolation uses the same capability
protocol over a different host/guest transport: a binding-less guest process
talks to a trusted capability host over stdio, with the OS sandbox applied by
the host. The trust boundary and runtime-plane isolation are pinned by
[ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md);
the uniform async capability surface is pinned by
[ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md).
See [`kfx-topology.md`](kfx-topology.md) for the current load/sandbox topology.

### Extensions (kfx) — `extensions/*`

Plugins built on the extension contract. A kfx is a package that declares one or
more facets (`view`, `adapter`, and proposed `service`) under `kungfuConfig`.
The repository keeps a small set of reference extensions that double as
build-time coverage probes — see
[*The build dogfoods the SDK*](#the-build-dogfoods-the-sdk) below.

### Skills — `framework/skill`, `extensions/system/skill-manager`

Kungfu Skills are agent-facing capability objects above kfx. The minimal source
is a directory containing `SKILL.md`; the runtime derives a compact catalog and
injects that catalog into managed agent runs, loading the full `SKILL.md` only
on demand. A skill can reference kfx dependencies, but it cannot grant those
packages additional runtime authority; the kfx trust gate still decides what
can execute.

### Agent onboarding pack — `kungfu agent`

The installed runtime also carries a small local Agent Onboarding Pack under the
core Python package. It is the first fact source for agents choosing whether to
read, report structured work facts, trace an existing command, run a managed
provider session, or handle remote evidence. The pack is exposed through
`kungfu agent brief`, `kungfu agent capabilities --json`, and
`kungfu agent choose-mode --json`, and it ships with provider-specific
`SKILL.md` files that can be previewed before explicit installation. The
agent-facing control surface is declared in `kfd3_api.registry.json`; the Click
runtime commands under `kungfu agent` anchor to that registry with explicit
KFD-3 API ids, while `commands.json`, the brief, and provider skills are
registry projections.

This pack is not another authority layer. It records current commands, maturity
labels, safety boundaries, and examples so Electron, standalone CLI, npm, and
PyPI installs do not depend on stale external notes. Future Homebrew, winget,
container, and kfx channels must pass the same pack validation before claiming
agent-ready packaging. `kungfu agent verify --json` is the installed-runtime
closure check: it validates the registry shape, confirms the `kungfu agent`
command tree has no unanchored runtime commands, and checks the command catalog
does not expose commands outside the declared registry.

### Distribution — `product` (`@kungfu-tech/product-kungfu`)

The dogfood installer: it bundles the runtime, both reference UIs, the SDK and
all first-party kfx declared by `product/package.json` into desktop and CLI
products. Installing the desktop product yields the reference GUI and TUI, the
`kungfu` shell, and the SDK for zero-setup extension and product development.
`./shifu dist` is the single source-to-product command; its outputs live
under `product/release`.

### Build tooling — `shifu`

Build-time only: `./shifu` is the development orchestrator that pins the
toolchain (Node via fnm, Python via uv, the package manager via Corepack) so a
fresh clone builds with one command.

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

`product` closes the loop at the top: assembling it is the real test that the
SDK can package complete desktop and CLI products from the runtime, the
reference surfaces and the extensions. Trading-specific reference extensions
from earlier versions are being retired, and their coverage role is being
handed to neutral replacements that exercise the same paths. The C++ path is covered by
[`examples/probe-cpp`](../examples/probe-cpp): a neutral probe that compiles
against the `libkungfu` API and the public `yijinjing/schema` headers into a
native module (`kungfu sdk kfx build` drives CMake through the core toolchain). The Python
ahead-of-time path is covered by
[`examples/probe-python`](../examples/probe-python): a neutral probe whose
dependency is installed with `kungfu engage pdm` and whose module is
Nuitka-compiled with `kungfu engage nuitka`. These two probes live under
`examples/` because they exist to exercise the build, not to be installed as
products. The JavaScript / TypeScript path is
covered by the reference view extensions (such as
[`extensions/rewind-inspector`](../extensions/rewind-inspector)), which `kungfu sdk kfx
build` bundles with esbuild.

## Repository layout

```
framework/    platform + contracts you build ON (imported as a dependency)
  core        runtime + core (C++ yijinjing schema/journal, bindings, kungfu)
  api         capability SDK and host/guest capability relay
  kfx         extension package/facet/trust contract
  skill       Kungfu Skill schemas, fixtures and catalog/context helpers
  spec        portable fact-ledger format spec
  gui         reference GUI (Electron + React)
  tui         reference TUI
developer/    build tooling you build WITH (invoked, a devDependency)
  sdk         application / extension / skill SDK — the `kungfu sdk` subcommand
extensions/   kfx plugins (reference extensions)
examples/     samples and build-coverage probes
product       dogfood desktop and CLI products (assemble the above)
shifu   build orchestrator (pins the toolchain)
```

### Where a new package goes

Place a package by what it *is*, not where it looks tidy. The dividing line is
build-*on* (a contract or library others import) versus build-*with* (a tool
others invoke):

- **`framework/`** — a runtime component, or a publishable, framework-neutral
  contract/library that others build on and take as a **dependency** (`core`,
  `api`, `kfx`, `skill`, `spec`, plus the reference `gui` / `tui`).
- **`developer/`** — a build-time **tool** you build with: invoked (typically a
  CLI) and taken as a **devDependency**, never imported at runtime (`sdk`).
- **`extensions/`** — a kfx plugin built on the extension contract.
- **`examples/`** — a sample or a build-coverage probe: it demonstrates or
  exercises the platform but is not shipped as a product.
- **`product`** — the assembly that bundles the platform into distributable
  desktop and CLI products.

By this rule a format spec is a contract, so it lives in `framework`; the `sdk`
build CLI is a tool, so it lives in `developer` — even when that leaves a single
package there.

## Direction

The frontend is being rebuilt as a platform with two minimal reference surfaces
(GUI per ADR-0006, TUI per ADR-0007) over a framework-neutral capability SDK,
rather than a single hand-maintained application. Trading-specific surfaces from
earlier versions are reference built-ins at most, not the point.
