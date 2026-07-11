# SPDX-License-Identifier: Apache-2.0

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
set(KF_LIBWASM_WASMTIME_TARGET "${CMAKE_CURRENT_BINARY_DIR}/cargo-target-wasmtime")
set(KF_LIBWASM_WASMER_TARGET "${CMAKE_CURRENT_BINARY_DIR}/cargo-target-wasmer")

if(WIN32)
  set(KF_LIBWASM_WASMTIME_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/kungfu_libwasm_wasmtime.dll")
  set(KF_LIBWASM_WASMER_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/kungfu_libwasm_wasmer.dll")
elseif(APPLE)
  set(KF_LIBWASM_WASMTIME_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/libkungfu_libwasm_wasmtime.dylib")
  set(KF_LIBWASM_WASMER_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/libkungfu_libwasm_wasmer.dylib")
else()
  set(KF_LIBWASM_WASMTIME_LIBRARY "${KF_LIBWASM_WASMTIME_TARGET}/release/libkungfu_libwasm_wasmtime.so")
  set(KF_LIBWASM_WASMER_LIBRARY "${KF_LIBWASM_WASMER_TARGET}/release/libkungfu_libwasm_wasmer.so")
endif()

add_custom_command(
  OUTPUT "${KF_LIBWASM_WASMTIME_LIBRARY}"
  COMMAND ${CMAKE_COMMAND} -E env "CARGO_TARGET_DIR=${KF_LIBWASM_WASMTIME_TARGET}"
          "${KF_LIBWASM_CARGO}" ${KF_LIBWASM_CARGO_SOURCE_ARGS} build --release --locked
          --manifest-path "${KF_LIBWASM_ROOT}/wasmtime/Cargo.toml"
  DEPENDS
    "${KF_LIBWASM_ROOT}/wasmtime/Cargo.toml"
    "${KF_LIBWASM_ROOT}/wasmtime/Cargo.lock"
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
  DEPENDS
    "${KF_LIBWASM_ROOT}/wasmer/Cargo.toml"
    "${KF_LIBWASM_ROOT}/wasmer/Cargo.lock"
    "${KF_LIBWASM_ROOT}/src/lib.rs"
    "${KF_LIBWASM_ROOT}/src/production.rs"
    "${KF_LIBWASM_ROOT}/../libwasm-spike/src/lib.rs"
  WORKING_DIRECTORY "${KF_LIBWASM_ROOT}/wasmer"
  COMMENT "Building production Wasmer libwasm adapter"
  VERBATIM)

add_custom_target(kungfu_libwasm_cdylibs ALL
  DEPENDS "${KF_LIBWASM_WASMTIME_LIBRARY}" "${KF_LIBWASM_WASMER_LIBRARY}")

add_executable(kungfu_wasm_host host.cpp)
set_target_properties(kungfu_wasm_host PROPERTIES OUTPUT_NAME "kungfu-wasm-host")
add_dependencies(kungfu_wasm_host kungfu_libwasm_cdylibs)
target_include_directories(kungfu_wasm_host PRIVATE include ../libkungfu/include)
target_compile_options(kungfu_wasm_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(kungfu_wasm_host PRIVATE ${LIBKUNGFU_NAME} ${CMAKE_DL_LIBS})

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
