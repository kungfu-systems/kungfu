// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
#define KUNGFU_RUNTIME_QUERY_FACT_QUERY_H

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::query {

inline constexpr const char *QUERY_DEFINITION_SCHEMA_V1 = "kungfu.query.definition/v1";
inline constexpr const char *LOGICAL_PLAN_SCHEMA_V1 = "kungfu.query.logical-plan/v1";
inline constexpr const char *QUERY_RESULT_SCHEMA_V1 = "kungfu.query.result/v1";
inline constexpr const char *QUERY_LINEAGE_SCHEMA_V1 = "kungfu.query.lineage/v1";
inline constexpr const char *QUERY_RESULT_ROW_SCHEMA_V1 = "kungfu.query.episode-row/v1";
inline constexpr const char *QUERY_FACT_STATE_ROW_SCHEMA_V1 = "kungfu.query.fact-state-row/v1";
inline constexpr const char *QUERY_CAPABILITIES_SCHEMA_V1 = "kungfu.query.capabilities/v1";
inline constexpr const char *QUERY_VALIDATION_SCHEMA_V1 = "kungfu.query.validation/v1";
inline constexpr const char *QUERY_EXPLAIN_SCHEMA_V1 = "kungfu.query.explain/v1";
inline constexpr const char *QUERY_CHANGELOG_SCHEMA_V1 = "kungfu.query.changelog/v1";
inline constexpr const char *QUERY_RESUME_TOKEN_SCHEMA_V1 = "kungfu.query.resume-token/v1";
inline constexpr const char *QUERY_VIEW_SCHEMA_V1 = "kungfu.query.saved-view/v1";
inline constexpr const char *QUERY_TEMPORAL_PATTERN_SCHEMA_V1 = "kungfu.query.temporal-pattern/v1";
inline constexpr const char *QUERY_TEMPORAL_MATCH_ROW_SCHEMA_V1 = "kungfu.query.temporal-match-row/v1";

enum class cut_kind { Head, ManifestFrameUid, SystemTime };

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
  int64_t system_time = 0;
};

struct query_policy {
  std::string fold = "episode-manifest-fold/v1";
  std::string schema = "kungfu.episode.manifest/v1";
  std::string engine = "episode-authority-scan/v1";
  std::string conflict = "preserve-source-claims/v1";
  std::string redaction = "report-missing-evidence/v1";
};

// KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 Q0: the result is unique only under this declared basis. These are
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

struct event_predicate {
  std::string field = {};
  std::string equals = {};
};

// Q4 deliberately admits one bounded pattern family. Events are partitioned,
// ordered on one declared time field, matched as a repeated two-step sequence,
// and optionally suppressed when a terminal event is present by as_of_time.
// This is enough to qualify attention churn without introducing an EPL root.
struct temporal_pattern {
  std::string schema = QUERY_TEMPORAL_PATTERN_SCHEMA_V1;
  std::string partition_by = "source";
  std::string order_by = "begin_time";
  std::vector<event_predicate> sequence = {};
  uint64_t repeat_min = 1;
  uint64_t repeat_max = 1;
  uint64_t within_ns = 0;
  int64_t as_of_time = 0;
  bool has_absence = false;
  event_predicate absence = {};
};

struct query_definition {
  std::string schema = QUERY_DEFINITION_SCHEMA_V1;
  query_basis basis = {};
  std::string object = "episodes";
  std::vector<std::string> subject_keys = {};
  uint64_t limit = 100;
  std::string evidence = "proof";
  bool has_temporal_pattern = false;
  temporal_pattern pattern = {};
};

struct result_field {
  std::string name = {};
  std::string type = {};
  bool nullable = false;
  bool externally_declared = true;
};

struct result_schema {
  std::string schema = QUERY_RESULT_ROW_SCHEMA_V1;
  std::vector<result_field> fields = {};
};

// Query rows are open and schema-driven, but they are not unvalidated JSON
// bags. Values cross the JSON edge once, then remain aligned positionally with
// result_schema until rendered back to the public façade.
struct query_value;
using query_array = std::vector<query_value>;
using query_object = std::map<std::string, query_value>;
struct missing_value {
  bool operator==(const missing_value &) const = default;
};

struct query_value {
  using storage = std::variant<missing_value, std::nullptr_t, bool, int64_t, uint64_t, double, std::string, query_array,
                               query_object>;
  storage data = missing_value{};

  query_value() = default;
  query_value(missing_value value) : data(value) {}
  query_value(std::nullptr_t) : data(nullptr) {}
  query_value(bool value) : data(value) {}
  query_value(int64_t value) : data(value) {}
  query_value(uint64_t value) : data(value) {}
  query_value(double value) : data(value) {}
  query_value(std::string value) : data(std::move(value)) {}
  query_value(const char *value) : data(std::string(value)) {}
  query_value(query_array value) : data(std::move(value)) {}
  query_value(query_object value) : data(std::move(value)) {}

  bool operator==(const query_value &) const = default;
};

