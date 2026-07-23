# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20)
project(kungfu_kfd7_consumer LANGUAGES C CXX)

find_package(Kungfu 4 CONFIG REQUIRED)

add_executable(kungfu_kfd7_c_consumer c/main.c)
target_link_libraries(kungfu_kfd7_c_consumer PRIVATE Kungfu::kungfu)
set_target_properties(kungfu_kfd7_c_consumer PROPERTIES C_STANDARD 11 C_STANDARD_REQUIRED YES)

add_executable(kungfu_kfd7_cpp_consumer cpp/main.cpp)
target_link_libraries(kungfu_kfd7_cpp_consumer PRIVATE Kungfu::kungfu)
target_compile_features(kungfu_kfd7_cpp_consumer PRIVATE cxx_std_20)
