# SPDX-License-Identifier: Apache-2.0

include_guard(GLOBAL)

function(kungfu_libwasm_default_cargo_target_root OUTPUT)
  if(DEFINED ENV{KF_LIBWASM_CARGO_TARGET_ROOT} AND
     NOT "$ENV{KF_LIBWASM_CARGO_TARGET_ROOT}" STREQUAL "")
    set(ROOT "$ENV{KF_LIBWASM_CARGO_TARGET_ROOT}")
  elseif(DEFINED ENV{XDG_CACHE_HOME} AND NOT "$ENV{XDG_CACHE_HOME}" STREQUAL "")
    set(ROOT "$ENV{XDG_CACHE_HOME}/kungfu/libwasm/cargo-target")
  elseif(WIN32 AND DEFINED ENV{LOCALAPPDATA} AND NOT "$ENV{LOCALAPPDATA}" STREQUAL "")
    set(ROOT "$ENV{LOCALAPPDATA}/kungfu/libwasm/cargo-target")
  elseif(DEFINED ENV{HOME} AND NOT "$ENV{HOME}" STREQUAL "")
    set(ROOT "$ENV{HOME}/.cache/kungfu/libwasm/cargo-target")
  elseif(DEFINED ENV{USERPROFILE} AND NOT "$ENV{USERPROFILE}" STREQUAL "")
    set(ROOT "$ENV{USERPROFILE}/.cache/kungfu/libwasm/cargo-target")
  else()
    set(ROOT "${CMAKE_BINARY_DIR}/.kungfu-cache/libwasm/cargo-target")
  endif()
  cmake_path(ABSOLUTE_PATH ROOT NORMALIZE OUTPUT_VARIABLE ROOT)
  set(${OUTPUT} "${ROOT}" PARENT_SCOPE)
endfunction()

