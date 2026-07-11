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

struct episode_manifest_unknown_record {
  int32_t carrier_type = 0;
  uint32_t schema_version = 0;
  bool unknown_version = false;
};

struct episode_manifest_record {
  uint64_t manifest_frame_uid = 0;
  int64_t manifest_gen_time = 0;
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

struct episode_inspect_result {
  episode_current_view episode = {};
  episode_causal_graph causal_graph = {};
  uint64_t unknown_record_count = 0;
};

struct episode_content_root {
  uint32_t covered_record_count = 0;
  std::string algorithm = {};
  std::string value = {};
};

struct episode_close_write_result {
  yijinjing::types::EpisodeClosed close = {};
  std::optional<yijinjing::types::EpisodeRootCommitted> content_root = {};
};

// The root covers the Episode-owned claim sequence in manifest append order;
// transport provenance, heartbeats, unknown records, and the root record do
// not participate in identity.
[[nodiscard]] episode_content_root compute_episode_content_root(const episode_current_view &view);

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_TYPES_H
