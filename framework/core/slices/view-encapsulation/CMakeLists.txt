# SPDX-License-Identifier: Apache-2.0
#
# view-encapsulation slice: proves "all FlatBuffers access goes through one
# runtime-independent chokepoint" (ADR-0039).
#
#   view_encapsulation_probe  drives the kungfu::view public API end to end
#                             (thin/full projection roundtrip, schema evolution,
#                             untrusted-input verifier). It compiles the view
#                             module source (src/view/schema.cpp) directly and
#                             links NEITHER yijinjing NOR libkungfu — only the
#                             directory-wide CONAN_LIBS (FlatBuffers + SQLite).
#                             That the proof builds without the runtime is the
#                             boundary claim: the view module is a swappable
#                             detail depending on nothing above it.
#
# The FB boundary itself (no raw flatbuffers::/reflection:: outside the module)
# is asserted by run.mjs via src/libkungfu/check-view-boundary.mjs.

project(view_encapsulation_slice)

set(_view_src ${CMAKE_CURRENT_SOURCE_DIR}/../../src/libkungfu/src/view/schema.cpp)
set(_view_inc ${CMAKE_CURRENT_SOURCE_DIR}/../../src/libkungfu/include)

add_executable(view_encapsulation_probe probe.cpp ${_view_src})
target_include_directories(view_encapsulation_probe PRIVATE ${_view_inc})
# Only FlatBuffers + SQLite; deliberately no yijinjing / libkungfu link.
target_link_libraries(view_encapsulation_probe
  flatbuffers::flatbuffers
  SQLite::SQLite3)
