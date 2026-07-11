// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/query/fact_query.h>

#include <algorithm>
#include <charconv>
#include <stdexcept>
#include <string>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>

namespace kungfu::runtime::query {

namespace yy_storage = kungfu::yijinjing::storage;

namespace {

uint64_t uint64_value(const nlohmann::json &value, const char *field) {
  if (value.is_number_unsigned()) {
    return value.get<uint64_t>();
  }
  if (value.is_number_integer()) {
    const auto signed_value = value.get<int64_t>();
    if (signed_value >= 0) {
      return static_cast<uint64_t>(signed_value);
    }
  }
  if (value.is_string()) {
    const auto text = value.get<std::string>();
    uint64_t parsed = 0;
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), parsed);
    if (error == std::errc{} && end == text.data() + text.size()) {
      return parsed;
    }
  }
  throw std::invalid_argument(std::string("invalid unsigned query field: ") + field);
}

uint64_t optional_uint64(const nlohmann::json &object, const char *field, uint64_t fallback = 0) {
  if (!object.is_object() || !object.contains(field) || object.at(field).is_null()) {
    return fallback;
  }
  return uint64_value(object.at(field), field);
}

std::string optional_text(const nlohmann::json &object, const char *field, const std::string &fallback = {}) {
  if (!object.is_object() || !object.contains(field) || object.at(field).is_null()) {
    return fallback;
  }
  if (!object.at(field).is_string()) {
    throw std::invalid_argument(std::string("invalid text query field: ") + field);
  }
  return object.at(field).get<std::string>();
}

nlohmann::json cut_json(const cut &value) {
  if (value.kind == cut_kind::Head) {
    return {{"kind", "head"}};
  }
  return {{"kind", "manifest_frame_uid"}, {"manifest_frame_uid", std::to_string(value.manifest_frame_uid)}};
}

nlohmann::json policy_json(const query_policy &policy) {
  return {{"fold", policy.fold},
          {"schema", policy.schema},
          {"engine", policy.engine},
          {"conflict", policy.conflict},
          {"redaction", policy.redaction}};
}

nlohmann::json result_schema_json(const result_schema &schema) {
  auto fields = nlohmann::json::array();
  for (const auto &field : schema.fields) {
    fields.push_back({{"name", field.name}, {"type", field.type}, {"nullable", field.nullable}});
  }
  return {{"schema", schema.schema}, {"fields", fields}};
}

std::string json_hash(const nlohmann::json &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value.dump(-1, ' ', false)));
}

result_schema episode_result_schema() {
  return {QUERY_RESULT_ROW_SCHEMA_V1,
          {{"episode_id", "uint64", false},
           {"status", "string", false},
           {"opened", "boolean", false},
           {"closed", "boolean", false},
           {"begin_time", "int64", true},
           {"end_time", "int64", true},
           {"record_count", "uint64", false},
           {"frame_count", "uint64", false},
           {"ref_count", "uint64", false},
           {"content_root", "string", true},
           {"content_root_status", "string", false}}};
}

nlohmann::json resolved_cut_json(const yy_storage::episode_manifest_fold &fold) {
  if (fold.total_record_count == 0) {
    return {{"kind", "empty"}};
  }
  return {{"kind", "manifest_frame_uid"}, {"manifest_frame_uid", std::to_string(fold.last_manifest_frame_uid)}};
}

} // namespace

