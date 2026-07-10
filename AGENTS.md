# AGENTS.md

This file orients coding agents (and people) working with this repository. It is
a router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Kungfu, or building it?

- **Using Kungfu** — install it, capture / inspect / replay a run, operate it:
  start at the documentation map, [`docs/MAP.md`](docs/MAP.md). It routes any
  question ("what does it guarantee", "how do I localize a failure", "what is the
  journal / replay model") to the document that answers it, and is written to be
  read by both people and agents. In an installed runtime, agents should first
  read the local pack with `kungfu agent brief` and choose a mode with
  `kungfu agent choose-mode --json`.
- **Building or contributing to this repo** — read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Building this repo

One entrypoint runs every task under the pinned toolchain. Do not invoke pnpm,
node, conan, or cmake directly — go through it:

```sh
./shifu sync      # install JS dependencies (frozen lockfile)
./shifu build     # build all workspaces (C++ core + bindings + app)
./shifu rebuild   # clear generated build outputs, then run build
./shifu check     # changed-scope read-only quality gate (lint/type/tests)
./shifu fix       # explicit formatting / safe auto-fixes for changed files
./shifu product gui dev   # run the reference GUI through the product loop
./shifu product cli dist  # build the CLI product archive
./shifu dist      # build distributable products under product/release
./shifu <task>    # any pnpm task, run under the pinned node
```

One-time prerequisites (install once; node, the package manager, and the Python
interpreter then resolve automatically):

- [fnm](https://github.com/Schniz/fnm) — pins node via `.node-version`
- [uv](https://docs.astral.sh/uv/) — manages the Python toolchain

On a machine without them, `./shifu` bootstraps pinned prebuilt copies
automatically (nothing needed beyond `curl`); see
[`docs/rust-adoption.md`](docs/rust-adoption.md).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full toolchain, repository
layout, and code style.

## Checking your work is green

```sh
./shifu check           # changed-scope lint, typecheck and unit/tooling tests
./shifu verify          # assert existing build artifacts (quick)
./shifu verify --full   # rebuild + freeze, then assert (slow; needs the full toolchain)
```

`check` is the source-quality gate for changed files plus shared type/tooling
tests. `check:all` exists for whole-tree cleanup once the lint baseline is clean.
`verify` is the runtime/product done-check: it asserts the build artifacts and
runs a `kungfu` runtime smoke plus the `mvp-smoke-v1` Episode qualification,
rather than trusting a "looks built" impression. The larger Episode baseline
remains an explicit periodic/release-readiness command.

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch (see
  [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Branches, pull requests & releases").
- Write commit messages and PR descriptions in English, using lightweight
  [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`).
- Sign off every commit with the DCO: `git commit -s`.
- Bugs, feature requests, questions, and documentation issues go through GitHub
  issues; security vulnerabilities use private vulnerability reporting — see
  [`SECURITY.md`](SECURITY.md).
- Brand, hosted-service, and upstream-provider boundaries are documented in
  [`TRADEMARK.md`](TRADEMARK.md), [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md), and
  [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md).

## Ground rules

- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests.
- Do not build or document official integrations that scrape private provider
  sessions, bypass provider billing or quota systems, or misrepresent usage
  attribution.
- Prefer the smallest change that holds, and keep documentation in sync with
  behavior.
- [`docs/MAP.md`](docs/MAP.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) are the
  sources of truth; when this summary and they disagree, follow them.
