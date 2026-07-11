// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/episode_manifest_projection.h>

#include <charconv>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <unordered_set>
#include <utility>
#include <variant>

#include <sqlite3.h>

#include <kungfu/runtime/cache/backend.h>
#include <kungfu/runtime/storage/projection_content.h>
#include <kungfu/runtime/storage/projection_transaction.h>
#include <kungfu/yijinjing/schema/registry.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>

namespace fs = std::filesystem;

namespace kungfu::runtime::storage_service_api {

namespace {

constexpr const char *QUERY_RECORDS_TABLE = "kf_episode_query_records_v1";

struct sqlite_closer {
  void operator()(sqlite3 *db) const {
    if (db != nullptr) {
      sqlite3_close(db);
    }
  }
};

struct statement_closer {
  void operator()(sqlite3_stmt *statement) const {
    if (statement != nullptr) {
      sqlite3_finalize(statement);
    }
  }
};

using sqlite_ptr = std::unique_ptr<sqlite3, sqlite_closer>;
using statement_ptr = std::unique_ptr<sqlite3_stmt, statement_closer>;

sqlite_ptr open_sqlite(const fs::path &path, int flags) {
  sqlite3 *raw = nullptr;
  const auto status = sqlite3_open_v2(path.string().c_str(), &raw, flags, nullptr);
  sqlite_ptr db(raw);
  if (status != SQLITE_OK) {
    throw std::runtime_error("unable to open Episode query projection: " +
                             std::string(raw == nullptr ? "unknown sqlite error" : sqlite3_errmsg(raw)));
  }
  sqlite3_busy_timeout(db.get(), 5000);
  return db;
}

void exec_sql(sqlite3 *db, const char *sql) {
  char *message = nullptr;
  const auto status = sqlite3_exec(db, sql, nullptr, nullptr, &message);
  if (status != SQLITE_OK) {
    const std::string detail = message == nullptr ? sqlite3_errmsg(db) : message;
    sqlite3_free(message);
    throw std::runtime_error("Episode query projection SQL failed: " + detail);
  }
}

statement_ptr prepare(sqlite3 *db, const char *sql) {
  sqlite3_stmt *raw = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &raw, nullptr) != SQLITE_OK) {
    throw std::runtime_error("Episode query projection prepare failed: " + std::string(sqlite3_errmsg(db)));
  }
  return statement_ptr(raw);
}

int32_t record_carrier_type(const yijinjing::storage::episode_manifest_record &record) {
  return std::visit(
      [](const auto &body) -> int32_t {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, yijinjing::storage::episode_manifest_unknown_record>) {
          return body.carrier_type;
        } else {
          return body_t::tag;
        }
      },
      record.body);
}

void rebuild_query_records(sqlite3 *db, const std::vector<yijinjing::storage::episode_manifest_record> &records) {
  exec_sql(db, "CREATE TABLE IF NOT EXISTS kf_episode_query_records_v1 ("
               "ordinal INTEGER PRIMARY KEY, manifest_frame_uid TEXT NOT NULL, "
               "manifest_gen_time INTEGER NOT NULL, carrier_type INTEGER NOT NULL, payload BLOB NOT NULL)");
  exec_sql(db, "DELETE FROM kf_episode_query_records_v1");
  auto insert = prepare(db, "INSERT INTO kf_episode_query_records_v1 "
                            "(ordinal, manifest_frame_uid, manifest_gen_time, carrier_type, payload) "
                            "VALUES (?, ?, ?, ?, ?)");
  for (size_t index = 0; index < records.size(); ++index) {
    const auto &record = records[index];
    const auto frame_uid = std::to_string(record.manifest_frame_uid);
    sqlite3_bind_int64(insert.get(), 1, static_cast<sqlite3_int64>(index));
    sqlite3_bind_text(insert.get(), 2, frame_uid.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(insert.get(), 3, record.manifest_gen_time);
    sqlite3_bind_int(insert.get(), 4, record_carrier_type(record));
    if (record.payload.empty()) {
      sqlite3_bind_zeroblob(insert.get(), 5, 0);
    } else {
      sqlite3_bind_blob(insert.get(), 5, record.payload.data(), static_cast<int>(record.payload.size()),
                        SQLITE_TRANSIENT);
    }
    if (sqlite3_step(insert.get()) != SQLITE_DONE) {
      throw std::runtime_error("Episode query projection insert failed: " + std::string(sqlite3_errmsg(db)));
    }
    sqlite3_reset(insert.get());
    sqlite3_clear_bindings(insert.get());
  }
}

uint64_t parse_frame_uid(const unsigned char *text) {
  if (text == nullptr) {
    throw std::runtime_error("Episode query projection contains a null frame uid");
  }
  const std::string value(reinterpret_cast<const char *>(text));
  uint64_t parsed = 0;
  const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
  if (error != std::errc{} || end != value.data() + value.size()) {
    throw std::runtime_error("Episode query projection contains an invalid frame uid");
  }
  return parsed;
}

fs::path projection_path(const std::string &runtime_dir) {
  return fs::path(runtime_dir) / "storage" / "projections" / "episode-manifest.sqlite";
}

template <typename DataType>
std::vector<DataType> records_of(const std::vector<yijinjing::storage::episode_manifest_record> &records) {
  std::vector<DataType> selected;
  for (const auto &record : records) {
    std::visit(
        [&](const auto &body) {
          using body_t = std::decay_t<decltype(body)>;
          if constexpr (std::is_same_v<body_t, DataType>) {
            selected.push_back(body);
          }
        },
        record.body);
  }
  return selected;
}

} // namespace

