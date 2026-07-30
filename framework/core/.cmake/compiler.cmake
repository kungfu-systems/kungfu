# SPDX-License-Identifier: Apache-2.0

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

############################################################

# 编译器缓存 launcher：优先 sccache(MSVC 原生 + 远程缓存后端),其次 ccache。命中即用、
# 缺失 no-op(开源克隆/未装机零影响)。Linux/macOS 通常命中 ccache、Windows 命中 sccache。
# 显著加速 clean-rebuild 下 libkungfu 重模板重编;libkungfu(conan build)与 node/electron
# bindings(cmake-js)共用本文件,一处全覆盖。
# 注:VS/MSBuild 生成器对 launcher 的支持随 CMake 版本而异,Windows 命中率以实测为准
# (Phase1 评估,goal 2026-06-27-windows-compile-cache-ci)。
find_program(KFC_COMPILER_CACHE NAMES sccache ccache)
if (KFC_COMPILER_CACHE)
  set(CMAKE_C_COMPILER_LAUNCHER "${KFC_COMPILER_CACHE}")
  set(CMAKE_CXX_COMPILER_LAUNCHER "${KFC_COMPILER_CACHE}")
  message(STATUS "compiler cache launcher: ${KFC_COMPILER_CACHE}")
endif ()

############################################################

# Set the global compile options.
# Some of the options may be override by target_compiles_options later in sub-projects.
if (UNIX)
  set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE})
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE})
  set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
  set(COMPILER_OPTIMIZE_ON_OPTIONS "-O3")
  set(COMPILER_OPTIMIZE_OFF_OPTIONS "-O0")
  # Strip local symbols from Release shared libraries and loadable modules.
  # libkungfu.dylib, kungfu_node.node, kungfu_electron.node and pykungfu.so each
  # carry tens of MB of local symbol table in __LINKEDIT (heavy template
  # instantiation from watcher.cpp + sqlite_orm/boost.hana/rxcpp/flatbuffers).
  # -Wl,-x discards only local symbols; the global/dynamic symbols that @rpath
  # linking between these artifacts relies on stay in the table. Release-scoped
  # so debug builds keep their symbols; UNIX covers macOS and Linux, while the
  # MSVC path below is left untouched because it deliberately ships PDBs for
  # field crash symbolization (docs/windows-crash-symbols.md). Release carries no
  # -g here, so there is no DWARF to preserve in a dSYM -- only local symbol
  # names are dropped from crash backtraces.
endif ()
if (UNIX AND NOT APPLE)
  set(KFC_INSTALL_RPATH
      "$ORIGIN"
      "$ORIGIN/../../"
      )
  set(CMAKE_INSTALL_RPATH "${KFC_INSTALL_RPATH}")
endif ()
if (APPLE)
  # @executable_path = "Kungfu.app/Contents/Frameworks/Kungfu Helper.app/Contents/MacOS"
  set(KFC_INSTALL_RPATH
      "@loader_path"
      "@loader_path/../../"
      "@executable_path/../../../../Resources/kungfu"
      )
  set(CMAKE_INSTALL_RPATH "${KFC_INSTALL_RPATH}")
  set(CMAKE_MACOSX_RPATH ON)
  set(CONAN_DISABLE_CHECK_COMPILER ON)
endif ()
if (MSVC)
  # /EHsc is part of the core RAII contract: exception paths must unwind local
  # owners (file handles, mappings, and other native resources).
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
  set(COMPILER_OPTIMIZE_ON_OPTIONS "/O2")
  set(COMPILER_OPTIMIZE_OFF_OPTIONS "/Od")
  # Emit debug info as PDBs so Windows crash reports symbolize in the field.
  # kungfu ships no source on the box and the C++ core is linked statically into
  # kungfu_node.node / pykungfu.pyd; without the matching PDB next to those
  # binaries the native stackwalker can only print module+offset. /Z7 keeps the
  # debug info inside each .obj (sccache-cacheable; /Zi serializes through
  # mspdbsrv and defeats the MSVC compiler cache). /DEBUG makes the linker emit
  # <target>.pdb, and /OPT:REF /OPT:ICF restore the size optimizations that
  # /DEBUG turns off by default so Release binaries stay lean. The release must
  # ship these PDBs -- see docs/windows-crash-symbols.md, enforced at freeze time
  # by .gyp/verify-windows-symbols.js.
