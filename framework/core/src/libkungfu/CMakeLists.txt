project(${LIBKUNGFU_NAME})

enable_windows_export_all_symbols()

# ADR-0051 domain-fact events keep the checked-in .fbs as the single schema
# owner. The generated header only embeds that source text so libkungfu can
# compile/verify it through kungfu::view without shipping a duplicate schema.
file(READ "${PROJECT_SOURCE_DIR}/schemas/domain_fact_event.fbs" DOMAIN_FACT_EVENT_FBS)
set(KUNGFU_GENERATED_INCLUDE_DIR "${KUNGFU_BUILD_DIR}/generated/include")
file(MAKE_DIRECTORY "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/facts")
configure_file(
  "${PROJECT_SOURCE_DIR}/schemas/domain_fact_schema.h.in"
  "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/facts/domain_fact_schema.h"
  @ONLY
)

# Embed the exact KFX contract document as the sole Profile JSON schema owner.
# Core validates its profileSuiteSchema before applying lifecycle semantics.
file(READ "${PROJECT_SOURCE_DIR}/../../../kfx/kungfu-kfx.contract.json" KFX_CONTRACT_JSON)
# MSVC limits one string literal to 65,535 bytes. Preserve the exact contract
# bytes while emitting bounded adjacent raw literals that C++ concatenates.
set(KFX_CONTRACT_JSON_LITERALS "")
string(LENGTH "${KFX_CONTRACT_JSON}" KFX_CONTRACT_JSON_LENGTH)
set(KFX_CONTRACT_JSON_OFFSET 0)
while(KFX_CONTRACT_JSON_OFFSET LESS KFX_CONTRACT_JSON_LENGTH)
  math(EXPR KFX_CONTRACT_JSON_REMAINING "${KFX_CONTRACT_JSON_LENGTH} - ${KFX_CONTRACT_JSON_OFFSET}")
  if(KFX_CONTRACT_JSON_REMAINING GREATER 16000)
    set(KFX_CONTRACT_JSON_CHUNK_LENGTH 16000)
  else()
    set(KFX_CONTRACT_JSON_CHUNK_LENGTH ${KFX_CONTRACT_JSON_REMAINING})
  endif()
  string(SUBSTRING "${KFX_CONTRACT_JSON}" ${KFX_CONTRACT_JSON_OFFSET} ${KFX_CONTRACT_JSON_CHUNK_LENGTH}
         KFX_CONTRACT_JSON_CHUNK)
  string(APPEND KFX_CONTRACT_JSON_LITERALS "R\"KFKFX(${KFX_CONTRACT_JSON_CHUNK})KFKFX\"\n")
  math(EXPR KFX_CONTRACT_JSON_OFFSET "${KFX_CONTRACT_JSON_OFFSET} + ${KFX_CONTRACT_JSON_CHUNK_LENGTH}")
endwhile()
file(MAKE_DIRECTORY "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/profile")
configure_file(
  "${PROJECT_SOURCE_DIR}/schemas/profile_source_contract.h.in"
  "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/profile/profile_source_contract.h"
  @ONLY
)

# ADR-0052 assessment jobs use an independent FlatBuffers authority while
# sharing the ActionEnvelope and Episode substrates with ADR-0051.
file(READ "${PROJECT_SOURCE_DIR}/schemas/assessment_event.fbs" ASSESSMENT_EVENT_FBS)
file(MAKE_DIRECTORY "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/trust")
configure_file(
  "${PROJECT_SOURCE_DIR}/schemas/assessment_schema.h.in"
  "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/trust/assessment_schema.h"
  @ONLY
)

# Saved query catalog facts share the ActionEnvelope and Episode substrates but
# keep an independent FlatBuffers schema authority.
file(READ "${PROJECT_SOURCE_DIR}/schemas/saved_query_catalog_event.fbs" SAVED_QUERY_CATALOG_EVENT_FBS)
file(MAKE_DIRECTORY "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/query")
configure_file(
  "${PROJECT_SOURCE_DIR}/schemas/saved_query_catalog_schema.h.in"
  "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/query/saved_query_catalog_schema.h"
  @ONLY
)

