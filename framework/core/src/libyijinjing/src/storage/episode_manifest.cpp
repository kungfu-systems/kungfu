// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/episode_manifest.h>

#include <algorithm>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/time.h>

#ifdef _WINDOWS
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace kungfu::yijinjing::storage {

namespace {

namespace fs = std::filesystem;

constexpr uint32_t EPISODE_MANIFEST_SCHEMA_VERSION = 1;

template <size_t N> std::string fixed_string(const kungfu::array<char, N> &value) {
  size_t length = 0;
  while (length < N && value.value[length] != '\0') {
    ++length;
  }
  return std::string(value.value, length);
}

template <size_t N> void set_fixed_string(kungfu::array<char, N> &dest, const std::string &value) {
  kungfu::copy_string(dest, value.c_str());
}

const char *status_name(EpisodeStatus status) {
  switch (status) {
  case EpisodeStatus::Open:
    return "open";
  case EpisodeStatus::Ended:
    return "ended";
  case EpisodeStatus::Aborted:
    return "aborted";
  case EpisodeStatus::Tombstoned:
    return "tombstoned";
  }
  return "unknown";
}

const char *ref_kind_name(EpisodeRefKind kind) {
  switch (kind) {
  case EpisodeRefKind::InputFrame:
    return "input_frame";
  case EpisodeRefKind::Payload:
    return "payload";
  case EpisodeRefKind::Schema:
    return "schema";
  case EpisodeRefKind::Episode:
    return "episode";
  }
  return "unknown";
}

location_ptr manifest_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<kungfu::yijinjing::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, EPISODE_MANIFEST_NAMESPACE, EPISODE_MANIFEST_NAME,
                               locator);
}

writer make_writer(const std::string &runtime_dir) {
  return writer(manifest_location(runtime_dir), location::PUBLIC, true, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

// Data-root-scoped manifest writer guard (trust-boundary contract §3.1): an
// exclusive advisory lock on the lock file next to the manifest journal,
// acquired before every manifest append and released when the operation ends.
// Acquire-or-fail: a concurrent writer gets manifest_writer_busy instead of
// appending alongside the active one. This enforces the yijinjing
// single-writer-per-location rule by mechanism rather than convention.
class manifest_writer_guard {
public:
  explicit manifest_writer_guard(const std::string &lock_path) : lock_path_(lock_path) {
#ifdef _WINDOWS
    handle_ = CreateFileA(lock_path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                          OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("manifest_writer_guard: cannot open lock file " + lock_path);
    }
    OVERLAPPED overlapped{};
    if (LockFileEx(handle_, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped) == 0) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw std::runtime_error("manifest_writer_busy: another writer holds " + lock_path);
    }
#else
    fd_ = ::open(lock_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0644);
    if (fd_ < 0) {
      throw std::runtime_error("manifest_writer_guard: cannot open lock file " + lock_path);
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) {
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error("manifest_writer_busy: another writer holds " + lock_path);
    }
#endif
  }

  manifest_writer_guard(const manifest_writer_guard &) = delete;
  manifest_writer_guard &operator=(const manifest_writer_guard &) = delete;

  ~manifest_writer_guard() {
#ifdef _WINDOWS
    if (handle_ != INVALID_HANDLE_VALUE) {
      OVERLAPPED overlapped{};
      UnlockFileEx(handle_, 0, 1, 0, &overlapped);
      CloseHandle(handle_);
    }
#else
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_UN);
      ::close(fd_);
    }
#endif
  }

private:
  std::string lock_path_;
#ifdef _WINDOWS
  HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
  int fd_ = -1;
#endif
};

manifest_writer_guard acquire_writer_guard(const std::string &runtime_dir) {
  return manifest_writer_guard(episode_manifest_writer_lock_path(runtime_dir));
}

uint64_t generated_episode_id(const episode_begin_options &options) {
  const auto begin_time = options.begin_time == 0 ? time::now_in_nano() : options.begin_time;
  return fast_hash_str_64(options.actor + "|" + options.title + "|" + options.source + "|" +
                          std::to_string(options.location_uid) + "|" + std::to_string(begin_time));
}

template <typename T> nlohmann::json base_record_json(const char *kind, const T &record) {
  return {
      {"schema", EPISODE_MANIFEST_SCHEMA_V1},    {"record_kind", kind},
      {"schema_version", record.schema_version}, {"episode_id", record.episode_id},
      {"location_uid", record.location_uid},
  };
}

