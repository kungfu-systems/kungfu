// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/episode_manifest.h>

#include <algorithm>
#include <map>
#include <memory>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace kungfu::yijinjing::storage {

namespace {

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

std::vector<nlohmann::json> read_records(const std::string &runtime_dir) {
  std::vector<nlohmann::json> records;
  const auto location = manifest_location(runtime_dir);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return records;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    switch (frame->carrier_type()) {
    case EpisodeOpen::tag:
      records.push_back(record_json(frame->data<EpisodeOpen>()));
      break;
    case EpisodeHeartbeat::tag:
      records.push_back(record_json(frame->data<EpisodeHeartbeat>()));
      break;
    case EpisodeFrameAttached::tag:
      records.push_back(record_json(frame->data<EpisodeFrameAttached>()));
      break;
    case EpisodeRefAttached::tag:
      records.push_back(record_json(frame->data<EpisodeRefAttached>()));
      break;
    case EpisodeClosed::tag:
      records.push_back(record_json(frame->data<EpisodeClosed>()));
      break;
    default:
      records.push_back({{"schema", EPISODE_MANIFEST_SCHEMA_V1},
                         {"record_kind", "unknown"},
                         {"carrier_type", frame->carrier_type()},
                         {"frame_uid", frame->frame_uid()},
                         {"gen_time", frame->gen_time()}});
      break;
    }
    records.back()["manifest_frame_uid"] = frame->frame_uid();
    records.back()["manifest_gen_time"] = frame->gen_time();
    reader->next();
  }
  return records;
}

struct episode_fold {
  nlohmann::json summary = nlohmann::json::object();
  nlohmann::json records = nlohmann::json::array();
  nlohmann::json frames = nlohmann::json::array();
  nlohmann::json refs = nlohmann::json::array();
  bool opened = false;
  bool closed = false;
};

std::map<uint64_t, episode_fold> fold_records(const std::vector<nlohmann::json> &records) {
  std::map<uint64_t, episode_fold> folded;
  for (const auto &record : records) {
    const auto episode_id = record.value("episode_id", uint64_t{0});
    if (episode_id == 0) {
      continue;
    }
    auto &episode = folded[episode_id];
    episode.records.push_back(record);
    const auto kind = record.value("record_kind", std::string{});
    if (kind == "episode_open") {
      episode.opened = true;
      episode.summary = record;
      episode.summary["record_count"] = episode.records.size();
      episode.summary["frame_count"] = episode.frames.size();
      episode.summary["ref_count"] = episode.refs.size();
    } else if (kind == "episode_heartbeat") {
      episode.summary["last_frame_uid"] = record.value("last_frame_uid", uint64_t{0});
      episode.summary["frame_count"] = record.value("frame_count", episode.frames.size());
      episode.summary["update_time"] = record.value("update_time", int64_t{0});
    } else if (kind == "episode_frame_attached") {
      episode.frames.push_back(record);
      episode.summary["last_frame_uid"] = record.value("frame_uid", uint64_t{0});
      episode.summary["frame_count"] = episode.frames.size();
    } else if (kind == "episode_ref_attached") {
      episode.refs.push_back(record);
      episode.summary["ref_count"] = episode.refs.size();
    } else if (kind == "episode_closed") {
      episode.closed = true;
      episode.summary["status"] = record.value("status", "unknown");
      episode.summary["end_time"] = record.value("end_time", int64_t{0});
      episode.summary["last_frame_uid"] = record.value("last_frame_uid", uint64_t{0});
      episode.summary["frame_count"] = record.value("frame_count", episode.frames.size());
      episode.summary["reason"] = record.value("reason", "");
    }
  }
  for (auto &[episode_id, episode] : folded) {
    episode.summary["schema"] = EPISODE_MANIFEST_SCHEMA_V1;
    episode.summary["episode_id"] = episode_id;
    episode.summary["opened"] = episode.opened;
    episode.summary["closed"] = episode.closed;
    episode.summary["record_count"] = episode.records.size();
    episode.summary["frame_count"] = episode.frames.size();
    episode.summary["ref_count"] = episode.refs.size();
    if (!episode.summary.contains("status")) {
      episode.summary["status"] = episode.opened ? "open" : "dangling";
    }
  }
  return folded;
}

} // namespace

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
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.end_time, 0, record);
  return record_json(record);
}

