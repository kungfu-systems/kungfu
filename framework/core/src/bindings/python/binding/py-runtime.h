// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/30.
//

#ifndef KUNGFU_PY_RUNTIME_HPP
#define KUNGFU_PY_RUNTIME_HPP

#include <pybind11/pybind11.h>

namespace kungfu::runtime {

void bind(pybind11::module &&m);

} // namespace kungfu::runtime

#endif // KUNGFU_PY_RUNTIME_HPP