struct dynamic_row {
  std::vector<query_value> values = {};
  bool operator==(const dynamic_row &) const = default;
};

struct authority_scan_operator {
  std::string object = {};
  query_basis basis = {};
};

struct scalar_filter_operator {
  std::string field = {};
  std::string operation = "eq";
  std::string value = {};
};

struct set_filter_operator {
  std::string field = {};
  std::string operation = "in";
  std::vector<std::string> values = {};
};

struct order_operator {
  std::string field = {};
  std::string direction = "asc";
};

struct limit_operator {
  uint64_t count = 0;
};

struct project_operator {
  result_schema schema = {};
};

struct evidence_operator {
  std::string level = "proof";
};

using logical_operator_arguments =
    std::variant<authority_scan_operator, scalar_filter_operator, set_filter_operator, temporal_pattern, order_operator,
                 limit_operator, project_operator, evidence_operator>;

struct logical_operator {
  std::string kind = {};
  logical_operator_arguments arguments = authority_scan_operator{};
};

// KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 Q1: frontends normalize into this public semantic contract. The
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

struct episode_authority {
  std::string kind = "yijinjing-journal";
  std::string schema = {};
  uint64_t first_manifest_frame_uid = 0;
  uint64_t last_manifest_frame_uid = 0;
  uint64_t record_count = 0;
  uint64_t unknown_record_count = 0;
  uint64_t unfolded_record_count = 0;
};

struct fact_authority {
  std::string kind = "yijinjing-journal";
  std::string schema = {};
  uint64_t record_count = 0;
  uint64_t selected_observation_count = 0;
};

using query_authority = std::variant<episode_authority, fact_authority>;

enum class resolved_cut_kind { Empty, Head, ManifestFrameUid, SystemTime, Unresolved };

struct resolved_query_cut {
  resolved_cut_kind kind = resolved_cut_kind::Empty;
  uint64_t manifest_frame_uid = 0;
  int64_t system_time = 0;
};

struct query_cut_proof {
  cut declared = {};
  resolved_query_cut resolved = {};
  bool inclusive = true;
};

struct query_time_basis {
  std::string valid_time = {};
  std::string system_time = {};
  std::string causal_time = {};
};

struct query_execution {
  std::string engine = {};
  std::string source = {};
  bool has_projection = false;
  bool projection_verified = false;
  std::string projection_status = {};
  std::string projection_schema = {};
  bool has_temporal_pattern = false;
  temporal_pattern pattern = {};
  uint64_t pattern_input_rows = 0;
};

struct nullable_value {
  bool present = false;
  std::optional<query_value> value = {};
};

struct episode_content_root {
  uint64_t episode_id = 0;
  std::string status = {};
  nullable_value recorded = {};
  nullable_value computed = {};
};

struct missing_manifest_cut {
  uint64_t manifest_frame_uid = 0;
};
struct missing_temporal_window {
  std::string partition_key = {};
  int64_t required_through = 0;
  int64_t observed_through = 0;
};
struct missing_temporal_input_limit {
  uint64_t limit = 0;
  uint64_t available = 0;
};
struct missing_episode {
  uint64_t episode_id = 0;
};
struct missing_fact_state_result_limit {
  uint64_t available = 0;
  uint64_t limit = 0;
};
using missing_input = std::variant<missing_manifest_cut, missing_temporal_window, missing_temporal_input_limit,
                                   missing_episode, missing_fact_state_result_limit>;

struct unverifiable_temporal_input {
  std::string episode_id = {};
  std::string reason = {};
};
struct unverifiable_declaration_basis {
  admission_outcome outcome = admission_outcome::Unverifiable;
  std::string reason = {};
};
enum class unverifiable_record_kind { ManifestUnknown, ManifestUnfolded };
struct unverifiable_record_count {
  unverifiable_record_kind kind = unverifiable_record_kind::ManifestUnknown;
  uint64_t count = 0;
};
struct unverifiable_contract_world {
  std::string id = {};
  std::string reason = {};
};
struct unverifiable_fact_episode_root {
  uint64_t episode_id = 0;
};
using unverifiable_input =
    std::variant<unverifiable_temporal_input, unverifiable_declaration_basis, unverifiable_record_count,
                 unverifiable_contract_world, unverifiable_fact_episode_root>;

struct query_conflict {
  std::string subject_key = {};
  std::vector<std::string> observation_ids = {};
  std::vector<std::string> source_ids = {};
};

struct lineage {
  std::string schema = QUERY_LINEAGE_SCHEMA_V1;
  query_authority authority = episode_authority{};
  query_cut_proof cut = {};
  query_policy policy_versions = {};
  query_time_basis time_basis = {};
  query_execution execution = {};
  std::string determinism = "deterministic";
  bool canonical_state = false;
  declaration_reference contract_world_declaration = {};
  std::vector<declaration_reference> fact_surface_declarations = {};
  std::vector<admission_evidence> admission_outcomes = {};
  std::vector<episode_content_root> episode_content_roots = {};
  std::vector<missing_input> missing_inputs = {};
  std::vector<unverifiable_input> unverifiable_inputs = {};
  std::vector<query_conflict> conflicts = {};
  std::string query_definition_hash = {};
  std::string logical_plan_hash = {};
};

