// SPDX-License-Identifier: Apache-2.0

#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/journal/layout_fingerprint.h>
#include <kungfu/yijinjing/journal/page.h>
#include <kungfu/yijinjing/platform/mmap.h>
#include <kungfu/yijinjing/schema/core.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

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
using kungfu::yijinjing::journal::frame_ptr;
using kungfu::yijinjing::journal::hookable_writer;
using kungfu::yijinjing::journal::journal;
using kungfu::yijinjing::journal::journal_format_epoch;
using kungfu::yijinjing::journal::journal_open_policy;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::page;
using kungfu::yijinjing::journal::page_lifecycle_parse_status;
using kungfu::yijinjing::journal::page_lifecycle_policy;
using kungfu::yijinjing::journal::page_open_intent;
using kungfu::yijinjing::journal::page_open_policy;
using kungfu::yijinjing::journal::page_precreation;
using kungfu::yijinjing::journal::parse_page_lifecycle;
using kungfu::yijinjing::journal::reader;
using kungfu::yijinjing::journal::reader_policy;
using kungfu::yijinjing::journal::writer;
using kungfu::yijinjing::journal::writer_hook;
using kungfu::yijinjing::platform::mapped_region;
using kungfu::yijinjing::platform::mapping_access;
using kungfu::yijinjing::platform::mapping_creation;
using kungfu::yijinjing::platform::mapping_durability;
using kungfu::yijinjing::platform::mapping_policy;
using kungfu::yijinjing::platform::mapping_residency;
using kungfu::yijinjing::types::frame_header;
using kungfu::yijinjing::types::page_header;

