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
| Episode identity, causal records, append/seal/recovery primitives | `libyijinjing` substrate; `libkungfu` orchestration | typed manifest authority and source/static Episode records in `libyijinjing`; runtime admission/repair composition in `libkungfu` | owned at the intended split |
| Fact identity/version/relation/Cut/ref/CAS authority | `libyijinjing` typed authority; `libkungfu` request validation and JSON/materialized projections | `fact_ledger_store` owns record/receipt pairing, replay verification, recovery disposition, and native snapshot export; `fact_kernel` retains protocol orchestration | characterized slice moved |
| Root canonical encoding | versioned protocol consumed across both libraries | KFR2 writer plus exact legacy reader and independent Python corpus | dependency admitted; no reinterpretation |
| storage service composition and runtime lifecycle | `libkungfu` | `libkungfu/runtime/storage/service*` | remains above kernel |
| file/RocksDB providers, SQLite projections, transport and process utilities | `libkungfu` adapters | `libkungfu/runtime/storage/provider*`, `io`, `util`, projections | remains above kernel |
| zero-copy stream, generic decode/checksum, maintenance-plan and read-only storage-status membrane | `libkungfu` public ABI | `api.h` stream and maintenance v1 tables | owned correctly |
| Fact/Episode/ActionBinding operations and receipts | `libkungfu` public ABI over one authority | `api.h` ledger-action v1 | owned correctly |
| diagnostics, maintenance, recovery planning | `libkungfu` public ABI | `api.h` maintenance v1 | owned correctly |
| Pursuit, Atlas, Warrant responsibility boundaries, non-substitution invariants, and session refinement | Action Geometry contract above the reality kernel | KFD-7 action contract, Agent Work contract, Action MJS | separate from Domain Profile semantics |
| Pursuit, Atlas, Warrant domain fields, lifecycle vocabulary, defaults, validation, presentation, and success policy | Domain Profiles | current combined Agent Work contract, Profile/runtime modules | projected above the standard ABI |
| TrustReport and KFD-2 assessment policy | Profile/application service | `libkungfu/runtime/trust` | remains above kernel |
| Python, Node, Rust, CLI, GUI and MJS ergonomics | thin hosts/wrappers | bindings and framework packages | no authority allowed |
| shared `libyijinjing` product or ABI | none | source/static embedding only | explicitly not planned |

## Current native ABI

| Symbol | Versions | Currency | Strength | Long-term disposition |
| --- | --- | --- | --- | --- |
| `kungfu_get_api` | v1 | discovery plus separately versioned interfaces and protocol/schema-tagged bytes | implemented behind a one-export façade; qualified as an installed consumer on Darwin arm64, Linux x64, and Windows x64 | standard-only pre-release target |

The ledger-action and maintenance tables advertise the bounded storage
capabilities and allow forty operation names. They reach the language-host-free Episode
lifecycle, recovery and projection rebuild; Fact query/admission/Cut-kernel
and Fact Library operations; fsck, export/import, index rebuild, backend
lifecycle, and assessment/trust. Their v1 semantic surface remains an
operation-name plus named JSON edge. The standard ABI provides discovery, stream, ledger-action,
and maintenance v1 tables, an exact seven-root ActionBinding, stable numeric
statuses, owner-thread handles, cancellation-before-admission, and explicit
protocol/schema/encoding fields. JSON is a named v1 edge encoding and does not
define Root identity. Its executable runtime rules are fixed by the
[embedder operational semantics](../guides/libkungfu-abi-consumer.md):
timeout is reserved in v1, stream cancellation checkpoints every 32 frames,
and hard deadlines discard a worker process rather than preempting a C++
thread.

## Language and product surfaces

| Surface | Valid responsibility | Current risk to close |
| --- | --- | --- |
| C/C++ | versioned C ABI and source-only C++ conveniences | installed `Kungfu::kungfu`, C and C++ scratch consumers, exact symbol policy, and supported-platform matrix qualified |
| Python | CLI/SDK/rendering and thin native projection | remaining recovery/retry/writer-liveness decisions are owned by the native-closure dependency |
| Node/Electron | UI/product host and direct in-process C++ storage-service consumer | no successor ABI reference wrapper is currently claimed |
| Rust | safe wrapper and host trunk | both use standard discovery and responsibility tables |
| Action MJS | pure declarations, validation, plans, and projections | must call public Core adapters for authority; cannot use private layouts |
| CLI/agent docs/site | discovery and human/Agent explanation | must be generated or checked against the machine contract rather than copy inventories |
| Buildchain | release evidence and surface classification | machine passport distinguishes consumer-ready, experimental, and residual-risk surfaces and binds the exact three-platform reports |

