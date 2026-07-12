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

# this directory holds the libkungfu runtime layer above the standalone
# yijinjing journal core, so the source GLOB needs no exclusion list beyond the
# state-cache/optim split
file(GLOB_RECURSE KUNGFU_OPTIM_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/*.cpp)
file(GLOB_RECURSE KUNGFU_STATE_CACHE_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/runtime/state_cache/*.cpp)
list(REMOVE_ITEM KUNGFU_OPTIM_SOURCE_FILES ${KUNGFU_STATE_CACHE_SOURCE_FILES})

add_library_object(kungfu_state_cache "${KUNGFU_STATE_CACHE_SOURCE_FILES}" "${COMPILER_OPTIMIZE_OFF_OPTIONS}" "${KUNGFU_BUILD_DIR}")
add_library_object(kungfu_optim "${KUNGFU_OPTIM_SOURCE_FILES}" "${COMPILER_OPTIMIZE_ON_OPTIONS}" "${KUNGFU_BUILD_DIR}")

# the OBJECT libraries compile independently of the final target, so they
# need the runtime headers, the vendored sqlite_orm, and the yijinjing core
# usage requirements (headers, hana, public C++20 contract) at their own scope
set(LIBKUNGFU_SQLITE_ORM_INCLUDE ${PROJECT_SOURCE_DIR}/../../.deps/sqlite_orm-1.7.1/include)
foreach(_kf_obj kungfu_state_cache kungfu_optim)
  target_include_directories(${_kf_obj} PRIVATE ${PROJECT_SOURCE_DIR}/include ${KUNGFU_GENERATED_INCLUDE_DIR})
  target_include_directories(${_kf_obj} SYSTEM PRIVATE ${LIBKUNGFU_SQLITE_ORM_INCLUDE})
  target_link_libraries(${_kf_obj} PRIVATE yijinjing kungfu_compile_contract ${CONAN_LIBS})
endforeach()

# Windows: 用 STATIC。libkungfu 含 rocksdb/boost::hana/sqlite_orm 大量模板实例化，作为 SHARED DLL 时
# CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS 自动导出的符号数 >65535，撞 COFF 库成员上限(LNK1189)。改 STATIC 由各
# binding 链接；journal 是 mmap 文件、跨实例本就共享，故 Windows 上多 binding 各自静态链接 libkungfu 仍读同一 journal。
# Mac/Linux 维持 SHARED(运行时多语言绑定在同进程共享同一 dylib/so)。
if (WIN32)
  add_library(${LIBKUNGFU_NAME} STATIC $<TARGET_OBJECTS:kungfu_optim> $<TARGET_OBJECTS:kungfu_state_cache>)
else ()
  add_library(${LIBKUNGFU_NAME} SHARED $<TARGET_OBJECTS:kungfu_optim> $<TARGET_OBJECTS:kungfu_state_cache>)
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
target_link_libraries(${LIBKUNGFU_NAME} PUBLIC yijinjing ${CONAN_LIBS} PRIVATE kungfu_compile_contract)
kungfu_strip_release_local_symbols(${LIBKUNGFU_NAME})

if(KUNGFU_WITH_CORE_TESTS)
  find_package(Threads REQUIRED)
  add_executable(kungfu_durability_contract_tests tests/durability_contract_tests.cpp)
  target_link_libraries(kungfu_durability_contract_tests PRIVATE ${LIBKUNGFU_NAME})
  target_compile_features(kungfu_durability_contract_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_durability_contract_tests COMMAND kungfu_durability_contract_tests)

  add_executable(kungfu_runtime_error_tests tests/runtime_error_tests.cpp)
  target_link_libraries(kungfu_runtime_error_tests PRIVATE ${LIBKUNGFU_NAME} Threads::Threads)
  target_compile_features(kungfu_runtime_error_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_runtime_error_tests COMMAND kungfu_runtime_error_tests)

  add_executable(kungfu_state_service_contract_tests tests/state_service_contract_tests.cpp)
  target_link_libraries(kungfu_state_service_contract_tests PRIVATE ${LIBKUNGFU_NAME} Threads::Threads)
  target_compile_features(kungfu_state_service_contract_tests PRIVATE cxx_std_20)
  add_test(NAME kungfu_state_service_contract_tests COMMAND kungfu_state_service_contract_tests)
endif()

# Windows AppContainer guest launcher (ADR-0014) lives in the runtime sandbox
# layer, not the standalone yijinjing core.
if(WIN32)
  # userenv: CreateAppContainerProfile / DeriveAppContainerSidFromAppContainerName
  # + GetAppContainerFolderPath. advapi32: FreeSid, SetEntriesInAcl,
  # GetNamedSecurityInfo/SetNamedSecurityInfo and ConvertSidToStringSid. ole32:
  # CoTaskMemFree. user32: window-station/desktop ACLs for USER32-linked guests.
  target_link_libraries(${LIBKUNGFU_NAME} PUBLIC userenv advapi32 user32 ole32)
endif()
