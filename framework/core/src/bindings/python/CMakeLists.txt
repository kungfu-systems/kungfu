project(kungfu-python-binding)

set(KF_PYTHON_BINDING_NAME pykungfu)
message(STATUS "Configuring for python binding ${KF_PYTHON_BINDING_NAME}")

use_libnode()

aux_source_directory(binding SOURCE_FILES_PYKUNGFU)
pybind11_add_module(${KF_PYTHON_BINDING_NAME} SHARED ${SOURCE_FILES_PYKUNGFU})
target_link_libraries(${KF_PYTHON_BINDING_NAME} PRIVATE ${LIBNODE} kungfu)
