// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/source_registry.h>

#include <map>
#include <memory>
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

constexpr uint32_t SOURCE_REGISTRY_SCHEMA_VERSION = 1;

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

const char *source_kind_name(SourceKind kind) {
  switch (kind) {
  case SourceKind::Local:
    return "local";
  case SourceKind::ImportedBundle:
    return "imported_bundle";
  case SourceKind::KungfuRuntime:
    return "kungfu_runtime";
  case SourceKind::Adapter:
    return "adapter";
  }
  return "unknown";
}

const char *verification_status_name(SourceVerificationStatus status) {
  switch (status) {
  case SourceVerificationStatus::Ok:
    return "ok";
  case SourceVerificationStatus::Degraded:
    return "degraded";
  case SourceVerificationStatus::Failed:
    return "failed";
  }
  return "unknown";
}

location_ptr registry_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<kungfu::yijinjing::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, SOURCE_REGISTRY_NAMESPACE, SOURCE_REGISTRY_NAME,
                               locator);
}

writer make_writer(const std::string &runtime_dir) {
  return writer(registry_location(runtime_dir), location::PUBLIC, true, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

uint64_t source_uid_of(const std::string &source_id) { return fast_hash_str_64(source_id); }

nlohmann::json range_json(uint64_t first_frame_uid, uint64_t last_frame_uid, int64_t since, int64_t until) {
  return {
      {"first_frame_uid", first_frame_uid},
      {"last_frame_uid", last_frame_uid},
      {"since", since},
      {"until", until},
  };
}

nlohmann::json record_json(const SourceRegistered &record) {
  return {
      {"schema", SOURCE_REGISTRY_SCHEMA_V1},           {"record_kind", "source_registered"},
      {"schema_version", record.schema_version},       {"source_uid", record.source_uid},
      {"source_id", fixed_string(record.source_id)},   {"kind", source_kind_name(record.kind)},
      {"coordinate", fixed_string(record.coordinate)}, {"head", fixed_string(record.head)},
      {"location_uid", record.location_uid},           {"register_time", record.register_time},
  };
}

nlohmann::json record_json(const SourceHeadUpdated &record) {
  return {
      {"schema", SOURCE_REGISTRY_SCHEMA_V1},
      {"record_kind", "source_head_updated"},
      {"schema_version", record.schema_version},
      {"source_uid", record.source_uid},
      {"location_uid", record.location_uid},
      {"update_time", record.update_time},
      {"head", fixed_string(record.head)},
      {"range", range_json(record.first_frame_uid, record.last_frame_uid, record.since, record.until)},
      {"inventory_hash",
       {{"algorithm", fixed_string(record.inventory_hash_algo)}, {"value", fixed_string(record.inventory_hash)}}},
  };
}

nlohmann::json record_json(const AcceptedRangeRecorded &record) {
  return {
      {"schema", SOURCE_REGISTRY_SCHEMA_V1},
      {"record_kind", "accepted_range_recorded"},
      {"schema_version", record.schema_version},
      {"source_uid", record.source_uid},
      {"manifest_uid", record.manifest_uid},
      {"source_id", fixed_string(record.source_id)},
      {"manifest_id", fixed_string(record.manifest_id)},
      {"location_uid", record.location_uid},
      {"accept_time", record.accept_time},
      {"range", range_json(record.first_frame_uid, record.last_frame_uid, record.since, record.until)},
      {"status", verification_status_name(record.status)},
  };
}

std::vector<nlohmann::json> read_records(const std::string &runtime_dir) {
  std::vector<nlohmann::json> records;
  const auto location = registry_location(runtime_dir);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return records;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    switch (frame->carrier_type()) {
    case SourceRegistered::tag:
      records.push_back(record_json(frame->data<SourceRegistered>()));
      break;
    case SourceHeadUpdated::tag:
      records.push_back(record_json(frame->data<SourceHeadUpdated>()));
      break;
    case AcceptedRangeRecorded::tag:
      records.push_back(record_json(frame->data<AcceptedRangeRecorded>()));
      break;
    default:
      records.push_back({{"schema", SOURCE_REGISTRY_SCHEMA_V1},
                         {"record_kind", "unknown"},
                         {"carrier_type", frame->carrier_type()},
                         {"frame_uid", frame->frame_uid()},
                         {"gen_time", frame->gen_time()}});
      break;
    }
    records.back()["registry_frame_uid"] = frame->frame_uid();
    records.back()["registry_gen_time"] = frame->gen_time();
    reader->next();
  }
  return records;
}

struct source_fold {
  nlohmann::json summary = nlohmann::json::object();
  nlohmann::json records = nlohmann::json::array();
  nlohmann::json accepted_ranges = nlohmann::json::array();
  bool registered = false;
};

std::map<uint64_t, source_fold> fold_records(const std::vector<nlohmann::json> &records) {
  std::map<uint64_t, source_fold> folded;
  for (const auto &record : records) {
    const auto source_uid = record.value("source_uid", uint64_t{0});
    if (source_uid == 0) {
      continue;
    }
    auto &source = folded[source_uid];
    source.records.push_back(record);
    const auto kind = record.value("record_kind", std::string{});
    if (kind == "source_registered") {
      source.registered = true;
      source.summary["source_uid"] = source_uid;
      source.summary["source_id"] = record.value("source_id", "");
      source.summary["kind"] = record.value("kind", "unknown");
      source.summary["coordinate"] = record.value("coordinate", "");
      source.summary["head"] = record.value("head", "");
      source.summary["location_uid"] = record.value("location_uid", uint64_t{0});
      source.summary["register_time"] = record.value("register_time", int64_t{0});
    } else if (kind == "source_head_updated") {
      // Later head updates fold over earlier ones: current view = latest head.
      if (record.contains("head")) {
        source.summary["head"] = record.value("head", "");
      }
      if (record.contains("range")) {
        source.summary["current_range"] = record.at("range");
      }
      if (record.contains("inventory_hash")) {
        source.summary["inventory_hash"] = record.at("inventory_hash");
      }
      source.summary["update_time"] = record.value("update_time", int64_t{0});
    } else if (kind == "accepted_range_recorded") {
      source.accepted_ranges.push_back(record);
    }
  }
  for (auto &[source_uid, source] : folded) {
    source.summary["schema"] = SOURCE_REGISTRY_SCHEMA_V1;
    source.summary["source_uid"] = source_uid;
    source.summary["registered"] = source.registered;
    source.summary["record_count"] = source.records.size();
    source.summary["accepted_range_count"] = source.accepted_ranges.size();
    if (!source.summary.contains("source_id")) {
      source.summary["source_id"] = "";
    }
  }
  return folded;
}

} // namespace

