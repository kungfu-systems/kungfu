
#include <kungfu/runtime/live/peer.h>

using namespace kungfu::runtime::live;
using namespace kungfu::yijinjing::enums;

namespace kungfu::runtime::live {

resource_manager::resource_manager(peer &runtime_peer) : peer_(runtime_peer) {}

std::thread &resource_manager::get_resource_management_worker() { return resource_management_worker; }

void resource_manager::on_react() {
  if (not is_resource_management_worker_required()) {
    return;
  }
  SPDLOG_INFO("using page resource_manager");
  if (not resource_management_worker.joinable()) {
    resource_management_worker = std::thread(&resource_manager::do_management, this);
  }
  SPDLOG_DEBUG("get_resource_management_worker thread id: {}", resource_management_worker.get_id());
}

void resource_manager::do_management() {
  while (true) {
    peer_.get_bus()->wait();
    peer_.preload_next_page();
    peer_.release_page();
    if (m_quit_) {
      break;
    }
  }
}

bool resource_manager::is_resource_management_worker_required() const {
  return peer_.get_bus()->is_on_load_page_required();
}

resource_manager::~resource_manager() {
  m_quit_ = true;
  peer_.get_bus()->notify_all();

  if (resource_management_worker.joinable()) {
    resource_management_worker.join();
    SPDLOG_INFO("~resource_manager resource_management_worker joined");
  }
}

} // namespace kungfu::runtime::live