nlohmann::json record_json(const EpisodeOpen &record) {
  auto row = base_record_json("episode_open", record);
  row["status"] = status_name(EpisodeStatus::Open);
  row["parent_episode_id"] = record.parent_episode_id;
  row["root_trigger_frame_uid"] = record.root_trigger_frame_uid;
  row["begin_time"] = record.begin_time;
  row["title"] = fixed_string(record.title);
  row["actor"] = fixed_string(record.actor);
  row["source"] = fixed_string(record.source);
  return row;
}

nlohmann::json record_json(const EpisodeHeartbeat &record) {
  auto row = base_record_json("episode_heartbeat", record);
  row["update_time"] = record.update_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["note"] = fixed_string(record.note);
  return row;
}

nlohmann::json record_json(const EpisodeFrameAttached &record) {
  auto row = base_record_json("episode_frame_attached", record);
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

nlohmann::json record_json(const EpisodeRefAttached &record) {
  auto row = base_record_json("episode_ref_attached", record);
  row["ref_kind"] = ref_kind_name(record.ref_kind);
  row["ref_uid"] = record.ref_uid;
  row["update_time"] = record.update_time;
  row["ref_id"] = fixed_string(record.ref_id);
  row["ref_hash"] = fixed_string(record.ref_hash);
  return row;
}

nlohmann::json record_json(const EpisodeClosed &record) {
  auto row = base_record_json("episode_closed", record);
  row["status"] = status_name(record.status);
  row["end_time"] = record.end_time;
  row["last_frame_uid"] = record.last_frame_uid;
  row["frame_count"] = record.frame_count;
  row["reason"] = fixed_string(record.reason);
  return row;
}

// Edge projection of one typed record, including its manifest provenance.
nlohmann::json record_row_json(const episode_manifest_record &record) {
  auto row = std::visit(
      [&record](const auto &body) -> nlohmann::json {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, episode_manifest_unknown_record>) {
          return {{"schema", EPISODE_MANIFEST_SCHEMA_V1},
                  {"record_kind", "unknown"},
                  {"carrier_type", body.carrier_type},
                  {"frame_uid", record.manifest_frame_uid},
                  {"gen_time", record.manifest_gen_time}};
        } else {
          return record_json(body);
        }
      },
      record.body);
  row["manifest_frame_uid"] = record.manifest_frame_uid;
  row["manifest_gen_time"] = record.manifest_gen_time;
  return row;
}

// Decode one manifest frame into its typed v1 record. A frame with an
// unrecognized carrier type, a schema_version newer than v1, or a payload too
// short for its record layout stays an unknown record: preserved with
// provenance, never folded, so a newer writer does not brick this reader.
template <typename T> bool decode_v1_record(const frame_ptr &frame, episode_manifest_record &record) {
  if (frame->data_length() < sizeof(T)) {
    return false;
  }
  if (frame->data<T>().schema_version > EPISODE_MANIFEST_SCHEMA_VERSION) {
    return false;
  }
  record.body = frame->data<T>();
  return true;
}

episode_manifest_record decode_record(const frame_ptr &frame) {
  episode_manifest_record record{};
  record.manifest_frame_uid = frame->frame_uid();
  record.manifest_gen_time = frame->gen_time();
  bool decoded = false;
  switch (frame->carrier_type()) {
  case EpisodeOpen::tag:
    decoded = decode_v1_record<EpisodeOpen>(frame, record);
    break;
  case EpisodeHeartbeat::tag:
    decoded = decode_v1_record<EpisodeHeartbeat>(frame, record);
    break;
  case EpisodeFrameAttached::tag:
    decoded = decode_v1_record<EpisodeFrameAttached>(frame, record);
    break;
  case EpisodeRefAttached::tag:
    decoded = decode_v1_record<EpisodeRefAttached>(frame, record);
    break;
  case EpisodeClosed::tag:
    decoded = decode_v1_record<EpisodeClosed>(frame, record);
    break;
  default:
    break;
  }
  if (!decoded) {
    episode_manifest_unknown_record unknown{};
    unknown.carrier_type = frame->carrier_type();
    if (frame->data_length() >= sizeof(uint32_t)) {
      // Every v1 record starts with a uint32 schema_version; reading that
      // prefix is safe even when the rest of the layout is unknown.
      unknown.schema_version = *static_cast<const uint32_t *>(frame->data_address());
      unknown.unknown_version = unknown.schema_version > EPISODE_MANIFEST_SCHEMA_VERSION;
    }
    record.body = unknown;
  }
  return record;
}