source_registry_store::source_registry_store(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

source_registry_journal_records source_registry_store::read_typed_records() const {
  source_registry_journal_records records;
  const auto location = registry_location(runtime_dir_);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return records;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    switch (frame->carrier_type()) {
    case SourceRegistered::tag:
      records.registered.push_back(frame->data<SourceRegistered>());
      break;
    case SourceHeadUpdated::tag:
      records.head_updates.push_back(frame->data<SourceHeadUpdated>());
      break;
    case AcceptedRangeRecorded::tag:
      records.accepted_ranges.push_back(frame->data<AcceptedRangeRecorded>());
      break;
    default:
      break;
    }
    reader->next();
  }
  return records;
}

nlohmann::json source_registry_store::register_source(const source_register_options &options) const {
  if (options.source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  SourceRegistered record{};
  record.schema_version = SOURCE_REGISTRY_SCHEMA_VERSION;
  record.source_uid = source_uid_of(options.source_id);
  record.kind = options.kind;
  record.location_uid = options.location_uid == 0 ? registry_location(runtime_dir_)->uid : options.location_uid;
  record.register_time = options.register_time == 0 ? time::now_in_nano() : options.register_time;
  set_fixed_string(record.source_id, options.source_id);
  set_fixed_string(record.coordinate, options.coordinate);
  set_fixed_string(record.head, options.head);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.register_time, 0, record);
  return record_json(record);
}

