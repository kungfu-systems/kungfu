// SPDX-License-Identifier: Apache-2.0

#include "py-yijinjing.h"

namespace kungfu::yijinjing {
void bind(pybind11::module &&m) {
  pybind::bind_enums(m);
  pybind::bind_types(m);
}
} // namespace kungfu::yijinjing
