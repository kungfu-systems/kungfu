---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: ongoing
theme: kungfu-core-architecture
doc_type: architecture-map
sources: [local-files]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-15
---

# Core Layer Map

This map is a checked projection of [`layers.json`](layers.json). Edit the
contract first, then update this projection; `check-layers.mjs` rejects drift.

Dependency direction is downward: composition and bindings may consume adapters
and services; the journal kernel may consume only schema/value contracts.

## Layers

| Order | Layer | Responsibility | May depend on |
| ---: | --- | --- | --- |
| 0 | `schema-values` | Stable value and schema contracts shared by the journal kernel. | `schema-values` |
| 1 | `journal-kernel` | Journal, mmap, hash, content and storage semantic kernel without runtime engines. | `journal-kernel`, `schema-values` |
| 2 | `ports-contracts` | Public runtime contracts and ports, independent of concrete adapters and bindings. | `ports-contracts`, `journal-kernel`, `schema-values` |
| 3 | `application-services` | Runtime application services for durability, state, query, trust, live and storage orchestration. | `application-services`, `ports-contracts`, `journal-kernel`, `schema-values` |
| 4 | `adapters` | Concrete storage, transport, OS, FlatBuffers and process adapters. | `adapters`, `application-services`, `ports-contracts`, `journal-kernel`, `schema-values` |
| 5 | `composition-bindings` | Composition roots and C, Python, Node and WASM-facing bindings. | `composition-bindings`, `adapters`, `application-services`, `ports-contracts`, `journal-kernel`, `schema-values` |
| 6 | `qualification` | Native qualification fixtures and tests; never a production dependency. | `qualification`, `composition-bindings`, `adapters`, `application-services`, `ports-contracts`, `journal-kernel`, `schema-values` |

## Components

Current targets describe the checked build graph. Internal component targets
remain private implementation details behind the public `kungfu` facade.
The production graph is budgeted to 6-12 bounded components.

