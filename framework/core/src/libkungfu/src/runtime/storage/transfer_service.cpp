// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <filesystem>
#include <random>
#include <stdexcept>
#include <utility>

#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>
#include <kungfu/yijinjing/storage/sync_root.h>

namespace kungfu::runtime::storage_service_api::detail {

namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;
namespace fs = std::filesystem;

[[nodiscard]] nlohmann::json render_manifest_document(const yy_storage::manifest_document_view &manifest);

nlohmann::json accept_storage_manifest_impl(const std::string &runtime_dir, const nlohmann::json &input) {
  auto parsed = parse_storage_export_bundle({{"manifest", input}});
  (void)default_storage_service().import_bundle({runtime_dir, {}, std::move(parsed), false});
  const auto provider = provider_cache::instance().acquire(runtime_dir, {});
  const auto source_id = text_or(input, "source_id", text_or(input, "storage_source_id", "local"));
  const auto accepted = catalog_store(runtime_dir).latest_manifest_typed(source_id, provider->content_store());
  if (!accepted.has_value()) {
    throw std::runtime_error("accepted manifest not found");
  }
  return render_manifest_document(*accepted);
}

nlohmann::json render_manifest_entry_view(const yy_storage::manifest_entry_view &entry) {
  nlohmann::json rendered = {{"kind", entry.kind},
                             {"source_id", entry.source_id},
                             {"source_path", entry.source_path},
                             {"source_time", entry.source_time},
                             {"schema_version", entry.schema_version},
                             {"content_type", entry.content_type},
                             {"payload_hash", entry.payload_hash},
                             {"byte_len", entry.byte_len},
                             {"payload_state", payload_state_text(entry.payload_state)}};
  if (entry.action_json.has_value()) {
    rendered["action"] = nlohmann::json::parse(*entry.action_json);
  }
  return rendered;
}

nlohmann::json render_sync_root(const yy_storage::manifest_sync_root_view &root) {
  return {{"schema", yy_storage::SYNC_ROOT_SCHEMA_V1},
          {"scope", yy_storage::SYNC_ROOT_SCOPE_SOURCE_IMPORT_MANIFEST},
          {"proof", yy_storage::SYNC_ROOT_PROOF_LINEAR_CHAIN_V1},
          {"algorithm", root.algorithm},
          {"value", root.value},
          {"entry_count", root.entry_count},
          {"initial", yy_storage::SYNC_ROOT_INITIAL_SHA256},
          {"ordering",
           {{"policy", yy_storage::SYNC_ROOT_ORDERING_POLICY_MANIFEST_ENTRY_SORT_V1},
            {"fields", {"kind", "source_id", "source_path"}}}}};
}

nlohmann::json render_manifest_document(const yy_storage::manifest_document_view &manifest) {
  nlohmann::json entries = nlohmann::json::array();
  for (const auto &entry : manifest.entries) {
    entries.push_back(render_manifest_entry_view(entry));
  }
  auto range = nlohmann::json::object();
  if (!manifest.range_since.empty()) {
    range["since"] = manifest.range_since;
  }
  if (!manifest.range_until.empty()) {
    range["until"] = manifest.range_until;
  }
  const auto sync_root = render_sync_root(manifest.sync_root);
  auto source =
      nlohmann::json{{"schema", yy_storage::STORAGE_SOURCE_RECORD_SCHEMA_V1},
                     {"source_id", manifest.source_id},
                     {"type", manifest.source_type},
                     {"kind", manifest.source_type == "atlas" ? "adapter" : "local"},
                     {"coordinate", manifest.source_coordinate},
                     {"current_head",
                      {{"head", manifest.source_head}, {"range", range}, {"inventory_hash", manifest.sync_root.value}}},
                     {"last_manifest_id", manifest.manifest_id},
                     {"updated_at", ""}};
  auto accepted = nlohmann::json{{"schema", yy_storage::STORAGE_ACCEPTED_RANGE_SCHEMA_V1},
                                 {"source_id", manifest.source_id},
                                 {"manifest_id", manifest.manifest_id},
                                 {"range", range},
                                 {"source_head", manifest.source_head},
                                 {"sync_root", sync_root},
                                 {"entry_count", manifest.entries.size()},
                                 {"status", "ok"}};
  source["accepted_ranges"] = nlohmann::json::array({accepted});
  return {{"schema", yy_storage::STORAGE_IMPORT_MANIFEST_SCHEMA_V1},
          {"authority", "yijinjing-journal"},
          {"manifest_id", manifest.manifest_id},
          {"scope", manifest.scope},
          {"source", source},
          {"source_id", manifest.source_id},
          {"source_type", manifest.source_type},
          {"source_head", manifest.source_head},
          {"range", range},
          {"counts", {{"records", manifest.entries.size()}}},
          {"entries", entries},
          {"payload_inventory", yy_storage::build_storage_payload_inventory(entries)},
          {"schema_inventory", yy_storage::build_storage_schema_inventory(entries)},
          {"accepted_ranges", nlohmann::json::array({accepted})},
          {"sync_root", sync_root},
          {"idempotency_key", manifest.source_id + ":" + manifest.manifest_id}};
}

nlohmann::json render_storage_export_bundle_result(const storage_export_bundle_result &result) {
  const auto manifest = render_manifest_document(result.manifest);
  nlohmann::json records = nlohmann::json::array();
  for (const auto &record : result.records) {
    auto row = render_manifest_entry_view(record.entry);
    row["scope"] = result.manifest.scope;
    row["manifest_id"] = result.manifest.manifest_id;
    row["storage_source_id"] = result.manifest.source_id;
    row["source_type"] = result.manifest.source_type;
    row["source_head"] = result.manifest.source_head;
    row["payload"] =
        record.payload_json.has_value() ? nlohmann::json::parse(*record.payload_json) : nlohmann::json(nullptr);
    records.push_back(std::move(row));
  }
  auto payload_inventory = yy_storage::build_storage_payload_inventory(manifest.at("entries"));
  payload_inventory["exported_records"] = records.size();
  return {{"schema", yy_storage::STORAGE_EXPORT_BUNDLE_SCHEMA_V1},
          {"bundle_id", result.bundle_id},
          {"source_id", result.source_id},
          {"manifest", manifest},
          {"records", records},
          {"payload_inventory", payload_inventory},
          {"schema_inventory", manifest.at("schema_inventory")},
          {"accepted_ranges", manifest.at("accepted_ranges")},
          {"sync_root", manifest.at("sync_root")}};
}

storage_export_bundle_result export_bundle_typed_impl(const storage_export_bundle_request &request) {
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  auto manifest =
      catalog_store(request.runtime_dir).latest_manifest_typed(request.source_id, provider->content_store());
  if (!manifest.has_value()) {
    throw std::runtime_error("manifest not found: " + request.source_id);
  }
  if (!request.range.since.empty() || !request.range.until.empty()) {
    std::vector<yy_storage::manifest_entry_view> filtered;
    for (const auto &entry : manifest->entries) {
      if (entry.source_time.empty()) {
        continue;
      }
      if (!request.range.since.empty() && entry.source_time < request.range.since) {
        continue;
      }
      if (!request.range.until.empty() && entry.source_time > request.range.until) {
        continue;
      }
      filtered.push_back(entry);
    }
    manifest->entries = std::move(filtered);
    manifest->range_since = request.range.since;
    manifest->range_until = request.range.until;
    manifest->sync_root = yy_storage::compute_manifest_sync_root(manifest->entries);
  }

  storage_export_bundle_result result{};
  result.bundle_id = manifest->source_id + ":" + manifest->manifest_id;
  result.source_id = manifest->source_id;
  result.manifest = *manifest;
  for (const auto &entry : manifest->entries) {
    storage_export_record_view record{};
    record.entry = entry;
    const auto withheld = entry.payload_state == yy_enums::PayloadState::Redacted ||
                          entry.payload_state == yy_enums::PayloadState::Absent;
    if (!withheld && !entry.payload_hash.empty() && provider->payload_exists(entry.payload_hash)) {
      const auto raw = provider->read_payload(entry.payload_hash);
      const auto error = yy_storage::verify_payload_ref(raw, entry.payload_hash, entry.byte_len);
      if (error.empty()) {
        record.payload_json = raw;
      } else if (entry.payload_state == yy_enums::PayloadState::Present) {
        throw std::runtime_error(error + ": " + entry.kind + ":" + entry.source_id);
      }
    } else if (!withheld && entry.payload_state == yy_enums::PayloadState::Present) {
      throw std::runtime_error("payload_missing: " + entry.kind + ":" + entry.source_id);
    }
    result.records.push_back(std::move(record));
  }
  std::sort(result.records.begin(), result.records.end(), [](const auto &lhs, const auto &rhs) {
    return std::tie(lhs.entry.kind, lhs.entry.source_id, lhs.entry.source_path) <
           std::tie(rhs.entry.kind, rhs.entry.source_id, rhs.entry.source_path);
  });
  if (request.record_receipt) {
    catalog_store(request.runtime_dir)
        .record_export_typed(result.manifest, result.records.size(), request.range.since, request.range.until);
  }
  return result;
}

nlohmann::json export_bundle_generic_impl(const storage_service_options &options, bool record_receipt) {
  return render_storage_export_bundle_result(
      default_storage_service().export_bundle({options.runtime_dir,
                                               options.provider,
                                               options.source_id,
                                               {text_or(options.range, "since"), text_or(options.range, "until")},
                                               record_receipt}));
}

yy_enums::PayloadState parse_payload_state_text(const std::string &state) {
  if (state == PAYLOAD_STATE_PRESENT) {
    return yy_enums::PayloadState::Present;
  }
  if (state == PAYLOAD_STATE_REDACTED) {
    return yy_enums::PayloadState::Redacted;
  }
  if (state == PAYLOAD_STATE_ABSENT) {
    return yy_enums::PayloadState::Absent;
  }
  return yy_enums::PayloadState::Missing;
}

yy_storage::manifest_entry_view parse_manifest_entry_view(const nlohmann::json &entry) {
  yy_storage::manifest_entry_view parsed{};
  parsed.kind = text_or(entry, "kind");
  parsed.source_id = text_or(entry, "source_id");
  parsed.source_path = text_or(entry, "source_path");
  parsed.source_time = text_or(entry, "source_time");
  parsed.schema_version = entry.value("schema_version", uint32_t{0});
  parsed.content_type = text_or(entry, "content_type");
  parsed.payload_hash = text_or(entry, "payload_hash");
  parsed.byte_len = entry.value("byte_len", uint64_t{0});
  parsed.payload_state = parse_payload_state_text(text_or(entry, "payload_state", "missing"));
  if (entry.contains("action") && entry.at("action").is_object()) {
    parsed.action_json = canonical_json(entry.at("action"));
  }
  return parsed;
}

storage_export_bundle_result parse_storage_export_bundle(const nlohmann::json &bundle) {
  if (!bundle.is_object()) {
    throw std::invalid_argument("bundle_manifest_missing");
  }
  const auto manifest_edge = object_or_empty(bundle, "manifest");
  if (manifest_edge.empty()) {
    throw std::invalid_argument("bundle_manifest_missing");
  }
  storage_export_bundle_result parsed{};
  parsed.bundle_id = text_or(bundle, "bundle_id");
  parsed.source_id = text_or(bundle, "source_id");
  auto &manifest = parsed.manifest;
  manifest.manifest_id = text_or(manifest_edge, "manifest_id");
  manifest.scope = text_or(manifest_edge, "scope");
  manifest.source_id = text_or(manifest_edge, "source_id", text_or(manifest_edge, "storage_source_id", "local"));
  manifest.source_type = text_or(manifest_edge, "source_type");
  manifest.source_head = text_or(manifest_edge, "source_head");
  manifest.source_coordinate =
      text_or(object_or_empty(manifest_edge, "source"), "coordinate", text_or(manifest_edge, "source_coordinate"));
  const auto range = object_or_empty(manifest_edge, "range");
  manifest.range_since = text_or(range, "since");
  manifest.range_until = text_or(range, "until");
  for (const auto &entry : array_or_empty(manifest_edge, "entries")) {
    if (!entry.is_object()) {
      throw std::invalid_argument("bundle_manifest_invalid: manifest_entries_invalid");
    }
    manifest.entries.push_back(parse_manifest_entry_view(entry));
  }
  const auto root = object_or_empty(manifest_edge, "sync_root");
  manifest.sync_root = {text_or(root, "algorithm"), text_or(root, "value"), root.value("entry_count", uint64_t{0})};
  for (const auto &record : array_or_empty(bundle, "records")) {
    if (!record.is_object()) {
      continue;
    }
    storage_export_record_view row{};
    row.entry = parse_manifest_entry_view(record);
    if (record.contains("payload") && !record.at("payload").is_null()) {
      row.payload_json = canonical_json(record.at("payload"));
    }
    parsed.records.push_back(std::move(row));
  }
  return parsed;
}

storage_import_bundle_result import_bundle_typed_impl(const storage_import_bundle_request &request) {
  const auto &manifest = request.bundle.manifest;
  if (manifest.manifest_id.empty())
    throw std::invalid_argument("bundle_manifest_invalid: missing_field: manifest_id");
  if (manifest.source_id.empty())
    throw std::invalid_argument("bundle_manifest_invalid: missing_field: source_id");
  if (request.verify) {
    const auto expected = yy_storage::compute_manifest_sync_root(manifest.entries);
    if (expected.algorithm != manifest.sync_root.algorithm || expected.value != manifest.sync_root.value ||
        expected.entry_count != manifest.sync_root.entry_count) {
      throw std::invalid_argument("bundle_manifest_invalid: sync_root_mismatch");
    }
  }
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  for (const auto &record : request.bundle.records) {
    if (!record.payload_json.has_value()) {
      continue;
    }
    if (record.entry.payload_state == yy_enums::PayloadState::Redacted ||
        record.entry.payload_state == yy_enums::PayloadState::Absent) {
      continue;
    }
    auto digest = record.entry.payload_hash;
    if (digest.empty()) {
      digest = yy_storage::compute_content_hash_value(*record.payload_json, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
    }
    const auto error = yy_storage::verify_payload_ref(*record.payload_json, digest, record.payload_json->size());
    if (!error.empty()) {
      throw std::invalid_argument("storage_payload_invalid: " + error);
    }
    provider->write_payload(digest, *record.payload_json);
  }

  const auto accepted = catalog_store(request.runtime_dir).accept_manifest_typed(manifest, provider->content_store());
  const auto registry = registry_store(request.runtime_dir);
  bool registered = false;
  for (const auto &[source_uid, source] : registry.fold_typed_records().sources) {
    (void)source_uid;
    if (source.registered && fixed_string(source.registration.source_id) == accepted.source_id) {
      registered = true;
      break;
    }
  }
  if (!registered) {
    yy_storage::source_register_options reg{};
    reg.source_id = accepted.source_id;
    reg.kind = accepted.source_type == "atlas" ? yy_enums::SourceKind::Adapter : yy_enums::SourceKind::Local;
    reg.coordinate = accepted.source_coordinate;
    reg.head = accepted.source_head;
    (void)registry.register_source(reg);
  }
  yy_storage::source_head_update_options head{};
  head.source_id = accepted.source_id;
  head.head = accepted.source_head;
  head.inventory_hash_algo = accepted.sync_root.algorithm;
  head.inventory_hash = accepted.sync_root.value;
  (void)registry.update_head(head);
  yy_storage::accepted_range_options range{};
  range.source_id = accepted.source_id;
  range.manifest_id = accepted.manifest_id;
  (void)registry.record_accepted_range(range);
  return {true, "source", accepted.source_id, accepted.manifest_id, request.bundle.records.size()};
}

nlohmann::json render_storage_import_bundle_result(const storage_import_bundle_result &result) {
  return {{"ok", result.ok},
          {"scope", result.scope},
          {"source_id", result.source_id},
          {"manifest_id", result.manifest_id},
          {"records", result.records}};
}

storage_verify_sync_result verify_sync_typed_impl(const storage_verify_sync_request &request) {
  storage_verify_sync_result result{};
  result.source_id = request.source_id;
  result.source_fsck =
      default_storage_service().fsck({request.runtime_dir, request.provider, request.provider_config_source,
                                      storage_fsck_scope::Source, request.source_id, 0, false});
  if (!result.source_fsck.ok) {
    result.ok = false;
    return result;
  }

  const auto bundle =
      default_storage_service().export_bundle({request.runtime_dir, request.provider, request.source_id, {}, false});
  result.exported_records = bundle.records.size();
  result.local_sync_root = {bundle.manifest.sync_root.algorithm, bundle.manifest.sync_root.value};
  const auto temp_root = fs::temp_directory_path() / ("kungfu-storage-sync-" + std::to_string(std::random_device{}()) +
                                                      "-" + std::to_string(std::random_device{}()));
  result.imported_runtime_dir = temp_root.string();
  try {
    result.import = default_storage_service().import_bundle({temp_root.string(), request.provider, bundle, true});
    result.imported_fsck =
        default_storage_service().fsck({temp_root.string(), request.provider, request.provider_config_source,
                                        storage_fsck_scope::Source, request.source_id, 0, false});
    auto imported_provider = provider_cache::instance().acquire(temp_root.string(), request.provider);
    const auto imported =
        catalog_store(temp_root.string()).latest_manifest_typed(request.source_id, imported_provider->content_store());
    if (imported.has_value()) {
      result.imported_sync_root = {imported->sync_root.algorithm, imported->sync_root.value};
    }
    imported_provider.reset();
    if (!provider_cache::instance().release_temporary(temp_root.string(), request.provider)) {
      throw std::runtime_error("temporary sync provider still has active operations");
    }
    fs::remove_all(temp_root);
  } catch (...) {
    (void)provider_cache::instance().release_temporary(temp_root.string(), request.provider);
    std::error_code cleanup_error;
    fs::remove_all(temp_root, cleanup_error);
    throw;
  }
  result.sync_roots_match = result.local_sync_root.algorithm == result.imported_sync_root.algorithm &&
                            result.local_sync_root.value == result.imported_sync_root.value;
  result.ok = result.imported_fsck.ok && result.sync_roots_match;
  return result;
}

nlohmann::json render_storage_verify_sync_result(const storage_verify_sync_result &result) {
  if (!result.source_fsck.ok) {
    return {{"ok", false},
            {"scope", "source"},
            {"source_id", result.source_id},
            {"errors", nlohmann::json::array({{{"code", "source_fsck_failed"},
                                               {"fsck", render_storage_fsck_result(result.source_fsck)}}})}};
  }
  auto imported_fsck = render_storage_fsck_result(result.imported_fsck);
  imported_fsck = replace_string_subtree(imported_fsck, result.imported_runtime_dir, "<sync-runtime>");
  return {{"ok", result.ok},
          {"scope", result.scope},
          {"source_id", result.source_id},
          {"exported_records", result.exported_records},
          {"import", render_storage_import_bundle_result(result.import)},
          {"local_sync_root",
           render_sync_root({result.local_sync_root.algorithm, result.local_sync_root.value, result.exported_records})},
          {"imported_sync_root", render_sync_root({result.imported_sync_root.algorithm, result.imported_sync_root.value,
                                                   result.exported_records})},
          {"sync_roots_match", result.sync_roots_match},
          {"source_fsck", render_storage_fsck_result(result.source_fsck)},
          {"imported_fsck", imported_fsck}};
}

} // namespace kungfu::runtime::storage_service_api::detail
