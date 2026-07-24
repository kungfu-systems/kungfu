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

## Load verified context before implementation

Do not treat this router, a README, chat history, or the first plausible file
as complete task context. In a source checkout, compile a bounded Agent Task
Chart from the current documentation Atlas before changing code or prose:

```sh
./shifu docs inventory --json
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
```

Choose the route from the inventory's declared Agent routes; do not guess it.
Current measured complete budgets and route-selection examples are in
[`docs/guides/xinfa-agent-context.md`](docs/guides/xinfa-agent-context.md).
Required omissions, stale authority, an ambiguous route, or a failed Atlas
verification are blockers: resolve or explicitly expand them before acting.
The Task Chart narrows what to inspect; it does not replace repository rules,
source reading, tests, review, or user authority.

An installed runtime has no compiler or selector. It can verify and read the
precompiled documentation Atlas, and exposes the exact boundary locally:

```sh
kungfu agent brief
kungfu agent docs --json
kungfu agent docs --verify --json
kungfu agent docs --projection agent --json
```

Automatic Xinfa admission exists only when the active work coordinator invokes
the public task-envelope and route-resolution contract and binds the resulting
roots. Merely writing a Go card or an Episode does not trigger Xinfa.

## Building this repo

One entrypoint runs every task under the pinned toolchain. Do not invoke pnpm,
node, conan, or cmake directly — go through it:

```sh docs-exec=shifu-version
./shifu --version
```

```sh
./shifu doctor    # check the development environment (install pointers)
./shifu sync      # install JS dependencies (frozen lockfile)
./shifu build     # build all workspaces (C++ core + bindings + app)
./shifu rebuild   # clear generated build outputs, then run build
./shifu check     # changed-scope read-only quality gate (lint/type/tests)
./shifu check:source # build-free source gate used by every dev pull request
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
[`docs/development/rust-adoption.md`](docs/development/rust-adoption.md) for how the launcher works.
For versioned cache policy and machine-readable schema discovery, see
[`docs/shifu/`](docs/shifu/). When a controller projects both
`SHIFU_CACHE_PROFILE_REF` and `SHIFU_CACHE_PROFILE_DIGEST`, ordinary
`./shifu <task>` invocations automatically resolve and apply that profile once;
the explicit `./shifu cache ...` control surface remains outside the wrapper.
Use `./shifu cache status` for local-only inspection and
`./shifu cache doctor [--probe]` for resolution and optional reachability;
`cache use/unset` are dry-run unless `--execute` is explicit.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full toolchain, repository
layout, and code style.

## Checking your work is green

```sh
./shifu check           # changed-scope lint, typecheck and unit/tooling tests
./shifu check:source    # GitHub-hosted source acceptance; no build or artifacts
./shifu core:architecture --path <repo-relative-path> # locate owner, targets, tests, docs and review route
./shifu core:architecture --capability <name> --json # stable machine-readable architecture query
./shifu core:architecture:health # inspect structural health budgets and ratchets
KUNGFU_BUILD_PROFILE=embedded-sqlite ./shifu rebuild:core # select one supported trimmed Core closure
./shifu core:affected -- --base <base> --head <head> --json # explain the native PR closure
./shifu verify          # assert existing build artifacts (quick)
./shifu verify --full   # rebuild + freeze, then assert (slow; needs the full toolchain)
./shifu docs:check      # deterministic Markdown, local-link, anchor, and docs-contract gate
./shifu docs validate --json # inspect the project-independent Documentation Protocol submission
./shifu docs:prose      # advisory vocabulary and load-bearing prose policy
./shifu adr:audit       # inspect all ADR lifecycle, evidence, and release debt
./shifu invariant:verify -- --list --json # discover authoritative Fact/Episode invariants, checker routes, and residual risk
```

`check:source` is the required development-PR gate: it checks the exact source
revision on GitHub-hosted Linux and never enters compiler, build, artifact, or
release lifecycles. `check` remains the broader local changed-scope gate with
shared unit/tooling tests. `check:all` exists for whole-tree cleanup once the
lint baseline is clean.
`verify` is the runtime/product done-check: it asserts the build artifacts and
runs a `kungfu` runtime smoke plus the `mvp-smoke-v1` Episode qualification,
rather than trusting a "looks built" impression. The larger Episode baseline
remains an explicit periodic/release-readiness command:

```sh
./shifu episode:qualify:release
```

It emits a self-contained evidence envelope; it is not a per-PR gate.

Invariant work starts from `./shifu invariant:verify -- --list --json`. The
registry points to Fact/Episode authority by content-addressed JSON pointer;
do not copy domain semantics into a new checker or workflow. The safe default
runner executes source binding only. Native/runtime layers are explicit, and a
missing prerequisite is `unqualified`, never a skipped pass.

Primitive work starts at the incubation passport, never at a hand-maintained
catalog or an ad hoc contract. Read
[`docs/architecture/primitive-management-plane.md`](docs/architecture/primitive-management-plane.md),
plan birth with `./shifu primitive:new -- --id <id> --name <name> --layer
<layer>`, and run `./shifu check:primitive-catalog`. Machine-readable Primitive
artifacts are detected repository-wide by their schema and `primitiveId`; a
different directory does not bypass governance.

`docs:check` is the same deterministic gate used by documentation pull
requests and pre-commit checks. It also verifies that the public Vocabulary
reference matches its machine-readable registry. `docs:prose` projects the
registry into Vale and reports both required rules and advisory terminology or
claim-language findings; CI blocks only on `docs:prose:required`. Network-dependent
URL validation remains separate in `docs:check:external`, and CI runs the same
Lychee configuration on a schedule.

Core `KF-ADR-<UUIDv7>` and Shifu `SHIFU-ADR-<UUIDv7>` records share the
canonical [`docs/adr/`](docs/adr/) authority and exactly the same machine gates.
Create them offline with `./shifu adr:new -- --owner kungfu|shifu --title
"..."`; the filename is the complete identity plus `.md`, with readable wording
kept in headings and link labels. Do not allocate a sequence number, edit a
shared identity index, or introduce a parser for the retired sequential scheme.
Run
`./shifu adr:audit -- --json` for the complete status inventory,
`--strict` to fail on review/evidence debt, or `--release stable` to exercise
the stable-admission obligation without publishing a release.

## Proposing changes

- Open pull requests against the relevant `dev/*` channel branch (see
  [`CONTRIBUTING.md`](CONTRIBUTING.md) → "Branches, pull requests & releases").
- Preserve the PR template's `kungfu-adr-release:v1` manifest. A feature PR must
  declare a bounded `stage-ready` or `implemented` delivery against accepted
  ADRs; do not use commit messages as implementation authority. Alpha and
  stable promotion semantics live in
  [`docs/development/version-release-design.md`](docs/development/version-release-design.md).
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
