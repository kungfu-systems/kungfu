---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0129
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [crates/Cargo.toml, crates/Cargo.lock, crates/xinfa/Cargo.toml, crates/xinfa/Cargo.lock, crates/xinfa/extraction-manifest.json, crates/xinfa/qualification/standalone-smoke-v1.json, crates/xinfa/qualification/wasm-engine-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: xinfa-rust-workspace-unification
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
ai_provenance: GPT-5 via Codex on 2026-07-21; based on repository manifests, boundary and extraction contracts, qualification evidence, and user-authorized migration; no claim about unobserved product platforms
---

# ADR-0129: Xinfa joins the canonical Rust workspace without surrendering extraction or product identity

- Status: accepted; implementation staged pending final qualification and merge
- Date: 2026-07-21
- Category: Rust workspace / Xinfa source layout / extraction boundary
- Supersedes: the top-level incubation location in
  [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md)
- Preserves: the independent semantic and extraction boundaries in ADR-0092,
  the linked-component boundary in
  [ADR-0126](ADR-0126-xinfa-trunk-linked-rust-component.md), and the
  WebAssembly/native authority split in
  [ADR-0128](ADR-0128-xinfa-wasm-engine-and-native-minting-boundary.md)

## Context

Kungfu already declares `crates/` as the one landing zone and Cargo workspace
for first-party Rust. Xinfa remained at top-level because its original
incubation decision deliberately emphasized extraction. After the trunk began
linking Xinfa directly, that physical exception created two Cargo roots, two
in-tree lock contexts, path special cases, and misleading documentation even
though Xinfa was already part of the Rust product graph.

Extraction independence is a property of declared files, dependency direction,
and executable qualification. It does not require a top-level directory or an
independent in-tree workspace.

## Decision

### 1. All first-party Rust source lives under one workspace root

Xinfa moves to `crates/xinfa/` and becomes a member of `crates/Cargo.toml`.
In-repository builds, Clippy, tests, release profiles, and dependency resolution
use the canonical `crates/Cargo.lock`. The trunk dependency is the direct
workspace-relative edge `../xinfa`.

### 2. The extraction contract remains independently executable

`crates/xinfa/extraction-manifest.json` continues to enumerate the exact files
copied into a clean temporary root. The retained `crates/xinfa/Cargo.lock` is
the extraction lock snapshot; Cargo ignores it for member builds but the
standalone smoke copies it and proves `cargo build --locked` and
`cargo test --locked` outside the monorepo.

Xinfa keeps explicit package metadata in its own manifest. It may not acquire a
Kungfu, Shifu, private-registry, Git, or monorepo-relative dependency. The
boundary gate still enforces the one-way `kungfu-trunk -> xinfa` edge.

### 3. Source coordinates move; product coordinates do not

Repository references, CI filters, qualification paths, and development
entrypoints use `crates/xinfa/...`. Public protocol names, the `xinfa` command,
`.xinfa` state, environment variables, release identity, installed archive
entries under `xinfa/...`, schema identifiers, and receipt roots do not change.
The move therefore changes source layout without versioning Xinfa semantics or
artifact formats.

### 4. WebAssembly remains deterministic and source-bound

The checked-in engine remains under `crates/xinfa/engine/` in source and under
`xinfa/engine/` in installed products. The pinned Rust toolchain and canonical
workspace release profile build it. Qualification must still prove exact
rebuild, source-tree binding, native/WASM byte parity, and the native-only
production minting boundary.

## Falsification and qualification

This decision is false if:

- `cargo metadata` does not report Xinfa as a member of the `crates` workspace;
- a first-party Rust project remains outside `crates/` without an explicit
  exclusion decision;
- extraction cannot build and test with only its manifest and extraction lock;
- moving the source changes any schema, canonical byte, public product path,
  state coordinate, or command behavior;
- the checked-in WebAssembly engine is not an exact pinned-toolchain rebuild; or
- source and installed-product qualification disagree on Xinfa behavior.

Required evidence is the workspace gate, Xinfa boundary and standalone smoke,
native/WASM qualification, source-entry tests, documentation control-plane
qualification, product inventory checks, and an independent review of the
source-versus-product coordinate boundary.

## Consequences

- Rust ownership and dependency resolution become legible from one workspace.
- Workspace-wide checks cover Xinfa without a special top-level exception.
- Xinfa retains a separately reproducible extraction lock and split boundary.
- Historical baselines and Project Cut records remain immutable; only live
  source declarations and newly generated evidence adopt the new path.
