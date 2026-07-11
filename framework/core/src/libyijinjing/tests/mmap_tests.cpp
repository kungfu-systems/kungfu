// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
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
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>

#ifdef _WIN32
#include <windows.h>
#else
#include <csignal>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::page;
using kungfu::yijinjing::journal::page_open_policy;
using kungfu::yijinjing::journal::page_precreation;
using kungfu::yijinjing::journal::reader_policy;
using kungfu::yijinjing::platform::mapped_region;
using kungfu::yijinjing::platform::mapping_access;
using kungfu::yijinjing::platform::mapping_creation;
using kungfu::yijinjing::platform::mapping_durability;
using kungfu::yijinjing::platform::mapping_policy;
using kungfu::yijinjing::platform::mapping_residency;
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

size_t process_resource_count() {
#ifdef _WIN32
  DWORD count = 0;
  require(GetProcessHandleCount(GetCurrentProcess(), &count) != 0, "failed to count process handles");
  return count;
#else
  const auto fd_root = fs::exists("/proc/self/fd") ? fs::path("/proc/self/fd") : fs::path("/dev/fd");
  return static_cast<size_t>(std::distance(fs::directory_iterator(fd_root), fs::directory_iterator{}));
#endif
}

auto make_location(const fs::path &root) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, "mmap_test", "writer", page_locator);
}

std::string create_page_path(const kungfu::yijinjing::data::location_ptr &loc) {
  (void)loc->locator->layout_dir(loc, kungfu::yijinjing::enums::layout::JOURNAL, true);
  return page::get_page_path(loc, location::PUBLIC, 1);
}

void create_seek_page(const kungfu::yijinjing::data::location_ptr &loc, uint32_t page_id, int64_t begin_time,
                      kungfu::yijinjing::enums::PageStatus status = kungfu::yijinjing::enums::PageStatus::Normal) {
  const auto path = page::get_page_path(loc, location::PUBLIC, page_id);
  auto region = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
  auto *header = reinterpret_cast<page_header *>(region.address());
  header->version = __JOURNAL_VERSION__;
  header->page_header_length = sizeof(page_header);
  header->page_size = TEST_PAGE_SIZE;
  header->frame_header_length = sizeof(frame_header);
  header->status = status;
  header->last_frame_position = sizeof(page_header);
  auto *first_frame = reinterpret_cast<frame_header *>(region.address() + sizeof(page_header));
  first_frame->gen_time = begin_time;
  require(region.reset(), "failed to release seek-page fixture mapping");
}

void test_wire_layout_invariants() {
  static_assert(sizeof(page_header) == 32, "wire-v1 page_header size changed");
  static_assert(sizeof(frame_header) == 72, "wire-v1 frame_header size changed");
  static_assert(offsetof(page_header, last_frame_position) == 24, "wire-v1 page publication token offset changed");
  static_assert(offsetof(frame_header, length) == 0, "frame publication token offset changed");
  static_assert(std::is_move_constructible_v<mapped_region>);
  static_assert(!std::is_copy_constructible_v<mapped_region>);
}

void test_mapping_policy_truth_table() {
  static_assert(mapping_policy::read_existing().qualified());
  static_assert(mapping_policy::write_existing().qualified());
  static_assert(mapping_policy::write_create_or_grow().qualified());

  constexpr mapping_policy read_create{mapping_access::read_only, mapping_creation::create_or_grow,
                                       mapping_residency::demand, mapping_durability::visibility};
  constexpr mapping_policy prefault{mapping_access::read_only, mapping_creation::existing_only,
                                    mapping_residency::prefault, mapping_durability::visibility};
  constexpr mapping_policy pinned{mapping_access::read_write, mapping_creation::existing_only,
                                  mapping_residency::pinned, mapping_durability::visibility};
  constexpr mapping_policy asynchronous{mapping_access::read_write, mapping_creation::existing_only,
                                        mapping_residency::demand, mapping_durability::asynchronous};
  constexpr mapping_policy durable{mapping_access::read_write, mapping_creation::existing_only,
                                   mapping_residency::demand, mapping_durability::durable};
  static_assert(!read_create.structurally_valid());
  static_assert(!read_create.qualified());
  static_assert(!prefault.qualified());
  static_assert(!pinned.qualified());
  static_assert(!asynchronous.qualified());
  static_assert(!durable.qualified());

  temp_tree tree;
  const auto path = tree.root() / "invalid-policy.journal";
  for (const auto policy : {read_create, prefault, pinned, asynchronous, durable}) {
    require_throws([&] { (void)mapped_region::map(path.string(), 4096, policy); },
                   "unqualified mapping policy was accepted");
  }
  require(!fs::exists(path), "invalid policy mutated the filesystem before rejection");
}

