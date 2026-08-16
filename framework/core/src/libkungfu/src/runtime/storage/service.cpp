// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/storage/service.h>

#include "service_internal.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <kungfu/runtime/action_recorder.h>
#include <kungfu/runtime/facts/fact_admission.h>
#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/kfx/native_registry.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/runtime/query/fact_query.h>
#include <kungfu/runtime/query/saved_query_catalog.h>
#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/manifest_catalog_projection.h>
#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/runtime/trust/assessment_runtime.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>
#include <kungfu/yijinjing/storage/sync_root.h>
#include <kungfu/yijinjing/time.h>
#include <sqlite3.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace detail {

yy_storage::episode_manifest_store episode_store(const storage_service_options &options) {
  return yy_storage::episode_manifest_store(options.runtime_dir);
}

yy_storage::source_registry_store source_registry_store(const storage_service_options &options) {
  return yy_storage::source_registry_store(options.runtime_dir);
}

nlohmann::json workspace_episode_layout_json(const storage_layout_result &result) {
  auto entries = nlohmann::json::array();
  for (const auto &entry : result.entries) {
    entries.push_back(
        {{"id", entry.id}, {"path", entry.path}, {"persistence", entry.persistence}, {"authority", entry.authority}});
  }
  return {{"schema", result.schema},
          {"owner", result.owner},
          {"layout_version", result.layout_version},
          {"runtime_home", result.runtime_home},
          {"workspace_data_home", result.workspace_data_home},
          {"runtime_home_source", result.runtime_home_source},
          {"runtime_dir", result.runtime_dir},
          {"runtime_dir_is_standard_child", result.runtime_dir_is_standard_child},
          {"config_home", result.config_home},
          {"provider", result.provider},
          {"provider_layout", provider_layout_json(result.provider_layout)},
          {"provider_runtime", provider_runtime_json(result.provider_runtime)},
          {"provider_cache", provider_cache_json(result.provider_cache)},
          {"paths",
           {{"data_home", result.paths.data_home},
            {"workspace_ignore", result.paths.workspace_ignore},
            {"workspace_config", result.paths.workspace_config},
            {"extensions_dir", result.paths.extensions_dir},
            {"runtime_dir", result.paths.runtime_dir},
            {"dataset_dir", result.paths.dataset_dir},
            {"inbox_dir", result.paths.inbox_dir},
            {"backtest_dir", result.paths.backtest_dir},
            {"sealed_episodes_dir", result.paths.sealed_episodes_dir},
            {"project_cuts_dir", result.paths.project_cuts_dir},
            {"journal_dir", result.paths.journal_dir},
            {"db_dir", result.paths.db_dir},
            {"nn_dir", result.paths.nn_dir},
            {"map_dir", result.paths.map_dir},
            {"log_dir", result.paths.log_dir},
            {"ownership_dir", result.paths.ownership_dir},
            {"coordinator_dir", result.paths.coordinator_dir},
            {"skill_manager_dir", result.paths.skill_manager_dir},
            {"agent_session_dir", result.paths.agent_session_dir},
            {"skill_context_dir", result.paths.skill_context_dir},
            {"project_cut_runtime_dir", result.paths.project_cut_runtime_dir},
            {"sources_dir", result.paths.sources_dir},
            {"peers_dir", result.paths.peers_dir},
            {"coordination_dir", result.paths.coordination_dir},
            {"admission_dir", result.paths.admission_dir},
            {"fact_durable_admission_dir", result.paths.fact_durable_admission_dir},
            {"receipts_dir", result.paths.receipts_dir},
            {"legacy_master_dir", result.paths.legacy_master_dir},
            {"storage_dir", result.paths.storage_dir},
            {"source_registry_journal", result.paths.source_registry_journal},
            {"manifest_catalog_journal", result.paths.manifest_catalog_journal},
            {"manifest_entries", result.paths.manifest_entries},
            {"payloads", result.paths.payloads},
            {"schemas", result.paths.schemas},
            {"rocksdb", result.paths.rocksdb},
            {"backend_binding", result.paths.backend_binding},
            {"backend_switch_state", result.paths.backend_switch_state},
            {"backend_switch_receipts", result.paths.backend_switch_receipts},
            {"backend_switch_operation_lock", result.paths.backend_switch_operation_lock},
            {"backend_authority_lock", result.paths.backend_authority_lock},
            {"source_registry_projection", result.paths.source_registry_projection},
            {"manifest_catalog_projection", result.paths.manifest_catalog_projection},
            {"episode_manifest_journal_dir", result.paths.episode_manifest_journal_dir},
            {"episode_manifest_journal", result.paths.episode_manifest_journal},
            {"coordinator_state", result.paths.coordinator_state},
            {"remote_mirrors", result.paths.remote_mirrors},
            {"atlas_store", result.paths.atlas_store}}},
          {"entries", std::move(entries)},
          {"coverage",
           {{"complete", result.coverage.complete},
            {"checked_roots", result.coverage.checked_roots},
            {"unclassified_durable_candidates", result.coverage.unclassified_durable_candidates}}},
          {"episodes",
           {{"authority", result.episodes.authority},
            {"schema", result.episodes.schema},
            {"manifest_namespace", result.episodes.manifest_namespace},
            {"manifest_name", result.episodes.manifest_name},
            {"manifest_journal", result.episodes.manifest_journal},
            {"query_tables", result.episodes.query_tables},
            {"export_schema", result.episodes.export_schema}}},
          {"ownership",
           {{"journal_dir", result.ownership.journal_dir},
            {"episode_manifest_journal", result.ownership.episode_manifest_journal},
            {"storage_dir", result.ownership.storage_dir},
            {"source_registry_journal", result.ownership.source_registry_journal},
            {"manifest_catalog_journal", result.ownership.manifest_catalog_journal},
            {"manifest_entries", result.ownership.manifest_entries},
            {"payloads", result.ownership.payloads},
            {"source_registry_projection", result.ownership.source_registry_projection},
            {"manifest_catalog_projection", result.ownership.manifest_catalog_projection},
            {"rocksdb", result.ownership.rocksdb},
            {"config_home", result.ownership.config_home}}},
          {"notes", result.notes}};
}

nlohmann::json entries_for_manifest(const nlohmann::json &manifest, const nlohmann::json &range_filter = {}) {
  auto entries = array_or_empty(manifest, "entries");
  if (range_filter.is_object() && !range_filter.empty()) {
    entries = yy_storage::filter_storage_manifest_entries(entries, range_filter);
  }
  nlohmann::json result = nlohmann::json::array();
  for (const auto &entry : entries) {
    if (entry.is_object()) {
      result.push_back(entry);
    }
  }
  return result;
}

yy_storage::manifest_catalog_store catalog_store(const std::string &runtime_dir) {
  return yy_storage::manifest_catalog_store(runtime_dir);
}

yy_storage::source_registry_store registry_store(const std::string &runtime_dir) {
  return yy_storage::source_registry_store(runtime_dir);
}

nlohmann::json load_latest_manifest_impl(const std::string &runtime_dir, const storage_provider &provider,
                                         const std::string &source_id) {
  return catalog_store(runtime_dir).latest_manifest(source_id, provider.content_store());
}

storage_projection_status_view source_registry_projection_status(const std::string &runtime_dir) {
  const auto projection = source_registry_projection(runtime_dir);
  return {PROJECTION_SOURCE_REGISTRY, projection.sqlite_path(), true, projection.verify_typed()};
}

storage_projection_status_view manifest_catalog_projection_status(const std::string &runtime_dir) {
  const auto projection = manifest_catalog_projection(runtime_dir);
  return {PROJECTION_MANIFEST_CATALOG, projection.sqlite_path(), true, projection.verify_typed()};
}

nlohmann::json projection_verification_json(const storage_projection_verify_result &report) {
  nlohmann::json rendered = {{"ok", report.ok},
                             {"status", report.status},
                             {"schema", report.schema},
                             {"runtime_dir", report.runtime_dir},
                             {"authority", report.authority},
                             {"projection_present", report.projection_present}};
  if (!report.note.empty()) {
    rendered["note"] = report.note;
  }
  if (report.projection_present) {
    rendered["degraded"] = report.degraded;
    rendered["drift"] = nlohmann::json::array();
    for (const auto &item : report.drift) {
      rendered["drift"].push_back({{"table", item.table},
                                   {"projection_rows", item.projection_rows},
                                   {"journal_distinct", item.journal_distinct},
                                   {"reason", item.reason},
                                   {"projection_digest", item.projection_digest},
                                   {"journal_digest", item.journal_digest}});
    }
    rendered["rows"] = nlohmann::json::object();
    for (const auto &item : report.rows) {
      rendered["rows"][item.table] = item.count;
    }
    rendered["journal_distinct"] = nlohmann::json::object();
    for (const auto &item : report.journal_distinct) {
      rendered["journal_distinct"][item.table] = item.count;
    }
  }
  return rendered;
}

nlohmann::json projection_rebuild_json(const storage_projection_rebuild_result &result) {
  nlohmann::json rows = nlohmann::json::object();
  nlohmann::json journal_records = nlohmann::json::object();
  for (const auto &item : result.rows)
    rows[item.table] = item.count;
  for (const auto &item : result.journal_records)
    journal_records[item.table] = item.count;
  return {{"ok", result.ok},
          {"schema", result.schema},
          {"runtime_dir", result.runtime_dir},
          {"authority", result.authority},
          {"projection", result.projection},
          {"sqlite_path", result.sqlite_path},
          {"rows", std::move(rows)},
          {"journal_records", std::move(journal_records)}};
}

nlohmann::json episode_projection_rebuild_json(const storage_projection_rebuild_result &result) {
  auto rendered = projection_rebuild_json(result);
  uint64_t journal_records = 0;
  uint64_t unknown_records_skipped = 0;
  for (const auto &item : result.journal_records) {
    if (item.table == "episode_manifest_records")
      journal_records = item.count;
    if (item.table == "unknown_records_skipped")
      unknown_records_skipped = item.count;
  }
  rendered["journal_records"] = journal_records;
  rendered["query_records"] = result.query_records;
  rendered["unknown_records_skipped"] = unknown_records_skipped;
  return rendered;
}

nlohmann::json projection_status_json(const storage_projection_status_view &status) {
  auto rendered = projection_verification_json(status.verification);
  rendered["name"] = status.name;
  rendered["path"] = status.path;
  rendered["rebuildable"] = status.rebuildable;
  return rendered;
}

