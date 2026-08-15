// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <filesystem>
#include <stdexcept>
#include <tuple>
#include <unordered_set>
#include <utility>

#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/manifest_catalog_projection.h>
#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>
#include <kungfu/yijinjing/storage/sync_root.h>

namespace kungfu::runtime::storage_service_api::detail {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

storage_status_result status_typed_impl(const storage_status_request &request) {
  const auto selection = select_provider(request.provider);
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, selection.name);
  storage_status_result result{};
  result.backend = provider->name();
  result.provider = provider->name();
  result.provider_config_source =
      request.provider_config_source.empty() ? selection.source : request.provider_config_source;
  result.provider_runtime = provider->runtime();
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }

  const auto source_fold = registry_store(request.runtime_dir).fold_typed_records();
  for (const auto &[source_uid, source] : source_fold.sources) {
    (void)source_uid;
    auto view = source_registry_status_view(source);
    if (request.source_id.empty() || view.source_id == request.source_id) {
      result.sources.push_back(std::move(view));
    }
  }
  result.ok = request.source_id.empty() || !result.sources.empty();

  const auto catalog = catalog_store(request.runtime_dir).read_typed_records();
  std::unordered_map<uint64_t, const yijinjing::types::ImportManifestAccepted *> latest_manifests;
  std::unordered_map<uint64_t, const yijinjing::types::ChannelCursorUpdated *> latest_cursors;
  for (const auto &manifest : catalog.manifests) {
    latest_manifests[manifest.source_uid] = &manifest;
  }
  for (const auto &cursor : catalog.cursors) {
    latest_cursors[cursor.source_uid] = &cursor;
  }

  for (const auto &source : result.sources) {
    storage_source_status_view status{};
    status.source_id = source.source_id;
    status.source = source;
    const auto manifest_iter = latest_manifests.find(source.source_uid);
    if (manifest_iter == latest_manifests.end()) {
      status.reason = "manifest_missing";
      result.source_status.push_back(std::move(status));
      continue;
    }

    const auto &manifest = *manifest_iter->second;
    status.ok = true;
    status.manifest_id = fixed_string(manifest.manifest_id);
    status.source_type = fixed_string(manifest.source_type);
    status.source_head = fixed_string(manifest.source_head);
    status.accepted_range = accepted_range_status_view(manifest);
    status.sync_root =
        storage_sync_root_view{fixed_string(manifest.sync_root_algo), fixed_string(manifest.sync_root_value)};
    status.entries = manifest.entry_count;
    status.payload_inventory = manifest.entry_count;

    std::unordered_set<std::string> schema_keys;
    for (const auto &entry : catalog.entries) {
      if (entry.manifest_uid != manifest.manifest_uid || entry.accept_time != manifest.accept_time ||
          entry.entry_schema_version == 0) {
        continue;
      }
      schema_keys.insert(fixed_string(entry.kind) + ":" + std::to_string(entry.entry_schema_version));
    }
    status.schema_inventory = schema_keys.size();

    if (const auto cursor_iter = latest_cursors.find(source.source_uid); cursor_iter != latest_cursors.end()) {
      status.accepted_cursor = cursor_status_view(*cursor_iter->second);
    }
    const auto source_type = *status.source_type;
    status.source_record =
        storage_manifest_source_view{status.source_id,
                                     source_type,
                                     source_type == "atlas" ? "adapter" : "local",
                                     fixed_string(manifest.source_coordinate),
                                     *status.source_head,
                                     {fixed_string(manifest.range_since), fixed_string(manifest.range_until)},
                                     fixed_string(manifest.sync_root_value),
                                     *status.accepted_range,
                                     *status.manifest_id};
    result.source_status.push_back(std::move(status));
  }

  result.projections = {source_registry_projection_status(request.runtime_dir),
                        manifest_catalog_projection_status(request.runtime_dir)};
  result.provider_cache = provider_cache::instance().stats();
  return result;
}

std::vector<std::string> referenced_payload_hashes(const std::string &runtime_dir, const std::string &source_id = {}) {
  return catalog_store(runtime_dir).referenced_payload_hashes(source_id);
}

