# SPDX-License-Identifier: Apache-2.0
#
# Embedding slice: a STANDALONE CMake project simulating an external consumer
# of the yijinjing core (the D30 distribution form: source/static embedding
# via add_subdirectory; contract in src/libyijinjing/EMBEDDING.md).
#
# Deliberately NOT wired into slices/CMakeLists.txt: the proof is that this
# project configures and builds against src/libyijinjing alone, with no help
# from the kungfu parent build. run.mjs configures it from scratch in a
# throwaway build directory; the embedder provides its own dependencies
# (here: the conan toolchain, as any conan-using embedder would).

cmake_minimum_required(VERSION 3.20)
project(yijinjing_embed_smoke CXX)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../src/libyijinjing libyijinjing)

# Match Core's narrow fmt compatibility contract for the standalone consumer.
# AppleClang 21 rejects fmt 10.2.1's consteval parser in C++23 mode.
if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang" AND
   CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 21 AND
   CMAKE_CXX_COMPILER_VERSION VERSION_LESS 22)
  target_compile_options(yijinjing PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
endif()

add_executable(embed_smoke main.cpp)
target_link_libraries(embed_smoke yijinjing)
if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang" AND
   CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 21 AND
   CMAKE_CXX_COMPILER_VERSION VERSION_LESS 22)
  target_compile_options(embed_smoke PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
endif()
