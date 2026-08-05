// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/core.h>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::frame;
using kungfu::yijinjing::journal::frame_ptr;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::writer;
using kungfu::yijinjing::types::frame_header;
using kungfu::yijinjing::types::page_header;

namespace {

constexpr uint64_t TEST_PAGE_SIZE_MB = 2;
constexpr size_t TEST_PAGE_SIZE = TEST_PAGE_SIZE_MB * kungfu::yijinjing::MB;
constexpr size_t MAX_PAYLOAD = TEST_PAGE_SIZE - sizeof(page_header) - 2 * sizeof(frame_header);

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-writer-safety-test-" + std::to_string(nonce));
    fs::create_directories(root_);
  }

  ~temp_tree() {
    std::error_code ignored;
    fs::remove_all(root_, ignored);
  }

  [[nodiscard]] const fs::path &root() const { return root_; }

private:
  fs::path root_;
};

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void require_throws(const std::function<void()> &fn, const std::string &message) {
  try {
    fn();
  } catch (const std::exception &) {
    return;
  }
  throw std::runtime_error(message);
}

bool frame_is_published_at(uintptr_t address) {
  auto *header = reinterpret_cast<frame_header *>(address);
  return std::atomic_ref<uint32_t>(header->length).load(std::memory_order_acquire) > 0 && header->carrier_type > 0;
}

auto make_location(const fs::path &root, const std::string &name) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, "writer_safety_test", name, page_locator);
}

auto make_bus() { return std::make_shared<kungfu::yijinjing::journal::bus>(false); }

class counting_publisher : public noop_publisher {
public:
  int notify() override {
    ++notifications;
    return 0;
  }

  int notifications{0};
};

struct source_frame {
  explicit source_frame(size_t payload_length)
      : storage(sizeof(frame_header) + payload_length), value(std::make_shared<frame>()) {
    value->set_address(reinterpret_cast<uintptr_t>(storage.data()));
    header().header_length = sizeof(frame_header);
    header().length = sizeof(frame_header) + payload_length;
    header().carrier_type = 4001;
  }

  frame_header &header() { return *reinterpret_cast<frame_header *>(storage.data()); }

  std::vector<std::byte> storage;
  frame_ptr value;
};

void test_reservation_rejects_max_plus_one_and_size_max_without_mutation() {
  temp_tree tree;
  auto publisher = std::make_shared<counting_publisher>();
  writer target(make_location(tree.root(), "reservation"), location::PUBLIC, publisher, false, make_bus(),
                TEST_PAGE_SIZE_MB);
  const auto original_page = target.get_current_page()->get_page_id();
  const auto original_cursor = target.get_journal()->current_frame()->address();

  require_throws([&] { (void)target.reserve_frame(1, 2001, MAX_PAYLOAD + 1); },
                 "MAX_PAYLOAD + 1 reservation was accepted");
  require_throws([&] { (void)target.reserve_frame(2, 2002, std::numeric_limits<size_t>::max()); },
                 "SIZE_MAX reservation was accepted");
  require(target.get_current_page()->get_page_id() == original_page, "rejected reservation rolled the page");
  require(target.get_journal()->current_frame()->address() == original_cursor,
          "rejected reservation advanced the frame cursor");
  require(publisher->notifications == 0, "rejected reservation notified readers");

  std::vector<std::byte> payload(MAX_PAYLOAD);
  auto exact = target.reserve_frame(3, 2003, payload.size());
  const auto exact_address = exact.frame()->address();
  exact.copy_bytes(payload.data(), payload.size());
  exact.commit(payload.size(), 4);
  require(frame_is_published_at(exact_address), "exact maximum payload was not published");
  require(publisher->notifications == 1, "exact maximum payload did not notify exactly once");

  auto recovery = target.reserve_frame(5, 2004, sizeof(uint64_t));
  require(target.get_current_page()->get_page_id() != original_page, "writer did not roll after exact maximum payload");
  recovery.copy_data(uint64_t{42});
  recovery.commit(sizeof(uint64_t), 6);
  require(publisher->notifications == 2, "writer did not recover after boundary rejection");
}