std::pair<nlohmann::json, std::string> load_payload_impl(const storage_provider &provider,
                                                         const nlohmann::json &entry) {
  const auto digest = text_or(entry, "payload_hash");
  if (digest.empty() || !provider.payload_exists(digest)) {
    // An empty digest can never resolve to a body (and must not reach the
    // hash primitives, which reject empty values).
    return {nullptr, "payload_missing"};
  }
  const auto raw = provider.read_payload(digest);
  if (!entry.contains("byte_len") ||
      (!entry.at("byte_len").is_number_unsigned() && !entry.at("byte_len").is_number_integer())) {
    return {nullptr, "byte_len_mismatch"};
  }
  const auto expected_len = entry.at("byte_len").get<uint64_t>();
  const auto error =
      yy_storage::verify_payload_ref(raw, digest, expected_len, yy_storage::CONTENT_HASH_ALGORITHM_SHA256);
  if (!error.empty()) {
    return {nullptr, error};
  }
  try {
    auto payload = nlohmann::json::parse(raw);
    return {payload, {}};
  } catch (const nlohmann::json::exception &) {
    return {nullptr, "payload_decode_error"};
  }
}

storage_fsck_result fsck_typed_impl(const storage_fsck_request &request) {
  if (request.scope == storage_fsck_scope::Episode)
    return episode_fsck_typed_impl(request);

  storage_fsck_result result{};
  result.scope = request.source_id.empty() ? storage_fsck_scope::All : storage_fsck_scope::Source;
  if (!request.source_id.empty())
    result.source_id = request.source_id;
  result.checked.projection_indexes = 2;

  const auto status =
      status_typed_impl({request.runtime_dir, request.provider, request.provider_config_source, request.source_id});
  std::vector<storage_source_registry_view> sources;
  for (const auto &source : status.sources) {
    if (source.registered)
      sources.push_back(source);
  }
  result.checked.sources = sources.size();
  if (!request.source_id.empty() && sources.empty()) {
    storage_fsck_cross_issue detail{};
    detail.source_id = request.source_id;
    result.issues.push_back({"error", "source_missing", "source-registry", detail});
    result.ok = false;
    result.status = "failed";
    return result;
  }

  result.source_registry = registry_store(request.runtime_dir).fsck_typed(request.source_id);
  for (const auto &error : result.source_registry.errors) {
    if (error.code != "source_missing")
      result.issues.push_back({"error", error.code, "source-registry", error});
  }
  for (const auto &warning : result.source_registry.warnings)
    result.issues.push_back({"warning", warning.code, "source-registry", warning});

  const auto catalog_records = catalog_store(request.runtime_dir).read_typed_records();
  std::unordered_map<uint64_t, const yijinjing::types::ImportManifestAccepted *> latest_manifests;
  for (const auto &manifest : catalog_records.manifests)
    latest_manifests[manifest.source_uid] = &manifest;
  uint64_t sources_with_manifests = 0;
  for (const auto &source : sources) {
    const auto iter = latest_manifests.find(source.source_uid);
    if (iter == latest_manifests.end()) {
      storage_fsck_cross_issue detail{};
      detail.source_id = source.source_id;
      result.issues.push_back({"error", "manifest_missing", "manifest-catalog", detail});
      continue;
    }
    ++sources_with_manifests;
    const auto catalog_head = fixed_string(iter->second->source_head);
    if (source.head.has_value() && !source.head->empty() && *source.head != catalog_head) {
      storage_fsck_cross_issue detail{};
      detail.source_id = source.source_id;
      detail.expected = catalog_head;
      detail.actual = *source.head;
      result.issues.push_back({"error", "source_registry_drift", "source-registry", detail});
    }
    result.checked.accepted_ranges += source.accepted_range_count;
  }
  result.checked.source_records = sources_with_manifests;

  auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  if (sources_with_manifests > 0 || request.source_id.empty()) {
    result.manifest_catalog =
        catalog_store(request.runtime_dir).fsck_typed(request.source_id, provider->content_store());
    for (const auto &error : result.manifest_catalog->errors) {
      if (error.code != "source_missing")
        result.issues.push_back({"error", error.code, "manifest-catalog", error});
    }
    for (const auto &warning : result.manifest_catalog->warnings)
      result.issues.push_back({"warning", warning.code, "manifest-catalog", warning});
    result.degraded = result.degraded || result.manifest_catalog->degraded;
    result.checked.manifests = result.manifest_catalog->manifests;
    result.checked.manifest_entries = result.manifest_catalog->manifest_entries;
    result.checked.payloads = result.manifest_catalog->payloads;
    result.checked.entries_documents = result.manifest_catalog->entries_documents;
  }

  if (request.source_id.empty()) {
    const auto referenced = referenced_payload_hashes(request.runtime_dir);
    for (const auto &payload : provider->all_payloads()) {
      if (std::find(referenced.begin(), referenced.end(), payload.digest) == referenced.end()) {
        ++result.checked.orphan_payloads;
        storage_fsck_cross_issue detail{};
        detail.path = payload.uri;
        detail.payload_hash = payload.digest;
        result.issues.push_back({"warning", "orphan_payload", "content-store", detail});
      }
    }
  }

  const auto scoped = episode_ref_store(request);
  result.episode_manifest = scoped.store.fsck_typed();
  result.checked.episode_manifest_records = result.episode_manifest.episode_manifest_records;
  result.checked.episodes = result.episode_manifest.episodes;
  for (const auto &error : result.episode_manifest.errors)
    result.issues.push_back({"error", error.code, "episode-manifest", error});
  for (const auto &warning : result.episode_manifest.warnings)
    result.issues.push_back({"warning", warning.code, "episode-manifest", warning});
  result.degraded = result.degraded || result.episode_manifest.degraded;

  result.projections = {source_registry_projection_status(request.runtime_dir),
                        manifest_catalog_projection_status(request.runtime_dir)};
  for (const auto &projection : result.projections) {
    if (projection.verification.status == "absent") {
      result.issues.push_back({"warning", "projection_absent", projection.name, projection});
    } else if (projection.verification.status == "degraded") {
      result.degraded = true;
      result.issues.push_back({"warning", "projection_drift", projection.name, projection});
    }
  }
  result.ok = std::none_of(result.issues.begin(), result.issues.end(),
                           [](const auto &issue) { return issue.severity == "error"; });
  result.status = !result.ok ? "failed" : (result.degraded ? "degraded" : "ok");
  return result;
}

