# SPDX-License-Identifier: Apache-2.0

# Shifu cache projection intentionally gives Cargo a short-lived wrapper path.
# CMake persists find_program results, so discard a wrapper that disappeared
# with the previous overlay before resolving the current command environment.
if(KF_LIBWASM_CARGO AND NOT EXISTS "${KF_LIBWASM_CARGO}")
  unset(KF_LIBWASM_CARGO CACHE)
endif()
find_program(KF_LIBWASM_CARGO cargo REQUIRED)
set(KF_LIBWASM_CARGO_REGISTRY_DEFAULT "")
if(DEFINED ENV{KF_LIBWASM_CARGO_REGISTRY})
  set(KF_LIBWASM_CARGO_REGISTRY_DEFAULT "$ENV{KF_LIBWASM_CARGO_REGISTRY}")
endif()
set(KF_LIBWASM_CARGO_REGISTRY "${KF_LIBWASM_CARGO_REGISTRY_DEFAULT}" CACHE STRING
  "Optional sparse Cargo registry mirror, for example sparse+https://rsproxy.cn/index/")
set(KF_LIBWASM_CARGO_SOURCE_ARGS)
if(KF_LIBWASM_CARGO_REGISTRY)
  list(APPEND KF_LIBWASM_CARGO_SOURCE_ARGS
    --config "source.crates-io.replace-with=\"kungfu-libwasm-mirror\""
    --config "source.kungfu-libwasm-mirror.registry=\"${KF_LIBWASM_CARGO_REGISTRY}\"")
endif()

set(KF_LIBWASM_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../crates/libwasm")
set(KF_LIBWASM_CARGO_TARGET_ROOT "" CACHE PATH
  "Optional root for stable per-engine libwasm Cargo target caches")
kungfu_resolve_libwasm_cargo_target(
  KF_LIBWASM_WASMTIME_TARGET KF_LIBWASM_WASMTIME_CACHE_KEY
  NAME wasmtime
  MANIFEST_DIR "${KF_LIBWASM_ROOT}/wasmtime"
  LOCKFILE "${KF_LIBWASM_ROOT}/wasmtime/Cargo.lock"
  SOURCE_ROOT "${KF_LIBWASM_ROOT}/../.."
  PROFILE release
  CARGO "${KF_LIBWASM_CARGO}"
  CACHE_ROOT "${KF_LIBWASM_CARGO_TARGET_ROOT}")
kungfu_resolve_libwasm_cargo_target(
  KF_LIBWASM_WASMER_TARGET KF_LIBWASM_WASMER_CACHE_KEY
  NAME wasmer
  MANIFEST_DIR "${KF_LIBWASM_ROOT}/wasmer"
  LOCKFILE "${KF_LIBWASM_ROOT}/wasmer/Cargo.lock"
  SOURCE_ROOT "${KF_LIBWASM_ROOT}/../.."
  PROFILE release
  CARGO "${KF_LIBWASM_CARGO}"
  CACHE_ROOT "${KF_LIBWASM_CARGO_TARGET_ROOT}")
set(KF_LIBWASM_STAGE_DIR "${CMAKE_CURRENT_BINARY_DIR}/cargo-stage")

if(WIN32)
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/kungfu_libwasm_wasmtime.dll")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/kungfu_libwasm_wasmer.dll")
elseif(APPLE)
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/libkungfu_libwasm_wasmtime.dylib")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/libkungfu_libwasm_wasmer.dylib")
else()
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/libkungfu_libwasm_wasmtime.so")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/libkungfu_libwasm_wasmer.so")
endif()
get_filename_component(KF_LIBWASM_WASMTIME_FILENAME "${KF_LIBWASM_WASMTIME_CACHED_LIBRARY}" NAME)
get_filename_component(KF_LIBWASM_WASMER_FILENAME "${KF_LIBWASM_WASMER_CACHED_LIBRARY}" NAME)
set(KF_LIBWASM_WASMTIME_LIBRARY "${KF_LIBWASM_STAGE_DIR}/${KF_LIBWASM_WASMTIME_FILENAME}")
set(KF_LIBWASM_WASMER_LIBRARY "${KF_LIBWASM_STAGE_DIR}/${KF_LIBWASM_WASMER_FILENAME}")

message(STATUS
  "libwasm Cargo cache: wasmtime=${KF_LIBWASM_WASMTIME_CACHE_KEY} "
  "(${KF_LIBWASM_WASMTIME_TARGET}), wasmer=${KF_LIBWASM_WASMER_CACHE_KEY} "
  "(${KF_LIBWASM_WASMER_TARGET})")

