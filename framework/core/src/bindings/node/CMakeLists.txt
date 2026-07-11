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

if (KF_NODE_BINDING_NAME)
  build_node_binding(${KF_NODE_BINDING_NAME} "${SOURCE_FILES_KUNGFU_NODE}")
endif ()

if ("${KF_NODE_BINDING_NAME}" STREQUAL "kungfu_node")
  build_node_binding(drone "${SOURCE_FILES_DRONE}")
endif ()

if ("${NODE_RUNTIME}" STREQUAL "node" AND UNIX AND NOT APPLE)
  build_node_binding(kungfu_kfc "${SOURCE_FILES_KUNGFU_NODE}" ${LIBNODE})
  add_dependencies(kungfu_kfc kungfu_node)
endif ()

if (NOT KF_NODE_BINDING_NAME)
  message(WARNING "Unknown node runtime ${NODE_RUNTIME}")
endif ()

# Python-free node launcher (ADR-0046 stage 3): a standalone shared library — not
# a napi addon — exposing one C entry over node::Start so the trunk front door can
# run the KUNGFU_AS_VARIANT=node variant without booting CPython. Built once, for
# the node runtime; it links libnode directly and inherits the core's global
# @loader_path/$ORIGIN rpath (compiler.cmake) to resolve the sibling libnode.
# Windows loading is a trunk-side follow-up (the trunk only dlopens it on unix
# today), so the launcher itself is unix-only until then.
if ("${NODE_RUNTIME}" STREQUAL "node" AND UNIX)
  message(STATUS "Configuring for node launcher kungfu_node_host")
  add_library(kungfu_node_host SHARED host/kungfu_node_host.cpp)
  set_target_properties(kungfu_node_host PROPERTIES CXX_VISIBILITY_PRESET hidden)
  target_link_libraries(kungfu_node_host ${LIBNODE})
endif ()
