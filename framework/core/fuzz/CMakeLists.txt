# SPDX-License-Identifier: Apache-2.0
#
# kungfu::view memory-safety targets (ADR-0039 residual risk).
#
# The three fuzz entries (fuzz_compile_schema / fuzz_from_bytes / fuzz_bind_frame)
# each drive one untrusted-input entry of the sole FlatBuffers access module,
# compiling src/view/schema.cpp directly and linking only FlatBuffers + SQLite —
# no runtime, mirroring the view-encapsulation slice probe. The SAME entry
# functions are built in two independent tiers, differing only in instrumentation
# and driver:
#
#   -DKUNGFU_WITH_SANITIZERS=ON   every-build lightweight tier: replay the seed
#                                 corpus through a libFuzzer-less driver
#                                 (StandaloneFuzzMain.cpp) under ASan+UBSan.
#                                 Builds with the ordinary build compiler (Apple
#                                 clang / Linux clang|gcc / MSVC /fsanitize=address)
#                                 — zero extra toolchain.
#   -DKUNGFU_WITH_FUZZ=ON         alpha heavy tier: real libFuzzer long-run
#                                 (-fsanitize=fuzzer,address,undefined). Needs a
#                                 libFuzzer-capable clang (Homebrew LLVM on macOS,
#                                 system clang on Linux). If the compiler lacks
#                                 libFuzzer, the fuzz targets are skipped with a
#                                 message rather than failing configure.
#
# Configured STANDALONE (never add_subdirectory'd into framework/core) because
# the fuzz tier needs a different compiler than the conan/cmake-js core toolchain,
# and two compilers cannot share one build tree. Dependencies come from the conan
# CMakeDeps that build:core already generated: point CMAKE_PREFIX_PATH at the core
# build dir, e.g.
#   cmake -S framework/core/fuzz -B framework/core/build-sanitize \
#         -DKUNGFU_WITH_SANITIZERS=ON -DCMAKE_PREFIX_PATH=$PWD/framework/core/build
# scripts/verify.mjs wires both tiers; see fuzz/README.md for the standalone recipe.

cmake_minimum_required(VERSION 3.15)
project(kungfu_view_fuzz CXX)

option(KUNGFU_WITH_SANITIZERS "build the view fuzz entries under ASan+UBSan via a libFuzzer-less standalone driver" OFF)
option(KUNGFU_WITH_FUZZ "build the view fuzz entries as libFuzzer targets (needs a libFuzzer-capable clang)" OFF)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(flatbuffers REQUIRED)
find_package(SQLite3 REQUIRED)

# Whole libkungfu public include — covers kungfu::view today and any other core
# module a future fuzz target drives (e.g. a storage/episode import surface).
set(_lk_dir ${CMAKE_CURRENT_SOURCE_DIR}/../src/libkungfu)
set(_lk_inc ${_lk_dir}/include)
set(_view_src ${_lk_dir}/src/view/schema.cpp)

# The libFuzzer tier only materializes when the active compiler actually ships
# libFuzzer; otherwise skip with a message (Apple clang has none).
set(_have_libfuzzer OFF)
if (KUNGFU_WITH_FUZZ)
  include(CheckCXXSourceCompiles)
  set(CMAKE_REQUIRED_FLAGS "-fsanitize=fuzzer")
  check_cxx_source_compiles([[
    #include <cstddef>
    #include <cstdint>
    extern "C" int LLVMFuzzerTestOneInput(const uint8_t *, size_t) { return 0; }
  ]] KUNGFU_LIBFUZZER_OK)
  unset(CMAKE_REQUIRED_FLAGS)
  if (KUNGFU_LIBFUZZER_OK)
    set(_have_libfuzzer ON)
  else()
    message(STATUS "kungfu view fuzz: '${CMAKE_CXX_COMPILER}' lacks libFuzzer (-fsanitize=fuzzer); fuzz targets skipped. Use an LLVM clang (brew install llvm on macOS; system clang on Linux ships it).")
  endif()
endif()

if (NOT KUNGFU_WITH_SANITIZERS AND NOT _have_libfuzzer)
  message(STATUS "kungfu view fuzz: no tier active — set -DKUNGFU_WITH_SANITIZERS=ON (ASan/UBSan replay) and/or -DKUNGFU_WITH_FUZZ=ON (libFuzzer).")
endif()

# Sanitizer flags: MSVC exposes only ASan (/fsanitize=address); clang/gcc get
# ASan+UBSan with no silent recovery so the first violation aborts.
if (MSVC)
  set(_san_compile /fsanitize=address)
  set(_san_link "")
else()
  set(_san_compile -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
  set(_san_link -fsanitize=address,undefined)
endif()
set(_fuzz_flags -fsanitize=fuzzer,address,undefined -fno-omit-frame-pointer)

# kungfu_add_fuzz(<name> <module .cpp under test> [more .cpp ...])
#   Builds fuzz/fuzz_<name>.cpp + the module source(s) two ways:
#     KUNGFU_WITH_SANITIZERS -> fuzz_<name>_sanitize  (StandaloneFuzzMain corpus
#                                                      replay under ASan/UBSan, any compiler)
#     KUNGFU_WITH_FUZZ       -> fuzz_<name>           (libFuzzer, when available)
#   Adding a new untrusted-input surface is one row here + a fuzz_<name>.cpp entry +
#   a corpus/<name>/ seed dir; scripts/verify.mjs discovers targets from fuzz_*.cpp,
#   so no wiring change is needed beyond this file.
function(kungfu_add_fuzz _name)
  set(_entry ${CMAKE_CURRENT_SOURCE_DIR}/fuzz_${_name}.cpp)
  set(_mod_srcs ${ARGN})

  if (KUNGFU_WITH_SANITIZERS)
    add_executable(fuzz_${_name}_sanitize ${_entry} ${CMAKE_CURRENT_SOURCE_DIR}/StandaloneFuzzMain.cpp ${_mod_srcs})
    target_include_directories(fuzz_${_name}_sanitize PRIVATE ${_lk_inc})
    target_link_libraries(fuzz_${_name}_sanitize PRIVATE flatbuffers::flatbuffers SQLite::SQLite3)
    target_compile_options(fuzz_${_name}_sanitize PRIVATE ${_san_compile})
    if (_san_link)
      target_link_options(fuzz_${_name}_sanitize PRIVATE ${_san_link})
    endif()
  endif()

  if (_have_libfuzzer)
    add_executable(fuzz_${_name} ${_entry} ${_mod_srcs})
    target_include_directories(fuzz_${_name} PRIVATE ${_lk_inc})
    target_link_libraries(fuzz_${_name} PRIVATE flatbuffers::flatbuffers SQLite::SQLite3)
    target_compile_options(fuzz_${_name} PRIVATE ${_fuzz_flags})
    target_link_options(fuzz_${_name} PRIVATE ${_fuzz_flags})
  endif()
endfunction()

# ── Registered fuzz targets ─────────────────────────────────────────
# kungfu::view — the sole FlatBuffers access module (ADR-0039): the three
# untrusted-input entries each compile the view TU directly (no runtime).
kungfu_add_fuzz(compile_schema ${_view_src})
kungfu_add_fuzz(from_bytes     ${_view_src})
kungfu_add_fuzz(bind_frame     ${_view_src})
# Future untrusted-input surfaces plug in with one row, e.g.:
#   kungfu_add_fuzz(episode_import ${_lk_dir}/src/storage/episode/import.cpp)
