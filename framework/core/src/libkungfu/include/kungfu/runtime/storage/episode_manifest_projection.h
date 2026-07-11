// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H
#define KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H

#include <string>

#include <nlohmann/json.hpp>

#include <kungfu/runtime/storage/projection_types.h>

namespace kungfu::runtime::storage_service_api {

inline constexpr const char *EPISODE_MANIFEST_PROJECTION_SCHEMA_V1 = "kungfu.episode.manifest-projection/v1";

// ADR-0041 point 5: rebuildable SQLite projection of the Episode manifest
// journal for indexed / SQL access. It reuses the compile-time Hana
// closed-set -> SQLite column path (cache::make_storage_ptr over
// EpisodeManifestDataTypes), the same path the source-registry projection
// uses. The manifest journal remains the authority; this projection is a
// derived view verified against the journal fold by fsck and can be rebuilt
// at any time. It is never a second authority.
class episode_manifest_projection {
public:
  explicit episode_manifest_projection(std::string runtime_dir);

  [[nodiscard]] std::string sqlite_path() const;

  [[nodiscard]] bool exists() const;

  // Rebuild the SQLite projection from the manifest journal: sync schema,
  // clear tables, replay every typed record. EpisodeOpen replays first-wins
  // to match the fold's immutable-identity rule; the other record families
  // upsert by their declared primary keys. Returns per-table row counts.
  [[nodiscard]] nlohmann::json rebuild() const;

  [[nodiscard]] storage_projection_rebuild_result rebuild_typed() const;

  // Verify the projection against the journal's typed record stream. Reports
  // drift (projection row counts diverging from distinct-primary-key journal
  // counts) as degraded, missing projection as a distinct honest state.
  [[nodiscard]] storage_projection_verify_result verify_typed() const;

  [[nodiscard]] nlohmann::json verify() const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H
