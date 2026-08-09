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
  return writer(registry_location(runtime_dir), location::PUBLIC, std::make_shared<noop_publisher>(), false,
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

nlohmann::json record_row_json(const source_registry_record &record) {
  auto row = std::visit(
      [&record](const auto &body) -> nlohmann::json {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, source_registry_unknown_record>) {
          return {{"schema", SOURCE_REGISTRY_SCHEMA_V1},
                  {"record_kind", "unknown"},
                  {"carrier_type", body.carrier_type},
                  {"frame_uid", record.registry_frame_uid},
                  {"gen_time", record.registry_gen_time}};
        } else {
          return record_json(body);
        }
      },
      record.body);
  row["registry_frame_uid"] = record.registry_frame_uid;
  row["registry_gen_time"] = record.registry_gen_time;
  return row;
}

uint64_t record_source_uid(const source_registry_record &record) {
  return std::visit(
      [](const auto &body) -> uint64_t {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, source_registry_unknown_record>) {
          return 0;
        } else {
          return body.source_uid;
        }
      },
      record.body);
}

void fold_into(source_registry_fold &fold, const source_registry_record &record) {
  ++fold.total_record_count;
  if (std::holds_alternative<source_registry_unknown_record>(record.body)) {
    ++fold.unknown_record_count;
    return;
  }
  const auto source_uid = record_source_uid(record);
  if (source_uid == 0) {
    ++fold.unfolded_record_count;
    return;
  }
  auto &source = fold.sources[source_uid];
  source.source_uid = source_uid;
  source.records.push_back(record);
  const auto record_index = source.records.size() - 1;
  std::visit(
      [&source, record_index](const auto &body) {
        using body_t = std::decay_t<decltype(body)>;
        if constexpr (std::is_same_v<body_t, SourceRegistered>) {
          source.registered = true;
          ++source.register_count;
          source.registration = body;
          source.current_head = fixed_string(body.head);
        } else if constexpr (std::is_same_v<body_t, SourceHeadUpdated>) {
          source.head_update_seen = true;
          source.head_update = body;
          source.current_head = fixed_string(body.head);
        } else if constexpr (std::is_same_v<body_t, AcceptedRangeRecorded>) {
          source.accepted_range_indices.push_back(record_index);
        }
      },
      record.body);
}

nlohmann::json summary_json(const source_registry_current_view &source) {
  nlohmann::json summary = {{"schema", SOURCE_REGISTRY_SCHEMA_V1},
                            {"source_uid", source.source_uid},
                            {"source_id", source.registered ? fixed_string(source.registration.source_id) : ""},
                            {"registered", source.registered},
                            {"record_count", source.records.size()},
                            {"accepted_range_count", source.accepted_range_indices.size()}};
  if (source.registered) {
    summary["kind"] = source_kind_name(source.registration.kind);
    summary["coordinate"] = fixed_string(source.registration.coordinate);
    summary["head"] = source.current_head;
    summary["location_uid"] = source.registration.location_uid;
    summary["register_time"] = source.registration.register_time;
  }
  if (source.head_update_seen) {
    summary["current_range"] = range_json(source.head_update.first_frame_uid, source.head_update.last_frame_uid,
                                          source.head_update.since, source.head_update.until);
    summary["inventory_hash"] = {{"algorithm", fixed_string(source.head_update.inventory_hash_algo)},
                                 {"value", fixed_string(source.head_update.inventory_hash)}};
    summary["update_time"] = source.head_update.update_time;
  }
  return summary;
}

nlohmann::json records_json(const source_registry_current_view &source) {
  nlohmann::json rows = nlohmann::json::array();
  for (const auto &record : source.records) {
    rows.push_back(record_row_json(record));
  }
  return rows;
}

nlohmann::json accepted_ranges_json(const source_registry_current_view &source) {
  nlohmann::json rows = nlohmann::json::array();
  for (const auto index : source.accepted_range_indices) {
    rows.push_back(record_row_json(source.records.at(index)));
  }
  return rows;
}

} // namespace

source_registry_store::source_registry_store(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

source_registry_journal_records source_registry_store::read_typed_records() const {
  source_registry_journal_records records;
  for_each_typed_record([&records](const source_registry_record &record) {
    std::visit(
        [&records](const auto &body) {
          using body_t = std::decay_t<decltype(body)>;
          if constexpr (std::is_same_v<body_t, SourceRegistered>) {
            records.registered.push_back(body);
          } else if constexpr (std::is_same_v<body_t, SourceHeadUpdated>) {
            records.head_updates.push_back(body);
          } else if constexpr (std::is_same_v<body_t, AcceptedRangeRecorded>) {
            records.accepted_ranges.push_back(body);
          }
        },
        record.body);
  });
  return records;
}

void source_registry_store::for_each_typed_record(const source_registry_record_visitor &visit) const {
  const auto location = registry_location(runtime_dir_);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    source_registry_record record{};
    record.registry_frame_uid = frame->frame_uid();
    record.registry_gen_time = frame->gen_time();
    switch (frame->carrier_type()) {
    case SourceRegistered::tag:
      record.body = frame->data<SourceRegistered>();
      break;
    case SourceHeadUpdated::tag:
      record.body = frame->data<SourceHeadUpdated>();
      break;
    case AcceptedRangeRecorded::tag:
      record.body = frame->data<AcceptedRangeRecorded>();
      break;
    default:
      record.body = source_registry_unknown_record{frame->carrier_type()};
      break;
    }
    visit(record);
    reader->next();
  }
}