namespace {

constexpr uint64_t TEST_PAGE_SIZE_MB = 2;
constexpr size_t TEST_PAGE_SIZE = TEST_PAGE_SIZE_MB * kungfu::yijinjing::MB;

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

bool frame_is_published_at(uintptr_t address) {
  auto *header = reinterpret_cast<frame_header *>(address);
  return std::atomic_ref<uint32_t>(header->length).load(std::memory_order_acquire) > 0 && header->carrier_type > 0;
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

auto make_named_location(const fs::path &root, const std::string &name) {
  auto page_locator = std::make_shared<locator>(root.string());
  return location::make_shared(mode::LIVE, location_role::SYSTEM, "mmap_test", name, page_locator);
}

auto make_bus() { return std::make_shared<kungfu::yijinjing::journal::bus>(false); }

class one_shot_hook : public writer_hook {
public:
  bool throw_on_open{false};
  bool throw_on_close{false};

  void on_open_frame(int64_t, frame_ptr) override {
    if (std::exchange(throw_on_open, false)) {
      throw std::runtime_error("injected open hook failure");
    }
  }

  void on_close_frame(int64_t, frame_ptr) override {
    if (std::exchange(throw_on_close, false)) {
      throw std::runtime_error("injected close hook failure");
    }
  }
};

class one_shot_publisher : public noop_publisher {
public:
  bool throw_on_notify{true};
  int notify() override {
    if (std::exchange(throw_on_notify, false)) {
      throw std::runtime_error("injected publisher failure");
    }
    return 0;
  }
};

class injectable_writer : public writer {
public:
  using writer::writer;
  bool throw_on_reserve{false};
  bool throw_on_commit{false};

protected:
  void on_frame_opened(int64_t trigger_time, kungfu::yijinjing::journal::frame *frame) override {
    writer::on_frame_opened(trigger_time, frame);
    if (std::exchange(throw_on_reserve, false)) {
      throw std::runtime_error("injected reservation failure");
    }
  }

  void on_frame_closing(int64_t gen_time, kungfu::yijinjing::journal::frame *frame) override {
    if (std::exchange(throw_on_commit, false)) {
      throw std::runtime_error("injected commit failure");
    }
    writer::on_frame_closing(gen_time, frame);
  }
};

class rollover_journal : public journal {
public:
  using journal::journal;
  bool throw_on_rollover{false};

protected:
  void close_page(int64_t trigger_time, int64_t last_gen_time) override {
    if (std::exchange(throw_on_rollover, false)) {
      throw std::runtime_error("injected page rollover failure");
    }
    journal::close_page(trigger_time, last_gen_time);
  }
};

// journal::close_page must create the next page BEFORE it publishes PageEnd on the
// page it is closing: a reader in another process that observes PageEnd immediately
// advances to the next page, and a plain reader carries no authority to create one.
// Only a source comment guarded that ordering. This probe pins it -- when close_page
// calls load_next_page the PageEnd slot must still be unpublished, and once
// close_page returns both the next page and the published PageEnd must exist.
class page_turn_order_journal : public journal {
public:
  using journal::journal;
  int page_turns_observed{0};
  int page_end_published_before_next_page{0};
  int next_page_missing_after_close{0};
  int page_end_missing_after_close{0};

protected:
  void close_page(int64_t trigger_time, int64_t last_gen_time) override {
    // Hold the closing page for the duration of the probe: journal::close_page
    // keeps only a local reference, so without this the mapping is released the
    // moment it returns and the PageEnd slot would be read after unmap.
    const kungfu::yijinjing::journal::page_ptr closing_page = page_;

    // close_page writes PageEnd into the slot after the current last frame.
    kungfu::yijinjing::journal::frame probe;
    probe.set_address(closing_page->last_frame_address());
    page_end_slot_ = probe.address() + probe.frame_length();
    const uint32_t next_page_id = closing_page->get_page_id() + 1;

    closing_ = true;
    journal::close_page(trigger_time, last_gen_time);
    closing_ = false;

    ++page_turns_observed;
    if (!page::check_page_existed(location_, dest_id_, next_page_id)) {
      ++next_page_missing_after_close;
    }
    if (!frame_is_published_at(page_end_slot_)) {
      ++page_end_missing_after_close;
    }
    page_end_slot_ = 0;
  }

  void load_next_page() override {
    if (closing_ && page_end_slot_ != 0 && frame_is_published_at(page_end_slot_)) {
      ++page_end_published_before_next_page;
    }
    journal::load_next_page();
  }

private:
  bool closing_{false};
  uintptr_t page_end_slot_{0};
};

std::string create_page_path(const kungfu::yijinjing::data::location_ptr &loc) {
  (void)loc->locator->layout_dir(loc, kungfu::yijinjing::enums::layout::JOURNAL, true);
  return page::get_page_path(loc, location::PUBLIC, 1);
}

void create_seek_page(const kungfu::yijinjing::data::location_ptr &loc, uint32_t page_id, int64_t begin_time,
                      kungfu::yijinjing::enums::PageStatus status = kungfu::yijinjing::enums::PageStatus::Normal) {
  const auto path = page::get_page_path(loc, location::PUBLIC, page_id);
  auto region = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
  auto *header = reinterpret_cast<page_header *>(region.address());
  header->version = journal_format_epoch;
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
  static_assert(journal_format_epoch == 0xe3b24c8du, "wire-v1 declared journal epoch changed");
  static_assert(sizeof(page_header) == 32, "wire-v1 page_header size changed");
  static_assert(sizeof(frame_header) == 72, "wire-v1 frame_header size changed");
  static_assert(offsetof(page_header, last_frame_position) == 24, "wire-v1 page publication token offset changed");
  static_assert(offsetof(frame_header, length) == 0, "frame publication token offset changed");
  static_assert(std::is_move_constructible_v<mapped_region>);
  static_assert(!std::is_copy_constructible_v<mapped_region>);
  static_assert(std::is_move_constructible_v<writer::frame_transaction>);
  static_assert(!std::is_copy_constructible_v<writer::frame_transaction>);
}

void test_retained_wire_v1_fixture() {
  std::ifstream input(YIJINJING_RETAINED_WIRE_V1_FIXTURE);
  require(input.good(), "retained wire-v1 fixture is unavailable");
  const auto fixture = nlohmann::json::parse(input);
  require(fixture.at("schema") == "kungfu.journal-wire-retained-fixture/v1", "retained fixture schema drifted");
  require(fixture.at("journal_format_epoch").get<uint32_t>() == journal_format_epoch, "retained journal epoch changed");
  require(fixture.at("page_header_size").get<size_t>() == sizeof(page_header), "retained page header size changed");
  require(fixture.at("frame_header_size").get<size_t>() == sizeof(frame_header), "retained frame header size changed");
  require(fixture.at("page_last_frame_position_offset").get<size_t>() == offsetof(page_header, last_frame_position),
          "retained page publication offset changed");
  require(fixture.at("frame_length_offset").get<size_t>() == offsetof(frame_header, length),
          "retained frame publication offset changed");

  temp_tree tree;
  const auto loc = make_location(tree.root());
  const auto page_size = fixture.at("page_size").get<size_t>();
  const auto &expected_frame = fixture.at("first_frame");
  const auto decode_hex = [](const std::string &hex) {
    require(hex.size() % 2 == 0, "retained fixture hex has odd length");
    std::vector<unsigned char> bytes;
    bytes.reserve(hex.size() / 2);
    for (size_t offset = 0; offset < hex.size(); offset += 2) {
      bytes.push_back(static_cast<unsigned char>(std::stoul(hex.substr(offset, 2), nullptr, 16)));
    }
    return bytes;
  };
  const auto page_header_bytes = decode_hex(fixture.at("page_header_hex").get<std::string>());
  const auto first_frame_header_bytes = decode_hex(fixture.at("first_frame_header_hex").get<std::string>());
  require(page_header_bytes.size() == sizeof(page_header), "retained page header byte count changed");
  require(first_frame_header_bytes.size() == sizeof(frame_header), "retained frame header byte count changed");
  const auto retained_path = create_page_path(loc);
  {
    std::ofstream output(retained_path, std::ios::binary | std::ios::trunc);
    require(output.good(), "retained wire-v1 page could not be created");
    output.write(reinterpret_cast<const char *>(page_header_bytes.data()),
                 static_cast<std::streamsize>(page_header_bytes.size()));
    output.write(reinterpret_cast<const char *>(first_frame_header_bytes.data()),
                 static_cast<std::streamsize>(first_frame_header_bytes.size()));
    output.seekp(static_cast<std::streamoff>(page_size - 1));
    output.put('\0');
    require(output.good(), "retained wire-v1 page bytes could not be written");
  }
  const auto retained = page::load(loc, location::PUBLIC, page_size, 1, page_open_policy::reader());
  require(retained->get_version() == journal_format_epoch, "current reader rejected retained wire-v1 epoch");
  const auto *first_frame = reinterpret_cast<const frame_header *>(retained->first_frame_address());
  require(first_frame->length == expected_frame.at("length").get<uint32_t>(), "retained frame length drifted");
  require(first_frame->header_length == expected_frame.at("header_length").get<uint32_t>(),
          "retained frame header length drifted");
  require(first_frame->gen_time == expected_frame.at("gen_time").get<int64_t>(), "retained frame gen_time drifted");
  require(first_frame->trigger_time == expected_frame.at("trigger_time").get<int64_t>(),
          "retained frame trigger_time drifted");
  require(first_frame->carrier_type == expected_frame.at("carrier_type").get<int32_t>(),
          "retained frame carrier_type drifted");
  require(first_frame->source == expected_frame.at("source").get<uint32_t>(), "retained frame source drifted");
  require(first_frame->dest == expected_frame.at("dest").get<uint32_t>(), "retained frame dest drifted");
  require(static_cast<uint32_t>(first_frame->data_type) == expected_frame.at("data_type").get<uint32_t>(),
          "retained frame data_type drifted");
  require(first_frame->initial_source == expected_frame.at("initial_source").get<uint32_t>(),
          "retained frame initial_source drifted");
  require(first_frame->journal_frame_uid == expected_frame.at("journal_frame_uid").get<uint64_t>(),
          "retained frame journal_frame_uid drifted");
  require(first_frame->trigger_frame_uid == expected_frame.at("trigger_frame_uid").get<uint64_t>(),
          "retained frame trigger_frame_uid drifted");
  require(first_frame->stream_id == expected_frame.at("stream_id").get<uint64_t>(), "retained frame stream_id drifted");
  require(retained->begin_time() == first_frame->gen_time, "page begin_time disagrees with retained frame");
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

void test_page_lifecycle_parse_is_pure_and_honest() {
  // Absent configuration keeps the historical defaults.
  const auto absent = parse_page_lifecycle(nullptr, nullptr);
  require(absent.ok() && !absent.policy.keep_page && absent.policy.max_pre_create_size_mb == 0,
          "absent page lifecycle configuration did not yield defaults");

  // Presence means enabled, matching the historical getenv() contract: any
  // value turns the knob on, including an empty one.
  require(parse_page_lifecycle("", nullptr).policy.keep_page, "empty keep-page value did not count as present");
  require(parse_page_lifecycle("0", nullptr).policy.keep_page, "keep-page presence contract is not value-insensitive");

  const auto sized = parse_page_lifecycle(nullptr, "128");
  require(sized.ok() && sized.policy.max_pre_create_size_mb == 128 && !sized.policy.keep_page,
          "valid pre-create size was not parsed");

  // An unusable setting is reported as a value rather than swallowed, and the
  // ceiling stays disabled instead of silently taking an arbitrary number.
  const auto invalid = parse_page_lifecycle(nullptr, "not-a-number");
  require(!invalid.ok() && invalid.status == page_lifecycle_parse_status::max_pre_create_size_invalid &&
              invalid.policy.max_pre_create_size_mb == 0,
          "invalid pre-create size was not reported as a value");
}

void test_page_lifecycle_survives_policy_copy() {
  // Regression: page lifecycle used to be seeded from getenv() into mutable
  // journal members that the copy constructor did not carry, so a copied
  // journal silently lost the configuration it was created with. Carrying it
  // in the (copied) policy is what fixes that.
  const auto configured = page_lifecycle_policy{true, 64};
  const auto policy = journal_open_policy::coordinator_reader().with_lifecycle(configured);
  require(policy.lifecycle.keep_page && policy.lifecycle.max_pre_create_size_mb == 64,
          "with_lifecycle did not carry the configuration");
  require(policy.precreation == page_precreation::coordinator &&
              policy.current_page.intent() == page_open_intent::reader,
          "with_lifecycle disturbed unrelated policy fields");

  const journal_open_policy copied = policy;
  require(copied.lifecycle.keep_page && copied.lifecycle.max_pre_create_size_mb == 64,
          "page lifecycle did not survive a policy copy");

  const auto reader = reader_policy::coordinator().with_lifecycle(configured);
  require(reader.journal.lifecycle.keep_page && reader.journal.lifecycle.max_pre_create_size_mb == 64,
          "reader policy did not carry page lifecycle down to the journal policy");
  require(!reader.discover_page_size, "reader with_lifecycle disturbed unrelated policy fields");

  // Defaults stay untouched for every named factory that does not ask for a
  // lifecycle, so existing call sites keep their behaviour.
  require(!journal_open_policy::writer().lifecycle.keep_page &&
              journal_open_policy::writer().lifecycle.max_pre_create_size_mb == 0,
          "named factory did not default page lifecycle");
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
  header->version = journal_format_epoch;
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
      {"version", [](page_header &header) { header.version = journal_format_epoch + 1u; }},
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
    header->version = journal_format_epoch;
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

  require(reader->get_version() == journal_format_epoch, "reader observed an unpublished page version");
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

void test_writer_transaction_recovers_from_reservation_and_commit_failures() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  injectable_writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), false, bus, TEST_PAGE_SIZE_MB);
  require(target.get_current_page()->get_page_size() == TEST_PAGE_SIZE,
          "writer fixture interpreted a byte count as mebibytes");

  target.throw_on_reserve = true;
  require_throws([&] { (void)target.reserve_frame(1, 1001, 8); }, "injected reservation failure did not escape");

  target.throw_on_commit = true;
  require_throws(
      [&] {
        auto tx = target.reserve_frame(2, 1002, 8);
        tx.commit(8, 3);
      },
      "injected commit failure did not escape");

  auto recovered = target.reserve_frame(4, 1003, 8);
  const auto published_address = recovered.frame()->address();
  recovered.commit(8, 5);
  require(frame_is_published_at(published_address), "writer did not recover after reservation/commit failures");
}

void test_writer_transaction_aborts_abandonment_and_payload_failure() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), false, bus, TEST_PAGE_SIZE_MB);

  uintptr_t abandoned_address = 0;
  {
    auto tx = target.reserve_frame(1, 1101, 8);
    abandoned_address = tx.frame()->address();
    require(!tx.frame()->has_data(), "reservation published length before commit");
  }

  require_throws(
      [&] {
        auto tx = target.reserve_frame(2, 1102, 8);
        require(tx.frame()->address() == abandoned_address, "abandonment advanced the journal cursor");
        throw std::runtime_error("injected payload construction failure");
      },
      "injected payload construction failure did not escape");

  auto recovered = target.reserve_frame(3, 1103, 8);
  require(recovered.frame()->address() == abandoned_address, "payload failure advanced the journal cursor");
  const auto published_address = recovered.frame()->address();
  recovered.commit(8, 4);
  require(frame_is_published_at(published_address), "writer did not recover after abandoned transactions");
}