query_definition parse_query_definition(const nlohmann::json &value) {
  if (!value.is_object()) {
    throw std::invalid_argument("query definition must be an object");
  }
  query_definition definition;
  definition.schema = optional_text(value, "schema", QUERY_DEFINITION_SCHEMA_V1);
  if (definition.schema != QUERY_DEFINITION_SCHEMA_V1) {
    throw std::invalid_argument("unsupported query definition schema: " + definition.schema);
  }
  definition.object = optional_text(value, "object", "episodes");
  if (definition.object != "episodes") {
    throw std::invalid_argument("ADR-0048 Q0 supports only object=episodes");
  }
  definition.limit = optional_uint64(value, "limit", 100);
  if (definition.limit == 0 || definition.limit > 1000) {
    throw std::invalid_argument("ADR-0048 Q0 requires 1 <= limit <= 1000");
  }
  definition.evidence = optional_text(value, "evidence", "proof");

  const auto basis = value.value("basis", nlohmann::json::object());
  definition.basis.scope = optional_text(basis, "scope", "episode-manifest");
  if (definition.basis.scope != "episode-manifest") {
    throw std::invalid_argument("ADR-0048 Q0 supports only scope=episode-manifest");
  }
  definition.basis.episode_id = optional_uint64(basis, "episode_id");
  definition.basis.perspective = optional_text(basis, "perspective", "manifest-append-order");
  if (definition.basis.perspective != "manifest-append-order") {
    throw std::invalid_argument("ADR-0048 Q0 supports only perspective=manifest-append-order");
  }

  const auto selected_cut = basis.value("cut", nlohmann::json{{"kind", "head"}});
  const auto cut_name = optional_text(selected_cut, "kind", "head");
  if (cut_name == "head") {
    definition.basis.selected_cut.kind = cut_kind::Head;
  } else if (cut_name == "manifest_frame_uid") {
    definition.basis.selected_cut.kind = cut_kind::ManifestFrameUid;
    definition.basis.selected_cut.manifest_frame_uid = optional_uint64(selected_cut, "manifest_frame_uid");
    if (definition.basis.selected_cut.manifest_frame_uid == 0) {
      throw std::invalid_argument("manifest_frame_uid cut requires a non-zero token");
    }
  } else {
    throw std::invalid_argument("unsupported query cut: " + cut_name);
  }

  const auto policy = basis.value("policy", nlohmann::json::object());
  definition.basis.policy.fold = optional_text(policy, "fold", definition.basis.policy.fold);
  definition.basis.policy.schema = optional_text(policy, "schema", definition.basis.policy.schema);
  definition.basis.policy.engine = optional_text(policy, "engine", definition.basis.policy.engine);
  definition.basis.policy.conflict = optional_text(policy, "conflict", definition.basis.policy.conflict);
  definition.basis.policy.redaction = optional_text(policy, "redaction", definition.basis.policy.redaction);
  const auto time_basis = basis.value("time_basis", nlohmann::json::object());
  definition.basis.valid_time = optional_text(time_basis, "valid_time", definition.basis.valid_time);
  definition.basis.system_time = optional_text(time_basis, "system_time", definition.basis.system_time);
  definition.basis.causal_time = optional_text(time_basis, "causal_time", definition.basis.causal_time);
  const query_policy supported_policy{};
  if (definition.basis.policy.fold != supported_policy.fold ||
      definition.basis.policy.schema != supported_policy.schema ||
      definition.basis.policy.engine != supported_policy.engine ||
      definition.basis.policy.conflict != supported_policy.conflict ||
      definition.basis.policy.redaction != supported_policy.redaction) {
    throw std::invalid_argument("unsupported ADR-0048 Q0 policy version");
  }
  const query_basis supported_basis{};
  if (definition.basis.valid_time != supported_basis.valid_time ||
      definition.basis.system_time != supported_basis.system_time ||
      definition.basis.causal_time != supported_basis.causal_time) {
    throw std::invalid_argument("unsupported ADR-0048 Q0 time basis");
  }
  return definition;
}

nlohmann::json query_definition_json(const query_definition &definition) {
  return {{"schema", definition.schema},
          {"basis",
           {{"scope", definition.basis.scope},
            {"episode_id", std::to_string(definition.basis.episode_id)},
            {"perspective", definition.basis.perspective},
            {"cut", cut_json(definition.basis.selected_cut)},
            {"policy", policy_json(definition.basis.policy)},
            {"time_basis",
             {{"valid_time", definition.basis.valid_time},
              {"system_time", definition.basis.system_time},
              {"causal_time", definition.basis.causal_time}}}}},
          {"object", definition.object},
          {"limit", definition.limit},
          {"evidence", definition.evidence}};
}

