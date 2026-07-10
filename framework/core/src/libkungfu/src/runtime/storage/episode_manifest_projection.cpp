// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/episode_manifest_projection.h>

#include <filesystem>
#include <set>
#include <tuple>
#include <unordered_set>
#include <utility>
#include <variant>

#include <kungfu/runtime/cache/backend.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "episode-manifest.sqlite";
}

// Distinct-primary-key journal counts. The SQLite tables upsert by primary
// key (EpisodeOpen by episode_id; EpisodeHeartbeat by episode_id+update_time;
// EpisodeFrameAttached by episode_id+frame_uid; EpisodeRefAttached by
// episode_id+ref_kind+ref_uid; EpisodeClosed and EpisodeRootCommitted by
// episode_id), so the honest expected row count is the distinct-PK count,
// not the raw append count.
struct distinct_counts {
  size_t opens = 0;
  size_t heartbeats = 0;
  size_t frames = 0;
  size_t refs = 0;
  size_t closes = 0;
  size_t roots = 0;
};

distinct_counts distinct_pk_counts(const std::vector<yijinjing::storage::episode_manifest_record> &records) {
  std::set<uint64_t> open_keys;
  std::set<std::pair<uint64_t, int64_t>> heartbeat_keys;
  std::set<std::pair<uint64_t, uint64_t>> frame_keys;
  std::set<std::tuple<uint64_t, int8_t, uint64_t>> ref_keys;
  std::set<uint64_t> close_keys;
  std::set<uint64_t> root_keys;
  for (const auto &record : records) {
    std::visit(
        [&](const auto &body) {
          using body_t = std::decay_t<decltype(body)>;
          if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeOpen>) {
            open_keys.insert(body.episode_id);
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeHeartbeat>) {
            heartbeat_keys.emplace(body.episode_id, body.update_time);
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeFrameAttached>) {
            frame_keys.emplace(body.episode_id, body.frame_uid);
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRefAttached>) {
            ref_keys.emplace(body.episode_id, static_cast<int8_t>(body.ref_kind), body.ref_uid);
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeClosed>) {
            close_keys.insert(body.episode_id);
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeRootCommitted>) {
            root_keys.insert(body.episode_id);
          }
        },
        record.body);
  }
  return {open_keys.size(), heartbeat_keys.size(), frame_keys.size(),
          ref_keys.size(),  close_keys.size(),     root_keys.size()};
}

} // namespace

episode_manifest_projection::episode_manifest_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string episode_manifest_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool episode_manifest_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

nlohmann::json episode_manifest_projection::rebuild() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::EpisodeManifestDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);
  storage->sync_schema();

  // The journal is the authority; the projection is a full rebuild over it.
  storage->remove_all<yijinjing::types::EpisodeOpen>();
  storage->remove_all<yijinjing::types::EpisodeHeartbeat>();
  storage->remove_all<yijinjing::types::EpisodeFrameAttached>();
  storage->remove_all<yijinjing::types::EpisodeRefAttached>();
  storage->remove_all<yijinjing::types::EpisodeClosed>();
  storage->remove_all<yijinjing::types::EpisodeRootCommitted>();

  const auto records = yijinjing::storage::episode_manifest_store(runtime_dir_).read_typed_records();
  std::unordered_set<uint64_t> opened;
  size_t unknown_skipped = 0;
  for (const auto &record : records) {
    std::visit(
        [&](const auto &body) {
          using body_t = std::decay_t<decltype(body)>;
          if constexpr (std::is_same_v<body_t, yijinjing::storage::episode_manifest_unknown_record>) {
            ++unknown_skipped;
          } else if constexpr (std::is_same_v<body_t, yijinjing::types::EpisodeOpen>) {
            // First open wins, matching the fold's immutable-identity rule.
            if (opened.insert(body.episode_id).second) {
              storage->replace(body);
            }
          } else {
            storage->replace(body);
          }
        },
        record.body);
  }

  return {
      {"ok", true},
      {"schema", EPISODE_MANIFEST_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection", "sqlite"},
      {"sqlite_path", path.string()},
      {"unknown_records_skipped", unknown_skipped},
      {"rows",
       {{"episode_open", storage->count<yijinjing::types::EpisodeOpen>()},
        {"episode_heartbeat", storage->count<yijinjing::types::EpisodeHeartbeat>()},
        {"episode_frame_attached", storage->count<yijinjing::types::EpisodeFrameAttached>()},
        {"episode_ref_attached", storage->count<yijinjing::types::EpisodeRefAttached>()},
        {"episode_closed", storage->count<yijinjing::types::EpisodeClosed>()},
        {"episode_root_committed", storage->count<yijinjing::types::EpisodeRootCommitted>()}}},
      {"journal_records", records.size()},
  };
}

