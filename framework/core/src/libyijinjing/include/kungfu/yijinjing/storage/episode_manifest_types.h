// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_TYPES_H
#define KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_TYPES_H

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

// Typed Episode fold and diagnostics contracts shared above the journal.
// JSON renderers and store operations stay in episode_manifest.h.
inline constexpr const char *EPISODE_MANIFEST_SCHEMA_V1 = "kungfu.episode.manifest/v1";
inline constexpr const char *EPISODE_MANIFEST_NAMESPACE = "storage";
inline constexpr const char *EPISODE_MANIFEST_NAME = "episode-manifest";

// Owned semantic inputs shared by the journal store and the runtime storage
// service. They are not persisted records and carry no carrier/layout promise.
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

struct episode_append_options {
  episode_begin_options begin = {};
  std::vector<episode_frame_attach_options> frames = {};
  std::vector<episode_ref_attach_options> refs = {};
  episode_close_options close = {};
};

struct episode_recover_options {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
  int64_t end_time = 0;
  std::string reason = {};
  uint64_t expected_manifest_frame_uid = 0;
};

struct episode_manifest_unknown_record {
  int32_t carrier_type = 0;
  uint32_t schema_version = 0;
  bool unknown_version = false;
};

struct episode_manifest_record {
  uint64_t manifest_frame_uid = 0;
  int64_t manifest_gen_time = 0;
  // Exact packed journal body. Derived projections retain these bytes so they
  // can replay the canonical decoder instead of inventing a second semantic
  // representation. Unknown/newer records remain round-trippable too.
  std::vector<uint8_t> payload = {};
  std::variant<episode_manifest_unknown_record, yijinjing::types::EpisodeOpen, yijinjing::types::EpisodeHeartbeat,
               yijinjing::types::EpisodeFrameAttached, yijinjing::types::EpisodeRefAttached,
               yijinjing::types::EpisodeClosed, yijinjing::types::EpisodeRootCommitted>
      body = episode_manifest_unknown_record{};
};

using episode_manifest_record_visitor = std::function<void(const episode_manifest_record &)>;

struct episode_current_view {
  uint64_t episode_id = 0;
  bool opened = false;
  bool closed = false;
  size_t open_count = 0;
  size_t close_count = 0;
  yijinjing::types::EpisodeOpen open = {};
  uint64_t open_manifest_frame_uid = 0;
  int64_t open_manifest_gen_time = 0;
  bool heartbeat_seen = false;
  int64_t update_time = 0;
  uint64_t claimed_frame_count = 0;
  bool last_frame_uid_seen = false;
  uint64_t last_frame_uid = 0;
  size_t unique_frame_count = 0;
  yijinjing::types::EpisodeClosed close = {};
  std::vector<yijinjing::enums::EpisodeStatus> close_statuses = {};
  bool root_seen = false;
  size_t root_count = 0;
  yijinjing::types::EpisodeRootCommitted root = {};
  std::vector<episode_manifest_record> records = {};
  std::vector<size_t> frame_indices = {};
  std::vector<size_t> ref_indices = {};
  std::vector<uint64_t> duplicate_frame_uids = {};
  size_t missing_frame_uid_count = 0;

  [[nodiscard]] const yijinjing::types::EpisodeFrameAttached &frame_at(size_t position) const {
    return std::get<yijinjing::types::EpisodeFrameAttached>(records[frame_indices[position]].body);
  }

  [[nodiscard]] const yijinjing::types::EpisodeRefAttached &ref_at(size_t position) const {
    return std::get<yijinjing::types::EpisodeRefAttached>(records[ref_indices[position]].body);
  }
};

struct episode_manifest_fold {
  std::map<uint64_t, episode_current_view> episodes = {};
  size_t total_record_count = 0;
  size_t unknown_record_count = 0;
  size_t unfolded_record_count = 0;
  uint64_t first_manifest_frame_uid = 0;
  uint64_t last_manifest_frame_uid = 0;
  int64_t last_manifest_gen_time = 0;
  bool cut_found = true;
};

