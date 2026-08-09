# SPDX-License-Identifier: Apache-2.0

add_executable(hana_sqlite_projection_host host.cpp)
target_include_directories(hana_sqlite_projection_host PRIVATE ../../src/libkungfu/include)
target_compile_options(hana_sqlite_projection_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(hana_sqlite_projection_host PRIVATE ${LIBKUNGFU_NAME})
