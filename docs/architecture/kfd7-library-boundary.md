# KFD-7 library boundary inventory

This is an auditable current-state inventory and migration cache. The accepted
decision is [ADR-0120](../adr/ADR-0120-kfd7-library-boundary-and-successor-abi.md);
the machine source is
[`kfd7-library-boundary.contract.json`](../../framework/core/architecture/kfd7-library-boundary.contract.json).
Repository files and qualified artifacts remain the underlying facts.

## Target ownership

| Responsibility | Final owner | Current owner/evidence | Migration state |
| --- | --- | --- | --- |
| frame/page mmap, reader/writer, ordering, journal replay input | `libyijinjing` | `src/libyijinjing` | owned correctly |
| content hashes, content store, source/manifest catalogs, provider-neutral storage contracts | `libyijinjing` | `src/libyijinjing/include/kungfu/yijinjing/storage*` | owned correctly |
| Episode identity, causal records, append/seal/recovery primitives | `libyijinjing` substrate; `libkungfu` orchestration | manifests partly in `libyijinjing`; lifecycle/admission/repair in `libkungfu` | characterize and split |
| Fact identity/version/relation/Cut/ref/CAS protocol and authoritative fold | `libyijinjing` | contract in `framework/fact`; implementation in `libkungfu/.../fact_kernel.cpp` | dependency-gated move |
| Root canonical encoding | protocol contract consumed by `libyijinjing` | staged Fact Kernel implementation; independent protocol goal paused | do not move or reinterpret yet |
| storage service composition and runtime lifecycle | `libkungfu` | `libkungfu/runtime/storage/service*` | remains above kernel |
| file/RocksDB providers, SQLite projections, transport and process utilities | `libkungfu` adapters | `libkungfu/runtime/storage/provider*`, `io`, `util`, projections | remains above kernel |
| zero-copy stream and generic decode/checksum membrane | `libkungfu` public ABI | `embedding.h` v1-v4 | successor stream adapter |
| Fact/Episode/ActionBinding operations and receipts | `libkungfu` public ABI over one authority | partial `native_storage.h` v1 operation+JSON edge | successor ledger-action interface |
| diagnostics, maintenance, recovery planning | `libkungfu` public ABI | split between embedding v2/v4 and storage service | successor maintenance interface |
| Pursuit, Atlas, Warrant responsibility boundaries, non-substitution invariants, and session refinement | Action Geometry contract above the reality kernel | KFD-7 action contract, Agent Work contract, Action MJS | separate from Domain Profile semantics |
| Pursuit, Atlas, Warrant domain fields, lifecycle vocabulary, defaults, validation, presentation, and success policy | Domain Profiles | current combined Agent Work contract, Profile/runtime modules | split behind compatibility adapters |
| TrustReport and KFD-2 assessment policy | Profile/application service | `libkungfu/runtime/trust` | remains above kernel |
| Python, Node, Rust, CLI, GUI and MJS ergonomics | thin hosts/wrappers | bindings and framework packages | no authority allowed |
| shared `libyijinjing` product or ABI | none | source/static embedding only | explicitly not planned |

## Current native ABI

| Symbol | Versions | Currency | Strength | Long-term disposition |
| --- | --- | --- | --- | --- |
| `kungfu_embedding_get_api` | v1-v4 | C structs, borrowed mmap views, JSON diagnostic reports | proven version/size negotiation and zero-copy data plane | retain as compatibility adapter; successor stream/maintenance interfaces absorb new work |
| `kungfu_native_storage_get_api` | v1 | operation name plus JSON request/result | language-host-free entry to a bounded subset of current storage operations | retain as compatibility adapter; do not grow into the final semantic ABI |
| `kungfu_get_api` | planned | discovery plus separately versioned interfaces and protocol/schema-tagged bytes | not implemented, exported, packaged, or stable | new-consumer target only after qualification |

