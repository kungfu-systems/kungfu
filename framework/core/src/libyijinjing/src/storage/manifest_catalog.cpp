// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/manifest_catalog.h>

#include <algorithm>
#include <map>
#include <memory>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/hash.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/sync_root.h>
#include <kungfu/yijinjing/time.h>

using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace kungfu::yijinjing::storage {

namespace {

constexpr uint32_t MANIFEST_CATALOG_SCHEMA_VERSION = 1;

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

// POD fields are fixed budgets, not silent truncation points: an over-budget
// field would desynchronize the delta records from the committed entries
// document, so it is rejected at acceptance.
template <size_t N> void set_checked_string(kungfu::array<char, N> &dest, const std::string &value, const char *field) {
  if (value.size() >= N) {
    throw std::invalid_argument(std::string("storage_manifest_invalid: field_too_long: ") + field);
  }
  set_fixed_string(dest, value);
}

std::string text_or(const nlohmann::json &object, const std::string &field, const std::string &fallback = {}) {
  if (!object.is_object() || !object.contains(field)) {
    return fallback;
  }
  const auto &value = object.at(field);
  if (value.is_string()) {
    return value.get<std::string>();
  }
  if (value.is_null()) {
    return fallback;
  }
  return value.dump(-1, ' ', false);
}

nlohmann::json object_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_object()) {
    return nlohmann::json::object();
  }
  return object.at(field);
}

nlohmann::json array_or_empty(const nlohmann::json &object, const std::string &field) {
  if (!object.is_object() || !object.contains(field) || !object.at(field).is_array()) {
    return nlohmann::json::array();
  }
  return object.at(field);
}

std::string canonical_json(const nlohmann::json &value) { return value.dump(-1, ' ', false); }

std::string source_id_for(const nlohmann::json &input) {
  auto source_id = text_or(input, "storage_source_id");
  if (source_id.empty()) {
    source_id = text_or(input, "source_id");
  }
  return source_id.empty() ? "local" : source_id;
}

std::string source_type_for(const nlohmann::json &input) {
  auto source_type = text_or(input, "source_type");
  if (source_type.empty()) {
    source_type = text_or(input, "type");
  }
  return source_type.empty() ? "local" : source_type;
}

std::string source_coordinate_for(const nlohmann::json &input) {
  auto coordinate = text_or(input, "source_coordinate");
  if (coordinate.empty()) {
    coordinate = text_or(input, "repo_root");
  }
  if (coordinate.empty()) {
    coordinate = text_or(input, "repo");
  }
  return coordinate;
}

std::string source_head_for(const nlohmann::json &input) {
  auto head = text_or(input, "source_head");
  if (head.empty()) {
    head = text_or(input, "repo_head");
  }
  if (head.empty()) {
    head = text_or(input, "head");
  }
  return head;
}

std::string manifest_id_for(const nlohmann::json &input) {
  auto id = text_or(input, "manifest_id");
  if (id.empty()) {
    id = text_or(input, "import_id");
  }
  return id;
}

std::string payload_subject(const nlohmann::json &entry) {
  const auto kind = text_or(entry, "kind");
  const auto source_id = text_or(entry, "source_id");
  if (kind.empty()) {
    return source_id;
  }
  if (source_id.empty()) {
    return kind;
  }
  return kind + ":" + source_id;
}

const char *payload_state_name(PayloadState state) {
  switch (state) {
  case PayloadState::Present:
    return "present";
  case PayloadState::Redacted:
    return "redacted";
  case PayloadState::Absent:
    return "absent";
  case PayloadState::Missing:
    return "missing";
  }
  return "missing";
}

PayloadState payload_state_from_text(const std::string &state) {
  if (state == "present") {
    return PayloadState::Present;
  }
  if (state == "redacted") {
    return PayloadState::Redacted;
  }
  if (state == "absent") {
    return PayloadState::Absent;
  }
  return PayloadState::Missing;
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

location_ptr catalog_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<kungfu::yijinjing::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, MANIFEST_CATALOG_NAMESPACE, MANIFEST_CATALOG_NAME,
                               locator);
}