uint64_t record_episode_id(const episode_manifest_record &record) {
  return std::visit(
      [](const auto &body) -> uint64_t {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, episode_manifest_unknown_record>) {
          return 0;
        } else {
          return body.episode_id;
        }
      },
      record.body);
}

// The deterministic fold: records apply strictly in append order, so the
// current view is a pure function of the journal content. Identity is
// first-open-wins; watermarks are last-writer-wins; collections keep append
// order including duplicates.
void fold_into(episode_manifest_fold &fold, const episode_manifest_record &record) {
  ++fold.total_record_count;
  if (std::holds_alternative<episode_manifest_unknown_record>(record.body)) {
    ++fold.unknown_record_count;
    return;
  }
  const auto episode_id = record_episode_id(record);
  if (episode_id == 0) {
    ++fold.unfolded_record_count;
    return;
  }
  auto &view = fold.episodes[episode_id];
  view.episode_id = episode_id;
  view.records.push_back(record);
  const auto record_index = view.records.size() - 1;
  std::visit(
      [&view, &record, record_index](const auto &body) {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, EpisodeOpen>) {
          ++view.open_count;
          if (!view.opened) {
            view.opened = true;
            view.open = body;
            view.open_manifest_frame_uid = record.manifest_frame_uid;
            view.open_manifest_gen_time = record.manifest_gen_time;
          }
        } else if constexpr (std::is_same_v<body_t, EpisodeHeartbeat>) {
          view.heartbeat_seen = true;
          view.update_time = body.update_time;
          view.claimed_frame_count = body.frame_count;
          view.last_frame_uid_seen = true;
          view.last_frame_uid = body.last_frame_uid;
        } else if constexpr (std::is_same_v<body_t, EpisodeFrameAttached>) {
          if (body.frame_uid == 0) {
            ++view.missing_frame_uid_count;
          } else {
            const auto duplicate =
                std::any_of(view.frame_indices.begin(), view.frame_indices.end(), [&view, &body](size_t index) {
                  return std::get<EpisodeFrameAttached>(view.records[index].body).frame_uid == body.frame_uid;
                });
            if (duplicate) {
              view.duplicate_frame_uids.push_back(body.frame_uid);
            } else {
              ++view.unique_frame_count;
            }
          }
          view.frame_indices.push_back(record_index);
          view.last_frame_uid_seen = true;
          view.last_frame_uid = body.frame_uid;
        } else if constexpr (std::is_same_v<body_t, EpisodeRefAttached>) {
          view.ref_indices.push_back(record_index);
        } else if constexpr (std::is_same_v<body_t, EpisodeClosed>) {
          ++view.close_count;
          view.closed = true;
          view.close = body;
          view.close_statuses.push_back(body.status);
          view.claimed_frame_count = body.frame_count;
          view.last_frame_uid_seen = true;
          view.last_frame_uid = body.last_frame_uid;
        }
      },
      record.body);
}

// Edge projection of the folded current view. Key set matches the v1 edge
// JSON shape: identity keys appear when the Episode has an open record,
// watermark keys when a writer produced them, and the computed counts always.
nlohmann::json summary_json(const episode_current_view &view) {
  nlohmann::json summary = nlohmann::json::object();
  if (view.opened) {
    summary = record_json(view.open);
    summary["manifest_frame_uid"] = view.open_manifest_frame_uid;
    summary["manifest_gen_time"] = view.open_manifest_gen_time;
  }
  if (view.heartbeat_seen) {
    summary["update_time"] = view.update_time;
  }
  if (view.last_frame_uid_seen) {
    summary["last_frame_uid"] = view.last_frame_uid;
  }
  if (view.closed) {
    summary["status"] = status_name(view.close.status);
    summary["end_time"] = view.close.end_time;
    summary["reason"] = fixed_string(view.close.reason);
  }
  summary["schema"] = EPISODE_MANIFEST_SCHEMA_V1;
  summary["episode_id"] = view.episode_id;
  summary["opened"] = view.opened;
  summary["closed"] = view.closed;
  summary["record_count"] = view.records.size();
  summary["frame_count"] = view.frame_indices.size();
  summary["ref_count"] = view.ref_indices.size();
  if (!summary.contains("status")) {
    summary["status"] = view.opened ? "open" : "dangling";
  }
  return summary;
}

