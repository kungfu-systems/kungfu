# SPDX-License-Identifier: Apache-2.0
#
# Minimal fact-ledger slice: two standalone executables that embed the journal
# spine without starting the trading runtime.
#
#   fact_ledger_host    write path  -- appends a causal chain of Json events
#   fact_ledger_export  read path   -- reopens the directory, emits JSONL + manifest
#
# Both link ONLY the yijinjing journal core -- this is the cut-proof for the
# static-core boundary: the tools embed the journal spine without libkungfu.

project(fact_ledger_slice)

add_executable(fact_ledger_host host.cpp)
target_link_libraries(fact_ledger_host yijinjing)

add_executable(fact_ledger_export export.cpp)
target_link_libraries(fact_ledger_export yijinjing)