## Packaging and consumer gaps

- `yijinjing` is intentionally a source/static CMake target with C++20 and
  declared header-only dependencies. It has no shared artifact or ABI promise.
- `libkungfu` is shared on macOS/Linux and static in the main Windows build;
  Windows provides narrow DLL entry targets for public C membranes.
- The repository installs the narrow façade, private runtime dependency, two
  public headers, machine contracts, guide, examples, and a versioned
  `Kungfu::kungfu` CMake package.
- Clean scratch C and C++ consumers use only that installed coordinate; the
  source/static example independently writes and verifies Fact record/receipt
  pairs plus Episode records with `language_hosts=0`.
- The only public export is `kungfu_get_api`.
- The public export inventory is fail-closed through
  `libkungfu-symbol-policy.json`: an authorization-only change must reach the
  target branch before implementation, the implementation change cannot alter
  that authorization, and only entries with complete supported-platform
  qualification may become link-visible. Ordinary capability growth uses a new
  interface or interface version behind the existing bootstrap.
- The sole-bootstrap Darwin/Linux/Windows installed-consumer qualification is
  bound to source revision
  `5901fd0255e2c259454e4208736bd90c07f8ba49` by
  [run 29825943409](https://github.com/kungfu-systems/kungfu/actions/runs/29825943409).
  Its three retained reports prove the exact one-export policy, installed C and
  C++ consumers, and the language-host-free source/static consumer.
- The immediately preceding qualification remains historical evidence only. Run
  [29809371727](https://github.com/kungfu-systems/kungfu/actions/runs/29809371727)
  passed at source revision
  `b2994d0d8016e152710124172147c84ffb536fa7`.
- The KFD Agent Runtime reference adapter is an in-process consumer of the
  standard public C membrane and exposes a separate JSONL process protocol; it
  does not add a fourth exported `libkungfu` bootstrap.

## Dependency boundary

All three direct dependencies are complete and admitted by exact roots:

| Goal | Owns | Required before |
| --- | --- | --- |
| Fact native foundation closure | complete `language_hosts=0` lifecycle, recovery, writer liveness, and ABI coverage | `sha256:f8a0cfe31ce213b541ec2d7d6a1656c7350c2fec3ec451faa7b22685b145a9f1` |
| Fact Root canonical encoding | implementation-independent bytes, vectors, and successor/legacy rules | `sha256:d8feb83845e3c9fbff4f26019fa72645a2812becbeb7c32fbde3423235d23944` |
| Fact Kernel internal decomposition | characterized protocol/fold/commit/query boundaries | `sha256:753ef35095a7c66511508e5bc6d7ddcc86c70d0e4c94d2523cbdca862798cbd8` |

The implementation consumes these roots and moves only the provider-neutral
typed authority slice. It does not duplicate their codecs, reinterpret persisted
roots, or move JSON/Profile/provider policy below the membrane.

## Migration matrix

| Stage | Change | Required proof | State |
| --- | --- | --- | --- |
| 0 | inventory current ownership, public ABI, packages, and dependencies | checked machine contract and ADR | implemented in this stage |
| 1 | add `kungfu_get_api`, discovery v1, stream v1 adapter, stable error dictionary | public-header compile and exact symbol policy | implemented and qualified |
| 2 | qualify canonical Root protocol and decompose the authoritative Fact Kernel | exact canonical bytes, independent implementation, characterization, no-write failures | complete by admitted dependencies |
| 3 | move generic Fact/Episode slices to `libyijinjing`; add ledger-action and maintenance interfaces | `language_hosts=0`, pairing/replay/recovery, crash/restart, provider and transfer regressions | implemented and qualified |
| 4 | publish native SDK coordinates, examples, wrappers, conformance corpus, and package discovery | clean repo-external source/static and installed/shared consumers | implemented and qualified |
| 5 | migrate first-party consumers, retire pre-standard adapters, and qualify supported platforms | exact schemas, roots, errors, receipts, installed artifacts and platform evidence | implemented and qualified |

## Non-claims

This inventory does not claim that every Fact protocol/policy implementation
moved below the membrane, that `libyijinjing` has a shared ABI, that Node has a
successor ABI reference wrapper, that external consumers have adopted it, or
that it is battle-tested.
