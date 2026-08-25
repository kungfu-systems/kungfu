// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <map>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace kungfu::runtime::storage_service_api {

namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace detail {

const char *verification_status_text(yy_enums::SourceVerificationStatus status) {
  switch (status) {
  case yy_enums::SourceVerificationStatus::Ok:
    return "ok";
  case yy_enums::SourceVerificationStatus::Degraded:
    return "degraded";
  case yy_enums::SourceVerificationStatus::Failed:
    return "failed";
  }
  return "failed";
}

storage_query_result query_result_shell(const storage_query_request &request) {
  storage_query_result result{};
  result.query = request.query;
  result.limit = request.limit;
  result.range = request.range;
  if (!request.entry_kind.empty())
    result.entry_kind = request.entry_kind;
  return result;
}

bool is_episode_query(storage_query_kind query) {
  return query == storage_query_kind::Episodes || query == storage_query_kind::EpisodeRecords ||
         query == storage_query_kind::EpisodeFrames || query == storage_query_kind::EpisodeRefs;
}

template <typename Fold>
storage_query_result query_episode_catalog(const storage_query_request &request, const Fold &fold,
                                           storage_query_result result) {
  std::vector<yy_storage::episode_current_view> rows;
  if (request.episode_id != 0) {
    const auto iter = fold.episodes.find(request.episode_id);
    if (iter != fold.episodes.end())
      rows.push_back(iter->second);
  } else {
    for (auto iter = fold.episodes.rbegin(); iter != fold.episodes.rend(); ++iter) {
      rows.push_back(iter->second);
      if (request.limit != 0 && rows.size() >= request.limit)
        break;
    }
  }
  result.rows = std::move(rows);
  return result;
}

template <typename Fold>
storage_query_result query_episode_records(const storage_query_request &request, const Fold &fold,
                                           storage_query_result result) {
  if (request.episode_id == 0)
    throw std::invalid_argument("episode_id is required for " + storage_query_kind_name(request.query));
  const auto iter = fold.episodes.find(request.episode_id);
  if (iter == fold.episodes.end()) {
    result.ok = false;
    result.errors.push_back({"episode_missing", request.episode_id});
    result.rows = std::vector<yy_storage::episode_manifest_record>{};
    return result;
  }
  const auto &view = iter->second;
  std::vector<yy_storage::episode_manifest_record> rows;
  if (request.query == storage_query_kind::EpisodeRecords) {
    rows = view.records;
  } else {
    const auto &indices = request.query == storage_query_kind::EpisodeFrames ? view.frame_indices : view.ref_indices;
    rows.reserve(indices.size());
    for (const auto index : indices)
      rows.push_back(view.records.at(index));
  }
  if (request.limit != 0 && rows.size() > request.limit)
    rows.resize(request.limit);
  result.rows = std::move(rows);
  return result;
}

storage_query_result query_episode_projection(const storage_query_request &request) {
  auto result = query_result_shell(request);
  result.scope = "episode";
  if (request.episode_id != 0)
    result.episode_id = request.episode_id;
  result.projection_name = "episode-manifest";
  result.projection_schema = yy_storage::EPISODE_MANIFEST_SCHEMA_V1;
  result.rebuildable = false;

  const auto fold = yy_storage::episode_manifest_store(request.runtime_dir).fold_typed_records();
  return request.query == storage_query_kind::Episodes ? query_episode_catalog(request, fold, std::move(result))
                                                       : query_episode_records(request, fold, std::move(result));
}

template <typename Records>
storage_query_result query_sources(const storage_query_request &request, const Records &records,
                                   const std::map<uint64_t, std::vector<size_t>> &manifests_by_source, uint64_t limit,
                                   storage_query_result result) {
  std::vector<storage_source_query_row> rows;
  for (const auto &[source_uid, indices] : manifests_by_source) {
    const auto &latest = records.manifests.at(indices.back());
    const auto source_id = latest.source_id.to_string();
    if (!request.source_id.empty() && source_id != request.source_id)
      continue;
    const auto export_count = static_cast<uint64_t>(
        std::count_if(records.exports.begin(), records.exports.end(),
                      [source_uid](const auto &receipt) { return receipt.source_uid == source_uid; }));
    rows.push_back({source_uid,
                    source_id,
                    latest.source_type.to_string(),
                    latest.source_coordinate.to_string(),
                    latest.manifest_id.to_string(),
                    latest.source_head.to_string(),
                    latest.accept_time,
                    latest.entry_count,
                    {latest.sync_root_algo.to_string(), latest.sync_root_value.to_string()},
                    indices.size(),
                    export_count});
    if (rows.size() >= limit)
      break;
  }
  result.rows = std::move(rows);
  return result;
}

template <typename Records>
storage_query_result query_manifests(const storage_query_request &request, const Records &records,
                                     const std::map<uint64_t, std::vector<size_t>> &manifests_by_source, uint64_t limit,
                                     storage_query_result result) {
  std::vector<storage_manifest_query_row> rows;
  for (const auto &[source_uid, indices] : manifests_by_source) {
    (void)source_uid;
    const auto source_id = records.manifests.at(indices.back()).source_id.to_string();
    if (!request.source_id.empty() && source_id != request.source_id)
      continue;
    for (const auto index : indices) {
      const auto &record = records.manifests.at(index);
      rows.push_back({source_id,
                      record.manifest_id.to_string(),
                      record.accept_time,
                      record.entry_count,
                      record.entries_hash.to_string(),
                      {record.sync_root_algo.to_string(), record.sync_root_value.to_string()},
                      verification_status_text(record.status)});
      if (rows.size() >= limit)
        break;
    }
    if (rows.size() >= limit)
      break;
  }
  result.rows = std::move(rows);
  return result;
}

template <typename Record, typename Header>
bool storage_entry_matches(const storage_query_request &request, const Record &record, const Header &header,
                           const storage_entry_query_row &row) {
  return record.accept_time == header.accept_time &&
         (request.source_id.empty() || row.storage_source_id == request.source_id) &&
         (request.entry_kind.empty() || row.kind == request.entry_kind) &&
         ((request.range.since.empty() && request.range.until.empty()) || !row.source_time.empty()) &&
         (request.range.since.empty() || row.source_time >= request.range.since) &&
         (request.range.until.empty() || row.source_time <= request.range.until);
}

template <typename Records>
storage_query_result query_entries(const storage_query_request &request, const Records &records, uint64_t limit,
                                   storage_query_result result) {
  std::unordered_map<uint64_t, size_t> latest_by_manifest_uid;
  for (size_t index = 0; index < records.manifests.size(); ++index)
    latest_by_manifest_uid[records.manifests[index].manifest_uid] = index;
  std::vector<storage_entry_query_row> rows;
  for (const auto &record : records.entries) {
    const auto header_iter = latest_by_manifest_uid.find(record.manifest_uid);
    if (header_iter == latest_by_manifest_uid.end())
      continue;
    const auto &header = records.manifests.at(header_iter->second);
    storage_entry_query_row row{record.kind.to_string(),
                                record.entry_source_id.to_string(),
                                record.source_path.to_string(),
                                record.source_time.to_string(),
                                record.entry_schema_version,
                                record.content_type.to_string(),
                                record.payload_hash.to_string(),
                                record.byte_len,
                                payload_state_text(record.payload_state),
                                record.entry_index,
                                record.accept_time,
                                header.source_id.to_string(),
                                header.manifest_id.to_string()};
    if (!storage_entry_matches(request, record, header, row))
      continue;
    rows.push_back(std::move(row));
    if (rows.size() >= limit)
      break;
  }
  result.rows = std::move(rows);
  return result;
}

storage_query_result query_catalog_projection(const storage_query_request &request) {
  auto result = query_result_shell(request);
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty())
    result.source_id = request.source_id;
  result.projection_name = "manifest-catalog";
  result.projection_schema = yy_storage::MANIFEST_CATALOG_SCHEMA_V1;
  result.rebuildable = true;

  // Generic storage queries serve straight from the typed kernel journal
  // records. SQLite remains a derived projection used for parity/SQL access,
  // never the authority or an intermediate JSON query substrate.
  const auto records = catalog_store(request.runtime_dir).read_typed_records();
  const auto limit = request.limit == 0 ? uint64_t{1000} : std::min<uint64_t>(request.limit, 1000);
  std::map<uint64_t, std::vector<size_t>> manifests_by_source;
  for (size_t index = 0; index < records.manifests.size(); ++index) {
    manifests_by_source[records.manifests[index].source_uid].push_back(index);
  }

  if (request.query == storage_query_kind::Sources)
    return query_sources(request, records, manifests_by_source, limit, std::move(result));
  if (request.query == storage_query_kind::Manifests)
    return query_manifests(request, records, manifests_by_source, limit, std::move(result));

  if (request.query != storage_query_kind::Entries)
    throw std::invalid_argument("unsupported storage query: " + storage_query_kind_name(request.query));
  return query_entries(request, records, limit, std::move(result));
}