nlohmann::json rows_json(const episode_current_view &view, const std::vector<size_t> &indices) {
  nlohmann::json rows = nlohmann::json::array();
  for (const auto index : indices) {
    rows.push_back(record_row_json(view.records[index]));
  }
  return rows;
}

nlohmann::json records_json(const episode_current_view &view) {
  nlohmann::json rows = nlohmann::json::array();
  for (const auto &record : view.records) {
    rows.push_back(record_row_json(record));
  }
  return rows;
}

bool contains_u64(const std::vector<uint64_t> &values, uint64_t value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

// ADR-0041 stage 4: a payload ref resolves through the ADR-0040 immutable
// content_store by its content identity (ref_hash); ref_id is an edge label
// with no resolution role. The verified read maps the store's declared error
// taxonomy onto manifest diagnostics -- there is no path fallback.
struct payload_ref_resolution {
  const char *status = "missing"; // dependency status for the causal graph
  const char *code = nullptr;     // issue code when the ref is not verified
  std::string detail = {};
};

payload_ref_resolution resolve_payload_ref(const std::string &runtime_dir, const std::string &ref_hash) {
  content_hash hash{};
  try {
    // canonical form is "<algo>:<hex>"; bare hex from earlier producers is
    // accepted as the store's default algorithm
    hash = ref_hash.find(':') != std::string::npos ? parse_content_hash(ref_hash) : make_content_hash(ref_hash);
  } catch (const std::exception &e) {
    return {"unaddressable", "episode_payload_ref_hash_invalid", e.what()};
  }
  file_content_store store((fs::path(runtime_dir) / "storage").string());
  const auto verified = store.verify("payloads", hash);
  switch (verified.error) {
  case content_store_error::Ok:
    return {"present", nullptr, {}};
  case content_store_error::NotFound:
    return {"missing", "episode_payload_ref_missing", verified.message};
  case content_store_error::CorruptObject:
    return {"hash_mismatch", "episode_payload_ref_hash_mismatch", verified.message};
  case content_store_error::InvalidArgument:
    return {"unaddressable", "episode_payload_ref_hash_invalid", verified.message};
  default:
    return {"unreadable", "episode_payload_ref_io_error", verified.message};
  }
}

struct episode_graph {
  nlohmann::json graph = nlohmann::json::object();
  nlohmann::json dependencies = nlohmann::json::array();
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  bool degraded = false;
};

episode_graph build_causal_graph(const std::string &runtime_dir, uint64_t episode_id, const episode_current_view &view,
                                 const std::map<uint64_t, episode_current_view> &folded) {
  std::vector<uint64_t> frame_uids;
  std::vector<uint64_t> declared_input_frames;
  nlohmann::json frame_edges = nlohmann::json::array();
  nlohmann::json dependencies = nlohmann::json::array();
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  bool degraded = false;
  const bool sealed = view.closed && view.close.status == EpisodeStatus::Ended;

  for (size_t position = 0; position < view.frame_indices.size(); ++position) {
    const auto frame_uid = view.frame_at(position).frame_uid;
    if (frame_uid != 0) {
      frame_uids.push_back(frame_uid);
    }
  }
  for (size_t position = 0; position < view.ref_indices.size(); ++position) {
    const auto &ref = view.ref_at(position);
    if (ref.ref_kind == EpisodeRefKind::InputFrame && ref.ref_uid != 0) {
      declared_input_frames.push_back(ref.ref_uid);
    }
  }

  const auto parent_episode_id = view.opened ? view.open.parent_episode_id : uint64_t{0};
  if (parent_episode_id != 0) {
    const bool present = folded.find(parent_episode_id) != folded.end();
    const auto status = present ? "present" : "missing";
    dependencies.push_back(
        {{"kind", "episode"}, {"role", "parent"}, {"episode_id", parent_episode_id}, {"status", status}});
    if (!present) {
      degraded = true;
      warnings.push_back({{"code", "episode_dependency_missing"},
                          {"episode_id", episode_id},
                          {"dependency_episode_id", parent_episode_id},
                          {"role", "parent"}});
    }
  }

  const auto root_trigger_frame_uid = view.opened ? view.open.root_trigger_frame_uid : uint64_t{0};
  if (root_trigger_frame_uid != 0 && !contains_u64(frame_uids, root_trigger_frame_uid)) {
    const bool declared = contains_u64(declared_input_frames, root_trigger_frame_uid);
    dependencies.push_back({{"kind", "frame"},
                            {"role", "root_trigger"},
                            {"frame_uid", root_trigger_frame_uid},
                            {"status", declared ? "declared_external" : "missing"}});
    if (!declared) {
      degraded = true;
      warnings.push_back({{"code", "episode_root_trigger_frame_missing"},
                          {"episode_id", episode_id},
                          {"frame_uid", root_trigger_frame_uid}});
    }
  }

  for (size_t position = 0; position < view.frame_indices.size(); ++position) {
    const auto &frame = view.frame_at(position);
    if (frame.trigger_frame_uid == 0) {
      continue;
    }
    if (contains_u64(frame_uids, frame.trigger_frame_uid)) {
      frame_edges.push_back({{"kind", "frame_trigger"},
                             {"scope", "internal"},
                             {"from_frame_uid", frame.trigger_frame_uid},
                             {"to_frame_uid", frame.frame_uid}});
      continue;
    }
    const bool declared = contains_u64(declared_input_frames, frame.trigger_frame_uid);
    dependencies.push_back({{"kind", "frame"},
                            {"role", "trigger"},
                            {"frame_uid", frame.trigger_frame_uid},
                            {"dependent_frame_uid", frame.frame_uid},
                            {"status", declared ? "declared_external" : "missing"}});
    if (!declared) {
      degraded = true;
      warnings.push_back({{"code", "episode_trigger_frame_missing"},
                          {"episode_id", episode_id},
                          {"frame_uid", frame.trigger_frame_uid},
                          {"dependent_frame_uid", frame.frame_uid}});
    }
  }

  for (size_t position = 0; position < view.ref_indices.size(); ++position) {
    const auto &ref = view.ref_at(position);
    const auto ref_id = fixed_string(ref.ref_id);
    const auto ref_hash = fixed_string(ref.ref_hash);
    if (ref.ref_kind == EpisodeRefKind::Episode) {
      const bool present = ref.ref_uid != 0 && folded.find(ref.ref_uid) != folded.end();
      const bool declared_external = ref.ref_uid == 0 || !ref_id.empty();
      const auto status = present ? "present" : (declared_external ? "declared_external" : "missing");
      dependencies.push_back({{"kind", "episode"},
                              {"role", "ref"},
                              {"episode_id", ref.ref_uid},
                              {"ref_id", ref_id},
                              {"ref_hash", ref_hash},
                              {"status", status}});
      if (!present && !declared_external) {
        degraded = true;
        warnings.push_back({{"code", "episode_dependency_missing"},
                            {"episode_id", episode_id},
                            {"dependency_episode_id", ref.ref_uid},
                            {"role", "ref"}});
      }
    } else if (ref.ref_kind == EpisodeRefKind::Payload) {
      const auto resolved = resolve_payload_ref(runtime_dir, ref_hash);
      dependencies.push_back({{"kind", "payload"},
                              {"role", "payload_ref"},
                              {"ref_uid", ref.ref_uid},
                              {"ref_id", ref_id},
                              {"ref_hash", ref_hash},
                              {"status", resolved.status}});
      if (resolved.code != nullptr) {
        nlohmann::json issue = {
            {"code", resolved.code}, {"episode_id", episode_id}, {"ref_id", ref_id}, {"ref_hash", ref_hash}};
        if (!resolved.detail.empty()) {
          issue["detail"] = resolved.detail;
        }
        // A seal claims the Episode's material is complete and intact; an
        // unverified payload ref falsifies a sealed Episode and only
        // degrades an open one (trust-boundary contract §3.2).
        if (sealed) {
          errors.push_back(std::move(issue));
        } else {
          degraded = true;
          warnings.push_back(std::move(issue));
        }
      }
    } else if (ref.ref_kind == EpisodeRefKind::Schema) {
      dependencies.push_back({{"kind", "schema"},
                              {"role", "schema_ref"},
                              {"ref_uid", ref.ref_uid},
                              {"ref_id", ref_id},
                              {"ref_hash", ref_hash},
                              {"status", "declared"}});
    }
  }

  return {{{
               "schema",
               "kungfu.episode.causal-graph/v1",
           },
           {"episode_id", episode_id},
           {"frame_count", frame_uids.size()},
           {"edge_count", frame_edges.size()},
           {"dependency_count", dependencies.size()},
           {"degraded", degraded},
           {"edges", frame_edges},
           {"dependencies", dependencies}},
          dependencies,
          errors,
          warnings,
          degraded};
}

} // namespace

