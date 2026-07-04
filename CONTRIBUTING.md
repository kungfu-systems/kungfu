# Contributing to Kungfu

Thanks for your interest in Kungfu. This guide covers how to build the project,
the coding conventions, and how changes are proposed and released.

## Feedback, questions & security

All project contact happens through GitHub — there is no email support channel.

- **Bugs, feature requests, questions, documentation issues** — open a
  [GitHub issue](https://github.com/kungfu-systems/kungfu/issues/new/choose).
- **Code and documentation changes** — open a pull request (see below).
- **Security vulnerabilities** — report them privately, never in a public issue.
  See [`SECURITY.md`](SECURITY.md).

Please do not include secrets, credentials, tokens, private logs, or other
sensitive material in issues or pull requests.

## Prerequisites

- A C++20 toolchain and [CMake](https://cmake.org/) (>= 3.15)
- [Conan 2](https://conan.io/) for C++ dependencies
- [fnm](https://github.com/Schniz/fnm) (Node is pinned via `.node-version`)
- [uv](https://docs.astral.sh/uv/) for the Python environment

Node, the package manager (pnpm via Corepack), and the Python interpreter are
resolved automatically once `fnm` and `uv` are installed.

## Repository layout

Kungfu is a pnpm-workspaces monorepo. See [`docs/architecture.md`](docs/architecture.md)
for how the layers fit together; the main areas:

- `framework/core` — the C++ core (`longfist` type system, `yijinjing` journal
  runtime) plus its Python and Node (N-API) bindings and the `kungfu` runtime,
  packaged as `@kungfu-tech/core`. Build orchestration lives in
  `framework/core/.gyp/`.
- `framework/api` — the capability SDK (typed access to journal / state / replay).
- `framework/gui`, `framework/tui` — the two reference UIs: a desktop GUI
  (Electron + React) and a terminal TUI.
- `developer/sdk` — the application / extension SDK (`kungfu sdk`); `developer/toolchain`
  — shared build dependencies.
- `extensions/*` — kfx extensions; `examples/*` — samples.
- `artifact` — the dogfood installer bundling the runtime, reference UIs and SDK.

Two command-line entry points, kept forward-compatible:

- `kungfu` — the end-user CLI command (`kungfu --version`, journal subcommands,
  …). It fronts the `kungfu` runtime.
- `./kungfu-code` — the development/build orchestrator used while working on the
  repo (see below).

## Toolchain & build

The repo pins its Node version via [`fnm`](https://github.com/Schniz/fnm) and a
checked-in `.node-version`, and manages the Python environment with
[`uv`](https://docs.astral.sh/uv/). You only need to install `fnm` and `uv` once;
Node, the package manager, and the Python interpreter are then resolved automatically.

```sh
# one-time: install fnm and uv (e.g. `brew install fnm uv`)

git clone git@github.com:kungfu-systems/kungfu.git
cd kungfu

./kungfu-code sync          # install JS dependencies (frozen lockfile)
./kungfu-code build         # build all workspaces (C++ core + bindings + app)
./kungfu-code freeze        # produce the standalone kungfu bundle
./kungfu-code build:app     # build the desktop app bundle
./kungfu-code app           # launch the desktop app
```

`./kungfu-code <task>` runs `<task>` under the pinned Node toolchain — it is a
thin wrapper, so any pnpm task works (`./kungfu-code build:core`, etc.).

> Node, packages, and Electron binaries are resolved through the standard
> `FNM_NODE_DIST_MIRROR`, `COREPACK_NPM_REGISTRY`, and `ELECTRON_MIRROR`
> environment variables; set these to point at a specific mirror if needed.

## Code style

Formatting and linting are part of the pre-build flow and CI:

- **C++** — `clang-format` (config in `.clang-format`).
- **Python** — [`ruff`](https://docs.astral.sh/ruff/) for both formatting
  (`ruff format`) and linting (`ruff check`). Config in
  `framework/core/pyproject.toml` under `[tool.ruff]`.
- **JavaScript / TypeScript** — Prettier / ESLint (per workspace).

Run formatting before committing:

```sh
./kungfu-code format        # all languages
```

## Commit messages

- Write commit messages and pull request descriptions in **English**.
- Follow lightweight [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`), e.g. `fix(core): handle empty journal page`.
- Sign every commit with the Developer Certificate of Origin (DCO):

```sh
git commit -s -m "fix(core): handle empty journal page"
```

The sign-off adds a line like:

```text
Signed-off-by: Your Name <you@example.com>
```

Pull requests are checked automatically; every commit must include this line.

## Branches, pull requests & releases

Development happens on channel branches per version line, promoted by pull
request:

```
dev/<major>/<version>  →  alpha/<major>/<version>  →  release/<major>/<version>
```

- Open pull requests against the relevant `dev/*` branch.
- Merging into `alpha/*` and `release/*` triggers the version-bump and release
  workflows, which tag the release and move the moving major tag.
- See [`docs/version-release-design.md`](docs/version-release-design.md) for the
  rationale behind the versioning and release mechanism.

## License

By contributing you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE). Kungfu uses the Developer Certificate
of Origin (DCO) and does not require a Contributor License Agreement (CLA).

See [LICENSE-POLICY.md](LICENSE-POLICY.md) for details.
