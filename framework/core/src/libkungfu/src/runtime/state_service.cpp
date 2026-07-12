// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/state_service.h>

#include <filesystem>
#include <map>
#include <mutex>
#include <stdexcept>
#include <utility>

#include <kungfu/runtime/state_cache/manager.h>

namespace kungfu::runtime::state_service {

namespace {

durability::barrier_result unavailable_barrier(uint64_t request_id, durability::durability_profile profile,
                                               const std::string &message) {
  durability::barrier_result result;
  result.receipt.request_id = request_id;
  result.receipt.requested_profile = profile;
  result.receipt.status = durability::receipt_status::Unknown;
  result.receipt.error = durability::durability_error_code::ServiceUnavailable;
  result.error = durability::ingest_error::ServiceUnavailable;
  result.message = message;
  result.status.available = false;
  result.status.last_error = durability::ingest_error::ServiceUnavailable;
  result.status.last_error_message = message;
  return result;
}

} // namespace

struct service::impl {
  explicit impl(const io_device_ptr &io_device)
      : ownership(yijinjing::ownership::lease::acquire_data_root_service(io_device->get_locator()->get_root())),
        manager(io_device) {}

  void require_write_authority() const {
    if (!ownership.owns()) {
      throw std::logic_error("state_service_ownership_lost");
    }
    if (!manager.running()) {
      throw std::logic_error("state_service_not_running");
    }
  }

  yijinjing::ownership::lease ownership;
  state_cache::manager manager;
  std::map<std::pair<uint64_t, uint64_t>, std::unique_ptr<durability::durable_ingest_log>> durable_shadows;
  mutable std::mutex durable_shadows_mutex;
};

service::service(const io_device_ptr &io_device) : impl_(std::make_unique<impl>(io_device)) {}

service::~service() { stop(); }

void service::start() { impl_->manager.start(); }

void service::stop() { impl_->manager.stop(); }

service_status service::status() const { return {impl_->ownership.status(), impl_->manager.running()}; }

std::vector<yijinjing::types::Location> service::locations() {
  return impl_->manager.get_all(yijinjing::types::Location{});
}

std::vector<yijinjing::types::Config> service::configs() { return impl_->manager.get_all(yijinjing::types::Config{}); }

void service::record_location(const yijinjing::types::Location &location) {
  impl_->require_write_authority();
  impl_->manager.feed_profile(location);
}

void service::reset_cache_shift(const yijinjing::data::location_ptr &location) {
  impl_->require_write_authority();
  impl_->manager.reset_cache_shift(location);
}

void service::ensure_storage(const yijinjing::data::location_ptr &location, uint32_t dest) {
  impl_->require_write_authority();
  impl_->manager.try_ensure_cached_storage(location, dest);
}

void service::restore(const yijinjing::data::location_ptr &location, const yijinjing::journal::writer_ptr &writer) {
  impl_->require_write_authority();
  impl_->manager.restore(location, writer);
}

void service::cache_reset(const event_ptr &event) {
  impl_->require_write_authority();
  impl_->manager.cache_reset(event);
}

void service::pause_projection(bool pause) {
  impl_->require_write_authority();
  impl_->manager.switch_feed_storage(pause);
}

void service::ingest(const event_ptr &event) {
  impl_->require_write_authority();
  impl_->manager.feed(event);
}

void service::open_durable_shadow(durability::ingest_options options) {
  impl_->require_write_authority();
  if (std::filesystem::absolute(options.data_root).lexically_normal() !=
      std::filesystem::absolute(impl_->ownership.status().data_root).lexically_normal()) {
    throw std::invalid_argument("durable shadow data root does not match state service ownership");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto key = std::make_pair(options.stream_id, options.container_epoch);
  if (impl_->durable_shadows.contains(key)) {
    throw std::logic_error("durable shadow stream epoch is already open");
  }
  impl_->durable_shadows.emplace(key, std::make_unique<durability::durable_ingest_log>(std::move(options)));
}

void service::append_durable_shadow(const durability::stream_position &position, int32_t carrier_type,
                                    const std::string &payload,
                                    const yijinjing::ownership::evidence &writer_generation) {
  impl_->require_write_authority();
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({position.stream_id, position.container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durable shadow stream epoch is not open");
  }
  found->second->append(position, carrier_type, payload.data(), payload.size(), impl_->ownership, writer_generation);
}

durability::barrier_result service::barrier_durable_shadow(uint64_t stream_id, uint64_t container_epoch,
                                                           uint64_t request_id, durability::durability_profile profile,
                                                           durability::barrier_options options) {
  if (!impl_->ownership.owns() || !impl_->manager.running()) {
    return unavailable_barrier(request_id, profile, "state_service_not_running_or_fenced");
  }
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({stream_id, container_epoch});
  if (found == impl_->durable_shadows.end()) {
    return unavailable_barrier(request_id, profile, "durable_shadow_stream_epoch_not_open");
  }
  return found->second->barrier(request_id, profile, impl_->ownership, options);
}

durability::ingest_status service::durable_shadow_status(uint64_t stream_id, uint64_t container_epoch) const {
  std::lock_guard lock(impl_->durable_shadows_mutex);
  const auto found = impl_->durable_shadows.find({stream_id, container_epoch});
  if (found == impl_->durable_shadows.end()) {
    throw std::logic_error("durable shadow stream epoch is not open");
  }
  return found->second->status();
}

} // namespace kungfu::runtime::state_service
