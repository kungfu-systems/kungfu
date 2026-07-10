# SPDX-License-Identifier: Apache-2.0

add_library(shared_embedding_native_kfx MODULE native_kfx.cpp)
target_include_directories(shared_embedding_native_kfx PRIVATE ../../src/libkungfu/include)
set_target_properties(shared_embedding_native_kfx PROPERTIES PREFIX "")

add_executable(shared_embedding_host host.cpp)
target_include_directories(shared_embedding_host PRIVATE ../../src/libkungfu/include)
target_link_libraries(shared_embedding_host PRIVATE ${LIBKUNGFU_NAME} ${CMAKE_DL_LIBS})
