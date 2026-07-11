# SPDX-License-Identifier: Apache-2.0

macro(use_node_addon_api)
  execute_process(
          COMMAND
          node -p "require('node-addon-api').include"
          WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
          OUTPUT_VARIABLE NODE_ADDON_API_DIR
  )
  string(REPLACE "\n" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})
  string(REPLACE "\"" "" NODE_ADDON_API_DIR ${NODE_ADDON_API_DIR})

  message(STATUS "Include node-addon-api headers from [${NODE_ADDON_API_DIR}]")
  message(STATUS "Include node-js headers from [${CMAKE_JS_INC}]")

  include_directories(${NODE_ADDON_API_DIR})
  include_directories(${CMAKE_JS_INC})

  add_compile_definitions(NAPI_EXPERIMENTAL)
  add_compile_definitions(NAPI_VERSION=8)
  add_compile_definitions(NODE_ADDON_API_CPP_EXCEPTIONS)
  if (MSVC)
    # node-addon-api cannot infer exception support from MSVC unless the
    # compiler emits standard C++ unwind semantics.
    add_compile_options(/EHsc)
  endif ()
endmacro(use_node_addon_api)

macro(use_libnode)
  execute_process(
    COMMAND
    node -p "require('@kungfu-tech/libnode').include"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE LIBNODE_INCLUDE_DIR
  )
  string(REPLACE "\n" "" LIBNODE_INCLUDE_DIR ${LIBNODE_INCLUDE_DIR})
  string(REPLACE "\"" "" LIBNODE_INCLUDE_DIR ${LIBNODE_INCLUDE_DIR})

  execute_process(
    COMMAND
    node -p "require('@kungfu-tech/libnode').libpath"
    WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
    OUTPUT_VARIABLE LIBNODE_LIB_DIR
  )
  string(REPLACE "\n" "" LIBNODE_LIB_DIR ${LIBNODE_LIB_DIR})
  string(REPLACE "\"" "" LIBNODE_LIB_DIR ${LIBNODE_LIB_DIR})

  message(STATUS "Include libnode headers from ${LIBNODE_INCLUDE_DIR}")

  include_directories(${LIBNODE_INCLUDE_DIR})
  link_directories(${LIBNODE_LIB_DIR})

  if (WIN32)
    set(LIBNODE "libnode")
  else()
    set(LIBNODE "node")
  endif()
endmacro(use_libnode)

macro(build_node_binding BINDING_NAME BINDING_SOURCE_FILES)
  message(STATUS "Configuring for node binding ${BINDING_NAME}")
  add_library(${BINDING_NAME} SHARED ${BINDING_SOURCE_FILES})
  set_target_properties(${BINDING_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
  # optional link libs passed as ${ARGN}
  target_link_libraries(${BINDING_NAME} ${LIBKUNGFU_NAME} ${CMAKE_JS_LIB} ${ARGN})
  if (WIN32)
    # /DELAYLOAD:NODE.EXE needs the delay-load helper (__delayLoadHelper2) from delayimp.lib;
    # without it the electron-runtime binding (drone.node) fails to link (LNK2001).
    target_link_libraries(${BINDING_NAME} delayimp)
  endif ()
endmacro(build_node_binding)