nlohmann::json episode_manifest_projection::verify() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::episode_manifest_store(runtime_dir_).read_typed_records();
  const auto expected = distinct_pk_counts(records);
  const bool has_records = !records.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    return {
        {"ok", true},
        {"status", has_records ? "absent" : "ok"},
        {"schema", EPISODE_MANIFEST_PROJECTION_SCHEMA_V1},
        {"runtime_dir", runtime_dir_},
        {"authority", "yijinjing-journal"},
        {"projection_present", false},
        {"note", has_records ? "projection not built; run episode_projection_rebuild to enable SQL queries"
                             : "no episode manifest records; projection not needed"},
    };
  }

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::EpisodeManifestDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  storage->sync_schema();

  const size_t projected_opens = storage->count<yijinjing::types::EpisodeOpen>();
  const size_t projected_heartbeats = storage->count<yijinjing::types::EpisodeHeartbeat>();
  const size_t projected_frames = storage->count<yijinjing::types::EpisodeFrameAttached>();
  const size_t projected_refs = storage->count<yijinjing::types::EpisodeRefAttached>();
  const size_t projected_closes = storage->count<yijinjing::types::EpisodeClosed>();
  const size_t projected_roots = storage->count<yijinjing::types::EpisodeRootCommitted>();

  nlohmann::json drift = nlohmann::json::array();
  const auto check = [&](const char *table, size_t projected, size_t journal_expected) {
    if (projected != journal_expected) {
      drift.push_back({{"table", table}, {"projection_rows", projected}, {"journal_distinct", journal_expected}});
    }
  };
  check("episode_open", projected_opens, expected.opens);
  check("episode_heartbeat", projected_heartbeats, expected.heartbeats);
  check("episode_frame_attached", projected_frames, expected.frames);
  check("episode_ref_attached", projected_refs, expected.refs);
  check("episode_closed", projected_closes, expected.closes);
  check("episode_root_committed", projected_roots, expected.roots);

  const bool degraded = !drift.empty();
  return {
      {"ok", !degraded},
      {"status", degraded ? "degraded" : "ok"},
      {"schema", EPISODE_MANIFEST_PROJECTION_SCHEMA_V1},
      {"runtime_dir", runtime_dir_},
      {"authority", "yijinjing-journal"},
      {"projection_present", true},
      {"degraded", degraded},
      {"drift", drift},
      {"rows",
       {{"episode_open", projected_opens},
        {"episode_heartbeat", projected_heartbeats},
        {"episode_frame_attached", projected_frames},
        {"episode_ref_attached", projected_refs},
        {"episode_closed", projected_closes},
        {"episode_root_committed", projected_roots}}},
      {"journal_distinct",
       {{"episode_open", expected.opens},
        {"episode_heartbeat", expected.heartbeats},
        {"episode_frame_attached", expected.frames},
        {"episode_ref_attached", expected.refs},
        {"episode_closed", expected.closes},
        {"episode_root_committed", expected.roots}}},
  };
}

} // namespace kungfu::runtime::storage_service_api
