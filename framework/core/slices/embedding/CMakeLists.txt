# SPDX-License-Identifier: Apache-2.0
#
# Embedding slice: a STANDALONE CMake project simulating an external consumer
# of the yijinjing core (the D30 distribution form: source/static embedding
# via add_subdirectory; contract in src/libyijinjing/EMBEDDING.md).
#
# Deliberately NOT wired into slices/CMakeLists.txt: the proof is that this
# project configures and builds against src/libyijinjing alone, with no help
# from the kungfu parent build. run.sh configures it from scratch in a
# throwaway build directory; the embedder provides its own dependencies
# (here: the conan toolchain, as any conan-using embedder would).

cmake_minimum_required(VERSION 3.15)
project(yijinjing_embed_smoke CXX)

add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../src/libyijinjing libyijinjing)

add_executable(embed_smoke main.cpp)
target_link_libraries(embed_smoke yijinjing)