void test_writer_transaction_recovers_from_hook_failures() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  auto hook = std::make_shared<one_shot_hook>();
  hookable_writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), false, bus, TEST_PAGE_SIZE_MB,
                         hook);

  hook->throw_on_open = true;
  require_throws([&] { (void)target.reserve_frame(1, 1201, 8); }, "open hook failure did not escape");

  hook->throw_on_close = true;
  require_throws(
      [&] {
        auto tx = target.reserve_frame(2, 1202, 8);
        tx.commit(8, 3);
      },
      "close hook failure did not escape");

  auto recovered = target.reserve_frame(4, 1203, 8);
  const auto published_address = recovered.frame()->address();
  recovered.commit(8, 5);
  require(frame_is_published_at(published_address), "writer did not recover after hook failures");
}

void test_writer_transaction_unlocks_before_publisher_notification() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  auto publisher = std::make_shared<one_shot_publisher>();
  writer target(loc, location::PUBLIC, publisher, false, bus, TEST_PAGE_SIZE_MB);

  uintptr_t published_address = 0;
  require_throws(
      [&] {
        auto tx = target.reserve_frame(1, 1301, 8);
        published_address = tx.frame()->address();
        tx.commit(8, 2);
      },
      "publisher notification failure did not escape");
  require(frame_is_published_at(published_address), "publisher failure rolled back an already published frame");

  auto recovered = target.reserve_frame(3, 1302, 8);
  recovered.commit(8, 4);
}

