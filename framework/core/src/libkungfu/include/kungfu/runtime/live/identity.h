// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_LIVE_IDENTITY_H
#define KUNGFU_RUNTIME_LIVE_IDENTITY_H

#include <string>

namespace kungfu::runtime::live {

// The coordinator is the canonical runtime concept.  Its location identity is
// deliberately kept on the historic v1 value so existing journals, RocksDB
// state and nanomsg endpoints remain readable without an in-place migration.
inline constexpr char COORDINATOR_WIRE_NAMESPACE[] = "master";
inline constexpr char COORDINATOR_WIRE_NAME[] = "master";

[[nodiscard]] inline bool is_coordinator_wire_namespace(const std::string &namespace_) {
  return namespace_ == COORDINATOR_WIRE_NAMESPACE;
}

} // namespace kungfu::runtime::live

#endif // KUNGFU_RUNTIME_LIVE_IDENTITY_H
