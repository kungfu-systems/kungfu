// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STATE_SERVICE_H
#define KUNGFU_RUNTIME_STATE_SERVICE_H

#include <memory>
#include <vector>

#include <kungfu/runtime/common.h>
#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/schema/core.h>

namespace kungfu::runtime::state_service {

struct service_status {
  yijinjing::ownership::evidence ownership = {};
  bool running = false;
};

// Compatibility implementation of the ADR-0068 state-service boundary.
// It remains in the coordinator process for this migration stage, but owns the
// state-cache/projection lifecycle and the sole data-root write authority.
class service {
public:
  explicit service(const io_device_ptr &io_device);
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

  void open_projection_shadow(projection_options options, durable_projector projector);
  [[nodiscard]] projection_snapshot
  rebuild_projection_shadow(uint64_t stream_id, uint64_t container_epoch, const std::string &projection_name,
                            std::optional<durability::stream_position> through = std::nullopt);
  [[nodiscard]] bootstrap_result bootstrap_projection_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                             const std::string &projection_name,
                                                             peer_state_requirement requirement);
  [[nodiscard]] projection_status projection_shadow_status(uint64_t stream_id, uint64_t container_epoch,
                                                           const std::string &projection_name) const;

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_STATE_SERVICE_H