| Component | Layer | Owner | Files | Current targets | Contract tests | Entry points |
| --- | --- | --- | ---: | --- | --- | --- |
| `yijinjing-schema` | `schema-values` | `core/schema` | 5 | `yijinjing` | `yijinjing_content_hash_tests` | `src/libyijinjing/include/kungfu/yijinjing/schema/core.h` |
| `yijinjing-kernel` | `journal-kernel` | `core/yijinjing` | 49 | `yijinjing` | `yijinjing_mmap_tests`<br>`yijinjing_fact_ledger_tests`<br>`yijinjing_custom_provider_qualification` | `src/libyijinjing/include/kungfu/yijinjing/journal/journal.h`<br>`src/libyijinjing/include/kungfu/yijinjing/storage.h`<br>`src/libyijinjing/include/kungfu/yijinjing/storage/fact_ledger.h` |
| `libkungfu-contracts` | `ports-contracts` | `core/runtime-contracts` | 67 | `yijinjing`<br>`kungfu_contracts`<br>`kungfu` | `kungfu_runtime_error_tests`<br>`kungfu_durability_contract_tests` | `src/libkungfu/include/kungfu/runtime/common.h`<br>`src/libkungfu/include/kungfu/runtime/storage/service.h` |
| `runtime-ledger-services` | `application-services` | `core/runtime-ledger` | 10 | `kungfu_ledger_services`<br>`kungfu` | `kungfu_durable_ingest_tests`<br>`kungfu_crash_recovery_tests` | `src/libkungfu/src/runtime/durable_ingest.cpp`<br>`src/libkungfu/src/runtime/facts/fact_admission.cpp` |
| `runtime-state-query-services` | `application-services` | `core/runtime-state-query` | 7 | `kungfu_state_query_services`<br>`kungfu_state_cache_services`<br>`kungfu` | `kungfu_state_service_contract_tests`<br>`kungfu_bounded_sql_parser_tests` | `src/libkungfu/src/runtime/state_service.cpp`<br>`src/libkungfu/src/runtime/query/fact_query.cpp` |
| `runtime-live-services` | `application-services` | `core/runtime-live` | 6 | `kungfu_live_services`<br>`kungfu` | `kungfu_peer_continuity_tests` | `src/libkungfu/src/runtime/live/reactor.cpp`<br>`src/libkungfu/src/runtime/live/coordinator.cpp` |
| `runtime-storage-services` | `application-services` | `core/runtime-storage` | 29 | `kungfu_storage_services`<br>`kungfu` | `kungfu_durability_contract_tests`<br>`kungfu_fact_authority_contract_tests`<br>`kungfu_offhost_backup_fixture` | `src/libkungfu/src/runtime/storage/service.cpp`<br>`src/libkungfu/src/runtime/storage/maintenance_service.cpp` |
| `runtime-extension-services` | `application-services` | `core/runtime-extension` | 13 | `kungfu_extension_services`<br>`kungfu` | `kungfu_native_kfx_contract_tests`<br>`kungfu_profile_lifecycle_tests`<br>`kungfu_action_geometry_tests`<br>`kungfu_domain_profile_tests`<br>`kungfu_profile_action_tests`<br>`kungfu_action_runtime_tests` | `src/libkungfu/src/runtime/kfx/native_registry.cpp`<br>`src/libkungfu/src/runtime/trust/assessment_runtime.cpp` |
| `runtime-storage-adapters` | `adapters` | `core/runtime-storage-adapters` | 7 | `kungfu_storage_adapters`<br>`kungfu` | `kungfu_durability_contract_tests` | `src/libkungfu/src/runtime/storage/provider.cpp` |
| `runtime-platform-adapters` | `adapters` | `core/runtime-platform-adapters` | 10 | `kungfu_view_adapters`<br>`kungfu_platform_adapters`<br>`kungfu` | `kungfu_view_component_link_tests` | `src/libkungfu/src/view/schema.cpp`<br>`src/libkungfu/src/runtime/io/io.cpp` |
| `core-composition-bindings` | `composition-bindings` | `core/bindings` | 48 | `kungfu_abi_exports`<br>`kungfu_composition`<br>`kungfu`<br>`kungfu_abi`<br>`kungfu-kfd-agent-runtime`<br>`kungfu_wasm_host`<br>`kungfu_node`<br>`kungfu_electron`<br>`drone`<br>`kungfu_kfc`<br>`kungfu_node_host`<br>`pykungfu` | `kungfu_projection_bootstrap_tests`<br>`kungfu_api_contract_tests` | `src/bindings/node/binding/kungfu_node.cpp`<br>`src/bindings/python/binding/pykungfu.cpp`<br>`src/kfd-agent-runtime/main.cpp`<br>`src/libkungfu/src/runtime/api.cpp` |
| `core-native-qualification` | `qualification` | `core/qualification` | 87 | `yijinjing_mmap_tests`<br>`yijinjing_content_hash_tests`<br>`yijinjing_advisory_file_lock_tests`<br>`yijinjing_fact_ledger_tests`<br>`yijinjing_custom_provider_qualification`<br>`yijinjing_mmap_qualification`<br>`yijinjing_journal_stress`<br>`kungfu_view_component_link_tests`<br>`kungfu_durability_contract_tests`<br>`kungfu_runtime_error_tests`<br>`kungfu_api_contract_tests`<br>`kungfu_peer_continuity_tests`<br>`kungfu_state_service_contract_tests`<br>`kungfu_fact_authority_contract_tests`<br>`kungfu_durable_ingest_tests`<br>`kungfu_durability_powercut_fixture`<br>`kungfu_durability_slo_fixture`<br>`kungfu_offhost_backup_fixture`<br>`kungfu_projection_bootstrap_tests`<br>`kungfu_crash_recovery_tests`<br>`kungfu_profile_lifecycle_tests`<br>`kungfu_bounded_sql_parser_tests`<br>`kungfu_native_kfx_contract_tests`<br>`kungfu_public_headers_stable_versioned_c_abi`<br>`kungfu_public_headers_libkungfu_cxx_source_surface`<br>`kungfu_public_headers_libyijinjing_source_embedding_surface`<br>`kungfu_action_geometry_tests`<br>`kungfu_domain_profile_tests`<br>`kungfu_profile_action_tests`<br>`kungfu_action_runtime_tests` | `kungfu_view_component_link_tests`<br>`kungfu_durability_contract_tests`<br>`kungfu_fact_authority_contract_tests`<br>`yijinjing_mmap_tests`<br>`kungfu_bounded_sql_parser_tests`<br>`kungfu_native_kfx_contract_tests`<br>`kungfu_api_contract_tests` | `src/libkungfu/tests/domain_component_link_tests.cpp`<br>`src/libkungfu/tests/durability_contract_tests.cpp`<br>`src/libyijinjing/tests/mmap_tests.cpp` |

