// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/storage/episode_manifest_projection.h>

#include <charconv>
#include <filesystem>
#include <memory>
#include <set>
#include <stdexcept>
#include <tuple>
#include <unordered_set>
#include <utility>
#include <variant>

#include <sqlite3.h>

#include <kungfu/runtime/cache/backend.h>
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

void rebuild_query_records(const fs::path &path,
                           const std::vector<yijinjing::storage::episode_manifest_record> &records) {
  auto db = open_sqlite(path, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE);
  exec_sql(db.get(), "CREATE TABLE IF NOT EXISTS kf_episode_query_records_v1 ("
                     "ordinal INTEGER PRIMARY KEY, manifest_frame_uid TEXT NOT NULL, "
                     "manifest_gen_time INTEGER NOT NULL, carrier_type INTEGER NOT NULL, payload BLOB NOT NULL)");
  exec_sql(db.get(), "BEGIN IMMEDIATE");
  try {
    exec_sql(db.get(), "DELETE FROM kf_episode_query_records_v1");
    auto insert = prepare(db.get(), "INSERT INTO kf_episode_query_records_v1 "
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
        throw std::runtime_error("Episode query projection insert failed: " + std::string(sqlite3_errmsg(db.get())));
      }
      sqlite3_reset(insert.get());
      sqlite3_clear_bindings(insert.get());
    }
    exec_sql(db.get(), "COMMIT");
  } catch (...) {
    sqlite3_exec(db.get(), "ROLLBACK", nullptr, nullptr, nullptr);
    throw;
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

storage_projection_rebuild_result episode_manifest_projection::rebuild_typed() const {
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
  rebuild_query_records(path, records);

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
  const auto expected = distinct_pk_counts(records);
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
  storage->sync_schema();

  const size_t projected_opens = storage->count<yijinjing::types::EpisodeOpen>();
  const size_t projected_heartbeats = storage->count<yijinjing::types::EpisodeHeartbeat>();
  const size_t projected_frames = storage->count<yijinjing::types::EpisodeFrameAttached>();
  const size_t projected_refs = storage->count<yijinjing::types::EpisodeRefAttached>();
  const size_t projected_closes = storage->count<yijinjing::types::EpisodeClosed>();
  const size_t projected_roots = storage->count<yijinjing::types::EpisodeRootCommitted>();

  std::vector<yijinjing::storage::episode_manifest_record> projected_records;
  try {
    projected_records = read_typed_records();
  } catch (const std::exception &) {
    projected_records.clear();
  }

  std::vector<storage_projection_drift> drift;
  const auto check = [&](const char *table, size_t projected, size_t journal_expected) {
    if (projected != journal_expected) {
      drift.push_back({table, static_cast<uint64_t>(projected), static_cast<uint64_t>(journal_expected)});
    }
  };
  check("episode_open", projected_opens, expected.opens);
  check("episode_heartbeat", projected_heartbeats, expected.heartbeats);
  check("episode_frame_attached", projected_frames, expected.frames);
  check("episode_ref_attached", projected_refs, expected.refs);
  check("episode_closed", projected_closes, expected.closes);
  check("episode_root_committed", projected_roots, expected.roots);
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
    drift.push_back(
        {QUERY_RECORDS_TABLE, static_cast<uint64_t>(projected_records.size()), static_cast<uint64_t>(records.size())});
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
          {{"episode_open", projected_opens},
           {"episode_heartbeat", projected_heartbeats},
           {"episode_frame_attached", projected_frames},
           {"episode_ref_attached", projected_refs},
           {"episode_closed", projected_closes},
           {"episode_root_committed", projected_roots},
           {QUERY_RECORDS_TABLE, static_cast<uint64_t>(projected_records.size())}},
          {{"episode_open", expected.opens},
           {"episode_heartbeat", expected.heartbeats},
           {"episode_frame_attached", expected.frames},
           {"episode_ref_attached", expected.refs},
           {"episode_closed", expected.closes},
           {"episode_root_committed", expected.roots},
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