void test_writer_transaction_recovers_from_page_rollover_failure() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  auto backing = std::make_shared<rollover_journal>(loc, location::PUBLIC, journal_open_policy::writer(), false, bus,
                                                    TEST_PAGE_SIZE);
  writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), backing, 0);
  constexpr size_t LARGE_PAYLOAD = TEST_PAGE_SIZE / 2;

  auto first = target.reserve_frame(1, 1401, LARGE_PAYLOAD);
  first.commit(LARGE_PAYLOAD, 2);

  backing->throw_on_rollover = true;
  require_throws([&] { (void)target.reserve_frame(3, 1402, LARGE_PAYLOAD); }, "page rollover failure did not escape");

  auto recovered = target.reserve_frame(4, 1403, 8);
  const auto published_address = recovered.frame()->address();
  recovered.commit(8, 5);
  require(frame_is_published_at(published_address), "writer did not recover after page rollover failure");
}

void test_page_release_does_not_poll_external_lease() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = std::make_shared<kungfu::yijinjing::journal::bus>(true);
  auto backing =
      std::make_shared<journal>(loc, location::PUBLIC, journal_open_policy::writer(), true, bus, TEST_PAGE_SIZE);
  writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), backing, 0);
  constexpr size_t LARGE_PAYLOAD = TEST_PAGE_SIZE / 2;

  auto first = target.reserve_frame(1, 1501, LARGE_PAYLOAD);
  first.commit(LARGE_PAYLOAD, 2);
  auto external_lease = target.get_current_page();
  const auto first_page_id = external_lease->get_page_id();

  auto second = target.reserve_frame(3, 1502, LARGE_PAYLOAD);
  second.commit(LARGE_PAYLOAD, 4);
  require(target.get_current_page()->get_page_id() != first_page_id, "fixture did not roll to the next page");

  std::weak_ptr<page> released_page = external_lease;
  const auto start = std::chrono::steady_clock::now();
  target.release_page();
  const auto elapsed = std::chrono::steady_clock::now() - start;
  require(elapsed < std::chrono::milliseconds(50), "page release waited for an external shared owner");
  require(!released_page.expired() && external_lease->get_page_id() == first_page_id,
          "page release invalidated an active external lease");

  external_lease.reset();
  require(released_page.expired(), "final external release did not destroy the passed page exactly once");
}