## Internal target graph

The public `kungfu` target remains the compatibility facade. These internal
targets express compile ownership and are generated into `TARGETS.cmake`
from the same authority as this map.

| Target | Kind | Component | Depends on | Sources |
| --- | --- | --- | --- | ---: |
| `kungfu_contracts` | `INTERFACE` | `libkungfu-contracts` | — | 0 |
| `kungfu_ledger_services` | `OBJECT` | `runtime-ledger-services` | `kungfu_contracts` | 10 |
| `kungfu_state_query_services` | `OBJECT` | `runtime-state-query-services` | `kungfu_contracts` | 4 |
| `kungfu_state_cache_services` | `OBJECT` | `runtime-state-query-services` | `kungfu_contracts` | 3 |
| `kungfu_live_services` | `OBJECT` | `runtime-live-services` | `kungfu_contracts` | 6 |
| `kungfu_storage_services` | `OBJECT` | `runtime-storage-services` | `kungfu_contracts` | 24 |
| `kungfu_extension_services` | `OBJECT` | `runtime-extension-services` | `kungfu_contracts` | 12 |
| `kungfu_storage_adapters` | `OBJECT` | `runtime-storage-adapters` | `kungfu_storage_services`<br>`kungfu_contracts` | 6 |
| `kungfu_view_adapters` | `OBJECT` | `runtime-platform-adapters` | `kungfu_contracts` | 2 |
| `kungfu_platform_adapters` | `OBJECT` | `runtime-platform-adapters` | `kungfu_contracts` | 7 |
| `kungfu_abi_exports` | `OBJECT` | `core-composition-bindings` | `kungfu_contracts` | 1 |
| `kungfu_composition` | `OBJECT` | `core-composition-bindings` | `kungfu_ledger_services`<br>`kungfu_state_query_services`<br>`kungfu_state_cache_services`<br>`kungfu_live_services`<br>`kungfu_storage_services`<br>`kungfu_extension_services`<br>`kungfu_storage_adapters`<br>`kungfu_view_adapters`<br>`kungfu_platform_adapters` | 3 |

## Responsibility seams

These checked source budgets keep storage responsibilities from collapsing
back into the compatibility facade.

| Responsibility | Source | Line budget |
| --- | --- | ---: |
| Public storage facade and shared application-service composition | `src/libkungfu/src/runtime/storage/service.cpp` | 3020 |
| Native Episode write retry and stale-writer recovery orchestration | `src/libkungfu/src/runtime/storage/episode_control.cpp` | 420 |
| Episode repair planning, evidence fetch, bundle validation and non-destructive apply | `src/libkungfu/src/runtime/storage/episode_repair.cpp` | 1500 |
| Typed journal queries and stable storage query result rendering | `src/libkungfu/src/runtime/storage/query_render.cpp` | 500 |
| JSON compatibility decoding, validation and typed option parsing | `src/libkungfu/src/runtime/storage/json_compat.cpp` | 500 |
| Provider registry and RocksDB content adapter behind the storage port | `src/libkungfu/src/runtime/storage/provider.cpp` | 800 |
| Filesystem content adapter behind the storage port | `src/libkungfu/src/runtime/storage/provider_file.cpp` | 160 |
| Status, fsck, projection rebuild, GC and compaction planning | `src/libkungfu/src/runtime/storage/maintenance_service.cpp` | 500 |
| Manifest bundle import, export and sync verification | `src/libkungfu/src/runtime/storage/transfer_service.cpp` | 520 |
| JSON edge and domain operation dispatch composition | `src/libkungfu/src/runtime/storage/domain_dispatch.cpp` | 1000 |

## Public contracts

The rows below are expanded and checked from the same authority. Stable
means versioned compatibility; experimental C++ does not freeze STL or
toolchain ABI; source-embedding-only does not promise a shared library.

| Rule | Level | Minimum profile | Headers | Consumers |
| --- | --- | --- | ---: | --- |
| `stable-versioned-c-abi` | `stable` | `embedded-sqlite` | 2 | native C/C++ embedders<br>Node/Electron hosts<br>Python hosts |
| `libkungfu-cxx-source-surface` | `experimental` | `embedded-sqlite` | 65 | libkungfu<br>in-repository C++ bindings and applications |
| `libyijinjing-source-embedding-surface` | `source-embedding-only` | `journal` | 31 | yijinjing static target embedders<br>libkungfu |