std::string episode_manifest_writer_lock_path(const std::string &runtime_dir) {
  const auto location = manifest_location(runtime_dir);
  return (fs::path(location->locator->layout_dir(location, enums::layout::JOURNAL, true)) / "writer.lock").string();
}

episode_manifest_store::episode_manifest_store(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

nlohmann::json episode_manifest_store::begin(const episode_begin_options &options) const {
  EpisodeOpen record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = options.episode_id == 0 ? generated_episode_id(options) : options.episode_id;
  record.parent_episode_id = options.parent_episode_id;
  record.root_trigger_frame_uid = options.root_trigger_frame_uid;
  record.location_uid = options.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.location_uid;
  record.begin_time = options.begin_time == 0 ? time::now_in_nano() : options.begin_time;
  set_fixed_string(record.title, options.title);
  set_fixed_string(record.actor, options.actor);
  set_fixed_string(record.source, options.source);
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.begin_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::heartbeat(const episode_heartbeat_options &options) const {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required");
  }
  EpisodeHeartbeat record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = options.episode_id;
  record.location_uid = options.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.location_uid;
  record.update_time = options.update_time == 0 ? time::now_in_nano() : options.update_time;
  record.last_frame_uid = options.last_frame_uid;
  record.frame_count = options.frame_count;
  set_fixed_string(record.note, options.note);
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.update_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::attach_frame(const episode_frame_attach_options &options) const {
  if (options.episode_id == 0 || options.frame_uid == 0) {
    throw std::invalid_argument("episode_id and frame_uid are required");
  }
  EpisodeFrameAttached record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = options.episode_id;
  record.location_uid = options.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.location_uid;
  record.frame_uid = options.frame_uid;
  record.trigger_frame_uid = options.trigger_frame_uid;
  record.stream_id = options.stream_id;
  record.gen_time = options.gen_time == 0 ? time::now_in_nano() : options.gen_time;
  record.trigger_time = options.trigger_time;
  record.carrier_type = options.carrier_type;
  record.source = options.source;
  record.dest = options.dest;
  record.data_length = options.data_length;
  record.integrity_version = options.integrity_version;
  record.payload_checksum = options.payload_checksum;
  record.frame_checksum = options.frame_checksum;
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.gen_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::attach_ref(const episode_ref_attach_options &options) const {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required");
  }
  EpisodeRefAttached record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = options.episode_id;
  record.location_uid = options.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.location_uid;
  record.ref_kind = options.ref_kind;
  record.ref_uid = options.ref_uid;
  record.update_time = options.update_time == 0 ? time::now_in_nano() : options.update_time;
  set_fixed_string(record.ref_id, options.ref_id);
  set_fixed_string(record.ref_hash, options.ref_hash);
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.update_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::end(const episode_close_options &options) const {
  if (options.episode_id == 0) {
    throw std::invalid_argument("episode_id is required");
  }
  EpisodeClosed record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = options.episode_id;
  record.location_uid = options.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.location_uid;
  record.status = options.status;
  record.end_time = options.end_time == 0 ? time::now_in_nano() : options.end_time;
  record.last_frame_uid = options.last_frame_uid;
  record.frame_count = options.frame_count;
  set_fixed_string(record.reason, options.reason);
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.end_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::abort(const episode_close_options &options) const {
  auto abort_options = options;
  abort_options.status = EpisodeStatus::Aborted;
  return end(abort_options);
}

nlohmann::json episode_manifest_store::recover(const episode_recover_options &options) const {
  const auto guard = acquire_writer_guard(runtime_dir_);
  const auto fold = fold_typed_records();
  const auto end_time = options.end_time == 0 ? time::now_in_nano() : options.end_time;
  const auto reason = options.reason.empty() ? std::string("recovered") : options.reason;
  std::vector<EpisodeClosed> closes;
  nlohmann::json skipped = nlohmann::json::array();
  for (const auto &[episode_id, view] : fold.episodes) {
    if (!view.opened || view.closed) {
      continue;
    }
    if (options.episode_id != 0 && episode_id != options.episode_id) {
      continue;
    }
    if (options.location_uid != 0 && view.open.location_uid != options.location_uid) {
      // Open Episodes owned by another location are reported, never mutated.
      skipped.push_back({{"episode_id", episode_id}, {"location_uid", view.open.location_uid}});
      continue;
    }
    EpisodeClosed record{};
    record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
    record.episode_id = episode_id;
    record.location_uid = view.open.location_uid;
    record.status = EpisodeStatus::Aborted;
    record.end_time = end_time;
    record.last_frame_uid = view.last_frame_uid;
    record.frame_count = view.frame_indices.size();
    set_fixed_string(record.reason, reason);
    closes.push_back(record);
  }
  nlohmann::json recovered = nlohmann::json::array();
  if (!closes.empty()) {
    auto writer = make_writer(runtime_dir_);
    for (const auto &record : closes) {
      writer.write_at(record.end_time, 0, record);
      recovered.push_back(record_json(record));
    }
  }
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"recovered", recovered},
          {"recovered_count", recovered.size()},
          {"skipped_open", skipped},
          {"skipped_count", skipped.size()}};
}

void episode_manifest_store::for_each_typed_record(const episode_manifest_record_visitor &visit) const {
  const auto location = manifest_location(runtime_dir_);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    visit(decode_record(reader->current_frame()));
    reader->next();
  }
}

std::vector<episode_manifest_record> episode_manifest_store::read_typed_records() const {
  std::vector<episode_manifest_record> records;
  for_each_typed_record([&records](const episode_manifest_record &record) { records.push_back(record); });
  return records;
}

episode_manifest_fold episode_manifest_store::fold_typed_records() const {
  episode_manifest_fold fold;
  for_each_typed_record([&fold](const episode_manifest_record &record) { fold_into(fold, record); });
  return fold;
}

nlohmann::json episode_manifest_store::list(uint64_t location_uid, uint64_t limit) const {
  const auto fold = fold_typed_records();
  nlohmann::json episodes = nlohmann::json::array();
  for (auto iter = fold.episodes.rbegin(); iter != fold.episodes.rend(); ++iter) {
    const auto &view = iter->second;
    const auto view_location_uid = view.opened ? view.open.location_uid : uint32_t{0};
    if (location_uid != 0 && view_location_uid != location_uid) {
      continue;
    }
    episodes.push_back(summary_json(view));
    if (limit != 0 && episodes.size() >= limit) {
      break;
    }
  }
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"episodes", episodes},
          {"episode_count", episodes.size()}};
}

