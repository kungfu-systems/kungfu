// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/query/fact_query.h>

#include <algorithm>
#include <cctype>
#include <charconv>
#include <initializer_list>
#include <stdexcept>
#include <string>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>

namespace kungfu::runtime::query {

namespace yy_storage = kungfu::yijinjing::storage;

namespace {

void reject_unknown_fields(const nlohmann::json &object, std::initializer_list<const char *> allowed,
                           const char *path) {
  if (!object.is_object()) {
    throw std::invalid_argument(std::string(path) + " must be an object");
  }
  for (const auto &[field, value] : object.items()) {
    (void)value;
    const auto known =
        std::any_of(allowed.begin(), allowed.end(), [&field](const char *candidate) { return field == candidate; });
    if (!known) {
      throw std::invalid_argument(std::string("unsupported query field: ") + path + "." + field);
    }
  }
}

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

nlohmann::json logical_operator_json(const logical_operator &operation) {
  return {{"kind", operation.kind}, {"arguments", operation.arguments}};
}

nlohmann::json logical_plan_payload_json(const logical_plan &plan) {
  auto operators = nlohmann::json::array();
  for (const auto &operation : plan.operators) {
    operators.push_back(logical_operator_json(operation));
  }
  return {{"schema", plan.schema},
          {"query_definition_hash", plan.query_definition_hash},
          {"operators", operators},
          {"result_schema", result_schema_json(plan.row_schema)}};
}

std::string json_hash(const nlohmann::json &value) {
  return yy_storage::format_content_hash(yy_storage::compute_content_hash(value.dump(-1, ' ', false)));
}

constexpr const char *EPISODE_CONTRACT_WORLD_ID = "kungfu.runtime";
constexpr const char *EPISODE_CONTRACT_WORLD_VERSION = "1";
constexpr const char *EPISODE_FACT_SURFACE_ID = "kungfu.runtime.episode-manifest";
constexpr const char *EPISODE_FACT_SURFACE_VERSION = "1";

nlohmann::json episode_contract_world_declaration_payload() {
  return {{"schema", "kungfu.kfd.contract-world-declaration/v1"},
          {"id", EPISODE_CONTRACT_WORLD_ID},
          {"version", EPISODE_CONTRACT_WORLD_VERSION},
          {"fact_surfaces", nlohmann::json::array({EPISODE_FACT_SURFACE_ID})},
          {"effective_system_time", "built-in"}};
}

declaration_reference episode_contract_world_reference() {
  return {EPISODE_CONTRACT_WORLD_ID, EPISODE_CONTRACT_WORLD_VERSION,
          json_hash(episode_contract_world_declaration_payload())};
}

nlohmann::json episode_fact_surface_declaration_payload() {
  const auto contract_world = episode_contract_world_reference();
  return {{"schema", "kungfu.kfd.fact-surface-declaration/v1"},
          {"id", EPISODE_FACT_SURFACE_ID},
          {"version", EPISODE_FACT_SURFACE_VERSION},
          {"contract_world",
           {{"id", contract_world.id}, {"version", contract_world.version}, {"root", contract_world.root}}},
          {"schema_owner", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
          {"source_authority", "yijinjing-episode-manifest-journal"},
          {"identity", "episode-id"},
          {"valid_time", "not-projected"},
          {"system_time", "manifest-gen-time"},
          {"causal_time", "manifest-order-and-episode-refs"},
          {"admission_policy", "typed-episode-manifest-fold/v1"}};
}

declaration_reference episode_fact_surface_reference() {
  return {EPISODE_FACT_SURFACE_ID, EPISODE_FACT_SURFACE_VERSION, json_hash(episode_fact_surface_declaration_payload())};
}

nlohmann::json declaration_reference_json(const declaration_reference &reference) {
  return {{"id", reference.id}, {"version", reference.version}, {"root", reference.root}};
}

bool is_canonical_sha256_root(const std::string &root) {
  if (root.size() != 71 || !root.starts_with("sha256:")) {
    return false;
  }
  return std::all_of(root.begin() + 7, root.end(),
                     [](unsigned char value) { return std::isdigit(value) != 0 || (value >= 'a' && value <= 'f'); });
}

declaration_reference parse_declaration_reference(const nlohmann::json &value, const char *path) {
  reject_unknown_fields(value, {"id", "version", "root"}, path);
  declaration_reference reference;
  reference.id = optional_text(value, "id");
  reference.version = optional_text(value, "version");
  reference.root = optional_text(value, "root");
  if (reference.id.empty() || reference.version.empty() || !is_canonical_sha256_root(reference.root)) {
    throw std::invalid_argument(std::string(path) + " requires non-empty id/version and canonical sha256 root");
  }
  return reference;
}

void normalize_declaration_basis(query_basis &basis) {
  if (basis.contract_world.id.empty() && basis.contract_world.version.empty() && basis.contract_world.root.empty()) {
    basis.contract_world = episode_contract_world_reference();
  }
  if (basis.fact_surfaces.empty()) {
    basis.fact_surfaces.push_back(episode_fact_surface_reference());
  }
}

std::string admission_outcome_name(admission_outcome outcome) {
  switch (outcome) {
  case admission_outcome::Admitted:
    return "admitted";
  case admission_outcome::UnregisteredSurface:
    return "unregistered-surface";
  case admission_outcome::IncompatibleSchema:
    return "incompatible-schema";
  case admission_outcome::AmbiguousAuthority:
    return "ambiguous-authority";
  case admission_outcome::Unverifiable:
    return "unverifiable";
  }
  throw std::invalid_argument("unknown admission outcome");
}

nlohmann::json admission_evidence_json(const admission_evidence &evidence) {
  return {{"outcome", admission_outcome_name(evidence.outcome)},
          {"fact_surface_id", evidence.fact_surface_id},
          {"record_count", evidence.record_count},
          {"reason", evidence.reason}};
}

bool same_declaration(const declaration_reference &left, const declaration_reference &right) {
  return left.id == right.id && left.version == right.version && left.root == right.root;
}

admission_evidence declaration_admission_evidence(const query_basis &basis, uint64_t record_count) {
  const auto expected_world = episode_contract_world_reference();
  const auto expected_surface = episode_fact_surface_reference();
  if (basis.fact_surfaces.size() != 1) {
    return {admission_outcome::AmbiguousAuthority, "", record_count,
            "episode-manifest queries require exactly one fact-surface declaration"};
  }
  const auto &surface = basis.fact_surfaces.front();
  if (basis.contract_world.id != expected_world.id || surface.id != expected_surface.id) {
    return {admission_outcome::UnregisteredSurface, surface.id, record_count,
            "declaration id is not registered for the episode-manifest authority"};
  }
  if (basis.contract_world.version != expected_world.version || surface.version != expected_surface.version) {
    return {admission_outcome::IncompatibleSchema, surface.id, record_count,
            "declaration version is incompatible with the episode-manifest authority"};
  }
  if (!same_declaration(basis.contract_world, expected_world) || !same_declaration(surface, expected_surface)) {
    return {admission_outcome::Unverifiable, surface.id, record_count,
            "declaration root does not match the registered built-in declaration"};
  }
  return {admission_outcome::Admitted, surface.id, record_count,
          "records satisfy the built-in typed Episode manifest declaration"};
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
  reject_unknown_fields(value, {"schema", "basis", "object", "limit", "evidence"}, "definition");
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
  if (definition.evidence != "proof") {
    throw std::invalid_argument("ADR-0048 Q1 supports only evidence=proof");
  }

  const auto basis = value.value("basis", nlohmann::json::object());
  reject_unknown_fields(
      basis, {"contract_world", "fact_surfaces", "scope", "episode_id", "perspective", "cut", "policy", "time_basis"},
      "definition.basis");
  if (!basis.contains("contract_world") || !basis.contains("fact_surfaces")) {
    throw std::invalid_argument("definition.basis requires explicit contract_world and fact_surfaces declarations");
  }
  definition.basis.contract_world =
      parse_declaration_reference(basis.at("contract_world"), "definition.basis.contract_world");
  const auto &fact_surfaces = basis.at("fact_surfaces");
  if (!fact_surfaces.is_array() || fact_surfaces.empty() || fact_surfaces.size() > 16) {
    throw std::invalid_argument("definition.basis.fact_surfaces requires 1..16 declaration references");
  }
  for (size_t index = 0; index < fact_surfaces.size(); ++index) {
    const auto path = std::string("definition.basis.fact_surfaces[") + std::to_string(index) + "]";
    definition.basis.fact_surfaces.push_back(parse_declaration_reference(fact_surfaces.at(index), path.c_str()));
  }
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
  reject_unknown_fields(selected_cut, {"kind", "manifest_frame_uid"}, "definition.basis.cut");
  const auto cut_name = optional_text(selected_cut, "kind", "head");
  if (cut_name == "head") {
    if (selected_cut.contains("manifest_frame_uid")) {
      throw std::invalid_argument("head cut must not include manifest_frame_uid");
    }
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
  reject_unknown_fields(policy, {"fold", "schema", "engine", "conflict", "redaction"}, "definition.basis.policy");
  definition.basis.policy.fold = optional_text(policy, "fold", definition.basis.policy.fold);
  definition.basis.policy.schema = optional_text(policy, "schema", definition.basis.policy.schema);
  definition.basis.policy.engine = optional_text(policy, "engine", definition.basis.policy.engine);
  definition.basis.policy.conflict = optional_text(policy, "conflict", definition.basis.policy.conflict);
  definition.basis.policy.redaction = optional_text(policy, "redaction", definition.basis.policy.redaction);
  const auto time_basis = basis.value("time_basis", nlohmann::json::object());
  reject_unknown_fields(time_basis, {"valid_time", "system_time", "causal_time"}, "definition.basis.time_basis");
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
  auto normalized = definition;
  normalize_declaration_basis(normalized.basis);
  auto fact_surfaces = nlohmann::json::array();
  for (const auto &surface : normalized.basis.fact_surfaces) {
    fact_surfaces.push_back(declaration_reference_json(surface));
  }
  return {{"schema", normalized.schema},
          {"basis",
           {{"contract_world", declaration_reference_json(normalized.basis.contract_world)},
            {"fact_surfaces", fact_surfaces},
            {"scope", normalized.basis.scope},
            {"episode_id", std::to_string(normalized.basis.episode_id)},
            {"perspective", normalized.basis.perspective},
            {"cut", cut_json(normalized.basis.selected_cut)},
            {"policy", policy_json(normalized.basis.policy)},
            {"time_basis",
             {{"valid_time", normalized.basis.valid_time},
              {"system_time", normalized.basis.system_time},
              {"causal_time", normalized.basis.causal_time}}}}},
          {"object", normalized.object},
          {"limit", normalized.limit},
          {"evidence", normalized.evidence}};
}

logical_plan plan_query(const query_definition &definition) {
  logical_plan plan;
  plan.definition = definition;
  normalize_declaration_basis(plan.definition.basis);
  const auto &normalized = plan.definition;
  plan.row_schema = episode_result_schema();
  plan.query_definition_hash = json_hash(query_definition_json(normalized));
  auto fact_surfaces = nlohmann::json::array();
  for (const auto &surface : normalized.basis.fact_surfaces) {
    fact_surfaces.push_back(declaration_reference_json(surface));
  }
  plan.operators.push_back({"authority_scan",
                            {{"object", normalized.object},
                             {"contract_world", declaration_reference_json(normalized.basis.contract_world)},
                             {"fact_surfaces", fact_surfaces},
                             {"scope", normalized.basis.scope},
                             {"perspective", normalized.basis.perspective},
                             {"cut", cut_json(normalized.basis.selected_cut)},
                             {"policy", policy_json(normalized.basis.policy)},
                             {"time_basis",
                              {{"valid_time", normalized.basis.valid_time},
                               {"system_time", normalized.basis.system_time},
                               {"causal_time", normalized.basis.causal_time}}}}});
  if (normalized.basis.episode_id != 0) {
    plan.operators.push_back(
        {"filter",
         {{"field", "episode_id"}, {"operator", "eq"}, {"value", std::to_string(normalized.basis.episode_id)}}});
  }
  plan.operators.push_back({"order", {{"field", "episode_id"}, {"direction", "asc"}}});
  plan.operators.push_back({"limit", {{"count", normalized.limit}}});
  auto projected_fields = nlohmann::json::array();
  for (const auto &field : plan.row_schema.fields) {
    projected_fields.push_back(field.name);
  }
  plan.operators.push_back({"project", {{"schema", plan.row_schema.schema}, {"fields", projected_fields}}});
  plan.operators.push_back({"evidence", {{"level", normalized.evidence}}});
  plan.logical_plan_hash = json_hash(logical_plan_payload_json(plan));
  return plan;
}

nlohmann::json logical_plan_json(const logical_plan &plan) {
  auto value = logical_plan_payload_json(plan);
  value["definition"] = query_definition_json(plan.definition);
  value["logical_plan_hash"] = plan.logical_plan_hash;
  return value;
}

nlohmann::json query_capabilities_json() {
  const auto contract_world = episode_contract_world_reference();
  const auto fact_surface = episode_fact_surface_reference();
  return {{"schema", QUERY_CAPABILITIES_SCHEMA_V1},
          {"query_definition_schema", QUERY_DEFINITION_SCHEMA_V1},
          {"logical_plan_schema", LOGICAL_PLAN_SCHEMA_V1},
          {"objects", nlohmann::json::array({"episodes"})},
          {"operators", nlohmann::json::array({"authority_scan", "filter", "order", "limit", "project", "evidence"})},
          {"cuts", nlohmann::json::array({"head", "manifest_frame_uid"})},
          {"admission_outcomes", nlohmann::json::array({"admitted", "unregistered-surface", "incompatible-schema",
                                                        "ambiguous-authority", "unverifiable"})},
          {"builtin_declarations",
           {{"contract_world",
             {{"reference", declaration_reference_json(contract_world)},
              {"declaration", episode_contract_world_declaration_payload()}}},
            {"fact_surfaces", nlohmann::json::array({{{"reference", declaration_reference_json(fact_surface)},
                                                      {"declaration", episode_fact_surface_declaration_payload()}}})}}},
          {"formats", nlohmann::json::array({"json", "ndjson", "tsv"})},
          {"commands",
           nlohmann::json::array({"capabilities", "schema", "describe", "examples", "validate", "explain", "prove"})},
          {"limits", {{"minimum", 1}, {"maximum", 1000}}},
          {"error_codes",
           nlohmann::json::array({"KF_QUERY_INPUT", "KF_QUERY_VALIDATION", "KF_QUERY_EXECUTION", "KF_QUERY_OUTPUT"})},
          {"physical_plan", {{"public", false}, {"reason", "engine-private-and-replaceable"}}}};
}

nlohmann::json query_definition_schema_json() {
  const auto declaration_reference_schema =
      nlohmann::json{{"type", "object"},
                     {"required", nlohmann::json::array({"id", "version", "root"})},
                     {"properties",
                      {{"id", {{"type", "string"}, {"minLength", 1}}},
                       {"version", {{"type", "string"}, {"minLength", 1}}},
                       {"root", {{"type", "string"}, {"pattern", "^sha256:[0-9a-f]{64}$"}}}}},
                     {"additionalProperties", false}};
  const auto cut_schema = nlohmann::json{
      {"oneOf", nlohmann::json::array(
                    {{{"type", "object"},
                      {"required", nlohmann::json::array({"kind"})},
                      {"properties", {{"kind", {{"const", "head"}}}}},
                      {"additionalProperties", false}},
                     {{"type", "object"},
                      {"required", nlohmann::json::array({"kind", "manifest_frame_uid"})},
                      {"properties",
                       {{"kind", {{"const", "manifest_frame_uid"}}},
                        {"manifest_frame_uid",
                         {{"oneOf", nlohmann::json::array({{{"type", "integer"}, {"minimum", 1}},
                                                           {{"type", "string"}, {"pattern", "^[1-9][0-9]*$"}}})}}}}},
                      {"additionalProperties", false}}})}};
  const auto policy_schema = nlohmann::json{{"type", "object"},
                                            {"properties",
                                             {{"fold", {{"const", "episode-manifest-fold/v1"}}},
                                              {"schema", {{"const", "kungfu.episode.manifest/v1"}}},
                                              {"engine", {{"const", "episode-authority-scan/v1"}}},
                                              {"conflict", {{"const", "preserve-source-claims/v1"}}},
                                              {"redaction", {{"const", "report-missing-evidence/v1"}}}}},
                                            {"additionalProperties", false}};
  const auto time_basis_schema = nlohmann::json{{"type", "object"},
                                                {"properties",
                                                 {{"valid_time", {{"const", "not-projected"}}},
                                                  {"system_time", {{"const", "manifest-gen-time"}}},
                                                  {"causal_time", {{"const", "manifest-order-and-episode-refs"}}}}},
                                                {"additionalProperties", false}};
  return {{"$schema", "https://json-schema.org/draft/2020-12/schema"},
          {"$id", QUERY_DEFINITION_SCHEMA_V1},
          {"title", "Kungfu QueryDefinition"},
          {"type", "object"},
          {"required", nlohmann::json::array({"schema", "basis", "object"})},
          {"properties",
           {{"schema", {{"const", QUERY_DEFINITION_SCHEMA_V1}}},
            {"basis",
             {{"type", "object"},
              {"required", nlohmann::json::array({"contract_world", "fact_surfaces", "scope", "perspective", "cut"})},
              {"properties",
               {{"contract_world", declaration_reference_schema},
                {"fact_surfaces",
                 {{"type", "array"}, {"minItems", 1}, {"maxItems", 16}, {"items", declaration_reference_schema}}},
                {"scope", {{"const", "episode-manifest"}}},
                {"episode_id",
                 {{"oneOf", nlohmann::json::array({{{"type", "integer"}, {"minimum", 0}},
                                                   {{"type", "string"}, {"pattern", "^[0-9]+$"}}})}}},
                {"perspective", {{"const", "manifest-append-order"}}},
                {"cut", cut_schema},
                {"policy", policy_schema},
                {"time_basis", time_basis_schema}}},
              {"additionalProperties", false}}},
            {"object", {{"const", "episodes"}}},
            {"limit", {{"type", "integer"}, {"minimum", 1}, {"maximum", 1000}}},
            {"evidence", {{"const", "proof"}}}}},
          {"additionalProperties", false}};
}

nlohmann::json query_object_description_json(const std::string &object) {
  if (object != "episodes") {
    throw std::invalid_argument("unsupported query object: " + object);
  }
  return {{"schema", "kungfu.query.object-description/v1"},
          {"object", "episodes"},
          {"authority", "yijinjing Episode manifest journal"},
          {"result_schema", result_schema_json(episode_result_schema())},
          {"basis_filter", "basis.episode_id"},
          {"canonical_order", nlohmann::json{{"field", "episode_id"}, {"direction", "asc"}}},
          {"supported_cuts", nlohmann::json::array({"head", "manifest_frame_uid"})}};
}

nlohmann::json query_examples_json() {
  const query_definition head_definition{};
  auto historical_definition = head_definition;
  historical_definition.basis.episode_id = 1048;
  historical_definition.basis.selected_cut.kind = cut_kind::ManifestFrameUid;
  historical_definition.basis.selected_cut.manifest_frame_uid = 123456789;
  return {{"schema", "kungfu.query.examples/v1"},
          {"examples",
           nlohmann::json::array(
               {{{"name", "episode-head"}, {"definition", query_definition_json(head_definition)}},
                {{"name", "episode-historical-cut"}, {"definition", query_definition_json(historical_definition)}}})}};
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
  auto fact_surfaces = nlohmann::json::array();
  for (const auto &surface : result.proof.fact_surface_declarations) {
    fact_surfaces.push_back(declaration_reference_json(surface));
  }
  auto admission_outcomes = nlohmann::json::array();
  for (const auto &outcome : result.proof.admission_outcomes) {
    admission_outcomes.push_back(admission_evidence_json(outcome));
  }
  return {{"schema", result.schema},
          {"definition", query_definition_json(result.definition)},
          {"logical_plan", logical_plan_json(result.plan)},
          {"result_schema", result_schema_json(result.row_schema)},
          {"rows", rows},
          {"row_count", rows.size()},
          {"result_hash", result.result_hash},
          {"lineage",
           {{"schema", result.proof.schema},
            {"query_definition_hash", result.proof.query_definition_hash},
            {"logical_plan_hash", result.proof.logical_plan_hash},
            {"authority", result.proof.authority},
            {"cut", result.proof.cut},
            {"policy_versions", result.proof.policy_versions},
            {"time_basis", result.proof.time_basis},
            {"determinism", result.proof.determinism},
            {"canonical_state", result.proof.canonical_state},
            {"contract_world_declaration", declaration_reference_json(result.proof.contract_world_declaration)},
            {"fact_surface_declarations", fact_surfaces},
            {"admission_outcomes", admission_outcomes},
            {"episode_content_roots", roots},
            {"missing_inputs", missing},
            {"unverifiable_inputs", unverifiable}}}};
}

query_result run_episode_authority_scan(const std::string &runtime_dir, const logical_plan &plan) {
  const auto &definition = plan.definition;
  yy_storage::episode_manifest_store store(runtime_dir);
  const auto fold = definition.basis.selected_cut.kind == cut_kind::Head
                        ? store.fold_typed_records()
                        : store.fold_typed_records_until(definition.basis.selected_cut.manifest_frame_uid);

  query_result result;
  result.definition = definition;
  result.plan = plan;
  result.row_schema = plan.row_schema;
  result.proof.query_definition_hash = plan.query_definition_hash;
  result.proof.logical_plan_hash = plan.logical_plan_hash;
  result.proof.contract_world_declaration = definition.basis.contract_world;
  result.proof.fact_surface_declarations = definition.basis.fact_surfaces;
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

  auto known_record_count = static_cast<uint64_t>(fold.total_record_count);
  const auto unknown_record_count = std::min(known_record_count, static_cast<uint64_t>(fold.unknown_record_count));
  known_record_count -= unknown_record_count;
  const auto unfolded_record_count = std::min(known_record_count, static_cast<uint64_t>(fold.unfolded_record_count));
  known_record_count -= unfolded_record_count;
  auto declaration_outcome =
      declaration_admission_evidence(definition.basis, static_cast<uint64_t>(fold.total_record_count));
  const auto declarations_admitted = declaration_outcome.outcome == admission_outcome::Admitted;
  if (declarations_admitted) {
    declaration_outcome.record_count = known_record_count;
  } else {
    result.proof.unverifiable_inputs.push_back({{"kind", "declaration_basis"},
                                                {"outcome", admission_outcome_name(declaration_outcome.outcome)},
                                                {"reason", declaration_outcome.reason}});
    result.proof.determinism = "unverifiable";
  }
  result.proof.admission_outcomes.push_back(declaration_outcome);

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
    result.proof.admission_outcomes.push_back(
        {admission_outcome::Unverifiable, definition.basis.fact_surfaces.front().id,
         static_cast<uint64_t>(fold.unknown_record_count), "unknown manifest records are not admitted"});
  }
  if (fold.unfolded_record_count != 0) {
    result.proof.unverifiable_inputs.push_back(
        {{"kind", "manifest_unfolded_records"}, {"count", fold.unfolded_record_count}});
    result.proof.determinism = "unverifiable";
    result.proof.admission_outcomes.push_back(
        {admission_outcome::Unverifiable, definition.basis.fact_surfaces.front().id,
         static_cast<uint64_t>(fold.unfolded_record_count), "unfolded manifest records are not admitted"});
  }

  result.proof.canonical_state =
      declarations_admitted && fold.cut_found && fold.unknown_record_count == 0 && fold.unfolded_record_count == 0;

  if (fold.cut_found && declarations_admitted) {
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
