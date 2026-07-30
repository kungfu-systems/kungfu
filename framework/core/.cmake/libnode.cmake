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
  target_include_directories(${BINDING_NAME} SYSTEM PRIVATE
    ${NODE_ADDON_API_DIR} ${CMAKE_JS_INC} ${LIBNODE_INCLUDE_DIR})
  target_compile_definitions(${BINDING_NAME} PRIVATE
    NAPI_EXPERIMENTAL NAPI_VERSION=8 NODE_ADDON_API_CPP_EXCEPTIONS)
  target_compile_options(${BINDING_NAME} PRIVATE
    "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_OFF_OPTIONS}>")
  target_link_directories(${BINDING_NAME} PRIVATE ${LIBNODE_LIB_DIR})
  # optional link libs passed as ${ARGN}
  target_link_libraries(${BINDING_NAME} PRIVATE
    ${LIBKUNGFU_NAME} kungfu_compile_contract ${CMAKE_JS_LIB} ${ARGN})
  kungfu_strip_release_local_symbols(${BINDING_NAME})
  if (WIN32)
    # /DELAYLOAD:NODE.EXE needs the delay-load helper (__delayLoadHelper2) from delayimp.lib;
    # without it the electron-runtime binding (drone.node) fails to link (LNK2001).
    target_link_libraries(${BINDING_NAME} PRIVATE delayimp)
  endif ()
endmacro(build_node_binding)
