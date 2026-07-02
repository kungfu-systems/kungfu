// SPDX-License-Identifier: Apache-2.0

#include <kungfu/common.h>
#include <kungfu/longfist/core.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::yijinjing::journal {

journal::journal(data::location_ptr location, uint32_t dest_id, bool is_writing, bool lazy, bool low_latency,
                 bus_ptr bus, uint64_t page_size, longfist::enums::Priority priority)
    : location_(std::move(location)), dest_id_(dest_id), is_writing_(is_writing), lazy_(lazy),
      low_latency_(low_latency), bus_(std::move(bus)), frame_(std::shared_ptr<frame>(new frame())), page_frame_nb_(0u),
      page_size_(page_size), priority_(priority), replica_(false) {
  keep_page_ = std::getenv("KF_KEEP_PAGE") != nullptr;
  char *pre_create_size = std::getenv("KF_MAX_PRE_CREATE_SIZE");
  try {
    if (pre_create_size != nullptr) {
      max_pre_create_size_ = std::stoul(pre_create_size);
    }
  } catch (std::exception &e) {
    SPDLOG_ERROR("failed to parse KF_MAX_PRE_CREATE_SIZE: {}", e.what());
    max_pre_create_size_ = 0;
  }
  SPDLOG_TRACE("keep_page_: {}, low_latency_: {}, max_pre_create_size_: {}", keep_page_, low_latency_,
               max_pre_create_size_);
}

journal::journal(const journal &other)
    : location_(other.location_), dest_id_(other.dest_id_), page_size_(other.page_size_),
      is_writing_(other.is_writing_), lazy_(other.lazy_), low_latency_(other.low_latency_), bus_(other.bus_),
      page_frame_nb_(other.page_frame_nb_), priority_(other.priority_) {
  pre_create_page_ = other.pre_create_page_;
  page_ = other.page_;
  frame_ = std::make_shared<frame>(*other.frame_);
  replica_ = true;
}

journal::~journal() {
  if (page_) {
    page_.reset();
  }
  keep_page_ = false;

  for (auto &page : passed_page_collector_) {
    page.reset();
  }
  passed_page_collector_.clear();
}

void journal::next() {
  assert(page_.get() != nullptr);
  if (frame_->msg_type() == longfist::types::PageEnd::tag) {
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
          std::lock_guard<std::recursive_mutex> lk_passed_page(passed_page_collector_mtx_);
          passed_page_collector_.push_back(std::move(page_));
        } else if (keep_page_) {
          passed_page_collector_.push_back(std::move(page_));
        }
      }

      if (low_latency_ and preload_page_ and preload_page_->get_page_id() == page_id) {
        page_ = std::move(preload_page_);
        page_->enable_page();
      } else {
        page_ = page::load(location_, dest_id_, page_size_, page_id, is_writing_, lazy_);
      }
    }
    frame_->set_address(page_->first_frame_address());
    page_frame_nb_ = 0u;
  };

  if (low_latency_) {
    std::lock_guard<std::recursive_mutex> lk_load_page(load_page_mtx_);
    fn_load();
    bus_->on_load_page();
  } else {
    fn_load();
  }
}

void journal::load_next_page() { load_page(page_->get_page_id() + 1); }

void journal::preload_next_page() {
  std::lock_guard<std::recursive_mutex> lk(load_page_mtx_);
  if ((not low_latency_ or not page_) or                                                   //
      (preload_page_ and preload_page_->get_page_id() == page_->get_page_id() + 1) or      //
      (page_->header_->status == longfist::enums::PageStatus::PreOpen) or                  //
      (not page::check_page_existed(location_, page_->dest_id_, page_->get_page_id() + 1)) //
  ) {
    return;
  }
  preload_page_ = page::load(location_, dest_id_, page_size_, page_->get_page_id() + 1, is_writing_, lazy_, true);
  SPDLOG_TRACE("journal: {} ", page::get_page_path(location_, dest_id_, preload_page_->get_page_id()));
}

// saving time for other process switch page, except the master
// only for master reading, and low_latency mode
void journal::try_load_next_extra_page() {
  if (lazy_ || is_writing_ || !low_latency_ ||                                        //
      page_->is_pre_open() ||                                                         //
      max_pre_create_size_ > 0 and page_->get_page_size() > max_pre_create_size_ * MB //
  ) {
    return;
  }
  pre_create_page_ =
      page::load(location_, dest_id_, page_->get_page_size(), page_->get_page_id() + 1, false, lazy_, true);
}

void journal::release_page() {
  if (keep_page_) {
    return;
  }

  static thread_local std::vector<page_ptr> queue_release_page{};
  {
    std::lock_guard<std::recursive_mutex> lk_passed_page(passed_page_collector_mtx_);
    if (passed_page_collector_.empty()) {
      return;
    }

    for (auto &page : passed_page_collector_) {
      queue_release_page.push_back(std::move(page));
    }
    passed_page_collector_.clear();
  }

  for (auto &page : queue_release_page) {
    // wait for the main thread to release shared_ptr<page>, or page would close in the main thread
    while (page.use_count() > 1 and not replica_) {
      std::this_thread::sleep_for(std::chrono::microseconds(1));
    }
    page.reset();
  }
  queue_release_page.clear();
}

void journal::close_page(int64_t trigger_time, int64_t last_gen_time) {
  page_ptr last_page = page_;

  // must load_next_page before mark PageEnd::tag,
  // or reader of other process may read next page before it created
  load_next_page();

  frame last_page_frame;
  last_page_frame.set_address(last_page->last_frame_address());
  last_page_frame.move_to_next();
  last_page_frame.set_header_length();
  last_page_frame.set_trigger_time(trigger_time);
  last_page_frame.set_msg_type(longfist::types::PageEnd::tag);
  last_page_frame.set_source(location_->uid);
  last_page_frame.set_dest(dest_id_);
  last_page_frame.set_gen_time(last_gen_time);
  last_page_frame.set_data_length(0);
  last_page->set_last_frame_position(last_page_frame.address() - last_page->address());
}

} // namespace kungfu::yijinjing::journal