void test_payload_extents_reject_before_publication() {
  temp_tree tree;
  auto publisher = std::make_shared<counting_publisher>();
  writer target(make_location(tree.root(), "payload"), location::PUBLIC, publisher, false, make_bus(),
                TEST_PAGE_SIZE_MB);
  const auto cursor = target.get_journal()->current_frame()->address();
  const std::vector<uint8_t> bytes(8, 7);

  require_throws(
      [&] {
        auto tx = target.reserve_frame(1, 3001, 4);
        tx.copy_bytes(bytes.data(), bytes.size());
      },
      "copy larger than the reservation was accepted");
  require_throws(
      [&] {
        auto tx = target.reserve_frame(2, 3002, 4);
        tx.commit(5, 3);
      },
      "commit larger than the reservation was accepted");
  require_throws(
      [&] {
        auto tx = target.reserve_frame(4, 3003, 1);
        tx.copy_bytes(nullptr, 1);
      },
      "non-empty null transaction copy was accepted");
  require(target.get_journal()->current_frame()->address() == cursor, "rejected payload operation advanced the cursor");
  require(publisher->notifications == 0, "rejected payload operation notified readers");

  target.write_bytes(8, 3007, std::span<const std::byte>{});
  require(publisher->notifications == 1, "valid empty byte payload was not published");
  target.write_bytes(9, 3008, std::as_bytes(std::span{bytes}));
  require(publisher->notifications == 2, "writer did not recover after payload rejection");
}

void test_copy_frame_rejects_inconsistent_sources_without_mutation() {
  temp_tree tree;
  auto publisher = std::make_shared<counting_publisher>();
  writer target(make_location(tree.root(), "copy-target"), location::PUBLIC, publisher, false, make_bus(),
                TEST_PAGE_SIZE_MB);
  const auto page_id = target.get_current_page()->get_page_id();
  const auto cursor = target.get_journal()->current_frame()->address();

  auto reject_without_mutation = [&](const frame_ptr &source, const std::string &message) {
    require_throws([&] { target.copy_frame(source); }, message);
    require(target.get_current_page()->get_page_id() == page_id, message + " rolled the page");
    require(target.get_journal()->current_frame()->address() == cursor, message + " advanced the cursor");
    require(publisher->notifications == 0, message + " notified readers");
  };

  reject_without_mutation(nullptr, "null frame source was accepted");
  source_frame malformed(8);
  malformed.header().header_length = 0;
  reject_without_mutation(malformed.value, "invalid frame header length was accepted");
  malformed.header().header_length = sizeof(frame_header);
  malformed.header().length = sizeof(frame_header) - 1;
  reject_without_mutation(malformed.value, "frame shorter than its header was accepted");
  malformed.header().length = sizeof(frame_header) + 3;
  reject_without_mutation(malformed.value, "unaligned frame payload was accepted");
  malformed.header().length = sizeof(frame_header) + MAX_PAYLOAD + sizeof(uintptr_t);
  reject_without_mutation(malformed.value, "oversized frame payload was accepted");

  source_frame valid(sizeof(uint64_t));
  target.copy_frame(valid.value);
  require(frame_is_published_at(cursor), "valid source frame was not published");
  require(publisher->notifications == 1, "valid source frame did not notify exactly once");
}

} // namespace

int main() {
  const std::vector<std::pair<std::string, std::function<void()>>> tests = {
      {"reservation bounds reject without mutation",
       test_reservation_rejects_max_plus_one_and_size_max_without_mutation},
      {"payload bounds reject before publication", test_payload_extents_reject_before_publication},
      {"frame copy rejects inconsistent sources", test_copy_frame_rejects_inconsistent_sources_without_mutation},
  };

  int failed = 0;
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "ok - " << name << '\n';
    } catch (const std::exception &error) {
      ++failed;
      std::cerr << "not ok - " << name << ": " << error.what() << '\n';
    }
  }
  return failed == 0 ? 0 : 1;
}
