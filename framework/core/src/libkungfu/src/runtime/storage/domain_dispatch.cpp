// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <stdexcept>
#include <unordered_set>
#include <utility>

#include <kungfu/runtime/action/action_runtime.h>
#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/facts/fact_admission.h>
#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/runtime/query/fact_query.h>
#include <kungfu/runtime/query/saved_query_catalog.h>
#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/runtime/trust/assessment_runtime.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::storage_service_api::detail {

namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

class file_storage_json_edge_service {
public:
  [[nodiscard]] nlohmann::json status(const storage_service_options &options) const {
    return render_storage_status_result(default_storage_service().status(parse_storage_status_request(options)));
  }

  [[nodiscard]] nlohmann::json fsck(const storage_service_options &options) const { return fsck_impl(options); }

  [[nodiscard]] nlohmann::json repair_plan(const storage_service_options &options) const {
    return repair_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_fetch(const storage_service_options &options) const {
    return repair_fetch_impl(options);
  }

  [[nodiscard]] nlohmann::json repair_apply(const storage_service_options &options) const {
    return repair_apply_impl(options);
  }

  [[nodiscard]] nlohmann::json export_bundle(const storage_service_options &options) const {
    if (options.scope == "episode") {
      return episode_export_bundle_impl(options);
    }
    // The public export operation records the export-bundle receipt; internal
    // read-only exports (verify_sync round trips, repair-fetch evidence scans
    // over mirror runtimes) call the impl without the receipt.
    return export_bundle_generic_impl(options, /*record_receipt=*/true);
  }

  [[nodiscard]] nlohmann::json import_bundle(const storage_service_options &options) const {
    if (!options.bundle.is_object()) {
      throw std::invalid_argument("bundle_manifest_missing");
    }
    if (options.scope == "episode" || text_or(options.bundle, "schema") == "kungfu.storage.episode-bundle/v1") {
      return episode_import_bundle_impl(options);
    }
    return render_storage_import_bundle_result(default_storage_service().import_bundle(
        {options.runtime_dir, options.provider, parse_storage_export_bundle(options.bundle), options.verify}));
  }

  [[nodiscard]] nlohmann::json episode_admission(const storage_service_options &options) const {
    return episode_admission_impl(options);
  }

  [[nodiscard]] nlohmann::json rebuild_index(const storage_service_options &options) const {
    return rebuild_index_impl(options);
  }

  [[nodiscard]] nlohmann::json gc_plan(const storage_service_options &options) const { return gc_plan_impl(options); }

  [[nodiscard]] nlohmann::json compact_plan(const storage_service_options &options) const {
    return compact_plan_impl(options);
  }

  [[nodiscard]] nlohmann::json verify_sync(const storage_service_options &options) const {
    return render_storage_verify_sync_result(default_storage_service().verify_sync(
        {options.runtime_dir, options.provider, options.provider_config_source, options.source_id}));
  }

  [[nodiscard]] nlohmann::json layout(const storage_service_options &options) const {
    storage_layout_request request{};
    request.runtime_dir = options.runtime_dir;
    request.runtime_home = text_or(options.operation_options, "runtime_home");
    request.config_home = text_or(options.operation_options, "config_home");
    request.provider = options.provider;
    return workspace_episode_layout_json(default_storage_service().layout(request));
  }

  [[nodiscard]] nlohmann::json query_plan(const storage_service_options &options) const {
    const auto action = text_or(options.operation_options, "action", "validate");
    if (action == "capabilities") {
      return query::query_capabilities_json();
    }
    if (action == "schema") {
      return query::query_definition_schema_json();
    }
    if (action == "describe") {
      return query::query_object_description_json(text_or(options.operation_options, "object", "episodes"));
    }
    if (action == "examples") {
      return query::query_examples_json();
    }

    auto definition = query::parse_query_definition(options.query_definition);
    if (action == "compile-sql") {
      if (options.query.empty()) {
        throw std::invalid_argument("compile-sql requires a non-empty SQL query");
      }
      definition = query::compile_episode_sql(options.query, definition);
    }
    const auto plan = query::plan_query(definition);
    if (action == "compile-sql") {
      return {{"schema", "kungfu.query.sql-compilation/v1"},
              {"sql", options.query},
              {"definition", query::query_definition_json(definition)},
              {"logical_plan", query::logical_plan_json(plan)},
              {"query_definition_hash", plan.query_definition_hash},
              {"logical_plan_hash", plan.logical_plan_hash}};
    }
    if (action == "validate") {
      return {{"schema", query::QUERY_VALIDATION_SCHEMA_V1},
              {"ok", true},
              {"definition", query::query_definition_json(definition)},
              {"query_definition_hash", plan.query_definition_hash},
              {"logical_plan_hash", plan.logical_plan_hash}};
    }
    if (action == "explain") {
      const auto engine = text_or(options.operation_options, "engine", "authority");
      if (engine != "authority" && engine != "sqlite") {
        throw std::invalid_argument("query engine must be authority or sqlite");
      }
      const auto authority_engine =
          definition.object == "fact-state" ? "fact-authority-scan/v1" : "episode-authority-scan/v1";
      if (definition.object == "fact-state" && engine == "sqlite") {
        throw std::invalid_argument("object=fact-state currently supports only the authority engine");
      }
      return {{"schema", query::QUERY_EXPLAIN_SCHEMA_V1},
              {"definition", query::query_definition_json(definition)},
              {"logical_plan", query::logical_plan_json(plan)},
              {"physical",
               {{"engine", engine == "authority" ? authority_engine : "episode-sqlite-projection/v1"},
                {"bounded", true},
                {"limit", definition.limit},
                {"cost",
                 {{"class", engine == "authority" ? "bounded-authority-scan" : "bounded-sqlite-projection"},
                  {"upper_bound_rows", definition.limit},
                  {"authority_records", "runtime-dependent"}}}}}};
    }
    throw std::invalid_argument("unsupported query planner action: " + action);
  }

  [[nodiscard]] nlohmann::json fact_query(const storage_service_options &options) const {
    const auto definition = query::parse_query_definition(options.query_definition);
    const auto plan = query::plan_query(definition);
    const auto engine = text_or(options.operation_options, "engine", "authority");
    if (engine == "authority") {
      if (definition.object == "fact-state") {
        return query::query_result_json(query::run_fact_state_authority_scan(options.runtime_dir, plan));
      }
      return query::query_result_json(query::run_episode_authority_scan(options.runtime_dir, plan));
    }
    if (engine == "sqlite") {
      if (definition.object != "episodes") {
        throw std::invalid_argument("object=fact-state currently supports only the authority engine");
      }
      return query::query_result_json(query::run_episode_sqlite_projection(options.runtime_dir, plan));
    }
    throw std::invalid_argument("query engine must be authority or sqlite");
  }

  [[nodiscard]] nlohmann::json fact_changelog(const storage_service_options &options) const {
    const auto definition = query::parse_query_definition(options.query_definition);
    const auto plan = query::plan_query(definition);
    const auto resume_token = object_or_empty(options.operation_options, "resume_token");
    const auto max_messages = uint64_or(options.operation_options, "max_messages", 100);
    return query::changelog_page_json(
        query::run_query_changelog(options.runtime_dir, plan, resume_token, max_messages));
  }

  [[nodiscard]] nlohmann::json saved_query_catalog(const storage_service_options &options) const {
    const auto action = text_or(options.operation_options, "action", "list");
    if (action == "contract") {
      return query::saved_query_catalog_contract();
    }
    if (action == "put") {
      return query::saved_query_put(options.runtime_dir, object_or_empty(options.operation_options, "saved_view"),
                                    text_or(options.operation_options, "query_id"),
                                    uint64_or(options.operation_options, "expected_revision"),
                                    int64_or(options.operation_options, "system_time"));
    }
    if (action == "get") {
      return query::saved_query_get(options.runtime_dir, text_or(options.operation_options, "query_id"),
                                    bool_or(options.operation_options, "include_deleted", false));
    }
    if (action == "list") {
      return query::saved_query_list(options.runtime_dir, bool_or(options.operation_options, "include_deleted", false));
    }
    if (action == "history") {
      return query::saved_query_history(options.runtime_dir, text_or(options.operation_options, "query_id"));
    }
    if (action == "delete") {
      return query::saved_query_delete(options.runtime_dir, text_or(options.operation_options, "query_id"),
                                       uint64_or(options.operation_options, "expected_revision"),
                                       int64_or(options.operation_options, "system_time"));
    }
    if (action == "rebuild") {
      return query::saved_query_rebuild(options.runtime_dir);
    }
    throw std::invalid_argument("unsupported saved-query catalog action: " + action);
  }

  [[nodiscard]] nlohmann::json profile_lifecycle(const storage_service_options &options) const {
    const auto action = text_or(options.operation_options, "action", "list");
    if (action == "contract") {
      return profile::profile_lifecycle_contract();
    }
    if (action == "inspect") {
      return profile::inspect_profile(text_or(options.operation_options, "profile_path"),
                                      object_or_empty(options.operation_options, "member_roots"));
    }
    if (action == "plan") {
      return profile::plan_profile_lifecycle(options.runtime_dir,
                                             object_or_empty(options.operation_options, "request"));
    }
    if (action == "apply") {
      return profile::apply_profile_lifecycle(options.runtime_dir, object_or_empty(options.operation_options, "plan"),
                                              text_or(options.operation_options, "authorization_id"),
                                              int64_or(options.operation_options, "system_time"));
    }
    if (action == "get") {
      return profile::get_profile(options.runtime_dir, text_or(options.operation_options, "profile_id"),
                                  bool_or(options.operation_options, "include_removed", false),
                                  int64_or(options.operation_options, "cut_system_time"));
    }
    if (action == "list") {
      return profile::list_profiles(options.runtime_dir, bool_or(options.operation_options, "include_removed", false),
                                    int64_or(options.operation_options, "cut_system_time"));
    }
    if (action == "history") {
      return profile::profile_history(options.runtime_dir, text_or(options.operation_options, "profile_id"));
    }
    throw std::invalid_argument("unsupported Profile lifecycle action: " + action);
  }

  [[nodiscard]] nlohmann::json kfx_runtime(const storage_service_options &options) const {
    const auto action = text_or(options.operation_options, "action", "contract");
    if (action == "contract") {
      return kfx::native_kfx_contract();
    }
    if (action == "validate") {
      return kfx::validate_native_kfx_document(text_or(options.operation_options, "kind"),
                                               object_or_empty(options.operation_options, "document"));
    }
    if (action == "list" || action == "inspect" || action == "resolve" || action == "plan" || action == "status" ||
        action == "assess" || action == "apply" || action == "authorize-host" || action == "history" ||
        action == "runtime-warrant-issue" || action == "runtime-warrant-heartbeat" ||
        action == "runtime-warrant-revoke" || action == "runtime-warrant-settle" ||
        action == "runtime-warrant-recover" || action == "kfd-10-witness") {
      return kfx::query_native_kfx_registry(action, object_or_empty(options.operation_options, "request"),
                                            options.runtime_dir);
    }
    throw std::invalid_argument("unsupported native KFX runtime action: " + action);
  }

  [[nodiscard]] nlohmann::json fact_kernel(const storage_service_options &options) const {
    return run_fact_kernel_operation(options.runtime_dir, options.operation_options);
  }

  [[nodiscard]] nlohmann::json action_runtime(const storage_service_options &options) const {
    return kungfu::runtime::action::run_action_runtime_operation(options.runtime_dir, options.operation_options);
  }

  [[nodiscard]] nlohmann::json fact_contract(const storage_service_options &options) const {
    (void)options;
    return facts::fact_contract_json();
  }

  [[nodiscard]] nlohmann::json fact_declare_world(const storage_service_options &options) const {
    return facts::declare_contract_world(options.runtime_dir, object_or_empty(options.operation_options, "declaration"),
                                         int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json fact_declare_surface(const storage_service_options &options) const {
    return facts::declare_fact_surface(options.runtime_dir, object_or_empty(options.operation_options, "declaration"),
                                       int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json fact_observe(const storage_service_options &options) const {
    return facts::record_observation(options.runtime_dir, object_or_empty(options.operation_options, "observation"),
                                     int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json fact_state(const storage_service_options &options) const {
    return facts::query_fact_state(options.runtime_dir, int64_or(options.operation_options, "cut_system_time"),
                                   text_or(options.operation_options, "subject_key"));
  }

  [[nodiscard]] nlohmann::json fact_library_contract(const storage_service_options &options) const {
    (void)options;
    return {
        {"schema", "kungfu.facts.library-contract/v1"},
        {"owner", "libkungfu"},
        {"authority", "yijinjing-journal"},
        {"content_store", {{"schemas", "schemas"}, {"payloads", "payloads"}}},
        {"schema_validation",
         {{"profile", "json-schema-object-subset/v1"},
          {"keywords", nlohmann::json::array({"type", "properties", "required", "items", "additionalProperties"})}}},
        {"semantic_profile",
         {{"id", "declared-facts-v1"},
          {"identity_policy", "subject-key/v1"},
          {"valid_time_policy", "explicit-range/v1"},
          {"system_time_policy", "journal-event-time/v1"},
          {"causal_time_policy", "event-parent/v1"},
          {"reducer_policy", "latest-admitted-per-source/v1"},
          {"correction_policy", "explicit-target/v1"},
          {"retraction_policy", "explicit-target/v1"},
          {"conflict_policy", "preserve-source-claims/v1"},
          {"redaction_policy", "hash-and-ref/v1"},
          {"compatibility_policy", "exact-schema-root/v1"}}},
        {"operations", nlohmann::json::array({"type-create", "type-list", "material-put", "material-list"})},
        {"writer_admission",
         {{"mode", "bounded-core-wait/v1"},
          {"timeout_ms", 5000},
          {"physical_writer", "single"},
          {"concurrent_clients", "queued-before-read"}}},
        {"portability", {{"full", "owned schema and payload bytes"}, {"thin", "declared refs only"}}},
        {"known_limits", nlohmann::json::array({"one fixed semantic profile", "bounded JSON Schema object subset",
                                                "no mutable global-latest workspace binding"})}};
  }

  [[nodiscard]] nlohmann::json fact_type_list(const storage_service_options &options) const {
    const auto state =
        facts::query_fact_state(options.runtime_dir, int64_or(options.operation_options, "cut_system_time"));
    const auto catalog = object_or_empty(state, "catalog");
    return {{"schema", "kungfu.facts.type-catalog/v1"},
            {"scope", text_or(options.operation_options, "scope", "selected-data-root")},
            {"semantic_profile", "declared-facts-v1"},
            {"contract_worlds", array_or_empty(catalog, "contract_worlds")},
            {"fact_types", array_or_empty(catalog, "fact_surfaces")},
            {"proof", state.at("proof")}};
  }

  [[nodiscard]] nlohmann::json fact_type_create(const storage_service_options &options) const {
    const auto definition = object_or_empty(options.operation_options, "definition");
    const auto type_id = required_text(definition, "id");
    const auto version = required_text(definition, "version");
    const auto sources = array_or_empty(definition, "source_authorities");
    if (sources.empty()) {
      throw std::invalid_argument("source_authorities requires at least one source id");
    }
    const auto schema = object_or_empty(definition, "schema");
    if (schema.empty()) {
      throw std::invalid_argument("schema must be a non-empty JSON object");
    }
    if (text_or(schema, "type") != "object") {
      throw std::invalid_argument("managed fact schema must use the supported top-level object profile");
    }
    const auto raw_schema = canonical_json(schema);
    const auto schema_hash = yy_storage::format_content_hash(yy_storage::compute_content_hash(raw_schema));
    const auto effective_from =
        int64_or(definition, "effective_from",
                 int64_or(options.operation_options, "system_time", kungfu::yijinjing::time::now_in_nano()));
    const auto effective_until = int64_or(definition, "effective_until");
    const auto explicit_world_reference = object_or_empty(definition, "contract_world");
    const auto world_id = explicit_world_reference.empty()
                              ? text_or(definition, "contract_world_id", type_id + ".world")
                              : required_text(explicit_world_reference, "id");
    const auto world_version =
        explicit_world_reference.empty() ? version : required_text(explicit_world_reference, "version");
    if (!explicit_world_reference.empty() && text_or(explicit_world_reference, "root").empty()) {
      throw std::invalid_argument("contract_world.root is required");
    }
    if (!text_or(definition, "contract_world_id").empty() && text_or(definition, "contract_world_id") != world_id) {
      throw std::invalid_argument("contract_world_id must match contract_world.id");
    }

    const auto existing = fact_type_list(options);
    const auto provider = shared_provider(options);
    nlohmann::json world_reference = explicit_world_reference;
    if (world_reference.empty()) {
      for (const auto &world : array_or_empty(existing, "contract_worlds")) {
        if (text_or(world, "id") == world_id && text_or(world, "version") == world_version) {
          world_reference = {{"id", world.at("id")}, {"version", world.at("version")}, {"root", world.at("root")}};
          break;
        }
      }
    }
    for (const auto &type : array_or_empty(existing, "fact_types")) {
      if (text_or(type, "id") == type_id && text_or(type, "version") == version) {
        if (text_or(type, "schema_owner_root") != schema_hash) {
          throw std::invalid_argument("fact type version already exists with a different schema root");
        }
        const auto existing_world = object_or_empty(type, "contract_world");
        if (canonical_json(array_or_empty(type, "source_authorities")) != canonical_json(sources) ||
            text_or(existing_world, "id") != world_id || text_or(existing_world, "version") != world_version ||
            (!explicit_world_reference.empty() &&
             text_or(existing_world, "root") != text_or(explicit_world_reference, "root"))) {
          throw std::invalid_argument("fact type version already exists with a different immutable definition");
        }
        const auto stored =
            provider->content_store().put_if_absent("schemas", raw_schema, yy_storage::parse_content_hash(schema_hash));
        if (!stored.ok()) {
          throw std::runtime_error("fact schema store failed: " + stored.message);
        }
        return {{"schema", "kungfu.facts.type-write/v1"},
                {"ok", true},
                {"status", "already_present"},
                {"definition", type},
                {"schema_hash", schema_hash},
                {"schema_store", content_result_json(stored)}};
      }
    }

    const auto stored =
        provider->content_store().put_if_absent("schemas", raw_schema, yy_storage::parse_content_hash(schema_hash));
    if (!stored.ok()) {
      throw std::runtime_error("fact schema store failed: " + stored.message);
    }
    nlohmann::json world_receipt = nullptr;
    if (world_reference.is_null() || world_reference.empty()) {
      world_receipt = facts::declare_contract_world(options.runtime_dir,
                                                    {{"id", world_id},
                                                     {"version", world_version},
                                                     {"effective_from", effective_from},
                                                     {"effective_until", effective_until},
                                                     {"fact_surface_ids", nlohmann::json::array({type_id})}},
                                                    effective_from);
      world_reference = world_receipt.at("reference");
    }
    nlohmann::json surface = {{"id", type_id},
                              {"version", version},
                              {"contract_world", world_reference},
                              {"effective_from", effective_from},
                              {"effective_until", effective_until},
                              {"schema_owner_root", schema_hash},
                              {"source_authorities", sources},
                              {"identity_policy", "subject-key/v1"},
                              {"valid_time_policy", "explicit-range/v1"},
                              {"system_time_policy", "journal-event-time/v1"},
                              {"causal_time_policy", "event-parent/v1"},
                              {"reducer_policy", "latest-admitted-per-source/v1"},
                              {"correction_policy", "explicit-target/v1"},
                              {"retraction_policy", "explicit-target/v1"},
                              {"conflict_policy", "preserve-source-claims/v1"},
                              {"redaction_policy", "hash-and-ref/v1"},
                              {"compatibility_policy", "exact-schema-root/v1"},
                              {"known_limits", nlohmann::json::array({"declared-facts-v1 fixed semantic profile"})}};
    const auto receipt = facts::declare_fact_surface(options.runtime_dir, surface, effective_from, schema_hash);
    return {{"schema", "kungfu.facts.type-write/v1"},
            {"ok", true},
            {"status", "created"},
            {"definition", receipt.at("declaration")},
            {"schema_hash", schema_hash},
            {"schema_store", content_result_json(stored)},
            {"world", world_receipt},
            {"receipt", receipt}};
  }

  [[nodiscard]] nlohmann::json fact_material_put(const storage_service_options &options) const {
    const auto material = object_or_empty(options.operation_options, "material");
    const auto type_id = required_text(material, "type_id");
    const auto type_version = required_text(material, "type_version");
    const auto source_id = required_text(material, "source_id");
    const auto subject_key = required_text(material, "subject_key");
    if (!material.contains("payload") || !material.at("payload").is_object()) {
      throw std::invalid_argument("payload must be a JSON object");
    }
    const auto types = fact_type_list(options);
    nlohmann::json selected;
    for (const auto &type : array_or_empty(types, "fact_types")) {
      if (text_or(type, "id") == type_id && text_or(type, "version") == type_version) {
        selected = type;
        break;
      }
    }
    if (selected.is_null() || selected.empty()) {
      throw std::invalid_argument("fact type version is not registered in the selected data root");
    }
    const auto provider = shared_provider(options);
    const auto schema_hash = required_text(selected, "schema_owner_root");
    const auto stored_schema = provider->content_store().get("schemas", yy_storage::parse_content_hash(schema_hash));
    if (!stored_schema.ok()) {
      throw std::runtime_error("fact type schema content is unavailable: " + schema_hash);
    }
    const auto schema = nlohmann::json::parse(stored_schema.bytes);
    validate_managed_json_value(schema, material.at("payload"), "$");
    const auto raw_payload = canonical_json(material.at("payload"));
    const auto payload_hash = yy_storage::format_content_hash(yy_storage::compute_content_hash(raw_payload));
    const auto stored =
        provider->content_store().put_if_absent("payloads", raw_payload, yy_storage::parse_content_hash(payload_hash));
    if (!stored.ok()) {
      throw std::runtime_error("fact payload store failed: " + stored.message);
    }
    const auto requested_system_time = int64_or(options.operation_options, "system_time");
    const auto identity_time =
        requested_system_time == 0 ? kungfu::yijinjing::time::now_in_nano() : requested_system_time;
    auto observation_id = text_or(material, "observation_id");
    if (observation_id.empty()) {
      const auto identity = canonical_json({{"type_id", type_id},
                                            {"type_version", type_version},
                                            {"source_id", source_id},
                                            {"subject_key", subject_key},
                                            {"payload_hash", payload_hash},
                                            {"system_time", identity_time}});
      const auto identity_hash = yy_storage::compute_content_hash(identity).value;
      observation_id = "obs-" + identity_hash.substr(0, 24);
    }
    const auto world = object_or_empty(selected, "contract_world");
    nlohmann::json observation = {{"observation_id", observation_id},
                                  {"contract_world_id", required_text(world, "id")},
                                  {"fact_surface_id", type_id},
                                  {"schema_owner_root", required_text(selected, "schema_owner_root")},
                                  {"source_id", source_id},
                                  {"subject_key", subject_key},
                                  {"valid_from", int64_or(material, "valid_from", identity_time)},
                                  {"valid_until", int64_or(material, "valid_until")},
                                  {"payload_hash", payload_hash},
                                  {"payload_ref", "content:payloads/" + payload_hash},
                                  {"action", text_or(material, "action", "assert")},
                                  {"target_observation_id", text_or(material, "target_observation_id")}};
    const auto receipt =
        facts::record_observation(options.runtime_dir, observation, requested_system_time, payload_hash);
    return {{"schema", "kungfu.facts.material-write/v1"},
            {"ok", receipt.at("admission").at("outcome") == "admitted"},
            {"payload_hash", payload_hash},
            {"payload_store", content_result_json(stored)},
            {"receipt", receipt}};
  }

  [[nodiscard]] nlohmann::json fact_material_list(const storage_service_options &options) const {
    auto state = facts::query_fact_state(options.runtime_dir, int64_or(options.operation_options, "cut_system_time"),
                                         text_or(options.operation_options, "subject_key"));
    const auto type_id = text_or(options.operation_options, "type_id");
    auto filter = [&type_id](nlohmann::json rows) {
      if (type_id.empty())
        return rows;
      nlohmann::json selected = nlohmann::json::array();
      for (const auto &row : rows) {
        if (text_or(row, "fact_surface_id") == type_id)
          selected.push_back(row);
      }
      return selected;
    };
    state["canonical_facts"] = filter(array_or_empty(state, "canonical_facts"));
    state["observation_history"] = filter(array_or_empty(state, "observation_history"));
    nlohmann::json payloads = nlohmann::json::object();
    const auto provider = shared_provider(options);
    for (const auto &row : state.at("observation_history")) {
      const auto hash_text = text_or(row, "payload_hash");
      if (hash_text.empty() || payloads.contains(hash_text))
        continue;
      const auto stored = provider->content_store().get("payloads", yy_storage::parse_content_hash(hash_text));
      if (stored.ok()) {
        payloads[hash_text] = nlohmann::json::parse(stored.bytes);
      }
    }
    return {{"schema", "kungfu.facts.material-catalog/v1"},
            {"type_id", type_id.empty() ? nlohmann::json(nullptr) : nlohmann::json(type_id)},
            {"state", state},
            {"payloads", payloads}};
  }

  [[nodiscard]] nlohmann::json fact_library_export(const storage_service_options &options) const {
    std::vector<uint64_t> episode_ids;
    std::unordered_set<uint64_t> seen;
    const auto push_episode = [&episode_ids, &seen](uint64_t episode_id) {
      if (episode_id != 0 && seen.insert(episode_id).second)
        episode_ids.push_back(episode_id);
    };
    const auto types = fact_type_list(options);
    for (const auto &world : array_or_empty(types, "contract_worlds"))
      push_episode(uint64_or(world, "episode_id"));
    for (const auto &type : array_or_empty(types, "fact_types"))
      push_episode(uint64_or(type, "episode_id"));
    const auto materials = fact_material_list(options);
    const auto state = object_or_empty(materials, "state");
    for (const auto &row : array_or_empty(state, "observation_history"))
      push_episode(uint64_or(row, "episode_id"));
    const auto assessments = trust::list_assessments(options.runtime_dir);
    for (const auto &row : array_or_empty(assessments, "assessments")) {
      push_episode(uint64_or(row, "parent_episode_id"));
      push_episode(uint64_or(row, "assessment_episode_id"));
    }
    nlohmann::json bundles = nlohmann::json::array();
    uint64_t missing_frame_count = 0;
    uint64_t missing_ref_payload_count = 0;
    bool episodes_self_contained = true;
    for (const auto episode_id : episode_ids) {
      auto export_options = options;
      export_options.scope = "episode";
      export_options.episode_id = episode_id;
      export_options.operation_options["episode_id"] = episode_id;
      auto rendered = render_storage_episode_bundle_result(episode_export_bundle_typed_impl(export_options));
      const auto material = object_or_empty(rendered, "material");
      missing_frame_count += uint64_or(material, "missing_frame_count");
      missing_ref_payload_count += uint64_or(material, "missing_ref_payload_count");
      episodes_self_contained = episodes_self_contained && bool_or(rendered, "self_contained", false);
      bundles.push_back(std::move(rendered));
    }
    const auto thin = bool_or(options.operation_options, "thin", false);
    const auto self_contained = !thin && episodes_self_contained;
    return {{"schema", "kungfu.facts.library-bundle/v1"},
            {"mode", thin ? "thin" : "full"},
            {"self_contained", self_contained},
            {"semantic_profile", "declared-facts-v1"},
            {"episode_count", bundles.size()},
            {"material",
             {{"missing_frame_count", missing_frame_count}, {"missing_ref_payload_count", missing_ref_payload_count}}},
            {"episodes", bundles},
            {"catalog", types},
            {"assessments", assessments}};
  }

  [[nodiscard]] nlohmann::json fact_library_import(const storage_service_options &options) const {
    const auto bundle = object_or_empty(options.operation_options, "library_bundle");
    if (text_or(bundle, "schema") != "kungfu.facts.library-bundle/v1") {
      throw std::invalid_argument("fact_library_bundle_invalid");
    }
    const auto dry_run = bool_or(options.operation_options, "dry_run", true);
    auto episodes = array_or_empty(bundle, "episodes");
    std::sort(episodes.begin(), episodes.end(), [](const auto &left, const auto &right) {
      const auto left_manifest = object_or_empty(left, "manifest");
      const auto right_manifest = object_or_empty(right, "manifest");
      return std::pair{int64_or(left_manifest, "begin_time"), uint64_or(left_manifest, "episode_id")} <
             std::pair{int64_or(right_manifest, "begin_time"), uint64_or(right_manifest, "episode_id")};
    });
    nlohmann::json preflight_receipts = nlohmann::json::array();
    bool ok = true;
    for (const auto &episode : episodes) {
      auto import_options = options;
      import_options.scope = "episode";
      import_options.bundle = episode;
      import_options.dry_run = true;
      const auto receipt = episode_import_bundle_impl(import_options);
      ok = ok && receipt.value("ok", false);
      preflight_receipts.push_back(receipt);
    }
    if (dry_run || !ok) {
      return {{"schema", "kungfu.facts.library-import/v1"},
              {"ok", ok},
              {"dry_run", true},
              {"source_mode", text_or(bundle, "mode")},
              {"receipt_count", preflight_receipts.size()},
              {"receipts", preflight_receipts}};
    }
    nlohmann::json receipts = nlohmann::json::array();
    for (const auto &episode : episodes) {
      auto import_options = options;
      import_options.scope = "episode";
      import_options.bundle = episode;
      import_options.dry_run = false;
      const auto receipt = episode_import_bundle_impl(import_options);
      ok = ok && receipt.value("ok", false);
      receipts.push_back(receipt);
      if (!receipt.value("ok", false))
        break;
    }
    return {{"schema", "kungfu.facts.library-import/v1"},
            {"ok", ok},
            {"dry_run", false},
            {"source_mode", text_or(bundle, "mode")},
            {"receipt_count", receipts.size()},
            {"receipts", receipts},
            {"preflight_receipts", preflight_receipts}};
  }

  [[nodiscard]] nlohmann::json assessment_contract(const storage_service_options &options) const {
    (void)options;
    return trust::assessment_contract_json();
  }

  [[nodiscard]] nlohmann::json assessment_request(const storage_service_options &options) const {
    return trust::request_assessment(options.runtime_dir, object_or_empty(options.operation_options, "request"),
                                     int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json assessment_execute(const storage_service_options &options) const {
    return trust::execute_assessment(options.runtime_dir, text_or(options.operation_options, "assessment_key"),
                                     text_or(options.operation_options, "executor_profile", "process"),
                                     int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json assessment_status(const storage_service_options &options) const {
    return trust::query_assessment(options.runtime_dir, text_or(options.operation_options, "assessment_key"));
  }

  [[nodiscard]] nlohmann::json assessment_list(const storage_service_options &options) const {
    return trust::list_assessments(options.runtime_dir);
  }

  [[nodiscard]] nlohmann::json assessment_invalidate(const storage_service_options &options) const {
    return trust::invalidate_assessment(options.runtime_dir, text_or(options.operation_options, "assessment_key"),
                                        text_or(options.operation_options, "changed_root"),
                                        text_or(options.operation_options, "reason"),
                                        int64_or(options.operation_options, "system_time"));
  }

  [[nodiscard]] nlohmann::json trust_require(const storage_service_options &options) const {
    return trust::require_trust(options.runtime_dir, text_or(options.operation_options, "assessment_key"),
                                text_or(options.operation_options, "purpose"));
  }

  [[nodiscard]] nlohmann::json episode_list(const storage_service_options &options) const {
    return episode_store(options).list(uint64_or(options.operation_options, "location_uid"), options.limit);
  }

  [[nodiscard]] nlohmann::json episode_inspect(const storage_service_options &options) const {
    auto inspected = episode_ref_store(options).store.inspect(options.episode_id);
    auto qualification_options = options;
    qualification_options.scope = "episode";
    const auto fsck = default_storage_service().fsck(parse_storage_fsck_request(qualification_options));
    if (fsck.qualification.has_value())
      inspected["qualification"] = episode_qualification_json(*fsck.qualification);
    return inspected;
  }

  [[nodiscard]] nlohmann::json episode_projection_rebuild(const storage_service_options &options) const {
    return episode_projection_rebuild_json(episode_manifest_projection(options.runtime_dir).rebuild_typed());
  }

  [[nodiscard]] nlohmann::json source_register(const storage_service_options &options) const {
    return source_registry_record_json(
        source_registry_store(options).register_source(parse_source_register_options(options.operation_options)));
  }

  [[nodiscard]] nlohmann::json source_update_head(const storage_service_options &options) const {
    return source_registry_record_json(
        source_registry_store(options).update_head(parse_source_head_update_options(options.operation_options)));
  }

  [[nodiscard]] nlohmann::json source_record_accepted_range(const storage_service_options &options) const {
    return source_registry_record_json(
        source_registry_store(options).record_accepted_range(parse_accepted_range_options(options.operation_options)));
  }

  [[nodiscard]] nlohmann::json source_list(const storage_service_options &options) const {
    return source_registry_store(options).list();
  }

  [[nodiscard]] nlohmann::json source_inspect(const storage_service_options &options) const {
    return source_registry_store(options).inspect(text_or(options.operation_options, "source_id", options.source_id));
  }

  [[nodiscard]] nlohmann::json source_registry_fsck(const storage_service_options &options) const {
    const auto source_id = text_or(options.operation_options, "source_id", options.source_id);
    const auto journal = source_registry_store(options).fsck_typed(source_id);
    const auto render_issue = [](const yy_storage::source_registry_fsck_issue &issue) {
      nlohmann::json row = {{"code", issue.code}};
      if (issue.source_uid.has_value())
        row["source_uid"] = *issue.source_uid;
      if (issue.source_id.has_value())
        row["source_id"] = *issue.source_id;
      if (issue.count.has_value())
        row["count"] = *issue.count;
      return row;
    };
    nlohmann::json errors = nlohmann::json::array();
    for (const auto &issue : journal.errors)
      errors.push_back(render_issue(issue));
    nlohmann::json warnings = nlohmann::json::array();
    for (const auto &issue : journal.warnings)
      warnings.push_back(render_issue(issue));
    const auto projection = source_registry_projection(options.runtime_dir).verify_typed();
    // KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5: fsck verifies journal + projection. The journal is the
    // authority; a rebuildable projection that has drifted from it is degraded,
    // not failed.
    const bool projection_degraded = projection.status == "degraded";
    return {{"ok", journal.ok && !projection_degraded},
            {"status", !journal.ok ? "failed" : (projection_degraded ? "degraded" : "ok")},
            {"schema", journal.schema},
            {"runtime_dir", journal.runtime_dir},
            {"authority", journal.authority},
            {"errors", std::move(errors)},
            {"warnings", std::move(warnings)},
            {"checked", {{"source_registry_records", journal.source_registry_records}, {"sources", journal.sources}}},
            {"projection", projection_verification_json(projection)}};
  }

  [[nodiscard]] nlohmann::json source_registry_rebuild(const storage_service_options &options) const {
    return projection_rebuild_json(source_registry_projection(options.runtime_dir).rebuild_typed());
  }
};

const file_storage_json_edge_service &storage_json_edge_service_instance() {
  static const file_storage_json_edge_service service;
  return service;
}

nlohmann::json dispatch_json_edge_operation(storage_operation operation, const storage_service_options &options) {
  const auto &parsed_options = options;
  switch (operation) {
  case storage_operation::Status:
    return storage_json_edge_service_instance().status(parsed_options);
  case storage_operation::Fsck:
    return storage_json_edge_service_instance().fsck(parsed_options);
  case storage_operation::RepairPlan:
    return storage_json_edge_service_instance().repair_plan(parsed_options);
  case storage_operation::RepairFetch:
    return storage_json_edge_service_instance().repair_fetch(parsed_options);
  case storage_operation::RepairApply:
    return storage_json_edge_service_instance().repair_apply(parsed_options);
  case storage_operation::ExportBundle:
    return storage_json_edge_service_instance().export_bundle(parsed_options);
  case storage_operation::ImportBundle:
    return storage_json_edge_service_instance().import_bundle(parsed_options);
  case storage_operation::EpisodeAdmission:
    return storage_json_edge_service_instance().episode_admission(parsed_options);
  case storage_operation::RebuildIndex:
    return storage_json_edge_service_instance().rebuild_index(parsed_options);
  case storage_operation::GcPlan:
    return storage_json_edge_service_instance().gc_plan(parsed_options);
  case storage_operation::CompactPlan:
    return storage_json_edge_service_instance().compact_plan(parsed_options);
  case storage_operation::VerifySync:
    return storage_json_edge_service_instance().verify_sync(parsed_options);
  case storage_operation::BackendStatus:
  case storage_operation::BackendSwitch:
  case storage_operation::BackendRollback:
    return dispatch_backend_operation(operation, parsed_options);
  case storage_operation::Query:
    return render_storage_query_result(default_storage_service().query(parse_storage_query_request(parsed_options)));
  case storage_operation::QueryPlan:
    return storage_json_edge_service_instance().query_plan(parsed_options);
  case storage_operation::FactQuery:
    return storage_json_edge_service_instance().fact_query(parsed_options);
  case storage_operation::FactChangelog:
    return storage_json_edge_service_instance().fact_changelog(parsed_options);
  case storage_operation::SavedQueryCatalog:
    return storage_json_edge_service_instance().saved_query_catalog(parsed_options);
  case storage_operation::ProfileLifecycle:
    return storage_json_edge_service_instance().profile_lifecycle(parsed_options);
  case storage_operation::ActionRuntime:
    return storage_json_edge_service_instance().action_runtime(parsed_options);
  case storage_operation::KfxRuntime:
    return storage_json_edge_service_instance().kfx_runtime(parsed_options);
  case storage_operation::FactKernel:
    return storage_json_edge_service_instance().fact_kernel(parsed_options);
  case storage_operation::FactContract:
    return storage_json_edge_service_instance().fact_contract(parsed_options);
  case storage_operation::FactDeclareWorld:
    return storage_json_edge_service_instance().fact_declare_world(parsed_options);
  case storage_operation::FactDeclareSurface:
    return storage_json_edge_service_instance().fact_declare_surface(parsed_options);
  case storage_operation::FactObserve:
    return storage_json_edge_service_instance().fact_observe(parsed_options);
  case storage_operation::FactState:
    return storage_json_edge_service_instance().fact_state(parsed_options);
  case storage_operation::FactLibraryContract:
    return storage_json_edge_service_instance().fact_library_contract(parsed_options);
  case storage_operation::FactTypeCreate:
    return storage_json_edge_service_instance().fact_type_create(parsed_options);
  case storage_operation::FactTypeList:
    return storage_json_edge_service_instance().fact_type_list(parsed_options);
  case storage_operation::FactMaterialPut:
    return storage_json_edge_service_instance().fact_material_put(parsed_options);
  case storage_operation::FactMaterialList:
    return storage_json_edge_service_instance().fact_material_list(parsed_options);
  case storage_operation::FactLibraryExport:
    return storage_json_edge_service_instance().fact_library_export(parsed_options);
  case storage_operation::FactLibraryImport:
    return storage_json_edge_service_instance().fact_library_import(parsed_options);
  case storage_operation::AssessmentContract:
    return storage_json_edge_service_instance().assessment_contract(parsed_options);
  case storage_operation::AssessmentRequest:
    return storage_json_edge_service_instance().assessment_request(parsed_options);
  case storage_operation::AssessmentExecute:
    return storage_json_edge_service_instance().assessment_execute(parsed_options);
  case storage_operation::AssessmentStatus:
    return storage_json_edge_service_instance().assessment_status(parsed_options);
  case storage_operation::AssessmentList:
    return storage_json_edge_service_instance().assessment_list(parsed_options);
  case storage_operation::AssessmentInvalidate:
    return storage_json_edge_service_instance().assessment_invalidate(parsed_options);
  case storage_operation::TrustRequire:
    return storage_json_edge_service_instance().trust_require(parsed_options);
  case storage_operation::Layout:
    return storage_json_edge_service_instance().layout(parsed_options);
  case storage_operation::EpisodeBegin:
  case storage_operation::EpisodeHeartbeat:
  case storage_operation::EpisodeEnd:
  case storage_operation::EpisodeAbort:
  case storage_operation::EpisodeAttachFrame:
  case storage_operation::EpisodeAttachRef:
  case storage_operation::EpisodeRecover:
  case storage_operation::EpisodeRecoveryPlan:
  case storage_operation::EpisodeRecoveryExecute:
    return dispatch_episode_control_operation(operation, parsed_options);
  case storage_operation::EpisodeList:
    return storage_json_edge_service_instance().episode_list(parsed_options);
  case storage_operation::EpisodeInspect:
    return storage_json_edge_service_instance().episode_inspect(parsed_options);
  case storage_operation::EpisodeProjectionRebuild:
    return storage_json_edge_service_instance().episode_projection_rebuild(parsed_options);
  case storage_operation::SourceRegister:
    return storage_json_edge_service_instance().source_register(parsed_options);
  case storage_operation::SourceUpdateHead:
    return storage_json_edge_service_instance().source_update_head(parsed_options);
  case storage_operation::SourceRecordAcceptedRange:
    return storage_json_edge_service_instance().source_record_accepted_range(parsed_options);
  case storage_operation::SourceList:
    return storage_json_edge_service_instance().source_list(parsed_options);
  case storage_operation::SourceInspect:
    return storage_json_edge_service_instance().source_inspect(parsed_options);
  case storage_operation::SourceRegistryFsck:
    return storage_json_edge_service_instance().source_registry_fsck(parsed_options);
  case storage_operation::SourceRegistryRebuild:
    return storage_json_edge_service_instance().source_registry_rebuild(parsed_options);
  }
  throw std::invalid_argument("unknown storage operation");
}

} // namespace kungfu::runtime::storage_service_api::detail