struct episode_fsck_issue {
  std::string code = {};
  std::optional<uint64_t> episode_id = {};
  std::optional<uint64_t> dependency_episode_id = {};
  std::optional<uint64_t> frame_uid = {};
  std::optional<uint64_t> dependent_frame_uid = {};
  std::optional<uint64_t> count = {};
  std::optional<int32_t> status = {};
  std::optional<uint64_t> claimed = {};
  std::optional<uint64_t> actual = {};
  std::optional<uint64_t> recorded_covered_record_count = {};
  std::optional<uint64_t> computed_covered_record_count = {};
  std::optional<std::string> role = {};
  std::optional<std::string> ref_id = {};
  std::optional<std::string> ref_hash = {};
  std::optional<std::string> detail = {};
  std::optional<std::string> reason = {};
  std::optional<std::string> algorithm = {};
  std::optional<std::string> recorded = {};
  std::optional<std::string> computed = {};

  friend bool operator==(const episode_fsck_issue &, const episode_fsck_issue &) = default;
};

struct episode_fsck_result {
  bool ok = true;
  std::string status = "ok";
  std::string schema = EPISODE_MANIFEST_SCHEMA_V1;
  std::string runtime_dir = {};
  std::string authority = "yijinjing-journal";
  bool degraded = false;
  std::vector<episode_fsck_issue> errors = {};
  std::vector<episode_fsck_issue> warnings = {};
  uint64_t episode_manifest_records = 0;
  uint64_t episodes = 0;
  uint64_t unknown_records = 0;
  uint64_t unfolded_records = 0;
  std::optional<episode_current_view> episode = {};
};

struct episode_causal_edge {
  uint64_t from_frame_uid = 0;
  uint64_t to_frame_uid = 0;
};

struct episode_dependency {
  std::string kind = {};
  std::string role = {};
  std::string status = {};
  std::optional<uint64_t> episode_id = {};
  std::optional<uint64_t> frame_uid = {};
  std::optional<uint64_t> dependent_frame_uid = {};
  std::optional<uint64_t> ref_uid = {};
  std::optional<std::string> ref_id = {};
  std::optional<std::string> ref_hash = {};
};

struct episode_causal_graph {
  std::string schema = "kungfu.episode.causal-graph/v1";
  uint64_t episode_id = 0;
  uint64_t frame_count = 0;
  std::vector<episode_causal_edge> edges = {};
  std::vector<episode_dependency> dependencies = {};
  std::vector<episode_fsck_issue> errors = {};
  std::vector<episode_fsck_issue> warnings = {};
  bool degraded = false;
};

struct episode_content_root {
  uint32_t covered_record_count = 0;
  std::string algorithm = {};
  std::string value = {};
};

enum class episode_content_root_status : uint8_t {
  Undefined = 0,
  RootWithoutSeal = 1,
  Absent = 2,
  Unverifiable = 3,
  Verified = 4,
  Mismatch = 5,
};

struct episode_content_root_verification {
  std::optional<yijinjing::types::EpisodeRootCommitted> recorded = {};
  std::optional<episode_content_root> computed = {};
  std::optional<bool> match = {};
  episode_content_root_status status = episode_content_root_status::Undefined;
};

struct episode_inspect_result {
  episode_current_view episode = {};
  episode_content_root_verification content_root = {};
  episode_causal_graph causal_graph = {};
  uint64_t unknown_record_count = 0;
};

struct episode_close_write_result {
  yijinjing::types::EpisodeClosed close = {};
  std::optional<yijinjing::types::EpisodeRootCommitted> content_root = {};
};

struct episode_append_result {
  yijinjing::types::EpisodeOpen open = {};
  std::vector<yijinjing::types::EpisodeFrameAttached> frames = {};
  std::vector<yijinjing::types::EpisodeRefAttached> refs = {};
  episode_close_write_result close = {};
};

struct episode_recover_skipped_open {
  uint64_t episode_id = 0;
  uint32_t location_uid = 0;
};

struct episode_recover_result {
  std::string runtime_dir = {};
  std::vector<episode_close_write_result> recovered = {};
  std::vector<episode_recover_skipped_open> skipped_open = {};
};

// The root covers the Episode-owned claim sequence in manifest append order;
// transport provenance, heartbeats, unknown records, and the root record do
// not participate in identity.
[[nodiscard]] episode_content_root compute_episode_content_root(const episode_current_view &view);

[[nodiscard]] episode_content_root_verification verify_episode_content_root(const episode_current_view &view,
                                                                            size_t unknown_record_count);

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_TYPES_H
