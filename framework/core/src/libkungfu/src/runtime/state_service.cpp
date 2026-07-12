// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/state_service.h>

#include <stdexcept>
#include <utility>

#include <kungfu/runtime/state_cache/manager.h>

namespace kungfu::runtime::state_service {

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

} // namespace kungfu::runtime::state_service
