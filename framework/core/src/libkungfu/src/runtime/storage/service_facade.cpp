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
namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

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

nlohmann::json render_manifest_catalog_issue(const yy_storage::manifest_catalog_fsck_issue &detail) {
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
}

nlohmann::json render_projection_issue(const storage_fsck_issue &issue, const storage_projection_status_view &detail) {
  nlohmann::json row = {{"code", issue.code}, {"projection", detail.name}, {"path", detail.path}};
  if (issue.code == "projection_absent") {
    row["reason"] = "projection is derived and can be rebuilt";
    return row;
  }
  row["drift"] = nlohmann::json::array();
  for (const auto &drift : detail.verification.drift) {
    row["drift"].push_back({{"table", drift.table},
                            {"projection_rows", drift.projection_rows},
                            {"journal_distinct", drift.journal_distinct},
                            {"reason", drift.reason},
                            {"projection_digest", drift.projection_digest},
                            {"journal_digest", drift.journal_digest}});
  }
  return row;
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
          return render_manifest_catalog_issue(detail);
        } else if constexpr (std::is_same_v<detail_t, yy_storage::episode_fsck_issue>) {
          auto row = yy_storage::render_episode_fsck_issue(detail);
          if (scope != storage_fsck_scope::Episode)
            row["projection"] = "episode-manifest";
          return row;
        } else if constexpr (std::is_same_v<detail_t, episode_frame_verification_issue>) {
          return render_episode_frame_verification_issue(detail);
        } else {
          return render_projection_issue(issue, detail);
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
