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
// Edge-level input options. These carry std::string for ergonomic callers; the
// store copies them into fixed-layout POD journal records. They are not the
// stored record and never become the fact substrate.
struct episode_begin_options {
  uint64_t episode_id = 0;
  uint64_t parent_episode_id = 0;
  uint64_t root_trigger_frame_uid = 0;
  uint32_t location_uid = 0;
  int64_t begin_time = 0;
  std::string title = {};
  std::string actor = {};
  std::string source = {};
};

struct episode_heartbeat_options {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
  int64_t update_time = 0;
  uint64_t last_frame_uid = 0;
  uint64_t frame_count = 0;
  std::string note = {};
};

struct episode_close_options {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
  yijinjing::enums::EpisodeStatus status = yijinjing::enums::EpisodeStatus::Ended;
  int64_t end_time = 0;
  uint64_t last_frame_uid = 0;
  uint64_t frame_count = 0;
  std::string reason = {};
};

struct episode_frame_attach_options {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
  uint64_t frame_uid = 0;
  uint64_t trigger_frame_uid = 0;
  uint64_t stream_id = 0;
  int64_t gen_time = 0;
  int64_t trigger_time = 0;
  int32_t carrier_type = 0;
  uint32_t source = 0;
  uint32_t dest = 0;
  uint32_t data_length = 0;
  uint32_t integrity_version = 0;
  uint64_t payload_checksum = 0;
  uint64_t frame_checksum = 0;
};

struct episode_ref_attach_options {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
  yijinjing::enums::EpisodeRefKind ref_kind = yijinjing::enums::EpisodeRefKind::InputFrame;
  uint64_t ref_uid = 0;
  int64_t update_time = 0;
  std::string ref_id = {};
  std::string ref_hash = {};
};

// Explicit crash-recovery maintenance operation: close interrupted open
// Episodes as aborted. Never automatic; the caller declares its scope with
// episode_id (one Episode) and/or location_uid (only Episodes opened by that
// owner location). Open Episodes outside the scope are reported, not mutated.
struct episode_recover_options {
  uint64_t episode_id = 0;   // 0 = every open Episode in scope
  uint32_t location_uid = 0; // 0 = any owner location
  int64_t end_time = 0;
  std::string reason = {}; // defaults to "recovered"
};

// The manifest writer guard lock file, next to the manifest journal pages.
// Every manifest write acquires an exclusive advisory lock on it or fails
// with manifest_writer_busy; see docs/episode-manifest-trust-boundary.md §3.
[[nodiscard]] std::string episode_manifest_writer_lock_path(const std::string &runtime_dir);

[[nodiscard]] nlohmann::json render_episode_fsck_issue(const episode_fsck_issue &issue);

[[nodiscard]] nlohmann::json render_episode_fsck_result(const episode_fsck_result &result);

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

  // Append-only writers. Each writes one POD record to the journal and
  // returns its JSON edge projection.
  [[nodiscard]] nlohmann::json begin(const episode_begin_options &options) const;

  [[nodiscard]] nlohmann::json heartbeat(const episode_heartbeat_options &options) const;

  [[nodiscard]] nlohmann::json attach_frame(const episode_frame_attach_options &options) const;

  [[nodiscard]] nlohmann::json attach_ref(const episode_ref_attach_options &options) const;

  [[nodiscard]] nlohmann::json end(const episode_close_options &options) const;

  [[nodiscard]] nlohmann::json abort(const episode_close_options &options) const;

  // Resume-or-abort recovery for interrupted open Episodes, as an explicit
  // maintenance step under the writer guard. Appends EpisodeClosed(Aborted)
  // for in-scope open Episodes; never runs automatically.
  [[nodiscard]] nlohmann::json recover(const episode_recover_options &options) const;

  // Stream the manifest journal back as typed records in append order. The
  // streaming visitor is the primitive; memory stays bounded by what the
  // caller accumulates.
  void for_each_typed_record(const episode_manifest_record_visitor &visit) const;

  [[nodiscard]] std::vector<episode_manifest_record> read_typed_records() const;

  // Fold the journal into the typed current views (the canonical in-memory
  // derivation shared by list/inspect/fsck and future projection/query).
  [[nodiscard]] episode_manifest_fold fold_typed_records() const;

  // Edge projections over the typed fold. JSON is produced here and only here.
  [[nodiscard]] nlohmann::json list(uint64_t location_uid = 0, uint64_t limit = 100) const;

  [[nodiscard]] nlohmann::json inspect(uint64_t episode_id) const;

  [[nodiscard]] episode_fsck_result fsck_typed(uint64_t episode_id = 0) const;

  [[nodiscard]] nlohmann::json fsck(uint64_t episode_id = 0) const;

private:
  std::string runtime_dir_;
  const content_store *content_store_ = nullptr;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H
