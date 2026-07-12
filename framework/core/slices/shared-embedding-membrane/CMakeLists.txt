# SPDX-License-Identifier: Apache-2.0

add_library(shared_embedding_native_kfx MODULE native_kfx.cpp)
target_include_directories(shared_embedding_native_kfx PRIVATE ../../src/libkungfu/include)
target_compile_options(shared_embedding_native_kfx PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
# The repository-wide link_libraries(CONAN_LIBS) predates this thin module and
# would otherwise pull static dependency state across the plugin boundary.  The
# native KFX consumer intentionally depends only on the versioned C table that
# the host passes at entry.
set_property(TARGET shared_embedding_native_kfx PROPERTY LINK_LIBRARIES "")
get_target_property(_shared_embedding_native_kfx_links shared_embedding_native_kfx LINK_LIBRARIES)
if (_shared_embedding_native_kfx_links)
  message(FATAL_ERROR "shared_embedding_native_kfx must not link core or Conan libraries")
endif()
set_target_properties(shared_embedding_native_kfx PROPERTIES
  PREFIX ""
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)

add_executable(shared_embedding_host host.cpp)
target_include_directories(shared_embedding_host PRIVATE ../../src/libkungfu/include)
target_compile_options(shared_embedding_host PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(shared_embedding_host PRIVATE ${LIBKUNGFU_NAME} ${CMAKE_DL_LIBS})