episode_frame_verification verify_episode_frame_claims(const storage_fsck_request &request) {
  namespace yjj = kungfu::yijinjing;
  episode_frame_verification result;
  const auto fold = yy_storage::episode_manifest_store(request.runtime_dir).fold_typed_records();

  auto locator = std::make_shared<yjj::data::locator>(request.runtime_dir, yy_enums::mode::LIVE);
  std::unordered_map<uint32_t, yjj::data::location_ptr> locations_by_uid;
  for (const auto &location : locator->list_locations("*", "*", "*", "*")) {
    locations_by_uid.emplace(location->uid, location);
  }

  struct claim_context {
    uint64_t episode_id = 0;
    bool sealed = false;
    yjj::types::EpisodeFrameAttached claim = {};
  };
  std::map<std::pair<uint32_t, uint32_t>, std::vector<claim_context>> journals;
  for (const auto &[episode_id, view] : fold.episodes) {
    if (request.episode_id != 0 && episode_id != request.episode_id) {
      continue;
    }
    const bool sealed = view.closed && view.close.status == yy_enums::EpisodeStatus::Ended;
    for (size_t position = 0; position < view.frame_indices.size(); ++position) {
      const auto &claim = view.frame_at(position);
      if (claim.frame_uid == 0) {
        continue;
      }
      journals[{claim.source, claim.dest}].push_back({episode_id, sealed, claim});
    }
  }

  auto report_presence_issue = [&result](bool sealed, episode_frame_verification_issue issue) {
    if (sealed) {
      result.errors.push_back(std::move(issue));
    } else {
      result.warnings.push_back(std::move(issue));
      result.degraded = true;
    }
  };

  for (auto &[journal_key, claims] : journals) {
    const auto source_uid = journal_key.first;
    const auto dest_uid = journal_key.second;
    const auto location_iter = locations_by_uid.find(source_uid);
    if (location_iter == locations_by_uid.end()) {
      for (const auto &context : claims) {
        episode_frame_verification_issue issue{};
        issue.code = "episode_frame_location_unknown";
        issue.episode_id = context.episode_id;
        issue.frame_uid = context.claim.frame_uid;
        issue.location_uid = source_uid;
        report_presence_issue(context.sealed, std::move(issue));
      }
      continue;
    }
    const auto &location = location_iter->second;

    std::unordered_map<uint64_t, std::vector<const claim_context *>> wanted;
    for (const auto &context : claims) {
      wanted[context.claim.frame_uid].push_back(&context);
    }

    std::unordered_set<uint64_t> found;
    if (!location->locator->list_page_id(location, dest_uid).empty()) {
      auto reader = std::make_shared<yjj::journal::reader>(true, false, std::make_shared<yjj::journal::bus>(false));
      reader->join(location, dest_uid, 0);
      while (reader->data_available()) {
        const auto frame = reader->current_frame();
        const auto wanted_iter = wanted.find(frame->frame_uid());
        if (wanted_iter != wanted.end() && found.insert(frame->frame_uid()).second) {
          const auto &header = *reinterpret_cast<const yjj::types::frame_header *>(frame->address());
          const auto *payload = static_cast<const uint8_t *>(frame->data_address());
          for (const auto *context : wanted_iter->second) {
            const auto &claim = context->claim;
            std::vector<episode_frame_field_mismatch> fields;
            if (header.carrier_type != claim.carrier_type) {
              fields.push_back({"carrier_type", int64_t{claim.carrier_type}, int64_t{header.carrier_type}});
            }
            if (header.gen_time != claim.gen_time) {
              fields.push_back({"gen_time", claim.gen_time, header.gen_time});
            }
            if (header.trigger_frame_uid != claim.trigger_frame_uid) {
              fields.push_back({"trigger_frame_uid", claim.trigger_frame_uid, header.trigger_frame_uid});
            }
            if (frame->data_length() < claim.data_length) {
              fields.push_back({"data_length", uint64_t{claim.data_length}, uint64_t{frame->data_length()}});
            }
            if (!fields.empty()) {
              episode_frame_verification_issue issue{};
              issue.code = "episode_attached_frame_mismatch";
              issue.episode_id = context->episode_id;
              issue.frame_uid = claim.frame_uid;
              issue.fields = std::move(fields);
              result.errors.push_back(std::move(issue));
              continue;
            }
            if (claim.integrity_version == 0) {
              ++result.verified;
              continue;
            }
            std::string algorithm;
            try {
              algorithm = action::frame_checksum_algorithm_for_integrity_version(claim.integrity_version);
            } catch (const std::exception &) {
              episode_frame_verification_issue issue{};
              issue.code = "episode_frame_integrity_version_unknown";
              issue.episode_id = context->episode_id;
              issue.frame_uid = claim.frame_uid;
              issue.integrity_version = claim.integrity_version;
              report_presence_issue(context->sealed, std::move(issue));
              continue;
            }
            const auto payload_checksum = action::checksum_payload(payload, claim.data_length, algorithm);
            const auto frame_checksum = action::checksum_frame(header, payload, claim.data_length, algorithm);
            if (payload_checksum != claim.payload_checksum || frame_checksum != claim.frame_checksum) {
              episode_frame_verification_issue issue{};
              issue.code = "episode_attached_frame_checksum_mismatch";
              issue.episode_id = context->episode_id;
              issue.frame_uid = claim.frame_uid;
              issue.claimed_payload_checksum = claim.payload_checksum;
              issue.actual_payload_checksum = payload_checksum;
              issue.claimed_frame_checksum = claim.frame_checksum;
              issue.actual_frame_checksum = frame_checksum;
              result.errors.push_back(std::move(issue));
              continue;
            }
            ++result.verified;
          }
        }
        reader->next();
      }
    }
    for (const auto &context : claims) {
      if (found.count(context.claim.frame_uid) == 0) {
        episode_frame_verification_issue issue{};
        issue.code = "episode_attached_frame_missing";
        issue.episode_id = context.episode_id;
        issue.frame_uid = context.claim.frame_uid;
        issue.location_uid = context.claim.source;
        issue.dest = context.claim.dest;
        report_presence_issue(context.sealed, std::move(issue));
      }
    }
  }
  return result;
}

nlohmann::json render_episode_frame_verification_issue(const episode_frame_verification_issue &issue) {
  nlohmann::json row = {{"code", issue.code}, {"episode_id", issue.episode_id}, {"frame_uid", issue.frame_uid}};
  if (issue.location_uid.has_value())
    row["location_uid"] = *issue.location_uid;
  if (issue.dest.has_value())
    row["dest"] = *issue.dest;
  if (issue.integrity_version.has_value())
    row["integrity_version"] = *issue.integrity_version;
  if (!issue.fields.empty()) {
    row["fields"] = nlohmann::json::array();
    for (const auto &field : issue.fields) {
      const auto render_value = [](const episode_frame_field_value &value) {
        return std::visit([](const auto item) { return nlohmann::json(item); }, value);
      };
      row["fields"].push_back(
          {{"field", field.field}, {"claimed", render_value(field.claimed)}, {"actual", render_value(field.actual)}});
    }
  }
  if (issue.claimed_payload_checksum.has_value()) {
    row["claimed_payload_checksum"] = *issue.claimed_payload_checksum;
  }
  if (issue.actual_payload_checksum.has_value())
    row["actual_payload_checksum"] = *issue.actual_payload_checksum;
  if (issue.claimed_frame_checksum.has_value())
    row["claimed_frame_checksum"] = *issue.claimed_frame_checksum;
  if (issue.actual_frame_checksum.has_value())
    row["actual_frame_checksum"] = *issue.actual_frame_checksum;
  return row;
}

std::optional<episode_repair_descriptor> episode_repair_descriptor_for_issue(const episode_qualification_issue &issue) {
  const auto &code = issue.code;
  if (code == "episode_dependency_missing") {
    return episode_repair_descriptor{"fetch_episode", {"source_or_episode_bundle"}};
  }
  if (code == "episode_root_trigger_frame_missing" || code == "episode_trigger_frame_missing") {
    return episode_repair_descriptor{"fetch_frame_or_declare_external_input", {"source_or_episode_bundle"}};
  }
  if (code == "episode_payload_ref_missing" || code == "episode_payload_ref_hash_mismatch") {
    return episode_repair_descriptor{"fetch_payload_by_hash", {"payload_store_or_episode_bundle"}};
  }
  if (code == "episode_attached_frame_missing") {
    return episode_repair_descriptor{"fetch_frame", {"source_or_episode_bundle"}};
  }
  if (code == "episode_projection_absent" || code == "episode_projection_drift") {
    return episode_repair_descriptor{"rebuild_projection", {}};
  }
  return std::nullopt;
}

std::string episode_issue_evidence(const std::string &code) {
  if (code.rfind("episode_payload_ref_", 0) == 0) {
    return "content";
  }
  if (code.rfind("episode_attached_frame_", 0) == 0 || code == "episode_frame_location_unknown" ||
      code == "episode_frame_integrity_version_unknown") {
    return "frames";
  }
  if (code == "episode_dependency_missing" || code == "episode_root_trigger_frame_missing" ||
      code == "episode_trigger_frame_missing") {
    return "causal_closure";
  }
  if (code.rfind("episode_projection_", 0) == 0) {
    return "projection";
  }
  return "manifest_integrity";
}

void append_unique(std::vector<std::string> &values, const std::string &value) {
  if (std::find(values.begin(), values.end(), value) == values.end()) {
    values.push_back(value);
  }
}

episode_qualification_evidence *find_episode_evidence(episode_qualification_result &result, const std::string &name) {
  const auto iter = std::find_if(result.evidence.begin(), result.evidence.end(),
                                 [&name](const auto &entry) { return entry.name == name; });
  return iter == result.evidence.end() ? nullptr : &*iter;
}

const episode_qualification_evidence *find_episode_evidence(const episode_qualification_result &result,
                                                            const std::string &name) {
  const auto iter = std::find_if(result.evidence.begin(), result.evidence.end(),
                                 [&name](const auto &entry) { return entry.name == name; });
  return iter == result.evidence.end() ? nullptr : &*iter;
}

episode_qualification_capability make_episode_capability(const std::string &name,
                                                         std::vector<std::pair<std::string, bool>> requirements) {
  episode_qualification_capability capability;
  capability.name = name;
  capability.safe = true;
  for (const auto &[requirement, satisfied] : requirements) {
    capability.required_evidence.push_back(requirement);
    if (!satisfied) {
      capability.safe = false;
      capability.blocked_by.push_back(requirement);
    }
  }
  return capability;
}

