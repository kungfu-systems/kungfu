# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20)
project(kungfu_kfd7_yijinjing_source_consumer LANGUAGES CXX)

add_subdirectory(libyijinjing)

add_executable(kungfu_kfd7_yijinjing_source_consumer main.cpp)
target_link_libraries(kungfu_kfd7_yijinjing_source_consumer PRIVATE yijinjing)
target_compile_features(kungfu_kfd7_yijinjing_source_consumer PRIVATE cxx_std_20)
