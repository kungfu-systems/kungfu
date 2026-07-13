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

Kungfu is local-first execution infrastructure for real-world agent work. It
turns execution into **Episodes**: bounded causal units whose Facts, Artifacts,
Receipts, dependencies, and verification roots can be inspected, sealed,
exported, replayed, recovered, and used to support Decisions.

```text
Real-world work happens in Episodes.
Facts are authoritative. Projections are rebuildable.
Claims require Proof before they support Decisions.
```

The open monorepo contains the low-latency runtime, CLI and TUI, desktop GUI,
language bindings, SDKs, extension system, product assembly, and their shared
qualification contracts. The user-facing distribution is named **Kungfu
Episodes**; the runtime, command, SDKs, and extension system use the Kungfu,
`libkungfu`, and `kfx` names.

## Why an Episode?

Logs show activity. Traces show calls. Workflows describe intended steps. A
chat session preserves a conversation. None of them, by itself, is the durable
object needed to answer:

- What actually happened?
- Which facts and artifacts belong to the work?
- What did the runtime acknowledge, and what survived a crash?
- What evidence supports completion?
- What may safely happen next?

An Episode gives those questions one stable semantic boundary without making a
process, UI, mutable database row, or provider session the authority. Read
[The Episode](docs/concepts/the-episode.md) for the narrative and
[Vocabulary](docs/concepts/vocabulary.md) for the precise public terms.

## What you can build and inspect

- Record typed runtime Facts in an append-only journal with explicit schema
  ownership and provenance.
- Inspect Episodes, causal Timelines, Artifacts, Receipts, Cuts, Watermarks, and
  rebuildable Projections.
- Replay recorded Facts, Rewind an Episode for forensic inspection, and qualify
  Recovery without silently repeating external side effects.
- Query current and historical fact state with proof and lineage attached.
- Embed `libkungfu`, use one ecosystem SDK, add a `kfx`, or assemble a complete
  application without adopting every higher layer.
- Qualify visibility, durability, recovery, and meaning as one end-to-end
  contract rather than treating ingestion speed as sufficient evidence.

## Start here

- **New to Kungfu:** use the curated [Documentation Guide](docs/README.md).
- **Choosing a product layer:** read [Choose Your Kungfu](docs/guides/choose-your-kungfu.md).
- **Evaluating trust or production use:** begin with
  [Known Limits](docs/qualification/known-limits.md) and the
  [Single-host institutional trust profile](docs/qualification/single-host-institutional-trust.md).
- **Looking up one exact question:** use the exhaustive
  [Documentation Map](docs/MAP.md).
- **Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md).

An installed runtime also carries an agent-readable product brief:

```sh
kungfu agent brief
kungfu agent capabilities --json
kungfu agent choose-mode --json
```

To evaluate the source tree before public artifacts are available:

```sh
git clone https://github.com/kungfu-systems/kungfu.git
cd kungfu
./shifu doctor
./shifu sync && ./shifu build
```

## Adopt only what you need

| Job | Smallest relevant surface |
| --- | --- |
| complete official experience | assembled Kungfu App |
| visual inspection and human workflows | GUI |
| headless operation and automation | CLI/TUI |
| one language ecosystem | Python, Node/TypeScript, or Rust SDK |
| native embedding | `libkungfu` |
| independent preservation and inspection | `.kungfu` format/spec |

Higher layers add convenience; they do not become a second authority over the
Facts. [Product Layers](docs/concepts/product-layers.md) defines the independent
qualification contract behind these choices.

## Architecture at a glance

The data plane is `yijinjing`, a low-latency append-only mmap journal shared by
C++, Python, and Node. Closed kernel records use fixed-layout Hana POD schemas;
open and domain Facts use FlatBuffers. JSON is an edge rendering or interchange
format, not a third journal schema.

Live work and Replay use the same frame and runtime semantics. SQLite and GUI
models are rebuildable Projections over journal-backed authority. The runtime,
capability SDK, application SDK, reference surfaces, and product assembly remain
separate layers with explicit contracts. See [Architecture](docs/architecture/overview.md)
and [Event Model](docs/architecture/event-model.md).

## Status and guarantees

Kungfu v4 is **Coming soon**. Source-built capabilities and qualification
slices exist, but public packaging, cross-platform evidence, strong
power-loss durability, and the institutional profile remain staged where the
linked evidence says so.

Design intent, implemented behavior, qualified guarantees, and released
artifacts are deliberately distinct. Before relying on a claim, check
[Contracts](docs/qualification/contracts.md), [Known Limits](docs/qualification/known-limits.md), and the
applicable retained qualification evidence.

## Project links

- Product home: <https://kungfu.tech>
- Developer and agent surface: <https://libkungfu.dev>
- Documentation: [docs/README.md](docs/README.md)
- Issues and questions: [GitHub issue forms](https://github.com/kungfu-systems/kungfu/issues/new/choose)
- Security reports: [SECURITY.md](SECURITY.md)
- License: [Apache License 2.0](LICENSE)
