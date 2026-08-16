# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.28)
project(kungfu LANGUAGES C CXX)

set(KUNGFU_SDK_VERSION "4.0.0-alpha.3" CACHE STRING "Installed Kungfu SDK version")

##########################################################################

include(${PROJECT_SOURCE_DIR}/.cmake/editor.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/compiler.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/toolchain-contract.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/libnode.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/libwasm-cargo-cache.cmake)

##########################################################################
# conan 2：依赖经 CMakeToolchain(工具链) + CMakeDeps(find_package 目标) 提供，
# 取代 conan 1.x 的 conanbuildinfo.cmake + conan_basic_setup。
# Concrete dependency targets are projected from architecture/build-capabilities.json.
include(${PROJECT_SOURCE_DIR}/architecture/BUILD_PROFILES.cmake)
find_package(fmt REQUIRED)
find_package(spdlog REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(xxHash REQUIRED)
if("nng" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(nng REQUIRED)
endif()
if("flatbuffers" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(flatbuffers REQUIRED)
endif()
if("rxcpp" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(rxcpp REQUIRED)
endif()
if("sqlite" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(SQLite3 REQUIRED)
endif()
if("rocksdb" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(RocksDB REQUIRED)
  add_compile_definitions(KUNGFU_HAS_ROCKSDB=1)
else()
  add_compile_definitions(KUNGFU_HAS_ROCKSDB=0)
endif()
if("tabulate" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  find_package(tabulate REQUIRED)
endif()
# pybind11 2.13 still uses FindPythonLibsNew for the shipping Python 3.13
# binding. CMake 3.28 would otherwise select CMP0148 NEW and change the module
# initialization/link contract. Keep this one policy OLD until pybind11's
# modern FindPython path passes the three-platform import/stub smoke.
if("python" IN_LIST KUNGFU_BUILD_BINDINGS)
  cmake_policy(SET CMP0148 OLD)
  find_package(pybind11 REQUIRED)
  # pybind11::windows_extras injects an unbounded /MP into every non-Debug
  # binding compile. Ninja already owns translation-unit scheduling, so keep
  # pybind11's /bigobj support but remove its second scheduler.
  if(MSVC AND TARGET pybind11::windows_extras)
    get_target_property(KUNGFU_PYBIND11_WINDOWS_COMPILE_OPTIONS
      pybind11::windows_extras INTERFACE_COMPILE_OPTIONS)
    if(KUNGFU_PYBIND11_WINDOWS_COMPILE_OPTIONS)
      list(FILTER KUNGFU_PYBIND11_WINDOWS_COMPILE_OPTIONS
        EXCLUDE REGEX "/MP")
      set_property(TARGET pybind11::windows_extras
        PROPERTY INTERFACE_COMPILE_OPTIONS
        "${KUNGFU_PYBIND11_WINDOWS_COMPILE_OPTIONS}")
    endif()
  endif()
endif()

# RxCpp 4.1.1 assigns to a const error_ptr in rx-notification.hpp. Conan's
# generated compatibility copy deletes that impossible assignment operator so
# clean GCC builds do not depend on a mutated shared package cache.
if("rxcpp" IN_LIST KUNGFU_BUILD_DEPENDENCY_ROOTS)
  if(NOT DEFINED KUNGFU_RXCPP_COMPAT_INCLUDE_DIR OR
     NOT EXISTS "${KUNGFU_RXCPP_COMPAT_INCLUDE_DIR}/rxcpp/rx-notification.hpp")
    message(FATAL_ERROR "missing generated RxCpp compatibility include tree")
  endif()
  target_include_directories(rxcpp::rxcpp BEFORE INTERFACE
    "${KUNGFU_RXCPP_COMPAT_INCLUDE_DIR}")
endif()

##########################################################################

option(NNG_TESTS "" OFF)
option(NNG_TOOLS "" OFF)
option(NNG_ENABLE_NNGCAT "" OFF)
option(KUNGFU_WITH_DEBUG_EXAMPLE "" OFF)
option(KUNGFU_WITH_SLICES "build the capability slices (minimal standalone proofs, see slices/README.md)" OFF)
option(KUNGFU_WITH_CORE_TESTS "build native yijinjing correctness tests" ON)
if(KUNGFU_WITH_CORE_TESTS)
  enable_testing()
endif()

##########################################################################

# header ownership is target-scoped: each library carries its own include/
# (src/libyijinjing, src/libkungfu) and propagates it via
# target_include_directories; vendored .deps headers attach to the targets
# that actually consume them (hana via yijinjing, sqlite_orm via libkungfu)

##########################################################################


set(KUNGFU_BUILD_DIR ${CMAKE_BINARY_DIR})
set(KUNGFU_BUILD_LIBRARY_DIR ${KUNGFU_BUILD_DIR}/${CMAKE_BUILD_TYPE})

# Every configured artifact carries a machine-readable qualification identity.
# This is intentionally emitted into the build tree (not the source tree), so
# package/build tooling can query the selected closure without loading a runtime.
execute_process(
  COMMAND git rev-parse HEAD
  WORKING_DIRECTORY "${PROJECT_SOURCE_DIR}"
  OUTPUT_VARIABLE KUNGFU_BUILD_SOURCE_REVISION
  OUTPUT_STRIP_TRAILING_WHITESPACE
  ERROR_QUIET
)
function(kungfu_json_array output values)
  if("${values}" STREQUAL "")
    set(${output} "[]" PARENT_SCOPE)
  else()
    string(REPLACE ";" "\", \"" quoted "${values}")
    set(${output} "[\"${quoted}\"]" PARENT_SCOPE)
  endif()
endfunction()
foreach(field COMPONENTS PROVIDERS PROJECTIONS BINDINGS DEPENDENCY_ROOTS)
  kungfu_json_array(KUNGFU_BUILD_IDENTITY_${field} "${KUNGFU_BUILD_${field}}")
endforeach()
if("runtime-services" IN_LIST KUNGFU_BUILD_COMPONENTS)
  set(KUNGFU_BUILD_IDENTITY_LIVE_CAPABILITY true)
else()
  set(KUNGFU_BUILD_IDENTITY_LIVE_CAPABILITY false)
endif()
file(TO_CMAKE_PATH "${KUNGFU_BUILD_DIR}" KUNGFU_BUILD_IDENTITY_BUILD_ROOT)
configure_file(
  "${PROJECT_SOURCE_DIR}/architecture/build-identity.json.in"
  "${KUNGFU_BUILD_DIR}/kungfu-core-build-identity.json"
  @ONLY
)
message(STATUS "Kungfu Core build identity: ${KUNGFU_BUILD_DIR}/kungfu-core-build-identity.json")

if(DEFINED ENV{LIBKUNGFU_NAME})
  set(LIBKUNGFU_NAME $ENV{LIBKUNGFU_NAME})
else()
  set(LIBKUNGFU_NAME kungfu)
endif()

##########################################################################

# journal core static library; libkungfu links it, minimal tools can link it alone
set(YIJINJING_BUILD_TESTS ${KUNGFU_WITH_CORE_TESTS})
add_subdirectory(src/libyijinjing)

if ("runtime-contracts" IN_LIST KUNGFU_BUILD_COMPONENTS AND
    (NOT DEFINED ENV{KUNGFU_BUILD_SKIP_LIBKUNGFU} OR NOT $ENV{KUNGFU_BUILD_SKIP_LIBKUNGFU}))
  message(STATUS "Enabled libkungfu")
  add_subdirectory(src/libkungfu)
  if ("c" IN_LIST KUNGFU_BUILD_BINDINGS)
    message(STATUS "Enabled KFD Agent Runtime adapter")
    add_subdirectory(src/kfd-agent-runtime)
  endif()
endif()

# Public-header self-compilation and frozen old-consumer ABI tests are generated
# from the same architecture authority as the component graph.
include(${PROJECT_SOURCE_DIR}/architecture/PUBLIC_CONTRACTS.cmake)

if (TARGET ${LIBKUNGFU_NAME} AND "wasm" IN_LIST KUNGFU_BUILD_BINDINGS)
  message(STATUS "Enabled production libwasm runtime")
  add_subdirectory(src/libwasm)
endif()

set(KUNGFU_BUILD_NODE_BINDINGS OFF)
if (NOT DEFINED ENV{KUNGFU_BUILD_SKIP_KUNGFU_NODE} OR NOT $ENV{KUNGFU_BUILD_SKIP_KUNGFU_NODE})
  set(KUNGFU_BUILD_NODE_BINDINGS ON)
endif()
if ((KUNGFU_BUILD_NODE_BINDINGS OR (WIN32 AND "${NODE_RUNTIME}" STREQUAL "node")) AND
    ("node" IN_LIST KUNGFU_BUILD_BINDINGS OR "electron" IN_LIST KUNGFU_BUILD_BINDINGS))
  message(STATUS "Enabled node bindings/runtime host")
  add_subdirectory(src/bindings/node)
endif()

if ((NOT DEFINED ENV{KUNGFU_BUILD_SKIP_PYKUNGFU} OR NOT $ENV{KUNGFU_BUILD_SKIP_PYKUNGFU}) AND
    "python" IN_LIST KUNGFU_BUILD_BINDINGS)
  message(STATUS "Enabled pykungfu")
  # pybind11 由 conan2 提供（find_package 已在顶部声明，requires pybind11/2.13.6）；
  # 不再 vendored（旧 2.9.0 不支持 Python 3.13）。
  add_subdirectory(src/bindings/python)
endif()

if (KUNGFU_WITH_DEBUG_EXAMPLE)
  message(STATUS "Enabled kungfu_debug_example")
  add_subdirectory(debug-example)
endif()

# Capability slices (minimal standalone proofs; see slices/README.md).
# The fact-ledger slice links only the yijinjing core, so the aggregate is
# wired whenever that target exists.
if (KUNGFU_WITH_SLICES AND TARGET yijinjing)
  message(STATUS "Enabled capability slices")
  add_subdirectory(slices)
endif()

if(TARGET ${LIBKUNGFU_NAME})
  include(GNUInstallDirs)
  include(CMakePackageConfigHelpers)

  if(WIN32)
    set(KUNGFU_INSTALL_RUNTIME_TARGETS kungfu_abi)
  else()
    set(KUNGFU_INSTALL_RUNTIME_TARGETS kungfu_abi ${LIBKUNGFU_NAME})
  endif()

  install(TARGETS ${KUNGFU_INSTALL_RUNTIME_TARGETS}
    RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}"
    LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}"
    ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
  )
  install(FILES
    "${PROJECT_SOURCE_DIR}/src/libkungfu/include/kungfu/api.h"
    "${PROJECT_SOURCE_DIR}/src/libkungfu/include/kungfu/api.hpp"
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}/kungfu"
  )
  install(FILES
    "${PROJECT_SOURCE_DIR}/src/libkungfu/include/kungfu/sdk/generated/runtime_action_v1.hpp"
    "${PROJECT_SOURCE_DIR}/src/libkungfu/include/kungfu/sdk/generated/work_lifecycle_v1.hpp"
    DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}/kungfu/sdk/generated"
  )
  install(FILES
    "${PROJECT_SOURCE_DIR}/architecture/kfd7-library-boundary.contract.json"
    "${PROJECT_SOURCE_DIR}/architecture/libkungfu-symbol-policy.json"
    "${PROJECT_SOURCE_DIR}/architecture/kfd7-abi-conformance-v1.json"
    "${PROJECT_SOURCE_DIR}/architecture/kfd7-embedder-operational-semantics-v1.json"
    "${PROJECT_SOURCE_DIR}/architecture/kfd7-release-passport.json"
    "${PROJECT_SOURCE_DIR}/architecture/layered-api-encoding-boundary.contract.json"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/kungfu/contracts"
  )
  install(FILES
    "${PROJECT_SOURCE_DIR}/../../docs/guides/libkungfu-abi-consumer.md"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/kungfu/docs"
  )
  install(DIRECTORY
    "${PROJECT_SOURCE_DIR}/examples/kfd7-consumer/"
    DESTINATION "${CMAKE_INSTALL_DATADIR}/kungfu/examples/kfd7-consumer"
  )

  configure_package_config_file(
    "${PROJECT_SOURCE_DIR}/cmake/KungfuConfig.cmake.in"
    "${CMAKE_CURRENT_BINARY_DIR}/KungfuConfig.cmake"
    INSTALL_DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/Kungfu"
  )
  write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/KungfuConfigVersion.cmake"
    VERSION 4.0.0
    COMPATIBILITY SameMajorVersion
  )
  install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/KungfuConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/KungfuConfigVersion.cmake"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/Kungfu"
  )
endif()
