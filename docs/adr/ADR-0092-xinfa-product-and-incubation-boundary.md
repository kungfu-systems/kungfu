---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0092
decision_status: accepted
implementation_status: partial
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/915]
qualification_refs: [xinfa/qualification/standalone-smoke-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-15
theme: xinfa-product-incubation-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-07-15
---

# ADR-0092: Xinfa is a standalone context compiler product

- Status: accepted; implementation partial
- Date: 2026-07-15
- Category: independent product / context compilation / incubation boundary
- Related: [SHIFU-ADR-0006](SHIFU-ADR-0006-documentation-protocol-and-provider-boundary.md),
  [ADR-0044](ADR-0044-shifu-delegation-protocol.md),
  [ADR-0049](ADR-0049-layer-complete-products-and-domain-neutral-core.md), and
  [ADR-0093](ADR-0093-xinfa-dual-first-verified-context-contract.md)

## Context

Shifu now has a project-independent Documentation Protocol for submitting
declared roots, profiles, providers, routes, and validation obligations. The
next work needs a canonical Context IR, truth and impact graph, bounded
selection, task capsules, packs, and provenance.

Putting those semantics into Shifu would turn a development/build opener into a
second compiler authority. Putting them into Kungfu would make a generally
useful agent-context product depend on one product runtime. A monorepo source
location is useful for incubation, but it must not become an accidental runtime,
namespace, state, artifact, or release dependency.

## Decision

### 1. Xinfa is its own product

Xinfa is **The Verified Context Compiler for Human-Agent Software Development**.
It owns the `xinfa` CLI, the `xinfa.*` protocol namespace, Context IR and
compiler semantics, artifact names, version source, release tags, state/cache
roots, and qualification receipts.

The initial source lives under top-level `xinfa/` only as an incubation choice.
`xinfa/extraction-manifest.json` is the authoritative split boundary. A clean
tree containing only those files must build and run without a Kungfu or Shifu
runtime, private import, monorepo-relative path, or host-product environment.

### 2. Authority follows one directed graph

```text
Project sources and domain semantics
                |
     public submission contracts
                |
  Shifu protocol conformance and Gate invocation
                |
      Xinfa Context IR compiler
       /         |          \
 impact graph  task capsule  context pack
       \         |          /
          public Xinfa artifacts
                |
   Kungfu and other thin product adapters
                |
      Buildchain exact attestation
```

The project owns source truth and domain semantics. Shifu owns its submission
protocol, canonical submission roots, conformance diagnostics, controlled Gate
execution, and thin invocation adapters. Xinfa alone owns canonical Context IR,
graph and impact semantics, selection, capsules, packs, and compiler provenance.
Kungfu and other products consume public Xinfa artifacts. Buildchain attests
exact inputs and artifacts without reinterpreting them.

Shifu commands may remain compatibility wrappers, but they must delegate through
a public Xinfa contract and may not contain an independent graph, selector,
pack, capsule, schema, state root, or compiler receipt implementation.

### 3. Product identity is independent

The first contract freezes these coordinates:

| Coordinate | Xinfa identity |
| --- | --- |
| CLI | `xinfa` |
| Protocol namespace | `xinfa.*` |
| Rust package | `xinfa` |
| Binary artifact | `xinfa-{target}` |
| Release tag | `xinfa-v{version}` |
| Version source | `xinfa/Cargo.toml` while incubated |
| Workspace state | `.xinfa` |
| State override | `XINFA_STATE_HOME` |
| Cache override | `XINFA_CACHE_HOME` |

Xinfa does not read `.kungfu`, Shifu cache/state, or host-product environment
variables. Source checkout tooling may invoke it, but those entrypoints are not
part of its runtime contract.

### 4. Incubation is extraction-first

The standalone core starts as a dependency-free Rust bootstrap with stable
`--version`, `contract --json`, and read-only `diagnose --json` surfaces. A
machine boundary contract rejects private host imports, package prefixes, path
dependencies, and known monorepo-relative roots. A negative fixture proves that
the rejection is executable.

The standalone smoke copies only the extraction manifest into a clean temporary
directory, removes host-product environment variables, builds and tests with
ordinary Cargo, compares stable contract output, and verifies that default and
overridden state diagnostics create no files. Each later compiler stage must
preserve this proof before claiming extraction readiness.

Once compiler semantics require JSON canonicalization and cryptographic roots,
ADR-0093 permits a closed allowlist of checksum-locked public registry crates.
Path, git, private, Shifu, Kungfu, and monorepo-relative dependencies remain
forbidden and executable boundary checks continue to enforce that distinction.

## Consequences

- Xinfa can evolve and later move to a separate repository without renaming its
  public contracts or relocating user state.
- Shifu remains a project-independent protocol, conformance, Gate, and launcher
  product rather than a second context compiler.
- Kungfu can dogfood Xinfa without gaining authority over its IR or release.
- Cross-product adapters must be visibly thin and live outside Xinfa core.
- The repository gains another pre-release product contract, but no Kungfu v4
  line is opened and no release artifact is published by this decision.

## Acceptance gates

- Boundary scanning rejects private Shifu/Kungfu imports, path dependencies, and
  monorepo-relative runtime roots, including an explicit negative fixture.
- A clean extraction builds, tests, and runs `--version`, `contract --json`, and
  `diagnose --json` after host-product environment variables are removed.
- Contract output is deterministic; state/cache defaults and overrides are
  Xinfa-owned and diagnostics do not create them.
- Future Shifu graph/context/pack work either delegates to the public Xinfa
  contract or is superseded; it does not create a parallel compiler authority.

## Non-claims

This slice does not implement the Context IR compiler, adapters, publishing,
cross-platform qualification, or a stable release. It does not change any
existing Shifu or Kungfu command meaning.

## Version impact

Register the independent pre-release `xinfa-product-contract` surface. Xinfa
starts at `0.1.0` with its own future release line. Kungfu and Shifu lines remain
unchanged; no line is opened by this incubation decision.
