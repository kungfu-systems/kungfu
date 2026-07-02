# SPDX-License-Identifier: Apache-2.0
#
# yijinjing journal core as a standalone static library (libyijinjing.a).
#
# The core is the journal spine: frame/page mmap machinery, reader/writer,
# assemble, locator/location, and the base utilities they stand on. It sees
# only the longfist schema leaf (kungfu/longfist/core.h) -- never the trading
# type registry, nng, rxcpp, sqlite or rocksdb. libkungfu links this target
# and must not recompile these sources; minimal tools (fact-ledger slice)
# link only this target.
#
# This file is self-sufficient on purpose: inside the kungfu build the parent
# provides toolchain, dependency targets and output conventions, and every
# block below defers to them; embedded standalone (add_subdirectory /
# FetchContent from another project) the fallbacks kick in. The embedding
# contract is documented in EMBEDDING.md next to this file.

cmake_minimum_required(VERSION 3.15)
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

file(GLOB_RECURSE YIJINJING_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/*.cpp)

add_library(yijinjing STATIC ${YIJINJING_SOURCE_FILES})
# the ADR-0001 publication protocol uses std::atomic_ref; a target-level
# requirement holds even when the embedder's global standard is older
target_compile_features(yijinjing PUBLIC cxx_std_20)
# linked into the SHARED libkungfu on Mac/Linux
set_target_properties(yijinjing PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(DEFINED KUNGFU_BUILD_DIR)
  set_target_properties(yijinjing PROPERTIES ARCHIVE_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR})
endif()
target_include_directories(yijinjing PUBLIC ${PROJECT_SOURCE_DIR}/include)

# boost::hana is header-only; the kungfu build puts its vendored copy on the
# global include path. Standalone, fall back to that same vendored copy when
# the embedder has not provided <boost/hana.hpp> some other way.
if(NOT DEFINED KUNGFU_BUILD_DIR AND EXISTS ${PROJECT_SOURCE_DIR}/../../.deps/hana-1.80.0/include)
  target_include_directories(yijinjing PUBLIC ${PROJECT_SOURCE_DIR}/../../.deps/hana-1.80.0/include)
endif()

target_link_libraries(yijinjing PUBLIC
  $<IF:$<TARGET_EXISTS:fmt::fmt-header-only>,fmt::fmt-header-only,fmt::fmt>
  $<IF:$<TARGET_EXISTS:spdlog::spdlog_header_only>,spdlog::spdlog_header_only,spdlog::spdlog>
  nlohmann_json::nlohmann_json)

if(DEFINED COMPILER_OPTIMIZE_ON_OPTIONS AND NOT "${COMPILER_OPTIMIZE_ON_OPTIONS}" STREQUAL "")
  target_compile_options(yijinjing PRIVATE "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>")
endif()
