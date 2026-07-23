// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/1/30.
//

#ifndef KUNGFU_PY_YIJINJING_HPP
#define KUNGFU_PY_YIJINJING_HPP

#include <pybind11/pybind11.h>

namespace kungfu::yijinjing {

void bind(pybind11::module &&m);

} // namespace kungfu::yijinjing

namespace kungfu::yijinjing::pybind {

void bind_types(pybind11::module &m);

void bind_enums(pybind11::module &m);

} // namespace kungfu::yijinjing::pybind

#endif // KUNGFU_PY_YIJINJING_HPP
