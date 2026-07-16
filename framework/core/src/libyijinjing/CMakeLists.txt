# SPDX-License-Identifier: Apache-2.0
#
# yijinjing journal core as a standalone static library (libyijinjing.a).
#
# The core is the journal spine: frame/page mmap machinery, reader/writer,
# assemble, locator/location, storage semantic contracts, and the base
# utilities they stand on. It sees only the yijinjing schema leaf
# (kungfu/yijinjing/schema/core.h) -- never the trading type registry, nng, rxcpp,
# sqlite or rocksdb. libkungfu links this target and must not recompile these
# sources; minimal tools (fact-ledger slice) link only this target.
#
# This file is self-sufficient on purpose: inside the kungfu build the parent
# provides toolchain, dependency targets and output conventions, and every
# block below defers to them; embedded standalone (add_subdirectory /
# FetchContent from another project) the fallbacks kick in. The embedding
# contract is documented in EMBEDDING.md next to this file.

cmake_minimum_required(VERSION 3.20)
project(yijinjing CXX)

# header-only dependencies -- resolved here only when no enclosing build
# already provides the targets (the kungfu build supplies them via conan)
if(NOT TARGET fmt::fmt-header-only AND NOT TARGET fmt::fmt)
  find_package(fmt REQUIRED)
endif()
if(NOT TARGET spdlog::spdlog_header_only AND NOT TARGET spdlog::spdlog)
  find_package(spdlog REQUIRED)
endif()
if(NOT TARGET nlohmann_json::nlohmann_json)
  find_package(nlohmann_json REQUIRED)
endif()
if(NOT TARGET xxHash::xxhash)
  find_package(xxHash REQUIRED)
endif()

