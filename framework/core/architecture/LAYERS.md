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

Current targets describe the build as it exists today. Repeated aggregate
targets expose the boundaries that the next remediation stage must split;
they are not a claim that the component already has a dedicated target.

| Component | Layer | Owner | Files | Current targets | Entry points |
| --- | --- | --- | ---: | --- | --- |
| `yijinjing-schema` | `schema-values` | `core/schema` | 5 | `yijinjing` | `src/libyijinjing/include/kungfu/yijinjing/schema/core.h` |
| `yijinjing-kernel` | `journal-kernel` | `core/yijinjing` | 42 | `yijinjing` | `src/libyijinjing/include/kungfu/yijinjing/journal/journal.h`<br>`src/libyijinjing/include/kungfu/yijinjing/storage.h` |
| `libkungfu-contracts` | `ports-contracts` | `core/runtime-contracts` | 54 | `yijinjing`<br>`kungfu` | `src/libkungfu/include/kungfu/runtime/common.h`<br>`src/libkungfu/include/kungfu/runtime/storage/service.h` |
| `libkungfu-services` | `application-services` | `core/runtime-services` | 29 | `kungfu_state_cache`<br>`kungfu_optim`<br>`kungfu` | `src/libkungfu/src/runtime/storage/service.cpp`<br>`src/libkungfu/src/runtime/state_service.cpp`<br>`src/libkungfu/src/runtime/query/fact_query.cpp` |
| `libkungfu-adapters` | `adapters` | `core/runtime-adapters` | 13 | `kungfu_optim`<br>`kungfu`<br>`kungfu_native_storage_shared` | `src/libkungfu/src/view/schema.cpp`<br>`src/libkungfu/src/runtime/native_storage.cpp`<br>`src/libkungfu/src/runtime/util/rocks.cpp` |
| `core-composition-bindings` | `composition-bindings` | `core/bindings` | 42 | `kungfu`<br>`kungfu_embedding`<br>`kungfu_wasm_host`<br>`kungfu_node`<br>`kungfu_electron`<br>`drone`<br>`kungfu_kfc`<br>`kungfu_node_host`<br>`pykungfu` | `src/bindings/node/binding/kungfu_node.cpp`<br>`src/bindings/python/binding/pykungfu.cpp`<br>`src/libkungfu/src/runtime/embedding.cpp` |
| `core-native-qualification` | `qualification` | `core/qualification` | 16 | `yijinjing_mmap_tests`<br>`yijinjing_content_hash_tests`<br>`yijinjing_mmap_qualification`<br>`kungfu_durability_contract_tests`<br>`kungfu_runtime_error_tests`<br>`kungfu_embedding_generic_codec_tests`<br>`kungfu_peer_continuity_tests`<br>`kungfu_state_service_contract_tests`<br>`kungfu_durable_ingest_tests`<br>`kungfu_durability_powercut_fixture`<br>`kungfu_durability_slo_fixture`<br>`kungfu_offhost_backup_fixture`<br>`kungfu_projection_bootstrap_tests`<br>`kungfu_crash_recovery_tests`<br>`kungfu_profile_lifecycle_tests` | `src/libkungfu/tests/durability_contract_tests.cpp`<br>`src/libyijinjing/tests/mmap_tests.cpp` |

## Navigation

| Question | Start here |
| --- | --- |
| Journal write, mmap publication or replay kernel | `yijinjing-kernel` → `src/libyijinjing/include/kungfu/yijinjing/journal/journal.h` |
| Durability and crash-recovery policy | `libkungfu-services` → `src/libkungfu/src/runtime/durability.cpp` |
| State service and projections | `libkungfu-services` → `src/libkungfu/src/runtime/state_service.cpp` |
| Runtime fact and saved-query behavior | `libkungfu-services` → `src/libkungfu/src/runtime/query/fact_query.cpp` |
| Trust assessment or live coordination | `libkungfu-services` → `src/libkungfu/src/runtime/trust/assessment_runtime.cpp` |
| Storage service composition | `libkungfu-services` → `src/libkungfu/src/runtime/storage/service.cpp` |
| RocksDB or SQLite integration | `libkungfu-adapters` → `src/libkungfu/src/runtime/util/rocks.cpp` |
| FlatBuffers projection boundary | `libkungfu-adapters` → `src/libkungfu/src/view/schema.cpp` |
| Transport, process or OS integration | `libkungfu-adapters` → `src/libkungfu/src/runtime/io/io.cpp` |
| Python, Node, C embedding or WASM entry | `core-composition-bindings` → `src/libkungfu/src/runtime/embedding.cpp` |
| Native regression or qualification fixture | `core-native-qualification` → `src/libkungfu/tests/durability_contract_tests.cpp` |

## Gate

```sh
./shifu check:source
```

The source gate fails when a tracked C/C++ file has zero or multiple owners,
when a current target loses its CMake evidence, when a resolved internal
include is undeclared, when a declared dependency or resolved include reverses
the layer contract, when a forbidden include enters a protected layer, or
when this map drifts.
