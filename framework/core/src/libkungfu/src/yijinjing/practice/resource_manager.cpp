
#include <kungfu/yijinjing/practice/apprentice.h>

using namespace kungfu::practice;
using namespace kungfu::longfist::enums;

namespace kungfu::practice {

resource_manager::resource_manager(apprentice &app) : app_(app) {}

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
    app_.get_bus()->wait();
    app_.preload_next_page();
    app_.release_page();
    if (m_quit_) {
      break;
    }
  }
}

bool resource_manager::is_resource_management_worker_required() const {
  return app_.get_bus()->is_on_load_page_required();
}

resource_manager::~resource_manager() {
  m_quit_ = true;
  app_.get_bus()->notify_all();

  if (resource_management_worker.joinable()) {
    resource_management_worker.join();
    SPDLOG_INFO("~resource_manager resource_management_worker joined");
  }
}

} // namespace kungfu::practice