file(GLOB_RECURSE YIJINJING_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/*.cpp)

add_library(yijinjing STATIC ${YIJINJING_SOURCE_FILES})
# the ADR-0001 publication protocol uses std::atomic_ref; a target-level
# requirement holds even when the embedder's global standard is older
target_compile_features(yijinjing PUBLIC cxx_std_20)
if(TARGET kungfu_compile_contract)
  target_link_libraries(yijinjing PUBLIC kungfu_compile_contract)
endif()
# linked into the SHARED libkungfu on Mac/Linux
set_target_properties(yijinjing PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(DEFINED KUNGFU_BUILD_DIR)
  set_target_properties(yijinjing PROPERTIES ARCHIVE_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR})
endif()
target_include_directories(yijinjing PUBLIC ${PROJECT_SOURCE_DIR}/include)

# boost::hana is header-only; inside the kungfu build and standalone alike,
# use the vendored copy next to this tree unless the embedder has provided
# <boost/hana.hpp> some other way. PUBLIC so every consumer of the core's
# yijinjing schema leaf inherits it.
if(EXISTS ${PROJECT_SOURCE_DIR}/../../.deps/hana-1.80.0/include)
  target_include_directories(yijinjing SYSTEM PUBLIC ${PROJECT_SOURCE_DIR}/../../.deps/hana-1.80.0/include)
endif()

target_link_libraries(yijinjing PUBLIC
  $<IF:$<TARGET_EXISTS:fmt::fmt-header-only>,fmt::fmt-header-only,fmt::fmt>
  $<IF:$<TARGET_EXISTS:spdlog::spdlog_header_only>,spdlog::spdlog_header_only,spdlog::spdlog>
  nlohmann_json::nlohmann_json
  xxHash::xxhash)

option(YIJINJING_BUILD_TESTS "build yijinjing native correctness tests" OFF)
if(YIJINJING_BUILD_TESTS)
  add_executable(yijinjing_mmap_tests tests/mmap_tests.cpp)
  target_link_libraries(yijinjing_mmap_tests PRIVATE yijinjing)
  if(TARGET kungfu_compile_contract)
    target_link_libraries(yijinjing_mmap_tests PRIVATE kungfu_compile_contract)
  endif()
  target_compile_features(yijinjing_mmap_tests PRIVATE cxx_std_20)
  target_compile_definitions(yijinjing_mmap_tests PRIVATE
    YIJINJING_RETAINED_WIRE_V1_FIXTURE="${PROJECT_SOURCE_DIR}/tests/fixtures/journal-wire-v1.json")
  add_test(NAME yijinjing_mmap_tests COMMAND yijinjing_mmap_tests)

  add_executable(yijinjing_content_hash_tests tests/content_hash_tests.cpp)
  target_link_libraries(yijinjing_content_hash_tests PRIVATE yijinjing)
  if(TARGET kungfu_compile_contract)
    target_link_libraries(yijinjing_content_hash_tests PRIVATE kungfu_compile_contract)
  endif()
  target_compile_features(yijinjing_content_hash_tests PRIVATE cxx_std_20)
  add_test(NAME yijinjing_content_hash_tests COMMAND yijinjing_content_hash_tests)

  add_executable(yijinjing_custom_provider_qualification tests/custom_provider_qualification.cpp)
  target_link_libraries(yijinjing_custom_provider_qualification PRIVATE yijinjing)
  if(TARGET kungfu_compile_contract)
    target_link_libraries(yijinjing_custom_provider_qualification PRIVATE kungfu_compile_contract)
  endif()
  target_compile_features(yijinjing_custom_provider_qualification PRIVATE cxx_std_20)
  add_test(NAME yijinjing_custom_provider_qualification COMMAND yijinjing_custom_provider_qualification)

  # A no-SQLite profile must retain fact authority, not merely compile the
  # journal target. These two independent programs write and then reopen a
  # causal fact ledger without starting libkungfu or a projection backend.
  add_executable(yijinjing_fact_ledger_host ../../slices/fact-ledger/host.cpp)
  target_link_libraries(yijinjing_fact_ledger_host PRIVATE yijinjing)
  add_executable(yijinjing_fact_ledger_export ../../slices/fact-ledger/export.cpp)
  target_link_libraries(yijinjing_fact_ledger_export PRIVATE yijinjing)
  set(YIJINJING_FACT_LEDGER_TEST_ROOT "${CMAKE_CURRENT_BINARY_DIR}/fact-ledger-qualification")
  add_test(NAME yijinjing_fact_authority_reset
    COMMAND ${CMAKE_COMMAND} -E remove_directory "${YIJINJING_FACT_LEDGER_TEST_ROOT}")
  set_tests_properties(yijinjing_fact_authority_reset PROPERTIES FIXTURES_SETUP yijinjing_fact_root)
  add_test(NAME yijinjing_fact_authority_write
    COMMAND yijinjing_fact_ledger_host "${YIJINJING_FACT_LEDGER_TEST_ROOT}" 3)
  set_tests_properties(yijinjing_fact_authority_write PROPERTIES
    FIXTURES_REQUIRED yijinjing_fact_root
    FIXTURES_SETUP yijinjing_fact_ledger)
  add_test(NAME yijinjing_fact_authority_reopen
    COMMAND yijinjing_fact_ledger_export "${YIJINJING_FACT_LEDGER_TEST_ROOT}"
      fact_ledger_slice host "${YIJINJING_FACT_LEDGER_TEST_ROOT}/export")
  set_tests_properties(yijinjing_fact_authority_reopen PROPERTIES
    FIXTURES_REQUIRED yijinjing_fact_ledger
    PASS_REGULAR_EXPRESSION "causal_chain_verified: true")

  # Evidence tool only: this executable exercises the qualified production
  # surface but is not linked into or shipped with the runtime.
  add_executable(yijinjing_mmap_qualification tests/mmap_qualification.cpp)
  target_link_libraries(yijinjing_mmap_qualification PRIVATE yijinjing)
  if(TARGET kungfu_compile_contract)
    target_link_libraries(yijinjing_mmap_qualification PRIVATE kungfu_compile_contract)
  endif()
  target_compile_features(yijinjing_mmap_qualification PRIVATE cxx_std_20)

  # Multi-process publication-protocol stress harness. A real single writer and
  # several real reader processes share the same mmap journal pages and
  # content-verify every observed frame -- machine-driven detection of the
  # ADR-0001 torn/reordered/duplicated-frame class on weak-memory hardware. The
  # full multi-process run is deliberately NOT a default ctest (it is minutes
  # long and POSIX-only); only the portable checker self-test is registered so
  # CI proves the detection logic itself is sound.
  add_executable(yijinjing_journal_stress tests/journal_stress_harness.cpp)
  target_link_libraries(yijinjing_journal_stress PRIVATE yijinjing)
  if(TARGET kungfu_compile_contract)
    target_link_libraries(yijinjing_journal_stress PRIVATE kungfu_compile_contract)
  endif()
  target_compile_features(yijinjing_journal_stress PRIVATE cxx_std_20)
  add_test(NAME yijinjing_journal_stress_checker
    COMMAND yijinjing_journal_stress --self-test-checker)
endif()

if(DEFINED COMPILER_OPTIMIZE_ON_OPTIONS AND NOT "${COMPILER_OPTIMIZE_ON_OPTIONS}" STREQUAL "")
  target_compile_options(yijinjing PRIVATE "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>")
endif()
