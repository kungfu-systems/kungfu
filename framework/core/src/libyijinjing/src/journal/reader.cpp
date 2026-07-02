// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::yijinjing::journal {
reader::~reader() {
  for (auto &iter : journals_) {
    iter.second->release_page();
  }
  journals_.clear();
}

void reader::join(const data::location_ptr &location, uint32_t dest_id, const int64_t from_time, uint64_t page_size,
                  longfist::enums::Priority priority) {
  SPDLOG_TRACE("join location: {}, dest_id: {}, page_size: {} ", location->to_string(), dest_id, page_size);
  auto key = journal_key(location, dest_id);
  auto size = lazy_ ? find_page_size(location, dest_id) : page::find_page_size(location, dest_id, page_size);
  auto result = journals_.try_emplace(
      key, std::make_shared<journal>(location, dest_id, false, lazy_, low_latency_, bus_, size, priority));
  if (result.second) {
    journals_.at(key)->seek_to_time(from_time);
  }
  if (current_ == nullptr) {
    sort_without_buffer(); // do not sort if current_ is set (because we could be in process of reading)
  }
  buffer_built_ = false;
}

void reader::disjoin_channel(const data::location_ptr &location, uint32_t dest_id) {
  auto key = journal_key(location, dest_id);
  journals_.erase(key);
  current_ = nullptr;
  sort_without_buffer();
}

void reader::disjoin(const data::location_ptr &location) {
  for (auto it = journals_.begin(); it != journals_.end();) {
    if (it->first.location_uid != location->location_uid or it->first.locator_uid != location->locator->locator_uid) {
      it++;
    } else {
      it = journals_.erase(it);
    }
  }
  current_ = nullptr;
  sort_without_buffer();
}

bool reader::data_available() {
  sort();
  return current_ != nullptr && current_frame()->has_data();
}

void reader::seek_to_time(int64_t nanotime) {
  for (auto &pair : journals_) {
    pair.second->seek_to_time(nanotime);
  }
  sort_without_buffer();
}

void reader::next() {
  if (current_ != nullptr) {
    current_->next();
  }
  sort();
}

void reader::sort_without_buffer() {
  buffer_built_ = false;
  // those could be refacted to std::ranges after cxx==20
  std::vector<journal_ptr> has_data_journals;
  for (auto &pair : journals_) {
    auto &journal = pair.second;
    if (journal->current_frame()->has_data()) {
      has_data_journals.push_back(journal);
    }
  }
  auto min_journal_it = std::max_element(has_data_journals.cbegin(), has_data_journals.cend(), later{});
  if (min_journal_it != has_data_journals.end()) {
    current_ = *min_journal_it;
  }
}

void reader::sort() {
  if (not buffer_built_) {
    build_buffer();
  }
  int64_t min_time = INT64_MAX;
  no_data_journals_buffer_.erase(std::remove_if(no_data_journals_buffer_.begin(), no_data_journals_buffer_.end(),
                                                [this](const auto &journal_ptr) {
                                                  const bool has_data = journal_ptr->current_frame()->has_data();
                                                  if (has_data) {
                                                    has_data_journals_heap_.push(journal_ptr);
                                                  }
                                                  return has_data;
                                                }),
                                 no_data_journals_buffer_.end());
  if (has_data_journals_heap_.empty()) {
    return;
  }
  auto min_journal = has_data_journals_heap_.top();
  if (min_journal->current_frame()->gen_time() <= min_time) {
    current_ = min_journal;
    has_data_journals_heap_.pop();
    no_data_journals_buffer_.push_back(current_);
  }
}

void reader::build_buffer() {
  no_data_journals_buffer_.clear();
  has_data_journals_heap_ = {};
  std::transform(journals_.begin(), journals_.end(), std::back_inserter(no_data_journals_buffer_),
                 [](auto &pair) { return pair.second; });
  buffer_built_ = true;
}

void reader::release_page() {
  for (auto &iter : journals_) {
    iter.second->release_page();
  }
}

void reader::preload_next_page() {
  for (auto &iter : journals_) {
    iter.second->preload_next_page();
  }
}

reader::reader(const reader &other) : lazy_(other.lazy_), low_latency_(other.low_latency_), bus_(other.bus_) {
  for (auto &j : other.journals_) {
    journals_.emplace(j.first, j.second);
    if (other.current_->get_source() == j.second->get_source() and other.current_->get_dest() == j.second->get_dest()) {
      current_ = journals_.find(j.first)->second;
    }
  }
}

journal_ptr reader::get_journal(const data::location_ptr &location, uint32_t dest_id) {
  auto key = journal_key(location, dest_id);
  auto iter = journals_.find(key);
  if (iter != journals_.end()) {
    return iter->second;
  }

  SPDLOG_ERROR("no journal found for location: {}, dest_id: {}", location->uname, dest_id);
  return nullptr;
}

uint64_t reader::find_page_size(const data::location_ptr &location, uint32_t dest_id) {
  std::vector<uint32_t> page_ids = location->locator->list_page_id(location, dest_id);
  if (page_ids.empty()) {
    SPDLOG_ERROR("no page for current journal {} -> {}", location->uname, dest_id);
    throw journal_error(fmt::format("no page for current journal {} -> {}", location->uname, dest_id));
  }

  auto page_id = page_ids.front();
  auto page = page::load_header_and_1st_frame_header(location, dest_id, page_id, false, true);
  auto page_size = page->get_page_size();
  if (page_size == 0) {
    const std::string msg = fmt::format("open a page never init page_header for {}", location->uname,
                                        page::get_page_path(location, dest_id, page_id));
    SPDLOG_ERROR(msg);
    throw journal_error(msg);
  }
  return page_size;
}

void reader::clear() {
  journals_.clear();
  current_ = nullptr;
  sort_without_buffer();
}

bool reader::later::operator()(const journal_ptr &lhs, const journal_ptr &rhs) const {
  if (lhs->priority_ == rhs->priority_) {
    return lhs->current_frame()->gen_time() > rhs->current_frame()->gen_time();
  }
  return lhs->priority_ < rhs->priority_;
}

} // namespace kungfu::yijinjing::journal