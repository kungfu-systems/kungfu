---
status: active
period: 2026-07-10
theme: kfx-execution-profiles
doc_type: architecture-decision
source_level: local-files + official-upstream
confidence: high
sensitivity: public
evidence_grade: B
review_state: user-reviewed
last_reviewed: 2026-07-10
---

# ADR-0045: KFX execution profiles — Rust-primary native, WebAssembly components, managed runtimes, and subprocesses

- Status: accepted (design ratified 2026-07-10; implementation remains gated
  by the native ABI and WASM spikes below)
- Date: 2026-07-10
- Category: extension contract / runtime placement / language policy
- Subsystem: `framework/kfx`, `framework/api`, the libkungfu polyglot membrane,
  the SDK build path, and the future KFX load plan
- Related: [ADR-0006](ADR-0006-v4-frontend-platform-architecture.md),
  [ADR-0013](ADR-0013-cli-runtime-extension-isolation-trusted-channel.md),
  [ADR-0014](ADR-0014-extension-execution-contract-uniform-capability-surface.md),
  [ADR-0017](ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md),
  [ADR-0022](ADR-0022-core-action-recording-surface.md),
  [ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md) (the host
  trunk is the prospective second consumer of the one C ABI decided here), and
  [`docs/rust-adoption.md`](../../../../docs/rust-adoption.md)

## Question

KFX currently has a facet model (`view`, `adapter`, and a proposed `service`),
a source-authority verdict, and trusted-versus-confined landings. It does not
yet give extension authors a durable answer to two different questions:

1. What is the preferred language and ABI for an extension that genuinely
   needs in-process journal performance?
2. Can one portable `.wasm` artifact provide a safer general-purpose extension
   plane without pretending to be the low-latency plane?

Those questions must not be collapsed. Native code optimizes co-resident data
access and accepts the host crash domain. WebAssembly optimizes portability and
capability confinement and accepts a lifted/lowered data boundary.

## Evidence

### Kungfu already has a native extension lineage

The native profile is not a new invention:

- In v3, XTP broker and C++ strategy KFX were compiled as pybind11 native
  modules. `KUNGFU_EXTENSION`, `KUNGFU_DEFINE_MD`, `KUNGFU_DEFINE_TD`, and
  `KUNGFU_MAIN_STRATEGY` instantiated wingchun/libkungfu objects in the loading
  process. A native fault therefore shared that process's failure domain.
- The v4 tree retains `examples/probe-cpp`, which compiles and links directly
  against public libkungfu and yijinjing headers. It is a build-time proof that
  the native link surface still exists.
- `docs/adapters.md` records the current zero-copy boundary: C++, Python, and
  Node bindings all sit over the same in-process libkungfu journal bytes.

The missing piece is not raw feasibility. It is a versioned, language-neutral
extension ABI with an explicit trust and crash-consent contract.

### Rust is feasible, but only behind a C ABI

