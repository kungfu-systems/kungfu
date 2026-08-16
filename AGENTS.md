# AGENTS.md

This file orients coding agents (and people) working with this repository. It is
a router, not a duplicate: it points to the authoritative documents rather than
restating them.

## Start from the person's objective

Restate the requested outcome in one sentence, then choose the single matching
route. Do not inventory the repository or preload multiple routes "just in
case."

| Objective | First route |
| --- | --- |
| Use or operate an installed Kungfu | Read the curated [`docs/README.md`](docs/README.md); run `kungfu agent brief`, then `kungfu agent choose-mode --json`. |
| Explain or evaluate Kungfu as a whole | Follow the [`Agent Architecture Analysis Protocol`](docs/architecture/agent-analysis-protocol.md), then use the [`Evolution Map`](docs/evolution/README.md) to enter current authority. |
| Change one bounded component, behavior, or document | Read [`CONTRIBUTING.md`](CONTRIBUTING.md), then compile the verified task context below. |
| Promote or publish a release | Load the [version and release design](docs/development/version-release-design.md) and [publication closure](docs/development/publication-closure.md) before acting. |

Use the exhaustive [`docs/MAP.md`](docs/MAP.md) only to ground a specific claim
or locate authority not resolved by the selected route. Expand context when a
verified route reports an omission or the task actually crosses a boundary—not
because the repository contains more concepts.

## Rules that always apply

- Treat checked-in contracts, source, and current verification output as
  authority. README text, chat history, generated projections, and Agent output
  are routes or evidence, not authority by themselves.
- Keep the person's mental model task-sized. Do not export implementation
  vocabulary, subsystem count, or repository structure unless it changes the
  answer or the person asks for it.
- Use `./shifu` for every development, build, test, package, and documentation
  task. Do not invoke pnpm, node, conan, or cmake directly.
- Prefer the smallest change that preserves existing behavior and authority;
  read the affected source and tests before editing.
- Never include secrets, credentials, tokens, or private logs in code, commits,
  issues, or pull requests. Follow [`SECURITY.md`](SECURITY.md) for private
  vulnerability reporting.
- Do not create official integrations that scrape private provider sessions,
  bypass billing or quotas, or misrepresent usage attribution. See
  [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md).

## Load bounded context before changing the repository

Do not implement from this router, the first plausible file, or a guessed docs
route. In a source checkout, compile an Agent Task Chart for the exact task:

```sh
./shifu docs inventory --json
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
```

Choose a route declared by the inventory. Missing required context, stale
authority, ambiguity, or required omissions are blockers until resolved or
explicitly expanded. The Task Chart narrows inspection; it does not replace
source reading, tests, review, or user authority. Budget guidance lives in
[`docs/guides/xinfa-agent-context.md`](docs/guides/xinfa-agent-context.md).

An installed runtime can verify the precompiled documentation Atlas but cannot
compile a new route:

```sh
kungfu agent brief
kungfu agent docs --verify --json
kungfu agent docs --projection agent --json
```

Automatic Xinfa admission occurs only when a coordinator invokes the public
task-envelope and route-resolution contract and binds the returned roots. A Go
card or Episode alone does not trigger it.

## Execute and verify through Shifu

```sh docs-exec=shifu-version
./shifu --version
```

```sh
./shifu doctor       # environment facts and install pointers
./shifu sync         # frozen dependency installation
./shifu build        # full workspace build when the task requires it
./shifu check        # changed-scope quality gate
./shifu check:source # build-free source acceptance required by dev PRs
./shifu docs:check   # deterministic documentation contract gate
./shifu verify       # existing product/runtime artifact verification
```

The launcher bootstraps the pinned toolchain on first use. Full build, product,
cache, and packaging commands live in [`CONTRIBUTING.md`](CONTRIBUTING.md) and
the [`Shifu` documentation](docs/shifu/README.md); load them only when the task
needs them.

Use the narrowest applicable route:

| When the task changes… | Load and run… |
| --- | --- |
| Core ownership or a cross-layer boundary | [Architecture Overview](docs/architecture/overview.md), then `./shifu core:architecture --path <path> --json`; use `core:architecture:health` or `core:affected` only when relevant. |
| Documentation | [Documentation checks](CONTRIBUTING.md#documentation-checks); run `./shifu docs:check` and `./shifu docs:prose:required`. Do not enter native build or artifact lifecycles for a docs-only change. |
| A Primitive definition or admission | [Primitive Management Plane](docs/architecture/primitive-management-plane.md); begin with its incubation passport and `./shifu primitive:new`. |
| Fact or Episode invariants | [Invariant Verification](docs/qualification/invariant-verification.md); discover the registry with `./shifu invariant:verify -- --list --json`. |
| An ADR or load-bearing architecture decision | [`docs/adr/`](docs/adr/README.md) and the [metadata contract](docs/development/document-metadata.md); use `./shifu adr:audit -- --json`. |
| A release, promotion, or upgrade publication | [Version and Release Design](docs/development/version-release-design.md) plus [Publication Closure](docs/development/publication-closure.md); consume rooted candidate evidence rather than rebuilding conclusions at the tail. |
| Public branding, hosted use, or provider integration | [`TRADEMARK.md`](TRADEMARK.md), [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md), and [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md). |

## Completion and contribution boundary

- Run the smallest gate that proves the changed surface. `check:source` is the
  exact-revision development PR gate; runtime or product changes also require
  their qualified build/verification route.
- Documentation-only work runs documentation gates, not the native compiler
  matrix. External URL health remains a separate scheduled or explicit check.
- Open pull requests against the relevant `dev/*` channel branch. Preserve the
  PR template's `kungfu-adr-release:v1` manifest and declare the bounded ADR
  delivery state when applicable.
- Write English Conventional Commit messages and PR descriptions, and sign off
  every commit with the DCO. Full branch, review, and release rules remain in
  [`CONTRIBUTING.md`](CONTRIBUTING.md).
- When this router conflicts with a canonical document selected above, follow
  the canonical document and repair this route in the same change when needed.
