# Generated from architecture/layers.json by check-layers.mjs.
# Do not edit this projection directly.

add_library(kungfu_contracts INTERFACE)
target_include_directories(kungfu_contracts INTERFACE ${PROJECT_SOURCE_DIR}/include ${KUNGFU_GENERATED_INCLUDE_DIR})
target_include_directories(kungfu_contracts SYSTEM INTERFACE ${LIBKUNGFU_SQLITE_ORM_INCLUDE})
target_link_libraries(kungfu_contracts INTERFACE yijinjing kungfu_compile_contract ${CONAN_LIBS})

set(KUNGFU_SERVICES_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/action_recorder.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/crash_recovery.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/durability.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/durable_ingest.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/facts/fact_admission.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/journal/replay_writer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/journal/tracer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/kfx/native_contract.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/kfx/native_registry.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/continuity.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/coordinator.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/peer.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/reactor.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/live/resource_manager.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/profile/profile_lifecycle.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/query/fact_query.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/query/saved_query_catalog.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/schema/schema_compiler.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_shadow.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/episode_manifest_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/manifest_catalog_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/service.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/storage/source_registry_projection.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/trust/assessment_runtime.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/typed_frame_dump.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/typed_state_projection.cpp"
)
add_library_object(kungfu_services "${KUNGFU_SERVICES_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_services PUBLIC kungfu_contracts)

set(KUNGFU_SERVICES_STATE_CACHE_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/manager.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/profile.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/state_cache/store.cpp"
)
add_library_object(kungfu_services_state_cache "${KUNGFU_SERVICES_STATE_CACHE_SOURCE_FILES}" "${COMPILER_OPTIMIZE_OFF_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_services_state_cache PUBLIC kungfu_contracts)

set(KUNGFU_ADAPTERS_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/io/io.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/io/sqlite.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/native_storage.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/sandbox/app_container.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/StackWalker.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/nanomsg.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/rocks.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/signal.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/stacktrace.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/util/terminal.cpp"
  "${PROJECT_SOURCE_DIR}/src/view/action_envelope.cpp"
  "${PROJECT_SOURCE_DIR}/src/view/schema.cpp"
)
add_library_object(kungfu_adapters "${KUNGFU_ADAPTERS_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_adapters PUBLIC kungfu_services kungfu_services_state_cache)

set(KUNGFU_COMPOSITION_SOURCE_FILES
  "${PROJECT_SOURCE_DIR}/src/runtime/embedding.cpp"
  "${PROJECT_SOURCE_DIR}/src/runtime/projection_bootstrap.cpp"
)
add_library_object(kungfu_composition "${KUNGFU_COMPOSITION_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")
target_link_libraries(kungfu_composition PUBLIC kungfu_adapters)

set(KUNGFU_INTERNAL_OBJECTS
  $<TARGET_OBJECTS:kungfu_services>
  $<TARGET_OBJECTS:kungfu_services_state_cache>
  $<TARGET_OBJECTS:kungfu_adapters>
  $<TARGET_OBJECTS:kungfu_composition>
)