nlohmann::json fsck_impl(const storage_service_options &options) {
  return render_storage_fsck_result(default_storage_service().fsck(parse_storage_fsck_request(options)));
}

storage_rebuild_index_result rebuild_index_typed_impl(const storage_rebuild_index_request &request) {
  // KF-ADR-019f86da-4f90-7828-9142-46f9bca4b0f5 (final slice): rebuild the derived SQLite projections from the
  // kernel journals through the Hana closed-set -> SQLite path. The journals
  // are the authority; there is no JSON registry to regenerate any more.
  storage_rebuild_index_result result{};
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }
  result.dry_run = request.dry_run;
  result.written = !request.dry_run;
  const auto plan_one = [&](const char *name, auto &&projection) {
    auto verify = projection.verify_typed();
    const bool needs_write = verify.status != "ok" || !verify.projection_present;
    result.would_write = result.would_write || needs_write;
    if (request.dry_run) {
      result.projections.push_back({name, true, false, needs_write, std::move(verify)});
      return;
    }
    auto rebuilt = projection.rebuild_typed();
    if (!rebuilt.ok) {
      result.errors.push_back({"projection_rebuild_failed", std::string(name), {}});
    }
    result.projections.push_back({name, false, true, true, std::move(rebuilt)});
  };
  plan_one(PROJECTION_SOURCE_REGISTRY, source_registry_projection(request.runtime_dir));
  plan_one(PROJECTION_MANIFEST_CATALOG, manifest_catalog_projection(request.runtime_dir));
  const auto sources = registry_store(request.runtime_dir).fold_typed_records();
  result.sources_rebuilt = sources.sources.size();
  if (!request.source_id.empty()) {
    const auto found = std::any_of(sources.sources.begin(), sources.sources.end(), [&](const auto &item) {
      return item.second.registered && fixed_string(item.second.registration.source_id) == request.source_id;
    });
    if (!found) {
      result.errors.push_back({"source_missing", {}, request.source_id});
    }
  }
  result.ok = result.errors.empty();
  if (!request.dry_run) {
    result.would_write = true;
  }
  return result;
}

