# SPDX-License-Identifier: Apache-2.0

set(CMAKE_CXX_STANDARD 20)

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
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -fPIC") # set -fPIC for nng
  set(CMAKE_CXX_FLAGS_DEBUG "-g -O0")
  set(CMAKE_CXX_FLAGS_RELEASE "-O0")
  set(CMAKE_LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE})
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/${CMAKE_BUILD_TYPE})
  set(CMAKE_BUILD_WITH_INSTALL_RPATH ON)
  set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
  set(COMPILER_OPTIMIZE_ON_OPTIONS "-O3")
  set(COMPILER_OPTIMIZE_OFF_OPTIONS "-O0")
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
      "@executable_path/../../../../Resources/kfc"
      )
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wno-deprecated-declarations -Wno-unqualified-std-cast-call -Wno-unused-value")
  set(CMAKE_INSTALL_RPATH "${KFC_INSTALL_RPATH}")
  set(CMAKE_MACOSX_RPATH ON)
  set(CONAN_DISABLE_CHECK_COMPILER ON)
endif ()
if (MSVC)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} /MP /utf-8 /permissive- /bigobj /W0 /Zc:__cplusplus")
  message(STATUS "CMAKE_CXX_FLAGS set to ${CMAKE_CXX_FLAGS}")
  set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} /IGNORE:4199")
  set(CMAKE_MODULE_LINKER_FLAGS "${CMAKE_MODULE_LINKER_FLAGS} /IGNORE:4199")
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
  add_compile_definitions(HAVE_SNPRINTF)
  add_compile_definitions(V8_DEPRECATION_WARNINGS=1)
  add_compile_definitions(_SILENCE_CXX17_CODECVT_HEADER_DEPRECATION_WARNING)
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
  set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} /Z7")
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} /Z7")
  set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} /DEBUG /OPT:REF /OPT:ICF")
  set(CMAKE_MODULE_LINKER_FLAGS "${CMAKE_MODULE_LINKER_FLAGS} /DEBUG /OPT:REF /OPT:ICF")
  set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} /DEBUG /OPT:REF /OPT:ICF")
endif ()

if (${CMAKE_CXX_COMPILER_ID} MATCHES GNU)
  set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -ftemplate-backtrace-limit=0 -Wno-address-of-packed-member -Wno-deprecated -Wno-nonnull")
endif ()

############################################################

macro(enable_windows_export_all_symbols)
  if (MSVC)
      set(CMAKE_WINDOWS_EXPORT_ALL_SYMBOLS ON)
  endif ()
endmacro()

macro(add_library_object OBJ_NAME SRC_FILES COMPILER_OPTIMIZE_OPTIONS OUTPUT_DIR)
  add_library(${OBJ_NAME} OBJECT ${SRC_FILES})
  set_target_properties(${OBJ_NAME} PROPERTIES POSITION_INDEPENDENT_CODE ON)
  if (NOT ${OUTPUT_DIR} STREQUAL "")
    set_target_properties(${OBJ_NAME} PROPERTIES ARCHIVE_OUTPUT_DIRECTORY ${OUTPUT_DIR})
  endif ()
  if (NOT ${COMPILER_OPTIMIZE_OPTIONS} STREQUAL "")
    target_compile_options(${OBJ_NAME} PRIVATE $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_OPTIONS}>)
  endif ()
endmacro()