episode_manifest_projection::episode_manifest_projection(std::string runtime_dir)
    : runtime_dir_(std::move(runtime_dir)) {}

std::string episode_manifest_projection::sqlite_path() const { return projection_path(runtime_dir_).string(); }

bool episode_manifest_projection::exists() const { return fs::exists(projection_path(runtime_dir_)); }

storage_projection_rebuild_result episode_manifest_projection::rebuild_typed() const {
  const auto path = projection_path(runtime_dir_);
  fs::create_directories(path.parent_path());

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::EpisodeManifestDataTypes);
  storage->pragma.journal_mode(sqlite_orm::journal_mode::WAL);
  storage->pragma.synchronous(0);

  const auto records = yijinjing::storage::episode_manifest_store(runtime_dir_).read_typed_records();
  const auto all_opens = records_of<yijinjing::types::EpisodeOpen>(records);
  const auto heartbeats = records_of<yijinjing::types::EpisodeHeartbeat>(records);
  const auto frames = records_of<yijinjing::types::EpisodeFrameAttached>(records);
  const auto refs = records_of<yijinjing::types::EpisodeRefAttached>(records);
  const auto closes = records_of<yijinjing::types::EpisodeClosed>(records);
  const auto roots = records_of<yijinjing::types::EpisodeRootCommitted>(records);
  std::unordered_set<uint64_t> opened;
  std::vector<yijinjing::types::EpisodeOpen> opens;
  for (const auto &record : all_opens) {
    if (opened.insert(record.episode_id).second) {
      opens.push_back(record);
    }
  }
  const auto known_records =
      all_opens.size() + heartbeats.size() + frames.size() + refs.size() + closes.size() + roots.size();
  const auto unknown_skipped = records.size() - known_records;
  rebuild_projection_transaction(storage, [&](sqlite3 *db) {
    storage->sync_schema();
    storage->remove_all<yijinjing::types::EpisodeOpen>();
    storage->remove_all<yijinjing::types::EpisodeHeartbeat>();
    storage->remove_all<yijinjing::types::EpisodeFrameAttached>();
    storage->remove_all<yijinjing::types::EpisodeRefAttached>();
    storage->remove_all<yijinjing::types::EpisodeClosed>();
    storage->remove_all<yijinjing::types::EpisodeRootCommitted>();
    if (!opens.empty()) {
      storage->replace_range(opens.begin(), opens.end());
    }
    if (!heartbeats.empty()) {
      storage->replace_range(heartbeats.begin(), heartbeats.end());
    }
    if (!frames.empty()) {
      storage->replace_range(frames.begin(), frames.end());
    }
    if (!refs.empty()) {
      storage->replace_range(refs.begin(), refs.end());
    }
    if (!closes.empty()) {
      storage->replace_range(closes.begin(), closes.end());
    }
    if (!roots.empty()) {
      storage->replace_range(roots.begin(), roots.end());
    }
    rebuild_query_records(db, records);
  });

  return {true,
          EPISODE_MANIFEST_PROJECTION_SCHEMA_V1,
          runtime_dir_,
          "yijinjing-journal",
          "sqlite",
          path.string(),
          {{"episode_open", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeOpen>())},
           {"episode_heartbeat", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeHeartbeat>())},
           {"episode_frame_attached", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeFrameAttached>())},
           {"episode_ref_attached", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeRefAttached>())},
           {"episode_closed", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeClosed>())},
           {"episode_root_committed", static_cast<uint64_t>(storage->count<yijinjing::types::EpisodeRootCommitted>())}},
          {{"episode_manifest_records", static_cast<uint64_t>(records.size())},
           {"unknown_records_skipped", static_cast<uint64_t>(unknown_skipped)}},
          static_cast<uint64_t>(records.size())};
}

