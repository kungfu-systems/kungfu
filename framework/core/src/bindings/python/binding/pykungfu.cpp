// SPDX-License-Identifier: Apache-2.0

#include "py-libnode.h"
#include "py-runtime.h"
#include "py-yijinjing.h"

namespace py = pybind11;

PYBIND11_MODULE(pykungfu, m) {
  kungfu::libnode::bind(m.def_submodule("libnode"));
  kungfu::yijinjing::bind(m.def_submodule("yijinjing"));
  kungfu::runtime::bind(m.def_submodule("runtime"));
}
