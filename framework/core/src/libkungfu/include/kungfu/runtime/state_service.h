// SPDX-License-Identifier: Apache-2.0

#ifndef KUNGFU_RUNTIME_STATE_SERVICE_H
#define KUNGFU_RUNTIME_STATE_SERVICE_H

#include <memory>
#include <vector>

#include <kungfu/runtime/common.h>
#include <kungfu/runtime/io.h>
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

private:
  struct impl;
  std::unique_ptr<impl> impl_;
};

} // namespace kungfu::runtime::state_service

#endif // KUNGFU_RUNTIME_STATE_SERVICE_H
