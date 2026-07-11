// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
#define KUNGFU_RUNTIME_QUERY_FACT_QUERY_H

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::query {

inline constexpr const char *QUERY_DEFINITION_SCHEMA_V1 = "kungfu.query.definition/v1";
inline constexpr const char *QUERY_RESULT_SCHEMA_V1 = "kungfu.query.result/v1";
inline constexpr const char *QUERY_LINEAGE_SCHEMA_V1 = "kungfu.query.lineage/v1";
inline constexpr const char *QUERY_RESULT_ROW_SCHEMA_V1 = "kungfu.query.episode-row/v1";

enum class cut_kind { Head, ManifestFrameUid };

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

struct lineage {
  std::string schema = QUERY_LINEAGE_SCHEMA_V1;
  nlohmann::json authority = nlohmann::json::object();
  nlohmann::json cut = nlohmann::json::object();
  nlohmann::json policy_versions = nlohmann::json::object();
  nlohmann::json time_basis = nlohmann::json::object();
  std::string determinism = "deterministic";
  std::vector<nlohmann::json> episode_content_roots = {};
  std::vector<nlohmann::json> missing_inputs = {};
  std::vector<nlohmann::json> unverifiable_inputs = {};
  std::string query_definition_hash = {};
};

struct query_result {
  std::string schema = QUERY_RESULT_SCHEMA_V1;
  query_definition definition = {};
  result_schema row_schema = {};
  std::vector<nlohmann::json> rows = {};
  lineage proof = {};
  std::string result_hash = {};
};

[[nodiscard]] query_definition parse_query_definition(const nlohmann::json &value);

[[nodiscard]] nlohmann::json query_definition_json(const query_definition &definition);

[[nodiscard]] nlohmann::json query_result_json(const query_result &result);

[[nodiscard]] query_result run_episode_authority_scan(const std::string &runtime_dir,
                                                      const query_definition &definition);

} // namespace kungfu::runtime::query

#endif // KUNGFU_RUNTIME_QUERY_FACT_QUERY_H
