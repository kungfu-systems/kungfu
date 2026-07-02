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

Options:

- `--name <name>` — product name (defaults to the directory basename).
- `--workspace` — wire platform dependencies as `workspace:*` when
  scaffolding inside the monorepo.

The generated app is self-contained: `pnpm pack` produces a distributable
bundle with the kungfu runtime under `Resources/kfc`.