void test_page_open_intent_truth_table() {
  const auto reader = page_open_policy::reader();
  require(!reader.may_initialize() && !reader.may_publish_normal() && !reader.mapping().writable() &&
              !reader.mapping().creates_or_grows(),
          "reader intent gained mutation authority");

  const auto writer = page_open_policy::writer();
  require(writer.may_initialize() && writer.may_publish_normal() && writer.mapping().writable() &&
              writer.mapping().creates_or_grows() && !writer.opens_preopen(),
          "writer intent lost active-page authority");

  const auto reader_preload = page_open_policy::reader_preload();
  require(reader_preload.opens_preopen() && !reader_preload.may_initialize() && !reader_preload.mapping().writable(),
          "reader preloader gained mutation authority");

  const auto writer_preload = page_open_policy::writer_preload();
  require(writer_preload.opens_preopen() && writer_preload.may_initialize() && writer_preload.may_publish_normal(),
          "writer preloader cannot activate its page");

  const auto precreator = page_open_policy::coordinator_precreate();
  require(precreator.opens_preopen() && precreator.may_initialize() && !precreator.may_publish_normal() &&
              precreator.mapping().writable() && precreator.mapping().creates_or_grows(),
          "coordinator precreator authority is not isolated");

  const auto peer_reader = reader_policy::peer();
  require(peer_reader.discover_page_size && peer_reader.journal.precreation == page_precreation::disabled,
          "peer reader unexpectedly owns precreation");
  const auto coordinator_reader = reader_policy::coordinator();
  require(!coordinator_reader.discover_page_size &&
              coordinator_reader.journal.precreation == page_precreation::coordinator,
          "coordinator reader did not receive explicit precreation authority");
}

void test_existing_mapping_never_creates_or_grows() {
  temp_tree tree;
  const auto missing = tree.root() / "missing.journal";
  require_throws([&] { (void)mapped_region::map(missing.string(), 4096, mapping_policy::read_existing()); },
                 "existing-only mapping accepted a missing file");
  require(!fs::exists(missing), "existing-only mapping created a missing file");

  const auto truncated = tree.root() / "truncated.journal";
  {
    std::ofstream stream(truncated, std::ios::binary);
    stream << "short";
  }
  const auto before = fs::file_size(truncated);
  require_throws([&] { (void)mapped_region::map(truncated.string(), 4096, mapping_policy::read_existing()); },
                 "existing-only mapping accepted a truncated file");
  require(fs::file_size(truncated) == before, "existing-only mapping changed a truncated file size");
  require_throws([&] { (void)mapped_region::map(truncated.string(), 0, mapping_policy::read_existing()); },
                 "zero-length mapping was accepted");
}

void test_mapped_region_move_ownership() {
  temp_tree tree;
  const auto path = tree.root() / "owned.journal";
  auto first = mapped_region::map(path.string(), 4096, mapping_policy::write_create_or_grow());
  require(first && first.writable() && first.size() == 4096, "writable mapping facts are incorrect");
  *reinterpret_cast<uint64_t *>(first.address()) = UINT64_C(0x1020304050607080);

  mapped_region second(std::move(first));
  require(!first && second, "move construction did not transfer mapping ownership");
  require(second.flush(), "writable mapping flush failed");
  require(second.reset(), "writable mapping release failed");
  require(!second, "released mapping retained an address");
  require(fs::file_size(path) == 4096, "writable mapping did not size the file exactly once");

  auto reader = mapped_region::map(path.string(), 4096, mapping_policy::read_existing());
  require(!reader.writable(), "read mapping unexpectedly has write access");
  require(*reinterpret_cast<const uint64_t *>(reader.address()) == UINT64_C(0x1020304050607080),
          "mapped payload changed across release/reopen");
}

void test_mapping_error_paths_release_resources() {
  temp_tree tree;
  const auto truncated = tree.root() / "truncated.journal";
  {
    std::ofstream stream(truncated, std::ios::binary);
    stream << "short";
  }

  require_throws([&] { (void)mapped_region::map(truncated.string(), 4096, mapping_policy::read_existing()); },
                 "resource-count warmup unexpectedly mapped a truncated file");
  const auto before = process_resource_count();
  for (int i = 0; i < 8; ++i) {
    require_throws([&] { (void)mapped_region::map(truncated.string(), 4096, mapping_policy::read_existing()); },
                   "repeated truncated mapping unexpectedly succeeded");
  }
  const auto after = process_resource_count();
  require(after <= before + 1, "failing mappings leaked file descriptors or handles: before=" + std::to_string(before) +
                                   ", after=" + std::to_string(after) + ", delta=" + std::to_string(after - before));

  const auto stale_path = tree.root() / "stale.journal";
  auto stale = mapped_region::map(stale_path.string(), 4096, mapping_policy::write_create_or_grow());
#ifdef _WIN32
  require(UnmapViewOfFile(reinterpret_cast<void *>(stale.address())) != 0,
          "failed to inject an already-unmapped Windows view");
#else
  require(munmap(reinterpret_cast<void *>(stale.address()), stale.size()) == 0,
          "failed to inject an already-unmapped POSIX region");
#endif
  require(!stale.flush(), "flush unexpectedly succeeded for an already-unmapped region");
  (void)stale.reset();
  require(!stale, "failed cleanup retained stale mapping ownership");
}

