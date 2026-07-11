# SPDX-License-Identifier: Apache-2.0

add_executable(native_storage_closure_host host.cpp)
target_include_directories(native_storage_closure_host PRIVATE ../../src/libkungfu/include)
target_compile_options(native_storage_closure_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(native_storage_closure_host PRIVATE ${LIBKUNGFU_NAME})
