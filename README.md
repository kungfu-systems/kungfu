# Kungfu

Kungfu is a framework and runtime for building journal-first,
streaming-data applications. It is built on one discipline: never let a
load-bearing truth rest on a claim you could fake — weld it to something that
can't. ([design philosophy](docs/design-philosophy.md).)

At its core is a low-latency, append-only event journal with a shared,
strongly-typed schema, exposed zero-copy to C++, Python, and Node. Kungfu
offers these capabilities — the journal, in-process state, and deterministic
replay — as a foundation (SDK) to build on, and ships a minimal reference
application built on that foundation.

Originally created for trading execution, the core is general: anything that
needs to capture, share, and faithfully replay high-frequency event streams.

## Core ideas

- **Journal-first data plane** — one append-only event log
  ([`yijinjing`](framework/core)) with a unified type system
  ([`longfist`](framework/core)) carrying source / destination / nanosecond
  timestamp / message type. Every component consumes the same frames rather than
  inventing its own format.
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

- **Core & runtime** — `longfist` (type system) and `yijinjing` (journal
  runtime) with Python and Node bindings, plus the `kungfu` runtime, packaged as
  `@kungfu-tech/core`. It embeds a Python and a Node runtime and is fronted
  by the `kungfu` end-user command; the richer end-user shell is planned under
  the same name.
- **Capability SDK** — typed, framework-neutral access to journal / state /
  replay (`framework/api`).
- **Application SDK** — scaffolding to build kfx extensions and assemble
  applications (`developer/sdk`).
- **Reference surfaces** — two minimal reference UIs over the same capability
  SDK: a desktop GUI on Electron + React (`framework/gui`) and a terminal TUI
  (`framework/tui`).
- **Distribution** — a dogfood installer bundling the runtime, both reference
  UIs and the SDK (`artifact`).

Runs on Windows, macOS, and Linux (including arm64). See
[`docs/architecture.md`](docs/architecture.md) for how these pieces are layered.

## Getting started

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the toolchain, build steps, coding
conventions, and the pull request / release flow.

```sh
# install fnm and uv once, then:
git clone git@github.com:kungfu-systems/kungfu.git
cd kungfu
./kungfu-code sync && ./kungfu-code build
```

## Documentation

Start at the [**documentation map**](docs/MAP.md) — it routes your question
(why it's built this way / how to trust the artifact / how to use it) to the
right document, and is readable by both people and agents.

- [`docs/MAP.md`](docs/MAP.md) — the question-indexed map of all documentation.
- [`docs/concepts.md`](docs/concepts.md) — the vocabulary in one place
  (`kungfu`/`kfx`/`kfs`, `libkungfu`, `longfist`, `yijinjing`, journal, …).
- [`docs/design-philosophy.md`](docs/design-philosophy.md) — the two first
  principles the whole design follows from, and how the architecture falls out
  of them.
- [`docs/architecture.md`](docs/architecture.md) — how the repository is layered
  (runtime, capability SDK, application SDK, reference surfaces) and why.
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
