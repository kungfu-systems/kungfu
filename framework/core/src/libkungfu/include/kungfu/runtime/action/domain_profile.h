// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_ACTION_DOMAIN_PROFILE_H
#define KUNGFU_RUNTIME_ACTION_DOMAIN_PROFILE_H

#include <string>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::action {

inline constexpr const char *AGENT_WORK_DOMAIN_PROFILE_SURFACE = "agent-work-domain-profile";
inline constexpr const char *LEGACY_ROLE_BODY_SCHEMA = "kungfu.kfd7.profile-role/v1";

// KFD-7 Agent Work Domain Profile authority ported byte/field faithfully from
// kungfu.agent.domain_profile. The welded domain-profile contract, the
// action-geometry root it pins, and each role schema are resolved through the
// existing registry (see action_contract_registry). Role bodies are validated by
// a fail-closed JSON Schema subset validator (kfd7-role-schema-subset/v1): any
// role schema keyword outside the declared subset is rejected at load time
// rather than silently ignored, returning authority to an explicit architecture
// decision instead of drifting from the Python jsonschema authority.

// Resolve and verify the domain profile's contract roots. Validates that the
// welded action-geometry contract root matches the domain profile's pinned root,
// then loads every role schema (verifying each raw-byte root). Returns
// {actionGeometryRoot, domainProfileRoot, roleSchemaRoots}.
[[nodiscard]] nlohmann::json domain_profile_roots(const std::string &search_base = {});

// The declared role body schema id for a role (contract roleSchemas[role].schema).
[[nodiscard]] std::string role_schema_id(const std::string &role, const std::string &search_base = {});

// The exact contract roots a role body must bind:
// {actionGeometryRoot, domainProfileRoot, roleSchemaRoot}.
[[nodiscard]] nlohmann::json role_bindings(const std::string &role, const std::string &search_base = {});

// Validate an Agent Work role body against its declared role schema. Legacy
// bodies (schema == LEGACY_ROLE_BODY_SCHEMA) are accepted structurally when
// allow_legacy is set. On success returns {role, legacy, [bindings]}; on failure
// throws std::runtime_error with a message byte-faithful to the Python authority.
[[nodiscard]] nlohmann::json validate_role_body(const nlohmann::json &body, bool allow_legacy = true,
                                                const std::string &search_base = {});

} // namespace kungfu::runtime::action

#endif // KUNGFU_RUNTIME_ACTION_DOMAIN_PROFILE_H