#ifndef _WIN32
void test_resize_budget_failure_releases_file() {
  temp_tree tree;
  const auto path = tree.root() / "limited.journal";
  std::cout.flush();
  std::cerr.flush();
  const pid_t child = fork();
  require(child >= 0, "fork failed for resize-budget test");
  if (child == 0) {
    std::signal(SIGXFSZ, SIG_IGN);
    const rlimit limit{1024, 1024};
    if (setrlimit(RLIMIT_FSIZE, &limit) != 0) {
      _exit(2);
    }
    try {
      (void)mapped_region::map(path.string(), 4096, mapping_policy::write_create_or_grow());
      _exit(3);
    } catch (...) {
      std::error_code error;
      const auto size = fs::exists(path, error) ? fs::file_size(path, error) : 0;
      _exit(!error && size <= 1024 ? 0 : 4);
    }
  }

  int status = 0;
  require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "resize-budget failure was not handled without file growth");
}
#endif

void test_page_reader_does_not_create_layout() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto journal_dir = loc->locator->layout_dir(loc, kungfu::yijinjing::enums::layout::JOURNAL, false);
  require(!fs::exists(journal_dir), "test journal directory unexpectedly exists");
  require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader()); },
                 "reader opened a missing journal page");
  require(!fs::exists(journal_dir), "reader created the journal directory for a missing page");
}

void test_corrupt_page_offsets_fail_before_payload_access() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto path = create_page_path(loc);
  auto region = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
  auto *header = reinterpret_cast<page_header *>(region.address());
  header->version = __JOURNAL_VERSION__;
  header->page_header_length = sizeof(page_header);
  header->page_size = TEST_PAGE_SIZE;
  header->frame_header_length = sizeof(frame_header);
  header->status = kungfu::yijinjing::enums::PageStatus::Normal;
  header->last_frame_position = TEST_PAGE_SIZE;
  require(region.reset(), "failed to release corrupt-page fixture mapping");

  require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader()); },
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
    auto region = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
    auto *header = reinterpret_cast<page_header *>(region.address());
    header->version = __JOURNAL_VERSION__;
    header->page_header_length = sizeof(page_header);
    header->page_size = TEST_PAGE_SIZE;
    header->frame_header_length = sizeof(frame_header);
    header->status = kungfu::yijinjing::enums::PageStatus::Normal;
    header->last_frame_position = sizeof(page_header);
    test_case.corrupt(*header);
    require(region.reset(), std::string("failed to release ") + test_case.name + " fixture");

    require_throws([&] { (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader()); },
                   std::string("page accepted corrupt ") + test_case.name);
  }
}

void test_page_header_publication() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto path = create_page_path(loc);
  auto empty = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
  require(empty.reset(), "failed to release empty page fixture mapping");

#ifdef _WIN32
  std::thread initializer([loc] {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::writer());
  });
  auto reader = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader());
  initializer.join();
#else
  const pid_t child = fork();
  require(child >= 0, "fork failed for page publication test");
  if (child == 0) {
    try {
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      (void)page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::writer());
      _exit(0);
    } catch (...) {
      _exit(2);
    }
  }
  auto reader = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader());
  int status = 0;
  require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "initializer process failed");
#endif

  require(reader->get_version() == __JOURNAL_VERSION__, "reader observed an unpublished page version");
  require(reader->get_page_size() == TEST_PAGE_SIZE, "reader observed an unpublished page size");
  require(reader->first_frame_address() > reader->address(), "reader observed an invalid first-frame address");
}

void test_page_lookup_uses_ordered_begin_times() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  for (uint32_t page_id = 1; page_id <= 4; ++page_id) {
    create_seek_page(loc, page_id, static_cast<int64_t>(page_id) * 100);
  }
  create_seek_page(loc, 5, 500, kungfu::yijinjing::enums::PageStatus::PreOpen);

  require(page::find_page_id(loc, location::PUBLIC, 0) == 1, "zero-time lookup did not select the first page");
  require(page::find_page_id(loc, location::PUBLIC, 100) == 1,
          "lookup at the first begin time did not preserve first-page fallback");
  require(page::find_page_id(loc, location::PUBLIC, 201) == 2, "lookup did not select the latest earlier page");
  require(page::find_page_id(loc, location::PUBLIC, 1'000) == 4, "lookup selected a pre-open tail page");
}

} // namespace

int main() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"wire layout invariants", test_wire_layout_invariants},
      {"mapping policy truth table", test_mapping_policy_truth_table},
      {"page open intent truth table", test_page_open_intent_truth_table},
      {"existing mapping never creates or grows", test_existing_mapping_never_creates_or_grows},
      {"mapped region move ownership", test_mapped_region_move_ownership},
      {"mapping error paths release resources", test_mapping_error_paths_release_resources},
#ifndef _WIN32
      {"resize budget failure releases file", test_resize_budget_failure_releases_file},
#endif
      {"page reader does not create layout", test_page_reader_does_not_create_layout},
      {"corrupt page offsets fail before payload access", test_corrupt_page_offsets_fail_before_payload_access},
      {"corrupt page header facts are rejected", test_corrupt_page_header_facts_are_rejected},
      {"page header publication", test_page_header_publication},
      {"page lookup uses ordered begin times", test_page_lookup_uses_ordered_begin_times},
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