nlohmann::json episode_manifest_store::inspect(uint64_t episode_id) const {
  if (episode_id == 0) {
    throw std::invalid_argument("episode_id is required");
  }
  const auto fold = fold_typed_records();
  const auto iter = fold.episodes.find(episode_id);
  if (iter == fold.episodes.end()) {
    return {{"ok", false},
            {"schema", EPISODE_MANIFEST_SCHEMA_V1},
            {"episode_id", episode_id},
            {"errors", nlohmann::json::array({{{"code", "episode_missing"}, {"episode_id", episode_id}}})}};
  }
  const auto &view = iter->second;
  const auto graph = build_causal_graph(runtime_dir_, episode_id, view, fold.episodes);
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"episode", summary_json(view)},
          {"causal_graph", graph.graph},
          {"dependencies", graph.dependencies},
          {"records", records_json(view)},
          {"frames", rows_json(view, view.frame_indices)},
          {"refs", rows_json(view, view.ref_indices)}};
}

nlohmann::json episode_manifest_store::fsck(uint64_t episode_id) const {
  const auto fold = fold_typed_records();
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  size_t checked = 0;
  bool degraded = false;
  for (const auto &[current_episode_id, view] : fold.episodes) {
    if (episode_id != 0 && current_episode_id != episode_id) {
      continue;
    }
    ++checked;
    if (!view.opened) {
      errors.push_back({{"code", "episode_open_missing"}, {"episode_id", current_episode_id}});
    }
    for (size_t occurrence = 0; occurrence < view.missing_frame_uid_count; ++occurrence) {
      errors.push_back({{"code", "episode_frame_uid_missing"}, {"episode_id", current_episode_id}});
    }
    for (const auto frame_uid : view.duplicate_frame_uids) {
      warnings.push_back(
          {{"code", "episode_frame_duplicate"}, {"episode_id", current_episode_id}, {"frame_uid", frame_uid}});
    }
    if (view.open_count > 1) {
      errors.push_back(
          {{"code", "episode_open_duplicate"}, {"episode_id", current_episode_id}, {"count", view.open_count}});
    }
    if (view.close_count > 1) {
      // The append-only tombstone path (a Tombstoned close after the seal) is
      // intentional, not a duplicate-close anomaly.
      bool extra_closes_are_tombstones = view.close.status == EpisodeStatus::Tombstoned;
      for (size_t index = 1; extra_closes_are_tombstones && index < view.close_statuses.size(); ++index) {
        extra_closes_are_tombstones = view.close_statuses[index] == EpisodeStatus::Tombstoned;
      }
      if (extra_closes_are_tombstones) {
        warnings.push_back(
            {{"code", "episode_tombstoned"}, {"episode_id", current_episode_id}, {"count", view.close_count}});
      } else {
        warnings.push_back(
            {{"code", "episode_closed_duplicate"}, {"episode_id", current_episode_id}, {"count", view.close_count}});
      }
    }
    if (view.closed) {
      const auto close_status = view.close.status;
      const bool status_valid = close_status == EpisodeStatus::Ended || close_status == EpisodeStatus::Aborted ||
                                close_status == EpisodeStatus::Tombstoned;
      if (!status_valid) {
        errors.push_back({{"code", "episode_close_status_invalid"},
                          {"episode_id", current_episode_id},
                          {"status", static_cast<int32_t>(close_status)}});
      }
      // A seal is a claim about the Episode's content; the fold is the actual.
      if (close_status == EpisodeStatus::Ended) {
        if (view.close.frame_count != view.unique_frame_count) {
          errors.push_back({{"code", "episode_seal_frame_count_mismatch"},
                            {"episode_id", current_episode_id},
                            {"claimed", view.close.frame_count},
                            {"actual", view.unique_frame_count}});
        }
        if (view.close.last_frame_uid != 0) {
          bool claimed_last_present = false;
          for (size_t position = 0; !claimed_last_present && position < view.frame_indices.size(); ++position) {
            claimed_last_present = view.frame_at(position).frame_uid == view.close.last_frame_uid;
          }
          if (!claimed_last_present) {
            errors.push_back({{"code", "episode_seal_last_frame_missing"},
                              {"episode_id", current_episode_id},
                              {"frame_uid", view.close.last_frame_uid}});
          }
        }
      }
    }
    const auto graph = build_causal_graph(runtime_dir_, current_episode_id, view, fold.episodes);
    degraded = degraded || graph.degraded;
    for (const auto &error : graph.errors) {
      errors.push_back(error);
    }
    for (const auto &warning : graph.warnings) {
      warnings.push_back(warning);
    }
  }
  if (fold.unknown_record_count > 0) {
    warnings.push_back({{"code", "manifest_unknown_records"}, {"count", fold.unknown_record_count}});
  }
  if (fold.unfolded_record_count > 0) {
    warnings.push_back({{"code", "manifest_record_episode_id_missing"}, {"count", fold.unfolded_record_count}});
  }
  if (episode_id != 0 && checked == 0) {
    errors.push_back({{"code", "episode_missing"}, {"episode_id", episode_id}});
  }
  return {{"ok", errors.empty()},
          {"status", errors.empty() ? (degraded ? "degraded" : "ok") : "failed"},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"degraded", degraded},
          {"errors", errors},
          {"warnings", warnings},
          {"checked",
           {{"episode_manifest_records", fold.total_record_count},
            {"episodes", checked},
            {"unknown_records", fold.unknown_record_count},
            {"unfolded_records", fold.unfolded_record_count}}}};
}

} // namespace kungfu::yijinjing::storage
