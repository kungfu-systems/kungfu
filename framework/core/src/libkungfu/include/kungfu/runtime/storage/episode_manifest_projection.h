// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H
#define KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H

#include <string>
#include <vector>

#include <kungfu/runtime/storage/projection_types.h>

#include <kungfu/yijinjing/storage/episode_manifest.h>

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

  // Rebuild schema, typed tables, and the append-preserving query table in one
  // transaction over one captured journal snapshot. EpisodeOpen replays
  // first-wins to match the fold's immutable-identity rule.
  [[nodiscard]] storage_projection_rebuild_result rebuild_typed() const;

  // Verify normalized Hana field content and query-record content against one
  // captured journal snapshot. Verification is read-only; missing or
  // unreadable projection schema is an honest degraded state.
  [[nodiscard]] storage_projection_verify_result verify_typed() const;

  // Read the append-preserving query projection. The caller must verify the
  // projection first; this method never falls back to the authority journal.
  [[nodiscard]] std::vector<yijinjing::storage::episode_manifest_record> read_typed_records() const;

  [[nodiscard]] yijinjing::storage::episode_manifest_fold fold_typed_records() const;

  [[nodiscard]] yijinjing::storage::episode_manifest_fold fold_typed_records_until(uint64_t manifest_frame_uid) const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::runtime::storage_service_api

#endif // KUNGFU_RUNTIME_STORAGE_EPISODE_MANIFEST_PROJECTION_H
