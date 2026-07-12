# AGENTS.md

This file orients coding agents (and people) working with this repository. It is
a router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Kungfu, or building it?

- **Using Kungfu** — install it, inspect / replay / rewind Episodes, or operate
  it: start at the curated documentation guide,
  [`docs/README.md`](docs/README.md). Use the exhaustive
  [`docs/MAP.md`](docs/MAP.md) when you need to ground one specific question or
  claim. In an installed runtime, agents should first
  read the local pack with `kungfu agent brief` and choose a mode with
  `kungfu agent choose-mode --json`.
- **Building or contributing to this repo** — read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Building this repo

One entrypoint runs every task under the pinned toolchain. Do not invoke pnpm,
node, conan, or cmake directly — go through it:

```sh
./shifu doctor    # check the development environment (install pointers)
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

There is nothing to preinstall beyond `curl`: on first run `./shifu`
bootstraps the pinned toolchain automatically (node via
[fnm](https://github.com/Schniz/fnm) and `.node-version`, python via
[uv](https://docs.astral.sh/uv/), and Buildchain via `.buildchain-version`) into
`~/.cache/kungfu`. An fnm / uv you
already have on PATH is used as-is; Buildchain remains pin-first. See
[`docs/rust-adoption.md`](docs/rust-adoption.md) for how the launcher works.
For versioned cache policy and machine-readable schema discovery, see
[`docs/shifu/`](docs/shifu/).

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full toolchain, repository
layout, and code style.

## Checking your work is green

```sh
./shifu check           # changed-scope lint, typecheck and unit/tooling tests
./shifu verify          # assert existing build artifacts (quick)
./shifu verify --full   # rebuild + freeze, then assert (slow; needs the full toolchain)
./shifu docs:check      # deterministic Markdown, local-link, anchor, and docs-contract gate
./shifu docs:prose      # advisory vocabulary and load-bearing prose policy
```

`check` is the source-quality gate for changed files plus shared type/tooling
tests. `check:all` exists for whole-tree cleanup once the lint baseline is clean.
`verify` is the runtime/product done-check: it asserts the build artifacts and
runs a `kungfu` runtime smoke plus the `mvp-smoke-v1` Episode qualification,
rather than trusting a "looks built" impression. The larger Episode baseline
remains an explicit periodic/release-readiness command:

```sh
./shifu episode:qualify:release
```

It emits a self-contained evidence envelope; it is not a per-PR gate.

`docs:check` is the same deterministic gate used by documentation pull
requests and pre-commit checks. It also verifies that the public Vocabulary
reference matches its machine-readable registry. `docs:prose` projects the
registry into Vale and reports both required rules and advisory terminology or
claim-language findings; CI blocks only on `docs:prose:required`. Network-dependent
URL validation remains separate in `docs:check:external`, and CI runs the same
Lychee configuration on a schedule.

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
- [`docs/README.md`](docs/README.md), [`docs/MAP.md`](docs/MAP.md), and
  [`CONTRIBUTING.md`](CONTRIBUTING.md) route to the relevant sources of truth;
  when this summary and a canonical document disagree, follow the canonical
  document.
