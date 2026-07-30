// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_DURABLE_INGEST_H
#define KUNGFU_RUNTIME_DURABLE_INGEST_H

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <kungfu/runtime/durability.h>
#include <kungfu/yijinjing/ownership.h>

namespace kungfu::runtime::durability {

inline constexpr const char *DURABLE_SEGMENT_SCHEMA_V2 = "kungfu.durable-segment/v2";
inline constexpr const char *DURABLE_CHECKPOINT_SCHEMA_V2 = "kungfu.durable-checkpoint/v2";
inline constexpr const char *DURABILITY_RECONCILIATION_SCHEMA_V1 = "kungfu.durability.reconciliation/v1";

enum class ingest_activation : uint8_t { Shadow, ProductionCandidate };

enum class ingest_fault_point : uint8_t {
  BeforeRecordWrite,
  AfterRecordWrite,
  BeforeDataSync,
  AfterDataSync,
  BeforeCheckpointWrite,
  BeforeCheckpointRename,
  AfterCheckpointRename,
  BeforeDirectorySync,
  AfterDirectorySync,
};

enum class tail_integrity : uint8_t { None, CompleteRecords, TornOrCorrupt, Unverifiable };

enum class ingest_error : uint8_t {
  None,
  InvalidArgument,
  PositionMismatch,
  PositionGap,
  FencingLost,
  UnsupportedProfile,
  Timeout,
  ServiceUnavailable,
  AppendOutcomeUnknown,
  IoError,
  CheckpointCorrupt,
  InjectedFault,
};

struct ingest_options {
  std::string data_root = {};
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::string writer_resource_id = {};
  std::string qualification_profile = {};
  bool qualification_passed = false;
  uint64_t segment_max_bytes = 64ULL * 1024ULL * 1024ULL;
  bool read_only = false;
  // Strong profiles remain disabled by default. ProductionCandidate is an
  // explicit, evidence-bound activation mode; it does not imply production
  // eligibility.
  ingest_activation activation = ingest_activation::Shadow;
};

struct ingest_status {
  std::string segment_schema = DURABLE_SEGMENT_SCHEMA_V2;
  std::string checkpoint_schema = DURABLE_CHECKPOINT_SCHEMA_V2;
  uint64_t active_segment_id = 1;
  uint64_t durable_chain_start_segment_id = 0;
  uint64_t durable_segment_id = 0;
  uint64_t durable_offset = 0;
  uint64_t pending_records = 0;
  uint64_t pending_bytes = 0;
  uint64_t unacknowledged_tail_bytes = 0;
  tail_integrity unacknowledged_tail_integrity = tail_integrity::None;
  uint64_t last_barrier_id = 0;
  uint64_t last_barrier_duration_ns = 0;
  std::optional<stream_position> durable_watermark = std::nullopt;
  std::string qualification_profile = {};
  bool qualification_passed = false;
  bool available = true;
  bool requires_reopen = false;
  uint64_t persisted_request_count = 0;
  uint64_t barrier_attempt_count = 0;
  uint64_t barrier_succeeded_count = 0;
  uint64_t barrier_terminal_failure_count = 0;
  uint64_t barrier_unknown_count = 0;
  uint64_t reconciled_request_count = 0;
  uint64_t reconciliation_unknown_count = 0;
  uint64_t recovered_request_count = 0;
  bool production_candidate_enabled = false;
  ingest_error last_error = ingest_error::None;
  std::string last_error_message = {};
};

struct barrier_options {
  // Absolute yijinjing monotonic time. Zero means no caller deadline. A
  // deadline can stop work before a new barrier starts; once barrier I/O has
  // begun, expiry is reported as unknown and reconciled by request id.
  int64_t deadline_at_ns = 0;
};

struct barrier_result {
  durability_receipt receipt = {};
  ingest_status status = {};
  ingest_error error = ingest_error::None;
  std::string message = {};
};

enum class reconciliation_state : uint8_t { Reconciled, Unknown, TerminalFailure };

// Edge-ready view of the C++ receipt authority. A missing request after a
// restart remains Unknown: callers must retry the original fact and request id
// rather than infer success or failure from absence.
struct receipt_reconciliation_view {
  std::string schema = DURABILITY_RECONCILIATION_SCHEMA_V1;
  uint64_t request_id = 0;
  std::string state = {};
  bool recovered = false;
  std::optional<durability_receipt_view> receipt = std::nullopt;
  std::string error = {};
  std::string message = {};
};

// The logical frame context needed to reconstruct existing state<DataType>
// routing and ordering without depending on a live mmap frame address.
struct durable_frame_context {
  int64_t gen_time = 0;
  int64_t trigger_time = 0;
  uint32_t source = 0;
  uint32_t dest = 0;
  int32_t data_type = 0;
  uint32_t initial_source = 0;
  uint64_t trigger_frame_uid = 0;

