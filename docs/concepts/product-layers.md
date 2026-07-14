# Product Layers

Independent adoption from the App to the format.

Kungfu is developed in one authoritative monorepo, but it is not one mandatory
installation. Each official layer closes a specific user job independently.

If you are deciding what to install or embed, start with the user-facing
[**Choose Your Kungfu**](../guides/choose-your-kungfu.md) guide. This page defines the
technical product and qualification boundaries behind that choice.

[ADR-0049](../adr/ADR-0049-layer-complete-products-and-domain-neutral-core.md)
defines the architecture constraint. This page is the practical product map.

## Choose from the outside in

| Product | What the user gets | What is not required |
| --- | --- | --- |
| assembled Kungfu App | compatible official layers in one convenient installation | use of every bundled layer |
| GUI | complete visual workflows over public service and SDK contracts | knowledge of SQL or internal storage |
| standalone CLI/TUI | headless host, agent/operator discovery, record, query, verify, maintain and export | Electron |
| PyPI, npm, or Cargo SDK | idiomatic access to the same core semantics in one language ecosystem | sibling SDKs or GUI |
| `libkungfu` | embedded `.kungfu` lifecycle, facts, Episodes, core query, verification and export | Python, Node, Rust host, Electron, cloud or database service |
| `.kungfu` format/spec | portable facts, declared schemas, verification and preservation rules | GUI or a particular language runtime |

The implementation and source-built qualification harness now cover every row.
The table remains a contract map, not a claim that the artifacts have been
published or that a current public release has passed its final Gate.

## Current maturity

The architecture already has the main separation mechanisms: a C++ core over
yijinjing, thin Python/Node bindings, delayed satellite runtimes, headless and
GUI surfaces, workspace-local `.kungfu`, and an assembled distribution.

ADR-0049 makes independent qualification the release obligation. The native
closure and versioned C ABI, thin Python/Node/Rust SDK artifacts, shared semantic
fixture, headless and human surfaces, assembled compatibility manifest, six
budgets, deletion checks, and installer-uninstall checks are implemented. The
source-built implementation was merged through PR #797 after three-host
qualification. The current Shifu Gate registry makes the layer contract and
exact format, SDK, surface, and seven-row publication verdict first-class
profile policy with digest-bound receipts.

That does not collapse build qualification into release publication. Public
npm, PyPI, crates.io, and GitHub Release coordinates, signing, and stable
compatibility remain separate release claims. See the
[layer-complete release qualification contract](../qualification/layer-product-release-qualification.md)
for the exact evidence chain and current boundary.

For the shortest audit path from the seven release rows to executable policy,
follow the [layer-complete qualification contract](../qualification/layer-product-release-qualification.md)
to the [Kungfu Gate catalog](../qualification/gates/README.md) and its
[generated policy matrix](../qualification/gates/policy-matrix.md). The matrix
shows which `layers.*` Gates are required, advisory, or off in each profile;
[`shifu.gates.json`](../../shifu.gates.json) remains the machine source of truth.

## The rule behind the choices

```text
One core, many complete products.
Higher layers add convenience, never authority.
Pay only for the layer you use.
No layer requires a higher layer to fulfill its contract.
```

Completeness is scoped. `libkungfu` is complete as an embedded runtime-fact
source; it is not expected to contain a desktop visualization. The GUI is
complete as the human surface; it does not own storage or query semantics.

## App, GUI, and CLI boundaries

The assembled Kungfu App is the one-install convenience product. It proves
that compatible official layers work together, but it does not replace their
independent qualifications or require a user to exercise every bundled layer.

The GUI is the complete visual product for humans. It may add timelines,
animation, tables, causal graphs, query builders, and workflow composition, but
it reaches facts through stable lower contracts. It cannot be the only place
that knows how to migrate, repair, query, or verify `.kungfu`.

The standalone CLI/TUI is the complete headless product for agents, developers,
automation, and operators. It must not require Electron for semantic
operations.

Pixel composition is legitimately GUI-specific. Fact meaning is not.

The reference GUI's Storage panel is the executable mapping: every semantic
button names a public `storage.*` capability method, while the surface fixture
pins its equivalent `kungfu storage ...` expression. Adding a new GUI-only
migration, repair, verification, or export semantic fails that contract until a
lower expression exists.

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

The stable native boundary is the versioned C table in
`kungfu/native_storage.h`. Requests and responses are UTF-8 JSON edge
projections over the existing runtime storage service; they are not a second
storage model. Result bytes are borrowed from a single-thread-affine context
until explicit release, and unsupported ABI versions, operations, busy state,
invalid input, and core failures have distinct status codes.

## What the format/spec must mean

The `.kungfu` format/spec is the smallest portability boundary. Independent
tools must be able to inspect declared facts, preserve unknown records, and
verify what they understand without installing a GUI or a particular language
host.

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