storage_projection_verify_result episode_manifest_projection::verify_typed() const {
  const auto path = projection_path(runtime_dir_);
  const auto records = yijinjing::storage::episode_manifest_store(runtime_dir_).read_typed_records();
  const auto expected_opens = snapshot_projection_content(records_of<yijinjing::types::EpisodeOpen>(records), true);
  const auto expected_heartbeats = snapshot_projection_content(records_of<yijinjing::types::EpisodeHeartbeat>(records));
  const auto expected_frames = snapshot_projection_content(records_of<yijinjing::types::EpisodeFrameAttached>(records));
  const auto expected_refs = snapshot_projection_content(records_of<yijinjing::types::EpisodeRefAttached>(records));
  const auto expected_closes = snapshot_projection_content(records_of<yijinjing::types::EpisodeClosed>(records));
  const auto expected_roots = snapshot_projection_content(records_of<yijinjing::types::EpisodeRootCommitted>(records));
  const bool has_records = !records.empty();

  if (!fs::exists(path)) {
    // Missing projection is a distinct honest state, not a silent ok: if the
    // journal has records, the projection needs a rebuild before SQL queries.
    storage_projection_verify_result result{};
    result.status = has_records ? "absent" : "ok";
    result.schema = EPISODE_MANIFEST_PROJECTION_SCHEMA_V1;
    result.runtime_dir = runtime_dir_;
    result.projection_present = false;
    result.note = has_records ? "projection not built; run episode_projection_rebuild to enable SQL queries"
                              : "no episode manifest records; projection not needed";
    return result;
  }

  auto storage = cache::make_storage_ptr(path.string(), yijinjing::EpisodeManifestDataTypes);
  storage->on_open = [](sqlite3 *db) { sqlite3_busy_timeout(db, 5000); };
  projection_content_snapshot projected_opens;
  projection_content_snapshot projected_heartbeats;
  projection_content_snapshot projected_frames;
  projection_content_snapshot projected_refs;
  projection_content_snapshot projected_closes;
  projection_content_snapshot projected_roots;
  try {
    projected_opens = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeOpen>(), true);
    projected_heartbeats = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeHeartbeat>());
    projected_frames = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeFrameAttached>());
    projected_refs = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeRefAttached>());
    projected_closes = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeClosed>());
    projected_roots = snapshot_projection_content(storage->get_all<yijinjing::types::EpisodeRootCommitted>());
  } catch (const std::exception &error) {
    return {false,
            "degraded",
            EPISODE_MANIFEST_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required: " + std::string(error.what()),
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  } catch (...) {
    return {false,
            "degraded",
            EPISODE_MANIFEST_PROJECTION_SCHEMA_V1,
            runtime_dir_,
            "yijinjing-journal",
            true,
            true,
            "projection schema unreadable; rebuild required",
            {{"__schema__", 0, 0, "schema_unreadable"}}};
  }

  std::vector<yijinjing::storage::episode_manifest_record> projected_records;
  try {
    projected_records = read_typed_records();
  } catch (const std::exception &) {
    projected_records.clear();
  }

  std::vector<storage_projection_drift> drift;
  const auto check = [&](const char *table, const projection_content_snapshot &projected,
                         const projection_content_snapshot &journal) {
    if (projected.digest != journal.digest) {
      drift.push_back({table, projected.rows, journal.rows,
                       projected.rows == journal.rows ? "content_mismatch" : "row_count_mismatch", projected.digest,
                       journal.digest});
    }
  };
  check("episode_open", projected_opens, expected_opens);
  check("episode_heartbeat", projected_heartbeats, expected_heartbeats);
  check("episode_frame_attached", projected_frames, expected_frames);
  check("episode_ref_attached", projected_refs, expected_refs);
  check("episode_closed", projected_closes, expected_closes);
  check("episode_root_committed", projected_roots, expected_roots);
  bool query_records_match = projected_records.size() == records.size();
  if (query_records_match) {
    for (size_t index = 0; index < records.size(); ++index) {
      const auto &authority = records[index];
      const auto &projected = projected_records[index];
      if (authority.manifest_frame_uid != projected.manifest_frame_uid ||
          authority.manifest_gen_time != projected.manifest_gen_time ||
          record_carrier_type(authority) != record_carrier_type(projected) || authority.payload != projected.payload) {
        query_records_match = false;
        break;
      }
    }
  }
  if (!query_records_match) {
    drift.push_back({QUERY_RECORDS_TABLE, static_cast<uint64_t>(projected_records.size()),
                     static_cast<uint64_t>(records.size()),
                     projected_records.size() == records.size() ? "content_mismatch" : "row_count_mismatch"});
  }

  const bool degraded = !drift.empty();
  return {!degraded,
          degraded ? "degraded" : "ok",
          EPISODE_MANIFEST_PROJECTION_SCHEMA_V1,
          runtime_dir_,
          "yijinjing-journal",
          true,
          degraded,
          {},
          std::move(drift),
          {{"episode_open", projected_opens.rows},
           {"episode_heartbeat", projected_heartbeats.rows},
           {"episode_frame_attached", projected_frames.rows},
           {"episode_ref_attached", projected_refs.rows},
           {"episode_closed", projected_closes.rows},
           {"episode_root_committed", projected_roots.rows},
           {QUERY_RECORDS_TABLE, static_cast<uint64_t>(projected_records.size())}},
          {{"episode_open", expected_opens.rows},
           {"episode_heartbeat", expected_heartbeats.rows},
           {"episode_frame_attached", expected_frames.rows},
           {"episode_ref_attached", expected_refs.rows},
           {"episode_closed", expected_closes.rows},
           {"episode_root_committed", expected_roots.rows},
           {"episode_manifest_records", static_cast<uint64_t>(records.size())}}};
}

