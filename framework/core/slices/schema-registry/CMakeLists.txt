# SPDX-License-Identifier: Apache-2.0
#
# Schema-registry slice: proves "decodable without the runtime that wrote it".
#
#   schema_registry_producer  writes FB + Json events and emits the bundle's
#                             format pieces (content-addressed .bfbs blobs +
#                             manifest schema bindings); owns generated code
#   schema_registry_decoder   decodes the journal from the bundle alone via
#                             FlatBuffers runtime reflection; links NO
#                             generated code and NO longfist type registry
#
# The two demo schemas (v1, v2-adds-a-field) are compiled at build time by the
# conan-provided flatc, into the build tree: --cpp for the producer only,
# -b --schema (.bfbs) as the artifact the bundle carries.

project(schema_registry_slice)

set(SR_GEN_DIR ${CMAKE_CURRENT_BINARY_DIR}/generated)
file(MAKE_DIRECTORY ${SR_GEN_DIR})

foreach(_v v1 v2)
  add_custom_command(
    OUTPUT ${SR_GEN_DIR}/demo_${_v}_generated.h ${SR_GEN_DIR}/demo_${_v}.bfbs
    COMMAND flatbuffers::flatc --cpp --scoped-enums -o ${SR_GEN_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/demo_${_v}.fbs
    COMMAND flatbuffers::flatc -b --schema -o ${SR_GEN_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/demo_${_v}.fbs
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/demo_${_v}.fbs
    COMMENT "flatc: demo_${_v}.fbs -> generated header + bfbs"
    VERBATIM)
endforeach()

add_custom_target(schema_registry_codegen DEPENDS
  ${SR_GEN_DIR}/demo_v1_generated.h ${SR_GEN_DIR}/demo_v1.bfbs
  ${SR_GEN_DIR}/demo_v2_generated.h ${SR_GEN_DIR}/demo_v2.bfbs)

add_executable(schema_registry_producer producer.cpp)
add_dependencies(schema_registry_producer schema_registry_codegen)
target_include_directories(schema_registry_producer PRIVATE ${SR_GEN_DIR})
target_link_libraries(schema_registry_producer yijinjing flatbuffers::flatbuffers)

add_executable(schema_registry_decoder decoder.cpp)
target_link_libraries(schema_registry_decoder yijinjing flatbuffers::flatbuffers)
