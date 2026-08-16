# Fact storage authority qualification

This page states which parts of Kungfu's current fact-storage substrate are
authoritative and implemented, which parts are projections, and which larger
claims remain unqualified. It is an evidence index, not a new storage contract.
The audited source baseline is `c7906973c65259a5d18848f6468e8d5a7f43dfc7`.

## Current answer

Kungfu has an implemented embedded content-addressed fact-storage kernel. The
immutable `content_store` contract and dependency-free file backend are owned by
`libyijinjing`; engine-backed implementations are injected from `libkungfu`.
RocksDB is an optional runtime provider, not a kernel dependency. Python and
Node expose thin bindings over the same C++ surface. Typed source and manifest
catalog journals remain authority; SQLite is rebuildable projection state.

This does **not** qualify a fleet storage service, sharding, object-store cold
tiering, a general mutable KV contract, destructive retention/GC, distributed
query, PB capacity, physical-power-loss durability, or production eligibility.

## Authority and reachability matrix

| Concern | Authority | Current reachability | Evidence | Boundary |
| --- | --- | --- | --- | --- |
| Immutable content identity | SHA-256 content hash in `libyijinjing` | Implemented C++ contract: `put_if_absent`, `get`, `has`, `verify` | `storage/content_store.h`; content-store slice | No mutable overwrite or delete semantics |
| Dependency-free embedded backend | `libyijinjing::file_content_store` | Implemented; atomic temp-file publication, verified reads, declared capabilities | `storage/content_store.cpp`; `slices/content-store/run.mjs` | Single-node embedded profile |
| Concrete engine boundary | `libyijinjing` interface; `libkungfu` implementation | Mechanically enforced against engine includes, symbols, and links | `libyijinjing/check-deps.mjs` and seeded self-test | RocksDB cannot become a kernel dependency |
| RocksDB content backend | `libkungfu` storage provider | Implemented behind the same content-store contract | `runtime/storage/provider.cpp`; Python and Node provider tests | One process-owned handle; not shared multi-process storage |
| Provider lifecycle | `libkungfu` provider cache | One provider per canonical runtime directory and profile for the process lifetime | PR #485; concurrent facade tests | No fleet service or cross-process ownership claim |
| Provider authority and migration | Atomic backend binding generation in `libkungfu` | File↔RocksDB copy, cross-process shared/exclusive write fence, semantic-root verification, resumable state, retained-provider rollback, and Python/Node/CLI receipts | [KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1](../adr/KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1.md); `test_storage_backend_switch.py`; Node authority-atomic binding test | Single-host operation/authority locks; no cross-machine consensus or destructive source cleanup |
| Language bindings | C++ runtime storage service | Python and Node expose symmetric thin facades | `py-runtime.cpp`; `kungfu_node.cpp`; binding tests | JSON/bytes are edge forms, not a second semantic root |
| Source and manifest catalogs | yijinjing append-only Hana POD journals | Implemented typed folds, fsck, rebuild, import/export receipts | `source_registry.h`; `manifest_catalog.h`; `test_episode_manifest_fsck.py`; `test_episode_manifest_projection.py` | JSON is an edge projection; SQLite is rebuildable |
| Fact admission | KFD-1 declaration plus journaled admission history | Initial declaration, observation, admission, correction/retraction, and historical query path implemented | [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](../adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md); `fact_admission.h`; `test_fact_kernel_integrity.py` | Admission is not universal external truth |
| Fact query | C++ query basis, logical plan, authority scan, and lineage | Implemented staged query surface over pinned declarations and cuts | `fact_query.h`; [KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104](../adr/KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104.md) tests | Broader SQL/distributed query qualification is separate |
| Integrity and portability | Journal/catalog authority plus content hashes and manifests | Local fsck, bundle import/export, provider round trips, and Episode payload resolution implemented | storage and Episode tests | Not arbitrary journal repair or remote range/hash sync |
| Durability | Typed facts and named [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](../adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md) profiles | Default-off current-hardware candidate evidence exists | durability qualification and retained evidence | Physical power loss and production eligibility remain false |

Paths in the table are relative to `framework/core/src/libyijinjing/include/kungfu/yijinjing/`,
`framework/core/src/libkungfu/src/`, or `framework/core/tests/` as applicable.

## Fact semantic ownership matrix

The durable schema owner remains the existing yijinjing Hana POD journal. The
typed model below is the single in-process fold projection; it does not add a
wire format or another persisted schema.