nlohmann::json source_registry_store::update_head(const source_head_update_options &options) const {
  if (options.source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  SourceHeadUpdated record{};
  record.schema_version = SOURCE_REGISTRY_SCHEMA_VERSION;
  record.source_uid = source_uid_of(options.source_id);
  record.location_uid = options.location_uid == 0 ? registry_location(runtime_dir_)->uid : options.location_uid;
  record.update_time = options.update_time == 0 ? time::now_in_nano() : options.update_time;
  record.first_frame_uid = options.first_frame_uid;
  record.last_frame_uid = options.last_frame_uid;
  record.since = options.since;
  record.until = options.until;
  set_fixed_string(record.head, options.head);
  set_fixed_string(record.inventory_hash_algo, options.inventory_hash_algo);
  set_fixed_string(record.inventory_hash, options.inventory_hash);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.update_time, 0, record);
  return record_json(record);
}

nlohmann::json source_registry_store::record_accepted_range(const accepted_range_options &options) const {
  if (options.source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  AcceptedRangeRecorded record{};
  record.schema_version = SOURCE_REGISTRY_SCHEMA_VERSION;
  record.source_uid = source_uid_of(options.source_id);
  record.manifest_uid = options.manifest_id.empty() ? 0 : fast_hash_str_64(options.manifest_id);
  record.location_uid = options.location_uid == 0 ? registry_location(runtime_dir_)->uid : options.location_uid;
  record.accept_time = options.accept_time == 0 ? time::now_in_nano() : options.accept_time;
  record.first_frame_uid = options.first_frame_uid;
  record.last_frame_uid = options.last_frame_uid;
  record.since = options.since;
  record.until = options.until;
  record.status = options.status;
  set_fixed_string(record.source_id, options.source_id);
  set_fixed_string(record.manifest_id, options.manifest_id);
  auto writer = make_writer(runtime_dir_);
  writer.write_at(record.accept_time, 0, record);
  return record_json(record);
}

nlohmann::json source_registry_store::list() const {
  const auto folded = fold_records(read_records(runtime_dir_));
  nlohmann::json sources = nlohmann::json::array();
  for (const auto &[source_uid, source] : folded) {
    sources.push_back(source.summary);
  }
  return {{"ok", true},
          {"schema", SOURCE_REGISTRY_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"sources", sources},
          {"source_count", sources.size()}};
}

nlohmann::json source_registry_store::inspect(const std::string &source_id) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto source_uid = source_uid_of(source_id);
  const auto folded = fold_records(read_records(runtime_dir_));
  const auto iter = folded.find(source_uid);
  if (iter == folded.end()) {
    return {{"ok", false},
            {"schema", SOURCE_REGISTRY_SCHEMA_V1},
            {"source_id", source_id},
            {"errors", nlohmann::json::array({{{"code", "source_missing"}, {"source_id", source_id}}})}};
  }
  return {{"ok", true},
          {"schema", SOURCE_REGISTRY_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"source", iter->second.summary},
          {"accepted_ranges", iter->second.accepted_ranges},
          {"records", iter->second.records}};
}

nlohmann::json source_registry_store::fsck(const std::string &source_id) const {
  const auto records = read_records(runtime_dir_);
  const auto folded = fold_records(records);
  const auto filter_uid = source_id.empty() ? uint64_t{0} : source_uid_of(source_id);
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  size_t checked = 0;
  for (const auto &[current_source_uid, source] : folded) {
    if (filter_uid != 0 && current_source_uid != filter_uid) {
      continue;
    }
    ++checked;
    if (!source.registered) {
      // Head updates or accepted ranges without a registration are dangling
      // producer output: honest degradation, recorded, not silently dropped.
      errors.push_back({{"code", "source_registration_missing"}, {"source_uid", current_source_uid}});
    }
    size_t register_count = 0;
    for (const auto &record : source.records) {
      if (record.value("record_kind", std::string{}) == "source_registered") {
        ++register_count;
      }
    }
    if (register_count > 1) {
      warnings.push_back(
          {{"code", "source_registered_duplicate"}, {"source_uid", current_source_uid}, {"count", register_count}});
    }
  }
  if (filter_uid != 0 && checked == 0) {
    errors.push_back({{"code", "source_missing"}, {"source_id", source_id}});
  }
  return {{"ok", errors.empty()},
          {"status", errors.empty() ? "ok" : "failed"},
          {"schema", SOURCE_REGISTRY_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"errors", errors},
          {"warnings", warnings},
          {"checked", {{"source_registry_records", records.size()}, {"sources", checked}}}};
}

} // namespace kungfu::yijinjing::storage
