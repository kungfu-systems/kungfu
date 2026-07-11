# Kungfu

<!-- buildchain:badges:start -->
[![KFD-1: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-1/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![KFD-2: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-2/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![KFD-3: declared](https://buildchain.libkungfu.dev/badges/v1/kfd-3/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![Buildchain Release Passport: declared](https://buildchain.libkungfu.dev/badges/v1/buildchain-release-passport/declared.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-0969da.svg)](https://github.com/kungfu-systems/kungfu/blob/HEAD/LICENSE)
[![Platform: macOS | Linux | Windows](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-6e7781.svg)](https://github.com/kungfu-systems/kungfu/releases/latest/download/buildchain.release.json)
[![Buildchain Validate](https://github.com/kungfu-systems/kungfu/actions/workflows/buildchain-validate.yml/badge.svg)](https://github.com/kungfu-systems/kungfu/actions/workflows/buildchain-validate.yml)
[![DCO](https://github.com/kungfu-systems/kungfu/actions/workflows/dco.yml/badge.svg)](https://github.com/kungfu-systems/kungfu/actions/workflows/dco.yml)
<!-- buildchain:badges:end -->

![Status: Coming soon](https://img.shields.io/badge/status-coming%20soon-orange.svg)

Kungfu is an open-source monorepo for real-world agent work: a local-first,
journal-first runtime for recording facts, replaying work, and building
verifiable agent-facing applications.

The user-facing desktop and CLI distributions are released as Kungfu Episodes.
The repository, runtime, command, SDKs, and extension system use the Kungfu,
libkungfu, and kfx names.

Facts before trust. In KFD terms, a load-bearing claim should never stand
alone: bind it to a verifiable source, artifact, manifest, or runtime receipt.
([KFD](https://kfd.libkungfu.dev/); [design philosophy](docs/design-philosophy.md);
[facts before trust](docs/facts-before-trust.md).)

Public entrypoints:

- Product home: <https://kungfu.tech>
- Developer and agent map: <https://libkungfu.dev>
- Source and open monorepo: this repository

## Use only what you need

You do **not** have to adopt the whole Kungfu App. Start with the smallest
product that closes your job: the `.kungfu` format, `libkungfu`, one language
SDK, the standalone CLI/TUI, the GUI, or the assembled App. Higher layers add
convenience; they do not become the exclusive authority over your facts.

See [**Choose your Kungfu**](docs/choose-your-kungfu.md) for the user-facing
decision guide and [`docs/product-layers.md`](docs/product-layers.md) for the
qualification contract behind it. Kungfu is currently **Coming soon**, so the
guide names staged artifacts explicitly rather than implying every package is
already released.

The product goal is to make fact-first responsibility the path of least
resistance: once a user starts relying on Kungfu, the natural way to use it
should be to inspect facts, understand responsibility, and make control
decisions from local proof rather than from opaque claims.

The commercial product surface is prepared in this repository as part of the
same open-source monorepo. Public release artifacts use the Kungfu Episodes
name; the underlying runtime and developer-facing surfaces remain Kungfu.

At its core is a low-latency, append-only event journal with one declared schema
authority per structured fact: fixed-layout Hana POD for the closed kernel and
FlatBuffers for the open/domain layer. Closed journal records are exposed
zero-copy to C++, Python, and Node. Kungfu offers these capabilities — the
journal, in-process state, and deterministic replay — as a foundation (SDK) to
build on, and ships a minimal reference application built on that foundation.

Originally created for trading execution, the core is general: anything that
needs to capture, share, and faithfully replay high-frequency event streams.

## Core ideas

- **Journal-first data plane** — one append-only event log
  ([`yijinjing`](framework/core)) and two declared schema substrates: the
  `kungfu/yijinjing/schema` Hana closed set for kernel facts, and `.fbs` for
  open/domain facts. Every component consumes the same frame protocol rather
  than inventing a language-local fact format.
- **Zero-copy, multi-language runtime** — the same in-process journal data is
  shared across C++, Python, and Node (N-API) without serialization on the hot
  path.
- **Deterministic replay** — live and replay run on the same runtime and the
  same journal semantics, so recorded streams replay with high precision rather
  than through a separate engine.

## Build on it

Kungfu is meant to be a base others build on, not a single fixed application:

- **Capabilities SDK** — consume journal / state / replay from your own code in
  C++, Python, or Node.
- **Extension points** — add features and UI to a Kungfu application.
- **Application SDK** — assemble a complete application on top of Kungfu, with
  Kungfu as the underlying dependency.

The repository ships the core plus a minimal reference application that
demonstrates and exercises these capabilities.

## The toolchain comes with the runtime

A guiding principle of kungfu is that the machine adapts to the person, not the
other way around. The `kungfu` runtime is batteries-included: it embeds a Python
and a Node runtime and brings a full Python development lifecycle — dependency
management, formatting, and ahead-of-time compilation — reachable through
`kungfu engage`. Building a kfx extension does not start by assembling a
toolchain: most extension development needs no separately installed Python,
Node, or package manager.

The runtime deliberately absorbs this complexity so its users do not have to. To
keep that convenience sustainable rather than bespoke, the absorbed tooling is
built on mainstream, well-maintained foundations.

## Components

- **Core & runtime** — `yijinjing` (journal, storage semantics, and runtime
  schema) plus `libkungfu` runtime bindings, packaged as `@kungfu-tech/core`.
  It embeds a Python and a Node runtime and is fronted by the `kungfu` end-user
  command; operator-facing shell slices such as `kungfu cockpit`, managed runs,
  and skill context injection grow under the same command.
- **Capability SDK** — typed, framework-neutral access to journal / state /
  replay (`framework/api`).
- **Application SDK** — scaffolding to build kfx extensions, create Kungfu
  Skills, and assemble applications (`developer/sdk`).
- **Reference surfaces** — two minimal reference UIs over the same capability
  SDK: a desktop GUI on Electron + React (`framework/gui`) and a terminal TUI
  (`framework/tui`).
- **Product assembly** — dogfood desktop and CLI products bundling the runtime,
  both reference UIs, the SDK and first-party kfx (`product`).

Runs on Windows, macOS, and Linux (including arm64). See
[`docs/architecture.md`](docs/architecture.md) for how these pieces are layered.

## Getting started

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the toolchain, build steps, coding
conventions, and the pull request / release flow.

```sh
git clone git@github.com:kungfu-systems/kungfu.git
cd kungfu
./shifu doctor            # check your environment (optional but recommended)
./shifu sync && ./shifu build
```

`./shifu` (`shifu.cmd` on Windows) is the build opener: it bootstraps the
pinned toolchain on first run — nothing to preinstall beyond `curl` (plus a
C++ toolchain and CMake for the native core; `./shifu doctor` tells you
exactly what is missing and where to get it).

> 功夫练不下去的时候，你去找的那个人就是师傅。
> *When your kungfu fails you, the one you turn to is your shifu.*

That is shifu's whole job description: it appears wherever kungfu cannot yet
help itself — before the toolchain exists, when the environment is broken,
when the repository itself still needs fetching.

With shifu installed on your PATH (`cargo install --path crates/shifu --root
~/.local` from any checkout), it also works as a standalone bootstrap core:

```sh
shifu clone [path]        # fetch the repository (default: current directory)
cd <path> && shifu build  # inside a checkout, shifu always delegates to the
                          # repo's own ./shifu — install once, stay current
                          # by pulling code, never by re-installing shifu
```

## Documentation

Start at the [**documentation map**](docs/MAP.md) — it routes your question
(why it's built this way / how to trust the artifact / how to use it) to the
right document, and is readable by both people and agents.

- Installed agent entrypoint: `kungfu agent brief`,
  `kungfu agent capabilities --json`, and `kungfu agent choose-mode --json`.
- [`docs/choose-your-kungfu.md`](docs/choose-your-kungfu.md) — choose the
  smallest Kungfu product that closes your job; the full App is optional.
- [`docs/MAP.md`](docs/MAP.md) — the question-indexed map of all documentation.
- [`docs/concepts.md`](docs/concepts.md) — the vocabulary in one place
  (`kungfu`/`kfx`/`sdk`, `libkungfu`, `yijinjing`, journal, schema, …).
- [`docs/design-philosophy.md`](docs/design-philosophy.md) — the two first
  principles the whole design follows from, and how the architecture falls out
  of them.
- [`docs/facts-before-trust.md`](docs/facts-before-trust.md) — why Kungfu starts
  from accountability: facts before trust, local proof before control.
- [`docs/architecture.md`](docs/architecture.md) — how the repository is layered
  (runtime, capability SDK, application SDK, reference surfaces) and why.
- [`docs/skills.md`](docs/skills.md) — design target for Kungfu Skills:
  `SKILL.md` as the minimal source, compact agent catalog injection,
  Node/Python manage modes, and kfx dependency composition.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — toolchain, build, conventions, releases.
- [`LICENSE-POLICY.md`](LICENSE-POLICY.md) — project licensing, DCO-based
  contributions, third-party notice policy, and commercial boundary.
- [`TRADEMARK.md`](TRADEMARK.md) — official project mark and fork identity
  boundary.
- [`ACCEPTABLE_USE.md`](ACCEPTABLE_USE.md) — acceptable use of official hosted,
  managed, and maintainer-operated services.
- [`PROVIDER_COMPLIANCE.md`](PROVIDER_COMPLIANCE.md) — official posture for
  provider APIs, CLIs, credentials, usage attribution, and anti-bypass
  boundaries.
- [`SECURITY.md`](SECURITY.md) — how to report vulnerabilities privately.
- [`docs/version-release-design.md`](docs/version-release-design.md) — versioning
  and release mechanism rationale.
- [`framework/core/docs/adr/`](framework/core/docs/adr) — architecture decision
  records.

## Feedback & support

Project contact happens through GitHub — there is no email support channel.

- Bugs, feature requests, questions, and documentation issues:
  [open an issue](https://github.com/kungfu-systems/kungfu/issues/new/choose).
- Changes: open a pull request (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).
- Security vulnerabilities: report them privately — see [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
