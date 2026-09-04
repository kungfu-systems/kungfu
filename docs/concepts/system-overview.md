# Kungfu System Overview

Kungfu is a local-first runtime that records real-world agent work and verifies
what actually got done. It works alongside the agents and execution surfaces
you already use.

This page is the current-system cross-section behind the concise project
[README](../../README.md). For whole-system study, it is the second layer after
the longitudinal [Evolution Map](../evolution/README.md): establish why the
major abstractions and authority boundaries appeared, then use this page to see
how they fit together now. A reader with one bounded product question can
enter this overview directly without loading the complete history.

Kungfu turns execution into **Episodes**, bounded causal units that bind Facts,
Artifacts, Receipts, dependencies, and verification roots into one inspectable
record. Episodes can be sealed, exported, and replayed to support recovery and
evidence-based Decisions.

```text
Real-world work happens in Episodes.
Facts are authoritative. Projections are rebuildable.
Claims require Proof before they support Decisions.
```

This open monorepo contains the low-latency runtime, CLI and TUI, desktop GUI,
language bindings, SDKs, extension system, product assembly, and the shared
qualification contracts that keep them aligned. The user-facing distribution
is named **Kungfu**; the runtime, command, SDKs, and extension system use the
Kungfu, `libkungfu`, and `kfx` names.

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
[The Episode](the-episode.md) for the narrative and
[Vocabulary](vocabulary.md) for the precise public terms.

## What Kungfu lets you do

- Record typed runtime Facts in an append-only journal with explicit schema
  ownership and provenance.
- Inspect Episodes, causal Timelines, Artifacts, Receipts, Cuts, Watermarks, and
  rebuildable Projections.
- Query current and historical fact state with proof and lineage attached.
- Replay recorded Facts, Rewind an Episode for forensic inspection, and qualify
  Recovery without silently repeating external side effects.
- Embed `libkungfu`, use one ecosystem SDK, add a `kfx`, or assemble a complete
  application without adopting every higher layer.
- Qualify visibility, durability, recovery, and meaning as one end-to-end
  contract rather than treating ingestion speed as sufficient evidence.

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
Facts. [Product Layers](product-layers.md) defines the independent qualification
contract behind these choices.

## Incubated standalone products

[Xinfa](../../crates/xinfa/README.md), **The Verified Context Compiler for Human-Agent
Software Development**, is incubated in this repository with its own CLI,
protocol namespace, version, artifacts, state/cache roots, release identity,
and extraction manifest. Its core has no Kungfu or Shifu runtime dependency;
those products may integrate only through thin public-contract adapters. See
[KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8](../adr/KF-ADR-019f86da-4f90-7ca2-8757-52f713bd3df8.md),
[KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7](../adr/KF-ADR-019f86da-4f90-7cef-a31b-bf3c50bd7cf7.md),
[KF-ADR-019f86da-4f90-79e3-8411-bbd133d55fff](../adr/KF-ADR-019f86da-4f90-79e3-8411-bbd133d55fff.md), and
[KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f](../adr/KF-ADR-019f86da-4f90-7a58-80ea-4666cc94397f.md).

## Architecture at a glance

The data plane is `yijinjing`, a low-latency append-only mmap journal shared by
C++, Python, and Node. Closed kernel records use fixed-layout Hana POD schemas;
open and domain Facts use FlatBuffers. JSON is an edge rendering or interchange
format, not a third journal schema.

Live work and Replay use the same frame and runtime semantics. SQLite and GUI
models are rebuildable Projections over journal-backed authority. The runtime,
capability SDK, application SDK, reference surfaces, and product assembly
remain separate layers with explicit contracts. See
[Architecture](../architecture/overview.md) and
[Event Model](../architecture/event-model.md).

## Why Kungfu?

Kungfu began with the Chinese idea of **功夫**: capability built through
disciplined practice. As the product evolved, **KUNGFU** acquired a recursive
technical meaning: `KUNGFU UNGFU: Never Guess. Facts Unfold.`

The name describes the architecture: deeply integrated at the product surface,
self-bootstrapping from Facts at the core. Read [Why Kungfu?](why-kungfu.md)
for the complete recursion and its connection to the product's fact-first
design.

## Status and guarantees

Kungfu `v4.0.0-alpha.1` is the first public v4 Alpha, with desktop and
standalone CLI artifacts for the declared macOS arm64, Linux x86_64, and
Windows x86_64 release surfaces. It is not a Stable or generally available
release. Strong power-loss durability, the institutional profile, independent
ecosystem SDK publication, and every other unlisted claim remain staged unless
linked evidence says otherwise.

Design intent, implemented behavior, qualified guarantees, and released
artifacts are deliberately distinct. Before relying on a claim, check
[Contracts](../qualification/contracts.md),
[Known Limits](../qualification/known-limits.md), and the applicable retained
qualification evidence.

## Continue reading

- [Documentation Guide](../README.md)
- [Choose Your Kungfu](../guides/choose-your-kungfu.md)
- [Fact, Episode, and Action Primitive Runtime](../architecture/fact-episode-action-runtime.md)
- [Agent Work State](../profiles/agent-work-state.md)
- [Documentation Map](../MAP.md)
