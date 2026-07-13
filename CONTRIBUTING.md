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

- A compiler in the native matrix (Apple Clang on macOS, GCC on Linux, MSVC on
  Windows) and [CMake](https://cmake.org/) >= 3.28. Linux Clang and Windows
  clang-cl are secondary qualification compilers. Exact floors live only in
  [`toolchain.contract.json`](toolchain.contract.json).
- [Conan 2](https://conan.io/) for C++ dependencies

Everything else is resolved by the `./shifu` entrypoint: node (via
[fnm](https://github.com/Schniz/fnm) and the checked-in `.node-version`), the
package manager (pnpm via Corepack), and the Python environment (via
[uv](https://docs.astral.sh/uv/)), plus the Buildchain binary pinned by
`.buildchain-version`. They are bootstrapped automatically when needed. User
fnm / uv installations remain eligible; Buildchain is pin-first so a global
version cannot silently replace the repository's reproducible build input. If
the local or runner controller projects `SHIFU_CACHE_PROFILE_REF` together with
`SHIFU_CACHE_PROFILE_DIGEST`, ordinary `./shifu <task>` commands automatically
run under that resolved cache profile. Public clones with neither value keep
the normal upstream path; partial projection fails closed.

Run `./shifu doctor` to check your environment: it reports every required
tool with a version line or an install pointer (and exits non-zero when a
required tool is missing, so it can gate scripts).
Use `./shifu doctor --json` when a machine-readable compiler/CMake/Ninja/Conan
fact record is needed. See [`docs/cpp-toolchain.md`](docs/cpp-toolchain.md).
For projected dependency caches, run `./shifu cache status` first; use
`./shifu cache doctor --probe` only when active endpoint checks are intended.
Local `cache use/unset` changes are dry-run unless `--execute` is supplied and
never overwrite an inventory-controller block.

## Repository layout

Kungfu is a pnpm-workspaces monorepo. See [`docs/architecture.md`](docs/architecture.md)
for how the layers fit together; the main areas:

- `framework/core` — the C++ core (`yijinjing` journal, storage semantics, and
  runtime schema) plus its Python and Node (N-API) bindings and the `kungfu`
  runtime, packaged as `@kungfu-tech/core`. Build orchestration lives in
  `framework/core/.gyp/`.
- `framework/api` — the capability SDK (typed access to journal / state / replay).
- `framework/gui`, `framework/tui` — the two reference UIs: a desktop GUI
  (Electron + React) and a terminal TUI.
- `developer/sdk` — the application / extension SDK (`kungfu sdk`); `developer/toolchain`
  — shared build dependencies.
- `extensions/*` — kfx extensions; `examples/*` — samples.
- `product` — the dogfood product assembly bundling the runtime, reference UIs,
  SDK, first-party kfx, desktop installers, and CLI archives.
- `crates` — the Rust workspace: self-contained native tools consumed as
  prebuilt binaries, currently the native `shifu` launcher. See
  [`docs/rust-adoption.md`](docs/rust-adoption.md) for when (and when not) a
  component belongs here.

Two command-line entry points, kept forward-compatible:

- `kungfu` — the end-user CLI command (`kungfu --version`, `query`, `storage`,
  …). It fronts the `kungfu` runtime.
- `./shifu` — the development/build orchestrator used while working on the
  repo (see below).

## Toolchain & build

`./shifu` (`shifu.cmd` on Windows) is the build opener: every task runs
under the toolchain the repo pins — node via [`fnm`](https://github.com/Schniz/fnm)
and the checked-in `.node-version`, python via [`uv`](https://docs.astral.sh/uv/).
There is nothing to preinstall beyond `curl`: on first run the launcher
bootstraps pinned prebuilt fnm / uv into `~/.cache/kungfu` when they are not
already on PATH (your own installs are used as-is).

```sh
git clone git@github.com:kungfu-systems/kungfu.git
cd kungfu

./shifu sync          # install JS dependencies (frozen lockfile)
./shifu build         # build all workspaces (C++ core + bindings + app)
./shifu rebuild       # remove generated build outputs, then build
./shifu check         # changed-scope read-only quality gate
./shifu fix           # explicit formatting / safe auto-fixes for changed files
./shifu product gui dev # run the reference GUI dev loop
./shifu product tui dev # run the reference TUI dev loop
./shifu product cli dist # build the CLI product archive
./shifu dist          # rebuild core, freeze, build bundled products under product/release
./shifu app           # launch the desktop app
```

`./shifu <task>` runs `<task>` under the pinned Node toolchain — it is a
thin wrapper, so any pnpm task works (`./shifu build:core`, etc.).

Shifu also marks child tasks with `SHIFU_ENTRYPOINT=1`. Participant-facing root
tasks reject accidental direct package-manager invocation and print the
equivalent `./shifu <task>` command. This marker is provenance, not a security
boundary; do not set it by hand to bypass the launcher. The repository check
also rejects direct `pnpm`, Node, Conan, or CMake commands in agent guidance,
contributor docs, Buildchain lifecycle configuration, and ordinary workflows.
Launcher implementation/bootstrap exceptions must be narrow and carry a
preceding `shifu-entry-contract: allow <reason>` comment.

`./shifu verify` includes the bounded `mvp-smoke-v1` Episode
qualification by default. Use `./shifu episode:qualify -- --profile
mvp-baseline-v1` explicitly for the heavier periodic/release-readiness
baseline. `./shifu episode:qualify:release` runs that complete baseline and
seals its TrustReport into retained release evidence. The release-evidence
path runs on alpha/release candidates and manual Build workflow dispatches, not
on every development pull request.

> Node, packages, and Electron binaries are resolved through the standard
> `FNM_NODE_DIST_MIRROR`, `COREPACK_NPM_REGISTRY`, and `ELECTRON_MIRROR`
> environment variables; set these to point at a specific mirror if needed.
> For generated development/runner cache profiles and the versioned contract,
> see [`docs/shifu/`](docs/shifu/).

## Code style

Formatting and linting are part of the pre-commit, ready/PR, and CI flow:

- **C++** — `clang-format` (config in `.clang-format`).
- **Python** — [`ruff`](https://docs.astral.sh/ruff/) for both formatting
  (`ruff format`) and linting (`ruff check`). Config in
  `framework/core/pyproject.toml` under `[tool.ruff]`.
- **JavaScript / TypeScript** — Prettier / ESLint (per workspace).

Run formatting before committing:

```sh
./shifu format        # all languages
./shifu fix           # format + safe lint fixes for changed files
./shifu check         # read-only changed-scope lint/type/test gate
```

The installed pre-commit hook runs `./shifu check:staged` semantics via
Node: it checks staged files without rewriting or re-staging them. If the hook
reports formatting or fixable lint issues, run `./shifu fix:staged`, review
the diff, and commit again. CI should run `./shifu check` and the relevant
build or verify command. `check:all` and `fix:all` are available for deliberate
whole-tree lint-baseline cleanup.

### Documentation checks

Documentation has a deterministic gate separate from network-dependent URL
health:

```sh
./shifu docs:check          # Markdown structure, local graph, topology, and vocabulary registry
./shifu docs:check:readonly # same gate with lock-keyed tools outside the checkout
./shifu docs:prose          # full advisory + required prose policy through Vale
./shifu docs:prose:required # objective prose rules that block pull requests
./shifu docs:check:external # external URLs through Lychee (local Lychee or Docker required)
```

`docs:check` runs in pre-commit and documentation pull requests. Opt-in fences
marked `docs-exec=<stable-id>` are welded to bounded argv/timeout/output
contracts in `docs.contract.json`; unregistered or drifting examples fail, and
the registered commands execute without a shell. The same contract declares
publication roots and governed paths, so an unreachable public page or stale
orphan exception also fails.

It checks the
whole Markdown graph so deleting or renaming a target cannot evade a
changed-file filter. The intentionally small Markdownlint rule baseline lives
in `.markdownlint-cli2.mjs`; do not enable a style rule by rewriting unrelated
documents. `docs.contract.json` owns only required documents and navigation
pointers. [`docs/document-metadata.contract.json`](docs/document-metadata.contract.json)
routes each governed document to inline, registry, or external metadata;
[`docs/document-metadata.registry.json`](docs/document-metadata.registry.json)
keeps public entry and guide metadata out of the rendered page. The same gate
makes ADR body/index status and immutable implementation references checked
projections of ADR metadata; see
[`docs/document-metadata.md`](docs/document-metadata.md). GitHub issue templates
and Kungfu Skills retain their independently consumed frontmatter schemas.
[`docs/vocabulary.registry.json`](docs/vocabulary.registry.json) is
the executable source for canonical term spelling and layers, governed public
files, retired wording, preferred terminology, and load-bearing claim guards.
The deterministic check verifies that its core terms remain aligned with
[`docs/vocabulary.md`](docs/vocabulary.md).

Vale configuration is generated into a temporary directory from that registry;
there is no committed second copy of the prose rules. `docs:prose:required`
enforces objective `error` rules. `docs:prose` also reports `warning` rules, but
those remain advisory while maintainers qualify their false-positive rate.
Both commands run Vale 3.14.2 through the immutable multi-platform container
digest in `docs/toolchain.contract.json`. Advisory runs emit line annotations,
a GitHub job summary, and an optional `KUNGFU_VALE_REPORT` JSON report. Rule
metadata records stable ids and promotion evidence; an error rule is rejected
unless it is required, has a negative fixture, and declares a clean baseline.

`docs:check:readonly` installs only the lock-derived documentation modules into
`~/.cache/kungfu/docs-tools/<digest>` (or `KUNGFU_DOCS_TOOL_CACHE`) and proves
that the checkout status is unchanged. Documentation workflows remain on one
GitHub-hosted Ubuntu runner; they do not consume the native Buildchain matrix.
The toolchain contract also pins every documentation Action by commit SHA and
records Vale release-archive checksums for audited non-container distribution.

External sites are nondeterministic, so they do not block pull requests. The
scheduled `Docs External Links` workflow runs the pinned Lychee release with
`lychee.toml`; `./shifu docs:check:external` uses the same config through a
local Lychee binary or its pinned Docker image.

### Scripts are JavaScript

The project is managed by pnpm and runs on every platform pnpm runs on —
Windows included. So **automation scripts are Node/JavaScript (`.mjs`/`.js`),
not shell** (`.sh`): shell scripts do not run on Windows and reintroduce a bash
dependency the toolchain does not otherwise need. Test fixtures and capability
slices use a `run.mjs` driver (shared helpers in `tests/fixtures/_harness.mjs`
and `framework/core/slices/_harness.mjs`); the verification gate
(`scripts/verify.mjs`) runs them through Node and **fails if a `.sh` reappears**
anywhere in the tree (`stage 0a: no-bash script guard`, shared with the
pre-commit hook via `scripts/no-bash-guard.mjs`). Prefer
pure Node (`node:child_process`, `fs`, `os`, `crypto`) over shelling out to
platform tools (`grep`, `mktemp`, `shasum`, …).

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
- Keep exactly one `kungfu-adr-release:v1` block from the pull-request
  template. Feature branches must declare `stage-ready` or `implemented`
  delivery intent and reference accepted ADRs; fixes and chores with no
  architecture impact use `adr-neutral` with a reason. This declares delivery
  scope, not semantic-version impact.
- Merging into `alpha/*` and `release/*` triggers the version-bump and release
  workflows, which tag the release and move the moving major tag.
- See [`docs/version-release-design.md`](docs/version-release-design.md) for the
  rationale behind versioning and the dev/alpha/stable ADR admissibility
  contract. Alpha promotions settle changed ADR progress after full Buildchain
  qualification. Stable promotions block every unimplemented or unqualified
  accepted ADR unless the exact release carries an explicitly reviewed admin
  waiver.

## License

By contributing you agree that your contributions are licensed under the
project's [Apache License 2.0](LICENSE). Kungfu uses the Developer Certificate
of Origin (DCO) and does not require a Contributor License Agreement (CLA).

See [LICENSE-POLICY.md](LICENSE-POLICY.md) for details.
