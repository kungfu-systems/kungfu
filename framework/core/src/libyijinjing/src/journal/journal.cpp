// SPDX-License-Identifier: Apache-2.0

#include <algorithm>

#include <kungfu/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::yijinjing::journal {

page_lifecycle_parse_result parse_page_lifecycle(const char *keep_page_value, const char *max_pre_create_size_value) {
  page_lifecycle_parse_result result = {};
  // Presence means enabled: this preserves the historical getenv() contract,
  // where any value (including an empty one) turned the knob on.
  result.policy.keep_page = keep_page_value != nullptr;

  if (max_pre_create_size_value == nullptr) {
    return result;
  }
  try {
    result.policy.max_pre_create_size_mb = static_cast<uint32_t>(std::stoul(max_pre_create_size_value));
  } catch (const std::exception &) {
    // An unusable setting is reported as a value, not swallowed here. The
    // entry layer owns the diagnostic: this function must stay pure so it can
    // be tested without touching the process environment.
    result.policy.max_pre_create_size_mb = 0;
    result.status = page_lifecycle_parse_status::max_pre_create_size_invalid;
  }
  return result;
}

journal::journal(data::location_ptr location, uint32_t dest_id, journal_open_policy policy, bool low_latency,
                 bus_ptr bus, uint64_t page_size, yijinjing::enums::Priority priority)
    : location_(std::move(location)), dest_id_(dest_id), policy_(policy), low_latency_(low_latency),
      bus_(std::move(bus)), frame_(std::shared_ptr<frame>(new frame())), page_frame_nb_(0u), page_size_(page_size),
      priority_(priority) {
  SPDLOG_TRACE("keep_page: {}, low_latency_: {}, max_pre_create_size_mb: {}", keep_page(), low_latency_,
               max_pre_create_size_mb());
}

journal::journal(const journal &other)
    : location_(other.location_), dest_id_(other.dest_id_), page_size_(other.page_size_), policy_(other.policy_),
      low_latency_(other.low_latency_), bus_(other.bus_), page_frame_nb_(other.page_frame_nb_),
      priority_(other.priority_) {
  pre_create_page_ = other.pre_create_page_;
  page_ = other.page_;
  frame_ = std::make_shared<frame>(*other.frame_);
}

journal::~journal() {
  if (page_) {
    page_.reset();
  }

  for (auto &page : passed_page_collector_) {
    page.reset();
  }
  passed_page_collector_.clear();
}

void journal::next() {
  assert(page_.get() != nullptr);
  if (frame_->carrier_type() == yijinjing::types::PageEnd::tag) {
    load_next_page();
    try_load_next_extra_page();
  } else {
    frame_->move_to_next();
    page_frame_nb_++;
  }
}

void journal::seek_to_time(int64_t nanotime) {
  uint32_t page_id = page::find_page_id(location_, dest_id_, nanotime);
  load_page(page_id);
  while (page_->is_full() && page_->end_time() <= nanotime) {
    load_next_page();
  }
  try_load_next_extra_page();
  while (frame_->has_data() && frame_->gen_time() <= nanotime) {
    next();
  }
}

void journal::load_page(uint32_t page_id) {
  auto fn_load = [&]() {
    if (not page_ or page_->get_page_id() != page_id) {
      if (page_) {
        if (bus_->is_on_load_page_required()) {
          std::lock_guard<std::mutex> lk_passed_page(passed_page_collector_mtx_);
          passed_page_collector_.push_back(std::move(page_));
        } else if (keep_page()) {
          passed_page_collector_.push_back(std::move(page_));
        }
      }

      if (low_latency_ and preload_page_ and preload_page_->get_page_id() == page_id) {
        page_ = std::move(preload_page_);
        page_->enable_page();
      } else {
        // A coordinator reader joins a freshly-registered peer's PUBLIC / SYNC /
        // command journals (coordinator::register_peer) before that peer has
        // opened its own writers, so the page may not exist yet. Create it here
        // — the "create sync journal" intent at the register site — rather than
        // failing the read-only open. The peer subsequently opens the same page
        // as a writer. Guarded so only the coordinator reader
        // (precreation == coordinator) and only a genuinely missing page take
        // this path; normal readers and existing pages are unaffected.
        auto page_policy = policy_.current_page;
        if (policy_.precreation == page_precreation::coordinator and
            not page::check_page_existed(location_, dest_id_, page_id)) {
          page_policy = page_open_policy::coordinator_precreate();
        }
        page_ = page::load(location_, dest_id_, page_size_, page_id, page_policy);
      }
    }
    frame_->set_address(page_->first_frame_address());
    page_frame_nb_ = 0u;
  };

  if (low_latency_) {
    std::lock_guard<std::mutex> lk_load_page(load_page_mtx_);
    fn_load();
    bus_->on_load_page();
  } else {
    fn_load();
  }
}