add_custom_command(
  OUTPUT "${KF_LIBWASM_WASMTIME_LIBRARY}"
  COMMAND ${CMAKE_COMMAND} -E env "CARGO_TARGET_DIR=${KF_LIBWASM_WASMTIME_TARGET}"
          "${KF_LIBWASM_CARGO}" ${KF_LIBWASM_CARGO_SOURCE_ARGS} build --release --locked
          --manifest-path "${KF_LIBWASM_ROOT}/wasmtime/Cargo.toml"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${KF_LIBWASM_STAGE_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMTIME_CACHED_LIBRARY}" "${KF_LIBWASM_WASMTIME_LIBRARY}"
  DEPENDS
    "${KF_LIBWASM_ROOT}/wasmtime/Cargo.toml"
    "${KF_LIBWASM_ROOT}/wasmtime/Cargo.lock"
    "${KF_LIBWASM_ROOT}/rust-toolchain.toml"
    "${KF_LIBWASM_ROOT}/src/lib.rs"
    "${KF_LIBWASM_ROOT}/src/production.rs"
    "${KF_LIBWASM_ROOT}/../libwasm-spike/src/lib.rs"
  WORKING_DIRECTORY "${KF_LIBWASM_ROOT}/wasmtime"
  COMMENT "Building production Wasmtime libwasm adapter"
  VERBATIM)

add_custom_command(
  OUTPUT "${KF_LIBWASM_WASMER_LIBRARY}"
  COMMAND ${CMAKE_COMMAND} -E env "CARGO_TARGET_DIR=${KF_LIBWASM_WASMER_TARGET}"
          "${KF_LIBWASM_CARGO}" ${KF_LIBWASM_CARGO_SOURCE_ARGS} build --release --locked
          --manifest-path "${KF_LIBWASM_ROOT}/wasmer/Cargo.toml"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${KF_LIBWASM_STAGE_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMER_CACHED_LIBRARY}" "${KF_LIBWASM_WASMER_LIBRARY}"
  DEPENDS
    "${KF_LIBWASM_ROOT}/wasmer/Cargo.toml"
    "${KF_LIBWASM_ROOT}/wasmer/Cargo.lock"
    "${KF_LIBWASM_ROOT}/rust-toolchain.toml"
    "${KF_LIBWASM_ROOT}/src/lib.rs"
    "${KF_LIBWASM_ROOT}/src/production.rs"
    "${KF_LIBWASM_ROOT}/../libwasm-spike/src/lib.rs"
  WORKING_DIRECTORY "${KF_LIBWASM_ROOT}/wasmer"
  COMMENT "Building production Wasmer libwasm adapter"
  VERBATIM)

add_custom_target(kungfu_libwasm_wasmtime_cdylib
  DEPENDS "${KF_LIBWASM_WASMTIME_LIBRARY}")
add_custom_target(kungfu_libwasm_wasmer_cdylib
  DEPENDS "${KF_LIBWASM_WASMER_LIBRARY}")
# Both adapters are heavy Rust release builds and share CARGO_HOME. Serialize
# them within one CMake graph; Cargo's own target-dir lock covers two separate
# CMake graphs that resolve to the same per-engine cache key.
add_dependencies(kungfu_libwasm_wasmer_cdylib kungfu_libwasm_wasmtime_cdylib)
add_custom_target(kungfu_libwasm_cdylibs ALL)
add_dependencies(kungfu_libwasm_cdylibs kungfu_libwasm_wasmer_cdylib)

add_executable(kungfu_wasm_host host.cpp)
set_target_properties(kungfu_wasm_host PROPERTIES OUTPUT_NAME "kungfu-wasm-host")
add_dependencies(kungfu_wasm_host kungfu_libwasm_cdylibs)
target_include_directories(kungfu_wasm_host PRIVATE include ../libkungfu/include)
target_compile_options(kungfu_wasm_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(kungfu_wasm_host PRIVATE
  ${LIBKUNGFU_NAME} kungfu_compile_contract ${CMAKE_DL_LIBS})

add_custom_target(kungfu_libwasm_self_test
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:kungfu_wasm_host>/libwasm"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMTIME_LIBRARY}" "$<TARGET_FILE_DIR:kungfu_wasm_host>/libwasm/"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMER_LIBRARY}" "$<TARGET_FILE_DIR:kungfu_wasm_host>/libwasm/"
  COMMAND "$<TARGET_FILE:kungfu_wasm_host>" --self-test
  DEPENDS kungfu_wasm_host
  COMMENT "Qualifying production libwasm engine metering"
  VERBATIM)
