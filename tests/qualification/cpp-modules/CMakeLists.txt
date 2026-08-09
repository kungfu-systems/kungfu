# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.28)
project(kungfu_cpp_modules_qualification LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(KUNGFU_QUALIFICATION_MODE "module" CACHE STRING "module or header")
set_property(CACHE KUNGFU_QUALIFICATION_MODE PROPERTY STRINGS module header)

set(CONSUMERS)
foreach(INDEX RANGE 0 47)
  set(SOURCE "${CMAKE_CURRENT_BINARY_DIR}/consumer_${INDEX}.cpp")
  if(KUNGFU_QUALIFICATION_MODE STREQUAL "module")
    file(WRITE "${SOURCE}"
      "import kungfu.qualification;\nint consumer_${INDEX}() { return kungfu::qualification::mix(${INDEX}); }\n")
  elseif(KUNGFU_QUALIFICATION_MODE STREQUAL "header")
    file(WRITE "${SOURCE}"
      "#include <kungfu/qualification.hpp>\nint consumer_${INDEX}() { return kungfu::qualification::mix(${INDEX}); }\n")
  else()
    message(FATAL_ERROR "KUNGFU_QUALIFICATION_MODE must be module or header")
  endif()
  list(APPEND CONSUMERS "${SOURCE}")
endforeach()

add_executable(qualification main.cpp ${CONSUMERS})
if(KUNGFU_QUALIFICATION_MODE STREQUAL "module")
  add_library(kungfu_qualification)
  target_sources(kungfu_qualification
    PUBLIC FILE_SET CXX_MODULES FILES kungfu.qualification.cppm)
  target_link_libraries(qualification PRIVATE kungfu_qualification)
else()
  target_include_directories(qualification PRIVATE include)
endif()

enable_testing()
add_test(NAME cpp_modules_qualification COMMAND qualification)