The current storage bootstrap advertises seven capability bits but allows only
18 operation names. It reaches Episode begin/end, Fact query and selected Fact
operations, fsck/export, assessment/trust, and `fact_kernel`. It does not
provide the complete lifecycle, backend, recovery, import, cancellation, or
ActionBinding surface required by the target contract. JSON is its named edge
currency and therefore cannot be reused as the implicit canonical Root format.

## Language and product surfaces

| Surface | Valid responsibility | Current risk to close |
| --- | --- | --- |
| C/C++ | stable C ABI and source-only C++ conveniences | no installed CMake consumer package; two bootstraps; only partial semantic coverage |
| Python | CLI/SDK/rendering and thin native projection | remaining recovery/retry/writer-liveness decisions are owned by the native-closure dependency |
| Node/Electron | UI/product host and thin native projection | must resolve the same interface registry and errors as C/Python |
| Rust | safe wrapper and host trunk | current embedding proof is not yet the final successor binding |
| Action MJS | pure declarations, validation, plans, and projections | must call public Core adapters for authority; cannot use private layouts |
| CLI/agent docs/site | discovery and human/Agent explanation | must be generated or checked against the machine contract rather than copy inventories |
| Buildchain | release evidence and surface classification | must distinguish consumer-ready, experimental, compatibility-only, and residual risk |

## Packaging and consumer gaps

- `yijinjing` is intentionally a source/static CMake target with C++20 and
  declared header-only dependencies. It has no shared artifact or ABI promise.
- `libkungfu` is shared on macOS/Linux and static in the main Windows build;
  Windows provides narrow DLL entry targets for public C membranes.
- The repository does not yet install a supported `Kungfu::kungfu` CMake
  package, public native SDK layout, or repo-external installed/shared example.
- Public-header self-compilation and frozen old-consumer tests exist, but
  package-coordinate and clean-scratch consumption evidence remains open.
- Architecture authority recorded embedding ABI v1-v3 even though v4 is live;
  ADR-0120 corrects that factual drift and adds a frozen v4 caller check.

## Dependency boundary

Three direct dependencies are paused and have no admitted implementation root
for this goal:

| Goal | Owns | Required before |
| --- | --- | --- |
| Fact native foundation closure | complete `language_hosts=0` lifecycle, recovery, writer liveness, and ABI coverage | final ledger-action coverage and native-closure claim |
| Fact Root canonical encoding | implementation-independent bytes, vectors, and successor/legacy rules | canonical request/Root portability claim or Root-code movement |
| Fact Kernel internal decomposition | characterized protocol/fold/commit/query boundaries | moving the generic Fact authority into `libyijinjing` |

The current stage may freeze ownership, compatibility, and the successor ABI
shape. It must not manufacture dependency roots, move Root/Fold code, or claim
consumer readiness from planned interfaces.

## Migration matrix

| Stage | Change | Required proof | State |
| --- | --- | --- | --- |
| 0 | inventory current ownership, public ABI, packages, and dependencies | checked machine contract and ADR | implemented in this stage |
| 1 | add `kungfu_get_api`, discovery v1, stream v1 adapter, stable error dictionary | public-header compile, symbol policy, old/new negotiation, v1-v4 legacy callers | planned |
| 2 | qualify canonical Root protocol and decompose the authoritative Fact Kernel | exact canonical bytes, independent implementation, characterization, no-write failures | waiting on dependencies |
| 3 | move generic Fact/Episode slices to `libyijinjing`; add ledger-action and maintenance interfaces | `language_hosts=0`, parity, crash/restart, provider switch, import/export | waiting on dependencies |
| 4 | publish native SDK coordinates, examples, wrappers, conformance corpus, and package discovery | clean repo-external source/static and installed/shared consumers | planned |
| 5 | delegate legacy bootstraps to the successor and qualify supported platforms | exact schemas, roots, errors, receipts, compatibility and platform evidence | planned |

## Non-claims

This inventory does not claim that the successor symbol exists, the Fact
Kernel has moved, Root encoding is independently portable, a shared Windows
`libkungfu` exists, release artifacts contain a native SDK, supported platforms
are qualified, or external consumers have adopted the surface.
