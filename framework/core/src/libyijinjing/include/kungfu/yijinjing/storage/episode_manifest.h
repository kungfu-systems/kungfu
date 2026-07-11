// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H
#define KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H

#include <cstdint>
#include <string>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/storage/episode_manifest_types.h>

namespace kungfu::yijinjing::storage {

// ADR-0034 / ADR-0041: the Episode manifest is the object's trust boundary.
// The authority is the append-only yijinjing journal of POD records; one
// deterministic typed fold is the canonical in-memory derivation; JSON is an
// edge projection only (CLI, export, binding return values). Fold semantics
// are specified in docs/episode-manifest-trust-boundary.md.
// The manifest writer guard lock file, next to the manifest journal pages.
// Every manifest write acquires an exclusive advisory lock on it or fails
// with manifest_writer_busy; see docs/episode-manifest-trust-boundary.md §3.
[[nodiscard]] std::string episode_manifest_writer_lock_path(const std::string &runtime_dir);

[[nodiscard]] nlohmann::json render_episode_fsck_issue(const episode_fsck_issue &issue);

[[nodiscard]] nlohmann::json render_episode_fsck_result(const episode_fsck_result &result);

// Stable edge projections shared by storage list/inspect and the fact-query
// authority scan so those readers cannot silently derive different semantics.
[[nodiscard]] nlohmann::json episode_summary_json(const episode_current_view &view);

[[nodiscard]] nlohmann::json episode_content_root_json(const episode_current_view &view, size_t unknown_record_count);

class content_store;

class episode_manifest_store {
public:
  explicit episode_manifest_store(std::string runtime_dir);

  [[nodiscard]] std::string runtime_dir() const { return runtime_dir_; }

  // ADR-0040/0041: payload refs resolve through this injected content store
  // when set, so the runtime layer can route resolution through the same
  // backend that published the bytes (file or engine-backed). Non-owning; the
  // caller keeps the store alive across the operation. When unset, fsck and
  // inspect fall back to the kernel's default file backend over
  // <runtime_dir>/storage.
  void set_content_store(const content_store *store) { content_store_ = store; }

  // Append-only writers return the authoritative Hana POD record directly;
  // JSON compatibility is rendered by the libkungfu edge adapter.
  [[nodiscard]] yijinjing::types::EpisodeOpen begin(const episode_begin_options &options) const;

  [[nodiscard]] yijinjing::types::EpisodeHeartbeat heartbeat(const episode_heartbeat_options &options) const;

  [[nodiscard]] yijinjing::types::EpisodeFrameAttached attach_frame(const episode_frame_attach_options &options) const;

  [[nodiscard]] yijinjing::types::EpisodeRefAttached attach_ref(const episode_ref_attach_options &options) const;

  [[nodiscard]] episode_close_write_result end(const episode_close_options &options) const;

  [[nodiscard]] episode_close_write_result abort(const episode_close_options &options) const;

  // Resume-or-abort recovery for interrupted open Episodes, as an explicit
  // maintenance step under the writer guard. Appends EpisodeClosed(Aborted)
  // for in-scope open Episodes; never runs automatically.
  [[nodiscard]] episode_recover_result recover(const episode_recover_options &options) const;

  // Stream the manifest journal back as typed records in append order. The
  // streaming visitor is the primitive; memory stays bounded by what the
  // caller accumulates.
  void for_each_typed_record(const episode_manifest_record_visitor &visit) const;

  [[nodiscard]] std::vector<episode_manifest_record> read_typed_records() const;

  // Fold the journal into the typed current views (the canonical in-memory
  // derivation shared by list/inspect/fsck and future projection/query).
  [[nodiscard]] episode_manifest_fold fold_typed_records() const;

  // Historical reference fold: admit records in manifest append order through
  // the exact frame uid (inclusive). The uid is a stable token, not a sortable
  // time value. cut_found is false when the requested token is absent.
  [[nodiscard]] episode_manifest_fold fold_typed_records_until(uint64_t manifest_frame_uid) const;

  // Edge projections over the typed fold. JSON is produced here and only here.
  [[nodiscard]] nlohmann::json list(uint64_t location_uid = 0, uint64_t limit = 100) const;

  [[nodiscard]] nlohmann::json inspect(uint64_t episode_id) const;

  [[nodiscard]] episode_inspect_result inspect_typed(uint64_t episode_id) const;

  [[nodiscard]] episode_causal_graph causal_graph_typed(uint64_t episode_id) const;

  [[nodiscard]] episode_fsck_result fsck_typed(uint64_t episode_id = 0) const;

  [[nodiscard]] nlohmann::json fsck(uint64_t episode_id = 0) const;

private:
  std::string runtime_dir_;
  const content_store *content_store_ = nullptr;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H