# ADR-0069 Profile Suite lifecycle facts use the same ActionEnvelope/Episode
# substrate while retaining an independent typed event authority.
file(READ "${PROJECT_SOURCE_DIR}/schemas/profile_lifecycle_event.fbs" PROFILE_LIFECYCLE_EVENT_FBS)
configure_file(
  "${PROJECT_SOURCE_DIR}/schemas/profile_lifecycle_schema.h.in"
  "${KUNGFU_GENERATED_INCLUDE_DIR}/kungfu/runtime/profile/profile_lifecycle_schema.h"
  @ONLY
)

# The layer authority generates exact source ownership and the internal target
# graph. Source additions must update layers.json and its checked projections;
# an architecture-blind recursive GLOB must not silently absorb them.
set(LIBKUNGFU_SQLITE_ORM_INCLUDE ${PROJECT_SOURCE_DIR}/../../.deps/sqlite_orm-1.7.1/include)
include("${CMAKE_CURRENT_SOURCE_DIR}/../../architecture/TARGETS.cmake")

# Windows: 用 STATIC。libkungfu 含 rocksdb/boost::hana/sqlite_orm 大量模板实例化，作为 SHARED DLL 时
# CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS 自动导出的符号数 >65535，撞 COFF 库成员上限(LNK1189)。改 STATIC 由各
# binding 链接；journal 是 mmap 文件、跨实例本就共享，故 Windows 上多 binding 各自静态链接 libkungfu 仍读同一 journal。
# Mac/Linux 维持 SHARED(运行时多语言绑定在同进程共享同一 dylib/so)。
if (WIN32)
  add_library(${LIBKUNGFU_NAME} STATIC ${KUNGFU_INTERNAL_OBJECTS})
else ()
  add_library(${LIBKUNGFU_NAME} SHARED ${KUNGFU_INTERNAL_OBJECTS})
endif ()
set_target_properties(${LIBKUNGFU_NAME} PROPERTIES LINKER_LANGUAGE CXX)
set_target_properties(${LIBKUNGFU_NAME} PROPERTIES ARCHIVE_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR})
target_compile_options(${LIBKUNGFU_NAME} PRIVATE "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>")
# journal core comes from the yijinjing static library (built once in
# src/libyijinjing, its sources are no longer under this directory's GLOB);
# PUBLIC so bindings linking libkungfu inherit the core usage requirements.
# The runtime headers and sqlite_orm are PUBLIC for the same reason: binding
# sources include the state-cache/live headers directly.
target_include_directories(${LIBKUNGFU_NAME} PUBLIC ${PROJECT_SOURCE_DIR}/include ${KUNGFU_GENERATED_INCLUDE_DIR})
target_include_directories(${LIBKUNGFU_NAME} SYSTEM PUBLIC ${LIBKUNGFU_SQLITE_ORM_INCLUDE})
target_link_libraries(${LIBKUNGFU_NAME} PUBLIC yijinjing ${CONAN_LIBS} kungfu_compile_contract)
kungfu_strip_release_local_symbols(${LIBKUNGFU_NAME})

