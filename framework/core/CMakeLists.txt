# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.15)
project(kungfu)

##########################################################################

include(${PROJECT_SOURCE_DIR}/.cmake/editor.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/compiler.cmake)
include(${PROJECT_SOURCE_DIR}/.cmake/libnode.cmake)

##########################################################################
# conan 2：依赖经 CMakeToolchain(工具链) + CMakeDeps(find_package 目标) 提供，
# 取代 conan 1.x 的 conanbuildinfo.cmake + conan_basic_setup。
# 用 CONAN_LIBS 列出 conan2 目标，使 src/libkungfu/CMakeLists.txt 的
# target_link_libraries(... ${CONAN_LIBS}) 与下方 link_libraries 零改动复用。
find_package(fmt REQUIRED)
find_package(spdlog REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(nng REQUIRED)
find_package(flatbuffers REQUIRED)
find_package(rxcpp REQUIRED)
find_package(SQLite3 REQUIRED)
find_package(RocksDB REQUIRED)
find_package(tabulate REQUIRED)
find_package(pybind11 REQUIRED)

set(CONAN_LIBS
    fmt::fmt-header-only
    spdlog::spdlog_header_only
    nlohmann_json::nlohmann_json
    nng::nng
    flatbuffers::flatbuffers
    rxcpp::rxcpp
    SQLite::SQLite3
    RocksDB::rocksdb
    tabulate::tabulate)

# conan2 的 object 库靠 target usage-requirement 传播 include；libkungfu 走 OBJECT
# 库分别编译，需在定义 target 前全局挂上依赖 include（复刻旧 conan_basic_setup 行为）。
link_libraries(${CONAN_LIBS})

##########################################################################

add_compile_definitions(HAVE_USLEEP=1)

add_compile_definitions(SPDLOG_ACTIVE_LEVEL=${SPDLOG_LOG_LEVEL_COMPILE})
add_compile_definitions(SPDLOG_NO_NAME)
add_compile_definitions(SPDLOG_NO_ATOMIC_LEVELS)

##########################################################################

option(NNG_TESTS "" OFF)
option(NNG_TOOLS "" OFF)
option(NNG_ENABLE_NNGCAT "" OFF)
option(KUNGFU_WITH_DEBUG_EXAMPLE "" OFF)
option(KUNGFU_WITH_SLICES "build the capability slices (minimal standalone proofs, see slices/README.md)" OFF)

##########################################################################

# header ownership is target-scoped: each library carries its own include/
# (src/libyijinjing, src/libkungfu) and propagates it via
# target_include_directories; vendored .deps headers attach to the targets
# that actually consume them (hana via yijinjing, sqlite_orm via libkungfu)

##########################################################################

# flatc build-time codegen：longfist 开放层 FB schema(.fbs)经 flatbuffers::flatc 在构建期生成
# *_generated.h(--cpp --gen-mutable --scoped-enums)+ *.bfbs(-b --schema)，取代手动跑 flatc + 入仓产物
# (消跨 schema 重跑/漂移)。flatbuffers::flatc 由 conan flatbuffers 的 cmake_build_modules
# (FlatcTargets.cmake)在 find_package(flatbuffers)时暴露；三平台均 native build(非交叉)，FlatcTargets
# 用包内 bin/flatc。生成到 libkungfu 的 include 树内以保 include 路径不变(产物已 gitignore)。
set(LONGFIST_FB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src/libkungfu/include/kungfu/longfist/fb)
add_custom_command(
  OUTPUT ${LONGFIST_FB_DIR}/order_generated.h ${LONGFIST_FB_DIR}/order.bfbs
  COMMAND flatbuffers::flatc --cpp --gen-mutable --scoped-enums -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/order.fbs
  COMMAND flatbuffers::flatc -b --schema -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/order.fbs
  DEPENDS ${LONGFIST_FB_DIR}/order.fbs
  COMMENT "flatc: order.fbs -> order_generated.h + order.bfbs"
  VERBATIM)
# trade.fbs include order.fbs，故也依赖 order.fbs(改 order schema 一并重生成 trade)。
add_custom_command(
  OUTPUT ${LONGFIST_FB_DIR}/trade_generated.h ${LONGFIST_FB_DIR}/trade.bfbs
  COMMAND flatbuffers::flatc --cpp --gen-mutable --scoped-enums -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/trade.fbs
  COMMAND flatbuffers::flatc -b --schema -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/trade.fbs
  DEPENDS ${LONGFIST_FB_DIR}/trade.fbs ${LONGFIST_FB_DIR}/order.fbs
  COMMENT "flatc: trade.fbs -> trade_generated.h + trade.bfbs"
  VERBATIM)
# position.fbs include order.fbs(复用 InstrumentType),故也依赖 order.fbs。
add_custom_command(
  OUTPUT ${LONGFIST_FB_DIR}/position_generated.h ${LONGFIST_FB_DIR}/position.bfbs
  COMMAND flatbuffers::flatc --cpp --gen-mutable --scoped-enums -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/position.fbs
  COMMAND flatbuffers::flatc -b --schema -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/position.fbs
  DEPENDS ${LONGFIST_FB_DIR}/position.fbs ${LONGFIST_FB_DIR}/order.fbs
  COMMENT "flatc: position.fbs -> position_generated.h + position.bfbs"
  VERBATIM)
# asset.fbs include position.fbs(复用 LedgerCategory),故也依赖 position.fbs(及其 include 的 order.fbs)。
add_custom_command(
  OUTPUT ${LONGFIST_FB_DIR}/asset_generated.h ${LONGFIST_FB_DIR}/asset.bfbs
  COMMAND flatbuffers::flatc --cpp --gen-mutable --scoped-enums -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/asset.fbs
  COMMAND flatbuffers::flatc -b --schema -I ${LONGFIST_FB_DIR} -o ${LONGFIST_FB_DIR} ${LONGFIST_FB_DIR}/asset.fbs
  DEPENDS ${LONGFIST_FB_DIR}/asset.fbs ${LONGFIST_FB_DIR}/position.fbs ${LONGFIST_FB_DIR}/order.fbs
  COMMENT "flatc: asset.fbs -> asset_generated.h + asset.bfbs"
  VERBATIM)
add_custom_target(longfist_fb_codegen DEPENDS
  ${LONGFIST_FB_DIR}/order_generated.h ${LONGFIST_FB_DIR}/order.bfbs
  ${LONGFIST_FB_DIR}/trade_generated.h ${LONGFIST_FB_DIR}/trade.bfbs
  ${LONGFIST_FB_DIR}/position_generated.h ${LONGFIST_FB_DIR}/position.bfbs
  ${LONGFIST_FB_DIR}/asset_generated.h ${LONGFIST_FB_DIR}/asset.bfbs)

##########################################################################


set(KUNGFU_BUILD_DIR ${CMAKE_BINARY_DIR})
set(KUNGFU_BUILD_LIBRARY_DIR ${KUNGFU_BUILD_DIR}/${CMAKE_BUILD_TYPE})

link_directories(${KUNGFU_BUILD_LIBRARY_DIR})

##########################################################################

if(DEFINED ENV{LIBKUNGFU_NAME})
  set(LIBKUNGFU_NAME $ENV{LIBKUNGFU_NAME})
else()
  set(LIBKUNGFU_NAME kungfu)
endif()

##########################################################################

# journal core static library; libkungfu links it, minimal tools can link it alone
add_subdirectory(src/libyijinjing)

if (NOT DEFINED ENV{KUNGFU_BUILD_SKIP_LIBKUNGFU} OR NOT $ENV{KUNGFU_BUILD_SKIP_LIBKUNGFU})
  message(STATUS "Enabled libkungfu")
  add_subdirectory(src/libkungfu)
  # libkungfu 的 OBJECT 库(编译 matcher.cpp 等 include 生成头的源)须在 flatc codegen 之后再编。
  foreach(_kf_obj kungfu_cache kungfu_optim)
    if(TARGET ${_kf_obj})
      add_dependencies(${_kf_obj} longfist_fb_codegen)
    endif()
  endforeach()
endif()

if (NOT DEFINED ENV{KUNGFU_BUILD_SKIP_KUNGFU_NODE} OR NOT $ENV{KUNGFU_BUILD_SKIP_KUNGFU_NODE})
  message(STATUS "Enabled kungfu_node")
  add_subdirectory(src/bindings/node)
endif()

if (NOT DEFINED ENV{KUNGFU_BUILD_SKIP_PYKUNGFU} OR NOT $ENV{KUNGFU_BUILD_SKIP_PYKUNGFU})
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