Rust's native ABI and default type layout are not stable extension contracts.
The official FFI guidance requires `extern "C"` for the platform C calling
convention and `#[repr(C)]` for interoperable layouts, and warns that raw-pointer
correctness remains outside the compiler's proof
([Rustonomicon FFI](https://doc.rust-lang.org/nomicon/ffi.html),
[Rust type layout](https://doc.rust-lang.org/reference/type-layout.html)).
Direct C++ binding generation also leaves important C++ semantics unsupported
or unsafe, including exceptions and several ABI-specific calling rules
([bindgen C++ limits](https://rust-lang.github.io/rust-bindgen/cpp.html)).

Therefore Rust can become the preferred native KFX authoring language only if
libkungfu owns one C ABI and both language experiences wrap it. Rust is not a
license to expose C++ classes, STL types, FlatBuffers implementation types, or
Rust layout across the extension boundary.

### WebAssembly is portable because it is not the native data plane

The Component Model uses WIT plus a canonical ABI so components written in
different languages can exchange high-level values
([Canonical ABI overview](https://component-model.bytecodealliance.org/advanced/canonical-abi.html)).
That interoperation is shared-nothing: strings and lists are lifted and lowered
through component linear memory. Current discussions about zero-copy buffers
explicitly identify copying between separate memories as the default and shared
memory as unresolved design work
([flat-data proposal](https://github.com/WebAssembly/component-model/issues/398),
[efficient memory passing](https://github.com/WebAssembly/component-model/issues/314)).

Consequently a WASM KFX must not receive a raw mmap pointer or claim journal
zero-copy. It receives bounded capability values, batches, resources, or
streams. The copy is part of the security boundary, not an optimization bug.

Rust's `wasm32-wasip2` target now emits components and is a Tier 2 target; the
Rust documentation describes WASI Preview 2 as an island of stability while
still calling the wider specification active
([rustc WASIp2 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html)).
WASI 0.3 adds native async component primitives, but toolchain/runtime support
is still landing, so KFX should begin with a narrow synchronous/batched WIT
world rather than make WASI 0.3 a launch dependency
([WASI 0.3 announcement](https://bytecodealliance.org/articles/WASI-0.3)).

### Runtime comparison

| Criterion | Wasmtime | Wasmer | Consequence for KFX |
|---|---|---|---|
| Component Model | First-class `wasmtime::component` API; enabled by default | The current 7.1 top-level API and official docs emphasize core Wasm modules and WASIX; no equivalent first-class component embedding surface was found in the reviewed public API | Wasmtime has materially lower standards-integration risk |
| Host integration | Rust API plus maintained C/C++ API and release artifacts | Rust API, multiple compilers/runtimes, headless mode | Both are embeddable; Wasmtime aligns better with WIT components |
| Maturity caveat | Component Model is enabled and largely implemented, but is not a final WebAssembly phase and C API gaps remain | Backend flexibility is strong, but KFX would need to prove the component toolchain itself | Neither choice removes the need for a spike |
| License | Apache-2.0 | MIT | Both are compatible with Kungfu's Apache-2.0 distribution |

Sources: [Wasmtime introduction](https://docs.wasmtime.dev/),
[Component API](https://docs.wasmtime.dev/api/wasmtime/component/index.html),
[proposal support matrix](https://docs.wasmtime.dev/stability-wasm-proposals.html),
[C/C++ embedding API](https://docs.wasmtime.dev/c-api/),
[Wasmtime repository](https://github.com/bytecodealliance/wasmtime),
[Wasmer 7.1 API](https://docs.rs/wasmer/latest/wasmer/), and
[Wasmer license](https://github.com/wasmerio/wasmer/blob/main/LICENSE).

Wasmtime is the provisional choice. Wasmer remains a measured fallback if a
future component API or a footprint/startup spike clearly wins. Absence from a
reviewed public API is not treated as proof that Wasmer can never support the
Component Model.

## Decision

### 1. Define four execution profiles, not four trust tiers

The existing trust axis (verified source or untrusted) and co-residence axis
remain authoritative. The profiles below describe how code is built and landed;
the load plan still decides whether a given artifact is admitted, confined, or
refused.

| Profile | Typical artifact and landing | Data boundary | Trust / failure domain | Preferred languages | Distribution |
|---|---|---|---|---|---|
| **native** | trusted in-process dynamic library | direct capability handles and mmap-backed journal views; no payload copy | explicit highest-trust grant; panic, UB, or segfault can terminate the host | **Rust preferred**, C++ supported | per OS / arch / ABI artifact |
| **wasm** | WebAssembly component in an embedded Wasmtime store | WIT canonical ABI; bounded batches/resources/streams; at least one linear-memory copy for variable-size payloads | VM confinement plus host capability allowlist; traps are contained, engine defects remain in the host threat model | any language with a conforming component toolchain | one portable `.wasm` artifact per compatible component world |
| **managed** | current JS/Python view, adapter, or interpreted service landing | current in-process or capability-relay transport selected by trust and facet | current renderer/adapter/service rules; untrusted adapters are refused | JavaScript/TypeScript and Python | JS bundle or managed source package |
| **subprocess** | independent `service` process or external executable | process IPC, stdio relay, or journal protocol | OS process/sandbox boundary; child crash does not corrupt the host | any language/runtime | source, prebuilt executable, or other platform-specific package |

`facet` and `profile` answer different questions. A `service` may be managed,
WASM, or subprocess-backed. A native profile is necessarily co-resident and
trusted. A WASM profile is not a way to smuggle Python/Node native modules into
WASI; it is its own pure-component form.

### 2. Make Rust the native authoring default only after five gates

1. **One C ABI is the source of truth.** The C++ core owns a versioned table of
   opaque handles, fixed-width scalar/POD types, lifecycle functions, error
   codes, and capability entrypoints. No C++ or Rust ABI crosses the boundary.
   This ABI has a second consumer already queued: the host trunk
   ([ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md)) plans to
   route its embedding seam through the same membrane rather than a parallel
   exported-C++ contract — one more reason no single consumer's convenience
   may leak language-specific types across it.
2. **Two thin language layers wrap the same ABI.** An official `kungfu-kfx`
   crate contains the unsafe calls and exposes a safe Rust API. A C++ header
   provides RAII/convenience over the same C functions. Neither layer owns
   journal semantics.
3. **No per-frame FFI callback.** The ABI is lifecycle-, handle-, and batch-
   oriented. A design that requires a language crossing for every journal frame
   fails the gate. Direct mapped views remain explicitly unsafe and versioned.
4. **No unwind crosses the boundary.** Rust panics and C++ exceptions are
   contained or abort according to the declared profile. The native artifact
   cannot rely on cross-language unwinding.
5. **Consent and provenance are explicit.** The runtime displays that native
   KFX shares the host crash domain, verifies the artifact's authority/content,
   and records the grant as a fact. A manifest cannot self-elevate.

Rust becomes the documentation/scaffold default after these gates because it
offers a bounded unsafe membrane and a safer default authoring experience.
C++ remains fully supported for existing integrations, vendor SDKs, and users
who need direct compatibility with the C++ ecosystem. “Rust preferred” is an UX
policy, not removal of C++ and not a rewrite of the C++ core.

### 3. Build the WASM profile around a narrow `libwasm` host

The first spike should use Wasmtime's Rust component API behind a small C ABI
owned by a dedicated `libwasm` host layer. This avoids pinning KFX to the known
gaps in the Wasmtime Component C API while keeping libkungfu in control of
admission, capabilities, facts, and receipts. It is an explicit exception to
the current “Rust at process boundaries by default” policy and must not be
accepted until the spike proves that the maintenance surface is bounded.

The initial WIT world must:

- import only KFX capabilities selected by the host; do not inherit ambient
  WASI filesystem, network, environment, or clock authority by default;
- expose coarse batch/resource calls, not raw journal memory or per-frame
  callbacks;
- version the world independently from the package manifest schema;
- meter fuel/epoch time, memory, table count, and output size;
- emit load, capability, trap, limit, and artifact-hash receipts to the normal
  Kungfu fact surface;
- keep the component artifact independent of Wasmtime-specific host types.

### 4. Treat latency numbers as gates, not claims

No KFX Wasmtime microbenchmark exists in this branch, and no runtime was
installed for this research. The cost statement that is already justified is
structural: native passes handles/views without copying payload bytes; canonical
ABI strings/lists are `O(n)` and require linear-memory allocation/copy.

The implementation spike must publish p50/p99 and bytes-copied evidence on
macOS arm64, Linux x64, and Windows x64. Proposed go/no-go ceilings are:

| Probe | Native profile gate | WASM profile gate |
|---|---:|---:|
| empty/control call, warm | p99 <= 1 microsecond | p99 <= 10 microseconds |
| 4 KiB host-to-guest-and-back batch, warm | no payload copy; p99 <= 5 microseconds | p99 <= 50 microseconds |
| 1 MiB one-way batch | direct view, no copy | effective copy throughput >= 1 GiB/s |
| steady-state memory per idle instance | extension-owned delta reported | <= 16 MiB excluding shared engine code |

These are product budgets to falsify, not measured performance. Wasmtime's own
public issue history shows that allocator configuration can change whole-request
throughput by more than an order of magnitude, so the spike must record engine
configuration as evidence rather than report a single “WASM is fast” number
([Wasmtime issue 8034](https://github.com/bytecodealliance/wasmtime/issues/8034)).

The native half now has a provisional implementation and evidence in
[`docs/libkungfu-embedding-membrane-spike.md`](../../../../docs/libkungfu-embedding-membrane-spike.md):
one core-owned v1 table, C++ and safe Rust wrappers, no per-frame callback,
borrowed mmap pages with explicit batch release, and contained exceptions.
macOS arm64 passes the native budgets; Linux x64 and Windows x64 remain pending
the spike PR matrix. This does not start the WASM spike or change the KFX
manifest/contract.

## Contract obligations

Any future manifest schema for these profiles must make the following facts
machine-readable without letting the package grant itself authority:

- artifact kind, profile, runtime, entry, target triple/component world, and ABI
  version;
- declared capabilities and resource ceilings;
- content hash and source-authority evidence;
- host-resolved trust, confinement, and user-consent result;
- lifecycle and failure receipts;
- explicit copy/zero-copy semantics for every journal-facing capability.

The current `kungfu-kfx.contract.json` is unchanged by this ADR. Adding these
fields is a separate KFD-1 contract change after the profile decision and
spikes. The existing uniform asynchronous capability surface remains the author
contract; the profile selects the transport and data representation beneath it.

## Delivery sequence

1. **Decision gate:** approve, revise, or reject the four-profile vocabulary
   and Rust-primary native policy.
2. **Native ABI spike:** lifecycle + one read-only batched journal capability;
   generate the Rust safe wrapper and C++ convenience header from one reviewed
   C surface. Do not modify the memory-safety core.
3. **WASM spike:** one Wasmtime component with no ambient WASI rights, the same
   read-only capability, the three-platform benchmark, footprint, and receipts.
4. **Contract proposal:** only after both spikes, propose the minimal manifest
   version and KFD-1 version impact.
5. **Authoring UX:** scaffold and documentation may recommend Rust only after
   the ABI/conformance suite is green; C++ remains available.

## Ratification

The maintainer ratified all five decision points on 2026-07-10:

1. `execution profile` is a separate axis from facet and trust tier;
2. Rust becomes the preferred native authoring UX only after the five gates,
   while C++ remains supported and the core remains C++;
3. the bounded `libwasm` Rust-host exception is allowed behind a small C ABI,
   subject to a spike proving that the maintenance boundary stays bounded;
4. Wasmtime is the provisional primary engine and Wasmer remains a measured
   fallback; and
5. the native ABI spike runs before the WASM spike, with both profiles sharing
   one explicit host capability membrane.

Ratification does not authorize implementation, change the current KFX
contract, or claim that any spike gate has passed.

## Kill or archive conditions

- Archive the native profile if current users no longer need sub-process-boundary
  latency, or if the ABI cannot avoid per-frame FFI and leaking core layout.
- Keep native C++-only rather than force Rust if the safe wrapper cannot cover
  the required API without exposing broad unsafe regions.
- Downgrade WASM to an experimental subprocess/service path if the component
  host misses the performance/footprint gates or cannot emit auditable limits
  and receipts.
- Re-open the runtime choice if Wasmtime's component support regresses, its
  embedding surface cannot meet the three-platform contract, or another engine
  wins the same evidence suite materially.

## Explicitly out of scope

- Changing `kungfu-kfx.contract.json` or any runtime loader.
- Adding a Rust binding crate, C ABI, Wasmtime/Wasmer dependency, or `.wasm`
  build pipeline.
- Rewriting the C++ journal/storage core or moving action-recording semantics
  out of the core.
- Claiming native fault isolation or WASM zero-copy journal access.
