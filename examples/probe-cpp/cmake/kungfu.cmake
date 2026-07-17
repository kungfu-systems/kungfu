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

# The built libkungfu library. Single-config generators place it under
# build/Release on POSIX, while the Windows core target writes kungfu.lib to
# the build root through KUNGFU_BUILD_DIR.
find_library(KF_LIBKUNGFU
  NAMES kungfu libkungfu
  PATHS "${KF_CORE_DIR}/build/Release" "${KF_CORE_DIR}/build" "${KF_CORE_DIR}/dist/kfc"
  NO_DEFAULT_PATH)
if(NOT KF_LIBKUNGFU)
  message(FATAL_ERROR "libkungfu shared library not found under ${KF_CORE_DIR}. Build the core first: ./shifu rebuild:core")
endif()

# Windows builds libkungfu as a static archive to stay below the COFF export
# ceiling. Its public yijinjing dependency therefore remains a separate
# archive for standalone consumers, unlike the shared libkungfu on POSIX.
if(WIN32)
  find_package(xxHash REQUIRED)
  find_library(KF_LIBYIJINJING
    NAMES yijinjing libyijinjing
    PATHS "${KF_CORE_DIR}/build/Release" "${KF_CORE_DIR}/build"
    NO_DEFAULT_PATH)
  if(NOT KF_LIBYIJINJING)
    message(FATAL_ERROR "libyijinjing static library not found under ${KF_CORE_DIR}. Build the core first: ./shifu rebuild:core")
  endif()
endif()

# Compile src/cpp/*.cpp of the current extension into a native pybind11 module
# named ${_target}, linked against libkungfu + FlatBuffers.
macro(kungfu_cpp_extension _target)
  file(GLOB _kf_srcs CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/cpp/*.cpp")
  pybind11_add_module(${_target} SHARED ${_kf_srcs})
  # Public Core headers are UTF-8. Keep standalone Windows consumers aligned
  # with kungfu_compile_contract so MSVC does not parse them through the host
  # legacy code page and turn multibyte comments into C++ tokens.
  target_compile_options(${_target} PRIVATE
    "$<$<CXX_COMPILER_ID:MSVC>:/utf-8>")
  # Keep external C++ consumers on the same narrow fmt compatibility contract
  # as Core. AppleClang 21 rejects fmt 10.2.1's consteval parser in C++23 mode.
  if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang" AND
     CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 21 AND
     CMAKE_CXX_COMPILER_VERSION VERSION_LESS 22)
    target_compile_options(${_target} PRIVATE
      "$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
  endif()
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
  if(WIN32)
    target_link_libraries(${_target} PRIVATE ${KF_LIBYIJINJING} xxHash::xxhash)
  endif()
endmacro()