episode_qualification_result make_episode_qualification(uint64_t episode_id,
                                                        const yy_storage::episode_fsck_result &manifest_report,
                                                        const episode_frame_verification *frame_verification,
                                                        const storage_projection_verify_result &projection) {
  episode_qualification_result result;
  result.episode_id = episode_id;
  result.status = manifest_report.status;
  const bool exists = manifest_report.episode.has_value();
  const auto lifecycle = [](const yy_storage::episode_current_view &episode) {
    if (!episode.opened)
      return std::string("dangling");
    if (!episode.closed)
      return std::string("open");
    switch (episode.close.status) {
    case yy_enums::EpisodeStatus::Ended:
      return std::string("ended");
    case yy_enums::EpisodeStatus::Aborted:
      return std::string("aborted");
    case yy_enums::EpisodeStatus::Tombstoned:
      return std::string("tombstoned");
    default:
      return std::string("unknown");
    }
  };
  result.lifecycle = exists ? lifecycle(*manifest_report.episode) : "missing";
  const auto frame_count = exists ? manifest_report.episode->frame_indices.size() : size_t{0};
  size_t payload_ref_count = 0;
  size_t schema_ref_count = 0;
  if (exists) {
    for (size_t position = 0; position < manifest_report.episode->ref_indices.size(); ++position) {
      const auto kind = manifest_report.episode->ref_at(position).ref_kind;
      payload_ref_count += kind == yy_enums::EpisodeRefKind::Payload ? 1 : 0;
      schema_ref_count += kind == yy_enums::EpisodeRefKind::Schema ? 1 : 0;
    }
  }
  const bool frames_checked = frame_verification != nullptr;

  result.evidence = {
      {"manifest_records", exists ? "verified" : "failed", {}},
      {"manifest_integrity", exists ? "verified" : "failed", {}},
      {"causal_closure", exists ? "verified" : "failed", {}},
      {"content", payload_ref_count == 0 ? "not_applicable" : "verified", {}},
      {"frames", frame_count == 0 ? "not_applicable" : (frames_checked ? "verified" : "not_checked"), {}},
      {"schemas", schema_ref_count == 0 ? "not_applicable" : "not_checked", {}},
      {"projection", "not_checked", {}},
  };

  const auto add_issue = [&result](auto detail, const std::string &severity) {
    episode_qualification_issue issue;
    issue.severity = severity;
    issue.code = detail.code;
    issue.evidence = episode_issue_evidence(issue.code);
    issue.detail = std::move(detail);
    result.issues.push_back(issue);
    if (auto *evidence = find_episode_evidence(result, issue.evidence); evidence != nullptr) {
      append_unique(evidence->issue_codes, issue.code);
      if (severity == "error") {
        evidence->state = "failed";
      } else if (severity == "warning" && evidence->state != "failed") {
        evidence->state = "degraded";
      }
    }
  };
  for (const auto &error : manifest_report.errors) {
    add_issue(error, "error");
  }
  for (const auto &warning : manifest_report.warnings) {
    add_issue(warning, "warning");
  }
  if (frame_verification != nullptr) {
    for (const auto &error : frame_verification->errors) {
      add_issue(error, "error");
    }
    for (const auto &warning : frame_verification->warnings) {
      add_issue(warning, "warning");
    }
  }

  const auto &projection_status = projection.status;
  if (auto *evidence = find_episode_evidence(result, "projection"); evidence != nullptr) {
    if (!exists) {
      evidence->state = "not_applicable";
    } else if (projection_status == "ok") {
      evidence->state = "verified";
    } else if (projection_status == "absent") {
      evidence->state = "missing";
      auto issue = projection;
      issue.status = "absent";
      episode_qualification_issue qualification_issue{"info", "episode_projection_absent", "projection",
                                                      std::move(issue)};
      result.issues.push_back(std::move(qualification_issue));
      append_unique(evidence->issue_codes, "episode_projection_absent");
    } else if (projection_status == "degraded") {
      evidence->state = "degraded";
      result.issues.push_back({"warning", "episode_projection_drift", "projection", projection});
      append_unique(evidence->issue_codes, "episode_projection_drift");
    } else {
      evidence->state = "failed";
      result.issues.push_back({"error", "episode_projection_unavailable", "projection", projection});
      append_unique(evidence->issue_codes, "episode_projection_unavailable");
    }
  }

  const bool frame_failed = frame_verification != nullptr && !frame_verification->errors.empty();
  const bool degraded = manifest_report.degraded || (frame_verification != nullptr && frame_verification->degraded) ||
                        projection_status == "degraded";
  result.status = (!manifest_report.ok || frame_failed) ? "failed" : (degraded ? "degraded" : "ok");

  const auto state = [&result](const std::string &name) {
    const auto *evidence = find_episode_evidence(result, name);
    return evidence == nullptr ? std::string("missing") : evidence->state;
  };
  const auto verified = [&state](const std::string &name) { return state(name) == "verified"; };
  const auto verified_or_not_applicable = [&state](const std::string &name) {
    const auto value = state(name);
    return value == "verified" || value == "not_applicable";
  };
  const bool records_readable = verified("manifest_records");
  const bool manifest_valid = verified("manifest_integrity");
  result.capabilities = {
      make_episode_capability("inspect", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("fsck", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("export_evidence", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("plan_repair", {{"manifest_records=verified", records_readable}}),
      make_episode_capability("rebuild_projection", {{"manifest_records=verified", records_readable},
                                                     {"manifest_integrity=verified", manifest_valid}}),
      make_episode_capability("append", {{"lifecycle=open", result.lifecycle == "open"},
                                         {"manifest_records=verified", records_readable},
                                         {"manifest_integrity=verified", manifest_valid}}),
      make_episode_capability("replay", {{"lifecycle=ended", result.lifecycle == "ended"},
                                         {"manifest_records=verified", records_readable},
                                         {"manifest_integrity=verified", manifest_valid},
                                         {"causal_closure=verified", verified("causal_closure")},
                                         {"content=verified|not_applicable", verified_or_not_applicable("content")},
                                         {"frames=verified|not_applicable", verified_or_not_applicable("frames")},
                                         {"schemas=verified|not_applicable", verified_or_not_applicable("schemas")}}),
      make_episode_capability("depend_on",
                              {{"lifecycle=ended", result.lifecycle == "ended"},
                               {"manifest_records=verified", records_readable},
                               {"manifest_integrity=verified", manifest_valid},
                               {"causal_closure=verified", verified("causal_closure")},
                               {"content=verified|not_applicable", verified_or_not_applicable("content")},
                               {"frames=verified|not_applicable", verified_or_not_applicable("frames")},
                               {"schemas=verified|not_applicable", verified_or_not_applicable("schemas")}}),
  };

  for (const auto &issue : result.issues) {
    const auto descriptor = episode_repair_descriptor_for_issue(issue);
    if (!descriptor.has_value()) {
      continue;
    }
    episode_repair_subject subject{};
    std::visit(
        [&subject](const auto &detail) {
          using detail_t = std::decay_t<decltype(detail)>;
          if constexpr (std::is_same_v<detail_t, yy_storage::episode_fsck_issue>) {
            subject.episode_id = detail.episode_id;
            subject.dependency_episode_id = detail.dependency_episode_id;
            subject.frame_uid = detail.frame_uid;
            subject.dependent_frame_uid = detail.dependent_frame_uid;
            subject.ref_id = detail.ref_id;
            subject.ref_hash = detail.ref_hash;
            subject.role = detail.role;
          } else if constexpr (std::is_same_v<detail_t, episode_frame_verification_issue>) {
            subject.episode_id = detail.episode_id;
            subject.frame_uid = detail.frame_uid;
          }
        },
        issue.detail);
    result.repair_prerequisites.push_back({issue.code, descriptor->action, descriptor->required_inputs, subject});
  }
  return result;
}

nlohmann::json episode_qualification_issue_detail_json(const episode_qualification_issue &issue) {
  return std::visit(
      [&issue](const auto &detail) {
        using detail_t = std::decay_t<decltype(detail)>;
        if constexpr (std::is_same_v<detail_t, yy_storage::episode_fsck_issue>) {
          return yy_storage::render_episode_fsck_issue(detail);
        } else if constexpr (std::is_same_v<detail_t, episode_frame_verification_issue>) {
          return render_episode_frame_verification_issue(detail);
        } else {
          nlohmann::json rendered = {{"code", issue.code}, {"status", detail.status}};
          if (issue.code == "episode_projection_drift") {
            rendered["drift"] = nlohmann::json::array();
            for (const auto &item : detail.drift) {
              rendered["drift"].push_back({{"table", item.table},
                                           {"projection_rows", item.projection_rows},
                                           {"journal_distinct", item.journal_distinct},
                                           {"reason", item.reason},
                                           {"projection_digest", item.projection_digest},
                                           {"journal_digest", item.journal_digest}});
            }
          }
          return rendered;
        }
      },
      issue.detail);
}

nlohmann::json episode_repair_subject_json(const episode_repair_subject &subject) {
  nlohmann::json rendered = nlohmann::json::object();
  if (subject.episode_id.has_value())
    rendered["episode_id"] = *subject.episode_id;
  if (subject.dependency_episode_id.has_value())
    rendered["dependency_episode_id"] = *subject.dependency_episode_id;
  if (subject.frame_uid.has_value())
    rendered["frame_uid"] = *subject.frame_uid;
  if (subject.dependent_frame_uid.has_value())
    rendered["dependent_frame_uid"] = *subject.dependent_frame_uid;
  if (subject.ref_id.has_value())
    rendered["ref_id"] = *subject.ref_id;
  if (subject.ref_hash.has_value())
    rendered["ref_hash"] = *subject.ref_hash;
  if (subject.role.has_value())
    rendered["role"] = *subject.role;
  return rendered;
}

nlohmann::json episode_qualification_json(const episode_qualification_result &result) {
  nlohmann::json evidence = nlohmann::json::object();
  for (const auto &entry : result.evidence) {
    evidence[entry.name] = {{"state", entry.state}, {"issue_codes", entry.issue_codes}};
  }
  nlohmann::json issues = nlohmann::json::array();
  for (const auto &issue : result.issues) {
    issues.push_back({{"severity", issue.severity},
                      {"code", issue.code},
                      {"evidence", issue.evidence},
                      {"detail", episode_qualification_issue_detail_json(issue)}});
  }
  nlohmann::json capabilities = nlohmann::json::array();
  nlohmann::json safe_capabilities = nlohmann::json::array();
  nlohmann::json contractions = nlohmann::json::array();
  for (const auto &capability : result.capabilities) {
    capabilities.push_back({{"name", capability.name},
                            {"safe", capability.safe},
                            {"requires", capability.required_evidence},
                            {"blocked_by", capability.blocked_by}});
    if (capability.safe) {
      safe_capabilities.push_back(capability.name);
    } else {
      contractions.push_back({{"capability", capability.name}, {"blocked_by", capability.blocked_by}});
    }
  }
  nlohmann::json repair_prerequisites = nlohmann::json::array();
  for (const auto &prerequisite : result.repair_prerequisites) {
    repair_prerequisites.push_back({{"issue_code", prerequisite.issue_code},
                                    {"action", prerequisite.action},
                                    {"required_inputs", prerequisite.required_inputs},
                                    {"subject", episode_repair_subject_json(prerequisite.subject)}});
  }
  return {{"schema", EPISODE_QUALIFICATION_SCHEMA_V1},
          {"policy_source", "cpp-typed-fold-fsck"},
          {"episode_id", result.episode_id},
          {"lifecycle", result.lifecycle},
          {"status", result.status},
          {"evidence", evidence},
          {"issues", issues},
          {"capabilities", capabilities},
          {"safe_capabilities", safe_capabilities},
          {"contractions", contractions},
          {"repair_prerequisites", repair_prerequisites}};
}

storage_fsck_result episode_fsck_typed_impl(const storage_fsck_request &request) {
  storage_fsck_result result{};
  result.scope = storage_fsck_scope::Episode;
  if (request.episode_id != 0)
    result.episode_id = request.episode_id;

  const auto scoped = episode_ref_store(request);
  result.episode_manifest = scoped.store.fsck_typed(request.episode_id);
  result.checked.episode_manifest_records = result.episode_manifest.episode_manifest_records;
  result.checked.episodes = result.episode_manifest.episodes;
  result.checked.projection_indexes = 1;
  for (const auto &error : result.episode_manifest.errors)
    result.issues.push_back({"error", error.code, "episode-manifest", error});
  for (const auto &warning : result.episode_manifest.warnings)
    result.issues.push_back({"warning", warning.code, "episode-manifest", warning});

  const auto projection = episode_manifest_projection(request.runtime_dir);
  storage_projection_status_view projection_status{"episode-manifest-sqlite", projection.sqlite_path(), true,
                                                   projection.verify_typed()};
  if (projection_status.verification.status == "degraded") {
    result.degraded = true;
    result.issues.push_back({"warning", "projection_drift", projection_status.name, projection_status});
  } else if (projection_status.verification.status == "absent") {
    result.issues.push_back({"warning", "projection_absent", projection_status.name, projection_status});
  }
  result.projections.push_back(projection_status);

  if (request.verify_frames) {
    result.frame_verification = verify_episode_frame_claims(request);
    result.checked.episode_frames_verified = result.frame_verification->verified;
    result.degraded = result.degraded || result.frame_verification->degraded;
    for (const auto &error : result.frame_verification->errors)
      result.issues.push_back({"error", error.code, "episode-frames", error});
    for (const auto &warning : result.frame_verification->warnings)
      result.issues.push_back({"warning", warning.code, "episode-frames", warning});
  }
  result.degraded = result.degraded || result.episode_manifest.degraded;
  result.ok = std::none_of(result.issues.begin(), result.issues.end(),
                           [](const auto &issue) { return issue.severity == "error"; });
  result.status = !result.ok ? "failed" : (result.degraded ? "degraded" : "ok");
  if (request.episode_id != 0) {
    result.qualification =
        make_episode_qualification(request.episode_id, result.episode_manifest,
                                   result.frame_verification.has_value() ? &*result.frame_verification : nullptr,
                                   result.projections.front().verification);
  }
  return result;
}

nlohmann::json episode_fsck_impl(const storage_service_options &options) {
  return render_storage_fsck_result(default_storage_service().fsck(parse_storage_fsck_request(options)));
}

// KF-ADR-019f86da-4f90-726e-b31f-ed180aa2e7a8: collect whole Episode frames and content-store payload bytes as one
// migration/recovery unit. Missing source material is counted, never invented.
void collect_episode_bundle_material(const storage_service_options &options, storage_episode_bundle_result &bundle) {
  namespace yjj = kungfu::yijinjing;
  bundle.self_contained = true;

  std::map<std::pair<uint32_t, uint32_t>, std::vector<uint64_t>> wanted_by_journal;
  std::map<std::pair<uint32_t, uint32_t>, std::unordered_set<uint64_t>> seen_by_journal;
  for (const auto index : bundle.manifest.frame_indices) {
    const auto &claim = std::get<yjj::types::EpisodeFrameAttached>(bundle.manifest.records.at(index).body);
    if (claim.frame_uid == 0) {
      continue;
    }
    const auto key = std::make_pair(claim.source, claim.dest);
    if (seen_by_journal[key].insert(claim.frame_uid).second) {
      wanted_by_journal[key].push_back(claim.frame_uid);
    }
  }

  auto locator = std::make_shared<yjj::data::locator>(options.runtime_dir, yy_enums::mode::LIVE);
  std::unordered_map<uint32_t, yjj::data::location_ptr> locations_by_uid;
  for (const auto &location : locator->list_locations("*", "*", "*", "*")) {
    locations_by_uid.emplace(location->uid, location);
  }

  for (const auto &[journal_key, frame_uids] : wanted_by_journal) {
    const auto location_iter = locations_by_uid.find(journal_key.first);
    if (location_iter == locations_by_uid.end()) {
      bundle.material_missing_frame_count += frame_uids.size();
      continue;
    }
    const auto &location = location_iter->second;
    episode_journal_material journal{};
    journal.role = yy_enums::get_location_role_name(location->role);
    journal.namespace_ = location->namespace_;
    journal.name = location->name;
    journal.mode = yy_enums::get_mode_name(location->mode);
    journal.seed = location->seed;
    journal.location_uid = location->uid;
    journal.dest = journal_key.second;
    std::unordered_set<uint64_t> wanted(frame_uids.begin(), frame_uids.end());
    if (!location->locator->list_page_id(location, journal.dest).empty()) {
      auto reader = std::make_shared<yjj::journal::reader>(true, false, std::make_shared<yjj::journal::bus>(false));
      reader->join(location, journal.dest, 0);
      while (reader->data_available()) {
        const auto frame = reader->current_frame();
        const auto wanted_iter = wanted.find(frame->frame_uid());
        if (wanted_iter != wanted.end()) {
          episode_frame_material material{};
          material.frame_uid = frame->frame_uid();
          material.gen_time = frame->gen_time();
          material.carrier_type = frame->carrier_type();
          material.frame_length = static_cast<uint32_t>(frame->frame_length());
          material.data_length = frame->data_length();
          material.bytes.assign(reinterpret_cast<const char *>(frame->address()), frame->frame_length());
          journal.frames.push_back(std::move(material));
          wanted.erase(wanted_iter);
        }
        reader->next();
      }
    }
    bundle.material_missing_frame_count += wanted.size();
    if (!journal.frames.empty()) {
      bundle.journals.push_back(std::move(journal));
    }
  }

  const auto provider = shared_provider(options);
  std::unordered_set<std::string> exported_hashes;
  for (const auto index : bundle.manifest.ref_indices) {
    const auto &claim = std::get<yjj::types::EpisodeRefAttached>(bundle.manifest.records.at(index).body);
    if (claim.ref_kind != yy_enums::EpisodeRefKind::Payload && claim.ref_kind != yy_enums::EpisodeRefKind::Schema) {
      continue;
    }
    const auto content_namespace =
        claim.ref_kind == yy_enums::EpisodeRefKind::Schema ? std::string("schemas") : std::string("payloads");
    const auto ref_hash = fixed_string(claim.ref_hash);
    const auto content_key = content_namespace + "\n" + ref_hash;
    if (ref_hash.empty() || !exported_hashes.insert(content_key).second) {
      continue;
    }
    yy_storage::content_hash parsed_hash{};
    try {
      parsed_hash = ref_hash.find(':') == std::string::npos ? yy_storage::make_content_hash(ref_hash)
                                                            : yy_storage::parse_content_hash(ref_hash);
    } catch (const std::exception &) {
      ++bundle.material_missing_ref_payload_count;
      continue;
    }
    const auto stored = provider->content_store().get(content_namespace, parsed_hash);
    if (!stored.ok()) {
      ++bundle.material_missing_ref_payload_count;
      continue;
    }
    episode_ref_payload_material material{};
    material.content_namespace = content_namespace;
    material.ref_hash = ref_hash;
    material.bytes = stored.bytes;
    material.byte_len = material.bytes.size();
    bundle.ref_payloads.push_back(std::move(material));
  }
}

storage_episode_bundle_result episode_export_bundle_typed_impl(const storage_service_options &options) {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required for episode export");
  }
  const auto scoped = episode_ref_store(options);
  const auto inspected = scoped.store.inspect_typed(options.episode_id);
  storage_episode_bundle_result bundle{"episode:" + std::to_string(options.episode_id), options.episode_id,
                                       inspected.episode, inspected.causal_graph};
  if (!bool_or(options.operation_options, "thin", false)) {
    collect_episode_bundle_material(options, bundle);
  }
  return bundle;
}

nlohmann::json fsck_impl(const storage_service_options &options);
nlohmann::json episode_import_bundle_impl(const storage_service_options &options);
nlohmann::json accept_storage_manifest_impl(const std::string &runtime_dir, const nlohmann::json &input);
nlohmann::json export_bundle_generic_impl(const storage_service_options &options, bool record_receipt);
nlohmann::json render_manifest_entry_view(const yy_storage::manifest_entry_view &entry);
nlohmann::json render_manifest_document(const yy_storage::manifest_document_view &manifest);
nlohmann::json render_storage_export_bundle_result(const storage_export_bundle_result &result);
storage_export_bundle_result parse_storage_export_bundle(const nlohmann::json &bundle);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeOpen &record);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeHeartbeat &record);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeFrameAttached &record);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRefAttached &record);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeClosed &record);
nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRootCommitted &record);
nlohmann::json render_episode_close_write_result(const yy_storage::episode_close_write_result &result);
nlohmann::json render_episode_recover_result(const yy_storage::episode_recover_result &result);
nlohmann::json episode_record_row_json(const yy_storage::episode_manifest_record &record);
nlohmann::json render_storage_episode_bundle_result(const storage_episode_bundle_result &result);

