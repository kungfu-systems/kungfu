project(kungfu-node-binding-${NODE_RUNTIME})

message(STATUS "Configuring for node bindings")

use_node_addon_api()
use_libnode()

aux_source_directory(binding SOURCE_FILES_KUNGFU_NODE)
aux_source_directory(drone SOURCE_FILES_DRONE)

if ("${NODE_RUNTIME}" STREQUAL "node")
  set(KF_NODE_BINDING_NAME kungfu_node)
endif ()

if ("${NODE_RUNTIME}" STREQUAL "electron")
  set(KF_NODE_BINDING_NAME kungfu_electron)
endif ()

if ("${NODE_RUNTIME}" STREQUAL "electron" AND WIN32)
  set(KF_NODE_BINDING_NAME kungfu_node)
endif ()

if (KUNGFU_BUILD_NODE_BINDINGS AND KF_NODE_BINDING_NAME)
  if(WIN32)
    # The addon already owns one statically linked libkungfu runtime on
    # Windows. Link the public bootstrap wrapper into that same image instead
    # of loading kungfu.dll, which would create a second runtime instance.
    build_node_binding(${KF_NODE_BINDING_NAME} "${SOURCE_FILES_KUNGFU_NODE}")
    target_sources(${KF_NODE_BINDING_NAME} PRIVATE $<TARGET_OBJECTS:kungfu_abi_exports>)
  else()
    # Unix bindings and the public facade resolve through the same shared
    # kungfu_runtime image.
    build_node_binding(${KF_NODE_BINDING_NAME} "${SOURCE_FILES_KUNGFU_NODE}" ${KUNGFU_PUBLIC_ABI_TARGET})
  endif()
endif ()

if (KUNGFU_BUILD_NODE_BINDINGS AND "${KF_NODE_BINDING_NAME}" STREQUAL "kungfu_node")
  build_node_binding(drone "${SOURCE_FILES_DRONE}")
endif ()

if (KUNGFU_BUILD_NODE_BINDINGS AND "${NODE_RUNTIME}" STREQUAL "node" AND UNIX AND NOT APPLE)
  build_node_binding(kungfu_kfc "${SOURCE_FILES_KUNGFU_NODE}" ${LIBNODE})
  add_dependencies(kungfu_kfc kungfu_node)
endif ()

if (KUNGFU_BUILD_NODE_BINDINGS AND NOT KF_NODE_BINDING_NAME)
  message(WARNING "Unknown node runtime ${NODE_RUNTIME}")
endif ()

# Python-free node launcher (ADR-0046 stage 3): a standalone shared library — not
# a napi addon — exposing one C entry over node::Start so the trunk front door can
# run the KUNGFU_AS_VARIANT=node variant without booting CPython. Built once, for
# the node runtime; it links libnode directly and inherits the core's global
# @loader_path/$ORIGIN rpath (compiler.cmake) to resolve the sibling libnode.
#
# Built on unix (.dylib/.so) and Windows (kungfu_node_host.dll — MSVC gives a
# SHARED lib no `lib` prefix). The host is an embedder, so on Windows it links the
# real libnode import lib (${LIBNODE}=libnode -> libnode.lib in LIBNODE_LIB_DIR),
# not a delay-loaded node.exe like the napi addons — no delayimp needed. The C
# entry is __declspec(dllexport)-ready (host/kungfu_node_host.cpp), the strip is
# unix-guarded, and CXX_VISIBILITY_PRESET is a no-op under MSVC, so the body is
# portable as-is. The trunk loads it via LoadLibraryW on Windows (variant.rs); at
# load time Windows resolves the sibling libnode.dll from the exe directory.
if ("${NODE_RUNTIME}" STREQUAL "node" AND (UNIX OR WIN32))
  message(STATUS "Configuring for node launcher kungfu_node_host")
  add_library(kungfu_node_host SHARED host/kungfu_node_host.cpp)
  set_target_properties(kungfu_node_host PROPERTIES CXX_VISIBILITY_PRESET hidden)
  target_include_directories(kungfu_node_host SYSTEM PRIVATE ${LIBNODE_INCLUDE_DIR})
  target_compile_options(kungfu_node_host PRIVATE
    "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_OFF_OPTIONS}>")
  target_link_directories(kungfu_node_host PRIVATE ${LIBNODE_LIB_DIR})
  target_link_libraries(kungfu_node_host PRIVATE ${LIBNODE} kungfu_compile_contract)
  kungfu_strip_release_local_symbols(kungfu_node_host)
endif ()
