project(kungfu-python-binding)

set(KF_PYTHON_BINDING_NAME pykungfu)
message(STATUS "Configuring for python binding ${KF_PYTHON_BINDING_NAME}")

use_libnode()

aux_source_directory(binding SOURCE_FILES_PYKUNGFU)
pybind11_add_module(${KF_PYTHON_BINDING_NAME} SHARED ${SOURCE_FILES_PYKUNGFU})
target_include_directories(${KF_PYTHON_BINDING_NAME} SYSTEM PRIVATE ${LIBNODE_INCLUDE_DIR})
target_compile_options(${KF_PYTHON_BINDING_NAME} PRIVATE
  "$<$<CONFIG:Release>:${COMPILER_OPTIMIZE_OFF_OPTIONS}>")
target_link_directories(${KF_PYTHON_BINDING_NAME} PRIVATE ${LIBNODE_LIB_DIR})
target_link_libraries(${KF_PYTHON_BINDING_NAME} PRIVATE
  ${LIBNODE} kungfu kungfu_compile_contract)
kungfu_strip_release_local_symbols(${KF_PYTHON_BINDING_NAME})