// Seed one journal (identified by dest_id) with an exact gen_time per frame, so
// a merge assertion can name the expected interleaving instead of racing wall
// clock time.
void seed_journal_at(const kungfu::yijinjing::data::location_ptr &loc, uint32_t dest_id,
                     const std::vector<int64_t> &gen_times) {
  writer seed(loc, dest_id, std::make_shared<noop_publisher>(), false, make_bus(), TEST_PAGE_SIZE_MB);
  for (const auto gen_time : gen_times) {
    seed.mark_at(gen_time, gen_time, 1601);
  }
}

// Drain the reader and record (gen_time, dest) in the order it hands frames out.
std::vector<std::pair<int64_t, uint32_t>> drain(reader &target, size_t limit) {
  std::vector<std::pair<int64_t, uint32_t>> observed;
  while (observed.size() < limit && target.data_available()) {
    const auto frame = target.current_frame();
    observed.emplace_back(frame->gen_time(), frame->dest());
    target.next();
  }
  return observed;
}

// Tie contract: equal gen_time resolves towards the higher Priority.
void test_reader_merge_breaks_gen_time_ties_by_priority() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  seed_journal_at(loc, 1, {100});
  seed_journal_at(loc, 2, {100});
  seed_journal_at(loc, 3, {100});

  reader target(reader_policy::peer(), true, make_bus());
  target.join(loc, 1, 0, TEST_PAGE_SIZE_MB, kungfu::yijinjing::enums::Priority::Low);
  target.join(loc, 2, 0, TEST_PAGE_SIZE_MB, kungfu::yijinjing::enums::Priority::High);
  target.join(loc, 3, 0, TEST_PAGE_SIZE_MB, kungfu::yijinjing::enums::Priority::Medium);

  const auto observed = drain(target, 3);
  require(observed.size() == 3, "reader did not surface every tied frame");
  const std::vector<uint32_t> expected_dest{2, 3, 1}; // High, Medium, Low
  for (size_t i = 0; i < expected_dest.size(); ++i) {
    require(observed[i].first == 100, "priority tie-break must not reorder gen_time");
    require(observed[i].second == expected_dest[i],
            "priority tie-break picked the wrong journal at index " + std::to_string(i) + ": expected dest " +
                std::to_string(expected_dest[i]) + ", got " + std::to_string(observed[i].second));
  }
}