struct query_result {
  std::string schema = QUERY_RESULT_SCHEMA_V1;
  query_definition definition = {};
  logical_plan plan = {};
  result_schema row_schema = {};
  std::vector<dynamic_row> rows = {};
  lineage proof = {};
  std::string result_hash = {};
};

enum class frontier_kind { Empty, ManifestFrameUid, SystemTime };

struct query_frontier {
  frontier_kind kind = frontier_kind::Empty;
  uint64_t manifest_frame_uid = 0;
  int64_t system_time = 0;
  uint64_t record_count = 0;
};

// A resume token names both ends of one deterministic changelog batch. A
// reconnect re-runs those exact cuts and verifies their result hashes before
// continuing at next_message_index; no GUI cache or server-side cursor owns
// query truth.
struct query_resume_token {
  std::string schema = QUERY_RESUME_TOKEN_SCHEMA_V1;
  query_definition definition = {};
  std::string query_definition_hash = {};
  std::string logical_plan_hash = {};
  query_frontier from = {};
  std::string from_result_hash = {};
  query_frontier target = {};
  std::string target_result_hash = {};
  uint64_t next_message_index = 0;
  std::string batch_id = {};
  std::string token_hash = {};
};

struct snapshot_begin {
  query_basis basis = {};
  result_schema schema = {};
};

struct row_upsert {
  std::string key = {};
  result_schema schema = {};
  dynamic_row row = {};
  nlohmann::json evidence_ref = nlohmann::json::object();
};

struct row_retract {
  std::string key = {};
  std::string before_hash = {};
  nlohmann::json evidence_ref = nlohmann::json::object();
};

struct progress {
  query_frontier frontier = {};
  nlohmann::json watermark = nlohmann::json::object();
};

struct schema_change {
  result_schema old_schema = {};
  result_schema new_schema = {};
  std::string compatibility = "unknown";
};

struct snapshot_end {
  std::string result_hash = {};
  query_frontier frontier = {};
};

struct gap {
  nlohmann::json expected = nlohmann::json::object();
  nlohmann::json observed = nlohmann::json::object();
  std::string recovery_hint = "request-full-snapshot";
};

using changelog_payload =
    std::variant<snapshot_begin, row_upsert, row_retract, progress, schema_change, snapshot_end, gap>;

struct changelog_message {
  std::string message_id = {};
  uint64_t index = 0;
  changelog_payload payload = snapshot_begin{};
};

struct changelog_page {
  std::string schema = QUERY_CHANGELOG_SCHEMA_V1;
  std::string batch_id = {};
  std::vector<changelog_message> messages = {};
  query_resume_token resume_token = {};
  bool complete = false;
};

[[nodiscard]] query_definition parse_query_definition(const nlohmann::json &value);

[[nodiscard]] nlohmann::json query_definition_json(const query_definition &definition);

[[nodiscard]] logical_plan plan_query(const query_definition &definition);

// Deliberately bounded SQL frontend. SQL selects rows only; the supplied base
// definition remains the owner of declarations, cut, time basis, and policy.
[[nodiscard]] query_definition compile_episode_sql(const std::string &sql, const query_definition &base_definition);

[[nodiscard]] nlohmann::json logical_plan_json(const logical_plan &plan);

[[nodiscard]] nlohmann::json query_capabilities_json();

[[nodiscard]] nlohmann::json query_definition_schema_json();

[[nodiscard]] nlohmann::json query_object_description_json(const std::string &object);

[[nodiscard]] nlohmann::json query_examples_json();

[[nodiscard]] nlohmann::json query_result_json(const query_result &result);

[[nodiscard]] query_resume_token parse_query_resume_token(const nlohmann::json &value);

[[nodiscard]] nlohmann::json query_resume_token_json(const query_resume_token &token);

[[nodiscard]] nlohmann::json changelog_page_json(const changelog_page &page);

[[nodiscard]] changelog_page run_episode_changelog(const std::string &runtime_dir, const logical_plan &plan,
                                                   const nlohmann::json &resume_token = nlohmann::json::object(),
                                                   uint64_t max_messages = 100);
[[nodiscard]] changelog_page run_query_changelog(const std::string &runtime_dir, const logical_plan &plan,
                                                 const nlohmann::json &resume_token = nlohmann::json::object(),
                                                 uint64_t max_messages = 100);

[[nodiscard]] query_result run_episode_authority_scan(const std::string &runtime_dir, const logical_plan &plan);

[[nodiscard]] query_result run_fact_state_authority_scan(const std::string &runtime_dir, const logical_plan &plan);

[[nodiscard]] query_result run_episode_sqlite_projection(const std::string &runtime_dir, const logical_plan &plan);

} // namespace kungfu::runtime::query

#endif // KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