writer make_writer(const std::string &runtime_dir) {
  return writer(catalog_location(runtime_dir), location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

uint64_t uid_of(const std::string &text) { return fast_hash_str_64(text); }

uint64_t manifest_uid_of(const std::string &source_id, const std::string &manifest_id) {
  return uid_of(source_id + ":" + manifest_id);
}

uint64_t channel_uid_of(const std::string &source_id) { return uid_of("import:" + source_id); }

nlohmann::json range_edge(const std::string &since, const std::string &until) {
  nlohmann::json range = nlohmann::json::object();
  if (!since.empty()) {
    range["since"] = since;
  }
  if (!until.empty()) {
    range["until"] = until;
  }
  return range;
}

nlohmann::json sync_root_edge(const ImportManifestAccepted &record) {
  // The record pins algorithm + value; the constant proof fields are fixed by
  // the record's schema_version. Acceptance verified the canonical object, so
  // this reconstruction is exact.
  nlohmann::json ordering_fields = nlohmann::json::array();
  ordering_fields.push_back("kind");
  ordering_fields.push_back("source_id");
  ordering_fields.push_back("source_path");
  return {
      {"schema", SYNC_ROOT_SCHEMA_V1},
      {"scope", SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST},
      {"proof", SYNC_ROOT_PROOF_LINEAR_CHAIN_V1},
      {"algorithm", fixed_string(record.sync_root_algo)},
      {"value", fixed_string(record.sync_root_value)},
      {"entry_count", record.entry_count},
      {"initial", SYNC_ROOT_INITIAL_SHA256},
      {"ordering",
       {
           {"policy", SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
           {"fields", ordering_fields},
       }},
  };
}

nlohmann::json payload_inventory_impl(const nlohmann::json &entries) {
  nlohmann::json payloads = nlohmann::json::array();
  if (entries.is_array()) {
    for (const auto &entry : entries) {
      if (!entry.is_object()) {
        continue;
      }
      payloads.push_back({
          {"subject", payload_subject(entry)},
          {"content_type", text_or(entry, "content_type")},
          {"hash", text_or(entry, "payload_hash")},
          {"byte_len", entry.value("byte_len", 0)},
          {"state", text_or(entry, "payload_state", "missing")},
          {"source_path", text_or(entry, "source_path")},
      });
    }
  }
  return {
      {"schema", STORAGE_PAYLOAD_INVENTORY_SCHEMA_V1},
      {"algorithm", CONTENT_HASH_ALGORITHM_SHA256},
      {"entries", payloads},
  };
}

nlohmann::json schema_inventory_impl(const nlohmann::json &entries) {
  nlohmann::json schemas = nlohmann::json::array();
  std::vector<std::string> seen;
  if (entries.is_array()) {
    for (const auto &entry : entries) {
      if (!entry.is_object()) {
        continue;
      }
      auto schema = object_or_empty(object_or_empty(entry, "action"), "schema_ref");
      if (schema.empty()) {
        const auto schema_version = entry.value("schema_version", 0);
        if (schema_version != 0) {
          schema = {{"id", text_or(entry, "kind")}, {"version", schema_version}};
        }
      }
      if (schema.empty()) {
        continue;
      }
      const auto key = text_or(schema, "id") + ":" + text_or(schema, "version");
      if (std::find(seen.begin(), seen.end(), key) != seen.end()) {
        continue;
      }
      seen.push_back(key);
      schemas.push_back({{"schema", schema}, {"content_type", text_or(entry, "content_type")}});
    }
  }
  return {
      {"schema", STORAGE_SCHEMA_INVENTORY_SCHEMA_V1},
      {"entries", schemas},
  };
}

nlohmann::json accepted_range_edge(const ImportManifestAccepted &record) {
  return {
      {"schema", STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
      {"source_id", fixed_string(record.source_id)},
      {"manifest_id", fixed_string(record.manifest_id)},
      {"range", range_edge(fixed_string(record.range_since), fixed_string(record.range_until))},
      {"source_head", fixed_string(record.source_head)},
      {"sync_root", sync_root_edge(record)},
      {"entry_count", record.entry_count},
      {"status", verification_status_name(record.status)},
  };
}

nlohmann::json source_record_edge(const ImportManifestAccepted &record) {
  const auto source_type = fixed_string(record.source_type);
  return {
      {"schema", STORAGE_SOURCE_RECORD_SCHEMA_V1},
      {"source_id", fixed_string(record.source_id)},
      {"type", source_type},
      {"kind", source_type == "atlas" ? "adapter" : "local"},
      {"coordinate", fixed_string(record.source_coordinate)},
      {"current_head",
       {
           {"head", fixed_string(record.source_head)},
           {"range", range_edge(fixed_string(record.range_since), fixed_string(record.range_until))},
           {"inventory_hash", fixed_string(record.sync_root_value)},
       }},
      {"accepted_ranges", nlohmann::json::array({accepted_range_edge(record)})},
      {"last_manifest_id", fixed_string(record.manifest_id)},
      {"updated_at", ""},
  };
}

nlohmann::json cursor_edge(const ChannelCursorUpdated &record) {
  return {
      {"schema", STORAGE_CHANNEL_CURSOR_SCHEMA_V1},
      {"source_id", fixed_string(record.source_id)},
      {"manifest_id", fixed_string(record.manifest_id)},
      {"source_head", fixed_string(record.source_head)},
      {"range", range_edge(fixed_string(record.range_since), fixed_string(record.range_until))},
      {"sync_root",
       {
           {"algorithm", fixed_string(record.sync_root_algo)},
           {"value", fixed_string(record.sync_root_value)},
       }},
      {"entry_count", record.entry_count},
  };
}

nlohmann::json manifest_edge(const ImportManifestAccepted &record, const nlohmann::json &entries) {
  return {
      {"schema", STORAGE_IMPORT_MANIFEST_SCHEMA_V1},
      {"authority", "yijinjing-journal"},
      {"manifest_id", fixed_string(record.manifest_id)},
      {"scope", fixed_string(record.scope)},
      {"source", source_record_edge(record)},
      {"source_id", fixed_string(record.source_id)},
      {"source_type", fixed_string(record.source_type)},
      {"source_head", fixed_string(record.source_head)},
      {"range", range_edge(fixed_string(record.range_since), fixed_string(record.range_until))},
      {"counts", {{"records", record.entry_count}}},
      {"entries", entries},
      {"payload_inventory", payload_inventory_impl(entries)},
      {"schema_inventory", schema_inventory_impl(entries)},
      {"accepted_ranges", nlohmann::json::array({accepted_range_edge(record)})},
      {"sync_root", sync_root_edge(record)},
      {"idempotency_key", fixed_string(record.source_id) + ":" + fixed_string(record.manifest_id)},
  };
}

storage_issue make_issue(const std::string &code, const std::string &path, const std::string &message,
                         nlohmann::json expected = nullptr, nlohmann::json actual = nullptr,
                         const std::string &severity = "error") {
  storage_issue issue{};
  issue.severity = severity;
  issue.code = code;
  issue.path = path;
  issue.message = message;
  issue.expected = std::move(expected);
  issue.actual = std::move(actual);
  return issue;
}

void require_string(std::vector<storage_issue> &issues, const nlohmann::json &object, const std::string &field,
                    const std::string &path) {
  if (!object.contains(field) || !object.at(field).is_string() || object.at(field).get<std::string>().empty()) {
    issues.emplace_back(make_issue("missing_field", path + "." + field, "required string field is missing"));
  }
}

bool matches_time_range(const nlohmann::json &entry, const nlohmann::json &range_filter) {
  if (!range_filter.is_object() || range_filter.empty()) {
    return true;
  }
  const auto stamp = text_or(entry, "source_time");
  if (stamp.empty()) {
    return false;
  }
  const auto since = text_or(range_filter, "since");
  const auto until = text_or(range_filter, "until");
  if (!since.empty() && stamp < since) {
    return false;
  }
  if (!until.empty() && stamp > until) {
    return false;
  }
  return true;
}

// The fold: append-ordered headers grouped by source, entry records grouped by
// manifest, plus receipts and cursors.
struct catalog_fold {
  manifest_catalog_journal_records records = {};
  // manifest_uid -> indices into records.manifests, in append order.
  std::map<uint64_t, std::vector<size_t>> manifest_accepts = {};
  // source_uid -> indices into records.manifests, in append order.
  std::map<uint64_t, std::vector<size_t>> source_manifests = {};
  // manifest_uid -> entry_index -> indices into records.entries.
  std::map<uint64_t, std::map<uint64_t, std::vector<size_t>>> manifest_entries = {};
};

catalog_fold fold_catalog(const manifest_catalog_journal_records &records) {
  catalog_fold fold;
  fold.records = records;
  for (size_t index = 0; index < records.manifests.size(); ++index) {
    const auto &record = records.manifests[index];
    fold.manifest_accepts[record.manifest_uid].push_back(index);
    fold.source_manifests[record.source_uid].push_back(index);
  }
  for (size_t index = 0; index < records.entries.size(); ++index) {
    const auto &record = records.entries[index];
    fold.manifest_entries[record.manifest_uid][record.entry_index].push_back(index);
  }
  return fold;
}

// Entry records of the LATEST acceptance of one manifest: a re-accept of the
// same manifest id appends a fresh header plus fresh entry records, so the
// current view keeps the last complete set per entry index.
std::vector<const ManifestEntryRecorded *> latest_entry_records(const catalog_fold &fold, uint64_t manifest_uid,
                                                                uint64_t entry_count) {
  std::vector<const ManifestEntryRecorded *> result;
  const auto iter = fold.manifest_entries.find(manifest_uid);
  if (iter == fold.manifest_entries.end()) {
    return result;
  }
  for (uint64_t index = 0; index < entry_count; ++index) {
    const auto entry_iter = iter->second.find(index);
    if (entry_iter == iter->second.end() || entry_iter->second.empty()) {
      continue;
    }
    result.push_back(&fold.records.entries[entry_iter->second.back()]);
  }
  return result;
}

const ImportManifestAccepted *latest_manifest_record(const catalog_fold &fold, uint64_t source_uid) {
  const auto iter = fold.source_manifests.find(source_uid);
  if (iter == fold.source_manifests.end() || iter->second.empty()) {
    return nullptr;
  }
  return &fold.records.manifests[iter->second.back()];
}

nlohmann::json load_entries_document(const ImportManifestAccepted &record, content_store &store) {
  const auto text = fixed_string(record.entries_hash);
  const auto hash = text.find(':') != std::string::npos ? parse_content_hash(text) : make_content_hash(text);
  auto result = store.get(MANIFEST_ENTRIES_CONTENT_NAMESPACE, hash);
  if (!result.ok()) {
    throw std::runtime_error("manifest_entries_document_unavailable: " + fixed_string(record.manifest_id) + ": " +
                             content_store_error_name(result.error) +
                             (result.message.empty() ? "" : " (" + result.message + ")"));
  }
  auto entries = nlohmann::json::parse(result.bytes, nullptr, false);
  if (entries.is_discarded() || !entries.is_array()) {
    throw std::runtime_error("manifest_entries_document_invalid: " + fixed_string(record.manifest_id));
  }
  return entries;
}

nlohmann::json source_summary(const catalog_fold &fold, uint64_t source_uid) {
  const auto *latest = latest_manifest_record(fold, source_uid);
  if (latest == nullptr) {
    return nlohmann::json::object();
  }
  size_t export_count = 0;
  for (const auto &receipt : fold.records.exports) {
    if (receipt.source_uid == source_uid) {
      ++export_count;
    }
  }
  return {
      {"source_uid", source_uid},
      {"source_id", fixed_string(latest->source_id)},
      {"source_type", fixed_string(latest->source_type)},
      {"coordinate", fixed_string(latest->source_coordinate)},
      {"manifest_id", fixed_string(latest->manifest_id)},
      {"source_head", fixed_string(latest->source_head)},
      {"accept_time", latest->accept_time},
      {"entry_count", latest->entry_count},
      {"sync_root", sync_root_edge(*latest)},
      {"manifest_count", fold.source_manifests.at(source_uid).size()},
      {"export_count", export_count},
  };
}

} // namespace

std::vector<storage_issue> verify_storage_import_manifest(const nlohmann::json &manifest) {
  std::vector<storage_issue> issues;
  if (!manifest.is_object()) {
    issues.emplace_back(make_issue("manifest_invalid", "$", "manifest must be an object"));
    return issues;
  }
  if (manifest.value("schema", "") != STORAGE_IMPORT_MANIFEST_SCHEMA_V1) {
    issues.emplace_back(make_issue("schema_mismatch", "$.schema", "unexpected storage manifest schema",
                                   STORAGE_IMPORT_MANIFEST_SCHEMA_V1, manifest.value("schema", "")));
  }
  require_string(issues, manifest, "manifest_id", "$");
  require_string(issues, manifest, "source_id", "$");
  const auto entries = array_or_empty(manifest, "entries");
  if (!manifest.contains("entries") || !manifest.at("entries").is_array()) {
    issues.emplace_back(make_issue("manifest_entries_invalid", "$.entries", "entries must be an array"));
  }
  const auto payload_inventory = object_or_empty(manifest, "payload_inventory");
  const auto payload_entries = array_or_empty(payload_inventory, "entries");
  if (!payload_inventory.empty() && payload_entries.size() != entries.size()) {
    issues.emplace_back(make_issue("payload_inventory_mismatch", "$.payload_inventory.entries",
                                   "payload inventory entry count must match manifest entries", entries.size(),
                                   payload_entries.size()));
  }
  const auto accepted_ranges = array_or_empty(manifest, "accepted_ranges");
  if (accepted_ranges.empty()) {
    issues.emplace_back(make_issue("accepted_range_missing", "$.accepted_ranges",
                                   "a storage import manifest must record at least one accepted range"));
  }
  if (manifest.contains("sync_root")) {
    for (const auto &issue :
         verify_linear_sync_root(manifest.at("sync_root"), entries.get<std::vector<nlohmann::json>>())) {
      issues.emplace_back(make_issue(issue.code, issue.field.empty() ? "$.sync_root" : "$.sync_root." + issue.field,
                                     "sync root verification failed", issue.expected, issue.actual));
    }
  } else {
    issues.emplace_back(make_issue("sync_root_missing", "$.sync_root", "sync root is required"));
  }
  return issues;
}

nlohmann::json build_storage_payload_inventory(const nlohmann::json &entries) {
  return payload_inventory_impl(entries);
}

nlohmann::json build_storage_schema_inventory(const nlohmann::json &entries) { return schema_inventory_impl(entries); }

nlohmann::json filter_storage_manifest_entries(const nlohmann::json &entries, const nlohmann::json &range_filter) {
  nlohmann::json filtered = nlohmann::json::array();
  if (!entries.is_array()) {
    return filtered;
  }
  for (const auto &entry : entries) {
    if (entry.is_object() && matches_time_range(entry, range_filter)) {
      filtered.push_back(entry);
    }
  }
  return filtered;
}

nlohmann::json build_storage_export_bundle(const nlohmann::json &manifest, const nlohmann::json &records) {
  const auto manifest_id = text_or(manifest, "manifest_id");
  const auto source_id = text_or(manifest, "source_id");
  nlohmann::json payload_inventory = object_or_empty(manifest, "payload_inventory");
  if (records.is_array()) {
    payload_inventory["exported_records"] = records.size();
  }
  return {
      {"schema", STORAGE_EXPORT_BUNDLE_SCHEMA_V1},
      {"bundle_id", source_id + ":" + manifest_id},
      {"source_id", source_id},
      {"manifest", manifest},
      {"records", records.is_array() ? records : nlohmann::json::array()},
      {"payload_inventory", payload_inventory},
      {"schema_inventory", object_or_empty(manifest, "schema_inventory")},
      {"accepted_ranges", array_or_empty(manifest, "accepted_ranges")},
      {"sync_root", object_or_empty(manifest, "sync_root")},
  };
}

namespace {

nlohmann::json manifest_entry_edge(const manifest_entry_view &entry) {
  nlohmann::json edge = {
      {"kind", entry.kind},
      {"source_id", entry.source_id},
      {"source_path", entry.source_path},
      {"source_time", entry.source_time},
      {"schema_version", entry.schema_version},
      {"content_type", entry.content_type},
      {"payload_hash", entry.payload_hash},
      {"byte_len", entry.byte_len},
      {"payload_state", payload_state_name(entry.payload_state)},
  };
  if (entry.action_json.has_value()) {
    edge["action"] = nlohmann::json::parse(*entry.action_json);
  }
  return edge;
}

manifest_entry_view manifest_entry_from_edge(const nlohmann::json &entry) {
  manifest_entry_view view{};
  view.kind = text_or(entry, "kind");
  view.source_id = text_or(entry, "source_id");
  view.source_path = text_or(entry, "source_path");
  view.source_time = text_or(entry, "source_time");
  view.schema_version = entry.value("schema_version", uint32_t{0});
  view.content_type = text_or(entry, "content_type");
  view.payload_hash = text_or(entry, "payload_hash");
  view.byte_len = entry.value("byte_len", uint64_t{0});
  view.payload_state = payload_state_from_text(text_or(entry, "payload_state", "missing"));
  if (entry.contains("action") && entry.at("action").is_object()) {
    view.action_json = canonical_json(entry.at("action"));
  }
  return view;
}

} // namespace

manifest_sync_root_view compute_manifest_sync_root(const std::vector<manifest_entry_view> &entries) {
  std::vector<nlohmann::json> edges;
  edges.reserve(entries.size());
  for (const auto &entry : entries) {
    edges.push_back(manifest_entry_edge(entry));
  }
  const auto root = compute_linear_sync_root(edges);
  return {text_or(root, "algorithm"), text_or(root, "value"), root.value("entry_count", uint64_t{0})};
}

manifest_catalog_store::manifest_catalog_store(std::string runtime_dir) : runtime_dir_(std::move(runtime_dir)) {}

manifest_catalog_journal_records manifest_catalog_store::read_typed_records() const {
  manifest_catalog_journal_records records;
  const auto location = catalog_location(runtime_dir_);
  if (location->locator->list_page_id(location, location::PUBLIC).empty()) {
    return records;
  }
  auto reader = std::make_shared<kungfu::yijinjing::journal::reader>(true, false, std::make_shared<bus>(false));
  reader->join(location, location::PUBLIC, 0);
  while (reader->data_available()) {
    const auto frame = reader->current_frame();
    switch (frame->carrier_type()) {
    case ImportManifestAccepted::tag:
      records.manifests.push_back(frame->data<ImportManifestAccepted>());
      break;
    case ManifestEntryRecorded::tag:
      records.entries.push_back(frame->data<ManifestEntryRecorded>());
      break;
    case ExportBundleRecorded::tag:
      records.exports.push_back(frame->data<ExportBundleRecorded>());
      break;
    case ChannelCursorUpdated::tag:
      records.cursors.push_back(frame->data<ChannelCursorUpdated>());
      break;
    default:
      break;
    }
    reader->next();
  }
  return records;
}

manifest_document_view manifest_catalog_store::accept_manifest_typed(const manifest_document_view &input,
                                                                     content_store &store) const {
  if (input.manifest_id.empty()) {
    throw std::invalid_argument("storage_manifest_invalid: missing_field: manifest_id");
  }
  const auto source_id = input.source_id.empty() ? std::string("local") : input.source_id;
  const auto source_type = input.source_type.empty() ? std::string("local") : input.source_type;
  const auto scope = input.scope.empty() ? source_type : input.scope;
  const auto sync_root = compute_manifest_sync_root(input.entries);
  if (!input.sync_root.value.empty() &&
      (input.sync_root.algorithm != sync_root.algorithm || input.sync_root.value != sync_root.value ||
       input.sync_root.entry_count != sync_root.entry_count)) {
    throw std::invalid_argument("storage_manifest_invalid: sync_root_mismatch: value");
  }

  nlohmann::json entries = nlohmann::json::array();
  for (const auto &entry : input.entries) {
    entries.push_back(manifest_entry_edge(entry));
  }
  const auto entries_document = canonical_json(entries);
  const auto put = store.put_if_absent(MANIFEST_ENTRIES_CONTENT_NAMESPACE, entries_document);
  if (!put.ok()) {
    throw std::runtime_error("manifest_entries_document_rejected: " + std::string(content_store_error_name(put.error)) +
                             (put.message.empty() ? "" : " (" + put.message + ")"));
  }

  const auto location_uid = catalog_location(runtime_dir_)->uid;
  const auto accept_time = time::now_in_nano();
  ImportManifestAccepted record{};
  record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  record.manifest_uid = manifest_uid_of(source_id, input.manifest_id);
  record.source_uid = uid_of(source_id);
  record.location_uid = location_uid;
  record.accept_time = accept_time;
  record.entry_count = input.entries.size();
  record.entries_byte_len = entries_document.size();
  record.status = SourceVerificationStatus::Ok;
  set_checked_string(record.scope, scope, "scope");
  set_checked_string(record.source_type, source_type, "source_type");
  set_checked_string(record.source_id, source_id, "source_id");
  set_checked_string(record.manifest_id, input.manifest_id, "manifest_id");
  set_checked_string(record.source_head, input.source_head, "source_head");
  set_checked_string(record.source_coordinate, input.source_coordinate, "source_coordinate");
  set_checked_string(record.range_since, input.range_since, "range.since");
  set_checked_string(record.range_until, input.range_until, "range.until");
  set_checked_string(record.sync_root_algo, sync_root.algorithm, "sync_root.algorithm");
  set_checked_string(record.sync_root_value, sync_root.value, "sync_root.value");
  set_checked_string(record.entries_hash, format_content_hash(put.hash), "entries_hash");

  std::vector<ManifestEntryRecorded> entry_records;
  entry_records.reserve(input.entries.size());
  for (size_t index = 0; index < input.entries.size(); ++index) {
    const auto &entry = input.entries[index];
    ManifestEntryRecorded entry_record{};
    entry_record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
    entry_record.manifest_uid = record.manifest_uid;
    entry_record.source_uid = record.source_uid;
    entry_record.entry_index = index;
    entry_record.location_uid = location_uid;
    entry_record.accept_time = accept_time;
    entry_record.entry_schema_version = entry.schema_version;
    entry_record.byte_len = entry.byte_len;
    entry_record.payload_state = entry.payload_state;
    set_checked_string(entry_record.kind, entry.kind, "entry.kind");
    set_checked_string(entry_record.entry_source_id, entry.source_id, "entry.source_id");
    set_checked_string(entry_record.source_path, entry.source_path, "entry.source_path");
    set_checked_string(entry_record.source_time, entry.source_time, "entry.source_time");
    set_checked_string(entry_record.content_type, entry.content_type, "entry.content_type");
    set_checked_string(entry_record.payload_hash, entry.payload_hash, "entry.payload_hash");
    set_checked_string(entry_record.commitment_hash, sync_root_entry_leaf_hash(manifest_entry_edge(entry)),
                       "entry.commitment_hash");
    entry_records.push_back(entry_record);
  }

  ChannelCursorUpdated cursor{};
  cursor.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  cursor.channel_uid = channel_uid_of(source_id);
  cursor.source_uid = record.source_uid;
  cursor.manifest_uid = record.manifest_uid;
  cursor.location_uid = location_uid;
  cursor.update_time = accept_time;
  cursor.entry_count = record.entry_count;
  set_fixed_string(cursor.source_id, source_id);
  set_fixed_string(cursor.manifest_id, input.manifest_id);
  cursor.source_head = record.source_head;
  cursor.range_since = record.range_since;
  cursor.range_until = record.range_until;
  cursor.sync_root_algo = record.sync_root_algo;
  cursor.sync_root_value = record.sync_root_value;

  auto writer = make_writer(runtime_dir_);
  writer.write_at(accept_time, 0, record);
  for (const auto &entry_record : entry_records) {
    writer.write_at(accept_time, 0, entry_record);
  }
  writer.write_at(accept_time, 0, cursor);

  auto accepted = input;
  accepted.source_id = source_id;
  accepted.source_type = source_type;
  accepted.scope = scope;
  accepted.sync_root = sync_root;
  return accepted;
}

std::optional<manifest_document_view> manifest_catalog_store::latest_manifest_typed(const std::string &source_id,
                                                                                    content_store &store) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto fold = fold_catalog(read_typed_records());
  const auto *record = latest_manifest_record(fold, uid_of(source_id));
  if (record == nullptr) {
    return std::nullopt;
  }
  manifest_document_view view{};
  view.manifest_id = fixed_string(record->manifest_id);
  view.scope = fixed_string(record->scope);
  view.source_id = fixed_string(record->source_id);
  view.source_type = fixed_string(record->source_type);
  view.source_coordinate = fixed_string(record->source_coordinate);
  view.source_head = fixed_string(record->source_head);
  view.range_since = fixed_string(record->range_since);
  view.range_until = fixed_string(record->range_until);
  for (const auto &entry : load_entries_document(*record, store)) {
    view.entries.push_back(manifest_entry_from_edge(entry));
  }
  view.sync_root = {fixed_string(record->sync_root_algo), fixed_string(record->sync_root_value), record->entry_count};
  return view;
}

void manifest_catalog_store::record_export_typed(const manifest_document_view &manifest, uint64_t exported_records,
                                                 const std::string &range_since, const std::string &range_until) const {
  if (manifest.source_id.empty() || manifest.manifest_id.empty()) {
    throw std::invalid_argument("storage_export_invalid: manifest identity is required");
  }
  const auto export_time = time::now_in_nano();
  ExportBundleRecorded record{};
  record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  record.bundle_uid = uid_of(manifest.source_id + ":" + manifest.manifest_id);
  record.manifest_uid = manifest_uid_of(manifest.source_id, manifest.manifest_id);
  record.source_uid = uid_of(manifest.source_id);
  record.location_uid = catalog_location(runtime_dir_)->uid;
  record.export_time = export_time;
  record.exported_records = exported_records;
  record.entry_count = manifest.entries.size();
  set_checked_string(record.source_id, manifest.source_id, "source_id");
  set_checked_string(record.manifest_id, manifest.manifest_id, "manifest_id");
  set_checked_string(record.range_since, range_since, "range.since");
  set_checked_string(record.range_until, range_until, "range.until");
  set_checked_string(record.sync_root_algo, manifest.sync_root.algorithm, "sync_root.algorithm");
  set_checked_string(record.sync_root_value, manifest.sync_root.value, "sync_root.value");
  auto writer = make_writer(runtime_dir_);
  writer.write_at(export_time, 0, record);
}

nlohmann::json manifest_catalog_store::accept_manifest(const nlohmann::json &input, content_store &store) const {
  if (!input.is_object()) {
    throw std::invalid_argument("storage_manifest_invalid: manifest_invalid");
  }
  const auto manifest_id = manifest_id_for(input);
  if (manifest_id.empty()) {
    throw std::invalid_argument("storage_manifest_invalid: missing_field: manifest_id");
  }
  const auto source_id = source_id_for(input);
  if (input.contains("entries") && !input.at("entries").is_array()) {
    throw std::invalid_argument("storage_manifest_invalid: manifest_entries_invalid");
  }
  nlohmann::json entries = array_or_empty(input, "entries");
  for (const auto &entry : entries) {
    if (!entry.is_object()) {
      throw std::invalid_argument("storage_manifest_invalid: manifest_entries_invalid");
    }
  }

  const auto entry_vector = entries.get<std::vector<nlohmann::json>>();
  const auto sync_root = compute_linear_sync_root(entry_vector);
  if (input.contains("sync_root") && input.at("sync_root").is_object() && !input.at("sync_root").empty()) {
    const auto issues = verify_linear_sync_root(input.at("sync_root"), entry_vector);
    if (!issues.empty()) {
      throw std::invalid_argument("storage_manifest_invalid: sync_root_mismatch: " + issues.front().field);
    }
  }

  // Commit the canonical entries document; the header record commits to it by
  // content hash so the JSON edge stays byte-reproducible across stores.
  const auto entries_document = canonical_json(entries);
  const auto put = store.put_if_absent(MANIFEST_ENTRIES_CONTENT_NAMESPACE, entries_document);
  if (!put.ok()) {
    throw std::runtime_error("manifest_entries_document_rejected: " + std::string(content_store_error_name(put.error)) +
                             (put.message.empty() ? "" : " (" + put.message + ")"));
  }

  const auto range = object_or_empty(input, "range");
  const auto location_uid = catalog_location(runtime_dir_)->uid;
  const auto accept_time = time::now_in_nano();

  ImportManifestAccepted record{};
  record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  record.manifest_uid = manifest_uid_of(source_id, manifest_id);
  record.source_uid = uid_of(source_id);
  record.location_uid = location_uid;
  record.accept_time = accept_time;
  record.entry_count = entry_vector.size();
  record.entries_byte_len = entries_document.size();
  record.status = SourceVerificationStatus::Ok;
  set_checked_string(record.scope, text_or(input, "scope", source_type_for(input)), "scope");
  set_checked_string(record.source_type, source_type_for(input), "source_type");
  set_checked_string(record.source_id, source_id, "source_id");
  set_checked_string(record.manifest_id, manifest_id, "manifest_id");
  set_checked_string(record.source_head, source_head_for(input), "source_head");
  set_checked_string(record.source_coordinate, source_coordinate_for(input), "source_coordinate");
  set_checked_string(record.range_since, text_or(range, "since"), "range.since");
  set_checked_string(record.range_until, text_or(range, "until"), "range.until");
  set_checked_string(record.sync_root_algo, sync_root.value("algorithm", CONTENT_HASH_ALGORITHM_SHA256),
                     "sync_root.algorithm");
  set_checked_string(record.sync_root_value, sync_root.value("value", ""), "sync_root.value");
  set_checked_string(record.entries_hash, format_content_hash(put.hash), "entries_hash");

  std::vector<ManifestEntryRecorded> entry_records;
  entry_records.reserve(entry_vector.size());
  for (size_t index = 0; index < entry_vector.size(); ++index) {
    const auto &entry = entry_vector[index];
    ManifestEntryRecorded entry_record{};
    entry_record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
    entry_record.manifest_uid = record.manifest_uid;
    entry_record.source_uid = record.source_uid;
    entry_record.entry_index = index;
    entry_record.location_uid = location_uid;
    entry_record.accept_time = accept_time;
    entry_record.entry_schema_version = entry.value("schema_version", 0);
    entry_record.byte_len = entry.value("byte_len", uint64_t{0});
    entry_record.payload_state = payload_state_from_text(text_or(entry, "payload_state", "missing"));
    set_checked_string(entry_record.kind, text_or(entry, "kind"), "entry.kind");
    set_checked_string(entry_record.entry_source_id, text_or(entry, "source_id"), "entry.source_id");
    set_checked_string(entry_record.source_path, text_or(entry, "source_path"), "entry.source_path");
    set_checked_string(entry_record.source_time, text_or(entry, "source_time"), "entry.source_time");
    set_checked_string(entry_record.content_type, text_or(entry, "content_type"), "entry.content_type");
    set_checked_string(entry_record.payload_hash, text_or(entry, "payload_hash"), "entry.payload_hash");
    set_checked_string(entry_record.commitment_hash, sync_root_entry_leaf_hash(entry), "entry.commitment_hash");
    entry_records.push_back(entry_record);
  }

  ChannelCursorUpdated cursor{};
  cursor.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  cursor.channel_uid = channel_uid_of(source_id);
  cursor.source_uid = record.source_uid;
  cursor.manifest_uid = record.manifest_uid;
  cursor.location_uid = location_uid;
  cursor.update_time = accept_time;
  cursor.entry_count = record.entry_count;
  set_fixed_string(cursor.source_id, source_id);
  set_fixed_string(cursor.manifest_id, manifest_id);
  cursor.source_head = record.source_head;
  cursor.range_since = record.range_since;
  cursor.range_until = record.range_until;
  cursor.sync_root_algo = record.sync_root_algo;
  cursor.sync_root_value = record.sync_root_value;

  auto writer = make_writer(runtime_dir_);
  writer.write_at(accept_time, 0, record);
  for (const auto &entry_record : entry_records) {
    writer.write_at(accept_time, 0, entry_record);
  }
  writer.write_at(accept_time, 0, cursor);

  return manifest_edge(record, entries);
}

nlohmann::json manifest_catalog_store::record_export(const nlohmann::json &manifest, uint64_t exported_records,
                                                     const nlohmann::json &range_filter) const {
  const auto source_id = text_or(manifest, "source_id");
  const auto manifest_id = text_or(manifest, "manifest_id");
  if (source_id.empty() || manifest_id.empty()) {
    throw std::invalid_argument("storage_export_invalid: manifest identity is required");
  }
  const auto sync_root = object_or_empty(manifest, "sync_root");
  const auto export_time = time::now_in_nano();

  ExportBundleRecorded record{};
  record.schema_version = MANIFEST_CATALOG_SCHEMA_VERSION;
  record.bundle_uid = uid_of(source_id + ":" + manifest_id);
  record.manifest_uid = manifest_uid_of(source_id, manifest_id);
  record.source_uid = uid_of(source_id);
  record.location_uid = catalog_location(runtime_dir_)->uid;
  record.export_time = export_time;
  record.exported_records = exported_records;
  record.entry_count = array_or_empty(manifest, "entries").size();
  set_checked_string(record.source_id, source_id, "source_id");
  set_checked_string(record.manifest_id, manifest_id, "manifest_id");
  set_checked_string(record.range_since, text_or(range_filter, "since"), "range.since");
  set_checked_string(record.range_until, text_or(range_filter, "until"), "range.until");
  set_checked_string(record.sync_root_algo, text_or(sync_root, "algorithm"), "sync_root.algorithm");
  set_checked_string(record.sync_root_value, text_or(sync_root, "value"), "sync_root.value");

  auto writer = make_writer(runtime_dir_);
  writer.write_at(export_time, 0, record);

  return {
      {"schema", MANIFEST_CATALOG_SCHEMA_V1},
      {"record_kind", "export_bundle_recorded"},
      {"authority", "yijinjing-journal"},
      {"bundle_id", source_id + ":" + manifest_id},
      {"source_id", source_id},
      {"manifest_id", manifest_id},
      {"export_time", export_time},
      {"exported_records", exported_records},
      {"entry_count", record.entry_count},
      {"range", range_edge(text_or(range_filter, "since"), text_or(range_filter, "until"))},
  };
}

nlohmann::json manifest_catalog_store::latest_manifest(const std::string &source_id, content_store &store) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto fold = fold_catalog(read_typed_records());
  const auto *record = latest_manifest_record(fold, uid_of(source_id));
  if (record == nullptr) {
    return nullptr;
  }
  return manifest_edge(*record, load_entries_document(*record, store));
}

nlohmann::json manifest_catalog_store::list() const {
  const auto fold = fold_catalog(read_typed_records());
  nlohmann::json sources = nlohmann::json::array();
  for (const auto &[source_uid, indices] : fold.source_manifests) {
    const auto summary = source_summary(fold, source_uid);
    if (!summary.empty()) {
      sources.push_back(summary);
    }
  }
  return {{"ok", true},
          {"schema", MANIFEST_CATALOG_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"sources", sources},
          {"source_count", sources.size()}};
}

nlohmann::json manifest_catalog_store::inspect(const std::string &source_id) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto fold = fold_catalog(read_typed_records());
  const auto source_uid = uid_of(source_id);
  const auto summary = source_summary(fold, source_uid);
  if (summary.empty()) {
    return {{"ok", false},
            {"schema", MANIFEST_CATALOG_SCHEMA_V1},
            {"source_id", source_id},
            {"errors", nlohmann::json::array({{{"code", "source_missing"}, {"source_id", source_id}}})}};
  }
  nlohmann::json manifests = nlohmann::json::array();
  for (const auto index : fold.source_manifests.at(source_uid)) {
    const auto &record = fold.records.manifests[index];
    manifests.push_back({
        {"manifest_id", fixed_string(record.manifest_id)},
        {"accept_time", record.accept_time},
        {"entry_count", record.entry_count},
        {"entries_hash", fixed_string(record.entries_hash)},
        {"sync_root", sync_root_edge(record)},
        {"status", verification_status_name(record.status)},
    });
  }
  nlohmann::json exports = nlohmann::json::array();
  for (const auto &receipt : fold.records.exports) {
    if (receipt.source_uid != source_uid) {
      continue;
    }
    exports.push_back({
        {"manifest_id", fixed_string(receipt.manifest_id)},
        {"export_time", receipt.export_time},
        {"exported_records", receipt.exported_records},
        {"entry_count", receipt.entry_count},
        {"range", range_edge(fixed_string(receipt.range_since), fixed_string(receipt.range_until))},
    });
  }
  nlohmann::json cursors = nlohmann::json::array();
  for (const auto &cursor : fold.records.cursors) {
    if (cursor.source_uid == source_uid) {
      cursors.push_back(cursor_edge(cursor));
    }
  }
  return {{"ok", true},
          {"schema", MANIFEST_CATALOG_SCHEMA_V1},
          {"runtime_dir", runtime_dir_},
          {"authority", "yijinjing-journal"},
          {"source", summary},
          {"manifests", manifests},
          {"exports", exports},
          {"cursors", cursors}};
}

