// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STATE_SERVICE_H
#define KUNGFU_RUNTIME_STATE_SERVICE_H

#include <memory>
#include <string>
#include <vector>

#include <kungfu/runtime/common.h>
#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu::runtime::state_service {

struct durability_candidate_config {
  bool enabled = false;
  std::string qualification_profile = {};
  // Internal fixture seam only. Product bindings never accept this value;
  // current-hardware admission is re-derived by libkungfu.
  bool qualification_passed = false;
  std::string contract_hash = {};
  std::string policy_digest = {};
  std::string default_profile = "visible";
  bool strong_profiles_requested = false;
  uint64_t segment_max_bytes = 64ULL * 1024ULL * 1024ULL;
  uint64_t request_timeout_ms = 5000;
  bool reconcile_on_timeout = true;
  std::string failure_policy = "fail-closed";
  uint64_t group_max_delay_ms = 10;
  uint64_t group_max_records = 32;
  uint64_t group_max_bytes = 1024ULL * 1024ULL;
};

struct projection_candidate_config {
  bool enabled = false;
  std::string qualification_profile = {};
  bool qualification_passed = false;
  uint64_t stream_id = 0;
  uint64_t container_epoch = 0;
  std::string writer_resource_id = {};
  std::string projection_name = "typed-peer-state";
  std::string projection_schema = "kungfu.typed-state-projection.v1";
};

struct service_status {
  yijinjing::ownership::evidence ownership = {};
  bool running = false;
  bool durability_candidate_enabled = false;
  bool durability_candidate_qualified = false;
  std::string durability_qualification_profile = {};
  std::string durability_contract_hash = {};
  std::string durability_policy_digest = {};
  std::string durability_default_profile = "visible";
  std::string durability_admission_reason = {};
  uint64_t durability_segment_max_bytes = 64ULL * 1024ULL * 1024ULL;
  uint64_t durability_request_timeout_ms = 5000;
  bool durability_reconcile_on_timeout = true;
  std::string durability_failure_policy = "fail-closed";
  uint64_t durability_group_max_delay_ms = 10;
  uint64_t durability_group_max_records = 32;
  uint64_t durability_group_max_bytes = 1024ULL * 1024ULL;
  bool projection_candidate_enabled = false;
  bool projection_candidate_qualified = false;
  std::string projection_qualification_profile = {};
};

// Compatibility implementation of the KF-ADR-019f86da-4f90-7ec5-a83c-99cfaee56aca state-service boundary.
// It remains in the coordinator process for this migration stage, but owns the
// state-cache/projection lifecycle and the sole data-root write authority.
class service {
public:
  explicit service(const io_device_ptr &io_device, durability_candidate_config candidate = {},
                   projection_candidate_config projection_candidate = {});
  ~service();
  service(const service &) = delete;
  service &operator=(const service &) = delete;

  void start();
  void stop();
  [[nodiscard]] service_status status() const;

  [[nodiscard]] std::vector<yijinjing::types::Location> locations();
  [[nodiscard]] std::vector<yijinjing::types::Config> configs();

  void record_location(const yijinjing::types::Location &location);
  void reset_cache_shift(const yijinjing::data::location_ptr &location);
  void ensure_storage(const yijinjing::data::location_ptr &location, uint32_t dest);
  void restore(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer);
  void cache_reset(const event_ptr &event);
  void pause_projection(bool pause);
  void ingest(const event_ptr &event);

  void open_durable_shadow(durability::ingest_options options);
  void append_durable_shadow(const durability::stream_position &position, int32_t carrier_type,
                             const std::string &payload, const yijinjing::ownership::evidence &writer_generation);
  void append_durable_shadow(const durability::stream_position &position, int32_t carrier_type,
                             const durability::durable_frame_context &frame, const std::string &payload,
                             const yijinjing::ownership::evidence &writer_generation);
  [[nodiscard]] durability::barrier_result barrier_durable_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                                  uint64_t request_id,
                                                                  durability::durability_profile profile,
                                                                  durability::barrier_options options = {});
  [[nodiscard]] durability::ingest_status durable_shadow_status(uint64_t stream_id, uint64_t container_epoch) const;

  // Explicit production-candidate surface. It is disabled by default and is
  // admitted only when the configured candidate profile matches local
  // qualification evidence. It deliberately does not imply production
  // eligibility.
  void open_durability_candidate(durability::ingest_options options);
  void append_durability_candidate(const durability::stream_position &position, int32_t carrier_type,
                                   const std::string &payload, const yijinjing::ownership::evidence &writer_generation);
  void append_durability_candidate(const durability::stream_position &position, int32_t carrier_type,
                                   const durability::durable_frame_context &frame, const std::string &payload,
                                   const yijinjing::ownership::evidence &writer_generation);
  [[nodiscard]] durability::barrier_result request_durability_candidate(const durability::durability_request &request,
                                                                        durability::barrier_options options = {});
  [[nodiscard]] durability::receipt_reconciliation_view
  reconcile_durability_candidate(const durability::durability_request &request);
  [[nodiscard]] durability::ingest_status durability_candidate_status(uint64_t stream_id,
                                                                      uint64_t container_epoch) const;

  void open_projection_shadow(projection_options options, durable_projector projector);
  [[nodiscard]] projection_snapshot
  rebuild_projection_shadow(uint64_t stream_id, uint64_t container_epoch, const std::string &projection_name,
                            std::optional<durability::stream_position> through = std::nullopt);
  [[nodiscard]] bootstrap_result bootstrap_projection_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                             const std::string &projection_name,
                                                             peer_state_requirement requirement);
  [[nodiscard]] projection_status projection_shadow_status(uint64_t stream_id, uint64_t container_epoch,
                                                           const std::string &projection_name) const;

  [[nodiscard]] projection_snapshot
  rebuild_projection_candidate(std::optional<durability::stream_position> through = std::nullopt);
  [[nodiscard]] projection_candidate_result
  bootstrap_projection_candidate(const peer_projection_declaration &declaration,
                                 const std::optional<projection_compatibility_view> &compatibility = std::nullopt);
  [[nodiscard]] projection_status projection_candidate_status() const;

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_STATE_SERVICE_H