// Priority outranks gen_time: the ordering is (Priority desc, gen_time asc), not
// (gen_time asc) with priority as a tiebreak only.
void test_reader_merge_prefers_priority_over_gen_time() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  seed_journal_at(loc, 1, {10}); // earlier, but Low
  seed_journal_at(loc, 2, {99}); // later, but High

  reader target(reader_policy::peer(), true, make_bus());
  target.join(loc, 1, 0, TEST_PAGE_SIZE_MB, kungfu::yijinjing::enums::Priority::Low);
  target.join(loc, 2, 0, TEST_PAGE_SIZE_MB, kungfu::yijinjing::enums::Priority::High);

  const auto observed = drain(target, 2);
  require(observed.size() == 2, "reader did not surface both frames");
  require(observed[0].second == 2, "higher Priority must be read before an earlier low-priority frame");
  require(observed[1].second == 1, "low-priority journal must still be drained");
}

// The two selection paths must agree on the merge front: seek_to_time() picks it
// through the linear sort_without_buffer() scan, data_available() through the
// sort() heap. Both derive from reads_before, so they must land on the same
// journal.
//
// join() is deliberately not the trigger here: it only re-selects while
// current_ == nullptr, so as not to move a cursor that is mid-read. Joining
// three journals therefore leaves current_ on the first one, whatever its
// gen_time. seek_to_time() re-selects unconditionally.
void test_reader_buffered_and_unbuffered_sort_agree() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  seed_journal_at(loc, 1, {70});
  seed_journal_at(loc, 2, {20});
  seed_journal_at(loc, 3, {50});

  reader unbuffered(reader_policy::peer(), true, make_bus());
  unbuffered.join(loc, 1, 0, TEST_PAGE_SIZE_MB);
  unbuffered.join(loc, 2, 0, TEST_PAGE_SIZE_MB);
  unbuffered.join(loc, 3, 0, TEST_PAGE_SIZE_MB);
  unbuffered.seek_to_time(0); // re-selects across all three via sort_without_buffer()
  const auto unbuffered_front = unbuffered.current_frame()->gen_time();

  reader buffered(reader_policy::peer(), true, make_bus());
  buffered.join(loc, 1, 0, TEST_PAGE_SIZE_MB);
  buffered.join(loc, 2, 0, TEST_PAGE_SIZE_MB);
  buffered.join(loc, 3, 0, TEST_PAGE_SIZE_MB);
  require(buffered.data_available(), "buffered reader saw no data"); // drives sort()
  const auto buffered_front = buffered.current_frame()->gen_time();

  require(unbuffered_front == 20, "sort_without_buffer did not select the earliest frame");
  require(buffered_front == unbuffered_front, "buffered and unbuffered sort disagree on the merge front");
}

// join() must not move a live cursor: re-selecting mid-read would skip or repeat
// frames for the consumer. This pins the guard that the merge-order refactor
// must not "tidy away".
void test_reader_join_does_not_move_a_live_cursor() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  seed_journal_at(loc, 1, {70});

  reader target(reader_policy::peer(), true, make_bus());
  target.join(loc, 1, 0, TEST_PAGE_SIZE_MB);
  require(target.current_frame()->gen_time() == 70, "first join did not select the only journal");

  // A later, earlier-timestamped journal must not steal the cursor on join.
  seed_journal_at(loc, 2, {20});
  target.join(loc, 2, 0, TEST_PAGE_SIZE_MB);
  require(target.current_frame()->gen_time() == 70, "join moved a cursor that was already selected");

  // It is picked up on the next explicit selection.
  require(target.data_available(), "reader saw no data after join");
  require(target.current_frame()->gen_time() == 20, "sort() did not admit the newly joined journal");
}

