// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <filesystem>
#include <string>
#include <system_error>
#include <unordered_set>
#include <utility>

#include <kungfu/runtime/storage/episode_manifest_projection.h>
#include <kungfu/runtime/storage/manifest_catalog_projection.h>
#include <kungfu/runtime/storage/source_registry_projection.h>
#include <kungfu/yijinjing/storage/episode_manifest.h>
#include <kungfu/yijinjing/storage/manifest_catalog.h>
#include <kungfu/yijinjing/storage/source_registry.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;

namespace detail {

storage_layout_result workspace_episode_layout_typed(const storage_layout_request &request,
                                                     const storage_provider &provider) {
  const auto runtime = absolute_normalized(request.runtime_dir);
  const auto home = request.runtime_home.empty() ? (runtime.filename() == "runtime" ? runtime.parent_path() : runtime)
                                                 : absolute_normalized(request.runtime_home);
  const auto journal_dir = runtime / "journal";
  const auto storage_dir = runtime / "storage";
  const auto episode_manifest_dir =
      journal_dir / "system" / yy_storage::EPISODE_MANIFEST_NAMESPACE / yy_storage::EPISODE_MANIFEST_NAME / "live";
  const auto manifest_catalog_journal_dir =
      journal_dir / "system" / yy_storage::MANIFEST_CATALOG_NAMESPACE / yy_storage::MANIFEST_CATALOG_NAME / "live";
  const auto source_registry_journal_dir =
      journal_dir / "system" / yy_storage::SOURCE_REGISTRY_NAMESPACE / yy_storage::SOURCE_REGISTRY_NAME / "live";
  const auto manifest_entries_pattern = storage_dir / "manifests" / "<hash-prefix>" / "<sha256>";
  const auto payload_pattern = storage_dir / "payloads" / "<hash-prefix>" / "<sha256>";

  storage_layout_result result{};
  result.runtime_home = home.string();
  result.workspace_data_home = home.string();
  result.runtime_home_source = request.runtime_home.empty() ? "inferred-from-runtime-dir" : "option";
  result.runtime_dir = runtime.string();
  result.runtime_dir_is_standard_child = runtime == (home / "runtime").lexically_normal();
  result.config_home = request.config_home.empty() ? std::string{} : absolute_normalized(request.config_home).string();
  result.provider = provider.name();
  result.provider_layout = provider.layout();
  result.provider_runtime = provider.runtime();
  result.provider_cache = provider_cache::instance().stats();
  result.paths.data_home = home.string();
  result.paths.workspace_ignore = (home / ".gitignore").string();
  result.paths.workspace_config = (home / "config.json").string();
  result.paths.first_party_manifest = (home / "first-party.json").string();
  result.paths.extensions_dir = (home / "extensions").string();
  result.paths.runtime_dir = runtime.string();
  result.paths.dataset_dir = (home / "dataset").string();
  result.paths.inbox_dir = (home / "inbox").string();
  result.paths.backtest_dir = (home / "backtest").string();
  result.paths.sealed_episodes_dir = (home / "episodes").string();
  result.paths.project_cuts_dir = (home / "project-cuts").string();
  result.paths.journal_dir = journal_dir.string();
  result.paths.db_dir = (runtime / "db").string();
  result.paths.nn_dir = (runtime / "nn").string();
  result.paths.map_dir = (runtime / "map").string();
  result.paths.log_dir = (runtime / "log").string();
  result.paths.ownership_dir = (runtime / "ownership").string();
  result.paths.coordinator_dir = (runtime / "coordinator").string();
  result.paths.skill_manager_dir = (runtime / "skill-manager").string();
  result.paths.agent_session_dir = (runtime / "agent-session").string();
  result.paths.skill_context_dir = (runtime / "skill-context").string();
  result.paths.project_cut_runtime_dir = (runtime / "project-cut-go").string();
  result.paths.sources_dir = (runtime / "sources").string();
  result.paths.peers_dir = (runtime / "peers").string();
  result.paths.coordination_dir = (runtime / "coordination").string();
  result.paths.admission_dir = (runtime / "admission").string();
  result.paths.fact_durable_admission_dir = (runtime / "fact-durable-admission").string();
  result.paths.receipts_dir = (runtime / "receipts").string();
  result.paths.legacy_master_dir = (runtime / "master").string();
  result.paths.storage_dir = storage_dir.string();
  result.paths.source_registry_journal = (source_registry_journal_dir / "*.journal").string();
  result.paths.manifest_catalog_journal = (manifest_catalog_journal_dir / "*.journal").string();
  result.paths.manifest_entries = manifest_entries_pattern.string();
  result.paths.payloads = payload_pattern.string();
  result.paths.schemas = (storage_dir / "schemas" / "<hash-prefix>" / "<sha256>").string();
  result.paths.rocksdb = provider_database_path(runtime.string()).string();
  result.paths.backend_binding = (storage_dir / "backend-binding.json").string();
  result.paths.backend_switch_state = (storage_dir / "backend-switch-state.json").string();
  result.paths.backend_switch_receipts = (storage_dir / "backend-switch-receipts" / "*.json").string();
  result.paths.backend_switch_operation_lock = (storage_dir / "backend-switch.lock").string();
  result.paths.backend_authority_lock = (storage_dir / "backend-authority.lock").string();
  result.paths.source_registry_projection = source_registry_projection(runtime.string()).sqlite_path();
  result.paths.manifest_catalog_projection = manifest_catalog_projection(runtime.string()).sqlite_path();
  result.paths.episode_manifest_journal_dir = episode_manifest_dir.string();
  result.paths.episode_manifest_journal = (episode_manifest_dir / "*.journal").string();
  result.paths.coordinator_state = (runtime / "coordinator").string();
  result.paths.remote_mirrors = (runtime / "remotes" / "<source-id>" / "runtime").string();
  result.paths.atlas_store = (runtime / "atlas" / "store").string();
  const auto add_entry = [&result](std::string id, const fs::path &path, std::string persistence,
                                   std::string authority) {
    result.entries.push_back({std::move(id), path.string(), std::move(persistence), std::move(authority)});
  };
  add_entry("workspace-ignore", home / ".gitignore", "durable", "workspace publication policy");
  add_entry("workspace-config", home / "config.json", "durable", "workspace configuration override");
  add_entry("first-party-manifest", home / "first-party.json", "durable", "build-generated KFX trust manifest");
  add_entry("extensions", home / "extensions", "durable", "installed workspace KFX packages");
  add_entry("inbox", home / "inbox", "durable", "unadmitted local source material");
  add_entry("dataset", home / "dataset", "durable", "workspace datasets");
  add_entry("backtest", home / "backtest", "durable", "workspace backtest results");
  add_entry("backups", home / "backups", "durable", "runtime recovery backups");
  add_entry("private", home / "private", "durable", "ignored workspace-private material");
  add_entry("cache", home / "cache", "cache", "rebuildable workspace cache");
  add_entry("locks", home / "locks", "ephemeral", "workspace advisory locks");
  add_entry("projections", home / "projections", "cache", "rebuildable workspace projections");
  add_entry("contract", home / "contract", "durable", "portable workspace contract input");
  add_entry("missions", home / "missions", "durable", "low-frequency workspace mission input");
  add_entry("skills", home / "skills", "durable", "installed workspace skills");
  add_entry("skill-bindings", home / "skill-bindings", "durable", "workspace skill enablement bindings");
  add_entry("sealed-episodes", home / "episodes", "durable", "sealed Git-provider Episode material");
  add_entry("project-cuts", home / "project-cuts", "durable", "published Project Cut material");
  add_entry("runtime", runtime, "durable", "mixed runtime container; child entries override persistence");
  add_entry("journal", journal_dir, "durable", "yijinjing fact and Episode authority");
  add_entry("db", runtime / "db", "durable", "runtime database layout");
  add_entry("nn", runtime / "nn", "ephemeral", "process communication endpoints");
  add_entry("map", runtime / "map", "ephemeral", "shared-memory mappings");
  add_entry("log", runtime / "log", "cache", "diagnostic logs");
  add_entry("ownership", runtime / "ownership", "ephemeral", "runtime ownership locks");
  add_entry("coordinator", runtime / "coordinator", "durable",
            "mixed continuity container; child entries override persistence");
  add_entry("coordinator-state", runtime / "coordinator" / "state.json", "durable", "runtime continuity state");
  add_entry("coordinator-assessments", runtime / "coordinator" / "assessments.json", "durable",
            "continuity assessment facts");
  add_entry("coordinator-continuity", runtime / "coordinator" / "runtime-continuity.json", "durable",
            "runtime continuity record");
  add_entry("coordinator-locks", runtime / "coordinator" / "continuity-locks", "ephemeral",
            "live continuity lock table");
  add_entry("coordinator-lock-guard", runtime / "coordinator" / "continuity-locks" / "locks.guard", "ephemeral",
            "continuity lock table advisory guard");
  add_entry("coordinator-pid", runtime / "coordinator" / "coordinator.pid", "ephemeral", "live process identity");
  add_entry("coordinator-log", runtime / "coordinator" / "coordinator.log", "cache", "diagnostic log");
  add_entry("skill-manager", runtime / "skill-manager", "durable", "skill installation and enablement state");
  add_entry("agent-session", runtime / "agent-session", "durable", "agent session and capsule continuity state");
  add_entry("skill-context", runtime / "skill-context", "cache", "compiled skill context");
  add_entry("project-cut-runtime", runtime / "project-cut-go", "cache", "rebuildable Project Cut coordination");
  add_entry("episode-provider", runtime / "episode-provider", "ephemeral", "live Git Episode provider leases");
  add_entry("full-evidence", runtime / "full-evidence", "durable", "admitted full Episode evidence receipts");
  add_entry("rewind", runtime / "rewind", "durable", "Rewind run bundles and retained evidence");
  add_entry("work", runtime / "work", "durable", "work-store schema bindings and manifests");
  add_entry("agent", runtime / "agent", "durable", "workspace agent policy");
  add_entry("skill-audit", runtime / "skill-audit.jsonl", "durable", "workspace skill audit trail");
  add_entry("sources", runtime / "sources", "durable", "workspace source registry");
  add_entry("peers", runtime / "peers", "durable", "peer launch and continuity state");
  add_entry("peer-logs", runtime / "peers" / "<peer-id>" / "peer.log", "cache", "peer diagnostic logs");
  add_entry("peer-locks", runtime / "peers" / "<peer-id>" / "locks", "ephemeral", "live peer lifecycle locks");
  add_entry("coordination", runtime / "coordination", "ephemeral", "same-host named lock table");
  add_entry("admission", runtime / "admission", "durable", "Episode admission state and receipts");
  add_entry("fact-durable-admission", runtime / "fact-durable-admission", "durable",
            "durable Fact ingest state and receipts");
  add_entry("receipts", runtime / "receipts", "durable", "runtime qualification and execution receipts");
  add_entry("libwasm-receipts", runtime / "receipts" / "libwasm", "durable", "libwasm execution receipts");
  add_entry("legacy-master", runtime / "master", "ephemeral", "legacy coordinator process identity");
  add_entry("storage", storage_dir, "durable", "runtime storage service container");
  add_entry("storage-manifests", storage_dir / "manifests", "durable", "accepted manifest documents");
  add_entry("storage-payloads", storage_dir / "payloads", "durable", "content-addressed payload bodies");
  add_entry("storage-schemas", storage_dir / "schemas", "durable", "content-addressed schema bodies");
  add_entry("storage-rocksdb", storage_dir / "rocksdb", "durable", "optional authoritative provider database");
  add_entry("storage-projections", storage_dir / "projections", "cache", "rebuildable SQLite projections");
  add_entry("storage-backend-binding", storage_dir / "backend-binding.json", "durable",
            "authoritative provider binding");
  add_entry("storage-backend-switch-state", storage_dir / "backend-switch-state.json", "durable",
            "provider migration state");
  add_entry("storage-backend-switch-receipts", storage_dir / "backend-switch-receipts", "durable",
            "provider migration receipts");
  add_entry("storage-backend-switch-lock", storage_dir / "backend-switch.lock", "ephemeral",
            "live provider migration operation lock");
  add_entry("storage-backend-authority-lock", storage_dir / "backend-authority.lock", "ephemeral",
            "live provider authority lock");
  add_entry("remote-mirrors", runtime / "remotes", "durable", "accepted source mirrors");
  add_entry("atlas-store", runtime / "atlas", "durable", "accepted Atlas mirror");
  const std::unordered_set<std::string> declared_paths = [&result] {
    std::unordered_set<std::string> paths;
    for (const auto &entry : result.entries) {
      paths.insert(fs::path(entry.path).lexically_normal().string());
    }
    return paths;
  }();
  const auto is_declared_path = [&declared_paths](const fs::path &path) {
    return declared_paths.count(path.lexically_normal().string()) != 0;
  };
  const auto check_root = [&result, &is_declared_path](const fs::path &root) {
    std::error_code error;
    const auto status = fs::status(root, error);
    if (error) {
      if (error == std::errc::no_such_file_or_directory) {
        return;
      }
      result.coverage.unclassified_durable_candidates.push_back((root / "<scan-error>").string());
      return;
    }
    if (!fs::exists(status)) {
      return;
    }
    if (!fs::is_directory(status)) {
      result.coverage.unclassified_durable_candidates.push_back(root.string());
      return;
    }
    result.coverage.checked_roots.push_back(root.string());
    for (fs::directory_iterator iter(root, error), end; iter != end && !error; iter.increment(error)) {
      const auto observed = iter->path().lexically_normal().string();
      if (!is_declared_path(iter->path())) {
        result.coverage.unclassified_durable_candidates.push_back(observed);
      }
    }
    if (error) {
      result.coverage.unclassified_durable_candidates.push_back((root / "<scan-error>").string());
    }
  };
  if (result.runtime_dir_is_standard_child) {
    check_root(home);
  }
  check_root(runtime);
  check_root(storage_dir);
  check_root(runtime / "coordinator");
  result.coverage.complete = result.coverage.unclassified_durable_candidates.empty();
  result.episodes = {"yijinjing-journal",
                     yy_storage::EPISODE_MANIFEST_SCHEMA_V1,
                     yy_storage::EPISODE_MANIFEST_NAMESPACE,
                     yy_storage::EPISODE_MANIFEST_NAME,
                     (episode_manifest_dir / "*.journal").string(),
                     {"episodes", "episode_records", "episode_frames", "episode_refs"},
                     "kungfu.storage.episode-bundle/v1"};
  result.ownership = {"append-only yijinjing frames owned by the resolved runtime",
                      "append-only yijinjing manifest records; not loose JSON authority",
                      "runtime storage service area for content-addressed bodies, provider databases, and projections",
                      "append-only yijinjing source-registry kernel records; the source catalog",
                      "append-only yijinjing manifest-catalog kernel records; the import/export/cursor authority",
                      "content-addressed accepted entries documents committed by the manifest records",
                      "provider-owned content-addressed payload bodies",
                      "derived rebuildable SQLite projection over the source-registry journal",
                      "derived rebuildable SQLite projection over the manifest-catalog journal",
                      "optional provider-owned large-payload/key-value backend",
                      "user config home; intentionally outside workspace data"};
  result.notes = {
      "This layout describes the resolved local data root; it is an inspection contract, not a second fact source.",
      "Episode authority remains the yijinjing manifest journal under the runtime journal tree.",
      "Provider-specific paths are implementation details behind the runtime storage service API."};
  return result;
}

} // namespace detail

} // namespace kungfu::runtime::storage_service_api
