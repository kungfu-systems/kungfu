// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_ACTION_GEOMETRY_H
#define KUNGFU_RUNTIME_ACTION_ACTION_GEOMETRY_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

inline constexpr const char *ACTION_GEOMETRY_SURFACE = "action-geometry";
inline constexpr const char *ACTION_GEOMETRY_EVALUATION_V1 = "kungfu.action-geometry.evaluation/v1";
inline constexpr const char *ACTION_GEOMETRY_SESSION_EVALUATION_V1 = "kungfu.action-geometry.session-evaluation/v1";

// Versioned KFD-7 Action Geometry evaluator without adopter-domain policy. These
// are contract-driven pure functions: the responsibility topology, invariants,
// and session dimensions come from the welded action-geometry contract resolved
// through the existing registry; no Agent Work field names or lifecycle vocabulary
// appear here (KF-ADR-019f86da-4f90-77c0-827b-fe1a3aa43e2b eligibility). Behavior is a byte/field faithful port of
// kungfu.agent.action_geometry.

// The welded contract's geometryRoot ("sha256:...") over its raw artifact bytes.
[[nodiscard]] std::string action_geometry_root(const std::string &search_base = {});

// Evaluate responsibility topology, identity aliasing, and non-substitution
// invariants. responsibility_ids maps responsibility name -> identity string;
// inference_claims is an array of claim strings. Returns the evaluation object.
[[nodiscard]] nlohmann::json evaluate_action_geometry(const nlohmann::json &responsibility_ids,
                                                      const nlohmann::json &inference_claims,
                                                      const std::string &search_base = {});

// Check the geometry's conservative session round-trip dimensions between two
// session projections. Returns the session-evaluation object.
[[nodiscard]] nlohmann::json evaluate_session_refinement(const nlohmann::json &before, const nlohmann::json &after,
                                                         const std::string &search_base = {});

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_ACTION_GEOMETRY_H