nlohmann::json rebuild_index_impl(const storage_service_options &options) {
  return render_storage_rebuild_index_result(
      default_storage_service().rebuild_index(parse_storage_rebuild_index_request(options)));
}

storage_gc_plan_result gc_plan_typed_impl(const storage_gc_plan_request &request) {
  if (!request.dry_run) {
    throw std::invalid_argument("storage_gc_requires_dry_run");
  }
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  const auto referenced = referenced_payload_hashes(request.runtime_dir, request.source_id);
  const auto payloads = provider->all_payloads();
  storage_gc_plan_result result{};
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }
  result.payloads_scanned = payloads.size();
  result.referenced_payloads = referenced.size();
  for (const auto &payload : payloads) {
    const auto digest = payload.digest;
    if (std::find(referenced.begin(), referenced.end(), digest) != referenced.end()) {
      continue;
    }
    result.candidate_bytes += payload.byte_len;
    result.candidates.push_back({digest, payload.uri, payload.byte_len, request.source_id.empty()});
  }
  result.notes = {"No payloads were deleted.",
                  request.source_id.empty()
                      ? "All-scope candidates are unreferenced by retained storage manifests."
                      : "Source scope candidates are not globally safe to delete because the interim payload store "
                        "is shared."};
  return result;
}

nlohmann::json gc_plan_impl(const storage_service_options &options) {
  return render_storage_gc_plan_result(default_storage_service().gc_plan(parse_storage_gc_plan_request(options)));
}

storage_compact_plan_result compact_plan_typed_impl(const storage_compact_plan_request &request) {
  if (!request.dry_run) {
    throw std::invalid_argument("storage_compact_requires_dry_run");
  }
  storage_compact_plan_result result{};
  result.scope = request.source_id.empty() ? "all" : "source";
  if (!request.source_id.empty()) {
    result.source_id = request.source_id;
  }
  result.rebuild_index = rebuild_index_typed_impl({request.runtime_dir, request.source_id, true});
  result.gc = gc_plan_typed_impl({request.runtime_dir, request.provider, request.source_id, true});

  const auto catalog = catalog_store(request.runtime_dir).read_typed_records();
  std::map<uint64_t, std::vector<const yijinjing::types::ImportManifestAccepted *>> manifests_by_source;
  for (const auto &manifest : catalog.manifests) {
    manifests_by_source[manifest.source_uid].push_back(&manifest);
  }
  for (const auto &[source_uid, manifests] : manifests_by_source) {
    (void)source_uid;
    const auto current_source_id = fixed_string(manifests.back()->source_id);
    if (!request.source_id.empty() && current_source_id != request.source_id) {
      continue;
    }
    for (const auto *manifest : manifests) {
      result.retained_manifests.push_back(
          {current_source_id,
           fixed_string(manifest->manifest_id),
           manifest->entry_count,
           {fixed_string(manifest->sync_root_algo), fixed_string(manifest->sync_root_value)}});
    }
  }
  result.projection_compact = {PROJECTION_MANIFEST_CATALOG,
                               manifest_catalog_projection(request.runtime_dir).sqlite_path(), "rebuild-and-vacuum",
                               true, true};
  const auto provider = provider_cache::instance().acquire(request.runtime_dir, request.provider);
  result.unsupported = {{"history-archive", "archive bundles are not implemented in this slice"},
                        {"backend-compact", provider->name() == PROVIDER_ROCKSDB
                                                ? "RocksDB compaction is not destructive-history compact"
                                                : "the file backend has no backend compaction"}};
  result.notes = {"No manifests, payloads, journal frames, or projections were rewritten.",
                  "This is a reviewable compaction plan, not destructive compaction."};
  result.ok = result.rebuild_index.ok && result.gc.ok;
  return result;
}

nlohmann::json compact_plan_impl(const storage_service_options &options) {
  return render_storage_compact_plan_result(
      default_storage_service().compact_plan(parse_storage_compact_plan_request(options)));
}

} // namespace kungfu::runtime::storage_service_api::detail