void journal::load_next_page() { load_page(page_->get_page_id() + 1); }

void journal::preload_next_page() {
  std::lock_guard<std::mutex> lk(load_page_mtx_);
  if ((not low_latency_ or not page_) or                                                   //
      (preload_page_ and preload_page_->get_page_id() == page_->get_page_id() + 1) or      //
      page_->is_pre_open() or                                                              //
      (not page::check_page_existed(location_, page_->dest_id_, page_->get_page_id() + 1)) //
  ) {
    return;
  }
  preload_page_ = page::load(location_, dest_id_, page_size_, page_->get_page_id() + 1, policy_.preload_page);
  SPDLOG_TRACE("journal: {} ", page::get_page_path(location_, dest_id_, preload_page_->get_page_id()));
}

// Save page-switch time for other processes. This path is only used by the
// coordinator reader in low-latency mode.
void journal::try_load_next_extra_page() {
  if (policy_.precreation != page_precreation::coordinator || !low_latency_ ||                //
      page_->is_pre_open() ||                                                                 //
      max_pre_create_size_mb() > 0 and page_->get_page_size() > max_pre_create_size_mb() * MB //
  ) {
    return;
  }
  pre_create_page_ = page::load(location_, dest_id_, page_->get_page_size(), page_->get_page_id() + 1,
                                page_open_policy::coordinator_precreate());
}

void journal::release_page() {
  if (keep_page()) {
    return;
  }

  // Drop journal/resource-manager ownership promptly. An external page lease
  // keeps the mapping alive until its own final release; refcount observation
  // is not a scheduling protocol and the resource worker never polls it.
  //
  // `released` looks unused on purpose: taking the handles under the lock and
  // letting them die at end of scope *is* the release, and it keeps the page
  // destructors (which unmap) off the collector mutex.
  std::vector<page_ptr> released;
  {
    std::lock_guard<std::mutex> lk_passed_page(passed_page_collector_mtx_);
    released.swap(passed_page_collector_);
  }
}

void journal::close_page(int64_t trigger_time, int64_t last_gen_time) {
  page_ptr last_page = page_;

  // must load_next_page before mark PageEnd::tag,
  // or reader of other process may read next page before it created
  load_next_page();

  frame last_page_frame;
  last_page_frame.set_address(last_page->last_frame_address());
  // A writer may be reopened for each logical append. If that fresh writer is
  // the one that rolls a full page, its in-memory last_gen_time is still zero.
  // The page itself is authoritative: preserve the final published frame's
  // time so a cold reader seeking from time zero does not skip the page.
  const auto persisted_last_gen_time = last_page_frame.gen_time();
  last_page_frame.move_to_next();
  last_page_frame.set_header_length();
  last_page_frame.set_trigger_time(trigger_time);
  last_page_frame.set_carrier_type(yijinjing::types::PageEnd::tag);
  last_page_frame.set_source(location_->uid);
  last_page_frame.set_dest(dest_id_);
  last_page_frame.set_gen_time(std::max(last_gen_time, persisted_last_gen_time));
  last_page->set_last_frame_position(last_page_frame.address() - last_page->address());
  last_page_frame.publish_data_length(0);
}

} // namespace kungfu::yijinjing::journal