# Resolve one isolated Cargo target directory. The source-root fingerprint keeps
# independent Git worktrees from racing on the same primary crate artifacts,
# while all CMake build trees created from one checkout reuse the same cache.
# The actual Cargo/Rust compiler identity, target, profile, and lockfile hash
# make invalidation explicit and keep Wasmtime/Wasmer dependency worlds apart.
function(kungfu_resolve_libwasm_cargo_target OUTPUT_DIR OUTPUT_KEY)
  set(ONE_VALUE_ARGS
      NAME
      MANIFEST_DIR
      LOCKFILE
      SOURCE_ROOT
      PROFILE
      CARGO
      RUSTC
      CACHE_ROOT
      TARGET
      TOOLCHAIN_FINGERPRINT)
  cmake_parse_arguments(KF "" "${ONE_VALUE_ARGS}" "" ${ARGN})

  foreach(REQUIRED_ARG NAME MANIFEST_DIR LOCKFILE SOURCE_ROOT PROFILE)
    if(NOT KF_${REQUIRED_ARG})
      message(FATAL_ERROR "kungfu_resolve_libwasm_cargo_target requires ${REQUIRED_ARG}")
    endif()
  endforeach()
  if(NOT KF_NAME MATCHES "^[A-Za-z0-9._-]+$" OR
     NOT KF_PROFILE MATCHES "^[A-Za-z0-9._-]+$")
    message(FATAL_ERROR "libwasm Cargo cache name/profile must be path-safe")
  endif()
  if(NOT EXISTS "${KF_LOCKFILE}")
    message(FATAL_ERROR "libwasm Cargo lockfile not found: ${KF_LOCKFILE}")
  endif()

  file(REAL_PATH "${KF_SOURCE_ROOT}" SOURCE_ROOT_REAL)
  file(SHA256 "${KF_LOCKFILE}" LOCK_HASH)
  string(SHA256 SOURCE_HASH "${SOURCE_ROOT_REAL}")

  if(KF_TOOLCHAIN_FINGERPRINT)
    set(TOOLCHAIN_FINGERPRINT "${KF_TOOLCHAIN_FINGERPRINT}")
  else()
    if(NOT KF_CARGO)
      message(FATAL_ERROR "libwasm Cargo cache resolution requires CARGO")
    endif()
    execute_process(
      COMMAND "${KF_CARGO}" -Vv
      WORKING_DIRECTORY "${KF_MANIFEST_DIR}"
      OUTPUT_VARIABLE CARGO_VERSION
      ERROR_VARIABLE CARGO_VERSION_ERROR
      OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE CARGO_VERSION_RESULT)
    if(NOT CARGO_VERSION_RESULT EQUAL 0)
      message(FATAL_ERROR
        "Failed to identify Cargo for libwasm cache: ${CARGO_VERSION_ERROR}")
    endif()

    if(KF_RUSTC)
      set(RUSTC "${KF_RUSTC}")
    else()
      get_filename_component(CARGO_DIRECTORY "${KF_CARGO}" DIRECTORY)
      find_program(RUSTC NAMES rustc HINTS "${CARGO_DIRECTORY}" NO_DEFAULT_PATH)
      if(NOT RUSTC)
        find_program(RUSTC NAMES rustc REQUIRED)
      endif()
    endif()
    execute_process(
      COMMAND "${RUSTC}" -vV
      WORKING_DIRECTORY "${KF_MANIFEST_DIR}"
      OUTPUT_VARIABLE RUSTC_VERSION
      ERROR_VARIABLE RUSTC_VERSION_ERROR
      OUTPUT_STRIP_TRAILING_WHITESPACE
      RESULT_VARIABLE RUSTC_VERSION_RESULT)
    if(NOT RUSTC_VERSION_RESULT EQUAL 0)
      message(FATAL_ERROR
        "Failed to identify rustc for libwasm cache: ${RUSTC_VERSION_ERROR}")
    endif()
    set(TOOLCHAIN_FINGERPRINT "cargo=${CARGO_VERSION}\nrustc=${RUSTC_VERSION}")
  endif()

  if(KF_TARGET)
    set(CARGO_TARGET "${KF_TARGET}")
  elseif(DEFINED ENV{CARGO_BUILD_TARGET} AND NOT "$ENV{CARGO_BUILD_TARGET}" STREQUAL "")
    set(CARGO_TARGET "$ENV{CARGO_BUILD_TARGET}")
  else()
    set(CARGO_TARGET "host")
  endif()

  string(SHA256 TOOLCHAIN_HASH "${TOOLCHAIN_FINGERPRINT}")
  string(SHA256 TARGET_HASH "${KF_NAME}|${KF_PROFILE}|${CARGO_TARGET}")
  string(SUBSTRING "${SOURCE_HASH}" 0 12 SOURCE_KEY)
  string(SUBSTRING "${TOOLCHAIN_HASH}" 0 12 TOOLCHAIN_KEY)
  string(SUBSTRING "${TARGET_HASH}" 0 8 TARGET_KEY)
  string(SUBSTRING "${LOCK_HASH}" 0 12 LOCK_KEY)
  set(CACHE_KEY
      "v1-${SOURCE_KEY}-${TOOLCHAIN_KEY}-${TARGET_KEY}-${LOCK_KEY}")

  if(KF_CACHE_ROOT)
    set(CACHE_ROOT "${KF_CACHE_ROOT}")
    cmake_path(ABSOLUTE_PATH CACHE_ROOT NORMALIZE OUTPUT_VARIABLE CACHE_ROOT)
  else()
    kungfu_libwasm_default_cargo_target_root(CACHE_ROOT)
  endif()
  set(TARGET_DIR "${CACHE_ROOT}/${KF_NAME}/${KF_PROFILE}/${CACHE_KEY}")

  set(${OUTPUT_DIR} "${TARGET_DIR}" PARENT_SCOPE)
  set(${OUTPUT_KEY} "${CACHE_KEY}" PARENT_SCOPE)
endfunction()
