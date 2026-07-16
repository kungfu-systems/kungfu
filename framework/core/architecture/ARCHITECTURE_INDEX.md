---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: ongoing
theme: kungfu-core-architecture-query
doc_type: generated-architecture-index
sources: [local-files]
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-15
---

# Core Architecture Query Index

Generated from `layers.json` and `build-capabilities.json`. Do not edit by hand. The projection contains only checked-in authority facts and does not identify unrecorded human maintainers.

| Component | Owner | Backup reviewer | Entry points | Targets | Profiles | Tests | Diagnostics |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `yijinjing-schema` | `core/schema` | `core/architecture` | `src/libyijinjing/include/kungfu/yijinjing/schema/core.h` | `yijinjing` | `embedded-minimal`<br>`embedded-sqlite`<br>`full`<br>`journal`<br>`server` | `yijinjing_content_hash_tests` | — |
| `yijinjing-kernel` | `core/yijinjing` | `core/architecture` | `src/libyijinjing/include/kungfu/yijinjing/journal/journal.h`<br>`src/libyijinjing/include/kungfu/yijinjing/storage.h` | `yijinjing` | `embedded-minimal`<br>`embedded-sqlite`<br>`full`<br>`journal`<br>`server` | `yijinjing_mmap_tests`<br>`yijinjing_custom_provider_qualification` | `journal-layout-mismatch` |
| `libkungfu-contracts` | `core/runtime-contracts` | `core/architecture` | `src/libkungfu/include/kungfu/runtime/common.h`<br>`src/libkungfu/include/kungfu/runtime/storage/service.h` | `yijinjing`<br>`kungfu_contracts`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_runtime_error_tests`<br>`kungfu_durability_contract_tests` | — |
| `runtime-ledger-services` | `core/runtime-ledger` | `core/architecture` | `src/libkungfu/src/runtime/durable_ingest.cpp`<br>`src/libkungfu/src/runtime/facts/fact_admission.cpp` | `kungfu_ledger_services`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_durable_ingest_tests`<br>`kungfu_crash_recovery_tests` | — |
| `runtime-state-query-services` | `core/runtime-state-query` | `core/architecture` | `src/libkungfu/src/runtime/state_service.cpp`<br>`src/libkungfu/src/runtime/query/fact_query.cpp` | `kungfu_state_query_services`<br>`kungfu_state_cache_services`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_state_service_contract_tests` | `storage-query-or-state-failure` |
| `runtime-live-services` | `core/runtime-live` | `core/architecture` | `src/libkungfu/src/runtime/live/reactor.cpp`<br>`src/libkungfu/src/runtime/live/coordinator.cpp` | `kungfu_live_services`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_peer_continuity_tests` | `live-continuity-failure` |
| `runtime-storage-services` | `core/runtime-storage` | `core/architecture` | `src/libkungfu/src/runtime/storage/service.cpp`<br>`src/libkungfu/src/runtime/storage/maintenance_service.cpp` | `kungfu_storage_services`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_durability_contract_tests`<br>`kungfu_offhost_backup_fixture` | — |
| `runtime-extension-services` | `core/runtime-extension` | `core/architecture` | `src/libkungfu/src/runtime/kfx/native_registry.cpp`<br>`src/libkungfu/src/runtime/trust/assessment_runtime.cpp` | `kungfu_extension_services`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_native_kfx_contract_tests`<br>`kungfu_profile_lifecycle_tests` | — |
| `runtime-storage-adapters` | `core/runtime-storage-adapters` | `core/architecture` | `src/libkungfu/src/runtime/storage/provider.cpp`<br>`src/libkungfu/src/runtime/native_storage.cpp` | `kungfu_storage_adapters`<br>`kungfu`<br>`kungfu_native_storage_shared` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_durability_contract_tests` | `storage-provider-failure` |
| `runtime-platform-adapters` | `core/runtime-platform-adapters` | `core/architecture` | `src/libkungfu/src/view/schema.cpp`<br>`src/libkungfu/src/runtime/io/io.cpp` | `kungfu_view_adapters`<br>`kungfu_platform_adapters`<br>`kungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_view_component_link_tests`<br>`kungfu_embedding_generic_codec_tests` | — |
| `core-composition-bindings` | `core/bindings` | `core/architecture` | `src/bindings/node/binding/kungfu_node.cpp`<br>`src/bindings/python/binding/pykungfu.cpp`<br>`src/libkungfu/src/runtime/embedding.cpp` | `kungfu_composition`<br>`kungfu`<br>`kungfu_embedding`<br>`kungfu_wasm_host`<br>`kungfu_node`<br>`kungfu_electron`<br>`drone`<br>`kungfu_kfc`<br>`kungfu_node_host`<br>`pykungfu` | `embedded-sqlite`<br>`full`<br>`server` | `kungfu_projection_bootstrap_tests`<br>`kungfu_embedding_generic_codec_tests` | `embedding-negotiation-failure` |
| `core-native-qualification` | `core/qualification` | `core/architecture` | `src/libkungfu/tests/domain_component_link_tests.cpp`<br>`src/libkungfu/tests/durability_contract_tests.cpp`<br>`src/libyijinjing/tests/mmap_tests.cpp` | `yijinjing_mmap_tests`<br>`yijinjing_content_hash_tests`<br>`yijinjing_custom_provider_qualification`<br>`yijinjing_mmap_qualification`<br>`yijinjing_journal_stress`<br>`kungfu_view_component_link_tests`<br>`kungfu_durability_contract_tests`<br>`kungfu_runtime_error_tests`<br>`kungfu_embedding_generic_codec_tests`<br>`kungfu_peer_continuity_tests`<br>`kungfu_state_service_contract_tests`<br>`kungfu_durable_ingest_tests`<br>`kungfu_durability_powercut_fixture`<br>`kungfu_durability_slo_fixture`<br>`kungfu_offhost_backup_fixture`<br>`kungfu_projection_bootstrap_tests`<br>`kungfu_crash_recovery_tests`<br>`kungfu_profile_lifecycle_tests`<br>`kungfu_bounded_sql_parser_tests`<br>`kungfu_native_kfx_contract_tests`<br>`kungfu_public_headers_stable_versioned_c_abi`<br>`kungfu_public_headers_libkungfu_cxx_source_surface`<br>`kungfu_public_headers_libyijinjing_source_embedding_surface`<br>`kungfu_public_contract_compatibility_tests` | — | `kungfu_view_component_link_tests`<br>`kungfu_durability_contract_tests`<br>`yijinjing_mmap_tests`<br>`kungfu_native_kfx_contract_tests`<br>`kungfu_public_contract_compatibility_tests` | `native-qualification-failure` |

## Query

`./shifu core:architecture --path framework/core/src/libkungfu/src/runtime/storage/service.cpp`

Use one of `--path`, `--component`, `--target`, `--symbol`, `--error`, `--capability`, or `--profile`; append `--json` for the stable machine surface.
