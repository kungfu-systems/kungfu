// SPDX-License-Identifier: Apache-2.0

#include "py-libnode.h"
#include "py-longfist.h"
#include "py-runtime.h"

namespace py = pybind11;

PYBIND11_MODULE(pykungfu, m) {
  kungfu::libnode::bind(m.def_submodule("libnode"));
  kungfu::longfist::bind(m.def_submodule("longfist"));
  kungfu::runtime::bind(m.def_submodule("runtime"));
}
