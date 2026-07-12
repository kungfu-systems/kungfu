# SPDX-License-Identifier: Apache-2.0

find_program(KF_LIBWASM_CARGO cargo REQUIRED)
include("${CMAKE_CURRENT_LIST_DIR}/../../.cmake/libwasm-cargo-cache.cmake")
set(KF_LIBWASM_CARGO_REGISTRY "" CACHE STRING
  "Optional sparse Cargo registry mirror, for example sparse+https://rsproxy.cn/index/")
set(KF_LIBWASM_CARGO_SOURCE_ARGS)
if(KF_LIBWASM_CARGO_REGISTRY)
  list(APPEND KF_LIBWASM_CARGO_SOURCE_ARGS
    --config "source.crates-io.replace-with=\"kungfu-spike-mirror\""
    --config "source.kungfu-spike-mirror.registry=\"${KF_LIBWASM_CARGO_REGISTRY}\"")
endif()
set(KF_LIBWASM_CRATE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../crates/libwasm-spike")
set(KF_LIBWASM_WASMTIME_DIR "${KF_LIBWASM_CRATE_ROOT}/wasmtime")
set(KF_LIBWASM_WASMER_DIR "${KF_LIBWASM_CRATE_ROOT}/wasmer")
set(KF_LIBWASM_CARGO_TARGET_ROOT "" CACHE PATH
  "Optional root for stable per-engine libwasm Cargo target caches")
kungfu_resolve_libwasm_cargo_target(
  KF_LIBWASM_WASMTIME_TARGET_DIR KF_LIBWASM_WASMTIME_CACHE_KEY
  NAME wasmtime-spike
  MANIFEST_DIR "${KF_LIBWASM_WASMTIME_DIR}"
  LOCKFILE "${KF_LIBWASM_WASMTIME_DIR}/Cargo.lock"
  SOURCE_ROOT "${KF_LIBWASM_CRATE_ROOT}/../.."
  PROFILE release
  CARGO "${KF_LIBWASM_CARGO}"
  CACHE_ROOT "${KF_LIBWASM_CARGO_TARGET_ROOT}")
kungfu_resolve_libwasm_cargo_target(
  KF_LIBWASM_WASMER_TARGET_DIR KF_LIBWASM_WASMER_CACHE_KEY
  NAME wasmer-spike
  MANIFEST_DIR "${KF_LIBWASM_WASMER_DIR}"
  LOCKFILE "${KF_LIBWASM_WASMER_DIR}/Cargo.lock"
  SOURCE_ROOT "${KF_LIBWASM_CRATE_ROOT}/../.."
  PROFILE release
  CARGO "${KF_LIBWASM_CARGO}"
  CACHE_ROOT "${KF_LIBWASM_CARGO_TARGET_ROOT}")
set(KF_LIBWASM_STAGE_DIR "${CMAKE_CURRENT_BINARY_DIR}/cargo-stage")

if(WIN32)
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET_DIR}/release/kf_libwasm_wasmtime_spike.dll")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET_DIR}/release/kf_libwasm_wasmer_spike.dll")
elseif(APPLE)
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET_DIR}/release/libkf_libwasm_wasmtime_spike.dylib")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET_DIR}/release/libkf_libwasm_wasmer_spike.dylib")
else()
  set(KF_LIBWASM_WASMTIME_CACHED_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET_DIR}/release/libkf_libwasm_wasmtime_spike.so")
  set(KF_LIBWASM_WASMER_CACHED_LIBRARY "${KF_LIBWASM_WASMER_TARGET_DIR}/release/libkf_libwasm_wasmer_spike.so")
