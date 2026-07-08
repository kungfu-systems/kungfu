// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/storage/generic_service.h>

#include <algorithm>
#include <string>

#include <kungfu/yijinjing/storage/content_hash.h>
#include <kungfu/yijinjing/storage/sync_root.h>

namespace kungfu::yijinjing::storage {

namespace {

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

nlohmann::json build_payload_inventory(const nlohmann::json &entries) {
  nlohmann::json payloads = nlohmann::json::array();
  if (!entries.is_array()) {
    return {
        {"schema", STORAGE_PAYLOAD_INVENTORY_SCHEMA_V1},
        {"algorithm", CONTENT_HASH_ALGORITHM_SHA256},
        {"entries", payloads},
    };
  }
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
  return {
      {"schema", STORAGE_PAYLOAD_INVENTORY_SCHEMA_V1},
      {"algorithm", CONTENT_HASH_ALGORITHM_SHA256},
      {"entries", payloads},
  };
}

nlohmann::json build_schema_inventory(const nlohmann::json &entries) {
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

nlohmann::json build_accepted_range(const nlohmann::json &input, const nlohmann::json &sync_root, size_t entry_count) {
  const auto manifest_id = manifest_id_for(input);
  return {
      {"schema", STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
      {"source_id", source_id_for(input)},
      {"manifest_id", manifest_id},
      {"range", object_or_empty(input, "range")},
      {"source_head", source_head_for(input)},
      {"sync_root", sync_root},
      {"entry_count", entry_count},
      {"status", "ok"},
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

} // namespace

nlohmann::json build_storage_source_record(const nlohmann::json &input) {
  const auto accepted_ranges = array_or_empty(input, "accepted_ranges");
  auto current_head = object_or_empty(input, "current_head");
  if (current_head.empty()) {
    current_head = {
        {"head", source_head_for(input)},
        {"range", object_or_empty(input, "range")},
        {"inventory_hash", object_or_empty(input, "sync_root").value("value", "")},
    };
  }
  return {
      {"schema", STORAGE_SOURCE_RECORD_SCHEMA_V1},
      {"source_id", source_id_for(input)},
      {"type", source_type_for(input)},
      {"kind", text_or(input, "kind", source_type_for(input) == "atlas" ? "adapter" : "local")},
      {"coordinate", source_coordinate_for(input)},
      {"current_head", current_head},
      {"accepted_ranges", accepted_ranges},
      {"last_manifest_id", manifest_id_for(input)},
      {"updated_at", text_or(input, "updated_at")},
  };
}

nlohmann::json build_storage_import_manifest(const nlohmann::json &input) {
  const auto entries = array_or_empty(input, "entries");
  const auto sync_root = input.contains("sync_root") && input.at("sync_root").is_object()
                             ? input.at("sync_root")
                             : compute_linear_sync_root(entries.get<std::vector<nlohmann::json>>());
  const auto accepted_range = build_accepted_range(input, sync_root, entries.size());
  const auto payload_inventory = build_payload_inventory(entries);
  const auto schema_inventory = build_schema_inventory(entries);
  nlohmann::json source_input = input;
  source_input["accepted_ranges"] = nlohmann::json::array({accepted_range});
  source_input["sync_root"] = sync_root;
  const auto source_record = build_storage_source_record(source_input);

  return {
      {"schema", STORAGE_IMPORT_MANIFEST_SCHEMA_V1},
      {"manifest_id", manifest_id_for(input)},
      {"scope", text_or(input, "scope", source_type_for(input))},
      {"source", source_record},
      {"source_id", source_id_for(input)},
      {"source_type", source_type_for(input)},
      {"source_head", source_head_for(input)},
      {"range", object_or_empty(input, "range")},
      {"counts", object_or_empty(input, "counts")},
      {"entries", entries},
      {"payload_inventory", payload_inventory},
      {"schema_inventory", schema_inventory},
      {"accepted_ranges", nlohmann::json::array({accepted_range})},
      {"sync_root", sync_root},
      {"idempotency_key", source_id_for(input) + ":" + manifest_id_for(input)},
  };
}

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

} // namespace kungfu::yijinjing::storage
