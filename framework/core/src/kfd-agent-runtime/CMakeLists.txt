# SPDX-License-Identifier: Apache-2.0

add_executable(kungfu-kfd-agent-runtime
  main.cpp
)
target_compile_features(kungfu-kfd-agent-runtime PRIVATE cxx_std_20)
target_compile_options(kungfu-kfd-agent-runtime PRIVATE
  $<$<CONFIG:Release>:${COMPILER_OPTIMIZE_ON_OPTIONS}>)
target_link_libraries(kungfu-kfd-agent-runtime PRIVATE
  ${LIBKUNGFU_NAME}
  nlohmann_json::nlohmann_json
)
set_target_properties(kungfu-kfd-agent-runtime PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${KUNGFU_BUILD_DIR}"
)
if(APPLE)
  set_target_properties(kungfu-kfd-agent-runtime PROPERTIES
    BUILD_RPATH "@loader_path;@loader_path/${CMAKE_BUILD_TYPE}")
elseif(UNIX)
  set_target_properties(kungfu-kfd-agent-runtime PROPERTIES
    BUILD_RPATH "$ORIGIN;$ORIGIN/${CMAKE_BUILD_TYPE}")
endif()
