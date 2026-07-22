# SPDX-License-Identifier: Apache-2.0
#
# Minimal fact-ledger slice: standalone executables that embed the journal
# spine without starting the trading runtime.
#
#   fact_ledger_host             write path -- appends a causal chain of Json events
#   fact_ledger_export           read path  -- reopens the directory, emits JSONL + manifest
#   fact_ledger_action_recorder  C++ action_recorder write/readback smoke
#
# host/export link only the yijinjing journal core. action_recorder links
# libkungfu because that is the polyglot core action-recording surface.

project(fact_ledger_slice)

add_executable(fact_ledger_host host.cpp)
target_link_libraries(fact_ledger_host yijinjing)

add_executable(fact_ledger_export export.cpp)
target_link_libraries(fact_ledger_export yijinjing)

add_executable(fact_ledger_action_recorder action_recorder.cpp)
target_link_libraries(fact_ledger_action_recorder ${LIBKUNGFU_NAME})
