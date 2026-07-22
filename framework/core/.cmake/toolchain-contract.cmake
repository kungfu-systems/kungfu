# SPDX-License-Identifier: Apache-2.0

set(KUNGFU_TOOLCHAIN_CONTRACT_FILE
    "${CMAKE_CURRENT_LIST_DIR}/../../../toolchain.contract.json")
file(READ "${KUNGFU_TOOLCHAIN_CONTRACT_FILE}" KUNGFU_TOOLCHAIN_CONTRACT)

function(kungfu_contract_get OUTPUT)
  string(JSON VALUE ERROR_VARIABLE ERROR GET "${KUNGFU_TOOLCHAIN_CONTRACT}" ${ARGN})
  if(ERROR)
    message(FATAL_ERROR "Invalid toolchain contract ${KUNGFU_TOOLCHAIN_CONTRACT_FILE}: ${ERROR}")
  endif()
  set(${OUTPUT} "${VALUE}" PARENT_SCOPE)
endfunction()

kungfu_contract_get(KUNGFU_MINIMUM_CMAKE minimum cmake)
kungfu_contract_get(KUNGFU_MINIMUM_NINJA minimum ninja)
kungfu_contract_get(KUNGFU_PROJECT_CXX_STANDARD policy project_cpp_standard)
kungfu_contract_get(KUNGFU_PUBLIC_YIJINJING_CXX_STANDARD policy public_yijinjing_cpp_standard)

if(CMAKE_VERSION VERSION_LESS KUNGFU_MINIMUM_CMAKE)
  message(FATAL_ERROR
    "Kungfu requires CMake >= ${KUNGFU_MINIMUM_CMAKE}; found ${CMAKE_VERSION}. "
    "Run ./shifu doctor for the platform-specific contract.")
endif()

if(NOT CMAKE_GENERATOR MATCHES "^Ninja")
  message(FATAL_ERROR "Kungfu requires the Ninja generator; found ${CMAKE_GENERATOR}")
endif()
execute_process(
  COMMAND "${CMAKE_MAKE_PROGRAM}" --version
  OUTPUT_VARIABLE KUNGFU_NINJA_VERSION
  OUTPUT_STRIP_TRAILING_WHITESPACE
  RESULT_VARIABLE KUNGFU_NINJA_RESULT)
if(NOT KUNGFU_NINJA_RESULT EQUAL 0 OR KUNGFU_NINJA_VERSION VERSION_LESS KUNGFU_MINIMUM_NINJA)
  message(FATAL_ERROR
    "Kungfu requires Ninja >= ${KUNGFU_MINIMUM_NINJA}; found ${KUNGFU_NINJA_VERSION}")
endif()

set(KUNGFU_ALLOWED_COMPILER FALSE)
if(APPLE AND CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang")
  set(KUNGFU_ALLOWED_COMPILER TRUE)
elseif(CMAKE_SYSTEM_NAME STREQUAL "Linux" AND CMAKE_CXX_COMPILER_ID MATCHES "^(GNU|Clang)$")
  set(KUNGFU_ALLOWED_COMPILER TRUE)
elseif(WIN32 AND CMAKE_CXX_COMPILER_ID MATCHES "^(MSVC|Clang)$")
  set(KUNGFU_ALLOWED_COMPILER TRUE)
endif()
if(NOT KUNGFU_ALLOWED_COMPILER)
  message(FATAL_ERROR
    "Compiler ${CMAKE_CXX_COMPILER_ID} is outside the Kungfu production/qualification matrix")
endif()

if(CMAKE_CXX_COMPILER_ID STREQUAL "AppleClang")
  kungfu_contract_get(KUNGFU_MINIMUM_COMPILER minimum apple_clang)
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
  kungfu_contract_get(KUNGFU_MINIMUM_COMPILER minimum gcc)
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "Clang")
  kungfu_contract_get(KUNGFU_MINIMUM_COMPILER minimum clang)
elseif(CMAKE_CXX_COMPILER_ID STREQUAL "MSVC")
  kungfu_contract_get(KUNGFU_MINIMUM_COMPILER minimum msvc)
endif()
if(CMAKE_CXX_COMPILER_VERSION VERSION_LESS KUNGFU_MINIMUM_COMPILER)
  message(FATAL_ERROR
    "${CMAKE_CXX_COMPILER_ID} >= ${KUNGFU_MINIMUM_COMPILER} is required; "
    "found ${CMAKE_CXX_COMPILER_VERSION}")
endif()

message(STATUS
  "Kungfu toolchain contract: C++${KUNGFU_PROJECT_CXX_STANDARD}, "
  "${CMAKE_CXX_COMPILER_ID} ${CMAKE_CXX_COMPILER_VERSION}, "
  "CMake ${CMAKE_VERSION}, Ninja ${KUNGFU_NINJA_VERSION}")
