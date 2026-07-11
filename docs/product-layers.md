# Product layers and independent adoption

Kungfu is developed in one authoritative monorepo, but it is not one mandatory
installation. Each official layer closes a specific user job independently.

If you are deciding what to install or embed, start with the user-facing
[**Choose your Kungfu**](choose-your-kungfu.md) guide. This page defines the
technical product and qualification boundaries behind that choice.

[ADR-0049](../framework/core/docs/adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md)
defines the architecture constraint. This page is the practical product map.

## The rule

```text
One core, many complete products.
Higher layers add convenience, never authority.
Pay only for the layer you use.
No layer requires a higher layer to fulfill its contract.
```

Completeness is scoped. `libkungfu` is complete as an embedded runtime-fact
source; it is not expected to contain a desktop visualization. The GUI is
complete as the human surface; it does not own storage or query semantics.

## Adoption products

| Product | What the user gets | What is not required |
| --- | --- | --- |
| `.kungfu` format/spec | portable facts, declared schemas, verification and preservation rules | GUI or a particular language runtime |
| `libkungfu` | embedded `.kungfu` lifecycle, facts, Episodes, core query, verification and export | Python, Node, Rust host, Electron, cloud or database service |
| PyPI package | idiomatic Python access to the same core semantics | npm, Cargo or GUI |
| npm package | idiomatic Node/TypeScript access to the same core semantics | Python, Cargo or GUI |
| Cargo package | idiomatic Rust access to the same core semantics | Python, Node or GUI |
| standalone CLI/TUI | headless host, agent/operator discovery, record, query, verify, maintain and export | Electron |
| GUI | complete visual workflows over public service and SDK contracts | knowledge of SQL or internal storage |
| assembled distribution | compatible official layers in one convenient installation | use of every bundled layer |

Some rows describe target qualifications whose implementation is staged. The
table is a contract map, not a claim that every ecosystem artifact already
passes its final release gate.

## What `link libkungfu` must mean

A native consumer should be able to complete this loop without initializing a
language host:

```text
open or create workspace-local .kungfu
-> begin Episode
-> append typed facts and causal links
-> seal Episode
-> query head and a historical cut
-> verify/fsck
-> export portable evidence
```

The application owns its domain facts. `libkungfu` owns how those facts are
recorded, ordered, stored, queried, verified, exported, and recovered.

The standard native package includes or resolves a default local provider and
the contract/schema artifacts required by that loop. A storage interface with
no usable default implementation is not a complete native product.

## What ecosystem packages must mean

Each language package is a thin, idiomatic surface over the same native
semantics. It can follow ecosystem conventions for distributing the compatible
native binary, but it cannot redefine Episode identity, causality, cuts, query
meaning, or proof.

An ecosystem package qualifies independently:

```text
install in a clean environment
-> discover capabilities
-> run the shared semantic fixture
-> inspect and export the same .kungfu artifact
```

Installing one language package must not install or initialize the others.

## CLI and GUI boundaries

The standalone CLI/TUI is the complete headless product for agents, developers,
automation, and operators. It must not require Electron for semantic
operations.

The GUI is the complete visual product for humans. It may add timelines,
animation, tables, causal graphs, query builders, and workflow composition, but
it reaches facts through stable lower contracts. It cannot be the only place
that knows how to migrate, repair, query, or verify `.kungfu`.

Pixel composition is legitimately GUI-specific. Fact meaning is not.

## Layer deletion test

Every release should preserve these statements:

```text
delete GUI       -> headless operation remains complete
delete CLI       -> embedded SDK/core operation remains complete
delete Python    -> Node/Rust/native operation remains complete
delete Node      -> Python/Rust/native operation remains complete
delete all hosts -> libkungfu still owns the local truth-source loop
```

Uninstalling or replacing a higher layer must not migrate, strand, or silently
change the authority of an existing `.kungfu` data root.

## Weight is more than file size

Each artifact tracks:

- dependency closure and optional components;
- installed/download size;
- cold-start path;
- resident runtime set and memory;
- required background services;
- update and compatibility surface;
- concepts a new user must understand before completing the first useful loop.

Lazy loading prevents unused runtimes from starting. Independent artifacts also
prevent users from downloading, updating, and reasoning about layers they did
not choose.

## Current maturity

The architecture already has the main separation mechanisms: a C++ core over
yijinjing, thin Python/Node bindings, delayed satellite runtimes, headless and
GUI surfaces, workspace-local `.kungfu`, and an assembled distribution.

ADR-0049 makes independent qualification the release obligation. Native
historical query closure, the Cargo SDK, stable cross-toolchain C ABI, and the
full per-artifact size/startup matrix remain staged work rather than current
release claims.
