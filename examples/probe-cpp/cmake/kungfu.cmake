# SPDX-License-Identifier: Apache-2.0
#
# Minimal, libkungfu-only build helper for a kfx C++ extension (v4 rewrite of the
# retired v2/v3 build/kungfu.cmake). It:
#   - locates the in-repo built core (libkungfu + its conan dependencies),
#   - wires pybind11 and FlatBuffers via the conan-generated configs,
#   - compiles src/cpp/*.cpp into a native pybind11 module (.so/.dylib/.pyd).
#
# It deliberately does NOT depend on libwingchun and does NOT invoke a separate
# flatc binary: the extension consumes libkungfu's already-generated FlatBuffers
# headers. Configure with the core's conan toolchain for ABI compatibility:
#
#   cmake -S . -B build \
#     -DCMAKE_TOOLCHAIN_FILE=<repo>/framework/core/build/conan_toolchain.cmake
#   cmake --build build

# Match the core build (gnu++23): the public yijinjing schema headers use
# C++20+ features, so extensions cannot compile against them with C++17.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

get_filename_component(KF_CORE_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../framework/core" ABSOLUTE)
if(NOT EXISTS "${KF_CORE_DIR}/src/libkungfu/include")
  message(FATAL_ERROR "libkungfu headers not found under ${KF_CORE_DIR}. Build the core first: ./shifu rebuild:core")
endif()

# conan-generated find_package() configs/modules live in the core build dir.
list(PREPEND CMAKE_PREFIX_PATH "${KF_CORE_DIR}/build")
list(PREPEND CMAKE_MODULE_PATH "${KF_CORE_DIR}/build")

find_package(pybind11 REQUIRED)
find_package(flatbuffers REQUIRED)
# kungfu/common.h pulls fmt, nlohmann/json, spdlog, and boost::hana into the
# public header surface, so every consumer of the libkungfu/libyijinjing
# headers needs the same dependency set the yijinjing target exports.
find_package(fmt REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(spdlog REQUIRED)

# The built libkungfu shared library.
find_library(KF_LIBKUNGFU
  NAMES kungfu libkungfu
  PATHS "${KF_CORE_DIR}/build/Release" "${KF_CORE_DIR}/dist/kfc"
  NO_DEFAULT_PATH)
if(NOT KF_LIBKUNGFU)
  message(FATAL_ERROR "libkungfu shared library not found under ${KF_CORE_DIR}. Build the core first: ./shifu rebuild:core")
endif()

# Compile src/cpp/*.cpp of the current extension into a native pybind11 module
# named ${_target}, linked against libkungfu + FlatBuffers.
macro(kungfu_cpp_extension _target)
  file(GLOB _kf_srcs CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/cpp/*.cpp")
  pybind11_add_module(${_target} SHARED ${_kf_srcs})
  target_include_directories(${_target} PRIVATE
    "${KF_CORE_DIR}/src/libkungfu/include"
    "${KF_CORE_DIR}/src/libyijinjing/include")
  # boost::hana is header-only and vendored next to the core tree (the same
  # copy the yijinjing target exports PUBLIC).
  if(EXISTS "${KF_CORE_DIR}/.deps/hana-1.80.0/include")
    target_include_directories(${_target} PRIVATE "${KF_CORE_DIR}/.deps/hana-1.80.0/include")
  endif()
  target_link_libraries(${_target} PRIVATE ${KF_LIBKUNGFU} flatbuffers::flatbuffers
    $<IF:$<TARGET_EXISTS:fmt::fmt-header-only>,fmt::fmt-header-only,fmt::fmt>
    $<IF:$<TARGET_EXISTS:spdlog::spdlog_header_only>,spdlog::spdlog_header_only,spdlog::spdlog>
    nlohmann_json::nlohmann_json)
endmacro()