void test_reader_journal_lookup_is_a_typed_value() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  seed_journal_at(loc, location::PUBLIC, {100});

  reader target(reader_policy::peer(), true, make_bus());
  const auto missing = target.get_journal(loc, location::PUBLIC);
  require(!missing, "an unjoined journal was reported as present");
  require(missing.error() == kungfu::yijinjing::journal::journal_lookup_error::not_joined,
          "an unjoined journal returned the wrong typed lookup error");

  target.join(loc, location::PUBLIC, 0, TEST_PAGE_SIZE_MB);
  const auto joined = target.get_journal(loc, location::PUBLIC);
  require(joined.has_value() && *joined != nullptr, "a joined journal was not returned as a value");
}

void test_reader_management_uses_membership_snapshots() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto writer_bus = make_bus();
  writer seed(loc, location::PUBLIC, std::make_shared<noop_publisher>(), false, writer_bus, TEST_PAGE_SIZE_MB);
  seed.mark(1, 1601);

  auto management_bus = std::make_shared<kungfu::yijinjing::journal::bus>(true);
  reader target(reader_policy::peer(), true, management_bus);
  target.join(loc, location::PUBLIC, 0, TEST_PAGE_SIZE_MB);
  const auto retained_snapshot = target.get_journals();
  require(retained_snapshot.size() == 1, "reader snapshot omitted joined journal");

  std::exception_ptr management_error;
  std::thread manager([&] {
    try {
      for (int i = 0; i < 200; ++i) {
        (void)target.get_journals();
        target.preload_next_page();
        target.release_page();
      }
    } catch (...) {
      management_error = std::current_exception();
    }
  });

  for (int i = 0; i < 50; ++i) {
    target.disjoin_channel(loc, location::PUBLIC);
    target.join(loc, location::PUBLIC, 0, TEST_PAGE_SIZE_MB);
  }
  manager.join();
  if (management_error) {
    std::rethrow_exception(management_error);
  }

  target.disjoin_channel(loc, location::PUBLIC);
  require(target.get_journals().empty(), "reader membership snapshot retained a disjoined journal");
  require(retained_snapshot.size() == 1, "previous reader snapshot aliased the mutable journal map");
}

} // namespace

void test_close_page_creates_next_page_before_page_end() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  auto bus = make_bus();
  auto backing = std::make_shared<page_turn_order_journal>(loc, location::PUBLIC, journal_open_policy::writer(), false,
                                                           bus, TEST_PAGE_SIZE);
  writer target(loc, location::PUBLIC, std::make_shared<noop_publisher>(), backing, 0);
  constexpr size_t LARGE_PAYLOAD = TEST_PAGE_SIZE / 2;

  for (int64_t gen = 1; gen <= 6; ++gen) {
    auto tx = target.reserve_frame(gen, 1501, LARGE_PAYLOAD);
    tx.commit(LARGE_PAYLOAD, gen);
  }

  require(backing->page_turns_observed >= 2, "fixture did not roll enough pages to probe turn-page ordering");
  require(backing->page_end_published_before_next_page == 0,
          "close_page published PageEnd before the next page existed");
  require(backing->next_page_missing_after_close == 0, "close_page returned without creating the next page");
  require(backing->page_end_missing_after_close == 0, "close_page returned without publishing PageEnd");
}

// page::load spins on the last_frame_position publication token when it opens a
// virgin page without initialization authority. Prove that a concurrent
// initializer releases that spin and that the acquiring reader observes a fully
// published header rather than the zeroed bytes it started from.
void test_virgin_page_initialization_unblocks_concurrent_reader() {
  temp_tree tree;
  auto loc = make_location(tree.root());
  const auto path = create_page_path(loc);
  {
    auto region = mapped_region::map(path, TEST_PAGE_SIZE, mapping_policy::write_create_or_grow());
    std::memset(reinterpret_cast<void *>(region.address()), 0, sizeof(page_header));
    require(region.reset(), "failed to release virgin page fixture");
  }

  std::exception_ptr reader_error;
  kungfu::yijinjing::journal::page_ptr observed;
  std::thread reader_thread([&] {
    try {
      observed = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::reader());
    } catch (...) {
      reader_error = std::current_exception();
    }
  });

  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  auto initialized = page::load(loc, location::PUBLIC, TEST_PAGE_SIZE, 1, page_open_policy::writer());
  reader_thread.join();

  if (reader_error) {
    std::rethrow_exception(reader_error);
  }
  require(static_cast<bool>(observed), "concurrent reader did not return the initialized virgin page");
  require(observed->get_page_id() == 1, "concurrent reader observed the wrong page");
  require(observed->get_version() == journal_format_epoch, "concurrent reader observed an unpublished page version");
  require(observed->last_frame_address() == observed->address() + sizeof(page_header),
          "concurrent reader observed an uninitialized publication token");
  require(!initialized->is_pre_open(), "initializing writer did not publish Normal page status");
}

