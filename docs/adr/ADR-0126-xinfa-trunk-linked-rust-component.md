---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0126
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [crates/xinfa/boundary.contract.json, crates/xinfa/extraction-manifest.json, crates/xinfa/tooling/standalone-smoke.mjs, crates/trunk/Cargo.toml, crates/trunk/src/main.rs, framework/core/src/python/kungfu/cli/commands/xinfa.py]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-20
theme: xinfa-trunk-linked-rust-component
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-20; based on repository contracts, byte-level migration baselines, and user-authorized design constraints; no claim about unobserved platform qualification or future release artifacts
---

# ADR-0126: Xinfa is an independently governed Rust component linked into the Kungfu trunk

- Status: accepted; implementation is complete pending closure, with
  source/component qualification and the darwin-arm64 installed product
  qualified while other product platforms remain unobserved
- Date: 2026-07-20
- Category: Xinfa boundary / Rust trunk / product distribution
- Supersedes: the independent-binary, independent-release, and zero-host
  qualification portions of [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md)
- Preserves: Xinfa semantic authority and extraction-first discipline from
  ADR-0092, the single public executable from
  [ADR-0118](ADR-0118-kungfu-single-entry-action-primitive-cli.md), and the
  layered Rust host from
  [ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md)

## Context

Xinfa's semantic implementation is already a Rust library with a CLI front end,
but the product distribution builds a second private executable,
`xinfa-engine`, and the Python `kungfu xinfa` adapter locates and launches it.
That physical split creates an extra build, packaging, discovery, version, and
process boundary without adding semantic isolation. Kungfu already ships one
Rust product trunk that is linked into the assembled product and is never
released independently.

The rejected alternative is to rewrite Xinfa in MJS merely to avoid requiring a
developer Rust toolchain. That would duplicate roughly the whole compiler,
replace link-time dependency direction with lint-only separation, and require a
new byte-equivalence proof for canonical key ordering, integer handling, JSON
escaping, schemas, roots, and receipts. Toolchain friction is a launcher
problem, not a reason to replace the semantic authority.

ADR-0123's separation rule applies here: semantic independence does not require
one process, executable, repository, or component per authority.

## Decision

### 1. Xinfa remains one independent semantic authority

Xinfa continues to own every `xinfa.*` protocol, schema, root preimage,
receipt, compiler rule, route-selection rule, state/cache coordinate, and
diagnostic vocabulary. It still does not own project truth, Kungfu runtime
facts, Episode identity, Shifu protocol conformance, Buildchain attestation, or
the public executable namespace.

This change does not version or reinterpret any existing Xinfa object. Existing
schemas, golden bytes, Atlas roots, route-resolution roots, Task Charts, and
receipts remain byte-identical.

### 2. The physical boundary is a Rust library component

`xinfa` exposes its complete command dispatcher as a library entry. Its
`xinfa` binary remains an extremely thin source-development wrapper that
forwards argv to that entry. The core crate keeps exactly the current
registry-only dependency allowlist:

```text
serde_json
sha2
```

It may not depend on Kungfu, Shifu, libkungfu, a monorepo-relative crate, a Git
dependency, or a private registry. The product dependency is one-way:

```text
kungfu-trunk -> xinfa
```

The boundary gate checks both halves: the Xinfa core allowlist and the exact
trunk-to-Xinfa path edge, while rejecting a reverse host dependency.

### 3. The trunk owns the physical product entry

`kungfu-trunk` links the Xinfa library and dispatches `xinfa` in process.
Kungfu-owned workspace shorthand normalization remains outside the Xinfa core.
The Python Click compatibility adapter forwards argv to the trunk; it no longer
locates or launches a private `xinfa-engine`.

The assembled product contains no separate Xinfa executable. Xinfa version and
protocol discovery remain available through `kungfu xinfa`, while the trunk
itself continues to follow the Kungfu product line and is not released on its
own.

### 4. Extraction proves crate independence, not a zero-host product

`extraction-manifest.json` remains the exact declaration of the independently
extractable Xinfa crate. Extraction builds and tests the library and thin
development binary to prove the dependency allowlist and semantic boundary.
Product qualification, however, invokes the linked trunk subcommand and proves
that it produces the same bytes as the extracted development wrapper.

The former `xinfa.standalone-boundary/v1` zero-host binary qualification is
replaced by a component boundary: extraction remains a portability and
separability oracle, not a promise of a separately distributed product.

### 5. Shifu reuses the trunk and preserves source freshness

When Cargo is available, `./shifu xinfa` runs the workspace trunk from source
with the existing content-addressed target cache, so Cargo remains the
freshness authority for both crates. When Cargo is absent, Shifu may reuse only
an explicit `KUNGFU_TRUNK_BIN` or the checkout's assembled product trunk. It
must not silently choose an arbitrary or stale PATH binary.

This removes the hard requirement for a separately installed Rust toolchain
when a qualified prebuilt trunk is already present, without writing a Rust
toolchain into the real machine. Hot source-development behavior remains one
cached Cargo freshness check.

### 6. MJS and WebAssembly boundaries

Xinfa is not rewritten in MJS. MJS remains appropriate for Shifu tooling,
qualification orchestration, and product adapters, but it does not gain a
second compiler implementation. If a future pure-JavaScript host needs the
compiler in process, it may consume a separately decided WebAssembly component
compiled from this Rust authority; that future delivery may not reinterpret
current roots.

## Falsification and qualification

This decision is false if:

- any existing Xinfa schema, root preimage, receipt byte, or golden fixture
  changes as a side effect of linking;
- Xinfa imports a Kungfu/Shifu namespace or monorepo crate;
- the product still builds, stages, locates, or invokes `xinfa-engine`;
- `kungfu xinfa` or `./shifu xinfa` crosses a subprocess boundary to a Xinfa
  engine when running through the trunk;
- the extracted thin binary and linked trunk produce different stdout, stderr,
  or exit status for the retained positive and negative corpus; or
- a no-Cargo fallback selects an undeclared PATH executable.

Qualification therefore includes the upgraded component boundary, clean crate
extraction, Rust unit tests, retained golden and negative fixtures, schema-set
and context-quality ratchets, direct thin-bin versus linked-trunk byte
comparison, Python adapter forwarding tests, product archive inventory, and
installed `kungfu xinfa` compile/verify smoke.

## Consequences

- Users and Agents receive one executable and one in-process Xinfa compiler.
- Xinfa retains link-level semantic isolation and independent extraction while
  losing an unnecessary release and packaging unit.
- The trunk build now includes the two existing public-registry crates used by
  Xinfa; no new dependency is introduced.
- Source development still produces a thin `xinfa` binary for direct
  qualification, but that binary is not a product artifact.
- A future physical re-extraction or WebAssembly host remains possible because
  the dependency direction and crate manifest stay closed.

## Version impact

The registered `xinfa-product-contract` and `kungfu-cli` surfaces change
physically but not semantically. This is a breaking pre-release distribution
change: the private engine artifact disappears, while every existing
`xinfa.*` object and public `kungfu xinfa` command meaning remains compatible.
No stable release line opens.
