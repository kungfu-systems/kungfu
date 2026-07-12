// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/state_service.h>
#include <kungfu/runtime/state_shadow.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/ownership.h>

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>

namespace fs = std::filesystem;
using kungfu::runtime::durability::stream_position;
using kungfu::runtime::state_service::service;
using kungfu::runtime::state_service::shadow_comparator;
using kungfu::runtime::state_service::shadow_lane;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::bus;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::writer;
using kungfu::yijinjing::ownership::busy_error;
using kungfu::yijinjing::ownership::lease;

namespace {

constexpr size_t TEST_PAGE_SIZE = 2 * kungfu::yijinjing::MB;

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-state-service-test-" + std::to_string(nonce));
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

void test_data_root_lease_is_unique_and_generation_is_monotonic() {
  temp_tree tree;
  uint64_t first_generation = 0;
  std::string first_token;
  {
    auto first = lease::acquire_data_root_service(tree.root().string());
    first_generation = first.status().generation;
    first_token = first.status().fence_token;
    bool refused = false;
    try {
      auto second = lease::acquire_data_root_service(tree.root().string());
      (void)second;
    } catch (const busy_error &) {
      refused = true;
    }
    require(refused, "a second in-process data-root owner was accepted");
  }
  auto reopened = lease::acquire_data_root_service(tree.root().string());
  require(reopened.status().generation == first_generation + 1, "clean reopen did not advance generation");
  require(reopened.status().fence_token != first_token, "clean reopen reused its fence token");
  require(!reopened.status().recovered_stale_owner, "clean reopen was reported as stale-owner recovery");
}

void test_writer_resource_identity_cannot_escape_ownership_root() {
  temp_tree tree;
  bool refused = false;
  try {
    auto invalid = lease::acquire_stream_writer(tree.root().string(), "../other-root");
    (void)invalid;
  } catch (const std::invalid_argument &) {
    refused = true;
  }
  require(refused, "writer resource identity accepted a path separator");
}

void test_writer_is_fenced_before_a_second_business_write() {
  temp_tree tree;
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto source = location::make_shared(mode::LIVE, location_role::SYSTEM, "fencing_test", "writer", page_locator);
  auto journal_bus = std::make_shared<bus>(false);
  auto publisher = std::make_shared<noop_publisher>();
  constexpr uint32_t dest = location::PUBLIC;

  {
    writer first(source, dest, publisher, false, journal_bus, TEST_PAGE_SIZE);
    bool refused = false;
    try {
      writer second(source, dest, publisher, false, journal_bus, TEST_PAGE_SIZE);
      auto transaction = second.reserve_frame(1, 1001, 8);
      transaction.commit(8, 2);
    } catch (const busy_error &) {
      refused = true;
    }
    require(refused, "a second writer reached a business write");
  }

  writer reopened(source, dest, publisher, false, journal_bus, TEST_PAGE_SIZE);
  auto transaction = reopened.reserve_frame(3, 1002, 8);
  transaction.commit(8, 4);
}

void test_shadow_compare_survives_restart_and_reports_drift() {
  shadow_comparator comparator;
  const stream_position equal{7, 11, 1, 101};
  const stream_position missing_split{7, 11, 2, 102};
  const stream_position missing_compatibility{7, 11, 3, 103};
  const stream_position mismatch{7, 11, 4, 104};
  comparator.observe(shadow_lane::Compatibility, equal, "same");
  comparator.observe(shadow_lane::Compatibility, equal, "same");
  comparator.observe(shadow_lane::Split, equal, "same");
  comparator.observe(shadow_lane::Compatibility, missing_split, "old-only");
  comparator.observe(shadow_lane::Split, missing_compatibility, "new-only");
  comparator.observe(shadow_lane::Compatibility, mismatch, "old");
  comparator.observe(shadow_lane::Split, mismatch, "new");

  auto restored = shadow_comparator::restore(comparator.snapshot());
  const auto report = restored.report();
  require(report.equal == 1, "shadow equality was lost across restart");
  require(report.duplicate_compatibility == 1, "shadow duplicate was not reported");
  require(report.missing_split == 1 && report.missing_compatibility == 1, "shadow missing frame was not reported");
  require(report.mismatched == 1, "shadow state mismatch was not reported");
  require(!report.converged(), "drifting shadow paths were reported as converged");
}

void test_state_service_lifecycle_is_independent_and_fail_closed() {
  temp_tree tree;
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto home = location::make_shared(mode::LIVE, location_role::SYSTEM, "service", "coordinator", page_locator);
  auto io_device = std::make_shared<kungfu::runtime::io_device_coordinator>(home, false);
  service state_service(io_device);
  require(state_service.status().ownership.owned, "state service did not expose ownership status");
  require(!state_service.status().running, "state service started implicitly");

  bool refused_before_start = false;
  try {
    state_service.pause_projection(false);
  } catch (const std::logic_error &) {
    refused_before_start = true;
  }
  require(refused_before_start, "state mutation was accepted before service start");

  bool second_owner_refused = false;
  try {
    service second(io_device);
  } catch (const busy_error &) {
    second_owner_refused = true;
  }
  require(second_owner_refused, "second state service initialized a projection store");

  state_service.start();
  state_service.start();
  require(state_service.status().running, "state service did not start idempotently");
  state_service.pause_projection(true);
  state_service.pause_projection(false);
  state_service.stop();
  state_service.stop();
  require(!state_service.status().running, "state service did not stop idempotently");

  bool refused_after_stop = false;
  try {
    state_service.pause_projection(false);
  } catch (const std::logic_error &) {
    refused_after_stop = true;
  }
  require(refused_after_stop, "state mutation was accepted after service stop");
}

int run_default_tests() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"data-root lease is unique and generations are monotonic",
       test_data_root_lease_is_unique_and_generation_is_monotonic},
      {"writer resource identity stays inside the ownership root",
       test_writer_resource_identity_cannot_escape_ownership_root},
      {"stream writer is fenced before a second business write", test_writer_is_fenced_before_a_second_business_write},
      {"shadow compare covers duplicates, missing frames, restart, and state equality",
       test_shadow_compare_survives_restart_and_reports_drift},
      {"state service lifecycle is independent and fail closed",
       test_state_service_lifecycle_is_independent_and_fail_closed},
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

} // namespace

