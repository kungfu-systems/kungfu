# Extensions (kfx)

How to write, build and install a kungfu extension. This is the
developer-facing page (*use* plane); the internal shell/kfx contract note is
[`../framework/gui/docs/shell-and-kfx.md`](../../framework/gui/docs/shell-and-kfx.md).
For the topology — which host loads a kfx, how it decides trust, and which
sandbox an untrusted kfx lands in — see [`kfx-topology.md`](kfx-topology.md).
Per claim, this page says where to verify it; the fixtures named at the
bottom are the machine-checked proof.

Three words carry the model — keep them apart:

- **facet** — what a package *does*, declared under `kungfuConfig.config`. A
  package may declare more than one; a facet's loader picks up only what it
  understands. Two are implemented today: `view` (a GUI screen the shell loads)
  and `adapter` (a **runtime facet** — capture-side framework instrumentation
  the trace supervisor loads; the first v4 runtime facet). A background
  `service` facet is proposed by
  [KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be](../adr/KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md)
  for kfx-owned long-lived processes. Older trading adapters and operators are
  a separate earlier-generation line, still mid-migration (see
  [status](#runtime-extensions-current-status)).
- **package (kfx)** — the unit of development and distribution: an npm
  package whose `package.json` carries a `kungfuConfig` manifest. `npm pack`
  of a built package is its complete, offline install unit.
- **suite** — a group of kfx distributed and operated together (navigation
  grouping, enable/disable as a unit, lockstep versioning). Membership is
  npm `dependencies`; the manifest lists member keys. A Suite may additionally
  bind a Profile document, making it one semantic and lifecycle closure while
  its members retain separate trust and capability boundaries.
- **Profile** — a user-visible domain model and operating protocol such as
  Mission/Go or Week/Day/Action. A Profile is declared by a KFX Suite; Kungfu
  Core still owns fact admission, assessment, query, timeline, and lifecycle
  authority.

The word *bundle* is reserved for the self-describing trace/export package
(see [`rewind.md`](../guides/rewind.md)) and is never used for kfx groups.

## A view kfx, from zero to installed

Inside the repository (the SDK is pre-release; see
[`known-limits.md`](../qualification/known-limits.md) on release infrastructure):

```sh
kungfu sdk create extension my-view --workspace
cd my-view
pnpm install                 # once published: plain npm/yarn also work
pnpm build                   # kungfu sdk kfx build → dist/view/index.js
npm pack                     # my-view-0.1.0.tgz — the install unit
kungfu kfx install my-view-0.1.0.tgz
kungfu kfx list
```

The scaffold is two files that matter plus a README:

```
my-view/
├── package.json          # identity + kungfuConfig manifest
└── src/view/index.tsx    # exports exactly one thing: the View component
```

Launch the reference app and the view becomes available to the command palette
and deep links — the primary Activity Rail is reserved for the focused Profile
Home and the fixed high-frequency product surfaces. The shell scans the install
root at startup. During development, point
`KF_EXTENSION_PATH` at a directory containing your package to load it from
source builds without installing (rebuild with `pnpm build`, reload the
app).

For the common single-package workflow, the SDK can do that wiring:

```sh
cd my-view-kfx
kungfu sdk product gui dev
```

That command builds the current kfx, points the reference GUI at the package's
extension root, and starts the GUI for inspection.

## The manifest (`kungfuConfig`)

The static half of an extension lives in `package.json` — managers and
installers read it without executing code. Field reference source of truth is
[`../framework/kfx/kungfu-kfx.contract.json`](../../framework/kfx/kungfu-kfx.contract.json);
TypeScript types in [`../framework/kfx/src/index.ts`](../../framework/kfx/src/index.ts)
must follow that contract. The SDK resolves the same contract from
`KUNGFU_KFX_CONTRACT`, a monorepo checkout, frozen runtime config, or an
extension project's installed `node_modules/@kungfu-tech/kfx` package:

| Field | Meaning |
|---|---|
| `key` | Install/identity key. Install target is `<home>/extensions/<key>`; first occurrence across roots wins. Required for every kfx. |
| `name` | Human-readable package display name. |
| `config.view.title` | Navigation title (falls back to `key`). |
| `config.view.capabilities` | Capability handles the view receives (`ledger`, `domain`, `rewind`, `work`); undeclared handles stay absent. This is the permission seam. |
| `config.view.system` | Shell-owned views (settings, kfx manager, status); not disableable. Third-party packages leave this unset. |
| `config.view.settings` | Entries (`key` / `label` / `fallback`) this view contributes to the shell Settings view; values persist in the runtime home's ConfigStore. |
| `config.view.entry` | Bundle path relative to the package root; default `dist/view/index.js`. |
| `config.adapter.targets` | Module import names whose import triggers the patch (informative — e.g. `langchain_core.tools.base`). |
| `config.adapter.runtimes` | Child runtimes this adapter instruments (`python`, `node`). The supervisor injects an adapter into a child of a matching runtime. |
| `config.adapter.entry` | Adapter source per runtime, relative to the package root (e.g. `{ "python": "src/adapter/python/index.py" }`). An adapter ships source — there is no bundle step. |
| `config.adapter.capabilities` | Capture-side capabilities the adapter needs; the same permission seam as a view's `capabilities` (reserved for enforcement). |
| `suite.title`, `suite.members` | Marks a suite package; `members` lists member `key`s. Members arrive as their own packages (npm `dependencies`) and install individually. |
| `suite.profile` | Optional relative path to a `kungfu.profile-suite/v1` document. Parent traversal and absolute paths are rejected. The document binds required/optional members and every KFD/action/view/migration/permission/qualification artifact by path and SHA-256. |

The manifest is a welded surface. Do not invent fields: `kungfu kfx install`,
`kungfu kfx inspect`, `@kungfu-tech/kfx`, the GUI/TUI loaders, Skill dependency
binding, and frozen artifact verification all validate against the same KFX
contract. The `service` facet is present in the contract as a draft facet while
KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be's process-hosting path hardens.

The same contract also carries `profileSuiteSchema`. Inspect the exact installed
schema with:

```sh
kungfu kfx profile-schema --json
```

Schema-valid means the Profile source closure is well formed. Core lifecycle
operations additionally require one canonical `sha256:...` content root for
every Suite member. Agents can inspect and preview without mutation, then
apply the exact plan with an authorization id:

```sh
kungfu -H <home> kfx profile inspect profile.json \
  --member-root contract=sha256:<64-hex> \
  --member-root actions=sha256:<64-hex>
kungfu -H <home> kfx profile plan install --profile-path profile.json \
  --member-root contract=sha256:<64-hex> \
  --member-root actions=sha256:<64-hex> > install-plan.json
kungfu -H <home> kfx profile apply install-plan.json \
  --authorization-id <decision-or-approval-id>
kungfu -H <home> kfx profile list
```

The actual keys must exactly match the Profile's required and optional member
set. `plan` is read-only; `apply` recomputes the plan and refuses artifact,
member-root, permission, lifecycle-basis, or runtime drift. A lifecycle receipt
does not by itself establish KFD-2 trust for a domain claim; see
[KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1](../adr/KF-ADR-019f86da-4f90-7f46-b195-3af6228d17b1.md).

## The build contract

`kungfu sdk kfx build` bundles `src/view/index.tsx` (or `.ts`) to a CommonJS
bundle at `dist/view/index.js`, leaving external (source of truth:
`KFX_EXTERNALS` in
[`../developer/sdk/src/sdk.js`](../../developer/sdk/src/sdk.js)):

- `react`, `react/jsx-runtime`, `react-dom`
- `@kungfu-tech/api`, `@kungfu-tech/api/capability`

The shell injects its own instances of these through a require shim at load
time, so every kfx shares one React and one capability surface — a view
extension must never ship its own copy. `@kungfu-tech/kfx` (contract types
+ UI tokens) is the opposite: types and plain objects, never stateful, and
bundled into each extension.

The bundle must export `View` (a React component taking
`{ caps, shell }: KfxViewProps`) as a named export — the loader rejects
anything else (verify:
[`../framework/gui/src/renderer/src/kfx-loader.ts`](../../framework/gui/src/renderer/src/kfx-loader.ts)).
A failing kfx renders its error panel; it cannot take the shell down.

An **adapter facet** has no bundle step — it ships source per child runtime,
and the capture supervisor injects it into a traced child, where it runs in
the user's own interpreter. `kungfu sdk kfx build` reports this and does nothing for
an adapter-only package. To add an adapter for a framework, declare
`config.adapter` (its `targets` / `runtimes` / `entry`) and write one entry
file per runtime that registers a patcher — each depends on nothing but the
runtime's built-ins:

- **python** (`entry.python`): `import rewind_client` (the dependency-free
  hook, never `kungfu`) and call `rewind_client.register_adapter(module_name,
  patcher)`; build spans with `rewind_client._CallCapture` / `_render`.
- **node** (`entry.node`): read `globalThis.__kungfuRewind` (the hook exposes
  it) and call `registerAdapter(moduleName, patcher)`; build spans with its
  `captureInvoke` / `render`.

A patcher receives the framework module once it is imported/required and wraps
its tool seam, so an unmodified run is captured with no code change. Discovery
and injection live in the supervisor (source of truth:
[`../framework/core/src/python/kungfu/rewind/adapters.py`](../../framework/core/src/python/kungfu/rewind/adapters.py)),
so the hooks stay dependency-free. `extensions/langchain-adapter` is the first
adapter facet (python); its `src/adapter/python/index.py` is the reference.

## Discovery

The loader scans extension roots in priority order — first occurrence of a
key wins:

1. `KF_EXTENSION_PATH` entries (path-separator list; in development this
   defaults to the workspace `extensions/` tree, and in a packaged artifact it
   defaults to `Resources/extensions`);
2. `<home>/extensions` next to the runtime dir — the root
   `kungfu kfx install` populates.

Scanning goes two levels deep, so suite members nested under a suite
directory are found in the workspace layout.

## Install lifecycle

`kungfu kfx` manages installs for a home (source of truth:
[`../framework/core/src/python/kungfu/cli/commands/kfx.py`](../../framework/core/src/python/kungfu/cli/commands/kfx.py)):

```sh
kungfu kfx install <tgz-or-directory>    # extract into <home>/extensions/<key>
kungfu kfx install <tgz> --force         # replace an existing install
kungfu kfx list [--json]                 # key, package, version, kind
kungfu kfx remove <key>                  # scoped to the managed install root
```

A double install without `--force` refuses; `remove` never touches paths
outside the install root. The CLI and the kfx-manager view operate on the
same facts.

## Trust tiers

A view runs at one of two trust tiers (KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1), and the runtime-plane trust
boundary is extended by KF-ADR-019f86da-4f90-79f1-8716-aca36b142847/KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9. The decision is single-sourced in
`resolveRuntimeTier` and related source-authority helpers
(`../framework/kfx/src/index.ts`). A manifest can ask to stay sandboxed but
never to elevate. Trust is not granted because a package was found under a
writable path or an environment-provided development root; those roots only
control discovery. Trust comes from a source-authority verdict such as the
frozen first-party set plus content pin described in
[KF-ADR-019f86da-4f90-79f1-8716-aca36b142847](../adr/KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md).

- **node-integrated** — source-verified first-party/system views. They share the
  shell's renderer, React and capability instances.
- **sandboxed-ipc** — an installed third-party view. It runs in an isolated
  renderer (`nodeIntegration:false, contextIsolation:true, sandbox:true`): no
  node, no `require`, no direct binding. `contextBridge` exposes only a bridge
  to the capabilities its manifest **declared**; every call round-trips to the
  trusted host over IPC, and an undeclared capability is rejected there — the
  capability declaration is now an *enforced* boundary, not advice. The view's
  session denies the network and its process is killed if it exceeds a memory
  cap (`createSandboxedView` in `../framework/gui/src/main/sandbox-view.ts`).

The `adapter` runtime facet is sharper than a view: an adapter is
instrumentation that runs inside the traced program's own process. A separate
renderer sandbox does not apply, and sandboxing an untrusted adapter into a
separate process would defeat the instrumentation. Per KF-ADR-019f86da-4f90-79f1-8716-aca36b142847, an untrusted
adapter is **refused**, not contained. Wrapping an adapter in a Kungfu Skill or
suite does not elevate it; it must satisfy the same runtime trust policy.

For independent runtime code that is not instrumentation, the proposed `service`
facet is the long-term OS-sandbox plane: a kfx-owned process talks to the host
over the same capability relay, with confinement chosen by the host. See
[`kfx-topology.md`](kfx-topology.md).

## Runtime extensions: current status

The first v4 runtime facet has landed: `config.adapter`, a capture-side
framework adapter the trace supervisor discovers and injects
(`extensions/langchain-adapter` captures unmodified LangChain runs). It needs
no bundle step — an adapter ships source per child runtime — so the v4 build
chain for this facet is "ships source", not a new packager.

Earlier-generation runtime extensions — trading adapters (`td`/`md`),
operators, strategies — are a separate line: they exist under
[`../examples/`](../../examples) with their sources and manifests, but their old
build surface predates the v4 `kungfu sdk` path and is not the contract
documented here. They are kept as reference probes while their coverage role
moves to neutral replacements (see [`known-limits.md`](../qualification/known-limits.md),
"Reference extensions are mid-migration"). Other runtime facets will grow on
this page when their v4 path lands, not before.

## Verified by

- [`../tests/fixtures/kfx-demo-scaffold/`](../../tests/fixtures/kfx-demo-scaffold)
  — scaffold → build → pack → install → remove, from a clean directory,
  asserting the load contract on the produced bundle.
- [`../tests/fixtures/kfx-demo-install/`](../../tests/fixtures/kfx-demo-install)
  — the managed lifecycle against a real shipped view package (double
  install refusal, `--force`, remove).
- [`../tests/fixtures/rewind-demo-langchain/`](../../tests/fixtures/rewind-demo-langchain)
  — the `adapter` facet: an unmodified LangChain agent, captured under
  `kungfu trace` by `extensions/langchain-adapter` discovered on the extension
  root, with no adapter code in the kernel.

All run in `verify --full` (fixture stage); a red fixture means this page
overclaims.
