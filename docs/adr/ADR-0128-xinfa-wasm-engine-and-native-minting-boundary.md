---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0128
decision_status: accepted
implementation_status: staged
implementation_prs: []
qualification_refs: [crates/xinfa/engine/manifest.json, crates/xinfa/qualification/wasm-engine-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-21
theme: xinfa-wasm-engine-native-minting-boundary
confidence: high
evidence_grade: B
last_reviewed: 2026-07-21
ai_provenance: GPT-5 via Codex on 2026-07-21; based on repository contracts, the verified Project Cut task context, and user-authorized design constraints; no claim about unobserved platform qualification or future release artifacts
---

# ADR-0128: Xinfa compiles one hash-pinned WebAssembly engine for development execution and receipt verification while the native trunk alone mints production receipts

- Status: accepted; implementation and darwin-arm64 source/product
  qualification are complete pending closure; other product platforms remain
  unobserved
- Date: 2026-07-21
- Category: Xinfa boundary / WebAssembly engine / development launcher / release verification
- Related: [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md),
  [ADR-0095](ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md),
  [ADR-0096](ADR-0096-xinfa-bounded-projection-and-task-chart.md), and
  [ADR-0126](ADR-0126-xinfa-trunk-linked-rust-component.md)

## Context

ADR-0126 links the independently governed Xinfa Rust crate into the Kungfu
trunk and keeps Cargo as the source-freshness authority. That removes a private
product executable, but a fresh development checkout still pays a Rust compile
before Shifu can ask Xinfa for a documentation Atlas or Task Chart. Rewriting
the compiler in MJS would remove that latency by introducing a second semantic
implementation, which is worse than the launcher friction.

The same compiled engine can also make a released Xinfa authority independently
replayable without installing the native product. This is useful only if the
artifact is content-addressed, rebuilt from the declared source cut, and kept
outside production admission authority.

## Decision

### 1. One Rust semantic authority has two compiled targets

The `xinfa` crate remains the only implementation of every `xinfa.*` schema,
canonical byte encoding, root preimage, receipt, selector, and diagnostic. It
builds for the native trunk and for `wasm32-unknown-unknown`; WebAssembly is a
second compilation target, not a port or protocol successor.

The shared compiler core is host-independent and I/O-free. It accepts declared
bytes and metadata and returns deterministic bytes, diagnostics, and proposed
artifacts. Filesystem discovery, reads, atomic publication, environment lookup,
stdout/stderr, and process exit remain host-shell responsibilities. The native
CLI/trunk and the Node host must call the same pure functions; they may not keep
separate native and WebAssembly semantic paths.

### 2. The WebAssembly ABI is minimal and JSON-edge only

The engine's callable ABI exports only allocation, one request/response call,
and deallocation (in addition to WebAssembly memory and linker metadata):

```text
xinfa_alloc(len) -> ptr
xinfa_call(ptr, len) -> packed(ptr, len)
xinfa_free(ptr, len)
```

Requests carry the command plus an explicit bounded file inventory. Responses
carry exit status, stdout/stderr, and proposed output files. JSON is transport
at this edge; typed Rust values remain the implementation state and no JSON
file becomes a second authority. The host performs byte transport and file
publication only.

### 3. The checked-in engine is content-addressed and source-bound

`crates/xinfa/engine/xinfa.wasm` is checked in together with
`crates/xinfa/engine/manifest.json`. The manifest binds at least the exact Xinfa source
tree hash, WebAssembly SHA-256, and exact Rust toolchain version. The repository
pins the toolchain and optimization profile. Qualification rebuilds the engine
and rejects any source, toolchain, artifact, or manifest drift.

The WebAssembly digest is the engine root for delivery-side verification. It
does not replace an Atlas root, Context Pack root, Project Cut, Git tree, or
Kungfu Episode root.

### 4. The Node host is a zero-dependency loader

The development host uses only Node built-ins. It reads the manifest and
engine, verifies SHA-256 before instantiation, transports the explicit file
inventory, invokes the minimal ABI, and publishes only the returned artifact
plan. One instantiated module is reused within the process. The host contains
no Xinfa validation, canonicalization, selection, root, or receipt semantics.

### 5. Shifu selects by exact source freshness

For `./shifu xinfa`, Shifu compares the current declared Xinfa source-tree hash
with the checked-in manifest. A match uses the Node/WebAssembly host without
Cargo. A mismatch rejects the stale engine, emits one actionable warning, and
falls back to the existing source-fresh native chain: explicit
`KUNGFU_TRUNK_BIN`, Cargo-run linked trunk, then the assembled trunk according
to the existing availability rules. Shifu never silently runs a stale engine
or an arbitrary PATH executable.

### 6. Native production admission remains exclusive

The WebAssembly target may reproduce existing non-qualifying Xinfa compiler
receipts for development and verification. It does not admit runtime facts,
seal Episodes, settle Project Cuts, mint production Kungfu receipts, or become
the production command authority. Those actions remain on the native trunk and
their existing native authorities.

### 7. Release products carry the engine as a verification artifact

Kungfu release products include the engine and manifest as an explicitly named
verification/replay artifact. The public executable remains `kungfu`; the
artifact does not restore a second public Xinfa executable or release line.
Product inventory and release gates verify the exact engine root and do not
claim execution-platform qualification beyond retained evidence.

## Falsification and qualification

This decision is false if:

- native and WebAssembly execution differ in stdout, stderr, exit status,
  canonical roots, receipts, Atlas bytes, or proposed artifact bytes for the
  retained corpus;
- production admission or receipt minting can route through WebAssembly;
- the Node host reimplements Xinfa semantics or requires an npm package;
- Shifu executes an engine whose source-tree hash or artifact hash does not
  match the manifest;
- a checked-in engine lacks an exact reproducible rebuild assertion; or
- release packaging omits or mutates the declared verification artifact.

Qualification on the declared retained producer rebuilds with the pinned
toolchain and checks the exact WebAssembly digest and size. Other hosts verify
that checked-in digest, source freshness, and ABI, then run native and
WebAssembly over the complete golden and negative corpus without claiming that
rustc is byte-identical across compilation hosts. All hosts prove stale-source
fallback, exercise a fresh Node-only checkout with no Rust toolchain on PATH,
check ABI allocation/error boundaries, and verify product archive inventory.
Cross-platform product claims remain limited to the exact retained runners and
artifacts that executed those gates.

## Consequences

- Agent startup can use current Xinfa semantics without a development-time Rust
  compile when the checked-in engine matches the source cut.
- Releases gain a small content-addressed verification surface without adding
  a second compiler authority or public executable.
- The crate gains a deliberately narrow host/core seam and a checked-in binary
  maintenance obligation. Rebuild and byte-equivalence gates are mandatory,
  not optional cleanup.
- Host callback-based lazy reads, browser delivery, WASI CLI packaging,
  libwasm execution, and third-party sandbox profiles remain separate future
  decisions.

## Version impact

This is an additive pre-release update to `xinfa-product-contract`,
`shifu-launcher`, and the Kungfu release artifact inventory. Existing
`xinfa.*` schemas, roots, receipts, CLI meanings, and the native production
authority remain compatible. No stable release line opens.
