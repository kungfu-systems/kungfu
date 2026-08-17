// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/episode_manifest.h>

#include <algorithm>
#include <cstring>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/io/advisory_file_lock.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/content_store.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using kungfu::yijinjing::io::advisory_file_lock;
using kungfu::yijinjing::io::advisory_file_lock_error;
using kungfu::yijinjing::io::advisory_file_lock_options;
using kungfu::yijinjing::io::advisory_lock_operation;
using kungfu::yijinjing::io::advisory_lock_region;
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
  return writer(manifest_location(runtime_dir), location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

// The manifest retains its data-root path and acquire-or-fail contract; only
// the byte-range OS mechanics are shared with the other authority writers.
advisory_file_lock acquire_writer_guard(const std::string &runtime_dir) {
  const auto lock_path = episode_manifest_writer_lock_path(runtime_dir);
  auto options = advisory_file_lock_options{};
  options.region = advisory_lock_region::byte(0);
  try {
    return advisory_file_lock(lock_path, options);
  } catch (const advisory_file_lock_error &error) {
    if (error.operation() == advisory_lock_operation::open) {
      throw std::runtime_error("manifest_writer_guard: cannot open lock file " + lock_path);
    }
    throw std::runtime_error("manifest_writer_busy: another writer holds " + lock_path);
  }
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

nlohmann::json record_json(const EpisodeRootCommitted &record) {
  auto row = base_record_json("episode_root_committed", record);
  row["commit_time"] = record.commit_time;
  row["covered_record_count"] = record.covered_record_count;
  row["algorithm"] = fixed_string(record.algorithm);
  row["root_value"] = fixed_string(record.root_value);
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
template <typename T> bool decode_v1_record(const void *payload, size_t payload_size, episode_manifest_record &record) {
  if (payload_size < sizeof(T)) {
    return false;
  }
  T body{};
  std::memcpy(static_cast<void *>(&body), payload, sizeof(T));
  if (body.schema_version > EPISODE_MANIFEST_SCHEMA_VERSION) {
    return false;
  }
  record.body = body;
  return true;
}

episode_manifest_record decode_record_body(int32_t carrier_type, uint64_t manifest_frame_uid, int64_t manifest_gen_time,
                                           const void *payload, size_t payload_size) {
  episode_manifest_record record{};
  record.manifest_frame_uid = manifest_frame_uid;
  record.manifest_gen_time = manifest_gen_time;
  if (payload_size != 0) {
    if (payload == nullptr) {
      throw std::invalid_argument("episode manifest payload pointer is null");
    }
    const auto *begin = static_cast<const uint8_t *>(payload);
    record.payload.assign(begin, begin + payload_size);
  }
  bool decoded = false;
  switch (carrier_type) {
  case EpisodeOpen::tag:
    decoded = decode_v1_record<EpisodeOpen>(payload, payload_size, record);
    break;
  case EpisodeHeartbeat::tag:
    decoded = decode_v1_record<EpisodeHeartbeat>(payload, payload_size, record);
    break;
  case EpisodeFrameAttached::tag:
    decoded = decode_v1_record<EpisodeFrameAttached>(payload, payload_size, record);
    break;
  case EpisodeRefAttached::tag:
    decoded = decode_v1_record<EpisodeRefAttached>(payload, payload_size, record);
    break;
  case EpisodeClosed::tag:
    decoded = decode_v1_record<EpisodeClosed>(payload, payload_size, record);
    break;
  case EpisodeRootCommitted::tag:
    decoded = decode_v1_record<EpisodeRootCommitted>(payload, payload_size, record);
    break;
  default:
    break;
  }
  if (!decoded) {
    episode_manifest_unknown_record unknown{};
    unknown.carrier_type = carrier_type;
    if (payload_size >= sizeof(uint32_t)) {
      // Every v1 record starts with a uint32 schema_version; reading that
      // prefix is safe even when the rest of the layout is unknown.
      std::memcpy(&unknown.schema_version, payload, sizeof(uint32_t));
      unknown.unknown_version = unknown.schema_version > EPISODE_MANIFEST_SCHEMA_VERSION;
    }
    record.body = unknown;
  }
  return record;
}

episode_manifest_record decode_record(const frame_ptr &frame) {
  return decode_record_body(frame->carrier_type(), frame->frame_uid(), frame->gen_time(), frame->data_address(),
                            frame->data_length());
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
  if (fold.total_record_count == 0) {
    fold.first_manifest_frame_uid = record.manifest_frame_uid;
  }
  fold.last_manifest_frame_uid = record.manifest_frame_uid;
  fold.last_manifest_gen_time = record.manifest_gen_time;
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
        } else if constexpr (std::is_same_v<body_t, EpisodeRootCommitted>) {
          ++view.root_count;
          if (!view.root_seen) {
            view.root_seen = true;
            view.root = body;
          }
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
  size_t payload_ref_count = 0;
  size_t schema_ref_count = 0;
  for (size_t position = 0; position < view.ref_indices.size(); ++position) {
    const auto kind = view.ref_at(position).ref_kind;
    payload_ref_count += kind == EpisodeRefKind::Payload ? 1 : 0;
    schema_ref_count += kind == EpisodeRefKind::Schema ? 1 : 0;
  }
  summary["payload_ref_count"] = payload_ref_count;
  summary["schema_ref_count"] = schema_ref_count;
  if (view.root_seen) {
    summary["content_root"] = fixed_string(view.root.root_value);
    summary["content_root_algorithm"] = fixed_string(view.root.algorithm);
  }
  if (!summary.contains("status")) {
    summary["status"] = view.opened ? "open" : "dangling";
  }
  return summary;
}

// KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9 edge projection of Episode identity: the recorded root claim, the
// recomputed root when this reader can derive one, and the verdict. Status
// vocabulary: undefined (open), absent (sealed, no root), verified, mismatch,
// unverifiable (unknown records present or unsupported algorithm),
// root_without_seal (a root claims identity of an unsealed Episode).
nlohmann::json content_root_json(const episode_current_view &view, size_t unknown_record_count) {
  const auto verification = verify_episode_content_root(view, unknown_record_count);
  const auto status_name = [](episode_content_root_status status) {
    switch (status) {
    case episode_content_root_status::Undefined:
      return "undefined";
    case episode_content_root_status::RootWithoutSeal:
      return "root_without_seal";
    case episode_content_root_status::Absent:
      return "absent";
    case episode_content_root_status::Unverifiable:
      return "unverifiable";
    case episode_content_root_status::Verified:
      return "verified";
    case episode_content_root_status::Mismatch:
      return "mismatch";
    }
    return "undefined";
  };
  const auto recorded =
      verification.recorded.has_value() ? record_json(*verification.recorded) : nlohmann::json(nullptr);
  const auto computed = verification.computed.has_value()
                            ? nlohmann::json{{"algorithm", verification.computed->algorithm},
                                             {"value", verification.computed->value},
                                             {"covered_record_count", verification.computed->covered_record_count}}
                            : nlohmann::json(nullptr);
  const auto match = verification.match.has_value() ? nlohmann::json(*verification.match) : nlohmann::json(nullptr);
  return {
      {"recorded", recorded}, {"computed", computed}, {"match", match}, {"status", status_name(verification.status)}};
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

// KF-ADR-019f86da-4f90-737e-893f-c095b9a05cae stage 4: a payload ref resolves through the
// KF-ADR-019f86da-4f90-738c-b372-e509976f69ff immutable content_store by its content identity (ref_hash); ref_id is an
// edge label with no resolution role. The verified read maps the store's declared error taxonomy onto manifest
// diagnostics -- there is no path fallback.
struct payload_ref_resolution {
  const char *status = "missing"; // dependency status for the causal graph
  const char *code = nullptr;     // issue code when the ref is not verified
  std::string detail = {};
};

payload_ref_resolution resolve_payload_ref(const content_store &store, const std::string &ref_hash) {
  content_hash hash{};
  try {
    // canonical form is "<algo>:<hex>"; bare hex from earlier producers is
    // accepted as the store's default algorithm
    hash = ref_hash.find(':') != std::string::npos ? parse_content_hash(ref_hash) : make_content_hash(ref_hash);
  } catch (const std::exception &e) {
    return {"unaddressable", "episode_payload_ref_hash_invalid", e.what()};
  }
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

episode_causal_graph build_causal_graph(const content_store &refs, uint64_t episode_id,
                                        const episode_current_view &view,
                                        const std::map<uint64_t, episode_current_view> &folded) {
  std::vector<uint64_t> frame_uids;
  std::vector<uint64_t> declared_input_frames;
  std::vector<episode_causal_edge> frame_edges;
  std::vector<episode_dependency> dependencies;
  std::vector<episode_fsck_issue> errors;
  std::vector<episode_fsck_issue> warnings;
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
    episode_dependency dependency{};
    dependency.kind = "episode";
    dependency.role = "parent";
    dependency.status = status;
    dependency.episode_id = parent_episode_id;
    dependencies.push_back(std::move(dependency));
    if (!present) {
      degraded = true;
      episode_fsck_issue issue{};
      issue.code = "episode_dependency_missing";
      issue.episode_id = episode_id;
      issue.dependency_episode_id = parent_episode_id;
      issue.role = "parent";
      warnings.push_back(std::move(issue));
    }
  }

  const auto root_trigger_frame_uid = view.opened ? view.open.root_trigger_frame_uid : uint64_t{0};
  if (root_trigger_frame_uid != 0 && !contains_u64(frame_uids, root_trigger_frame_uid)) {
    const bool declared = contains_u64(declared_input_frames, root_trigger_frame_uid);
    episode_dependency dependency{};
    dependency.kind = "frame";
    dependency.role = "root_trigger";
    dependency.status = declared ? "declared_external" : "missing";
    dependency.frame_uid = root_trigger_frame_uid;
    dependencies.push_back(std::move(dependency));
    if (!declared) {
      degraded = true;
      episode_fsck_issue issue{};
      issue.code = "episode_root_trigger_frame_missing";
      issue.episode_id = episode_id;
      issue.frame_uid = root_trigger_frame_uid;
      warnings.push_back(std::move(issue));
    }
  }

  for (size_t position = 0; position < view.frame_indices.size(); ++position) {
    const auto &frame = view.frame_at(position);
    if (frame.trigger_frame_uid == 0) {
      continue;
    }
    if (contains_u64(frame_uids, frame.trigger_frame_uid)) {
      frame_edges.push_back({frame.trigger_frame_uid, frame.frame_uid});
      continue;
    }
    const bool declared = contains_u64(declared_input_frames, frame.trigger_frame_uid);
    episode_dependency dependency{};
    dependency.kind = "frame";
    dependency.role = "trigger";
    dependency.status = declared ? "declared_external" : "missing";
    dependency.frame_uid = frame.trigger_frame_uid;
    dependency.dependent_frame_uid = frame.frame_uid;
    dependencies.push_back(std::move(dependency));
    if (!declared) {
      degraded = true;
      episode_fsck_issue issue{};
      issue.code = "episode_trigger_frame_missing";
      issue.episode_id = episode_id;
      issue.frame_uid = frame.trigger_frame_uid;
      issue.dependent_frame_uid = frame.frame_uid;
      warnings.push_back(std::move(issue));
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
      episode_dependency dependency{};
      dependency.kind = "episode";
      dependency.role = "ref";
      dependency.status = status;
      dependency.episode_id = ref.ref_uid;
      dependency.ref_id = ref_id;
      dependency.ref_hash = ref_hash;
      dependencies.push_back(std::move(dependency));
      if (!present && !declared_external) {
        degraded = true;
        episode_fsck_issue issue{};
        issue.code = "episode_dependency_missing";
        issue.episode_id = episode_id;
        issue.dependency_episode_id = ref.ref_uid;
        issue.role = "ref";
        warnings.push_back(std::move(issue));
      }
    } else if (ref.ref_kind == EpisodeRefKind::Payload) {
      const auto resolved = resolve_payload_ref(refs, ref_hash);
      episode_dependency dependency{};
      dependency.kind = "payload";
      dependency.role = "payload_ref";
      dependency.status = resolved.status;
      dependency.ref_uid = ref.ref_uid;
      dependency.ref_id = ref_id;
      dependency.ref_hash = ref_hash;
      dependencies.push_back(std::move(dependency));
      if (resolved.code != nullptr) {
        episode_fsck_issue issue{};
        issue.code = resolved.code;
        issue.episode_id = episode_id;
        issue.ref_id = ref_id;
        issue.ref_hash = ref_hash;
        if (!resolved.detail.empty()) {
          issue.detail = resolved.detail;
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
      episode_dependency dependency{};
      dependency.kind = "schema";
      dependency.role = "schema_ref";
      dependency.status = "declared";
      dependency.ref_uid = ref.ref_uid;
      dependency.ref_id = ref_id;
      dependency.ref_hash = ref_hash;
      dependencies.push_back(std::move(dependency));
    }
  }

  episode_causal_graph graph{};
  graph.episode_id = episode_id;
  graph.frame_count = static_cast<uint64_t>(frame_uids.size());
  graph.edges = std::move(frame_edges);
  graph.dependencies = std::move(dependencies);
  graph.errors = std::move(errors);
  graph.warnings = std::move(warnings);
  graph.degraded = degraded;
  return graph;
}

nlohmann::json dependency_json(const episode_dependency &dependency) {
  nlohmann::json value = {{"kind", dependency.kind}, {"role", dependency.role}, {"status", dependency.status}};
  if (dependency.episode_id.has_value()) {
    value["episode_id"] = *dependency.episode_id;
  }
  if (dependency.frame_uid.has_value()) {
    value["frame_uid"] = *dependency.frame_uid;
  }
  if (dependency.dependent_frame_uid.has_value()) {
    value["dependent_frame_uid"] = *dependency.dependent_frame_uid;
  }
  if (dependency.ref_uid.has_value()) {
    value["ref_uid"] = *dependency.ref_uid;
  }
  if (dependency.ref_id.has_value()) {
    value["ref_id"] = *dependency.ref_id;
  }
  if (dependency.ref_hash.has_value()) {
    value["ref_hash"] = *dependency.ref_hash;
  }
  return value;
}

nlohmann::json dependencies_json(const episode_causal_graph &graph) {
  nlohmann::json values = nlohmann::json::array();
  for (const auto &dependency : graph.dependencies) {
    values.push_back(dependency_json(dependency));
  }
  return values;
}

nlohmann::json causal_graph_json(const episode_causal_graph &graph) {
  nlohmann::json edges = nlohmann::json::array();
  for (const auto &edge : graph.edges) {
    edges.push_back({{"kind", "frame_trigger"},
                     {"scope", "internal"},
                     {"from_frame_uid", edge.from_frame_uid},
                     {"to_frame_uid", edge.to_frame_uid}});
  }
  const auto dependencies = dependencies_json(graph);
  return {{"schema", graph.schema},
          {"episode_id", graph.episode_id},
          {"frame_count", graph.frame_count},
          {"edge_count", graph.edges.size()},
          {"dependency_count", graph.dependencies.size()},
          {"degraded", graph.degraded},
          {"edges", std::move(edges)},
          {"dependencies", dependencies}};
}

// KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9: per-record commitment for the content root. Each covered record
// contributes its hana field bytes in declaration order — scalar and enum
// fields as their in-memory little-endian bytes, fixed char arrays as their
// full zero-filled extent. Struct padding never enters the hash, so the
// commitment is deterministic across compilers and write paths.
template <typename T> std::string episode_record_commitment(const T &record) {
  std::string bytes;
  boost::hana::for_each(boost::hana::accessors<T>(), [&bytes, &record](auto accessor) {
    const auto &member = boost::hana::second(accessor)(record);
    bytes.append(reinterpret_cast<const char *>(&member), sizeof(member));
  });
  return compute_content_hash_value(bytes);
}

// KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9 v1 chain link preimage, pinned by fixtures: ASCII domain tag,
// decimal covered-record index, previous link hex, record commitment hex,
// joined by '|'. The initial link is 64 zero hex digits.
constexpr const char *EPISODE_ROOT_LINK_DOMAIN = "kungfu.episode-root-link/v1";
constexpr const char *EPISODE_ROOT_INITIAL_LINK = "0000000000000000000000000000000000000000000000000000000000000000";

std::string episode_root_chain_link(size_t index, const std::string &previous, const std::string &record_commitment) {
  return compute_content_hash_value(std::string(EPISODE_ROOT_LINK_DOMAIN) + "|" + std::to_string(index) + "|" +
                                    previous + "|" + record_commitment);
}

} // namespace

nlohmann::json episode_summary_json(const episode_current_view &view) { return summary_json(view); }

nlohmann::json episode_content_root_json(const episode_current_view &view, size_t unknown_record_count) {
  return content_root_json(view, unknown_record_count);
}

episode_content_root compute_episode_content_root(const episode_current_view &view) {
  episode_content_root root{};
  root.algorithm = CONTENT_HASH_ALGORITHM_SHA256;
  root.value = EPISODE_ROOT_INITIAL_LINK;
  bool open_covered = false;
  bool close_covered = false;
  for (const auto &record : view.records) {
    const auto commitment = std::visit(
        [&open_covered, &close_covered](const auto &body) -> std::string {
          using body_t = std::decay_t<decltype(body)>;
          if constexpr (std::is_same_v<body_t, EpisodeOpen>) {
            if (open_covered) {
              return {};
            }
            open_covered = true;
            return episode_record_commitment(body);
          } else if constexpr (std::is_same_v<body_t, EpisodeFrameAttached> ||
                               std::is_same_v<body_t, EpisodeRefAttached>) {
            return episode_record_commitment(body);
          } else if constexpr (std::is_same_v<body_t, EpisodeClosed>) {
            // the first terminal close is the seal and part of identity;
            // later closes (tombstone path, anomalous duplicates) are
            // lifecycle facts outside it
            if (close_covered) {
              return {};
            }
            close_covered = true;
            return episode_record_commitment(body);
          } else {
            // heartbeats, unknown records, and the root record itself stay
            // outside identity
            return {};
          }
        },
        record.body);
    if (commitment.empty()) {
      continue;
    }
    root.value = episode_root_chain_link(root.covered_record_count, root.value, commitment);
    ++root.covered_record_count;
  }
  return root;
}

episode_content_root_verification verify_episode_content_root(const episode_current_view &view,
                                                              size_t unknown_record_count) {
  episode_content_root_verification result{};
  if (view.root_seen) {
    result.recorded = view.root;
  }
  if (!view.closed) {
    result.status =
        view.root_seen ? episode_content_root_status::RootWithoutSeal : episode_content_root_status::Undefined;
    return result;
  }
  if (unknown_record_count > 0) {
    result.status = view.root_seen ? episode_content_root_status::Unverifiable : episode_content_root_status::Absent;
    return result;
  }
  result.computed = compute_episode_content_root(view);
  if (!view.root_seen) {
    result.status = episode_content_root_status::Absent;
    return result;
  }
  if (fixed_string(view.root.algorithm) != result.computed->algorithm) {
    result.status = episode_content_root_status::Unverifiable;
    return result;
  }
  result.match = fixed_string(view.root.root_value) == result.computed->value &&
                 view.root.covered_record_count == result.computed->covered_record_count;
  result.status = *result.match ? episode_content_root_status::Verified : episode_content_root_status::Mismatch;
  return result;
}

std::string episode_manifest_writer_lock_path(const std::string &runtime_dir) {
  const auto location = manifest_location(runtime_dir);
  return (fs::path(location->locator->layout_dir(location, enums::layout::JOURNAL, true)) / "writer.lock").string();
}

episode_manifest_record decode_episode_manifest_record(int32_t carrier_type, uint64_t manifest_frame_uid,
                                                       int64_t manifest_gen_time, const void *payload,
                                                       size_t payload_size) {
  return decode_record_body(carrier_type, manifest_frame_uid, manifest_gen_time, payload, payload_size);
}

episode_manifest_fold fold_episode_manifest_records(const std::vector<episode_manifest_record> &records) {
  episode_manifest_fold fold;
  for (const auto &record : records) {
    fold_into(fold, record);
  }
  return fold;
}

episode_manifest_fold fold_episode_manifest_records_until(const std::vector<episode_manifest_record> &records,
                                                          uint64_t manifest_frame_uid) {
  episode_manifest_fold fold;
  fold.cut_found = false;
  for (const auto &record : records) {
    fold_into(fold, record);
    if (record.manifest_frame_uid == manifest_frame_uid) {
      fold.cut_found = true;
      break;
    }
  }
  return fold;
}

episode_manifest_store::episode_manifest_store(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

uint64_t episode_manifest_store::resolve_episode_id(const episode_begin_options &options) {
  return options.episode_id == 0 ? generated_episode_id(options) : options.episode_id;
}

EpisodeOpen episode_manifest_store::begin(const episode_begin_options &options) const {
  EpisodeOpen record{};
  record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  record.episode_id = resolve_episode_id(options);
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
  return record;
}

EpisodeHeartbeat episode_manifest_store::heartbeat(const episode_heartbeat_options &options) const {
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
  return record;
}

EpisodeFrameAttached episode_manifest_store::attach_frame(const episode_frame_attach_options &options) const {
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
  return record;
}

EpisodeRefAttached episode_manifest_store::attach_ref(const episode_ref_attach_options &options) const {
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
  return record;
}

episode_append_result episode_manifest_store::append(const episode_append_options &options) const {
  episode_append_result result{};
  auto &open = result.open;
  open.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  open.episode_id = resolve_episode_id(options.begin);
  open.parent_episode_id = options.begin.parent_episode_id;
  open.root_trigger_frame_uid = options.begin.root_trigger_frame_uid;
  open.location_uid =
      options.begin.location_uid == 0 ? manifest_location(runtime_dir_)->uid : options.begin.location_uid;
  open.begin_time = options.begin.begin_time == 0 ? time::now_in_nano() : options.begin.begin_time;
  set_fixed_string(open.title, options.begin.title);
  set_fixed_string(open.actor, options.begin.actor);
  set_fixed_string(open.source, options.begin.source);

  if (options.frames.empty()) {
    throw std::invalid_argument("complete Episode append requires at least one frame");
  }
  if (options.close.episode_id != 0 && options.close.episode_id != open.episode_id) {
    throw std::invalid_argument("Episode close does not match appended Episode");
  }
  if (options.close.frame_count != options.frames.size() ||
      options.close.last_frame_uid != options.frames.back().frame_uid) {
    throw std::invalid_argument("Episode close does not cover appended frames");
  }
  if (options.close.status == EpisodeStatus::Open) {
    throw std::invalid_argument("complete Episode append requires a terminal status");
  }
  for (const auto &frame : options.frames) {
    if ((frame.episode_id != 0 && frame.episode_id != open.episode_id) || frame.frame_uid == 0) {
      throw std::invalid_argument("Episode frame does not match appended Episode");
    }
  }
  for (const auto &ref : options.refs) {
    if (ref.episode_id != 0 && ref.episode_id != open.episode_id) {
      throw std::invalid_argument("Episode ref does not match appended Episode");
    }
  }

  const auto guard = acquire_writer_guard(runtime_dir_);
  const auto existing = fold_typed_records();
  if (existing.episodes.contains(open.episode_id)) {
    throw std::invalid_argument("Episode already exists");
  }
  auto writer = make_writer(runtime_dir_);
  episode_manifest_fold appended{};
  const auto write_and_fold = [&writer, &appended](int64_t gen_time, const auto &record) {
    writer.write_at(gen_time, 0, record);
    episode_manifest_record row{};
    row.body = record;
    fold_into(appended, row);
  };

  write_and_fold(open.begin_time, open);
  for (const auto &frame_options : options.frames) {
    EpisodeFrameAttached frame{};
    frame.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
    frame.episode_id = open.episode_id;
    frame.location_uid = frame_options.location_uid == 0 ? open.location_uid : frame_options.location_uid;
    frame.frame_uid = frame_options.frame_uid;
    frame.trigger_frame_uid = frame_options.trigger_frame_uid;
    frame.stream_id = frame_options.stream_id;
    frame.gen_time = frame_options.gen_time == 0 ? time::now_in_nano() : frame_options.gen_time;
    frame.trigger_time = frame_options.trigger_time;
    frame.carrier_type = frame_options.carrier_type;
    frame.source = frame_options.source;
    frame.dest = frame_options.dest;
    frame.data_length = frame_options.data_length;
    frame.integrity_version = frame_options.integrity_version;
    frame.payload_checksum = frame_options.payload_checksum;
    frame.frame_checksum = frame_options.frame_checksum;
    write_and_fold(frame.gen_time, frame);
    result.frames.push_back(frame);
  }
  for (const auto &ref_options : options.refs) {
    EpisodeRefAttached ref{};
    ref.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
    ref.episode_id = open.episode_id;
    ref.location_uid = ref_options.location_uid == 0 ? open.location_uid : ref_options.location_uid;
    ref.ref_kind = ref_options.ref_kind;
    ref.ref_uid = ref_options.ref_uid;
    ref.update_time = ref_options.update_time == 0 ? time::now_in_nano() : ref_options.update_time;
    set_fixed_string(ref.ref_id, ref_options.ref_id);
    set_fixed_string(ref.ref_hash, ref_options.ref_hash);
    write_and_fold(ref.update_time, ref);
    result.refs.push_back(ref);
  }

  auto &close_result = result.close;
  auto &close = close_result.close;
  close.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  close.episode_id = open.episode_id;
  close.location_uid = options.close.location_uid == 0 ? open.location_uid : options.close.location_uid;
  close.status = options.close.status;
  close.end_time = options.close.end_time == 0 ? time::now_in_nano() : options.close.end_time;
  close.last_frame_uid = options.close.last_frame_uid;
  close.frame_count = options.close.frame_count;
  set_fixed_string(close.reason, options.close.reason);
  write_and_fold(close.end_time, close);

  const auto root = compute_episode_content_root(appended.episodes.at(open.episode_id));
  EpisodeRootCommitted root_record{};
  root_record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
  root_record.episode_id = open.episode_id;
  root_record.location_uid = close.location_uid;
  root_record.commit_time = close.end_time;
  root_record.covered_record_count = root.covered_record_count;
  set_fixed_string(root_record.algorithm, root.algorithm);
  set_fixed_string(root_record.root_value, root.value);
  writer.write_at(root_record.commit_time, 0, root_record);
  close_result.content_root = root_record;
  return result;
}

episode_close_write_result episode_manifest_store::end(const episode_close_options &options) const {
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
  auto fold = fold_typed_records();
  const auto folded = fold.episodes.find(record.episode_id);
  const bool first_close = folded == fold.episodes.end() || !folded->second.closed;
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.end_time, 0, record);
  episode_close_write_result result{};
  result.close = record;
  // KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9: the first terminal close is the seal — commit the Episode's
  // content identity as the final claim, under the same writer guard so no
  // record can interleave between the seal and its root. Later closes
  // (tombstone path) are lifecycle facts outside identity and get no root.
  if (first_close) {
    episode_manifest_record appended{};
    appended.body = record;
    fold_into(fold, appended);
    const auto root = compute_episode_content_root(fold.episodes.at(record.episode_id));
    EpisodeRootCommitted root_record{};
    root_record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
    root_record.episode_id = record.episode_id;
    root_record.location_uid = record.location_uid;
    root_record.commit_time = record.end_time;
    root_record.covered_record_count = root.covered_record_count;
    set_fixed_string(root_record.algorithm, root.algorithm);
    set_fixed_string(root_record.root_value, root.value);
    writer.write_at(root_record.commit_time, 0, root_record);
    result.content_root = root_record;
  }
  return result;
}

episode_close_write_result episode_manifest_store::abort(const episode_close_options &options) const {
  auto abort_options = options;
  abort_options.status = EpisodeStatus::Aborted;
  return end(abort_options);
}

episode_recover_result episode_manifest_store::recover(const episode_recover_options &options) const {
  const auto guard = acquire_writer_guard(runtime_dir_);
  auto fold = fold_typed_records();
  if (options.expected_manifest_frame_uid != 0) {
    if (options.episode_id == 0) {
      throw std::runtime_error(
          "episode_recovery_precondition_changed: expected manifest frame requires a specific episode_id");
    }
    const auto target = fold.episodes.find(options.episode_id);
    if (target == fold.episodes.end() || !target->second.opened || target->second.closed ||
        target->second.records.empty() ||
        (options.location_uid != 0 && target->second.open.location_uid != options.location_uid) ||
        target->second.records.back().manifest_frame_uid != options.expected_manifest_frame_uid) {
      throw std::runtime_error("episode_recovery_precondition_changed: Episode facts changed after recovery planning");
    }
  }
  const auto end_time = options.end_time == 0 ? time::now_in_nano() : options.end_time;
  const auto reason = options.reason.empty() ? std::string("recovered") : options.reason;
  std::vector<EpisodeClosed> closes;
  std::vector<episode_recover_skipped_open> skipped;
  for (const auto &[episode_id, view] : fold.episodes) {
    if (!view.opened || view.closed) {
      continue;
    }
    if (options.episode_id != 0 && episode_id != options.episode_id) {
      continue;
    }
    if (options.location_uid != 0 && view.open.location_uid != options.location_uid) {
      // Open Episodes owned by another location are reported, never mutated.
      skipped.push_back({episode_id, view.open.location_uid});
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
  std::vector<episode_close_write_result> recovered;
  if (!closes.empty()) {
    auto writer = make_writer(runtime_dir_);
    for (const auto &record : closes) {
      writer.write_at(record.end_time, 0, record);
      episode_close_write_result written{};
      written.close = record;
      // KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9: recovery seals were open Episodes, so each close here is
      // the first close — commit each Episode's content root after its seal.
      episode_manifest_record appended{};
      appended.body = record;
      fold_into(fold, appended);
      const auto root = compute_episode_content_root(fold.episodes.at(record.episode_id));
      EpisodeRootCommitted root_record{};
      root_record.schema_version = EPISODE_MANIFEST_SCHEMA_VERSION;
      root_record.episode_id = record.episode_id;
      root_record.location_uid = record.location_uid;
      root_record.commit_time = record.end_time;
      root_record.covered_record_count = root.covered_record_count;
      set_fixed_string(root_record.algorithm, root.algorithm);
      set_fixed_string(root_record.root_value, root.value);
      writer.write_at(root_record.commit_time, 0, root_record);
      written.content_root = root_record;
      recovered.push_back(std::move(written));
    }
  }
  return {runtime_dir_, std::move(recovered), std::move(skipped)};
}

void episode_manifest_store::for_each_typed_record(const episode_manifest_record_visitor &visit) const {
  const auto location = manifest_location(runtime_dir_);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    // PageEnd is journal infrastructure: the reader consumes it to roll over
    // to the next page, but it is not an Episode manifest record and must not
    // make every cross-page content root unverifiable.
    if (frame->carrier_type() != PageEnd::tag) {
      visit(decode_record(frame));
    }
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

episode_manifest_fold episode_manifest_store::fold_typed_records_until(uint64_t manifest_frame_uid) const {
  episode_manifest_fold fold;
  fold.cut_found = false;
  bool complete = false;
  for_each_typed_record([&](const episode_manifest_record &record) {
    if (complete) {
      return;
    }
    fold_into(fold, record);
    if (record.manifest_frame_uid == manifest_frame_uid) {
      fold.cut_found = true;
      complete = true;
    }
  });
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
  const file_content_store default_content_store((fs::path(runtime_dir_) / "storage").string());
  const content_store &refs = content_store_ != nullptr ? *content_store_ : default_content_store;
  const auto graph = build_causal_graph(refs, episode_id, view, fold.episodes);
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"episode", summary_json(view)},
          {"content_root", content_root_json(view, fold.unknown_record_count)},
          {"causal_graph", causal_graph_json(graph)},
          {"dependencies", dependencies_json(graph)},
          {"records", records_json(view)},
          {"frames", rows_json(view, view.frame_indices)},
          {"refs", rows_json(view, view.ref_indices)}};
}

episode_causal_graph episode_manifest_store::causal_graph_typed(uint64_t episode_id) const {
  return inspect_typed(episode_id).causal_graph;
}

episode_inspect_result episode_manifest_store::inspect_typed(uint64_t episode_id) const {
  if (episode_id == 0) {
    throw std::invalid_argument("episode_id is required");
  }
  const auto fold = fold_typed_records();
  const auto iter = fold.episodes.find(episode_id);
  if (iter == fold.episodes.end()) {
    throw std::invalid_argument("episode not found: " + std::to_string(episode_id));
  }
  const file_content_store default_content_store((fs::path(runtime_dir_) / "storage").string());
  const content_store &refs = content_store_ != nullptr ? *content_store_ : default_content_store;
  return {iter->second, verify_episode_content_root(iter->second, fold.unknown_record_count),
          build_causal_graph(refs, episode_id, iter->second, fold.episodes),
          static_cast<uint64_t>(fold.unknown_record_count)};
}

episode_fsck_result episode_manifest_store::fsck_typed(uint64_t episode_id) const {
  const auto fold = fold_typed_records();
  const file_content_store default_content_store((fs::path(runtime_dir_) / "storage").string());
  const content_store &refs = content_store_ != nullptr ? *content_store_ : default_content_store;
  episode_fsck_result result{};
  result.runtime_dir = runtime_dir_;
  result.episode_manifest_records = static_cast<uint64_t>(fold.total_record_count);
  result.unknown_records = static_cast<uint64_t>(fold.unknown_record_count);
  result.unfolded_records = static_cast<uint64_t>(fold.unfolded_record_count);
  const auto issue_for = [](std::string code, uint64_t current_episode_id) {
    episode_fsck_issue issue{};
    issue.code = std::move(code);
    issue.episode_id = current_episode_id;
    return issue;
  };
  for (const auto &[current_episode_id, view] : fold.episodes) {
    if (episode_id != 0 && current_episode_id != episode_id) {
      continue;
    }
    ++result.episodes;
    if (episode_id != 0) {
      result.episode = view;
    }
    if (!view.opened) {
      result.errors.push_back(issue_for("episode_open_missing", current_episode_id));
    }
    for (size_t occurrence = 0; occurrence < view.missing_frame_uid_count; ++occurrence) {
      result.errors.push_back(issue_for("episode_frame_uid_missing", current_episode_id));
    }
    for (const auto frame_uid : view.duplicate_frame_uids) {
      auto issue = issue_for("episode_frame_duplicate", current_episode_id);
      issue.frame_uid = frame_uid;
      result.warnings.push_back(std::move(issue));
    }
    if (view.open_count > 1) {
      auto issue = issue_for("episode_open_duplicate", current_episode_id);
      issue.count = static_cast<uint64_t>(view.open_count);
      result.errors.push_back(std::move(issue));
    }
    if (view.close_count > 1) {
      // The append-only tombstone path (a Tombstoned close after the seal) is
      // intentional, not a duplicate-close anomaly.
      bool extra_closes_are_tombstones = view.close.status == EpisodeStatus::Tombstoned;
      for (size_t index = 1; extra_closes_are_tombstones && index < view.close_statuses.size(); ++index) {
        extra_closes_are_tombstones = view.close_statuses[index] == EpisodeStatus::Tombstoned;
      }
      auto issue = issue_for(extra_closes_are_tombstones ? "episode_tombstoned" : "episode_closed_duplicate",
                             current_episode_id);
      issue.count = static_cast<uint64_t>(view.close_count);
      result.warnings.push_back(std::move(issue));
    }
    if (view.closed) {
      const auto close_status = view.close.status;
      const bool status_valid = close_status == EpisodeStatus::Ended || close_status == EpisodeStatus::Aborted ||
                                close_status == EpisodeStatus::Tombstoned;
      if (!status_valid) {
        auto issue = issue_for("episode_close_status_invalid", current_episode_id);
        issue.status = static_cast<int32_t>(close_status);
        result.errors.push_back(std::move(issue));
      }
      // A seal is a claim about the Episode's content; the fold is the actual.
      if (close_status == EpisodeStatus::Ended) {
        if (view.close.frame_count != view.unique_frame_count) {
          auto issue = issue_for("episode_seal_frame_count_mismatch", current_episode_id);
          issue.claimed = view.close.frame_count;
          issue.actual = static_cast<uint64_t>(view.unique_frame_count);
          result.errors.push_back(std::move(issue));
        }
        if (view.close.last_frame_uid != 0) {
          bool claimed_last_present = false;
          for (size_t position = 0; !claimed_last_present && position < view.frame_indices.size(); ++position) {
            claimed_last_present = view.frame_at(position).frame_uid == view.close.last_frame_uid;
          }
          if (!claimed_last_present) {
            auto issue = issue_for("episode_seal_last_frame_missing", current_episode_id);
            issue.frame_uid = view.close.last_frame_uid;
            result.errors.push_back(std::move(issue));
          }
        }
      }
    }
    // KF-ADR-019f86da-4f90-73f2-a0ac-42f14e0278d9: the recorded content root is a claim about the whole covered
    // sequence; fsck recomputes it from the fold and verifies. Unknown
    // records make the recomputation unverifiable (this reader cannot
    // canonicalize records a newer writer may have covered), reported
    // honestly instead of guessed.
    if (view.root_seen && !view.closed) {
      result.errors.push_back(issue_for("episode_root_without_seal", current_episode_id));
    }
    if (view.root_count > 1) {
      auto issue = issue_for("episode_root_duplicate", current_episode_id);
      issue.count = static_cast<uint64_t>(view.root_count);
      result.warnings.push_back(std::move(issue));
    }
    if (view.root_seen && view.closed) {
      const auto recorded_algorithm = fixed_string(view.root.algorithm);
      if (fold.unknown_record_count > 0) {
        auto issue = issue_for("episode_root_unverifiable", current_episode_id);
        issue.reason = "unknown_records_present";
        result.warnings.push_back(std::move(issue));
      } else if (recorded_algorithm != CONTENT_HASH_ALGORITHM_SHA256) {
        auto issue = issue_for("episode_root_unverifiable", current_episode_id);
        issue.reason = "unsupported_algorithm";
        issue.algorithm = recorded_algorithm;
        result.warnings.push_back(std::move(issue));
      } else {
        const auto root = compute_episode_content_root(view);
        const auto recorded_value = fixed_string(view.root.root_value);
        if (recorded_value != root.value || view.root.covered_record_count != root.covered_record_count) {
          auto issue = issue_for("episode_root_mismatch", current_episode_id);
          issue.recorded = recorded_value;
          issue.computed = root.value;
          issue.recorded_covered_record_count = view.root.covered_record_count;
          issue.computed_covered_record_count = root.covered_record_count;
          result.errors.push_back(std::move(issue));
        }
      }
    }
    const auto graph = build_causal_graph(refs, current_episode_id, view, fold.episodes);
    result.degraded = result.degraded || graph.degraded;
    for (const auto &error : graph.errors) {
      result.errors.push_back(error);
    }
    for (const auto &warning : graph.warnings) {
      result.warnings.push_back(warning);
    }
  }
  if (fold.unknown_record_count > 0) {
    episode_fsck_issue issue{};
    issue.code = "manifest_unknown_records";
    issue.count = static_cast<uint64_t>(fold.unknown_record_count);
    result.warnings.push_back(std::move(issue));
    result.degraded = true;
  }
  if (fold.unfolded_record_count > 0) {
    episode_fsck_issue issue{};
    issue.code = "manifest_record_episode_id_missing";
    issue.count = static_cast<uint64_t>(fold.unfolded_record_count);
    result.warnings.push_back(std::move(issue));
  }
  if (episode_id != 0 && result.episodes == 0) {
    result.errors.push_back(issue_for("episode_missing", episode_id));
  }
  result.ok = result.errors.empty();
  result.status = !result.ok ? "failed" : (result.degraded ? "degraded" : "ok");
  return result;
}

nlohmann::json render_episode_fsck_issue(const episode_fsck_issue &issue) {
  nlohmann::json row = {{"code", issue.code}};
  if (issue.episode_id.has_value())
    row["episode_id"] = *issue.episode_id;
  if (issue.dependency_episode_id.has_value())
    row["dependency_episode_id"] = *issue.dependency_episode_id;
  if (issue.frame_uid.has_value())
    row["frame_uid"] = *issue.frame_uid;
  if (issue.dependent_frame_uid.has_value())
    row["dependent_frame_uid"] = *issue.dependent_frame_uid;
  if (issue.count.has_value())
    row["count"] = *issue.count;
  if (issue.status.has_value())
    row["status"] = *issue.status;
  if (issue.claimed.has_value())
    row["claimed"] = *issue.claimed;
  if (issue.actual.has_value())
    row["actual"] = *issue.actual;
  if (issue.recorded_covered_record_count.has_value()) {
    row["recorded_covered_record_count"] = *issue.recorded_covered_record_count;
  }
  if (issue.computed_covered_record_count.has_value()) {
    row["computed_covered_record_count"] = *issue.computed_covered_record_count;
  }
  if (issue.role.has_value())
    row["role"] = *issue.role;
  if (issue.ref_id.has_value())
    row["ref_id"] = *issue.ref_id;
  if (issue.ref_hash.has_value())
    row["ref_hash"] = *issue.ref_hash;
  if (issue.detail.has_value())
    row["detail"] = *issue.detail;
  if (issue.reason.has_value())
    row["reason"] = *issue.reason;
  if (issue.algorithm.has_value())
    row["algorithm"] = *issue.algorithm;
  if (issue.recorded.has_value())
    row["recorded"] = *issue.recorded;
  if (issue.computed.has_value())
    row["computed"] = *issue.computed;
  return row;
}

nlohmann::json render_episode_fsck_result(const episode_fsck_result &result) {
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  for (const auto &issue : result.errors)
    errors.push_back(render_episode_fsck_issue(issue));
  for (const auto &issue : result.warnings)
    warnings.push_back(render_episode_fsck_issue(issue));
  nlohmann::json report = {{"ok", result.ok},
                           {"status", result.status},
                           {"schema", result.schema},
                           {"runtime_dir", result.runtime_dir},
                           {"authority", result.authority},
                           {"degraded", result.degraded},
                           {"errors", std::move(errors)},
                           {"warnings", std::move(warnings)},
                           {"checked",
                            {{"episode_manifest_records", result.episode_manifest_records},
                             {"episodes", result.episodes},
                             {"unknown_records", result.unknown_records},
                             {"unfolded_records", result.unfolded_records}}}};
  if (result.episode.has_value()) {
    report["episode"] = summary_json(*result.episode);
  }
  return report;
}

nlohmann::json episode_manifest_store::fsck(uint64_t episode_id) const {
  return render_episode_fsck_result(fsck_typed(episode_id));
}

} // namespace kungfu::yijinjing::storage
