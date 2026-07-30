// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2019-06-15.
//

#ifndef KUNGFU_RUNTIME_LIVE_COORDINATOR_H
#define KUNGFU_RUNTIME_LIVE_COORDINATOR_H

#include <utility>

#include <kungfu/runtime/common.h>

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/live/continuity.h>
#include <kungfu/runtime/live/reactor.h>
#include <kungfu/runtime/state_service.h>
#include <kungfu/yijinjing/journal/common.h>

namespace kungfu::runtime::live {

struct timer_task {
  int64_t checkpoint;
  int64_t duration;
  int64_t repeat_limit;
  int64_t repeat_count;
};

class coordinator : public reactor {
public:
  explicit coordinator(const yijinjing::data::location_ptr &home, bool low_latency = false,
                       state_service::durability_candidate_config durability_candidate = {},
                       state_service::projection_candidate_config projection_candidate = {},
                       coordinator_authority continuity_authority = {});

  explicit coordinator(const kungfu::runtime::io_device_ptr &io_device,
                       state_service::durability_candidate_config durability_candidate = {},
                       state_service::projection_candidate_config projection_candidate = {},
                       coordinator_authority continuity_authority = {});
  [[nodiscard]] const coordinator_authority &continuity_authority() const { return continuity_authority_; }
  [[nodiscard]] state_service::service_status state_service_status() const { return state_service_.status(); }

  // Configured durability execution remains owned by the state-service
  // boundary. These narrow forwards let product bindings execute the admitted
  // request/receipt protocol without exposing the service object itself.
  void open_durability_candidate(durability::ingest_options options) {
    state_service_.open_durability_candidate(std::move(options));
  }
  void append_durability_candidate(const durability::stream_position &position, int32_t carrier_type,
                                   const durability::durable_frame_context &frame, const std::string &payload,
                                   const yijinjing::ownership::evidence &writer_generation) {
    state_service_.append_durability_candidate(position, carrier_type, frame, payload, writer_generation);
  }
  [[nodiscard]] durability::barrier_result request_durability_candidate(const durability::durability_request &request,
                                                                        durability::barrier_options options = {}) {
    return state_service_.request_durability_candidate(request, options);
  }
  [[nodiscard]] durability::receipt_reconciliation_view
  reconcile_durability_candidate(const durability::durability_request &request) {
    return state_service_.reconcile_durability_candidate(request);
  }
  [[nodiscard]] durability::ingest_status durability_candidate_status(uint64_t stream_id,
                                                                      uint64_t container_epoch) const {
    return state_service_.durability_candidate_status(stream_id, container_epoch);
  }

  void on_exit() override;

  void notify_deregister_on_exit();

  void notify_coordinator_deregister_on_exit();

  void on_notify() override;

  // React hook mirroring peer::on_react(): a subclass (including a Python
  // subclass via the binding) overrides this to install frame subscriptions via
  // observe() before coordinator::react() connects the event stream. Default
  // is empty so the native coordinator behaviour is unchanged.
  virtual void on_react();

  virtual void on_register(int64_t gen_time, const yijinjing::types::Register &register_data) = 0;

  virtual bool check_register(int64_t gen_time, const yijinjing::types::Register &register_data) = 0;

  virtual void on_interval_check(int64_t nanotime) = 0;

  void register_peer(const event_ptr &event);

  void deregister_peer(int64_t trigger_time, uint32_t peer_location_uid);

  void on_request_deregister(const event_ptr &event);

  bool is_reactable(const event_ptr &event) override;

  void pre_setup() override;

protected:
  int64_t last_check_;
  state_service::service state_service_;
  coordinator_authority continuity_authority_;

  std::unordered_map<uint32_t, uint32_t> peer_cmd_locations_ = {};
  std::unordered_map<uint32_t, std::unordered_map<int32_t, timer_task>> timer_tasks_ = {};

  void react() override;

  void on_active() final;

  void on_frame() final;

  void try_add_location(int64_t trigger_time, const yijinjing::data::location_ptr &peer_location);

private:
  void handle_timer_tasks();

  // Route guard: accept RequestStop only when it targets a SYSTEM location in a
  // coordinator wire namespace. Named so it can be referenced by the route
  // declaration and exercised on its own (KF-ADR-019f86da-4f90-786d-9fd5-468c3f3d231b); the behaviour is unchanged
  // from the inline filter it replaces.
  [[nodiscard]] bool dest_is_coordinator_wire(const event_ptr &event) const;

  void feed(const event_ptr &event);

  void pong(const event_ptr &event);

  void on_request_write_to_outlet(const event_ptr &event);

  void on_request_write_to(const event_ptr &event);

  void on_request_read_from(const event_ptr &event);

  void on_request_read_from_public(const event_ptr &event);

  void on_request_read_from_sync(const event_ptr &event);

  void on_request_read_from_others(const event_ptr &event);

  void on_channel_request(const event_ptr &event);

  void on_time_request(const event_ptr &event);

  void on_new_location(const event_ptr &event);

  static void write_time_reset(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_locations(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_registries(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_channels(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);

  void write_bands(int64_t trigger_time, const yijinjing::journal::writer_ptr &writer);
};
} // namespace kungfu::runtime::live
#endif // KUNGFU_RUNTIME_LIVE_COORDINATOR_H
