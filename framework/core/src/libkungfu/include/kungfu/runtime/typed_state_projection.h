// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H
#define KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H

#include <map>
#include <string>

#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/state_cache/model.h>

namespace kungfu::runtime::state_service {

inline constexpr const char *TYPED_STATE_PROJECTION_SCHEMA_V1 = "kungfu.typed-state-projection.v1";

struct projection_candidate_inspect_options {
  std::string data_root = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::string writer_resource_id = {};
  std::string qualification_profile = {};
  std::string projection_name = "typed-peer-state";
  peer_state_requirement requirement = peer_state_requirement::Required;
};

// Projects only the authoritative Hana StateDataTypes closed set. Unknown
// carriers are ignored; malformed known carriers fail closed.
[[nodiscard]] durable_projector make_typed_state_projector();

// Produces the same derived image from the compatibility state bank so shadow
// cutover can compare actual state semantics, not merely record counts.
[[nodiscard]] std::map<std::string, std::string> typed_state_image(const state_cache::bank &compatibility_state);

// Decodes a verified typed-state image into a staging bank and replaces the
// target only after every entry validates. Failure leaves the target untouched.
void restore_typed_state_image(const std::map<std::string, std::string> &image, state_cache::bank &target);

// Candidate hydration validates the complete image before replacing the peer
// bank. A refused/degraded candidate never changes the target.
void hydrate_projection_candidate(projection_candidate_result &result, state_cache::bank &target);

// Emits an already verified candidate image while retaining the original
// source/destination/update-time carried by the typed projection.
void emit_projection_candidate(projection_candidate_result &result, const yijinjing::journal::writer_ptr &writer);

// Read-only operator/binding surface over the same native bootstrap contract.
// It never creates a stream, rebuilds a projection, or widens eligibility.
[[nodiscard]] projection_candidate_status_view
inspect_projection_candidate(projection_candidate_inspect_options options);

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_TYPED_STATE_PROJECTION_H