| Data | Internal owner | Durable or edge owner | JSON boundary |
| --- | --- | --- | --- |
| Object, Version, Relation, Revocation, Cut, Ref, Transition | `fact_domain.h` aggregates folded by `fact_state.cpp` | Existing `Fact*` Hana records and KFR2/v1 metadata preimages | `fact_domain.cpp` parses verified metadata and renders façade/bundle projections |
| Accepted operation receipt and Root mapping | `operation_receipt` and `root_mapping` in `fact_domain.h` | Adjacent Hana receipt record plus versioned Root protocol | The domain adapter reconstructs non-Root fields from the paired authority record and renders the compatible receipt |
| Authority import/export and fsck | The same typed `kernel_state` and domain aggregates | Journal and content-store roots | Bundle, diagnostics, and failure payloads only |
| Query plan and proof | Typed operator variants, authority variant, Cut proof, issues, conflicts, and content-root evidence in `fact_query.h` | The selected journal cut and declarations | `fact_query.cpp` owns the result/lineage renderer |
| Open query rows | `result_schema` plus positional `dynamic_row` and recursive `query_value` variant | No durable authority; derived at a declared cut | Nullable absent values remain absent at render, preserving the existing result shape |

`scripts/check-fact-kernel-boundary.test.mjs` rejects stable state/proof maps or
rows that regress to `nlohmann::json` semantic bags. Root, Receipt, bundle, and
query-result characterization tests guard the edge bytes and semantics.

## Fact failure and fold diagnostics

Fact operation failures expose two machine-readable levels. Automation uses the
stable `failure_category`, whose closed values are `invalid-request`,
`invalid-action`, `invalid-field`, `invalid-identity`, `stale-ref`, and
`integrity-failure`, and `backend-failure`. `integrity-failure` means persisted
evidence is readable but contradicts its declared root or authority relation;
backend I/O and availability faults remain `backend-failure`. The existing
`failure_code` remains the more specific reason
and may grow as new rejection cases are admitted; `message` is explanatory and
is not an automation contract. Unknown actions fail as `invalid-action`, while
an action of the wrong JSON type and closed-schema field errors fail as
`invalid-field` instead of falling through to another operation.

The native journal fold retains the compatible `counts.unknown_records`
summary and also returns one issue per failed record through a query's `issues`
array. Each issue has exactly `sequence`, `frame_tag`, `record_root`,
`failure_code`, `message`, `phase`, and `recovery`; unavailable sequence or root
identity is `null`. Raw frame bytes and payloads are never included. The Python
integrity fsck, CLI, and Agent-facing storage facade project these same fields
without inventing a second diagnostic taxonomy.

Deterministic durable-admission and authority-import fault injection is a
qualification-only surface. Request JSON cannot enable it. The process must
start with `KUNGFU_FACT_QUALIFICATION_FAULTS=1`; the capabilities document
reports the gate, its disabled default, and its current state.

## Advisory writer-lock contract

Fact storage domains share one cross-platform advisory-file-lock primitive for
the OS-level open, acquire, release, and close mechanics. They do not share a
business lock abstraction: each caller still owns its lock path, protected
critical section, wait policy, permissions, error vocabulary, and recovery or
evidence semantics.

| Domain | Lock path | Mode and region | Wait policy | POSIX permissions | Preserved domain behavior |
| --- | --- | --- | --- | --- | --- |
| Fact mutation/import | `<fact journal>/writer.lock` | Exclusive byte 0 | `ref-cas` blocks; other mutation/import actions fail fast | `0644` | CAS contenders serialize through a fresh fold and reject as `stale-ref`; other contention remains `fact_kernel_writer_busy`; open failure remains `fact_kernel_writer_guard_open_failed` |
| Episode manifest append | `<manifest journal>/writer.lock` | Exclusive byte 0 | Fail fast | `0644` | Existing path-bearing `manifest_writer_guard` and `manifest_writer_busy` errors remain unchanged |
| Backend switch operation | `<runtime>/storage/backend-switch.lock` | Exclusive whole file | Fail fast | `0600` | Any unavailable operation guard remains `backend_switch_busy` |
| Backend authority | `<runtime>/storage/backend-authority.lock` | Shared readers or exclusive writer, whole file | Blocking | `0600` | Acquisition failure remains `backend_authority_lock_failed` |
| Stream ownership | `<data root>/ownership/<scope>/<resource>.lock` | Exclusive; Windows byte at offset `2^32`, POSIX whole-file `flock` | Fail fast | `0644` | Local reservation, evidence I/O, generation/fence advancement, active-owner inspection, and stale-owner recovery remain owned by the ownership domain |