std::vector<yijinjing::storage::episode_manifest_record> episode_manifest_projection::read_typed_records() const {
  const auto path = projection_path(runtime_dir_);
  if (!fs::exists(path)) {
    throw std::runtime_error("Episode query projection is absent; rebuild it before sqlite execution");
  }
  auto db = open_sqlite(path, SQLITE_OPEN_READONLY);
  auto select = prepare(db.get(), "SELECT ordinal, manifest_frame_uid, manifest_gen_time, carrier_type, payload "
                                  "FROM kf_episode_query_records_v1 ORDER BY ordinal ASC");
  std::vector<yijinjing::storage::episode_manifest_record> records;
  sqlite3_int64 expected_ordinal = 0;
  int status = SQLITE_OK;
  while ((status = sqlite3_step(select.get())) == SQLITE_ROW) {
    const auto ordinal = sqlite3_column_int64(select.get(), 0);
    if (ordinal != expected_ordinal++) {
      throw std::runtime_error("Episode query projection ordinals are not contiguous");
    }
    const auto frame_uid = parse_frame_uid(sqlite3_column_text(select.get(), 1));
    const auto gen_time = sqlite3_column_int64(select.get(), 2);
    const auto carrier_type = sqlite3_column_int(select.get(), 3);
    const auto *payload = sqlite3_column_blob(select.get(), 4);
    const auto payload_size = sqlite3_column_bytes(select.get(), 4);
    records.push_back(yijinjing::storage::decode_episode_manifest_record(carrier_type, frame_uid, gen_time, payload,
                                                                         static_cast<size_t>(payload_size)));
  }
  if (status != SQLITE_DONE) {
    throw std::runtime_error("Episode query projection read failed: " + std::string(sqlite3_errmsg(db.get())));
  }
  return records;
}

yijinjing::storage::episode_manifest_fold episode_manifest_projection::fold_typed_records() const {
  return yijinjing::storage::fold_episode_manifest_records(read_typed_records());
}

yijinjing::storage::episode_manifest_fold
episode_manifest_projection::fold_typed_records_until(uint64_t manifest_frame_uid) const {
  return yijinjing::storage::fold_episode_manifest_records_until(read_typed_records(), manifest_frame_uid);
}

} // namespace kungfu::runtime::storage_service_api