endif()
get_filename_component(KF_LIBWASM_WASMTIME_FILENAME "${KF_LIBWASM_WASMTIME_CACHED_LIBRARY}" NAME)
get_filename_component(KF_LIBWASM_WASMER_FILENAME "${KF_LIBWASM_WASMER_CACHED_LIBRARY}" NAME)
set(KF_LIBWASM_WASMTIME_LIBRARY "${KF_LIBWASM_STAGE_DIR}/${KF_LIBWASM_WASMTIME_FILENAME}")
set(KF_LIBWASM_WASMER_LIBRARY "${KF_LIBWASM_STAGE_DIR}/${KF_LIBWASM_WASMER_FILENAME}")

add_custom_command(
  OUTPUT "${KF_LIBWASM_WASMTIME_LIBRARY}"
  COMMAND ${CMAKE_COMMAND} -E env
          "CARGO_TARGET_DIR=${KF_LIBWASM_WASMTIME_TARGET_DIR}"
          "${KF_LIBWASM_CARGO}" ${KF_LIBWASM_CARGO_SOURCE_ARGS} build --release --locked
          --manifest-path "${KF_LIBWASM_WASMTIME_DIR}/Cargo.toml"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${KF_LIBWASM_STAGE_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMTIME_CACHED_LIBRARY}" "${KF_LIBWASM_WASMTIME_LIBRARY}"
  DEPENDS
    "${KF_LIBWASM_WASMTIME_DIR}/Cargo.toml"
    "${KF_LIBWASM_WASMTIME_DIR}/Cargo.lock"
    "${KF_LIBWASM_CRATE_ROOT}/rust-toolchain.toml"
    "${KF_LIBWASM_CRATE_ROOT}/src/lib.rs"
  WORKING_DIRECTORY "${KF_LIBWASM_WASMTIME_DIR}"
  COMMENT "Building bounded Wasmtime libwasm adapter"
  VERBATIM)

add_custom_command(
  OUTPUT "${KF_LIBWASM_WASMER_LIBRARY}"
  COMMAND ${CMAKE_COMMAND} -E env
          "CARGO_TARGET_DIR=${KF_LIBWASM_WASMER_TARGET_DIR}"
          "${KF_LIBWASM_CARGO}" ${KF_LIBWASM_CARGO_SOURCE_ARGS} build --release --locked
          --manifest-path "${KF_LIBWASM_WASMER_DIR}/Cargo.toml"
  COMMAND ${CMAKE_COMMAND} -E make_directory "${KF_LIBWASM_STAGE_DIR}"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
          "${KF_LIBWASM_WASMER_CACHED_LIBRARY}" "${KF_LIBWASM_WASMER_LIBRARY}"
  DEPENDS
    "${KF_LIBWASM_WASMER_DIR}/Cargo.toml"
    "${KF_LIBWASM_WASMER_DIR}/Cargo.lock"
    "${KF_LIBWASM_CRATE_ROOT}/rust-toolchain.toml"
    "${KF_LIBWASM_CRATE_ROOT}/src/lib.rs"
  WORKING_DIRECTORY "${KF_LIBWASM_WASMER_DIR}"
  COMMENT "Building bounded Wasmer libwasm adapter"
  VERBATIM)

add_custom_target(libwasm_spike_wasmtime_cdylib
  DEPENDS "${KF_LIBWASM_WASMTIME_LIBRARY}")
add_custom_target(libwasm_spike_wasmer_cdylib
  DEPENDS "${KF_LIBWASM_WASMER_LIBRARY}")
add_dependencies(libwasm_spike_wasmer_cdylib libwasm_spike_wasmtime_cdylib)
add_custom_target(libwasm_spike_cdylibs ALL)
add_dependencies(libwasm_spike_cdylibs libwasm_spike_wasmer_cdylib)

add_executable(libwasm_shared_membrane_host host.cpp)
add_dependencies(libwasm_shared_membrane_host libwasm_spike_cdylibs)
target_include_directories(libwasm_shared_membrane_host PRIVATE ../../src/libkungfu/include)
target_compile_options(libwasm_shared_membrane_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(libwasm_shared_membrane_host PRIVATE ${LIBKUNGFU_NAME} ${CMAKE_DL_LIBS})
