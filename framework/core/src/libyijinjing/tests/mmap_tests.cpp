// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/platform/mmap.h>
#include <kungfu/yijinjing/schema/core.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>

#ifndef _WINDOWS
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::page;
using kungfu::yijinjing::platform::mapped_region;
using kungfu::yijinjing::types::frame_header;
using kungfu::yijinjing::types::page_header;

namespace {

constexpr size_t TEST_PAGE_SIZE = 2 * kungfu::yijinjing::MB;

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-mmap-test-" + std::to_string(nonce));
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

auto make_location(const fs::path &root) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, "mmap_test", "writer", page_locator);
}

std::string create_page_path(const kungfu::yijinjing::data::location_ptr &loc) {
  (void)loc->locator->layout_dir(loc, kungfu::yijinjing::enums::layout::JOURNAL, true);
  return page::get_page_path(loc, location::PUBLIC, 1);
}

void test_wire_layout_invariants() {
  static_assert(sizeof(page_header) == 32, "wire-v1 page_header size changed");
  static_assert(sizeof(frame_header) == 72, "wire-v1 frame_header size changed");
  static_assert(offsetof(page_header, last_frame_position) == 24, "wire-v1 page publication token offset changed");
  static_assert(offsetof(frame_header, length) == 0, "frame publication token offset changed");
  static_assert(std::is_move_constructible_v<mapped_region>);
  static_assert(!std::is_copy_constructible_v<mapped_region>);
}

void test_existing_mapping_never_creates_or_grows() {
  temp_tree tree;
  const auto missing = tree.root() / "missing.journal";
  require_throws([&] { (void)mapped_region::map_existing(missing.string(), 4096); },
                 "existing-only mapping accepted a missing file");
  require(!fs::exists(missing), "existing-only mapping created a missing file");

  const auto truncated = tree.root() / "truncated.journal";
  {
    std::ofstream stream(truncated, std::ios::binary);
    stream << "short";
  }
  const auto before = fs::file_size(truncated);
  require_throws([&] { (void)mapped_region::map_existing(truncated.string(), 4096); },
                 "existing-only mapping accepted a truncated file");
  require(fs::file_size(truncated) == before, "existing-only mapping changed a truncated file size");
  require_throws([&] { (void)mapped_region::map_existing(truncated.string(), 0); }, "zero-length mapping was accepted");
}

void test_mapped_region_move_ownership() {
  temp_tree tree;
  const auto path = tree.root() / "owned.journal";
  auto first = mapped_region::map_writable(path.string(), 4096);
  require(first && first.writable() && first.size() == 4096, "writable mapping facts are incorrect");
  *reinterpret_cast<uint64_t *>(first.address()) = UINT64_C(0x1020304050607080);

  mapped_region second(std::move(first));
  require(!first && second, "move construction did not transfer mapping ownership");
  require(second.flush(), "writable mapping flush failed");
  require(second.reset(), "writable mapping release failed");
  require(!second, "released mapping retained an address");
  require(fs::file_size(path) == 4096, "writable mapping did not size the file exactly once");

  auto reader = mapped_region::map_existing(path.string(), 4096);
  require(!reader.writable(), "read mapping unexpectedly has write access");
  require(*reinterpret_cast<const uint64_t *>(reader.address()) == UINT64_C(0x1020304050607080),
          "mapped payload changed across release/reopen");
}

void test_page_reader_does_not_create_layout() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto journal_dir = loc->locator->layout_dir(loc, kungfu::yijinjing::enums::layout::JOURNAL, false);
  require(!fs::exists(journal_dir), "test journal directory unexpectedly exists");
  require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, false, true); },
                 "reader opened a missing journal page");
  require(!fs::exists(journal_dir), "reader created the journal directory for a missing page");
}

void test_corrupt_page_offsets_fail_before_payload_access() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto path = create_page_path(loc);
  auto region = mapped_region::map_writable(path, TEST_PAGE_SIZE);
  auto *header = reinterpret_cast<page_header *>(region.address());
  header->version = __JOURNAL_VERSION__;
  header->page_header_length = sizeof(page_header);
  header->page_size = TEST_PAGE_SIZE;
  header->frame_header_length = sizeof(frame_header);
  header->status = kungfu::yijinjing::enums::PageStatus::Normal;
  header->last_frame_position = TEST_PAGE_SIZE;
  require(region.reset(), "failed to release corrupt-page fixture mapping");

  require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, false, true); },
                 "page accepted a last-frame offset outside the mapped payload");
}

void test_corrupt_page_header_facts_are_rejected() {
  struct corrupt_case {
    const char *name;
    std::function<void(page_header &)> corrupt;
  };
  const corrupt_case cases[] = {
      {"page header length", [](page_header &header) { header.page_header_length = sizeof(page_header) + 8; }},
      {"frame header length", [](page_header &header) { header.frame_header_length = sizeof(frame_header) - 8; }},
      {"page size", [](page_header &header) { header.page_size = TEST_PAGE_SIZE + 4096; }},
  };

  for (const auto &test_case : cases) {
    temp_tree tree;
    auto loc = make_location(tree.root());
    const auto path = create_page_path(loc);
    auto region = mapped_region::map_writable(path, TEST_PAGE_SIZE);
    auto *header = reinterpret_cast<page_header *>(region.address());
    header->version = __JOURNAL_VERSION__;
    header->page_header_length = sizeof(page_header);
    header->page_size = TEST_PAGE_SIZE;
    header->frame_header_length = sizeof(frame_header);
    header->status = kungfu::yijinjing::enums::PageStatus::Normal;
    header->last_frame_position = sizeof(page_header);
    test_case.corrupt(*header);
    require(region.reset(), std::string("failed to release ") + test_case.name + " fixture");

    require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, false, true); },
                   std::string("page accepted corrupt ") + test_case.name);
  }
}

void test_page_header_publication() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto path = create_page_path(loc);
  auto empty = mapped_region::map_writable(path, TEST_PAGE_SIZE);
  require(empty.reset(), "failed to release empty page fixture mapping");

#ifdef _WINDOWS
  std::thread initializer([loc] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, true, true);
  });
  auto reader = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, false, true);
  initializer.join();
#else
  const pid_t child = fork();
  require(child >= 0, "fork failed for page publication test");
  if (child == 0) {
    try {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, true, true);
      _exit(0);
    } catch (...) {
      _exit(2);
    }
  }
  auto reader = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, false, true);
  int status = 0;
  require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "initializer process failed");
#endif

  require(reader->get_version() == __JOURNAL_VERSION__, "reader observed an unpublished page version");
  require(reader->get_page_size() == TEST_PAGE_SIZE, "reader observed an unpublished page size");
  require(reader->first_frame_address() > reader->address(), "reader observed an invalid first-frame address");
}

} // namespace

int main() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"wire layout invariants", test_wire_layout_invariants},
      {"existing mapping never creates or grows", test_existing_mapping_never_creates_or_grows},
      {"mapped region move ownership", test_mapped_region_move_ownership},
      {"page reader does not create layout", test_page_reader_does_not_create_layout},
      {"corrupt page offsets fail before payload access", test_corrupt_page_offsets_fail_before_payload_access},
      {"corrupt page header facts are rejected", test_corrupt_page_header_facts_are_rejected},
      {"page header publication", test_page_header_publication},
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