nlohmann::json episode_export_bundle_impl(const storage_service_options &options) {
  return render_storage_episode_bundle_result(episode_export_bundle_typed_impl(options));
}

nlohmann::json replace_string_subtree(nlohmann::json value, const std::string &needle, const std::string &replacement) {
  if (needle.empty()) {
    return value;
  }
  if (value.is_string()) {
    auto text = value.get<std::string>();
    size_t pos = 0;
    while ((pos = text.find(needle, pos)) != std::string::npos) {
      text.replace(pos, needle.size(), replacement);
      pos += replacement.size();
    }
    return text;
  }
  if (value.is_array()) {
    for (auto &item : value) {
      item = replace_string_subtree(item, needle, replacement);
    }
    return value;
  }
  if (value.is_object()) {
    for (auto &[_, item] : value.items()) {
      item = replace_string_subtree(item, needle, replacement);
    }
    return value;
  }
  return value;
}

storage_source_registry_view source_registry_status_view(const yy_storage::source_registry_current_view &source) {
  storage_source_registry_view result{};
  result.source_uid = source.source_uid;
  result.registered = source.registered;
  result.record_count = source.records.size();
  result.accepted_range_count = source.accepted_range_indices.size();
  if (source.registered) {
    result.source_id = fixed_string(source.registration.source_id);
    result.kind = source_kind_text(source.registration.kind);
    result.coordinate = fixed_string(source.registration.coordinate);
    result.head = source.current_head;
    result.location_uid = source.registration.location_uid;
    result.register_time = source.registration.register_time;
  }
  if (source.head_update_seen) {
    result.current_range =
        storage_frame_range_view{source.head_update.first_frame_uid, source.head_update.last_frame_uid,
                                 source.head_update.since, source.head_update.until};
    result.inventory_hash = storage_sync_root_view{fixed_string(source.head_update.inventory_hash_algo),
                                                   fixed_string(source.head_update.inventory_hash)};
    result.update_time = source.head_update.update_time;
  }
  return result;
}

storage_accepted_range_view accepted_range_status_view(const yijinjing::types::ImportManifestAccepted &manifest) {
  return {fixed_string(manifest.source_id),
          fixed_string(manifest.manifest_id),
          {fixed_string(manifest.range_since), fixed_string(manifest.range_until)},
          fixed_string(manifest.source_head),
          {fixed_string(manifest.sync_root_algo), fixed_string(manifest.sync_root_value)},
          manifest.entry_count,
          verification_status_text(manifest.status)};
}

storage_cursor_view cursor_status_view(const yijinjing::types::ChannelCursorUpdated &cursor) {
  return {fixed_string(cursor.source_id),
          fixed_string(cursor.manifest_id),
          fixed_string(cursor.source_head),
          {fixed_string(cursor.range_since), fixed_string(cursor.range_until)},
          {fixed_string(cursor.sync_root_algo), fixed_string(cursor.sync_root_value)},
          cursor.entry_count};
}

nlohmann::json source_registry_record_json(const yijinjing::types::SourceRegistered &record) {
  return {{"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
          {"record_kind", "source_registered"},
          {"schema_version", record.schema_version},
          {"source_uid", record.source_uid},
          {"source_id", fixed_string(record.source_id)},
          {"kind", source_kind_text(record.kind)},
          {"coordinate", fixed_string(record.coordinate)},
          {"head", fixed_string(record.head)},
          {"location_uid", record.location_uid},
          {"register_time", record.register_time}};
}

nlohmann::json source_registry_record_json(const yijinjing::types::SourceHeadUpdated &record) {
  return {{"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
          {"record_kind", "source_head_updated"},
          {"schema_version", record.schema_version},
          {"source_uid", record.source_uid},
          {"location_uid", record.location_uid},
          {"update_time", record.update_time},
          {"head", fixed_string(record.head)},
          {"range",
           {{"first_frame_uid", record.first_frame_uid},
            {"last_frame_uid", record.last_frame_uid},
            {"since", record.since},
            {"until", record.until}}},
          {"inventory_hash",
           {{"algorithm", fixed_string(record.inventory_hash_algo)}, {"value", fixed_string(record.inventory_hash)}}}};
}

nlohmann::json source_registry_record_json(const yijinjing::types::AcceptedRangeRecorded &record) {
  return {{"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
          {"record_kind", "accepted_range_recorded"},
          {"schema_version", record.schema_version},
          {"source_uid", record.source_uid},
          {"manifest_uid", record.manifest_uid},
          {"source_id", fixed_string(record.source_id)},
          {"manifest_id", fixed_string(record.manifest_id)},
          {"location_uid", record.location_uid},
          {"accept_time", record.accept_time},
          {"range",
           {{"first_frame_uid", record.first_frame_uid},
            {"last_frame_uid", record.last_frame_uid},
            {"since", record.since},
            {"until", record.until}}},
          {"status", verification_status_text(record.status)}};
}

class file_storage_service : public storage_service {
public:
  [[nodiscard]] storage_status_result status(const storage_status_request &request) const override {
    return status_typed_impl(request);
  }

  [[nodiscard]] storage_layout_result layout(const storage_layout_request &request) const override {
    const auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
    return workspace_episode_layout_typed(request, *provider);
  }

  [[nodiscard]] storage_fsck_result fsck(const storage_fsck_request &request) const override {
    return fsck_typed_impl(request);
  }

  [[nodiscard]] storage_repair_plan_result repair_plan(const storage_repair_plan_request &request) const override {
    return repair_plan_typed_impl(request);
  }

  [[nodiscard]] storage_query_result query(const storage_query_request &request) const override {
    return query_journal_projection(request);
  }

  [[nodiscard]] storage_gc_plan_result gc_plan(const storage_gc_plan_request &request) const override {
    return gc_plan_typed_impl(request);
  }

  [[nodiscard]] storage_rebuild_index_result
  rebuild_index(const storage_rebuild_index_request &request) const override {
    return rebuild_index_typed_impl(request);
  }

  [[nodiscard]] storage_compact_plan_result compact_plan(const storage_compact_plan_request &request) const override {
    return compact_plan_typed_impl(request);
  }

  [[nodiscard]] storage_export_bundle_result
  export_bundle(const storage_export_bundle_request &request) const override {
    return export_bundle_typed_impl(request);
  }

  [[nodiscard]] storage_import_bundle_result
  import_bundle(const storage_import_bundle_request &request) const override {
    return import_bundle_typed_impl(request);
  }

  [[nodiscard]] storage_verify_sync_result verify_sync(const storage_verify_sync_request &request) const override {
    return verify_sync_typed_impl(request);
  }

  [[nodiscard]] yijinjing::types::EpisodeOpen
  episode_begin(const storage_episode_begin_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).begin(request.options);
  }

  [[nodiscard]] yijinjing::types::EpisodeHeartbeat
  episode_heartbeat(const storage_episode_heartbeat_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).heartbeat(request.options);
  }

  [[nodiscard]] yijinjing::types::EpisodeFrameAttached
  episode_attach_frame(const storage_episode_frame_attach_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).attach_frame(request.options);
  }

  [[nodiscard]] yijinjing::types::EpisodeRefAttached
  episode_attach_ref(const storage_episode_ref_attach_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).attach_ref(request.options);
  }

  [[nodiscard]] yy_storage::episode_close_write_result
  episode_end(const storage_episode_close_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).end(request.options);
  }

  [[nodiscard]] yy_storage::episode_close_write_result
  episode_abort(const storage_episode_close_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).abort(request.options);
  }

  [[nodiscard]] yy_storage::episode_recover_result
  episode_recover(const storage_episode_recover_request &request) const override {
    return yy_storage::episode_manifest_store(request.runtime_dir).recover(request.options);
  }

  [[nodiscard]] storage_projection_rebuild_result
  episode_projection_rebuild(const storage_episode_projection_rebuild_request &request) const override {
    return episode_manifest_projection(request.runtime_dir).rebuild_typed();
  }

  [[nodiscard]] storage_episode_list_result episode_list(const storage_episode_list_request &request) const override {
    const auto fold = yy_storage::episode_manifest_store(request.runtime_dir).fold_typed_records();
    storage_episode_list_result result{};
    result.runtime_dir = request.runtime_dir;
    result.unknown_record_count = static_cast<uint64_t>(fold.unknown_record_count);
    for (auto iter = fold.episodes.rbegin(); iter != fold.episodes.rend(); ++iter) {
      const auto &view = iter->second;
      const auto location_uid = view.opened ? view.open.location_uid : uint32_t{0};
      if (request.location_uid != 0 && request.location_uid != location_uid)
        continue;
      result.episodes.push_back(view);
      if (request.limit != 0 && result.episodes.size() >= request.limit)
        break;
    }
    return result;
  }

  [[nodiscard]] storage_episode_inspect_result
  episode_inspect(const storage_episode_inspect_request &request) const override {
    const auto inspected = yy_storage::episode_manifest_store(request.runtime_dir).inspect_typed(request.episode_id);
    storage_fsck_request fsck_request{};
    fsck_request.runtime_dir = request.runtime_dir;
    fsck_request.scope = storage_fsck_scope::Episode;
    fsck_request.episode_id = request.episode_id;
    const auto fsck_result = fsck(fsck_request);
    return {true,
            request.runtime_dir,
            "yijinjing-journal",
            inspected.episode,
            inspected.content_root,
            inspected.causal_graph,
            inspected.unknown_record_count,
            fsck_result.qualification};
  }

  [[nodiscard]] yijinjing::types::SourceRegistered
  source_register(const storage_source_register_request &request) const override {
    return yy_storage::source_registry_store(request.runtime_dir).register_source(request.options);
  }

  [[nodiscard]] yijinjing::types::SourceHeadUpdated
  source_update_head(const storage_source_head_update_request &request) const override {
    return yy_storage::source_registry_store(request.runtime_dir).update_head(request.options);
  }

  [[nodiscard]] yijinjing::types::AcceptedRangeRecorded
  source_record_accepted_range(const storage_source_accepted_range_request &request) const override {
    return yy_storage::source_registry_store(request.runtime_dir).record_accepted_range(request.options);
  }

  [[nodiscard]] storage_source_list_result source_list(const storage_source_list_request &request) const override {
    const auto fold = yy_storage::source_registry_store(request.runtime_dir).fold_typed_records();
    storage_source_list_result result{};
    result.runtime_dir = request.runtime_dir;
    result.unknown_record_count = static_cast<uint64_t>(fold.unknown_record_count);
    result.sources.reserve(fold.sources.size());
    for (const auto &[source_uid, source] : fold.sources) {
      (void)source_uid;
      result.sources.push_back(source);
    }
    return result;
  }

  [[nodiscard]] storage_source_inspect_result
  source_inspect(const storage_source_inspect_request &request) const override {
    const auto store = yy_storage::source_registry_store(request.runtime_dir);
    const auto source = store.inspect_typed(request.source_id);
    if (!source.has_value())
      throw std::invalid_argument("source not found: " + request.source_id);
    const auto fold = store.fold_typed_records();
    return {true, request.runtime_dir, "yijinjing-journal", *source, static_cast<uint64_t>(fold.unknown_record_count)};
  }

  [[nodiscard]] storage_source_registry_fsck_result
  source_registry_fsck(const storage_source_registry_fsck_request &request) const override {
    const auto journal = yy_storage::source_registry_store(request.runtime_dir).fsck_typed(request.source_id);
    const auto projection = source_registry_projection(request.runtime_dir).verify_typed();
    const bool projection_degraded = projection.status == "degraded";
    return {journal.ok && !projection_degraded, !journal.ok ? "failed" : (projection_degraded ? "degraded" : "ok"),
            journal, projection};
  }

  [[nodiscard]] storage_projection_rebuild_result
  source_registry_rebuild(const storage_source_registry_rebuild_request &request) const override {
    return source_registry_projection(request.runtime_dir).rebuild_typed();
  }
};

