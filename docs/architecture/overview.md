# Architecture

How the Kungfu repository is layered, and the principle that shapes it. This is
a cross-sectional view of the current system. If you are new to the repository
or the number of layers is the problem, first read the longitudinal
[Evolution Map](../evolution/README.md) and choose the closest pressure in its
[reader routes](../evolution/reader-routes.md); then return here for the current
module boundaries. For the accountability stance behind the product, see
[`facts-before-trust.md`](../concepts/facts-before-trust.md); for the two first principles
the whole design follows from, see
[`design-philosophy.md`](../concepts/design-philosophy.md); for the vocabulary
(`kungfu`/`kfx`/`skill`/`sdk`, `libkungfu`, `yijinjing`, schema, …) see
[`concepts.md`](../concepts/implementation-concepts.md); for the Fact and Episode
public model see [`the-episode.md`](../concepts/the-episode.md) and
[`fact-episode-action-runtime.md`](fact-episode-action-runtime.md); for journal, frame, zero-copy, and Replay
mechanics see [`event-model.md`](event-model.md); for build and contribution see
[CONTRIBUTING](../../CONTRIBUTING.md); for specific decisions see the
[ADRs](../adr).

## Guiding principle: the machine adapts to the person

This is the first of two coupled first principles; the second — *reality sets the
test, not the product* — and how the architecture follows from both are set out
in [`design-philosophy.md`](../concepts/design-philosophy.md).

Kungfu absorbs toolchain and runtime complexity into the product layer that
needs it so users do not have to assemble that layer themselves. The assembled
`kungfu` runtime embeds both a Python and a Node runtime and bridges a full
Python development lifecycle — dependency management, formatting, and
ahead-of-time compilation — so most extension development needs no separately
installed language runtimes or package managers. This does not make the
assembled runtime the minimum adoption unit: `libkungfu`, ecosystem SDKs, the
standalone CLI/TUI, and the GUI retain independently qualified product
closures. See [`product-layers.md`](../concepts/product-layers.md) and
[KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](../adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md).

This is a deliberate trade: the project carries the complexity so the user does
not. It stays sustainable only while the absorbed tooling rests on mainstream,
well-maintained foundations — so "modernize" here means *reduce both user
friction and maintenance burden*, not chase convergence for its own sake.

## The polyglot membrane

At the bottom sits one C++ core, `libkungfu` above the `yijinjing` journal and
schema authority layer. C++, Python, and Node do not each reimplement it — they
are thin bindings over the *same in-process* core. Closed kernel records read
the *same* POD journal bytes with no serialization on the hot path. Open/domain
payloads remain declared cross-language FlatBuffers rather than becoming
language-local objects. That shared membrane is:

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

For closed kernel facts, the POD layout *is* the wire format (see
[KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265](../adr/KF-ADR-019f86da-4f90-7bf2-9789-1b88bf3ed265.md)
and [`contracts.md`](../qualification/contracts.md)). Open/domain facts use `.fbs` as their
schema owner. [KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3](../adr/KF-ADR-019f86da-4f90-71eb-b4c0-376ca7bc7ad3.md)
defines the exclusive ownership rule and the derived view, opaque body, JSON,
and SQLite boundaries; the binding boundaries are detailed in
[`adapters.md`](adapters.md). Everything below is how this core is layered into
a platform.

### Schema authority: two substrates, one owner per fact

Persisted structured facts belong to exactly one substrate:

- **Hana closed-set POD** — fixed-layout, mmap-safe kernel facts with stable
  `carrier_type` identities and compile-time Hana-to-`sqlite_orm` projections.
- **FlatBuffers open/domain schemas** — KFX and evolving cross-language facts
  owned by `.fbs`, with `.bfbs` reflection projections behind `kungfu::view`.

Typed service results and fold views are derived API objects, not a third
persistence schema. Large files and model/source bodies are opaque
content-addressed bytes described by typed metadata. JSON is an adapter,
CLI/export, diagnostic, or rendering boundary; it is not the core service or
journal contract.

## Layers

The repository-level product layers below are complemented by the checked
[Core Layer Map](../../framework/core/architecture/LAYERS.md). That map assigns
every first-party Core C/C++ source and public header to one component owner,
declares the allowed dependency direction, and is enforced by the source gate.

Kungfu is a platform plus a minimal reference application — the editor-platform
model: the core provides capability; products are built on top. The packages
group into the following layers.

The source tree is integrated; distribution is layered. Each official layer
must be independently useful and independently removable within its declared
contract. Higher layers add convenience, never authority. The three
application horizons that keep the core vocabulary honest are documented in
[`domain-horizons.md`](../concepts/domain-horizons.md).

### Runtime and core — `framework/core` (`@kungfu-tech/core`)

The foundation: the `yijinjing` append-only journal runtime and schema layout in
C++, with Python and Node (N-API) bindings, exposed zero-copy in-process. It
also produces the `kungfu` runtime, which embeds the Python and Node runtimes
and bridges the development toolchain; it is the base for
operator-facing surfaces such as the interactive bare `kungfu` TUI, managed runs, skill context
injection, and the richer end-user shell as it matures.

### Capability SDK — `framework/api`

Typed, framework-neutral, publishable access to journal / state / replay over
the in-process zero-copy binding. This is the real value of the platform — the
surface external products consume, independent of any UI framework. See
[KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80](../adr/KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80.md).

### Contracts — `framework/kfx`, `framework/skill`, `framework/spec`

Publishable, framework-neutral contracts others build against, siblings of the
capability SDK:

- `kfx` is the extension contract: package identity, manifest fields, facets,
  trust-tier inputs and UI tokens shared by hosts and extensions. Its current
  shipped facets include `view` and `adapter`; a background `service` facet is
  proposed in
  [KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](../adr/KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md).
