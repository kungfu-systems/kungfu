// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/runtime/storage/service.h>

#include "service_internal.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstring>
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

nlohmann::json entries_for_manifest(const nlohmann::json &manifest, const nlohmann::json &range_filter) {
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
      auto reader = std::make_shared<yjj::journal::reader>(yjj::journal::reader_policy::peer(), false,
                                                           std::make_shared<yjj::journal::bus>(false));
      reader->join(location, dest_uid, 0);
      while (reader->data_available()) {
        const auto frame = reader->current_frame();
        const auto wanted_iter = wanted.find(frame->frame_uid());
        if (wanted_iter != wanted.end() && found.insert(frame->frame_uid()).second) {
          yjj::types::frame_header header{};
          std::memcpy(&header, reinterpret_cast<const void *>(frame->address()), sizeof(header));
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
      auto reader = std::make_shared<yjj::journal::reader>(yjj::journal::reader_policy::peer(), false,
                                                           std::make_shared<yjj::journal::bus>(false));
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

} // namespace kungfu::runtime::storage_service_api
