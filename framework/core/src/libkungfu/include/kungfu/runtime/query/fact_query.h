// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
#define KUNGFU_RUNTIME_QUERY_FACT_QUERY_H

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::query {

inline constexpr const char *QUERY_DEFINITION_SCHEMA_V1 = "kungfu.query.definition/v1";
inline constexpr const char *LOGICAL_PLAN_SCHEMA_V1 = "kungfu.query.logical-plan/v1";
inline constexpr const char *QUERY_RESULT_SCHEMA_V1 = "kungfu.query.result/v1";
inline constexpr const char *QUERY_LINEAGE_SCHEMA_V1 = "kungfu.query.lineage/v1";
inline constexpr const char *QUERY_RESULT_ROW_SCHEMA_V1 = "kungfu.query.episode-row/v1";
inline constexpr const char *QUERY_CAPABILITIES_SCHEMA_V1 = "kungfu.query.capabilities/v1";
inline constexpr const char *QUERY_VALIDATION_SCHEMA_V1 = "kungfu.query.validation/v1";
inline constexpr const char *QUERY_EXPLAIN_SCHEMA_V1 = "kungfu.query.explain/v1";

enum class cut_kind { Head, ManifestFrameUid };

enum class admission_outcome {
  Admitted,
  UnregisteredSurface,
  IncompatibleSchema,
  AmbiguousAuthority,
  Unverifiable,
};

struct declaration_reference {
  std::string id = {};
  std::string version = {};
  std::string root = {};
};

struct admission_evidence {
  admission_outcome outcome = admission_outcome::Unverifiable;
  std::string fact_surface_id = {};
  uint64_t record_count = 0;
  std::string reason = {};
};

struct cut {
  cut_kind kind = cut_kind::Head;
  uint64_t manifest_frame_uid = 0;
};

struct query_policy {
  std::string fold = "episode-manifest-fold/v1";
  std::string schema = "kungfu.episode.manifest/v1";
  std::string engine = "episode-authority-scan/v1";
  std::string conflict = "preserve-source-claims/v1";
  std::string redaction = "report-missing-evidence/v1";
};

// ADR-0048 Q0: the result is unique only under this declared basis. These are
// C++-owned semantic fields; bindings translate edge JSON but do not infer a
// second basis.
struct query_basis {
  declaration_reference contract_world = {};
  std::vector<declaration_reference> fact_surfaces = {};
  std::string scope = "episode-manifest";
  uint64_t episode_id = 0;
  std::string perspective = "manifest-append-order";
  cut selected_cut = {};
  query_policy policy = {};
  std::string valid_time = "not-projected";
  std::string system_time = "manifest-gen-time";
  std::string causal_time = "manifest-order-and-episode-refs";
};

struct query_definition {
  std::string schema = QUERY_DEFINITION_SCHEMA_V1;
  query_basis basis = {};
  std::string object = "episodes";
  uint64_t limit = 100;
  std::string evidence = "proof";
};

struct result_field {
  std::string name = {};
  std::string type = {};
  bool nullable = false;
};

struct result_schema {
  std::string schema = QUERY_RESULT_ROW_SCHEMA_V1;
  std::vector<result_field> fields = {};
};

struct logical_operator {
  std::string kind = {};
  nlohmann::json arguments = nlohmann::json::object();
};

// ADR-0048 Q1: frontends normalize into this public semantic contract. The
// authority-scan implementation consumes the plan; physical execution choices
// remain private and replaceable.
struct logical_plan {
  std::string schema = LOGICAL_PLAN_SCHEMA_V1;
  query_definition definition = {};
  std::vector<logical_operator> operators = {};
  result_schema row_schema = {};
  std::string query_definition_hash = {};
  std::string logical_plan_hash = {};
};

struct lineage {
  std::string schema = QUERY_LINEAGE_SCHEMA_V1;
  nlohmann::json authority = nlohmann::json::object();
  nlohmann::json cut = nlohmann::json::object();
  nlohmann::json policy_versions = nlohmann::json::object();
  nlohmann::json time_basis = nlohmann::json::object();
  std::string determinism = "deterministic";
  bool canonical_state = false;
  declaration_reference contract_world_declaration = {};
  std::vector<declaration_reference> fact_surface_declarations = {};
  std::vector<admission_evidence> admission_outcomes = {};
  std::vector<nlohmann::json> episode_content_roots = {};
  std::vector<nlohmann::json> missing_inputs = {};
  std::vector<nlohmann::json> unverifiable_inputs = {};
  std::string query_definition_hash = {};
  std::string logical_plan_hash = {};
};

struct query_result {
  std::string schema = QUERY_RESULT_SCHEMA_V1;
  query_definition definition = {};
  logical_plan plan = {};
  result_schema row_schema = {};
  std::vector<nlohmann::json> rows = {};
  lineage proof = {};
  std::string result_hash = {};
};

[[nodiscard]] query_definition parse_query_definition(const nlohmann::json &value);

[[nodiscard]] nlohmann::json query_definition_json(const query_definition &definition);

[[nodiscard]] logical_plan plan_query(const query_definition &definition);

[[nodiscard]] nlohmann::json logical_plan_json(const logical_plan &plan);

[[nodiscard]] nlohmann::json query_capabilities_json();

[[nodiscard]] nlohmann::json query_definition_schema_json();

[[nodiscard]] nlohmann::json query_object_description_json(const std::string &object);

[[nodiscard]] nlohmann::json query_examples_json();

[[nodiscard]] nlohmann::json query_result_json(const query_result &result);

[[nodiscard]] query_result run_episode_authority_scan(const std::string &runtime_dir, const logical_plan &plan);

} // namespace kungfu::runtime::query

#endif // KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