  friend bool operator==(const durable_frame_context &, const durable_frame_context &) = default;
};

struct durable_record {
  uint64_t segment_id = 0;
  uint64_t segment_offset = 0;
  uint64_t record_size = 0;
  stream_position position = {};
  int32_t carrier_type = 0;
  durable_frame_context frame = {};
  uint64_t owner_generation = 0;
  uint64_t writer_generation = 0;
  std::string payload_sha256 = {};
  std::string record_sha256 = {};
  std::string payload = {};
};

using ingest_fault_injector = std::function<void(ingest_fault_point)>;

// One append-only durable container per logical stream epoch. It is separate
// from the mmap hot path: appends and barriers never run inside writer frame
// publication unless an explicit caller chooses a durable profile.
class durable_ingest_log {
public:
  explicit durable_ingest_log(ingest_options options, ingest_fault_injector fault_injector = {});
  ~durable_ingest_log();
  durable_ingest_log(const durable_ingest_log &) = delete;
  durable_ingest_log &operator=(const durable_ingest_log &) = delete;

  void append(const stream_position &position, int32_t carrier_type, const void *payload, size_t payload_size,
              const yijinjing::ownership::lease &service_owner, const yijinjing::ownership::lease &writer_owner);
  void append(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
              const void *payload, size_t payload_size, const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::lease &writer_owner);
  void append(const stream_position &position, int32_t carrier_type, const void *payload, size_t payload_size,
              const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::evidence &writer_generation);
  void append(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
              const void *payload, size_t payload_size, const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::evidence &writer_generation);
  void append(const stream_position &position, int32_t carrier_type, const std::string &payload,
              const yijinjing::ownership::lease &service_owner, const yijinjing::ownership::lease &writer_owner) {
    append(position, carrier_type, payload.data(), payload.size(), service_owner, writer_owner);
  }
  void append(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
              const std::string &payload, const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::lease &writer_owner) {
    append(position, carrier_type, frame, payload.data(), payload.size(), service_owner, writer_owner);
  }
  void append(const stream_position &position, int32_t carrier_type, const std::string &payload,
              const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::evidence &writer_generation) {
    append(position, carrier_type, payload.data(), payload.size(), service_owner, writer_generation);
  }
  void append(const stream_position &position, int32_t carrier_type, const durable_frame_context &frame,
              const std::string &payload, const yijinjing::ownership::lease &service_owner,
              const yijinjing::ownership::evidence &writer_generation) {
    append(position, carrier_type, frame, payload.data(), payload.size(), service_owner, writer_generation);
  }

  [[nodiscard]] barrier_result barrier(uint64_t request_id, durability_profile profile,
                                       const yijinjing::ownership::lease &service_owner,
                                       const yijinjing::ownership::lease &writer_owner);
  [[nodiscard]] barrier_result barrier(uint64_t request_id, durability_profile profile,
                                       const yijinjing::ownership::lease &service_owner,
                                       const yijinjing::ownership::lease &writer_owner, barrier_options options);
  [[nodiscard]] barrier_result barrier(uint64_t request_id, durability_profile profile,
                                       const yijinjing::ownership::lease &service_owner);
  [[nodiscard]] barrier_result barrier(uint64_t request_id, durability_profile profile,
                                       const yijinjing::ownership::lease &service_owner, barrier_options options);
  [[nodiscard]] barrier_result barrier(const durability_request &request,
                                       const yijinjing::ownership::lease &service_owner,
                                       const yijinjing::ownership::lease &writer_owner, barrier_options options = {});
  [[nodiscard]] barrier_result barrier(const durability_request &request,
                                       const yijinjing::ownership::lease &service_owner, barrier_options options = {});
  [[nodiscard]] receipt_reconciliation_view reconcile(const durability_request &request);
  [[nodiscard]] ingest_status status() const;
  // Reads only the checkpoint-covered chain. Unknown tails are never returned
  // as durable records; any identity, ordering, or checksum disagreement
  // fails the inspection.
  [[nodiscard]] std::vector<durable_record> read_durable_records() const;

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

[[nodiscard]] const char *ingest_error_name(ingest_error error) noexcept;
[[nodiscard]] const char *reconciliation_state_name(reconciliation_state state) noexcept;

// Opens the named stream read-only and reconciles one request against the
// checkpoint-covered receipt index. This is the shared C++ authority used by
// Python, Node and CLI inspection surfaces.
[[nodiscard]] receipt_reconciliation_view reconcile_durable_receipt(ingest_options options,
                                                                    const durability_request &request);

} // namespace kungfu::runtime::durability

#endif // KUNGFU_RUNTIME_DURABLE_INGEST_H