storage_query_result query_journal_projection(const storage_query_request &request) {
  return is_episode_query(request.query) ? query_episode_projection(request) : query_catalog_projection(request);
}

// Stage 3 deep verification (KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae point 4,
// KF-ADR-019f86da-4f90-7d72-bf9f-1d5913bbb0d5/0028): re-open the event journals the manifest claims frames from and
// verify each attached frame receipt against the actual frame — presence, header fields, and the recomputed
// payload/frame checksums. Opt-in via the fsck "verify_frames" option because it reads every referenced journal. A
// sealed (Ended) Episode with a missing or mismatched frame is failed; an open/aborted Episode is degraded with the
// exact missing side reported.

nlohmann::json storage_query_rows_json(const storage_query_rows &rows) {
  return std::visit(
      [](const auto &typed_rows) {
        using rows_t = std::decay_t<decltype(typed_rows)>;
        nlohmann::json rendered = nlohmann::json::array();
        for (const auto &row : typed_rows) {
          if constexpr (std::is_same_v<rows_t, std::vector<storage_source_query_row>>) {
            rendered.push_back({{"source_uid", row.source_uid},
                                {"source_id", row.source_id},
                                {"source_type", row.source_type},
                                {"coordinate", row.coordinate},
                                {"manifest_id", row.manifest_id},
                                {"source_head", row.source_head},
                                {"accept_time", row.accept_time},
                                {"entry_count", row.entry_count},
                                {"sync_root", {{"algorithm", row.sync_root.algorithm}, {"value", row.sync_root.value}}},
                                {"manifest_count", row.manifest_count},
                                {"export_count", row.export_count}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<storage_manifest_query_row>>) {
            rendered.push_back({{"manifest_id", row.manifest_id},
                                {"accept_time", row.accept_time},
                                {"entry_count", row.entry_count},
                                {"entries_hash", row.entries_hash},
                                {"sync_root", {{"algorithm", row.sync_root.algorithm}, {"value", row.sync_root.value}}},
                                {"status", row.status},
                                {"source_id", row.source_id}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<storage_entry_query_row>>) {
            rendered.push_back({{"kind", row.kind},
                                {"source_id", row.source_id},
                                {"source_path", row.source_path},
                                {"source_time", row.source_time},
                                {"schema_version", row.schema_version},
                                {"content_type", row.content_type},
                                {"payload_hash", row.payload_hash},
                                {"byte_len", row.byte_len},
                                {"payload_state", row.payload_state},
                                {"entry_index", row.entry_index},
                                {"accept_time", row.accept_time},
                                {"storage_source_id", row.storage_source_id},
                                {"manifest_id", row.manifest_id}});
          } else if constexpr (std::is_same_v<rows_t, std::vector<yy_storage::episode_current_view>>) {
            rendered.push_back(yy_storage::episode_summary_json(row));
          } else {
            rendered.push_back(episode_record_row_json(row));
          }
        }
        return rendered;
      },
      rows);
}

} // namespace detail

using namespace detail;

size_t storage_query_result::row_count() const {
  return std::visit([](const auto &typed_rows) { return typed_rows.size(); }, rows);
}

std::string storage_query_kind_name(storage_query_kind kind) {
  switch (kind) {
  case storage_query_kind::Sources:
    return "sources";
  case storage_query_kind::Manifests:
    return "manifests";
  case storage_query_kind::Entries:
    return "entries";
  case storage_query_kind::Episodes:
    return "episodes";
  case storage_query_kind::EpisodeRecords:
    return "episode_records";
  case storage_query_kind::EpisodeFrames:
    return "episode_frames";
  case storage_query_kind::EpisodeRefs:
    return "episode_refs";
  }
  throw std::invalid_argument("unknown storage query kind");
}

storage_query_kind parse_storage_query_kind(const std::string &kind) {
  const auto normalized = kind.empty() ? std::string("entries") : kind;
  if (normalized == "sources") {
    return storage_query_kind::Sources;
  }
  if (normalized == "manifests") {
    return storage_query_kind::Manifests;
  }
  if (normalized == "entries") {
    return storage_query_kind::Entries;
  }
  if (normalized == "episodes") {
    return storage_query_kind::Episodes;
  }
  if (normalized == "episode_records") {
    return storage_query_kind::EpisodeRecords;
  }
  if (normalized == "episode_frames") {
    return storage_query_kind::EpisodeFrames;
  }
  if (normalized == "episode_refs") {
    return storage_query_kind::EpisodeRefs;
  }
  throw std::invalid_argument("unsupported storage query: " + normalized);
}

storage_query_request parse_storage_query_request(const storage_service_options &options) {
  storage_query_request request{};
  request.runtime_dir = options.runtime_dir;
  request.provider = options.provider;
  request.provider_config_source = options.provider_config_source;
  request.source_id = options.source_id;
  request.entry_kind = options.kind;
  request.range.since = text_or(options.range, "since");
  request.range.until = text_or(options.range, "until");
  request.query = parse_storage_query_kind(options.query);
  request.episode_id = options.episode_id;
  request.limit = options.limit;
  return request;
}

nlohmann::json render_storage_query_result(const storage_query_result &result) {
  auto rows = storage_query_rows_json(result.rows);
  nlohmann::json rendered = {{"ok", result.ok},
                             {"scope", result.scope},
                             {"projection",
                              {{"name", result.projection_name},
                               {"schema", result.projection_schema},
                               {"authority", result.authority},
                               {"rebuildable", result.rebuildable}}},
                             {"query", storage_query_kind_name(result.query)},
                             {"limit", result.limit},
                             {"rows", std::move(rows)},
                             {"row_count", result.row_count()}};
  const bool episode_query =
      result.query == storage_query_kind::Episodes || result.query == storage_query_kind::EpisodeRecords ||
      result.query == storage_query_kind::EpisodeFrames || result.query == storage_query_kind::EpisodeRefs;
  if (episode_query) {
    rendered["episode_id"] =
        result.episode_id.has_value() ? nlohmann::json(*result.episode_id) : nlohmann::json(nullptr);
  } else {
    rendered["source_id"] = result.source_id.has_value() ? nlohmann::json(*result.source_id) : nlohmann::json(nullptr);
    rendered["kind"] = result.entry_kind.has_value() ? nlohmann::json(*result.entry_kind) : nlohmann::json(nullptr);
    nlohmann::json range = nlohmann::json::object();
    if (!result.range.since.empty()) {
      range["since"] = result.range.since;
    }
    if (!result.range.until.empty()) {
      range["until"] = result.range.until;
    }
    rendered["range"] = std::move(range);
  }
  if (!result.errors.empty()) {
    rendered["errors"] = nlohmann::json::array();
    for (const auto &error : result.errors) {
      nlohmann::json row = {{"code", error.code}};
      if (error.episode_id.has_value()) {
        row["episode_id"] = *error.episode_id;
      }
      rendered["errors"].push_back(std::move(row));
    }
  }
  return rendered;
}

} // namespace kungfu::runtime::storage_service_api