// The k-way merge must yield a single non-decreasing gen_time order across joined
// journals of equal priority, including frames written at identical times.
// (reader::later orders by priority first, so this pins the same-priority case.)
void test_reader_merges_joined_journals_in_time_order() {
  temp_tree tree;
  const std::pair<const char *, std::vector<int64_t>> plan[] = {
      {"peer_a", {10, 40, 50, 70}},
      {"peer_b", {20, 40, 60}},
      {"peer_c", {30, 50, 80}},
  };

  std::vector<kungfu::yijinjing::data::location_ptr> locations;
  std::vector<int64_t> expected;
  for (const auto &[name, times] : plan) {
    auto loc = make_named_location(tree.root(), name);
    locations.push_back(loc);
    auto write_bus = make_bus();
    writer out(loc, location::PUBLIC, std::make_shared<noop_publisher>(), false, write_bus, TEST_PAGE_SIZE_MB);
    for (const auto gen_time : times) {
      auto tx = out.reserve_frame(gen_time, 1502, sizeof(int64_t));
      std::memcpy(tx.data(), &gen_time, sizeof(int64_t));
      tx.commit(sizeof(int64_t), gen_time);
      expected.push_back(gen_time);
    }
  }
  std::sort(expected.begin(), expected.end());

  auto read_bus = make_bus();
  reader target(reader_policy::peer(), false, read_bus);
  for (const auto &loc : locations) {
    target.join(loc, location::PUBLIC, 0, TEST_PAGE_SIZE_MB);
  }

  std::vector<int64_t> observed;
  for (size_t guard = 0; guard < 1000 && target.data_available(); ++guard) {
    auto current = target.current_frame();
    if (current->carrier_type() == 1502) {
      observed.push_back(current->gen_time());
    }
    target.next();
  }

  require(observed.size() == expected.size(),
          "reader merge dropped or duplicated frames: observed=" + std::to_string(observed.size()) +
              " expected=" + std::to_string(expected.size()));
  require(std::is_sorted(observed.begin(), observed.end()), "reader merge did not yield non-decreasing gen_time order");
  require(observed == expected, "reader merge did not yield the written gen_time multiset");
}

int main() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"wire layout invariants", test_wire_layout_invariants},
      {"retained wire-v1 fixture", test_retained_wire_v1_fixture},
      {"mapping policy truth table", test_mapping_policy_truth_table},
      {"page open intent truth table", test_page_open_intent_truth_table},
      {"page lifecycle parse is pure and honest", test_page_lifecycle_parse_is_pure_and_honest},
      {"page lifecycle survives policy copy", test_page_lifecycle_survives_policy_copy},
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
      {"writer transaction reservation and commit recovery",
       test_writer_transaction_recovers_from_reservation_and_commit_failures},
      {"writer transaction abandonment and payload recovery",
       test_writer_transaction_aborts_abandonment_and_payload_failure},
      {"writer transaction hook recovery", test_writer_transaction_recovers_from_hook_failures},
      {"writer transaction publisher recovery", test_writer_transaction_unlocks_before_publisher_notification},
      {"writer transaction page rollover recovery", test_writer_transaction_recovers_from_page_rollover_failure},
      {"page release does not poll external lease", test_page_release_does_not_poll_external_lease},
      {"reader management membership snapshots", test_reader_management_uses_membership_snapshots},
      {"close page creates next page before page end", test_close_page_creates_next_page_before_page_end},
      {"virgin page initialization unblocks concurrent reader",
       test_virgin_page_initialization_unblocks_concurrent_reader},
      {"reader merges joined journals in time order", test_reader_merges_joined_journals_in_time_order},
      {"reader merge breaks gen_time ties by priority", test_reader_merge_breaks_gen_time_ties_by_priority},
      {"reader merge prefers priority over gen_time", test_reader_merge_prefers_priority_over_gen_time},
      {"reader buffered and unbuffered sort agree", test_reader_buffered_and_unbuffered_sort_agree},
      {"reader join does not move a live cursor", test_reader_join_does_not_move_a_live_cursor},
      {"reader journal lookup is a typed value", test_reader_journal_lookup_is_a_typed_value},
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