Windows opens lock paths through the filesystem path's wide representation, so
Unicode paths do not regress to an ANSI-only lock boundary. The ownership
offset remains outside its JSON evidence payload; it is intentionally not
normalized to byte 0 because Windows byte-range locks affect reads through
other handles. These non-equivalent policies are explicit inputs to the shared
primitive rather than hidden branches in duplicated lock classes.

## Fact CAS concurrency qualification

Fact `ref-cas` uses the same exclusive writer guard as every other mutation,
but waits for that guard so process scheduling cannot escape as a backend-lock
failure. Once admitted to the critical section, every contender folds the
authoritative journal again and evaluates the exact expected Cut root and
revision. Consequently, contenders released against one old head produce one
accepted transition; all other contenders reject as `stale-ref` without a
journal append.

The native Python characterization suite proves this with independently
spawned processes on a temporary runtime. Workers announce readiness through a
process queue and begin from one event release rather than timing sleeps. The
test checks the accepted response and every rejection, the exact one-transition
authority delta, the matching one-receipt inventory delta, and a fresh verifier
process's replayed head against the winner receipt. The
harness uses Python's `spawn` process context and the cross-platform advisory
lock implementation, so the same test contract applies on Linux, macOS, and
Windows; passing on one host remains evidence for that host, not a claim that
the other CI hosts ran.

## Lifecycle reconciliation

- [KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de](../adr/KF-ADR-019f86da-4f90-70c5-b572-89ec183b37de.md) is `accepted` and `staged`: its provider-neutral service, typed
  catalogs, query, fsck, bundle, projection rebuild, and dry-run maintenance
  slices exist, while destructive maintenance and cross-machine sync do not.
- [KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5](../adr/KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5.md) is `accepted` and `implemented`: source and manifest catalog records
  are typed journal authority; JSON and SQLite are projections.
- [KF-ADR-019f86da-4f90-738c-b372-e509976f69ff](../adr/KF-ADR-019f86da-4f90-738c-b372-e509976f69ff.md) is `accepted` and `implemented` for its embedded first delivery.
  PRs [#476](https://github.com/kungfu-systems/kungfu/pull/476),
  [#480](https://github.com/kungfu-systems/kungfu/pull/480), and
  [#485](https://github.com/kungfu-systems/kungfu/pull/485) close the contract,
  engine injection, binding symmetry, and provider lifecycle gaps. Their commits
  are included in the published
  [`shifu-v4.0.0-alpha.0`](https://github.com/kungfu-systems/kungfu/releases/tag/shifu-v4.0.0-alpha.0)
  tag.
- [KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1](../adr/KF-ADR-019f86da-4f90-713b-a44c-0677d2446cc1.md) is `accepted` and `staged`: the binding, resumable bidirectional
  operation, write fence, rollback, multisurface receipts, and temporary-root
  qualification fixtures are implemented on the current branch; immutable PR
  evidence is recorded only after review and mainline merge.
- [KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03](../adr/KF-ADR-019f86da-4f90-7d81-90a0-d144fc27fe03.md) is `accepted` and `implemented` for the initial KFD-1 declaration and
  admission path; broader domain scaffolding remains incremental.
- [KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca](../adr/KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca.md) remains `accepted` and `staged`; its evidence boundary is authoritative
  for durability claims and is not widened by content-store release inclusion.

## Reproduction

Run the focused checks from the repository root:

```sh
node framework/core/src/libyijinjing/check-deps.mjs --self-test
node framework/core/src/libyijinjing/check-deps.mjs
cmake -S framework/core -B framework/core/build -DKUNGFU_WITH_SLICES=ON
cmake --build framework/core/build --target content_store_probe
node framework/core/slices/content-store/run.mjs
python -m pytest framework/core/tests/python/test_content_store_facade.py framework/core/tests/python/test_storage_backend_switch.py
node --test framework/core/tests/storage-node-binding.test.js
./shifu build:core
./shifu test:advisory-file-lock
./shifu adr:audit -- --json
./shifu docs:check
./shifu check:source
```

The CMake and binding checks require the repository's normal native build
environment. Passing documentation and source checks alone does not substitute
for the native content-store and binding tests.
