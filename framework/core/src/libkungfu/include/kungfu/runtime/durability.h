// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_DURABILITY_H
#define KUNGFU_RUNTIME_DURABILITY_H

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace kungfu::runtime::durability {

inline constexpr const char *DURABILITY_RECEIPT_SCHEMA_V1 = "kungfu.durability.receipt/v1";
inline constexpr const char *DURABILITY_CAPABILITY_SCHEMA_V1 = "kungfu.durability.capability/v1";

enum class durability_profile : uint8_t { Visible, DurableGroup, DurableSync, Replicated };
enum class receipt_status : uint8_t { Succeeded, Failed, Unknown };
enum class durability_error_code : uint8_t {
  None,
  InvalidRequest,
  UnsupportedProfile,
  Timeout,
  OutcomeUnknown,
  ServiceUnavailable,
  ConflictingRequestId,
  PositionEpochMismatch,
  WatermarkRegression,
  FrontierNotEstablished,
  FrontierAheadOfDependency,
};
enum class position_order : uint8_t { Before, Equal, After, Unordered };
enum class watermark_kind : uint8_t { Visible, Durable, Projection, Replicated };

// Logical identity only. Physical page ids, paths and offsets are deliberately
// absent: they may change across rollover or restart without changing this cut.
struct stream_position {
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  uint64_t sequence = 0;
  uint64_t frame_uid = 0;

  friend bool operator==(const stream_position &, const stream_position &) = default;
};

struct durability_request {
  uint64_t request_id = 0;
  stream_position position = {};
  durability_profile requested_profile = durability_profile::Visible;
};

struct durability_receipt {
  uint64_t request_id = 0;
  stream_position position = {};
  durability_profile requested_profile = durability_profile::Visible;
  std::optional<durability_profile> achieved_profile = std::nullopt;
  std::optional<stream_position> visible_watermark = std::nullopt;
  std::optional<stream_position> durable_watermark = std::nullopt;
  std::optional<stream_position> projection_watermark = std::nullopt;
  std::optional<stream_position> replicated_watermark = std::nullopt;
  uint64_t barrier_id = 0;
  std::string qualification_profile = {};
  int64_t completed_at = 0;
  receipt_status status = receipt_status::Unknown;
  durability_error_code error = durability_error_code::None;
};

// Binding/edge view keeps enum names stable across languages instead of
// exporting implementation ordinals as public semantics.
struct durability_receipt_view {
  std::string schema = DURABILITY_RECEIPT_SCHEMA_V1;
  uint64_t request_id = 0;
  stream_position position = {};
  std::string requested_profile = {};
  std::optional<std::string> achieved_profile = std::nullopt;
  std::optional<stream_position> visible_watermark = std::nullopt;
  std::optional<stream_position> durable_watermark = std::nullopt;
  std::optional<stream_position> projection_watermark = std::nullopt;
  std::optional<stream_position> replicated_watermark = std::nullopt;
  uint64_t barrier_id = 0;
  std::string qualification_profile = {};
  int64_t completed_at = 0;
  std::string status = {};
  std::string error = {};
};

struct durability_profile_capability {
  std::string name = {};
  std::string availability = {};
  std::string qualification = {};
  bool production_eligible = false;
  std::string guarantee = {};
  std::string refusal_reason = {};
};

struct durability_evidence_reference {
  std::string id = {};
  std::string path = {};
  std::string sha256 = {};
};

struct durability_restore_capability {
  bool verified = false;
  std::string scope = {};
  std::string backup_cut = {};
  uint64_t maximum_observed_rpo_records = 0;
  bool off_host = false;
  bool independent_failure_domain = false;
};

struct durability_candidate_admission {
  std::string schema = "kungfu.durability-production-candidate-report/v1";
  std::string verdict = {};
  bool current_hardware_candidate_complete = false;
  bool candidate_profile_default_enabled = false;
  bool clean_host_restart_qualified = false;
  bool off_host_restore_qualified = false;
  bool physical_power_loss_qualified = false;
  bool independent_failure_domain_qualified = false;
  bool production_eligible = false;
  bool high_availability_supported = false;
  bool replication_supported = false;
  bool consensus_supported = false;
  std::string evidence_path = {};
  std::string evidence_sha256 = {};
  std::string freshness_policy = {};
  std::string compatibility_bridge = {};
};

// C++ owns the capability semantics. Python, Node and CLI surfaces are thin
// projections of this value; JSON remains an edge representation only.
struct durability_capability_report {
  std::string schema = DURABILITY_CAPABILITY_SCHEMA_V1;
  std::string authority = "libkungfu";
  std::string profile = {};
  std::string support_level = {};
  bool production_eligible = false;
  std::string qualified_envelope = {};
  std::string qualification_profile = {};
  std::vector<durability_profile_capability> profiles = {};
  std::vector<durability_evidence_reference> evidence = {};
  durability_restore_capability restore = {};
  durability_candidate_admission admission = {};
  std::vector<std::string> trust_assumptions = {};
  std::vector<std::string> non_claims = {};
};

struct watermark_update_result {
  bool advanced = false;
  durability_error_code error = durability_error_code::None;
};

[[nodiscard]] const char *durability_profile_name(durability_profile profile) noexcept;
[[nodiscard]] const char *receipt_status_name(receipt_status status) noexcept;
[[nodiscard]] const char *durability_error_name(durability_error_code error) noexcept;
[[nodiscard]] durability_profile parse_durability_profile(const std::string &name);
[[nodiscard]] position_order compare_positions(const stream_position &left, const stream_position &right) noexcept;

// The contract-only implementation can honestly complete visible requests.
// Stronger requests fail explicitly; they are never silently downgraded.
[[nodiscard]] durability_receipt make_visible_receipt(const durability_request &request, int64_t completed_at = 0);
[[nodiscard]] durability_receipt make_unknown_receipt(const durability_request &request, durability_error_code error,
                                                      int64_t completed_at = 0);
[[nodiscard]] durability_receipt_view make_receipt_view(const durability_receipt &receipt);
[[nodiscard]] nlohmann::json render_durability_receipt(const durability_receipt &receipt);
[[nodiscard]] const durability_capability_report &single_host_institutional_capability();
[[nodiscard]] nlohmann::json render_durability_capability(const durability_capability_report &report);

class visible_receipt_registry {
public:
  [[nodiscard]] durability_receipt complete(const durability_request &request, int64_t completed_at = 0);

private:
  struct entry {
    durability_request request;
    durability_receipt receipt;
  };
  std::map<uint64_t, entry> entries_ = {};
};

class watermark_tracker {
public:
  [[nodiscard]] watermark_update_result advance(watermark_kind kind, const stream_position &position);
  [[nodiscard]] const std::optional<stream_position> &visible() const noexcept { return visible_; }
  [[nodiscard]] const std::optional<stream_position> &durable() const noexcept { return durable_; }
  [[nodiscard]] const std::optional<stream_position> &projection() const noexcept { return projection_; }
  [[nodiscard]] const std::optional<stream_position> &replicated() const noexcept { return replicated_; }

private:
  [[nodiscard]] watermark_update_result advance_monotonic(std::optional<stream_position> &frontier,
                                                          const stream_position &position);
  [[nodiscard]] watermark_update_result require_at_or_below(const std::optional<stream_position> &dependency,
                                                            const stream_position &position) const;

  std::optional<stream_position> visible_ = std::nullopt;
  std::optional<stream_position> durable_ = std::nullopt;
  std::optional<stream_position> projection_ = std::nullopt;
  std::optional<stream_position> replicated_ = std::nullopt;
};

} // namespace kungfu::runtime::durability

#endif // KUNGFU_RUNTIME_DURABILITY_H
