# AGENTS.md

This file orients coding agents (and people) working with this repository. It is
a router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Are you using Kungfu, or building it?

- **Using Kungfu** — install it, capture / inspect / replay a run, operate it:
  start at the documentation map, [`docs/MAP.md`](docs/MAP.md). It routes any
  question ("what does it guarantee", "how do I localize a failure", "what is the
  journal / replay model") to the document that answers it, and is written to be
  read by both people and agents.
- **Building or contributing to this repo** — read the rest of this file, then
  [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Building this repo

One entrypoint runs every task under the pinned toolchain. Do not invoke pnpm,
node, conan, or cmake directly — go through it:

```sh
./kungfu-code sync      # install JS dependencies (frozen lockfile)
./kungfu-code build     # build all workspaces (C++ core + bindings + app)
./kungfu-code <task>    # any pnpm task, run under the pinned node
```

One-time prerequisites (install once; node, the package manager, and the Python
interpreter then resolve automatically):

- [fnm](https://github.com/Schniz/fnm) — pins node via `.node-version`
- [uv](https://docs.astral.sh/uv/) — manages the Python toolchain

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full toolchain, repository
layout, and code style.

## Checking your work is green

```sh
./kungfu-code verify          # assert existing build artifacts (quick)
./kungfu-code verify --full   # rebuild + freeze, then assert (slow; needs the full toolchain)
```

`verify` is the single done-check: it asserts the build artifacts and runs a
`kungfu` runtime smoke, rather than trusting a "looks built" impression.

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

## Ground rules

- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests.
- Prefer the smallest change that holds, and keep documentation in sync with
  behavior.
- [`docs/MAP.md`](docs/MAP.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md) are the
  sources of truth; when this summary and they disagree, follow them.
