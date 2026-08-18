# Generated from architecture/layers.json by check-layers.mjs.
# Do not edit this projection directly.

add_library(kungfu_contracts INTERFACE)
target_include_directories(kungfu_contracts INTERFACE ${PROJECT_SOURCE_DIR}/include ${KUNGFU_GENERATED_INCLUDE_DIR})
target_include_directories(kungfu_contracts SYSTEM INTERFACE ${LIBKUNGFU_SQLITE_ORM_INCLUDE})
target_link_libraries(kungfu_contracts INTERFACE yijinjing kungfu_compile_contract ${KUNGFU_TARGET_KUNGFU_CONTRACTS_DEPENDENCIES})

set(KUNGFU_LEDGER_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/action_recorder.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/crash_recovery.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/durability.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/durable_ingest.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/facts/fact_admission.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/journal/replay_writer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/journal/tracer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/schema/schema_compiler.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/typed_frame_dump.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/typed_state_projection.cpp"
)
add_library_object(kungfu_ledger_services "${KUNGFU_LEDGER_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_ledger_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_ledger_services PUBLIC ${KUNGFU_TARGET_KUNGFU_LEDGER_SERVICES_DEPENDENCIES})

set(KUNGFU_STATE_QUERY_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/query/fact_query.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/query/saved_query_catalog.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_shadow.cpp"
)
add_library_object(kungfu_state_query_services "${KUNGFU_STATE_QUERY_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_state_query_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_state_query_services PUBLIC ${KUNGFU_TARGET_KUNGFU_STATE_QUERY_SERVICES_DEPENDENCIES})

set(KUNGFU_STATE_CACHE_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/manager.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/profile.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/store.cpp"
)
add_library_object(kungfu_state_cache_services "${KUNGFU_STATE_CACHE_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_OFF_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_state_cache_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_state_cache_services PUBLIC ${KUNGFU_TARGET_KUNGFU_STATE_CACHE_SERVICES_DEPENDENCIES})

set(KUNGFU_LIVE_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/live/continuity.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/coordinator.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/peer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/reactor.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/resource_manager.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/route.cpp"
)
add_library_object(kungfu_live_services "${KUNGFU_LIVE_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_live_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_live_services PUBLIC ${KUNGFU_TARGET_KUNGFU_LIVE_SERVICES_DEPENDENCIES})

set(KUNGFU_STORAGE_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/backend_switch.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/episode_admission.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/episode_control.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/episode_manifest_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/episode_repair.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_actions.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_authority.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_commit.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_domain.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_durable_admission.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_kernel.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_portability.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_protocol.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_query.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/fact_state.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/json_compat.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/layout.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/maintenance_service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/manifest_catalog_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/query_render.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/service_operation_catalog.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/source_registry_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/transfer_service.cpp"
)
add_library_object(kungfu_storage_services "${KUNGFU_STORAGE_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_storage_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_storage_services PUBLIC ${KUNGFU_TARGET_KUNGFU_STORAGE_SERVICES_DEPENDENCIES})

set(KUNGFU_EXTENSION_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/action/action_canonical_json.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/action/action_contract_registry.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/action/action_geometry.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/action/action_runtime.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/action/domain_profile.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/action/profile_action.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/kfx/native_authority.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/kfx/native_contract.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/kfx/native_registry.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/profile/initiative_assignment_service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/profile/profile_lifecycle.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/trust/assessment_runtime.cpp"
)
add_library_object(kungfu_extension_services "${KUNGFU_EXTENSION_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_extension_services PUBLIC kungfu_contracts)
target_link_libraries(kungfu_extension_services PUBLIC ${KUNGFU_TARGET_KUNGFU_EXTENSION_SERVICES_DEPENDENCIES})

set(KUNGFU_STORAGE_ADAPTERS_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/io/sqlite.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/provider.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/provider_file.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/key_value_factory.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/key_value_rocksdb.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/rocks.cpp"
)
if(NOT "rocksdb" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  list(REMOVE_ITEM KUNGFU_STORAGE_ADAPTERS_SOURCE_FILES
    "${PROJECT_SOURCE_DIR}/src/runtime/util/key_value_rocksdb.cpp"
    "${PROJECT_SOURCE_DIR}/src/runtime/util/rocks.cpp"
  )
endif()
add_library_object(kungfu_storage_adapters "${KUNGFU_STORAGE_ADAPTERS_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_storage_adapters PUBLIC kungfu_storage_services kungfu_contracts)
target_link_libraries(kungfu_storage_adapters PUBLIC ${KUNGFU_TARGET_KUNGFU_STORAGE_ADAPTERS_DEPENDENCIES})

set(KUNGFU_VIEW_ADAPTERS_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/view/action_envelope.cpp"
  "${PROJECT_SOURCE_DIR}/src/view/schema.cpp"
)
add_library_object(kungfu_view_adapters "${KUNGFU_VIEW_ADAPTERS_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_view_adapters PUBLIC kungfu_contracts)
target_link_libraries(kungfu_view_adapters PUBLIC ${KUNGFU_TARGET_KUNGFU_VIEW_ADAPTERS_DEPENDENCIES})

set(KUNGFU_PLATFORM_ADAPTERS_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/io/io.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/sandbox/app_container.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/StackWalker.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/nanomsg.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/signal.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/stacktrace.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/terminal.cpp"
)
add_library_object(kungfu_platform_adapters "${KUNGFU_PLATFORM_ADAPTERS_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_platform_adapters PUBLIC kungfu_contracts)
target_link_libraries(kungfu_platform_adapters PUBLIC ${KUNGFU_TARGET_KUNGFU_PLATFORM_ADAPTERS_DEPENDENCIES})

set(KUNGFU_ABI_EXPORTS_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/abi_exports.cpp"
)
add_library_object(kungfu_abi_exports "${KUNGFU_ABI_EXPORTS_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_abi_exports PUBLIC kungfu_contracts)
target_link_libraries(kungfu_abi_exports PUBLIC ${KUNGFU_TARGET_KUNGFU_ABI_EXPORTS_DEPENDENCIES})

set(KUNGFU_COMPOSITION_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/api.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/projection_bootstrap.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/domain_dispatch.cpp"
)
add_library_object(kungfu_composition "${KUNGFU_COMPOSITION_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_composition PUBLIC kungfu_ledger_services kungfu_state_query_services kungfu_state_cache_services kungfu_live_services kungfu_storage_services kungfu_extension_services kungfu_storage_adapters kungfu_view_adapters kungfu_platform_adapters)
target_link_libraries(kungfu_composition PUBLIC ${KUNGFU_TARGET_KUNGFU_COMPOSITION_DEPENDENCIES})

set(KUNGFU_INTERNAL_OBJECTS
  $<TARGET_OBJECTS:kungfu_ledger_services>
  $<TARGET_OBJECTS:kungfu_state_query_services>
  $<TARGET_OBJECTS:kungfu_state_cache_services>
  $<TARGET_OBJECTS:kungfu_live_services>
  $<TARGET_OBJECTS:kungfu_storage_services>
  $<TARGET_OBJECTS:kungfu_extension_services>
  $<TARGET_OBJECTS:kungfu_storage_adapters>
  $<TARGET_OBJECTS:kungfu_view_adapters>
  $<TARGET_OBJECTS:kungfu_platform_adapters>
  $<TARGET_OBJECTS:kungfu_abi_exports>
  $<TARGET_OBJECTS:kungfu_composition>
)