### Stable link-visible symbols

| Symbol | Owner | ABI versions | Minimum profile |
| --- | --- | --- | --- |
| `kungfu_get_api` | `core-composition-bindings` | v1 | `embedded-sqlite` |

### Schema, layout and binding parity

| Contract | Level | Owner / shared semantic authority | Minimum profile |
| --- | --- | --- | --- |
| `journal-wire-v1` | `stable` | `yijinjing-kernel` | `journal` |
| `libkungfu-event-schemas` | `experimental` | `libkungfu-contracts` | `embedded-sqlite` |
| binding:`node` | `experimental` | `libkungfu-in-process-contracts` | `full` |
| binding:`python` | `experimental` | `libkungfu-in-process-contracts` | `full` |
| binding:`electron` | `experimental` | `libkungfu-in-process-contracts` | `full` |
| binding:`wasm` | `experimental` | `libkungfu-in-process-contracts` | `full` |

### Deprecation authority

Core contributes governed surfaces to the repository-wide lifecycle
authority; this architecture contract does not own a second ledger.

| Contract | Registry | Contributed entries |
| --- | --- | --- |
| `../deprecation/deprecation-lifecycle.contract.json` | `../deprecation/deprecation-registry.json` | `core.yijinjing.boolean-mmap-adapters` |

## Navigation

| Question | Start here |
| --- | --- |
| Journal write, mmap publication or replay kernel | `yijinjing-kernel` → `src/libyijinjing/include/kungfu/yijinjing/journal/journal.h` |
| Durability, ingest or crash-recovery policy | `runtime-ledger-services` → `src/libkungfu/src/runtime/durability.cpp` |
| State service, cache or query behavior | `runtime-state-query-services` → `src/libkungfu/src/runtime/state_service.cpp` |
| Live peer coordination and continuity | `runtime-live-services` → `src/libkungfu/src/runtime/live/coordinator.cpp` |
| KFX, profile lifecycle or trust assessment | `runtime-extension-services` → `src/libkungfu/src/runtime/kfx/native_registry.cpp` |
| Storage facade or shared application helpers | `runtime-storage-services` → `src/libkungfu/src/runtime/storage/service.cpp` |
| Storage status, fsck, rebuild, GC or compact planning | `runtime-storage-services` → `src/libkungfu/src/runtime/storage/maintenance_service.cpp` |
| Storage bundle import, export or sync verification | `runtime-storage-services` → `src/libkungfu/src/runtime/storage/transfer_service.cpp` |
| Storage provider registry or RocksDB adapter integration | `runtime-storage-adapters` → `src/libkungfu/src/runtime/storage/provider.cpp` |
| Filesystem storage provider integration | `runtime-storage-adapters` → `src/libkungfu/src/runtime/storage/provider_file.cpp` |
| Storage JSON edge or domain operation dispatch | `core-composition-bindings` → `src/libkungfu/src/runtime/storage/domain_dispatch.cpp` |
| General RocksDB or SQLite integration | `runtime-storage-adapters` → `src/libkungfu/src/runtime/util/rocks.cpp` |
| FlatBuffers projection boundary | `runtime-platform-adapters` → `src/libkungfu/src/view/schema.cpp` |
| Transport, process or OS integration | `runtime-platform-adapters` → `src/libkungfu/src/runtime/io/io.cpp` |
| Python, Node, C embedding or WASM entry | `core-composition-bindings` → `src/libkungfu/src/runtime/api.cpp` |
| Native regression or qualification fixture | `core-native-qualification` → `src/libkungfu/tests/durability_contract_tests.cpp` |

## Gate

```sh
./shifu check:source
```

The source gate fails when a tracked C/C++ file has zero or multiple owners,
when a current target loses its CMake evidence, when a resolved internal
include is undeclared, when a declared dependency or resolved include reverses
the layer contract, when an internal source has zero or multiple build targets,
when a target edge reverses the layer contract, when a forbidden include enters
a protected layer, when a checked responsibility token or source-size budget
drifts, or when the map or generated CMake projection drifts.