const file_storage_service &typed_storage_service_instance() {
  static const file_storage_service service;
  return service;
}

const char *episode_status_text(yy_enums::EpisodeStatus status) {
  switch (status) {
  case yy_enums::EpisodeStatus::Open:
    return "open";
  case yy_enums::EpisodeStatus::Ended:
    return "ended";
  case yy_enums::EpisodeStatus::Aborted:
    return "aborted";
  case yy_enums::EpisodeStatus::Tombstoned:
    return "tombstoned";
  }
  return "unknown";
}

const char *episode_ref_kind_text(yy_enums::EpisodeRefKind kind) {
  switch (kind) {
  case yy_enums::EpisodeRefKind::InputFrame:
    return "input_frame";
  case yy_enums::EpisodeRefKind::Payload:
    return "payload";
  case yy_enums::EpisodeRefKind::Schema:
    return "schema";
  case yy_enums::EpisodeRefKind::Episode:
    return "episode";
  }
  return "unknown";
}

template <typename T> nlohmann::json episode_base_record_json(const char *kind, const T &record) {
  return {{"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
          {"record_kind", kind},
          {"schema_version", record.schema_version},
          {"episode_id", record.episode_id},
          {"location_uid", record.location_uid}};
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeOpen &record) {
  auto row = episode_base_record_json("episode_open", record);
  row["status"] = episode_status_text(yy_enums::EpisodeStatus::Open);
  row["parent_episode_id"] = record.parent_episode_id;
  row["root_trigger_frame_uid"] = record.root_trigger_frame_uid;
  row["begin_time"] = record.begin_time;
  row["title"] = fixed_string(record.title);
  row["actor"] = fixed_string(record.actor);
  row["source"] = fixed_string(record.source);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeHeartbeat &record) {
  auto row = episode_base_record_json("episode_heartbeat", record);
  row["update_time"] = record.update_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["note"] = fixed_string(record.note);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeFrameAttached &record) {
  auto row = episode_base_record_json("episode_frame_attached", record);
  row["frame_uid"] = record.frame_uid;
  row["trigger_frame_uid"] = record.trigger_frame_uid;
  row["stream_id"] = record.stream_id;
  row["gen_time"] = record.gen_time;
  row["trigger_time"] = record.trigger_time;
  row["carrier_type"] = record.carrier_type;
  row["source"] = record.source;
  row["dest"] = record.dest;
  row["data_length"] = record.data_length;
  row["integrity_version"] = record.integrity_version;
  row["payload_checksum"] = record.payload_checksum;
  row["frame_checksum"] = record.frame_checksum;
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRefAttached &record) {
  auto row = episode_base_record_json("episode_ref_attached", record);
  row["ref_kind"] = episode_ref_kind_text(record.ref_kind);
  row["ref_uid"] = record.ref_uid;
  row["update_time"] = record.update_time;
  row["ref_id"] = fixed_string(record.ref_id);
  row["ref_hash"] = fixed_string(record.ref_hash);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeClosed &record) {
  auto row = episode_base_record_json("episode_closed", record);
  row["status"] = episode_status_text(record.status);
  row["end_time"] = record.end_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["reason"] = fixed_string(record.reason);
  return row;
}

nlohmann::json episode_record_body_json(const yijinjing::types::EpisodeRootCommitted &record) {
  auto row = episode_base_record_json("episode_root_committed", record);
  row["commit_time"] = record.commit_time;
  row["covered_record_count"] = record.covered_record_count;
  row["algorithm"] = fixed_string(record.algorithm);
  row["root_value"] = fixed_string(record.root_value);
  return row;
}

nlohmann::json render_episode_close_write_result(const yy_storage::episode_close_write_result &result) {
  auto rendered = episode_record_body_json(result.close);
  if (result.content_root.has_value()) {
    rendered["content_root"] = episode_record_body_json(*result.content_root);
  }
  return rendered;
}

nlohmann::json render_episode_recover_result(const yy_storage::episode_recover_result &result) {
  nlohmann::json recovered = nlohmann::json::array();
  for (const auto &item : result.recovered)
    recovered.push_back(render_episode_close_write_result(item));
  nlohmann::json skipped = nlohmann::json::array();
  for (const auto &item : result.skipped_open)
    skipped.push_back({{"episode_id", item.episode_id}, {"location_uid", item.location_uid}});
  return {{"ok", true},
          {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", result.runtime_dir},
          {"authority", "yijinjing-journal"},
          {"recovered", std::move(recovered)},
          {"recovered_count", result.recovered.size()},
          {"skipped_open", std::move(skipped)},
          {"skipped_count", result.skipped_open.size()}};
}

nlohmann::json episode_record_row_json(const yy_storage::episode_manifest_record &record) {
  auto row = std::visit(
      [&record](const auto &body) -> nlohmann::json {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, yy_storage::episode_manifest_unknown_record>) {
          return {{"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                  {"record_kind", "unknown"},
                  {"carrier_type", body.carrier_type},
                  {"frame_uid", record.manifest_frame_uid},
                  {"gen_time", record.manifest_gen_time}};
        } else {
          return episode_record_body_json(body);
        }
      },
      record.body);
  row["manifest_frame_uid"] = record.manifest_frame_uid;
  row["manifest_gen_time"] = record.manifest_gen_time;
  return row;
}

nlohmann::json render_storage_episode_inspect_records(const storage_episode_inspect_result &result) {
  nlohmann::json records = nlohmann::json::array();
  for (const auto &record : result.episode.records)
    records.push_back(episode_record_row_json(record));
  return records;
}

nlohmann::json episode_dependency_json(const yy_storage::episode_dependency &dependency) {
  nlohmann::json rendered = {{"kind", dependency.kind}, {"role", dependency.role}, {"status", dependency.status}};
  if (dependency.episode_id.has_value())
    rendered["episode_id"] = *dependency.episode_id;
  if (dependency.frame_uid.has_value())
    rendered["frame_uid"] = *dependency.frame_uid;
  if (dependency.dependent_frame_uid.has_value())
    rendered["dependent_frame_uid"] = *dependency.dependent_frame_uid;
  if (dependency.ref_uid.has_value())
    rendered["ref_uid"] = *dependency.ref_uid;
  if (dependency.ref_id.has_value())
    rendered["ref_id"] = *dependency.ref_id;
  if (dependency.ref_hash.has_value())
    rendered["ref_hash"] = *dependency.ref_hash;
  return rendered;
}

nlohmann::json episode_dependencies_json(const yy_storage::episode_causal_graph &graph) {
  nlohmann::json rendered = nlohmann::json::array();
  for (const auto &dependency : graph.dependencies)
    rendered.push_back(episode_dependency_json(dependency));
  return rendered;
}

nlohmann::json episode_causal_graph_json(const yy_storage::episode_causal_graph &graph) {
  nlohmann::json edges = nlohmann::json::array();
  for (const auto &edge : graph.edges) {
    edges.push_back({{"kind", "frame_trigger"},
                     {"scope", "internal"},
                     {"from_frame_uid", edge.from_frame_uid},
                     {"to_frame_uid", edge.to_frame_uid}});
  }
  return {{"schema", graph.schema},
          {"episode_id", graph.episode_id},
          {"frame_count", graph.frame_count},
          {"edge_count", graph.edges.size()},
          {"dependency_count", graph.dependencies.size()},
          {"degraded", graph.degraded},
          {"edges", std::move(edges)},
          {"dependencies", episode_dependencies_json(graph)}};
}

nlohmann::json render_storage_episode_bundle_result(const storage_episode_bundle_result &result) {
  nlohmann::json records = nlohmann::json::array();
  for (const auto &record : result.manifest.records)
    records.push_back(episode_record_row_json(record));
  nlohmann::json frames = nlohmann::json::array();
  for (const auto index : result.manifest.frame_indices)
    frames.push_back(episode_record_row_json(result.manifest.records.at(index)));
  nlohmann::json refs = nlohmann::json::array();
  for (const auto index : result.manifest.ref_indices)
    refs.push_back(episode_record_row_json(result.manifest.records.at(index)));
  const auto dependencies = episode_dependencies_json(result.causal_graph);
  nlohmann::json rendered = {{"schema", "kungfu.storage.episode-bundle/v1"},
                             {"bundle_id", result.bundle_id},
                             {"scope", "episode"},
                             {"episode_id", result.episode_id},
                             {"authority", "yijinjing-journal"},
                             {"manifest", yy_storage::episode_summary_json(result.manifest)},
                             {"causal_graph", episode_causal_graph_json(result.causal_graph)},
                             {"records", std::move(records)},
                             {"frames", std::move(frames)},
                             {"refs", std::move(refs)},
                             {"dependencies", dependencies},
                             {"degraded", result.causal_graph.degraded},
                             {"record_count", result.manifest.records.size()},
                             {"frame_count", result.manifest.frame_indices.size()},
                             {"ref_count", result.manifest.ref_indices.size()},
                             {"dependency_count", result.causal_graph.dependencies.size()}};
  if (!result.self_contained) {
    return rendered;
  }
  // KF-ADR-019f86da-4f90-726e-b31f-ed180aa2e7a8: bundle-owned bytes use base64 only at the JSON edge.
  rendered["self_contained"] = true;
  nlohmann::json journals = nlohmann::json::array();
  for (const auto &journal : result.journals) {
    nlohmann::json frame_rows = nlohmann::json::array();
    for (const auto &frame : journal.frames) {
      frame_rows.push_back({{"frame_uid", frame.frame_uid},
                            {"gen_time", frame.gen_time},
                            {"carrier_type", frame.carrier_type},
                            {"frame_length", frame.frame_length},
                            {"data_length", frame.data_length},
                            {"bytes", base64_encode(frame.bytes)}});
    }
    journals.push_back({{"location",
                         {{"role", journal.role},
                          {"namespace", journal.namespace_},
                          {"name", journal.name},
                          {"mode", journal.mode},
                          {"seed", journal.seed},
                          {"uid", journal.location_uid}}},
                        {"dest", journal.dest},
                        {"frames", std::move(frame_rows)}});
  }
  rendered["journals"] = std::move(journals);
  nlohmann::json ref_payloads = nlohmann::json::array();
  for (const auto &payload : result.ref_payloads) {
    ref_payloads.push_back({{"content_namespace", payload.content_namespace},
                            {"ref_hash", payload.ref_hash},
                            {"byte_len", payload.byte_len},
                            {"bytes", base64_encode(payload.bytes)}});
  }
  rendered["ref_payloads"] = std::move(ref_payloads);
  rendered["material"] = {{"missing_frame_count", result.material_missing_frame_count},
                          {"missing_ref_payload_count", result.material_missing_ref_payload_count}};
  return rendered;
}

nlohmann::json make_request(storage_operation operation, const storage_service_options &options) {
  return {
      {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"operation", storage_operation_name(operation)},
      {"runtime_dir", options.runtime_dir},
      {"provider", options.provider},
      {"provider_config_source", options.provider_config_source},
      {"scope", options.scope},
      {"source_id", options.source_id},
      {"dry_run", options.dry_run},
      {"verify", options.verify},
      {"range", options.range},
      {"artifact_uri", options.artifact_uri},
  };
}

} // namespace detail

using namespace detail;

const storage_service &default_storage_service() { return typed_storage_service_instance(); }

nlohmann::json render_storage_episode_inspect_records(const storage_episode_inspect_result &result) {
  return detail::render_storage_episode_inspect_records(result);
}

std::string storage_fsck_scope_name(storage_fsck_scope scope) {
  switch (scope) {
  case storage_fsck_scope::All:
    return "all";
  case storage_fsck_scope::Source:
    return "source";
  case storage_fsck_scope::Episode:
    return "episode";
  }
  return "all";
}

storage_fsck_request parse_storage_fsck_request(const storage_service_options &options) {
  storage_fsck_request request{};
  request.runtime_dir = options.runtime_dir;
  request.provider = options.provider;
  request.provider_config_source = options.provider_config_source;
  request.source_id = options.source_id;
  request.episode_id = options.episode_id;
  request.verify_frames = bool_or(options.operation_options, "verify_frames", false);
  request.scope = options.scope == "episode"
                      ? storage_fsck_scope::Episode
                      : (options.source_id.empty() ? storage_fsck_scope::All : storage_fsck_scope::Source);
  return request;
}

storage_repair_plan_request parse_storage_repair_plan_request(const storage_service_options &options) {
  const auto fsck = parse_storage_fsck_request(options);
  return {fsck.runtime_dir, fsck.provider,   fsck.provider_config_source, fsck.scope,
          fsck.source_id,   fsck.episode_id, fsck.verify_frames,          options.dry_run};
}

nlohmann::json render_storage_fsck_issue(const storage_fsck_issue &issue, storage_fsck_scope scope) {
  auto rendered = std::visit(
      [&issue, scope](const auto &detail) {
        using detail_t = std::decay_t<decltype(detail)>;
        if constexpr (std::is_same_v<detail_t, storage_fsck_cross_issue>) {
          nlohmann::json row = {{"code", issue.code}};
          if (detail.source_id.has_value())
            row["source_id"] = *detail.source_id;
          if (detail.path.has_value())
            row["path"] = *detail.path;
          if (detail.payload_hash.has_value())
            row["payload_hash"] = *detail.payload_hash;
          if (detail.expected.has_value())
            row["expected"] = *detail.expected;
          if (detail.actual.has_value())
            row["actual"] = *detail.actual;
          if (detail.reason.has_value())
            row["reason"] = *detail.reason;
          return row;
        } else if constexpr (std::is_same_v<detail_t, yy_storage::source_registry_fsck_issue>) {
          nlohmann::json row = {{"code", detail.code}, {"projection", "source-registry"}};
          if (detail.source_uid.has_value())
            row["source_uid"] = *detail.source_uid;
          if (detail.source_id.has_value())
            row["source_id"] = *detail.source_id;
          if (detail.count.has_value())
            row["count"] = *detail.count;
          return row;
        } else if constexpr (std::is_same_v<detail_t, yy_storage::manifest_catalog_fsck_issue>) {
          nlohmann::json row = {{"code", detail.code}};
          if (detail.source_id.has_value())
            row["source_id"] = *detail.source_id;
          if (detail.manifest_id.has_value())
            row["manifest_id"] = *detail.manifest_id;
          if (detail.error.has_value())
            row["error"] = *detail.error;
          if (detail.subject.has_value())
            row["subject"] = *detail.subject;
          if (detail.payload_hash.has_value())
            row["payload_hash"] = *detail.payload_hash;
          if (detail.state.has_value())
            row["state"] = *detail.state;
          if (detail.kind.has_value())
            row["kind"] = *detail.kind;
          if (detail.entry_source_id.has_value())
            row["entry_source_id"] = *detail.entry_source_id;
          if (detail.manifest_uid.has_value())
            row["manifest_uid"] = *detail.manifest_uid;
          if (detail.entry_index.has_value())
            row["entry_index"] = *detail.entry_index;
          if (detail.expected.has_value())
            row["expected"] = *detail.expected;
          if (detail.actual.has_value())
            row["actual"] = *detail.actual;
          if (detail.expected_text.has_value())
            row["expected"] = *detail.expected_text;
          if (detail.actual_text.has_value())
            row["actual"] = *detail.actual_text;
          if (detail.intentional.has_value())
            row["intentional"] = *detail.intentional;
          return row;
        } else if constexpr (std::is_same_v<detail_t, yy_storage::episode_fsck_issue>) {
          auto row = yy_storage::render_episode_fsck_issue(detail);
          if (scope != storage_fsck_scope::Episode)
            row["projection"] = "episode-manifest";
          return row;
        } else if constexpr (std::is_same_v<detail_t, episode_frame_verification_issue>) {
          return render_episode_frame_verification_issue(detail);
        } else {
          nlohmann::json row = {{"code", issue.code}, {"projection", detail.name}, {"path", detail.path}};
          if (issue.code == "projection_absent") {
            row["reason"] = "projection is derived and can be rebuilt";
          } else {
            row["drift"] = nlohmann::json::array();
            for (const auto &drift : detail.verification.drift) {
              row["drift"].push_back({{"table", drift.table},
                                      {"projection_rows", drift.projection_rows},
                                      {"journal_distinct", drift.journal_distinct},
                                      {"reason", drift.reason},
                                      {"projection_digest", drift.projection_digest},
                                      {"journal_digest", drift.journal_digest}});
            }
          }
          return row;
        }
      },
      issue.detail);
  return rendered;
}

nlohmann::json render_storage_fsck_result(const storage_fsck_result &result) {
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  for (const auto &issue : result.issues) {
    auto rendered = render_storage_fsck_issue(issue, result.scope);
    (issue.severity == "error" ? errors : warnings).push_back(std::move(rendered));
  }
  nlohmann::json checked = {{"sources", result.checked.sources},
                            {"manifests", result.checked.manifests},
                            {"accepted_ranges", result.checked.accepted_ranges},
                            {"source_records", result.checked.source_records},
                            {"projection_indexes", result.checked.projection_indexes},
                            {"orphan_payloads", result.checked.orphan_payloads},
                            {"episode_manifest_records", result.checked.episode_manifest_records},
                            {"episodes", result.checked.episodes}};
  if (result.scope == storage_fsck_scope::Episode) {
    checked["payloads"] = 0;
    checked["schemas"] = 0;
    checked["sqlite_projection_rows"] = 0;
  } else {
    checked["manifest_entries"] = result.checked.manifest_entries;
    checked["payloads"] = result.checked.payloads;
    checked["entries_documents"] = result.checked.entries_documents;
  }
  if (result.frame_verification.has_value())
    checked["episode_frames_verified"] = result.checked.episode_frames_verified;

  nlohmann::json report = {{"ok", result.ok},
                           {"status", result.status},
                           {"scope", storage_fsck_scope_name(result.scope)},
                           {"degraded", result.degraded},
                           {"errors", std::move(errors)},
                           {"warnings", std::move(warnings)},
                           {"checked", std::move(checked)},
                           {"episode_manifest", yy_storage::render_episode_fsck_result(result.episode_manifest)}};
  if (result.scope == storage_fsck_scope::Episode) {
    report["episode_id"] = result.episode_id.has_value() ? nlohmann::json(*result.episode_id) : nlohmann::json(nullptr);
    const auto &projection = result.projections.front();
    report["episode_projection"] = projection_verification_json(projection.verification);
    report["projections"] = nlohmann::json::array({{{"name", "episode-manifest"},
                                                    {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
                                                    {"authority", "yijinjing-journal"},
                                                    {"path", "journal/system/storage/episode-manifest/live/*.journal"},
                                                    {"rebuildable", false}},
                                                   {{"name", "episode-manifest-sqlite"},
                                                    {"schema", EPISODE_MANIFEST_PROJECTION_SCHEMA_V1},
                                                    {"authority", "yijinjing-journal"},
                                                    {"path", "storage/projections/episode-manifest.sqlite"},
                                                    {"rebuildable", true}}});
    report["repair_policy"] = {{"mode", "plan-fetch-apply"},
                               {"auto_repair", false},
                               {"destructive", false},
                               {"projection_rebuild",
                                {{"authority", "yijinjing-journal"},
                                 {"projection", "sqlite"},
                                 {"operation", "episode_projection_rebuild"},
                                 {"rebuildable", true}}}};
    if (result.qualification.has_value())
      report["qualification"] = episode_qualification_json(*result.qualification);
  } else {
    report["source_id"] = result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr);
    report["authority"] = result.authority;
    report["projections"] = nlohmann::json::array();
    for (const auto &projection : result.projections)
      report["projections"].push_back(projection_status_json(projection));
  }
  return report;
}

nlohmann::json render_storage_repair_plan_result(const storage_repair_plan_result &result) {
  const auto render_subject = [](nlohmann::json &candidate, const storage_repair_subject &subject) {
    if (subject.episode_id.has_value())
      candidate["episode_id"] = *subject.episode_id;
    if (subject.dependency_episode_id.has_value())
      candidate["dependency_episode_id"] = *subject.dependency_episode_id;
    if (subject.frame_uid.has_value())
      candidate["frame_uid"] = *subject.frame_uid;
    if (subject.dependent_frame_uid.has_value())
      candidate["dependent_frame_uid"] = *subject.dependent_frame_uid;
    if (subject.ref_id.has_value())
      candidate["ref_id"] = *subject.ref_id;
    if (subject.ref_hash.has_value())
      candidate["ref_hash"] = *subject.ref_hash;
    if (subject.source_id.has_value())
      candidate["source_id"] = *subject.source_id;
    if (subject.subject.has_value())
      candidate["subject"] = *subject.subject;
    if (subject.state.has_value())
      candidate["state"] = *subject.state;
    if (subject.path.has_value())
      candidate["path"] = *subject.path;
    if (subject.payload_hash.has_value())
      candidate["payload_hash"] = *subject.payload_hash;
  };
  nlohmann::json candidates = nlohmann::json::array();
  for (const auto &item : result.candidates) {
    nlohmann::json candidate = {{"code", item.code},
                                {"issue_code", item.issue_code},
                                {"kind", item.kind},
                                {"role", item.role},
                                {"action", item.action},
                                {"suggested_action", item.action},
                                {"safe_to_apply", item.safe_to_apply},
                                {"requires", item.required_inputs},
                                {"warning", render_storage_fsck_issue(item.issue, result.scope)}};
    render_subject(candidate, item.subject);
    candidates.push_back(std::move(candidate));
  }
  nlohmann::json unsupported = nlohmann::json::array();
  for (const auto &issue : result.unsupported)
    unsupported.push_back(render_storage_fsck_issue(issue, result.scope));
  return {{"ok", result.ok},
          {"schema", "kungfu.storage.repair-plan/v1"},
          {"scope", storage_fsck_scope_name(result.scope)},
          {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
          {"episode_id", result.episode_id.has_value() ? nlohmann::json(*result.episode_id) : nlohmann::json(nullptr)},
          {"dry_run", result.dry_run},
          {"plan_only", result.plan_only},
          {"status", result.status},
          {"degraded", result.degraded},
          {"candidate_count", candidates.size()},
          {"candidates", std::move(candidates)},
          {"unsupported", std::move(unsupported)},
          {"fsck", render_storage_fsck_result(result.fsck)},
          {"notes", result.notes}};
}

storage_status_request parse_storage_status_request(const storage_service_options &options) {
  return {options.runtime_dir, options.provider, options.provider_config_source, options.source_id};
}

storage_gc_plan_request parse_storage_gc_plan_request(const storage_service_options &options) {
  return {options.runtime_dir, options.provider, options.source_id, options.dry_run};
}

nlohmann::json render_storage_gc_plan_result(const storage_gc_plan_result &result) {
  nlohmann::json candidates = nlohmann::json::array();
  for (const auto &candidate : result.candidates) {
    candidates.push_back({{"payload_hash", candidate.payload_hash},
                          {"path", candidate.uri},
                          {"bytes", candidate.bytes},
                          {"safe_to_delete", candidate.safe_to_delete}});
  }
  return {{"ok", result.ok},
          {"scope", result.scope},
          {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
          {"dry_run", result.dry_run},
          {"payloads_scanned", result.payloads_scanned},
          {"referenced_payloads", result.referenced_payloads},
          {"candidate_count", result.candidates.size()},
          {"candidate_bytes", result.candidate_bytes},
          {"candidates", std::move(candidates)},
          {"notes", result.notes}};
}

storage_rebuild_index_request parse_storage_rebuild_index_request(const storage_service_options &options) {
  return {options.runtime_dir, options.source_id, options.dry_run};
}

nlohmann::json render_storage_rebuild_index_result(const storage_rebuild_index_result &result) {
  nlohmann::json projections = nlohmann::json::array();
  for (const auto &action : result.projections) {
    auto rendered = std::visit(
        [](const auto &detail) {
          using detail_t = std::decay_t<decltype(detail)>;
          nlohmann::json row = {{"ok", detail.ok},
                                {"schema", detail.schema},
                                {"runtime_dir", detail.runtime_dir},
                                {"authority", detail.authority}};
          if constexpr (std::is_same_v<detail_t, storage_projection_verify_result>) {
            row["status"] = detail.status;
            row["projection_present"] = detail.projection_present;
            if (!detail.note.empty()) {
              row["note"] = detail.note;
            }
            if (detail.projection_present) {
              row["degraded"] = detail.degraded;
              row["drift"] = nlohmann::json::array();
              for (const auto &drift : detail.drift) {
                row["drift"].push_back({{"table", drift.table},
                                        {"projection_rows", drift.projection_rows},
                                        {"journal_distinct", drift.journal_distinct},
                                        {"reason", drift.reason},
                                        {"projection_digest", drift.projection_digest},
                                        {"journal_digest", drift.journal_digest}});
              }
              row["rows"] = nlohmann::json::object();
              for (const auto &count : detail.rows) {
                row["rows"][count.table] = count.count;
              }
              row["journal_distinct"] = nlohmann::json::object();
              for (const auto &count : detail.journal_distinct) {
                row["journal_distinct"][count.table] = count.count;
              }
            }
          } else {
            row["projection"] = detail.projection;
            row["sqlite_path"] = detail.sqlite_path;
            row["rows"] = nlohmann::json::object();
            for (const auto &count : detail.rows) {
              row["rows"][count.table] = count.count;
            }
            row["journal_records"] = nlohmann::json::object();
            for (const auto &count : detail.journal_records) {
              row["journal_records"][count.table] = count.count;
            }
          }
          return row;
        },
        action.detail);
    rendered["name"] = action.name;
    rendered["dry_run"] = action.dry_run;
    rendered["written"] = action.written;
    if (action.dry_run) {
      rendered["would_write"] = action.would_write;
    }
    projections.push_back(std::move(rendered));
  }
  nlohmann::json errors = nlohmann::json::array();
  for (const auto &error : result.errors) {
    nlohmann::json row = {{"code", error.code}};
    if (error.projection.has_value()) {
      row["projection"] = *error.projection;
    }
    if (error.source_id.has_value()) {
      row["source_id"] = *error.source_id;
    }
    errors.push_back(std::move(row));
  }
  return {{"ok", result.ok},
          {"scope", result.scope},
          {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
          {"authority", result.authority},
          {"rebuilt_from", result.rebuilt_from},
          {"projections", std::move(projections)},
          {"dry_run", result.dry_run},
          {"would_write", result.would_write},
          {"written", result.written},
          {"sources_rebuilt", result.sources_rebuilt},
          {"errors", std::move(errors)}};
}

storage_compact_plan_request parse_storage_compact_plan_request(const storage_service_options &options) {
  return {options.runtime_dir, options.provider, options.source_id, options.dry_run};
}

nlohmann::json render_storage_compact_plan_result(const storage_compact_plan_result &result) {
  nlohmann::json retained_manifests = nlohmann::json::array();
  for (const auto &manifest : result.retained_manifests) {
    retained_manifests.push_back({{"source_id", manifest.source_id},
                                  {"manifest_id", manifest.manifest_id},
                                  {"entries", manifest.entries},
                                  {"sync_root",
                                   {{"schema", yy_storage::SYNC_ROOT_SCHEMA_V1},
                                    {"scope", yy_storage::SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST},
                                    {"proof", yy_storage::SYNC_ROOT_PROOF_LINEAR_CHAIN_V1},
                                    {"algorithm", manifest.sync_root.algorithm},
                                    {"value", manifest.sync_root.value},
                                    {"entry_count", manifest.entries},
                                    {"initial", yy_storage::SYNC_ROOT_INITIAL_SHA256},
                                    {"ordering",
                                     {{"policy", yy_storage::SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
                                      {"fields", nlohmann::json::array({"kind", "source_id", "source_path"})}}}}}});
  }
  nlohmann::json unsupported = nlohmann::json::array();
  for (const auto &action : result.unsupported) {
    unsupported.push_back({{"name", action.name}, {"reason", action.reason}});
  }
  return {
      {"ok", result.ok},
      {"scope", result.scope},
      {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
      {"dry_run", result.dry_run},
      {"retained_manifests", std::move(retained_manifests)},
      {"rebuild_index", render_storage_rebuild_index_result(result.rebuild_index)},
      {"gc", render_storage_gc_plan_result(result.gc)},
      {"projection_compact",
       {{"name", result.projection_compact.name},
        {"path", result.projection_compact.path},
        {"action", result.projection_compact.action},
        {"dry_run", result.projection_compact.dry_run},
        {"rebuildable", result.projection_compact.rebuildable}}},
      {"unsupported", std::move(unsupported)},
      {"notes", result.notes},
  };
}

nlohmann::json render_storage_status_result(const storage_status_result &result) {
  const auto range_json = [](const storage_time_range &range) {
    nlohmann::json rendered = nlohmann::json::object();
    if (!range.since.empty()) {
      rendered["since"] = range.since;
    }
    if (!range.until.empty()) {
      rendered["until"] = range.until;
    }
    return rendered;
  };
  const auto sync_root_json = [](const storage_sync_root_view &root) {
    return nlohmann::json{{"algorithm", root.algorithm}, {"value", root.value}};
  };
  const auto proof_root_json = [&sync_root_json](const storage_sync_root_view &root, uint64_t entry_count) {
    auto rendered = sync_root_json(root);
    rendered["schema"] = yy_storage::SYNC_ROOT_SCHEMA_V1;
    rendered["scope"] = yy_storage::SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST;
    rendered["proof"] = yy_storage::SYNC_ROOT_PROOF_LINEAR_CHAIN_V1;
    rendered["entry_count"] = entry_count;
    rendered["initial"] = yy_storage::SYNC_ROOT_INITIAL_SHA256;
    rendered["ordering"] = {{"policy", yy_storage::SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
                            {"fields", nlohmann::json::array({"kind", "source_id", "source_path"})}};
    return rendered;
  };
  const auto accepted_range_json = [&range_json, &proof_root_json](const storage_accepted_range_view &range) {
    return nlohmann::json{{"schema", yy_storage::STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
                          {"source_id", range.source_id},
                          {"manifest_id", range.manifest_id},
                          {"range", range_json(range.range)},
                          {"source_head", range.source_head},
                          {"sync_root", proof_root_json(range.sync_root, range.entry_count)},
                          {"entry_count", range.entry_count},
                          {"status", range.status}};
  };
  const auto source_json = [](const storage_source_registry_view &source) {
    nlohmann::json rendered = {{"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
                               {"source_uid", source.source_uid},
                               {"source_id", source.source_id},
                               {"registered", source.registered},
                               {"record_count", source.record_count},
                               {"accepted_range_count", source.accepted_range_count}};
    if (source.registered) {
      rendered["kind"] = *source.kind;
      rendered["coordinate"] = *source.coordinate;
      rendered["head"] = *source.head;
      rendered["location_uid"] = *source.location_uid;
      rendered["register_time"] = *source.register_time;
    }
    if (source.current_range.has_value()) {
      const auto &range = *source.current_range;
      rendered["current_range"] = {{"first_frame_uid", range.first_frame_uid},
                                   {"last_frame_uid", range.last_frame_uid},
                                   {"since", range.since},
                                   {"until", range.until}};
      rendered["inventory_hash"] = {{"algorithm", source.inventory_hash->algorithm},
                                    {"value", source.inventory_hash->value}};
      rendered["update_time"] = *source.update_time;
    }
    return rendered;
  };

  nlohmann::json sources = nlohmann::json::array();
  for (const auto &source : result.sources) {
    sources.push_back(source_json(source));
  }
  nlohmann::json projections = nlohmann::json::array();
  for (const auto &projection : result.projections) {
    projections.push_back(projection_status_json(projection));
  }
  nlohmann::json source_status = nlohmann::json::array();
  for (const auto &status : result.source_status) {
    nlohmann::json row = {{"source_id", status.source_id}, {"ok", status.ok}, {"authority", result.authority}};
    if (!status.ok) {
      row["reason"] = *status.reason;
      row["source"] = source_json(status.source);
      source_status.push_back(std::move(row));
      continue;
    }
    row["manifest_id"] = *status.manifest_id;
    row["source_type"] = *status.source_type;
    row["source_head"] = *status.source_head;
    row["accepted_ranges"] = nlohmann::json::array({accepted_range_json(*status.accepted_range)});
    if (status.accepted_cursor.has_value()) {
      const auto &cursor = *status.accepted_cursor;
      row["accepted_cursor"] = {{"schema", yy_storage::STORAGE_CHANNEL_CURSOR_SCHEMA_V1},
                                {"source_id", cursor.source_id},
                                {"manifest_id", cursor.manifest_id},
                                {"source_head", cursor.source_head},
                                {"range", range_json(cursor.range)},
                                {"sync_root", sync_root_json(cursor.sync_root)},
                                {"entry_count", cursor.entry_count}};
    } else {
      row["accepted_cursor"] = nullptr;
    }
    row["sync_root"] = proof_root_json(*status.sync_root, status.entries);
    row["entries"] = status.entries;
    row["payload_inventory"] = status.payload_inventory;
    row["schema_inventory"] = status.schema_inventory;
    const auto &record = *status.source_record;
    row["source_record"] = {{"schema", yy_storage::STORAGE_SOURCE_RECORD_SCHEMA_V1},
                            {"source_id", record.source_id},
                            {"type", record.source_type},
                            {"kind", record.kind},
                            {"coordinate", record.coordinate},
                            {"current_head",
                             {{"head", record.source_head},
                              {"range", range_json(record.range)},
                              {"inventory_hash", record.inventory_hash}}},
                            {"accepted_ranges", nlohmann::json::array({accepted_range_json(record.accepted_range)})},
                            {"last_manifest_id", record.manifest_id},
                            {"updated_at", ""}};
    source_status.push_back(std::move(row));
  }

  return {{"ok", result.ok},
          {"backend", result.backend},
          {"provider", result.provider},
          {"provider_config_source", result.provider_config_source},
          {"provider_runtime", provider_runtime_json(result.provider_runtime)},
          {"provider_cache", provider_cache_json(result.provider_cache)},
          {"scope", result.scope},
          {"source_id", result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr)},
          {"authority", result.authority},
          {"sources", std::move(sources)},
          {"source_count", result.sources.size()},
          {"projections", std::move(projections)},
          {"source_status", std::move(source_status)}};
}

storage_service_options parse_storage_service_options(const std::string &runtime_dir, const nlohmann::json &options) {
  storage_service_options parsed;
  parsed.runtime_dir = runtime_dir;
  const auto selected_provider = select_provider_for_runtime(runtime_dir, text_or(options, "provider"));
  parsed.provider = selected_provider.name;
  parsed.provider_config_source = selected_provider.source;
  parsed.scope = text_or(options, "scope", "all");
  parsed.source_id = text_or(options, "source_id");
  parsed.dry_run = bool_or(options, "dry_run", true);
  parsed.verify = bool_or(options, "verify", true);
  parsed.range = object_or_empty(options, "range");
  parsed.artifact_uri = text_or(options, "artifact_uri");
  parsed.bundle = object_or_empty(options, "bundle");
  parsed.manifest = object_or_empty(options, "manifest");
  parsed.operation_options = options;
  parsed.query_definition = object_or_empty(options, "definition");
  parsed.query = text_or(options, "query", "entries");
  parsed.kind = text_or(options, "kind");
  parsed.episode_id = uint64_or(options, "episode_id");
  parsed.limit = uint64_or(options, "limit", 100);
  return parsed;
}

nlohmann::json make_storage_service_request(const std::string &operation, const std::string &runtime_dir,
                                            const nlohmann::json &options) {
  const auto parsed_operation = parse_storage_operation(operation);
  const auto parsed_options = parse_storage_service_options(runtime_dir, options);
  auto request = make_request(parsed_operation, parsed_options);
  if (parsed_operation == storage_operation::Query) {
    request["query"] = parsed_options.query;
    request["kind"] = parsed_options.kind.empty() ? nlohmann::json(nullptr) : nlohmann::json(parsed_options.kind);
    request["limit"] = parsed_options.limit;
  } else if (parsed_operation == storage_operation::QueryPlan || parsed_operation == storage_operation::FactQuery ||
             parsed_operation == storage_operation::FactChangelog ||
             parsed_operation == storage_operation::SavedQueryCatalog) {
    request["definition"] = parsed_options.query_definition;
    request["action"] = text_or(parsed_options.operation_options, "action");
  } else if (parsed_operation == storage_operation::Layout) {
    request["runtime_home"] = runtime_home_path(parsed_options).string();
    request["runtime_home_source"] = runtime_home_source(parsed_options);
    request["config_home"] = optional_absolute_path(parsed_options.operation_options, "config_home");
  }
  if (parsed_options.episode_id != 0) {
    request["episode_id"] = parsed_options.episode_id;
  }
  if (parsed_operation == storage_operation::EpisodeList) {
    request["location_uid"] = uint64_or(options, "location_uid");
    request["limit"] = parsed_options.limit;
  } else if (parsed_operation == storage_operation::EpisodeInspect) {
    request["episode_id"] = uint64_or(options, "episode_id");
  } else if (storage_operation_name(parsed_operation).rfind("episode_", 0) == 0) {
    request["episode"] = parsed_options.operation_options;
  }
  return request;
}

nlohmann::json run_storage_service_operation(const std::string &operation, const std::string &runtime_dir,
                                             const nlohmann::json &options) {
  const auto parsed_operation = parse_storage_operation(operation);
  if (parsed_operation == storage_operation::BackendStatus || parsed_operation == storage_operation::BackendSwitch ||
      parsed_operation == storage_operation::BackendRollback) {
    storage_service_options backend_options{};
    backend_options.runtime_dir = runtime_dir;
    backend_options.operation_options = options;
    return dispatch_backend_operation(parsed_operation, backend_options);
  }
  return detail::dispatch_json_edge_operation(parsed_operation, parse_storage_service_options(runtime_dir, options));
}

nlohmann::json accept_storage_manifest(const std::string &runtime_dir, const nlohmann::json &manifest) {
  return accept_storage_manifest_impl(runtime_dir, manifest);
}

nlohmann::json load_storage_latest_manifest(const std::string &runtime_dir, const std::string &source_id) {
  const auto provider = shared_provider(runtime_dir);
  return load_latest_manifest_impl(runtime_dir, *provider, source_id);
}

nlohmann::json export_storage_records(const std::string &runtime_dir, const std::string &source_id,
                                      const nlohmann::json &range) {
  const auto provider = shared_provider(runtime_dir);
  const auto manifest = load_latest_manifest_impl(runtime_dir, *provider, source_id);
  if (manifest.is_null()) {
    throw std::runtime_error("manifest not found: " + source_id);
  }
  nlohmann::json records = nlohmann::json::array();
  for (const auto &entry : entries_for_manifest(manifest, range)) {
    auto row = entry;
    row["scope"] = text_or(manifest, "scope");
    row["manifest_id"] = text_or(manifest, "manifest_id");
    row["storage_source_id"] = source_id;
    row["source_type"] = text_or(manifest, "source_type");
    row["source_head"] = text_or(manifest, "source_head");
    const auto state = text_or(entry, "payload_state", PAYLOAD_STATE_PRESENT);
    if (state == PAYLOAD_STATE_REDACTED || state == PAYLOAD_STATE_ABSENT) {
      row["payload"] = nullptr;
    } else if (state != PAYLOAD_STATE_PRESENT) {
      auto [payload, error] = load_payload_impl(*provider, entry);
      row["payload"] = error.empty() ? payload : nlohmann::json(nullptr);
    } else {
      auto [payload, error] = load_payload_impl(*provider, entry);
      if (!error.empty()) {
        throw std::runtime_error(error + ": " + text_or(entry, "kind") + ":" + text_or(entry, "source_id"));
      }
      row["payload"] = payload;
    }
    records.push_back(row);
  }
  std::sort(records.begin(), records.end(), [](const nlohmann::json &lhs, const nlohmann::json &rhs) {
    return std::make_tuple(text_or(lhs, "kind"), text_or(lhs, "source_id"), text_or(lhs, "source_path")) <
           std::make_tuple(text_or(rhs, "kind"), text_or(rhs, "source_id"), text_or(rhs, "source_path"));
  });
  return records;
}

std::string write_storage_payload_bytes(const std::string &runtime_dir, const std::string &digest,
                                        const std::string &raw) {
  const auto error = yy_storage::verify_payload_ref(raw, digest, raw.size(), yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
  if (!error.empty()) {
    throw std::invalid_argument("storage_payload_invalid: " + error);
  }
  const auto provider = shared_provider(runtime_dir);
  provider->write_payload(digest, raw);
  return payload_uri_for(provider->name(), runtime_dir, digest);
}

namespace detail {

nlohmann::json content_result_json(const yy_storage::content_store_result &result) {
  return {{"ok", result.ok()},
          {"error", yy_storage::content_store_error_name(result.error)},
          {"hash", {{"algorithm", result.hash.algorithm}, {"value", result.hash.value}}},
          {"byte_length", result.byte_length},
          {"existed", result.existed},
          {"message", result.message}};
}

} // namespace detail

namespace {

bool parse_content_hash_text(const std::string &text, yy_storage::content_hash &hash, std::string &message) {
  try {
    hash = text.find(':') != std::string::npos ? yy_storage::parse_content_hash(text)
                                               : yy_storage::make_content_hash(text);
    return true;
  } catch (const std::exception &e) {
    message = e.what();
    return false;
  }
}

nlohmann::json invalid_content_hash_json(const std::string &message) {
  yy_storage::content_store_result result{};
  result.error = yy_storage::content_store_error::InvalidArgument;
  result.message = message;
  return content_result_json(result);
}

} // namespace

// KF-ADR-019f86da-4f90-738c-b372-e509976f69ff routes one immutable content-store contract through the runtime-selected
// provider.
nlohmann::json content_store_put_if_absent(const std::string &runtime_dir, const std::string &content_namespace,
                                           const std::string &raw, const std::string &expected_hash) {
  yy_storage::content_hash expected{};
  if (!expected_hash.empty()) {
    std::string message;
    if (!parse_content_hash_text(expected_hash, expected, message)) {
      return invalid_content_hash_json(message);
    }
  }
  const auto provider = shared_provider(runtime_dir);
  return content_result_json(provider->content_store().put_if_absent(content_namespace, raw, expected));
}

bool content_store_has(const std::string &runtime_dir, const std::string &content_namespace,
                       const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    return false;
  }
  const auto provider = shared_provider(runtime_dir);
  return provider->content_store().has(content_namespace, hash);
}

nlohmann::json content_store_verify(const std::string &runtime_dir, const std::string &content_namespace,
                                    const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    return invalid_content_hash_json(message);
  }
  const auto provider = shared_provider(runtime_dir);
  return content_result_json(provider->content_store().verify(content_namespace, hash));
}

std::string content_store_get(const std::string &runtime_dir, const std::string &content_namespace,
                              const std::string &content_hash_text) {
  yy_storage::content_hash hash{};
  std::string message;
  if (!parse_content_hash_text(content_hash_text, hash, message)) {
    throw std::invalid_argument("content_store_get: " + message);
  }
  const auto provider = shared_provider(runtime_dir);
  auto result = provider->content_store().get(content_namespace, hash);
  if (!result.ok()) {
    throw std::runtime_error(std::string("content_store_get_failed: ") +
                             yy_storage::content_store_error_name(result.error) +
                             (result.message.empty() ? "" : ": " + result.message));
  }
  return std::move(result.bytes);
}

nlohmann::json content_store_capabilities(const std::string &runtime_dir) {
  const auto provider = shared_provider(runtime_dir);
  const auto caps = provider->content_store().capabilities();
  return {{"provider", provider->name()},
          {"profile", caps.profile},
          {"hash_algorithm", caps.hash_algorithm},
          {"max_object_size", caps.max_object_size},
          {"atomic_put_if_absent", caps.atomic_put_if_absent},
          {"verified_reads", caps.verified_reads},
          {"durability", caps.durability},
          {"visibility", caps.visibility},
          {"concurrency", caps.concurrency}};
}

nlohmann::json storage_service_capabilities() {
  const auto provider = select_provider({});
  return {
      {"schema", RUNTIME_STORAGE_SERVICE_SCHEMA_V1},
      {"owner", RUNTIME_STORAGE_SERVICE_OWNER},
      {"operations", storage_operation_names()},
      {"backend", provider.name},
      {"provider", provider.name},
      {"provider_config_source", provider.source},
      {"providers", nlohmann::json::array({
                        {{"name", PROVIDER_FILE},
                         {"available", provider_available(PROVIDER_FILE)},
                         {"default", provider.name == PROVIDER_FILE},
                         {"selected", provider.name == PROVIDER_FILE},
                         {"layout", provider_layout_json(provider_layout_for(PROVIDER_FILE))},
                         {"runtime", provider_runtime_json(provider_runtime_for(PROVIDER_FILE))}},
                        {{"name", PROVIDER_ROCKSDB},
                         {"available", provider_available(PROVIDER_ROCKSDB)},
                         {"default", provider.name == PROVIDER_ROCKSDB},
                         {"selected", provider.name == PROVIDER_ROCKSDB},
                         {"layout", provider_layout_json(provider_layout_for(PROVIDER_ROCKSDB))},
                         {"runtime", provider_runtime_json(provider_runtime_for(PROVIDER_ROCKSDB))}},
                    })},
      {"backend_authority", backend_authority_capability_json()},
      {"projections",
       nlohmann::json::array(
           {{{"name", "source-registry"},
             {"schema", yy_storage::SOURCE_REGISTRY_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/source-registry/live/*.journal"},
             {"rebuildable", false}},
            {{"name", PROJECTION_SOURCE_REGISTRY},
             {"schema", SOURCE_REGISTRY_PROJECTION_SCHEMA_V1},
             {"authority", "derived"},
             {"path", "storage/projections/source-registry.sqlite"},
             {"rebuildable", true}},
            {{"name", "manifest-catalog"},
             {"schema", yy_storage::MANIFEST_CATALOG_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/manifest-catalog/live/*.journal"},
             {"export_schema", yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1},
             {"rebuildable", false}},
            {{"name", PROJECTION_MANIFEST_CATALOG},
             {"schema", MANIFEST_CATALOG_PROJECTION_SCHEMA_V1},
             {"authority", "derived"},
             {"path", "storage/projections/manifest-catalog.sqlite"},
             {"rebuildable", true}},
            {{"name", "episode-manifest"},
             {"schema", yy_storage::EPISODE_MANIFEST_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/storage/episode-manifest/live/*.journal"},
             {"query_tables", nlohmann::json::array({"episodes", "episode_records", "episode_frames", "episode_refs"})},
             {"export_schema", "kungfu.storage.episode-bundle/v1"},
             {"rebuildable", false}},
            {{"name", "domain-fact-admission"},
             {"schema", facts::DOMAIN_FACT_EVENT_SCHEMA_V1},
             {"authority", "yijinjing-journal"},
             {"path", "journal/system/facts/admission/live/*.journal"},
             {"contract", facts::fact_contract_json()},
             {"rebuildable", false}}})},
      {"notes",
       nlohmann::json::array({
           "The runtime storage service surface and providers are owned by libkungfu.",
           "Provider selection is an implementation option; product semantics remain storage-service operations.",
           "Python and Node should remain binding, CLI, or UI layers over this service.",
       })},
  };
}

} // namespace kungfu::runtime::storage_service_api
