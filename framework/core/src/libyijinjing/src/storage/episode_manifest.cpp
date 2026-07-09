// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/episode_manifest.h>

#include <algorithm>
#include <filesystem>
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

uint64_t u64_or(const nlohmann::json &object, const std::string &field, uint64_t fallback = 0) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_number_unsigned()) {
    return value.get<uint64_t>();
  }
  if (value.is_number_integer()) {
    const auto signed_value = value.get<int64_t>();
    return signed_value < 0 ? fallback : static_cast<uint64_t>(signed_value);
  }
  return fallback;
}

std::string text_or(const nlohmann::json &object, const std::string &field, const std::string &fallback = {}) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_string()) {
    return fallback;
  }
  return object.at(field).get<std::string>();
}

bool contains_u64(const std::vector<uint64_t> &values, uint64_t value) {
  return std::find(values.begin(), values.end(), value) != values.end();
}

bool payload_ref_exists(const std::string &runtime_dir, const nlohmann::json &ref) {
  const auto ref_id = text_or(ref, "ref_id");
  if (ref_id.empty()) {
    return false;
  }
  fs::path path(ref_id);
  if (path.is_relative()) {
    path = fs::path(runtime_dir) / path;
  }
  return fs::exists(path);
}

struct episode_graph {
  nlohmann::json graph = nlohmann::json::object();
  nlohmann::json dependencies = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  bool degraded = false;
};

episode_graph build_causal_graph(const std::string &runtime_dir, uint64_t episode_id, const episode_fold &episode,
                                 const std::map<uint64_t, episode_fold> &folded) {
  std::vector<uint64_t> frame_uids;
  std::vector<uint64_t> declared_input_frames;
  nlohmann::json frame_edges = nlohmann::json::array();
  nlohmann::json dependencies = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  bool degraded = false;

  for (const auto &frame : episode.frames) {
    const auto frame_uid = u64_or(frame, "frame_uid");
    if (frame_uid != 0) {
      frame_uids.push_back(frame_uid);
    }
  }
  for (const auto &ref : episode.refs) {
    if (text_or(ref, "ref_kind") == "input_frame") {
      const auto ref_uid = u64_or(ref, "ref_uid");
      if (ref_uid != 0) {
        declared_input_frames.push_back(ref_uid);
      }
    }
  }

  const auto parent_episode_id = u64_or(episode.summary, "parent_episode_id");
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

  const auto root_trigger_frame_uid = u64_or(episode.summary, "root_trigger_frame_uid");
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

  for (const auto &frame : episode.frames) {
    const auto frame_uid = u64_or(frame, "frame_uid");
    const auto trigger_frame_uid = u64_or(frame, "trigger_frame_uid");
    if (trigger_frame_uid == 0) {
      continue;
    }
    if (contains_u64(frame_uids, trigger_frame_uid)) {
      frame_edges.push_back({{"kind", "frame_trigger"},
                             {"scope", "internal"},
                             {"from_frame_uid", trigger_frame_uid},
                             {"to_frame_uid", frame_uid}});
      continue;
    }
    const bool declared = contains_u64(declared_input_frames, trigger_frame_uid);
    dependencies.push_back({{"kind", "frame"},
                            {"role", "trigger"},
                            {"frame_uid", trigger_frame_uid},
                            {"dependent_frame_uid", frame_uid},
                            {"status", declared ? "declared_external" : "missing"}});
    if (!declared) {
      degraded = true;
      warnings.push_back({{"code", "episode_trigger_frame_missing"},
                          {"episode_id", episode_id},
                          {"frame_uid", trigger_frame_uid},
                          {"dependent_frame_uid", frame_uid}});
    }
  }

  for (const auto &ref : episode.refs) {
    const auto ref_kind = text_or(ref, "ref_kind");
    if (ref_kind == "episode") {
      const auto ref_uid = u64_or(ref, "ref_uid");
      const bool present = ref_uid != 0 && folded.find(ref_uid) != folded.end();
      const bool declared_external = ref_uid == 0 || !text_or(ref, "ref_id").empty();
      const auto status = present ? "present" : (declared_external ? "declared_external" : "missing");
      dependencies.push_back({{"kind", "episode"},
                              {"role", "ref"},
                              {"episode_id", ref_uid},
                              {"ref_id", text_or(ref, "ref_id")},
                              {"ref_hash", text_or(ref, "ref_hash")},
                              {"status", status}});
      if (!present && !declared_external) {
        degraded = true;
        warnings.push_back({{"code", "episode_dependency_missing"},
                            {"episode_id", episode_id},
                            {"dependency_episode_id", ref_uid},
                            {"role", "ref"}});
      }
    } else if (ref_kind == "payload") {
      const bool present = payload_ref_exists(runtime_dir, ref);
      dependencies.push_back({{"kind", "payload"},
                              {"role", "payload_ref"},
                              {"ref_uid", u64_or(ref, "ref_uid")},
                              {"ref_id", text_or(ref, "ref_id")},
                              {"ref_hash", text_or(ref, "ref_hash")},
                              {"status", present ? "present" : "missing"}});
      if (!present) {
        degraded = true;
        warnings.push_back({{"code", "episode_payload_ref_missing"},
                            {"episode_id", episode_id},
                            {"ref_id", text_or(ref, "ref_id")},
                            {"ref_hash", text_or(ref, "ref_hash")}});
      }
    } else if (ref_kind == "schema") {
      dependencies.push_back({{"kind", "schema"},
                              {"role", "schema_ref"},
                              {"ref_uid", u64_or(ref, "ref_uid")},
                              {"ref_id", text_or(ref, "ref_id")},
                              {"ref_hash", text_or(ref, "ref_hash")},
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
          warnings,
          degraded};
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
  const auto graph = build_causal_graph(runtime_dir_, episode_id, iter->second, folded);
  return {{"ok", true},
          {"schema", EPISODE_MANIFEST_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"episode", iter->second.summary},
          {"causal_graph", graph.graph},
          {"dependencies", graph.dependencies},
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
  bool degraded = false;
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
    const auto graph = build_causal_graph(runtime_dir_, current_episode_id, episode, folded);
    degraded = degraded || graph.degraded;
    for (const auto &warning : graph.warnings) {
      warnings.push_back(warning);
    }
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
          {"checked", {{"episode_manifest_records", records.size()}, {"episodes", checked}}}};
}

} // namespace kungfu::yijinjing::storage