nlohmann::json episode_manifest_store::abort(const episode_close_options &options) const {
  auto abort_options = options;
  abort_options.status = EpisodeStatus::Aborted;
  return end(abort_options);
}

nlohmann::json episode_manifest_store::list(uint64_t location_uid, uint64_t limit) const {
  const auto folded = fold_records(read_records(runtime_dir_));
  nlohmann::json episodes = nlohmann::json::array();
  for (auto iter = folded.rbegin(); iter != folded.rend(); ++iter) {
    const auto &summary = iter->second.summary;
    if (location_uid != 0 && summary.value("location_uid", uint64_t{0}) != location_uid) {
      continue;
    }
    episodes.push_back(summary);
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
  const auto folded = fold_records(read_records(runtime_dir_));
  const auto iter = folded.find(episode_id);
  if (iter == folded.end()) {
    return {{"ok", false},
            {"schema", EPISODE_MANIFEST_SCHEMA_V1},
            {"episode_id", episode_id},
            {"errors", nlohmann::json::array({{{"code", "episode_missing"}, {"episode_id", episode_id}}})}};
  }
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"episode", iter->second.summary},
          {"records", iter->second.records},
          {"frames", iter->second.frames},
          {"refs", iter->second.refs}};
}

nlohmann::json episode_manifest_store::fsck(uint64_t episode_id) const {
  const auto records = read_records(runtime_dir_);
  const auto folded = fold_records(records);
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  size_t checked = 0;
  for (const auto &[current_episode_id, episode] : folded) {
    if (episode_id != 0 && current_episode_id != episode_id) {
      continue;
    }
    ++checked;
    if (!episode.opened) {
      errors.push_back({{"code", "episode_open_missing"}, {"episode_id", current_episode_id}});
    }
    size_t open_count = 0;
    size_t close_count = 0;
    std::vector<uint64_t> seen_frames;
    for (const auto &record : episode.records) {
      const auto kind = record.value("record_kind", std::string{});
      if (kind == "episode_open") {
        ++open_count;
      } else if (kind == "episode_closed") {
        ++close_count;
      } else if (kind == "episode_frame_attached") {
        const auto frame_uid = record.value("frame_uid", uint64_t{0});
        if (frame_uid == 0) {
          errors.push_back({{"code", "episode_frame_uid_missing"}, {"episode_id", current_episode_id}});
        } else if (std::find(seen_frames.begin(), seen_frames.end(), frame_uid) != seen_frames.end()) {
          warnings.push_back(
              {{"code", "episode_frame_duplicate"}, {"episode_id", current_episode_id}, {"frame_uid", frame_uid}});
        } else {
          seen_frames.push_back(frame_uid);
        }
      }
    }
    if (open_count > 1) {
      errors.push_back({{"code", "episode_open_duplicate"}, {"episode_id", current_episode_id}, {"count", open_count}});
    }
    if (close_count > 1) {
      warnings.push_back(
          {{"code", "episode_closed_duplicate"}, {"episode_id", current_episode_id}, {"count", close_count}});
    }
  }
  if (episode_id != 0 && checked == 0) {
    errors.push_back({{"code", "episode_missing"}, {"episode_id", episode_id}});
  }
  return {{"ok", errors.empty()},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"errors", errors},
          {"warnings", warnings},
          {"checked", {{"episode_manifest_records", records.size()}, {"episodes", checked}}}};
}

} // namespace kungfu::yijinjing::storage