nlohmann::json manifest_catalog_store::latest_cursor(const std::string &source_id) const {
  if (source_id.empty()) {
    throw std::invalid_argument("source_id is required");
  }
  const auto records = read_typed_records();
  const auto source_uid = uid_of(source_id);
  const ChannelCursorUpdated *latest = nullptr;
  for (const auto &cursor : records.cursors) {
    if (cursor.source_uid == source_uid) {
      latest = &cursor;
    }
  }
  if (latest == nullptr) {
    return nullptr;
  }
  return cursor_edge(*latest);
}

std::vector<std::string> manifest_catalog_store::referenced_payload_hashes(const std::string &source_id) const {
  const auto records = read_typed_records();
  const auto filter_uid = source_id.empty() ? uint64_t{0} : uid_of(source_id);
  std::vector<std::string> hashes;
  for (const auto &entry : records.entries) {
    if (filter_uid != 0 && entry.source_uid != filter_uid) {
      continue;
    }
    auto digest = fixed_string(entry.payload_hash);
    if (!digest.empty() && std::find(hashes.begin(), hashes.end(), digest) == hashes.end()) {
      hashes.push_back(std::move(digest));
    }
  }
  return hashes;
}

manifest_catalog_fsck_result manifest_catalog_store::fsck_typed(const std::string &source_id,
                                                                content_store &store) const {
  const auto fold = fold_catalog(read_typed_records());
  const auto filter_uid = source_id.empty() ? uint64_t{0} : uid_of(source_id);
  manifest_catalog_fsck_result result{};
  result.runtime_dir = runtime_dir_;
  result.exports = static_cast<uint64_t>(fold.records.exports.size());
  result.cursors = static_cast<uint64_t>(fold.records.cursors.size());
  const auto issue_for = [](std::string code, const std::string &current_source_id, const std::string &manifest_id) {
    manifest_catalog_fsck_issue issue{};
    issue.code = std::move(code);
    issue.source_id = current_source_id;
    issue.manifest_id = manifest_id;
    return issue;
  };

  // The current view is each source's latest accepted manifest; superseded
  // acceptances are history and do not degrade current health.
  for (const auto &[source_uid, manifest_indices] : fold.source_manifests) {
    if (filter_uid != 0 && source_uid != filter_uid) {
      continue;
    }
    const auto &latest = fold.records.manifests[manifest_indices.back()];
    const auto manifest_uid = latest.manifest_uid;
    ++result.manifests;
    const auto manifest_id = fixed_string(latest.manifest_id);
    const auto current_source_id = fixed_string(latest.source_id);

    // Fold consistency: one delta record per entry index of the latest accept.
    const auto entry_records = latest_entry_records(fold, manifest_uid, latest.entry_count);
    result.manifest_entries += static_cast<uint64_t>(entry_records.size());
    if (entry_records.size() != latest.entry_count) {
      auto issue = issue_for("manifest_entry_count_mismatch", current_source_id, manifest_id);
      issue.expected = latest.entry_count;
      issue.actual = static_cast<uint64_t>(entry_records.size());
      result.errors.push_back(std::move(issue));
      continue;
    }

    // The sync-root chain recomputed from the recorded leaf hashes alone.
    std::vector<std::string> leaves;
    leaves.reserve(entry_records.size());
    for (const auto *entry_record : entry_records) {
      leaves.push_back(fixed_string(entry_record->commitment_hash));
    }
    const auto recomputed = compute_linear_sync_root_from_leaves(leaves);
    if (recomputed.value("value", "") != fixed_string(latest.sync_root_value)) {
      auto issue = issue_for("sync_root_mismatch", current_source_id, manifest_id);
      issue.expected_text = fixed_string(latest.sync_root_value);
      issue.actual_text = recomputed.value("value", "");
      result.errors.push_back(std::move(issue));
    }

    // The committed entries document, cross-checked field by field.
    ++result.entries_documents;
    nlohmann::json entries = nullptr;
    try {
      entries = load_entries_document(latest, store);
    } catch (const std::exception &e) {
      auto issue = issue_for("entries_document_unavailable", current_source_id, manifest_id);
      issue.error = e.what();
      result.errors.push_back(std::move(issue));
    }
    if (entries.is_array()) {
      if (entries.size() != latest.entry_count) {
        auto issue = issue_for("entries_document_mismatch", current_source_id, manifest_id);
        issue.expected = latest.entry_count;
        issue.actual = static_cast<uint64_t>(entries.size());
        result.errors.push_back(std::move(issue));
      } else {
        for (size_t index = 0; index < entry_records.size(); ++index) {
          const auto &entry = entries.at(index);
          const auto *entry_record = entry_records[index];
          const bool fields_match =
              fixed_string(entry_record->kind) == text_or(entry, "kind") &&
              fixed_string(entry_record->entry_source_id) == text_or(entry, "source_id") &&
              fixed_string(entry_record->source_path) == text_or(entry, "source_path") &&
              fixed_string(entry_record->source_time) == text_or(entry, "source_time") &&
              fixed_string(entry_record->content_type) == text_or(entry, "content_type") &&
              fixed_string(entry_record->payload_hash) == text_or(entry, "payload_hash") &&
              entry_record->byte_len == entry.value("byte_len", uint64_t{0}) &&
              payload_state_name(entry_record->payload_state) == text_or(entry, "payload_state", "missing");
          if (!fields_match) {
            auto issue = issue_for("manifest_entry_drift", current_source_id, manifest_id);
            issue.entry_index = index;
            result.errors.push_back(std::move(issue));
          }
          if (sync_root_entry_leaf_hash(entry) != fixed_string(entry_record->commitment_hash)) {
            auto issue = issue_for("entry_commitment_mismatch", current_source_id, manifest_id);
            issue.entry_index = index;
            result.errors.push_back(std::move(issue));
          }
        }
      }
    }

    // Payload references through the KF-ADR-019f86da-4f90-738c-b372-e509976f69ff content store.
    for (const auto *entry_record : entry_records) {
      ++result.payloads;
      const auto state = entry_record->payload_state;
      const auto digest = fixed_string(entry_record->payload_hash);
      if (state != PayloadState::Present) {
        const bool intentional = state == PayloadState::Redacted || state == PayloadState::Absent;
        if (!intentional) {
          result.degraded = true;
        }
        auto issue = issue_for("payload_not_present", current_source_id, manifest_id);
        issue.manifest_id.reset();
        issue.subject = fixed_string(entry_record->kind) + ":" + fixed_string(entry_record->entry_source_id);
        issue.payload_hash = digest;
        issue.state = payload_state_name(state);
        issue.intentional = intentional;
        result.warnings.push_back(std::move(issue));
        continue;
      }
      if (digest.empty()) {
        auto issue = issue_for("payload_missing", current_source_id, manifest_id);
        issue.manifest_id.reset();
        issue.kind = fixed_string(entry_record->kind);
        issue.entry_source_id = fixed_string(entry_record->entry_source_id);
        issue.payload_hash = digest;
        result.errors.push_back(std::move(issue));
        continue;
      }
      const auto verified = store.verify("payloads", make_content_hash(digest));
      if (!verified.ok()) {
        auto issue = issue_for(verified.error == content_store_error::NotFound ? "payload_missing" : "hash_mismatch",
                               current_source_id, manifest_id);
        issue.manifest_id.reset();
        issue.kind = fixed_string(entry_record->kind);
        issue.entry_source_id = fixed_string(entry_record->entry_source_id);
        issue.payload_hash = digest;
        result.errors.push_back(std::move(issue));
      } else if (verified.byte_length != entry_record->byte_len) {
        auto issue = issue_for("byte_len_mismatch", current_source_id, manifest_id);
        issue.manifest_id.reset();
        issue.kind = fixed_string(entry_record->kind);
        issue.entry_source_id = fixed_string(entry_record->entry_source_id);
        issue.payload_hash = digest;
        issue.expected = entry_record->byte_len;
        issue.actual = verified.byte_length;
        result.errors.push_back(std::move(issue));
      }
    }
  }

  // Dangling producer output is honest degradation, recorded, never dropped.
  for (const auto &[manifest_uid, by_index] : fold.manifest_entries) {
    if (fold.manifest_accepts.contains(manifest_uid)) {
      continue;
    }
    if (filter_uid != 0 && !by_index.empty() &&
        fold.records.entries[by_index.begin()->second.front()].source_uid != filter_uid) {
      continue;
    }
    manifest_catalog_fsck_issue issue{};
    issue.code = "manifest_header_missing";
    issue.manifest_uid = manifest_uid;
    result.errors.push_back(std::move(issue));
  }
  for (const auto &receipt : fold.records.exports) {
    if (filter_uid != 0 && receipt.source_uid != filter_uid) {
      continue;
    }
    if (!fold.manifest_accepts.contains(receipt.manifest_uid)) {
      result.warnings.push_back(
          issue_for("export_manifest_unknown", fixed_string(receipt.source_id), fixed_string(receipt.manifest_id)));
    }
  }
  for (const auto &cursor : fold.records.cursors) {
    if (filter_uid != 0 && cursor.source_uid != filter_uid) {
      continue;
    }
    if (!fold.manifest_accepts.contains(cursor.manifest_uid)) {
      result.warnings.push_back(
          issue_for("cursor_manifest_unknown", fixed_string(cursor.source_id), fixed_string(cursor.manifest_id)));
    }
  }
  if (filter_uid != 0 && result.manifests == 0) {
    manifest_catalog_fsck_issue issue{};
    issue.code = "source_missing";
    issue.source_id = source_id;
    result.errors.push_back(std::move(issue));
  }

  result.ok = result.errors.empty();
  result.status = !result.ok ? "failed" : (result.degraded ? "degraded" : "ok");
  return result;
}

