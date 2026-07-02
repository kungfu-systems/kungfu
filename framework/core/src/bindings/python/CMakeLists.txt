project(kungfu-python-binding)

set(KF_PYTHON_BINDING_NAME pykungfu)
message(STATUS "Configuring for python binding ${KF_PYTHON_BINDING_NAME}")

use_libnode()

aux_source_directory(binding SOURCE_FILES_PYKUNGFU)
# tracing-foundation Phase 1: 交易语义(book/broker/strategy/operator/...)移出编译流程;
# 保留 py-wingchun.cpp + py-wingchun-utils.cpp —— 仅暴露 header-only 的 instrument utils
# (get_instrument_type/hash_instrument/is_valid_price 等,common.h inline),Python 层 kungfu/wingchun 需用。
list(FILTER SOURCE_FILES_PYKUNGFU EXCLUDE REGEX "py-wingchun-(book|broker|factor|map|operator|orderbook|service|strategy|streamdatabatcher|tool)")
pybind11_add_module(${KF_PYTHON_BINDING_NAME} SHARED ${SOURCE_FILES_PYKUNGFU})
# wingchun_headers: py-wingchun/py-wingchun-utils 用的 header-only instrument utils
# 来自休眠模块 src/libwingchun 的 include 面
target_link_libraries(${KF_PYTHON_BINDING_NAME} PRIVATE ${LIBNODE} kungfu wingchun_headers)
