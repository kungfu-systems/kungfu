# SPDX-License-Identifier: Apache-2.0
#
# yijinjing journal core as a standalone static library (libyijinjing.a).
#
# The core is the journal spine: frame/page mmap machinery, reader/writer,
# assemble, locator/location, and the base utilities they stand on. It sees
# only the longfist schema leaf (kungfu/longfist/core.h) -- never the trading
# type registry, nng, rxcpp, sqlite or rocksdb. libkungfu links this target
# and must not recompile these sources; minimal tools (fact-ledger slice)
# link only this target.

project(yijinjing)

file(GLOB_RECURSE YIJINJING_SOURCE_FILES ${PROJECT_SOURCE_DIR}/src/*.cpp)

add_library(yijinjing STATIC ${YIJINJING_SOURCE_FILES})
# linked into the SHARED libkungfu on Mac/Linux
set_target_properties(yijinjing PROPERTIES
  POSITION_INDEPENDENT_CODE ON
  ARCHIVE_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR})
target_include_directories(yijinjing PUBLIC ${PROJECT_SOURCE_DIR}/include)
target_compile_options(yijinjing PRIVATE "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>")
