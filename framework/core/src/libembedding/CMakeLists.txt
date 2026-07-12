# SPDX-License-Identifier: Apache-2.0
#
# ADR-0046 stage 3 (Phase B2): a Windows-only SHARED library that exports exactly
# one C symbol — kungfu_embedding_get_api — so the Rust trunk can link the
# embedding membrane on Windows. On Windows the core is built STATIC and does not
# export the embedding entry (a SHARED core blows the COFF 65535-export limit,
# LNK1189, because of the rocksdb/boost/sqlite_orm template closure — see
# ../libkungfu/CMakeLists.txt). Exporting a single symbol from a dedicated DLL
# dodges that limit while still handing the trunk something to link against.
#
# This target is deliberately NOT under src/libkungfu/, so it does not inherit
# that directory's enable_windows_export_all_symbols() — export-all over the whole
# core closure is exactly what LNK1189 rejects. The single dllexport comes solely
# from the header's KF_EMBEDDING_BUILD_SHARED path.
#
# Windows-only: on POSIX the trunk links libkungfu directly (the SHARED core
# already exports the entry via visibility, Phase A), so this DLL is never built
# there and POSIX is untouched.
#
# It compiles its own copy of embedding.cpp; the copy already inside kungfu.lib
# (matched by the src/*.cpp GLOB) stays dormant because nothing references it, so
# there is no duplicate-definition conflict. embedding.cpp must NOT be removed
# from the core GLOB — the POSIX libkungfu exports the entry from it.

add_library(kungfu_embedding SHARED
  ${CMAKE_CURRENT_SOURCE_DIR}/../libkungfu/src/runtime/embedding.cpp)

# The single dllexport; every other embedding function is anonymous-namespace
# static reached through the kf_embedding_api_v1 table, so nothing else exports.
target_compile_definitions(kungfu_embedding PRIVATE KF_EMBEDDING_BUILD_SHARED)

# embedding.cpp includes <kungfu/embedding.h> + <kungfu/runtime/io.h>; the rest of
# the include closure (yijinjing, generated flatbuffers, vendored headers) arrives
# transitively from the linked core targets' PUBLIC include dirs.
target_include_directories(kungfu_embedding PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/../libkungfu/include)

# Whole-core static closure: ${LIBKUNGFU_NAME} (STATIC on Windows) PUBLIC-
# propagates yijinjing + ${CONAN_LIBS} + userenv/advapi32/user32/ole32. This is
# pykungfu's link line minus ${LIBNODE} (embedding never touches node). The
# linker pulls the referenced objects from kungfu.lib/yijinjing.lib on demand.
target_link_libraries(kungfu_embedding PRIVATE
  ${LIBKUNGFU_NAME} kungfu_compile_contract ${CONAN_LIBS})

set_target_properties(kungfu_embedding PROPERTIES
  # Belt-and-suspenders against LNK1189: never auto-export the closure.
  WINDOWS_EXPORT_ALL_SYMBOLS OFF
  # kungfu_embedding.lib (import) + kungfu_embedding.dll land next to kungfu.lib
  # at the build root, where the trunk build points KF_TRUNK_NATIVE_DIR on Windows.
  ARCHIVE_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR}
  RUNTIME_OUTPUT_DIRECTORY ${KUNGFU_BUILD_DIR})

kungfu_strip_release_local_symbols(kungfu_embedding)