nlohmann::json query_result_json(const query_result &result) {
  auto rows = nlohmann::json::array();
  for (const auto &row : result.rows) {
    rows.push_back(row);
  }
  auto roots = nlohmann::json::array();
  for (const auto &root : result.proof.episode_content_roots) {
    roots.push_back(root);
  }
  auto missing = nlohmann::json::array();
  for (const auto &item : result.proof.missing_inputs) {
    missing.push_back(item);
  }
  auto unverifiable = nlohmann::json::array();
  for (const auto &item : result.proof.unverifiable_inputs) {
    unverifiable.push_back(item);
  }
  return {{"schema", result.schema},
          {"definition", query_definition_json(result.definition)},
          {"result_schema", result_schema_json(result.row_schema)},
          {"rows", rows},
          {"row_count", rows.size()},
          {"result_hash", result.result_hash},
          {"lineage",
           {{"schema", result.proof.schema},
            {"query_definition_hash", result.proof.query_definition_hash},
            {"authority", result.proof.authority},
            {"cut", result.proof.cut},
            {"policy_versions", result.proof.policy_versions},
            {"time_basis", result.proof.time_basis},
            {"determinism", result.proof.determinism},
            {"episode_content_roots", roots},
            {"missing_inputs", missing},
            {"unverifiable_inputs", unverifiable}}}};
}

query_result run_episode_authority_scan(const std::string &runtime_dir, const query_definition &definition) {
  yy_storage::episode_manifest_store store(runtime_dir);
  const auto fold = definition.basis.selected_cut.kind == cut_kind::Head
                        ? store.fold_typed_records()
                        : store.fold_typed_records_until(definition.basis.selected_cut.manifest_frame_uid);

  query_result result;
  result.definition = definition;
  result.row_schema = episode_result_schema();
  result.proof.query_definition_hash = json_hash(query_definition_json(definition));
  result.proof.authority = {{"kind", "yijinjing-journal"},
                            {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                            {"first_manifest_frame_uid", std::to_string(fold.first_manifest_frame_uid)},
                            {"last_manifest_frame_uid", std::to_string(fold.last_manifest_frame_uid)},
                            {"record_count", fold.total_record_count},
                            {"unknown_record_count", fold.unknown_record_count},
                            {"unfolded_record_count", fold.unfolded_record_count}};
  result.proof.cut = {{"declared", cut_json(definition.basis.selected_cut)},
                      {"resolved", fold.cut_found ? resolved_cut_json(fold) : nlohmann::json{{"kind", "unresolved"}}},
                      {"inclusive", true}};
  result.proof.policy_versions = policy_json(definition.basis.policy);
  result.proof.time_basis = {{"valid_time", definition.basis.valid_time},
                             {"system_time", definition.basis.system_time},
                             {"causal_time", definition.basis.causal_time}};

  if (!fold.cut_found) {
    result.proof.missing_inputs.push_back(
        {{"kind", "manifest_cut"},
         {"manifest_frame_uid", std::to_string(definition.basis.selected_cut.manifest_frame_uid)}});
    result.proof.determinism = "unverifiable";
  }
  if (fold.unknown_record_count != 0) {
    result.proof.unverifiable_inputs.push_back(
        {{"kind", "manifest_unknown_records"}, {"count", fold.unknown_record_count}});
    result.proof.determinism = "unverifiable";
  }

  if (fold.cut_found) {
    for (const auto &[episode_id, view] : fold.episodes) {
      if (definition.basis.episode_id != 0 && episode_id != definition.basis.episode_id) {
        continue;
      }
      auto row = yy_storage::episode_summary_json(view);
      const auto content_root = yy_storage::episode_content_root_json(view, fold.unknown_record_count);
      row["content_root_status"] = content_root.at("status");
      if (!row.contains("content_root")) {
        row["content_root"] = nullptr;
      }
      result.rows.push_back(row);
      result.proof.episode_content_roots.push_back({{"episode_id", std::to_string(episode_id)},
                                                    {"status", content_root.at("status")},
                                                    {"recorded", content_root.at("recorded")},
                                                    {"computed", content_root.at("computed")}});
      if (definition.limit != 0 && result.rows.size() >= definition.limit) {
        break;
      }
    }
  }
  if (definition.basis.episode_id != 0 && result.rows.empty() && fold.cut_found) {
    result.proof.missing_inputs.push_back(
        {{"kind", "episode"}, {"episode_id", std::to_string(definition.basis.episode_id)}});
  }

  result.result_hash = json_hash({{"result_schema", result_schema_json(result.row_schema)}, {"rows", result.rows}});
  return result;
}

} // namespace kungfu::runtime::query
