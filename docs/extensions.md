# Extensions (kfx)

How to write, build and install a kungfu extension. This is the
developer-facing page (*use* plane); the internal shell/kfx contract note is
[`../framework/gui/docs/shell-and-kfx.md`](../framework/gui/docs/shell-and-kfx.md).
Per claim, this page says where to verify it; the fixtures named at the
bottom are the machine-checked proof.

Three words carry the model — keep them apart:

- **facet** — what a package *does*, declared under `kungfuConfig.config`.
  The shipped facet today is `view` (a GUI screen); runtime facets (trading
  adapters, operators) exist as earlier-generation examples and are
  mid-migration (see [status](#runtime-extensions-current-status)).
- **package (kfx)** — the unit of development and distribution: an npm
  package whose `package.json` carries a `kungfuConfig` manifest. `npm pack`
  of a built package is its complete, offline install unit.
- **suite** — a group of kfx distributed and operated together (navigation
  grouping, enable/disable as a unit, lockstep versioning). Membership is
  npm `dependencies`; the manifest lists member keys.

The word *bundle* is reserved for the self-describing trace/export package
(see [`rewind.md`](rewind.md)) and is never used for kfx groups.

## A view kfx, from zero to installed

Inside the repository (the SDK is pre-release; see
[`known-limits.md`](known-limits.md) on release infrastructure):

```sh
node developer/sdk/src/kfs.js create extension my-view --workspace
cd my-view
pnpm install                 # once published: plain npm/yarn also work
pnpm build                   # kfs kfx build → dist/view/index.js
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

Launch the reference app and the view appears in navigation — the shell
scans the install root at startup. During development, point
`KF_EXTENSION_PATH` at a directory containing your package to load it from
source builds without installing (rebuild with `pnpm build`, reload the
app).

## The manifest (`kungfuConfig`)

The static half of an extension lives in `package.json` — managers and
installers read it without executing code. Field reference (source of
truth: [`../framework/kfx/src/index.ts`](../framework/kfx/src/index.ts),
types `KfxViewDecl` / `KfxSettingDecl` / `KfxSuiteDecl`):

| Field | Meaning |
|---|---|
| `key` | Install/identity key. Install target is `<home>/extensions/<key>`; first occurrence across roots wins. Required for every kfx. |
| `name` | Human-readable package display name. |
| `config.view.title` | Navigation title (falls back to `key`). |
| `config.view.capabilities` | Capability handles the view receives (`ledger`, `domain`, `rewind`, `work`); undeclared handles stay absent. This is the permission seam. |
| `config.view.system` | Shell-owned views (settings, kfx manager, status); not disableable. Third-party packages leave this unset. |
| `config.view.settings` | Entries (`key` / `label` / `fallback`) this view contributes to the shell Settings view; values persist in the runtime home's ConfigStore. |
| `config.view.entry` | Bundle path relative to the package root; default `dist/view/index.js`. |
| `suite.title`, `suite.members` | Marks a suite package; `members` lists member `key`s. Members arrive as their own packages (npm `dependencies`) and install individually. |

The manifest is a welded surface the moment packages are published; until
then it evolves with its in-repo consumers. Do not invent fields — the
loader ignores what it does not know, and nothing else will read them.

## The build contract

`kfs kfx build` bundles `src/view/index.tsx` (or `.ts`) to a CommonJS
bundle at `dist/view/index.js`, leaving external (source of truth:
`KFX_EXTERNALS` in
[`../developer/sdk/src/kfs.js`](../developer/sdk/src/kfs.js)):

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
[`../framework/gui/src/renderer/src/kfx-loader.ts`](../framework/gui/src/renderer/src/kfx-loader.ts)).
A failing kfx renders its error panel; it cannot take the shell down.

## Discovery

The loader scans extension roots in priority order — first occurrence of a
key wins:

1. `KF_EXTENSION_PATH` entries (path-separator list; in development this
   defaults to the workspace `extensions/` tree);
2. `<home>/extensions` next to the runtime dir — the root
   `kungfu kfx install` populates.

Scanning goes two levels deep, so suite members nested under a suite
directory are found in the workspace layout.

## Install lifecycle

`kungfu kfx` manages installs for a home (source of truth:
[`../framework/core/src/python/kungfu/console/commands/kfx.py`](../framework/core/src/python/kungfu/console/commands/kfx.py)):

```sh
kungfu kfx install <tgz-or-directory>    # extract into <home>/extensions/<key>
kungfu kfx install <tgz> --force         # replace an existing install
kungfu kfx list [--json]                 # key, package, version, kind
kungfu kfx remove <key>                  # scoped to the managed install root
```

A double install without `--force` refuses; `remove` never touches paths
outside the install root. The CLI and the kfx-manager view operate on the
same facts.

Installed kfx currently run node-integrated — installing a kfx is trusting
it. The manifest's capability declaration is the seam for a future
sandboxed tier; the tier does not exist yet (see
[`../framework/gui/docs/shell-and-kfx.md`](../framework/gui/docs/shell-and-kfx.md),
evolution notes).

## Runtime extensions: current status

Earlier-generation runtime extensions — trading adapters (`td`/`md`),
operators, strategies — exist under [`../examples/`](../examples) with
their sources and manifests, but their build surface (`kfs extension
build`/`package`) predates the v4 SDK and is not provided by it. They are
kept as reference probes while their coverage role moves to neutral
replacements (see [`known-limits.md`](known-limits.md), "Reference
extensions are mid-migration"). The supported extension path today is the
view kfx documented above; this page will grow the runtime facets when
their v4 build chain lands, not before.

## Verified by

- [`../tests/fixtures/kfx-demo-scaffold/`](../tests/fixtures/kfx-demo-scaffold)
  — scaffold → build → pack → install → remove, from a clean directory,
  asserting the load contract on the produced bundle.
- [`../tests/fixtures/kfx-demo-install/`](../tests/fixtures/kfx-demo-install)
  — the managed lifecycle against a real shipped view package (double
  install refusal, `--force`, remove).

Both run in `verify --full` (fixture stage); a red fixture means this page
overclaims.
