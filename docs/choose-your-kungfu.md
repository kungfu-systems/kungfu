# Choose Your Kungfu

Use only the layer you need.

You do **not** have to adopt the whole Kungfu App to use Kungfu.

Kungfu is developed in one repository so its formats, runtimes, SDKs, command
line, and visual tools stay compatible. It is delivered as several adoption
products so you can take only the layer that closes your problem.

```text
one shared core
+ several independently useful products
+ no requirement to start with the largest one
```

The desktop App is the broadest convenience product. It is not the source of
truth and it is not the mandatory doorway into Kungfu. Most first-time users
should still consider it first, then move down the table when they need a
smaller, headless, language-specific, or native integration boundary.

## Start with the job you need to finish

| I want to... | Start with... | You do not need... |
| --- | --- | --- |
| get the complete official experience in one installation | the assembled Kungfu App | the obligation to use every bundled component |
| explore facts visually, build timelines, or use human-friendly query tools | the GUI | SQL or knowledge of Kungfu's storage internals |
| automate, script, operate, or query Kungfu headlessly | the standalone CLI/TUI | Electron |
| use Kungfu from my existing Python, Node/TypeScript, or Rust project | that ecosystem's Kungfu SDK | the other language SDKs or the App |
| add reliable facts, Episodes, replay, and verification to a native application | `libkungfu` | Electron, Python, Node, a cloud account, or an external database service |
| inspect or preserve a Kungfu fact artifact with my own tooling | the `.kungfu` format and spec | the App or a particular programming language |

Read from the top down. If you want a complete first experience, choose the
App. If you already know your integration boundary, continue downward until a
smaller product closes the job. Choosing a broader or narrower surface never
changes who owns your facts or migrates them into a GUI-only database.

## Four common adoption paths

### I want the easiest complete human experience

Use the Kungfu App. It brings compatible official layers together and adds the
visual experience: timelines, tables, causal graphs, query builders, workflow
composition, and product guidance.

This is a convenience choice, not an authority choice. The GUI reads and acts
through the same lower contracts available to the CLI and SDKs. Uninstalling
the GUI must not strand or silently reinterpret your `.kungfu` data.

### I need an agent-friendly or server-friendly tool

Use the standalone CLI/TUI. It is the headless product for shell scripts,
agents, automation, CI, remote machines, and operators.

The command surface is designed to be discoverable and composable: stable
machine-readable output for programs, tabular output for shell tools, and
diagnostics kept separate from data. Installing Electron must not be a
prerequisite for semantic operations.

### I already work inside one language ecosystem

Use the SDK for that ecosystem. A Python user should not have to understand
npm or Cargo; a Node user should not have to initialize Python; a Rust user
should not have to install either sibling SDK.

The SDKs are idiomatic adapters over one semantic core. They do not define
different meanings for Episode identity, causality, historical cuts, or proof.

### I am embedding Kungfu in another product

Link `libkungfu` and keep your existing application shell.

Your application owns its domain—agents, trades, simulations, devices, game
entities, or something else. The native core owns the generic runtime-fact
lifecycle: ordering, Episodes, storage, replay, query, verification, recovery,
and export.

You should not need to ship the Kungfu desktop App merely to maintain your own
`.kungfu` data.

## What stays the same whichever path you choose

The adoption paths share:

- the `.kungfu` fact and Episode model;
- ordering, causality, replay, and historical-cut semantics;
- declared schema authority;
- verification and proof rules;
- compatibility information generated from the same monorepo;
- the rule that higher layers add convenience, never exclusive authority.

This is why Kungfu can offer several products without becoming several
incompatible implementations.

## Move between layers without restarting

Most people encounter Kungfu from the outside in:

```text
assembled App
-> standalone GUI or CLI/TUI when a smaller operating surface is enough
-> one ecosystem SDK when Kungfu belongs inside existing application code
-> libkungfu when the native boundary is the product boundary
-> format/spec when you are building independent artifact tooling
```

Builders can also grow from the core outward. Both directions must preserve the
same `.kungfu` authority: removing the GUI, a CLI, or an unused language host
must leave the lower declared product closures valid.

## Current availability and maturity

Kungfu is currently marked **Coming soon**, and independent artifact
qualification is staged. This page describes the adoption contract the project
is implementing; it does not claim that every package is already published or
that every row has passed its final release gate.

The native historical-query closure and versioned C ABI now have executable
qualification. Thin Python, Node, and Rust storage SDK sources share that
contract and pass an exact-artifact Darwin ARM64 gate, but they are not yet a
published cross-platform release claim. The complete resident-memory and
release-channel matrix also remains staged. Check [known limits](known-limits.md)
and the relevant release artifact before choosing a production path.

The project treats that honesty as part of the product: an absent or staged
layer should be named as such rather than hidden behind the full App.

## Go deeper

- [Product Layers](product-layers.md) defines each
  product closure and its deletion/qualification tests.
- [Architecture](architecture.md) explains how the source tree and runtime are
  layered.
- [Known limits](known-limits.md) separates current guarantees from staged
  work.
- [ADR-0049](../framework/core/docs/adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md)
  is the load-bearing architecture decision behind this guide.
