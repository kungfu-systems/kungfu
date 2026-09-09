// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <utility>

#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/manifest_catalog_projection.h>
#include <kungfu/runtime/storage/source_registry_projection.h>

namespace kungfu::runtime::storage_service_api::detail {

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

} // namespace kungfu::runtime::storage_service_api::detail
