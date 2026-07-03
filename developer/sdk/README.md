# @kungfu-tech/sdk

SDK for assembling Kungfu applications.

The platform model (see `framework/core/docs/adr/ADR-0006` and `ADR-0011`):
the core provides capability — typed, in-process, zero-copy access to runtime
data — and applications are thin shells over it. This package scaffolds such
an application on the reference stack (electron-vite + React + TypeScript +
biome), wired to load the native binding the same way the reference GUI does.

## Usage

```sh
kfs create app my-app          # scaffold into ./my-app
cd my-app
pnpm install
pnpm dev                       # launch against a built @kungfu-tech/core
```

It also scaffolds view extensions (kfx) — installable view packages the
reference shell discovers and mounts (see `docs/extensions.md` in the
repository root for the contract):

```sh
kfs create extension my-view   # scaffold into ./my-view
cd my-view
pnpm install
pnpm build                     # kfs kfx build → dist/view/index.js
npm pack                       # the tgz installs via `kungfu kfx install`
```

Options (both `create` targets):

- `--name <name>` — product/view name (defaults to the directory basename).
- `--workspace` — wire platform dependencies as `workspace:*` when
  scaffolding inside the monorepo.

The generated app is self-contained: `pnpm pack` produces a distributable
bundle with the kungfu runtime under `Resources/kungfu`.
