# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20)
project(yijinjing_custom_provider_consumer CXX)

# Standalone third-party shape: consume only the public yijinjing target and
# provider SDK. The fixture source stays shared with the parent-build contract
# test so the external and internal qualification paths cannot drift.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../../src/libyijinjing libyijinjing)
add_executable(custom_provider_consumer
  ${CMAKE_CURRENT_SOURCE_DIR}/../../src/libyijinjing/tests/custom_provider_qualification.cpp)
target_link_libraries(custom_provider_consumer PRIVATE yijinjing)

# Match the established standalone embedding contract for AppleClang 21:
# fmt 10.2.1's consteval parser needs this consumer-local compatibility define.
if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang" AND
   CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 21 AND
   CMAKE_CXX_COMPILER_VERSION VERSION_LESS 22)
  target_compile_options(yijinjing PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
  target_compile_options(custom_provider_consumer PRIVATE
    "$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
endif()