std::vector<source_registry_record> source_registry_store::read_typed_stream() const {
  std::vector<source_registry_record> records;
  for_each_typed_record([&records](const source_registry_record &record) { records.push_back(record); });
  return records;
}

source_registry_fold source_registry_store::fold_typed_records() const {
  source_registry_fold fold;
  for_each_typed_record([&fold](const source_registry_record &record) { fold_into(fold, record); });
  return fold;
}

SourceRegistered source_registry_store::register_source(const source_register_options &options) const {
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
  return record;
}

SourceHeadUpdated source_registry_store::update_head(const source_head_update_options &options) const {
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
  return record;
}

AcceptedRangeRecorded source_registry_store::record_accepted_range(const accepted_range_options &options) const {
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
  return record;
}

nlohmann::json source_registry_store::list() const {
  const auto folded = fold_typed_records();
  nlohmann::json sources = nlohmann::json::array();
  for (const auto &[source_uid, source] : folded.sources) {
    (void)source_uid;
    sources.push_back(summary_json(source));
  }
  return {{"ok", true},
          {"schema", SOURCE_REGISTRY_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"sources", sources},
          {"source_count", sources.size()}};
}

std::optional<source_registry_current_view> source_registry_store::inspect_typed(const std::string &source_id) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto folded = fold_typed_records();
  const auto iter = folded.sources.find(source_uid_of(source_id));
  if (iter == folded.sources.end()) {
    return std::nullopt;
  }
  return iter->second;
}

nlohmann::json source_registry_store::inspect(const std::string &source_id) const {
  const auto inspected = inspect_typed(source_id);
  if (!inspected.has_value()) {
    return {{"ok", false},
            {"schema", SOURCE_REGISTRY_SCHEMA_V1},
            {"source_id", source_id},
            {"errors", nlohmann::json::array({{{"code", "source_missing"}, {"source_id", source_id}}})}};
  }
  return {{"ok", true},
          {"schema", SOURCE_REGISTRY_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"source", summary_json(*inspected)},
          {"accepted_ranges", accepted_ranges_json(*inspected)},
          {"records", records_json(*inspected)}};
}

source_registry_fsck_result source_registry_store::fsck_typed(const std::string &source_id) const {
  const auto folded = fold_typed_records();
  const auto filter_uid = source_id.empty() ? uint64_t{0} : source_uid_of(source_id);
  source_registry_fsck_result result{};
  result.runtime_dir = runtime_dir_;
  result.source_registry_records = static_cast<uint64_t>(folded.total_record_count);
  for (const auto &[current_source_uid, source] : folded.sources) {
    if (filter_uid != 0 && current_source_uid != filter_uid) {
      continue;
    }
    ++result.sources;
    if (!source.registered) {
      // Head updates or accepted ranges without a registration are dangling
      // producer output: honest degradation, recorded, not silently dropped.
      result.errors.push_back({"source_registration_missing", current_source_uid, {}, {}});
    }
    if (source.register_count > 1) {
      result.warnings.push_back(
          {"source_registered_duplicate", current_source_uid, {}, static_cast<uint64_t>(source.register_count)});
    }
  }
  if (filter_uid != 0 && result.sources == 0) {
    result.errors.push_back({"source_missing", {}, source_id, {}});
  }
  result.ok = result.errors.empty();
  result.status = result.ok ? "ok" : "failed";
  return result;
}

nlohmann::json source_registry_store::fsck(const std::string &source_id) const {
  const auto result = fsck_typed(source_id);
  const auto render_issue = [](const source_registry_fsck_issue &issue) {
    nlohmann::json row = {{"code", issue.code}};
    if (issue.source_uid.has_value()) {
      row["source_uid"] = *issue.source_uid;
    }
    if (issue.source_id.has_value()) {
      row["source_id"] = *issue.source_id;
    }
    if (issue.count.has_value()) {
      row["count"] = *issue.count;
    }
    return row;
  };
  nlohmann::json errors = nlohmann::json::array();
  nlohmann::json warnings = nlohmann::json::array();
  for (const auto &issue : result.errors) {
    errors.push_back(render_issue(issue));
  }
  for (const auto &issue : result.warnings) {
    warnings.push_back(render_issue(issue));
  }
  return {{"ok", result.ok},
          {"status", result.status},
          {"schema", result.schema},
          {"runtime_dir", result.runtime_dir},
          {"authority", result.authority},
          {"errors", std::move(errors)},
          {"warnings", std::move(warnings)},
          {"checked", {{"source_registry_records", result.source_registry_records}, {"sources", result.sources}}}};
}

} // namespace kungfu::yijinjing::storage
