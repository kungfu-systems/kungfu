// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H
#define KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H

#include <map>
#include <string>

#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/state_cache/model.h>

namespace kungfu::runtime::state_service {

inline constexpr const char *TYPED_STATE_PROJECTION_SCHEMA_V1 = "kungfu.typed-state-projection.v1";

// Projects only the authoritative Hana StateDataTypes closed set. Unknown
// carriers are ignored; malformed known carriers fail closed.
[[nodiscard]] durable_projector make_typed_state_projector();

// Produces the same derived image from the compatibility state bank so shadow
// cutover can compare actual state semantics, not merely record counts.
[[nodiscard]] std::map<std::string, std::string> typed_state_image(const state_cache::bank &compatibility_state);

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H
