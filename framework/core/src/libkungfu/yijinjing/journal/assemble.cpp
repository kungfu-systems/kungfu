
// SPDX-License-Identifier: Apache-2.0

//
// Created by Keren Dong on 2020/5/22.
//

#include <kungfu/yijinjing/cache/backend.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/io.h>
#include <kungfu/yijinjing/journal/assemble.h>
#include <kungfu/yijinjing/journal/bus.h>
#include <kungfu/yijinjing/time.h>
#include <unordered_set>

namespace kungfu::yijinjing::journal {
using namespace longfist::enums;
using namespace longfist::types;

sink::sink() : publisher_(std::make_shared<noop_publisher>()), bus_(std::make_shared<bus>(false)) {}

publisher_ptr sink::get_publisher() { return publisher_; }

bus_ptr sink::get_bus() { return bus_; }

uint64_t sink::find_page_size(const data::location_ptr &location, uint32_t dest_id) {
  return reader::find_page_size(location, dest_id);
}

copy_sink::copy_sink(data::locator_ptr locator) : sink(), locator_(std::move(locator)) {}

void copy_sink::put(const data::location_ptr &location, uint32_t dest_id, const frame_ptr &frame) {
  auto pair = writers_.try_emplace(location->uid);
  auto &writers = pair.first->second;
  if (writers.find(dest_id) == writers.end()) {
    auto target_location = data::location::make_shared(*location, locator_);
    auto page_size = find_page_size(target_location, dest_id);
    writers.try_emplace(dest_id, std::make_shared<writer>(target_location, dest_id, true, get_publisher(), false,
                                                          std::make_shared<bus>(false), page_size));
  }
  writers.at(dest_id)->copy_frame(frame);
}

assemble::assemble(const data::locator_ptr &locator, const std::string &mode, const std::string &category,
                   const std::string &group, const std::string &name)
    : mode_(mode), category_(category), group_(group), name_(name), publisher_(std::make_shared<noop_publisher>()) {
  locators_.push_back(locator);
  readers_.push_back(std::make_shared<reader>(true, false, std::make_shared<bus>(false)));
  auto reader = readers_.back();
  for (auto &location : locator->list_locations(category, group, name, mode)) {
    for (auto dest_id : locator->list_location_dest(location)) {
      reader->join(location, dest_id, 0);
    }
  }
  sort();
}

assemble::assemble(const std::vector<data::locator_ptr> &locators, const std::string &mode, const std::string &category,
                   const std::string &group, const std::string &name)
    : mode_(mode), category_(category), group_(group), name_(name), publisher_(std::make_shared<noop_publisher>()) {
  for (auto &locator : locators) {
    locators_.push_back(locator);
    readers_.push_back(std::make_shared<reader>(true, false, std::make_shared<bus>(false)));
    auto reader = readers_.back();
    for (auto &location : locator->list_locations(category, group, name, mode)) {
      for (auto dest_id : locator->list_location_dest(location)) {
        reader->join(location, dest_id, 0);
      }
    }
  }
  sort();
}

assemble::assemble(const data::location_ptr &source_location, uint32_t dest_id, uint32_t assemble_mode,
                   int64_t from_time)
    : mode_("*"), category_("*"), group_("*"), name_("*"), publisher_(std::make_shared<noop_publisher>()) {
  from_time_ = from_time;
  locators_.clear();
  readers_.clear();
  data::locator_ptr l = source_location->locator;
  locators_.push_back(source_location->locator);
  readers_.push_back(std::make_shared<reader>(true, false, std::make_shared<bus>(false)));
  auto reader = readers_.front();

  // join channel
  if (assemble_mode & AssembleMode::Channel) {
    reader->join(source_location, dest_id, from_time);
  }

  // join all journal dest of location
  if (assemble_mode & AssembleMode::Write) {
    for (auto dest : l->list_location_dest(source_location)) {
      reader->join(source_location, dest, from_time);
    }
  }

  // scan all locations, join dest_id or PUBLIC
  bool b_read = assemble_mode & AssembleMode::Read;
  bool b_public = assemble_mode & AssembleMode::Public;
  bool b_sync = assemble_mode & AssembleMode::Sync;
  bool b_all = assemble_mode & AssembleMode::All;
  if (b_read or b_public or b_all) {
    for (auto &location : l->list_locations("*", "*", "*", "*")) {
      for (auto dest : l->list_location_dest(location)) {
        if (b_all) {
          reader->join(location, dest, from_time);
        } else if (b_read and dest == dest_id) {
          reader->join(location, dest_id, from_time);
        } else if (b_public and dest == data::location::PUBLIC) {
          reader->join(location, data::location::PUBLIC, from_time);
        } else if (b_sync and dest == data::location::SYNC) {
          reader->join(location, data::location::SYNC, from_time);
        }
      }
    }
  }
  sort();
}

assemble assemble::operator+(assemble &other) {
  if (mode_ != other.mode_ or category_ != other.category_ or group_ != other.group_ or name_ != other.name_) {
    auto msg = fmt::format("assemble incompatible: {}/{}/{}/{}, {}/{}/{}/{}", category_, group_, name_, mode_,
                           other.category_, other.group_, other.name_, other.mode_);
    throw assemble_exception(msg);
  }
  std::vector<data::locator_ptr> merged_locators = {};
  merged_locators.insert(merged_locators.end(), locators_.begin(), locators_.end());
  merged_locators.insert(merged_locators.end(), other.locators_.begin(), other.locators_.end());
  return assemble(merged_locators, mode_, category_, group_, name_);
}

assemble &assemble::operator+=(const assemble &other) {
  // add journals in the same locator
  std::unordered_set<uint32_t> other_same_index;
  for (uint32_t other_locator_index = 0; other_locator_index < other.locators_.size(); ++other_locator_index) {
    const auto &other_locator = other.locators_.at(other_locator_index);
    for (uint32_t this_locator_index = 0; this_locator_index < locators_.size(); ++this_locator_index) {
      const auto &this_locator = locators_.at(this_locator_index);
      if (this_locator == other_locator) {
        auto &this_reader = readers_.at(this_locator_index);
        const auto &other_reader = other.readers_.at(other_locator_index);
        for (const auto &other_pair : other_reader->get_journals()) {
          const auto &other_journal = other_pair.second;
          this_reader->join(other_journal->get_location(), other_journal->get_dest(), other.from_time_);
        }
        other_same_index.emplace(other_locator_index);
        break;
      }
    }
  }

  // add journals of other, whose locator not in locators_ of this
  for (uint32_t other_locator_index = 0; other_locator_index < locators_.size(); ++other_locator_index) {
    if (other_same_index.find(other_locator_index) != other_same_index.end()) {
      continue;
    }
    const auto &other_locator = other.locators_.at(other_locator_index);
    const auto &other_reader = other.readers_.at(other_locator_index);
    locators_.push_back(other_locator);
    readers_.push_back(std::make_shared<reader>(true, false, std::make_shared<bus>(false)));
    auto &this_reader = readers_.back();
    for (const auto &other_pair : other_reader->get_journals()) {
      const auto &other_journal = other_pair.second;
      this_reader->join(other_journal->get_location(), other_journal->get_dest(), other.from_time_);
    }
  }

  return *this;
}

assemble &assemble::operator-=(const assemble &other) {
  for (uint32_t other_locator_index = 0; other_locator_index < other.locators_.size(); ++other_locator_index) {
    const auto &other_locator = other.locators_.at(other_locator_index);
    for (uint32_t this_locator_index = 0; this_locator_index < locators_.size(); ++this_locator_index) {
      const auto &this_locator = locators_.at(this_locator_index);
      if (this_locator == other_locator) {
        auto &this_reader = readers_.at(this_locator_index);
        const auto &other_reader = other.readers_.at(other_locator_index);
        for (const auto &other_pair : other_reader->get_journals()) {
          const auto &other_journal = other_pair.second;
          this_reader->disjoin_channel(other_journal->get_location(), other_journal->get_dest());
        }
        break;
      }
    }
  }
  return *this;
}

void assemble::operator>>(const sink_ptr &sink) {
  while (data_available()) {
    auto page = current_reader_->current_page();
    sink->put(page->get_location(), page->get_dest_id(), current_frame());
    next();
  }
}

bool assemble::data_available() {
  sort();
  return std::any_of(readers_.begin(), readers_.end(), [](auto &r) { return r->data_available(); });
}

void assemble::next() {
  if (current_reader_) {
    current_reader_->next();
  }
  sort();
}

frame_ptr assemble::current_frame() { return current_reader_->current_frame(); }

page_ptr assemble::current_page() { return current_reader_->current_page(); }

void assemble::sort() {
  int64_t min_time = INT64_MAX;
  for (auto &reader : readers_) {
    if (reader->data_available() and reader->current_frame()->gen_time() < min_time) {
      min_time = reader->current_frame()->gen_time();
      current_reader_ = reader;
    }
  }
}

void assemble::seek_to_time(int64_t nano_time) {
  for (auto &reader : readers_) {
    reader->seek_to_time(nano_time);
  }
  sort();
}

std::vector<frame_header> assemble::read_headers(int32_t msg_type, int64_t end_time) {
  std::vector<frame_header> v{};
  while (data_available() and current_frame()->gen_time() < end_time) {
    if (msg_type == 0 or current_frame()->msg_type() == msg_type) {
      v.push_back(*reinterpret_cast<frame_header *>(current_frame()->address()));
    }
    next();
  }
  return v;
}

std::vector<std::pair<longfist::types::frame_header, std::vector<uint8_t>>> assemble::read_bytes(int32_t msg_type,
                                                                                                 int64_t end_time) {
  std::vector<std::pair<longfist::types::frame_header, std::vector<uint8_t>>> v{};
  while (data_available() and current_frame()->gen_time() < end_time) {
    if (msg_type == 0 or
        current_frame()->msg_type() == msg_type && current_page()->get_version() == __JOURNAL_VERSION__) {
      const frame_header &head = *reinterpret_cast<frame_header *>(current_frame()->address());
      std::vector<uint8_t> bytes{current_frame()->data_as_bytes(),
                                 current_frame()->data_as_bytes() + current_frame()->data_length()};
      v.emplace_back(head, bytes);
    }

    if (current_page()->get_version() != __JOURNAL_VERSION__) {
      SPDLOG_WARN("journal version mismatch, expect {}, got {}, page_id {}, location uid {} location name {}",
                  __JOURNAL_VERSION__, current_page()->get_version(), current_page()->get_page_id(),
                  current_page()->get_location()->uid, current_page()->get_location()->uname);
    }

    next();
  }
  return v;
}

void assemble::disjoin(const data::location_ptr &location) {
  for (auto &reader : readers_) {
    reader->disjoin(location);
  }
}

void assemble::disjoin_channel(const data::location_ptr &location, uint32_t dest_id) {
  for (auto &reader : readers_) {
    reader->disjoin_channel(location, dest_id);
  }
}

void assemble::move_to_time(int64_t nano_time) {
  while (data_available() and current_frame()->trigger_time() < nano_time) {
    next();
  }
}

} // namespace kungfu::yijinjing::journal