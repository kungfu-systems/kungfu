// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_PROJECTION_BOOTSTRAP_H
#define KUNGFU_RUNTIME_PROJECTION_BOOTSTRAP_H

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <kungfu/runtime/durable_ingest.h>

namespace kungfu::runtime::state_service {

inline constexpr const char *PROJECTION_SNAPSHOT_SCHEMA_V1 = "kungfu.projection-snapshot/v1";

enum class peer_state_requirement : uint8_t { Required, Optional, None };
enum class bootstrap_outcome : uint8_t { Ready, Degraded, Refused };
enum class projection_error : uint8_t {
  None,
  InvalidArgument,
  ServiceUnavailable,
  SnapshotMissing,
  SnapshotCorrupt,
  SchemaMismatch,
  PositionMismatch,
  PositionGap,
  ProjectorFailed,
  IoError,
};

struct projection_mutation {
  std::string key = {};
  std::string value = {};
  bool erase = false;
};

using durable_projector = std::function<std::optional<projection_mutation>(const durability::durable_record &)>;

struct projection_options {
  std::string data_root = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::string projection_name = {};
  std::string projection_schema = {};
  std::string source_qualification_profile = {};
};

struct projection_snapshot {
  std::string schema = PROJECTION_SNAPSHOT_SCHEMA_V1;
  std::string projection_name = {};
  std::string projection_schema = {};
  std::string source_qualification_profile = {};
  durability::stream_position through_position = {};
  std::map<std::string, std::string> state = {};
  std::string integrity_sha256 = {};
};

struct projection_status {
  bool available = true;
  bool snapshot_present = false;
  bool shadow = true;
  std::string rebuild_state = "not_started";
  std::optional<durability::stream_position> durable_watermark = std::nullopt;
  std::optional<durability::stream_position> projection_watermark = std::nullopt;
  uint64_t lag_records = 0;
  projection_error last_error = projection_error::None;
  std::string last_error_message = {};
};

struct bootstrap_result {
  bootstrap_outcome outcome = bootstrap_outcome::Refused;
  projection_error error = projection_error::None;
  std::string message = {};
  projection_status status = {};
  std::map<std::string, std::string> state = {};
  std::optional<durability::stream_position> snapshot_through = std::nullopt;
  std::optional<durability::stream_position> replay_through = std::nullopt;
  uint64_t replayed_records = 0;
};

// A derived, rebuildable projection snapshot over checkpoint-covered durable
// records. The snapshot is never a fact authority: its integrity and cut are
// verified before replay, and deletion is repaired by rebuilding from KFDL.
class projection_bootstrap_store {
public:
  projection_bootstrap_store(projection_options options, durable_projector projector);
  ~projection_bootstrap_store();
  projection_bootstrap_store(const projection_bootstrap_store &) = delete;
  projection_bootstrap_store &operator=(const projection_bootstrap_store &) = delete;

  [[nodiscard]] projection_snapshot rebuild(const std::vector<durability::durable_record> &records,
                                            std::optional<durability::stream_position> through = std::nullopt);
  [[nodiscard]] projection_snapshot load_snapshot() const;
  [[nodiscard]] bootstrap_result bootstrap(const std::vector<durability::durable_record> &records,
                                           peer_state_requirement requirement);
  [[nodiscard]] projection_status status() const;
  [[nodiscard]] std::string snapshot_path() const;

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

[[nodiscard]] const char *projection_error_name(projection_error error) noexcept;
[[nodiscard]] const char *bootstrap_outcome_name(bootstrap_outcome outcome) noexcept;

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_PROJECTION_BOOTSTRAP_H