int main(int argc, char **argv) {
  if (argc == 1) {
    return run_default_tests();
  }
  if (argc < 3) {
    return 64;
  }
  const std::string command = argv[1];
  const std::string root = argv[2];
  try {
    if (command == "--crash-owner") {
      auto owner = lease::acquire_data_root_service(root);
      require(owner.owns(), "crash fixture did not acquire ownership");
      std::_Exit(0);
    }
    if (command == "--expect-recovered-owner") {
      auto owner = lease::acquire_data_root_service(root);
      require(owner.status().recovered_stale_owner, "unclean exit did not leave stale-owner evidence");
      require(owner.status().generation >= 2, "stale-owner recovery did not advance generation");
      return 0;
    }
    if (command == "--expect-clean-reopen") {
      auto owner = lease::acquire_data_root_service(root);
      require(!owner.status().recovered_stale_owner, "clean release was reported as stale-owner recovery");
      require(owner.status().generation >= 2, "clean reopen did not advance generation");
      return 0;
    }
    if (command == "--hold-owner") {
      if (argc < 5) {
        return 64;
      }
      auto owner = lease::acquire_data_root_service(root);
      std::ofstream(argv[3]) << owner.status().generation << '\n' << owner.status().fence_token << '\n';
      while (!fs::exists(argv[4])) {
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
      }
      return 0;
    }
    if (command == "--expect-owner-busy") {
      try {
        auto owner = lease::acquire_data_root_service(root);
        (void)owner;
      } catch (const busy_error &) {
        return 0;
      }
      throw std::runtime_error("a live owner was not fenced");
    }
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
  return 64;
}