if(KUNGFU_WITH_CORE_TESTS)
  find_package(Threads REQUIRED)
  add_executable(kungfu_durability_contract_tests tests/durability_contract_tests.cpp)
  target_link_libraries(kungfu_durability_contract_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract)
  target_compile_features(kungfu_durability_contract_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_durability_contract_tests COMMAND kungfu_durability_contract_tests)

  add_executable(kungfu_runtime_error_tests tests/runtime_error_tests.cpp)
  target_link_libraries(kungfu_runtime_error_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_runtime_error_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_runtime_error_tests COMMAND kungfu_runtime_error_tests)

  add_executable(kungfu_embedding_generic_codec_tests tests/embedding_generic_codec_tests.cpp)
  target_link_libraries(kungfu_embedding_generic_codec_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract)
  target_compile_features(kungfu_embedding_generic_codec_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_embedding_generic_codec_tests COMMAND kungfu_embedding_generic_codec_tests)

  add_executable(kungfu_peer_continuity_tests tests/peer_continuity_tests.cpp)
  target_link_libraries(kungfu_peer_continuity_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_peer_continuity_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_peer_continuity_tests COMMAND kungfu_peer_continuity_tests)

  add_executable(kungfu_state_service_contract_tests tests/state_service_contract_tests.cpp)
  target_link_libraries(kungfu_state_service_contract_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_state_service_contract_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_state_service_contract_tests COMMAND kungfu_state_service_contract_tests)

  add_executable(kungfu_durable_ingest_tests tests/durable_ingest_tests.cpp)
  target_link_libraries(kungfu_durable_ingest_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_durable_ingest_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_durable_ingest_tests COMMAND kungfu_durable_ingest_tests)

  add_executable(kungfu_durability_powercut_fixture tests/durability_powercut_fixture.cpp)
  target_link_libraries(kungfu_durability_powercut_fixture PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_durability_powercut_fixture PRIVATE cxx_std_20)

  add_executable(kungfu_durability_slo_fixture tests/durability_slo_fixture.cpp)
  target_link_libraries(kungfu_durability_slo_fixture PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_durability_slo_fixture PRIVATE cxx_std_20)

  add_executable(kungfu_offhost_backup_fixture tests/offhost_backup_fixture.cpp)
  target_link_libraries(kungfu_offhost_backup_fixture PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_offhost_backup_fixture PRIVATE cxx_std_20)

  add_executable(kungfu_projection_bootstrap_tests tests/projection_bootstrap_tests.cpp)
  target_link_libraries(kungfu_projection_bootstrap_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_projection_bootstrap_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_projection_bootstrap_tests COMMAND kungfu_projection_bootstrap_tests)

  add_executable(kungfu_crash_recovery_tests tests/crash_recovery_tests.cpp)
  target_link_libraries(kungfu_crash_recovery_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_crash_recovery_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_crash_recovery_tests COMMAND kungfu_crash_recovery_tests)

  add_executable(kungfu_profile_lifecycle_tests tests/profile_lifecycle_tests.cpp)
  target_link_libraries(kungfu_profile_lifecycle_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_profile_lifecycle_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_profile_lifecycle_tests COMMAND kungfu_profile_lifecycle_tests)

  add_executable(kungfu_native_kfx_contract_tests tests/native_kfx_contract_tests.cpp)
  target_link_libraries(kungfu_native_kfx_contract_tests PRIVATE ${LIBKUNGFU_NAME} kungfu_compile_contract Threads::Threads)
  target_compile_features(kungfu_native_kfx_contract_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_native_kfx_contract_tests COMMAND kungfu_native_kfx_contract_tests)
endif()

# The production Windows core stays static to avoid the COFF export-table
# ceiling above, but the public storage SDK still needs one loadable C ABI.
# Compile only that adapter into a narrow DLL and link its implementation to
# the static core. The explicit dllexport macro keeps this target to the single
# version-negotiated bootstrap instead of re-enabling export-all-symbols.
if (WIN32)
  add_library(kungfu_native_storage_shared SHARED src/runtime/native_storage.cpp)
  target_compile_definitions(kungfu_native_storage_shared PRIVATE KF_NATIVE_STORAGE_BUILD_SHARED=1)
  target_link_libraries(kungfu_native_storage_shared PRIVATE ${LIBKUNGFU_NAME})
  set_target_properties(kungfu_native_storage_shared PROPERTIES
    OUTPUT_NAME kungfu
    ARCHIVE_OUTPUT_NAME kungfu_native_storage
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
  )
endif ()

# Windows AppContainer guest launcher (ADR-0014) lives in the runtime sandbox
# layer, not the standalone yijinjing core.
if(WIN32)
  # userenv: CreateAppContainerProfile / DeriveAppContainerSidFromAppContainerName
  # + GetAppContainerFolderPath. advapi32: FreeSid, SetEntriesInAcl,
  # GetNamedSecurityInfo/SetNamedSecurityInfo and ConvertSidToStringSid. ole32:
  # CoTaskMemFree. user32: window-station/desktop ACLs for USER32-linked guests.
  target_link_libraries(${LIBKUNGFU_NAME} PUBLIC userenv advapi32 user32 ole32)
endif()
