// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H
#define KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H

#include <cstdint>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include <kungfu/yijinjing/schema/types.h>

namespace kungfu::yijinjing::storage {

inline constexpr const char *EPISODE_MANIFEST_SCHEMA_V1 = "kungfu.episode.manifest/v1";
inline constexpr const char *EPISODE_MANIFEST_GROUP = "storage";
inline constexpr const char *EPISODE_MANIFEST_NAME = "episode-manifest";

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

class episode_manifest_store {
public:
  explicit episode_manifest_store(std::string runtime_dir);

  [[nodiscard]] std::string runtime_dir() const { return runtime_dir_; }

  [[nodiscard]] nlohmann::json begin(const episode_begin_options &options) const;

  [[nodiscard]] nlohmann::json heartbeat(const episode_heartbeat_options &options) const;

  [[nodiscard]] nlohmann::json attach_frame(const episode_frame_attach_options &options) const;

  [[nodiscard]] nlohmann::json attach_ref(const episode_ref_attach_options &options) const;

  [[nodiscard]] nlohmann::json end(const episode_close_options &options) const;

  [[nodiscard]] nlohmann::json abort(const episode_close_options &options) const;

  [[nodiscard]] nlohmann::json list(uint64_t location_uid = 0, uint64_t limit = 100) const;

  [[nodiscard]] nlohmann::json inspect(uint64_t episode_id) const;

  [[nodiscard]] nlohmann::json fsck(uint64_t episode_id = 0) const;

private:
  std::string runtime_dir_;
};

} // namespace kungfu::yijinjing::storage

#endif // KUNGFU_YIJINJING_STORAGE_EPISODE_MANIFEST_H