nlohmann::json manifest_catalog_store::fsck(const std::string &source_id, content_store &store) const {
  const auto result = fsck_typed(source_id, store);
  const auto render_issue = [](const manifest_catalog_fsck_issue &issue) {
    nlohmann::json row = {{"code", issue.code}};
    if (issue.source_id.has_value()) {
      row["source_id"] = *issue.source_id;
    }
    if (issue.manifest_id.has_value()) {
      row["manifest_id"] = *issue.manifest_id;
    }
    if (issue.error.has_value()) {
      row["error"] = *issue.error;
    }
    if (issue.subject.has_value()) {
      row["subject"] = *issue.subject;
    }
    if (issue.payload_hash.has_value()) {
      row["payload_hash"] = *issue.payload_hash;
    }
    if (issue.state.has_value()) {
      row["state"] = *issue.state;
    }
    if (issue.kind.has_value()) {
      row["kind"] = *issue.kind;
    }
    if (issue.entry_source_id.has_value()) {
      row["entry_source_id"] = *issue.entry_source_id;
    }
    if (issue.manifest_uid.has_value()) {
      row["manifest_uid"] = *issue.manifest_uid;
    }
    if (issue.entry_index.has_value()) {
      row["entry_index"] = *issue.entry_index;
    }
    if (issue.expected.has_value()) {
      row["expected"] = *issue.expected;
    } else if (issue.expected_text.has_value()) {
      row["expected"] = *issue.expected_text;
    }
    if (issue.actual.has_value()) {
      row["actual"] = *issue.actual;
    } else if (issue.actual_text.has_value()) {
      row["actual"] = *issue.actual_text;
    }
    if (issue.intentional.has_value()) {
      row["intentional"] = *issue.intentional;
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
          {"degraded", result.degraded},
          {"schema", result.schema},
          {"runtime_dir", result.runtime_dir},
          {"authority", result.authority},
          {"errors", std::move(errors)},
          {"warnings", std::move(warnings)},
          {"checked",
           {{"manifests", result.manifests},
            {"manifest_entries", result.manifest_entries},
            {"payloads", result.payloads},
            {"entries_documents", result.entries_documents},
            {"exports", result.exports},
            {"cursors", result.cursors}}}};
}

} // namespace kungfu::yijinjing::storage
