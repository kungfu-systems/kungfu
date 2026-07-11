---
status: accepted
period: 2026-07-11
theme: libwasm-production-runtime
doc_type: architecture-decision
source_level: local-files + executable-probe + official-upstream
confidence: high
sensitivity: public
evidence_grade: B
review_state: user-reviewed
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-11
  visible_context: ADR-0045, the merged dual-engine spike, Kungfu fact admission, the product assembly path, and Wasmer 7.2 metering middleware
  invisible_context_boundary: Future engine releases and unobserved release-candidate behavior remain outside this decision
---

# ADR-0054: libwasm is a governed product runtime, not a copied spike library

- Status: accepted
- Date: 2026-07-11
- Category: KFX runtime / capability admission / distribution
- Related: [ADR-0045](ADR-0045-kfx-execution-profiles-native-rust-wasm.md),
  [ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md), and
  [ADR-0051](ADR-0051-kfd-contract-world-fact-admission-and-trust.md)

## Context

The ADR-0045 spike proved that Wasmtime and Wasmer can consume the same
libkungfu batch capability through one C ABI on macOS ARM64, Linux x64, and
Windows x64. It deliberately remained under `KUNGFU_WITH_SLICES=ON`: its guest
was embedded test bytecode, Wasmer had no CPU meter, and no product artifact,
KFX manifest, admission decision, or durable receipt referred to it.

Copying those `*_spike` libraries into `dist/kungfu` would turn test evidence
into an accidental compatibility promise. Production entry requires one
contract that binds the artifact, explicit human capability consent, resource
limits, engine result, durable fact admission, packaging, and release
qualification.

## Decision

### 1. One engine-neutral guest world lands before Component Model parity

The first production world is `kungfu:journal/batch@1.0.0`. It is a versioned
core-Wasm lowering of the adjacent WIT contract, with these exports:

- fixed-size exported memory named `memory`;
- `kf_control_v1() -> s32`;
- `kf_consume_v1(ptr: s32, len: s32) -> s64`.

The module has no imports, start function, table, WASI, filesystem, network,
environment, clock, or raw journal pointer. The host copies one bounded batch
into linear memory and invokes the guest once. This is the engine-neutral
fallback contract. A future Component Model adapter may implement the same WIT
world, but cannot replace or silently mutate version 1.

### 2. Wasmtime is primary; Wasmer is a real fallback only with metering

Wasmtime uses fuel. Wasmer uses its 7.2 compiler metering middleware with the
same operator cost policy and reports exhausted points as a limit receipt.
Both engines also enforce module size, fixed memory-page ceilings, no tables,
no imports, bounded batch size, fixed output, trap containment, and panic
containment. Automatic fallback happens only when the primary adapter is
unavailable; a guest rejection, trap, hash mismatch, or exhausted budget is
not retried under a second engine.

### 3. The manifest declares; the caller grants; libkungfu records

`kungfuConfig.config.wasm` declares the world, artifact path and SHA-256,
capabilities, engine policy, and limits. It cannot grant itself authority.
`kungfu kfx run-wasm` requires an explicit `--grant` for every capability and
refuses undeclared or ungranted capabilities before starting the host.

The native host independently rechecks the artifact hash, world, capability
mask, and limits. It records a pre-execution admission fact and a
post-execution receipt through ADR-0051's journal-owned fact admission surface.
The JSON bodies are stored under the runtime receipt directory; the fact
journal carries their canonical hashes and references. Execution does not
start unless the admission observation is itself admitted.

### 4. The product owns the runtime artifact closure

The normal core build produces a production-named host and two replaceable
engine adapters. Freeze/assembly places the host at the runtime root and the
adapters plus contract under `dist/kungfu/libwasm/`. Desktop and CLI products
already copy that complete core runtime tree, so they inherit exactly one
libwasm closure.

The compatibility manifest hashes the public C ABI, guest contract, host, and
adapter tree. Release verification checks those files and includes a deletion
test: removing the host, either promised adapter, or the contract must fail
qualification. Dedicated spike targets remain evidence-only and never satisfy
the release check.

## Production gate matrix

| Gate | Required evidence | Failure behavior |
|---|---|---|
| artifact identity | manifest SHA-256 equals bytes rehashed by the host | reject before compile |
| capability consent | declared capabilities equal explicit grants | reject before host start |
| guest contract | exact world v1, required exports, no imports/start/table | reject before instantiate |
| CPU | Wasmtime fuel or Wasmer metering points | contained limit receipt |
| memory/output | fixed pages and fixed scalar/report output | reject or contained limit receipt |
| execution | one libkungfu batch crossing and one guest call per batch | qualification failure |
| receipts | admitted preflight fact plus durable execution fact | execution is not successful |
| distribution | host, both promised adapters, ABI and contract in final artifact | block release |
| platforms | source build and installed-artifact smoke on macOS/Linux/Windows | block support claim |

## Compatibility and versioning

This adds a new KFX manifest facet, public C ABI, command, runtime files, and
default release behavior. It is a minor-version candidate under KFD-1, not a
patch-only spike. ABI v1 and world `1.0.0` are welded once released; engine SDK
types, adapter filenames behind the runtime contract, and internal compiler
configuration remain replaceable.

## Stop lines

- Do not ship Wasmer as a promised fallback if metering does not pass on all
  supported platforms.
- Do not add ambient WASI imports to world v1.
- Do not move journal/storage semantics or raw mmap ownership into Rust.
- Do not retry security or guest failures under another engine.
- Do not advance ADR-0046 Stage 3 as part of this work.