endif ()

# fmt 10.2.1's consteval format-string parser is rejected by AppleClang 21 in
# C++23 mode. Apply the narrow compatibility flag to every Core C++ target,
# including tests that intentionally do not link kungfu_compile_contract.
if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang" AND
   CMAKE_CXX_COMPILER_VERSION VERSION_GREATER_EQUAL 21 AND
   CMAKE_CXX_COMPILER_VERSION VERSION_LESS 22)
  add_compile_options("$<$<COMPILE_LANGUAGE:CXX>:-DFMT_CONSTEVAL=>")
endif()

add_library(kungfu_compile_contract INTERFACE)
target_compile_features(kungfu_compile_contract INTERFACE cxx_std_23)
target_compile_definitions(kungfu_compile_contract INTERFACE
  HAVE_USLEEP=1
  SPDLOG_ACTIVE_LEVEL=${SPDLOG_LOG_LEVEL_COMPILE}
  SPDLOG_NO_NAME
  SPDLOG_NO_ATOMIC_LEVELS
  $<$<CXX_COMPILER_ID:MSVC>:HAVE_SNPRINTF;V8_DEPRECATION_WARNINGS=1;_SILENCE_CXX17_CODECVT_HEADER_DEPRECATION_WARNING>)
# Exhaustive switch over closed enums is part of the compile contract
# (KF-ADR-019f86da-4f90-7749-b14e-9c0626c03f9f): an enumerator with neither a case label nor a default arm is an
# error, not a warning. A deliberate default arm stays legal -- it is the
# designed escape for unknown inputs at durability seams (e.g. the storage
# offline scanners' unknown-record downgrade paths). MSVC C4062 is the same
# predicate as -Wswitch; C4061 (which fires even with a default present) would
# outlaw those designed arms and is intentionally not enabled.
target_compile_options(kungfu_compile_contract INTERFACE
  $<$<CXX_COMPILER_ID:AppleClang,Clang>:-Wall;-Werror=switch>
  $<$<CXX_COMPILER_ID:GNU>:-Wall;-Werror=switch;-ftemplate-backtrace-limit=0>
  $<$<CXX_COMPILER_ID:MSVC>:/MP;/utf-8;/permissive-;/bigobj;/W3;/we4062;/Zc:__cplusplus;/EHsc;/Z7>)
target_link_options(kungfu_compile_contract INTERFACE
  $<$<CXX_COMPILER_ID:MSVC>:/DEBUG;/OPT:REF;/OPT:ICF;/IGNORE:4199>)

function(kungfu_strip_release_local_symbols TARGET_NAME)
  if(UNIX)
    target_link_options(${TARGET_NAME} PRIVATE "$<$<CONFIG:Release>:-Wl,-x>")
  endif()
endfunction()

############################################################

macro(enable_windows_export_all_symbols)
  if (MSVC)
      set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)
  endif ()
endmacro()

macro(add_library_object OBJ_NAME SRC_FILES COMPILER_OPTIMIZE_OPTIONS OUTPUT_DIR)
  add_library(${OBJ_NAME} OBJECT ${SRC_FILES})
  target_link_libraries(${OBJ_NAME} PRIVATE kungfu_compile_contract)
  set_target_properties(${OBJ_NAME} PROPERTIES POSITION_INDEPENDENT_CODE ON)
  if (NOT ${OUTPUT_DIR} STREQUAL "")
    set_target_properties(${OBJ_NAME} PROPERTIES ARCHIVE_OUTPUT_DIRECTORY ${OUTPUT_DIR})
  endif ()
  if (NOT ${COMPILER_OPTIMIZE_OPTIONS} STREQUAL "")
    target_compile_options(${OBJ_NAME} PRIVATE $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_OPTIONS}>)
  endif ()
endmacro()
