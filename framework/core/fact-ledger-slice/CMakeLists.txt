# SPDX-License-Identifier: Apache-2.0
#
# Minimal fact-ledger slice: two standalone executables that embed the journal
# spine without starting the trading runtime.
#
#   fact_ledger_host    write path  -- appends a causal chain of Json events
#   fact_ledger_export  read path   -- reopens the directory, emits JSONL + manifest
#
# Both link the existing libkungfu (${LIBKUNGFU_NAME}); the parent CMakeLists
# already puts src/include and the conan libs on the global include/link path.

project(fact_ledger_slice)

add_executable(fact_ledger_host host.cpp)
target_link_libraries(fact_ledger_host ${LIBKUNGFU_NAME})

add_executable(fact_ledger_export export.cpp)
target_link_libraries(fact_ledger_export ${LIBKUNGFU_NAME})

# Find libkungfu at its build location when running from the build tree.
set_target_properties(fact_ledger_host fact_ledger_export PROPERTIES
  BUILD_WITH_INSTALL_RPATH FALSE
  SKIP_BUILD_RPATH FALSE)