- `skill` is the agent-facing contract above kfx: `SKILL.md` parsing, compact
  catalogs, context envelopes, dependency binding and manager fixtures. A skill
  may reference kfx packages, but kfx remains the runtime trust artifact. See
  [KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf](../adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md).
- `spec` is the portable fact-ledger format spec — the manifest contract plus
  the versioned spec bundle — that lets external tools decode the journal
  without the runtime.

Like `api`, these are surfaces you build *on*, not tools.

### Application SDK — `developer/sdk` (`@kungfu-tech/sdk`)

Scaffolding that turns the core capabilities into development tooling: building
`kfx` extensions, scaffolding Kungfu Skills, assembling applications, and
producing packaged artifacts (the `kungfu sdk` subcommand).

### Reference surfaces

Two minimal reference UI implementations over the same capability SDK:

- **GUI** — `framework/gui` (`@kungfu-tech/gui`): a desktop application
  on Electron + React, loading the native binding in-process to preserve
  zero-copy. See
  [KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80](../adr/KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80.md).
- **TUI** — `framework/tui` (`@kungfu-tech/tui`): a terminal
  application. Pure Node, so it loads the binding in-process with no renderer
  boundary. See
  [KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a](../adr/KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a.md).

These framework packages are reference implementations rather than independent
fact authorities. The released standalone CLI/TUI and GUI products that
assemble them must still be complete within their declared adoption layers per
[KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](../adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md); "reference" does not mean a user must install the full desktop
distribution to operate Kungfu.

The journal/state runtime stays in-process on the trusted path so the zero-copy
moat is preserved. Untrusted `view` kfx are isolated by the GUI shell as
sandboxed Electron `WebContentsView`s that reach their declared capabilities
only through an IPC relay. Runtime-plane isolation uses the same capability
protocol over a different host/guest transport: a binding-less guest process
talks to a trusted capability host over stdio, with the OS sandbox applied by
the host. The trust boundary and runtime-plane isolation are pinned by
[KF-ADR-019f86da-4f90-79f1-8716-aca36b142847](../adr/KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md);
the uniform async capability surface is pinned by
[KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9](../adr/KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md).
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

The dogfood installer: inert Product System metadata assembles the runtime,
both reference UIs, the SDK, and all product-declared KFX into desktop and CLI
products. Assembly and distribution confer no runtime authority. Installing the
desktop product yields the reference GUI and TUI, the `kungfu` shell, and the
SDK for zero-setup extension and product development. `./shifu dist` is the
single source-to-product command; its outputs live under `product/release`.

### Build tooling — `shifu`

Build-time only: `./shifu` is the development orchestrator that pins the
toolchain (Node via fnm, Python via uv, the package manager via Corepack) so a
fresh clone builds with one command.

## The build dogfoods the SDK

The repository's own build is a closed loop that exercises Kungfu's capabilities
end to end: if a core capability regresses, building Kungfu itself fails first.
This is one instance of a broader product-layer principle — *the adoption path is
the validation path, so upkeep of the core is a byproduct of use* — set out in
[KF-ADR-019f86da-4f90-7739-aa31-52af27bc4470](../adr/KF-ADR-019f86da-4f90-7739-aa31-52af27bc4470.md).

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
[`examples/probe-cpp`](../../examples/probe-cpp): a neutral probe that compiles
against the `libkungfu` API and the public `yijinjing/schema` headers into a
native module (`kungfu sdk kfx build` drives CMake through the core toolchain). The Python
ahead-of-time path is covered by
[`examples/probe-python`](../../examples/probe-python): a neutral probe whose
dependency is installed with `kungfu dev engage pdm` and whose module is
Nuitka-compiled with `kungfu dev engage nuitka`. These two probes live under
`examples/` because they exist to exercise the build, not to be installed as
products. The JavaScript / TypeScript path is
covered by the reference view extensions (such as
[`extensions/rewind-inspector`](../../extensions/rewind-inspector)), which `kungfu sdk kfx
build` bundles with esbuild.

## Repository layout

```
framework/    architecture roots: npm packages plus source-only contracts/tools
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

Place a component by what it *is*, not where it looks tidy. The dividing line is
build-*on* (a contract or library others consume) versus build-*with* (a tool
others invoke). The complete classification and its machine-checked package
boundary are maintained in [`framework/README.md`](../../framework/README.md):

- **`framework/`** — an architecture root. Some immediate children are npm
  packages; others are source-only contracts, internal libraries or repository
  tools. A directory becomes an npm package only when it has `package.json` and
  is owned by the npm release registry; its location alone grants no package or
  publication boundary.
- **`developer/`** — a build-time **tool** you build with: invoked (typically a
  CLI) and taken as a **devDependency**, never imported at runtime (`sdk`).
- **`extensions/`** — a kfx plugin built on the extension contract.
- **`examples/`** — a sample or a build-coverage probe: it demonstrates or
  exercises the platform but is not shipped as a product.
- **`product`** — the assembly that bundles the platform into distributable
  desktop and CLI products.

By this rule a format spec is a contract, so it lives in `framework`; the `sdk`
build CLI is a distributable developer tool, so it lives in `developer`. A
repository-only tool may still live in `framework` when it governs or qualifies
framework contracts without claiming an independently released package.

## Direction

The frontend is being rebuilt as a platform with two minimal reference surfaces
(GUI per [KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80](../adr/KF-ADR-019f86da-4f90-7513-9c95-f19e0c7faa80.md), TUI per [KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a](../adr/KF-ADR-019f86da-4f90-76ce-8957-f95affe9341a.md)) over a framework-neutral capability SDK,
rather than a single hand-maintained application. Trading-specific surfaces from
earlier versions are reference built-ins at most, not the point.
