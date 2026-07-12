// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/rx.h>
#include <kungfu/yijinjing/journal/journal.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <thread>

namespace fs = std::filesystem;
using kungfu::rx::loop_error_scope;
using kungfu::rx::loop_error_state;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::bus;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::replay_exhausted;
using kungfu::yijinjing::journal::replay_writer;
using kungfu::yijinjing::journal::writer;

namespace {

constexpr size_t TEST_PAGE_SIZE = 2 * kungfu::yijinjing::MB;
volatile std::sig_atomic_t sigint_count = 0;

void count_sigint(int) { sigint_count = sigint_count + 1; }

class sigint_guard {
public:
  sigint_guard() : previous_(std::signal(SIGINT, count_sigint)) {}
  ~sigint_guard() { std::signal(SIGINT, previous_); }

private:
  decltype(std::signal(SIGINT, count_sigint)) previous_;
};

void require(bool condition, const std::string &message) {
  if (not condition) {
    throw std::runtime_error(message);
  }
}

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-runtime-error-test-" + std::to_string(nonce));
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

void test_first_error_wins_and_stop_is_idempotent() {
  auto state = std::make_shared<loop_error_state>();
  require(state->record_error(std::make_exception_ptr(std::logic_error("first cause"))),
          "first subscriber error was not recorded");
  require(not state->record_error(std::make_exception_ptr(std::runtime_error("second cause"))),
          "second subscriber error replaced the first cause");
  state->request_stop();
  state->request_stop();

  require(state->stop_requested(), "subscriber error did not request stop");
  try {
    state->rethrow_if_error();
  } catch (const std::logic_error &error) {
    require(std::string(error.what()) == "first cause", "first subscriber cause was replaced");
    state->reset();
    require(not state->stop_requested() and not state->first_error(), "loop error state did not reset for reuse");
    return;
  }
  throw std::runtime_error("first subscriber cause was not rethrown with its original type");
}

void test_loop_states_are_isolated() {
  auto first = std::make_shared<loop_error_state>();
  auto second = std::make_shared<loop_error_state>();
  std::thread first_thread(
      [&] { (void)first->record_error(std::make_exception_ptr(std::runtime_error("first loop"))); });
  std::thread second_thread(
      [&] { (void)second->record_error(std::make_exception_ptr(std::runtime_error("second loop"))); });
  first_thread.join();
  second_thread.join();

  auto message = [](const std::shared_ptr<loop_error_state> &state) {
    try {
      state->rethrow_if_error();
    } catch (const std::exception &error) {
      return std::string(error.what());
    }
    return std::string();
  };
  require(message(first) == "first loop", "first loop received another loop's error");
  require(message(second) == "second loop", "second loop received another loop's error");
}

void test_error_scope_does_not_extend_owner_lifetime() {
  std::weak_ptr<loop_error_state> weak;
  {
    auto state = std::make_shared<loop_error_state>();
    weak = state;
    loop_error_scope scope(state);
    require(not kungfu::rx::current_loop_error_state.expired(), "loop error scope did not expose its owner token");
  }
  require(weak.expired(), "subscription error token retained its owner after teardown");
  require(kungfu::rx::current_loop_error_state.expired(), "loop error scope leaked thread-local owner state");
  try {
    kungfu::rx::report_subscriber_error(weak, std::make_exception_ptr(std::logic_error("expired owner")));
  } catch (const std::logic_error &error) {
    require(std::string(error.what()) == "expired owner", "expired owner fallback lost the original cause");
    return;
  }
  throw std::runtime_error("expired owner callback did not return control to its caller");
}

void test_replay_exhaustion_is_typed_and_signal_free() {
  temp_tree tree;
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto source = location::make_shared(mode::LIVE, location_role::SYSTEM, "replay_test", "writer", page_locator);
  auto journal_bus = std::make_shared<bus>(false);
  auto publisher = std::make_shared<noop_publisher>();
  constexpr int32_t available_carrier = 1001;
  constexpr int32_t missing_carrier = 2002;

  {
    writer fixture(source, location::PUBLIC, publisher, false, journal_bus, TEST_PAGE_SIZE);
    auto transaction = fixture.reserve_frame(1, available_carrier, 8);
    transaction.commit(8, 2);
  }

  sigint_count = 0;
  sigint_guard signal_observer;
  bool typed_error_observed = false;
  try {
    replay_writer replay(source, location::PUBLIC, publisher, journal_bus, TEST_PAGE_SIZE, 0);
    (void)replay.reserve_frame(3, missing_carrier, 8);
  } catch (const replay_exhausted &error) {
    typed_error_observed = true;
    require(error.carrier_type() == missing_carrier, "replay error lost its carrier type");
    require(error.trigger_time() == 3, "replay error lost its trigger time");
  }
  require(typed_error_observed, "replay exhaustion returned a synthetic writable frame");
  require(sigint_count == 0, "replay exhaustion emitted SIGINT");
}

} // namespace

int main() {
  test_first_error_wins_and_stop_is_idempotent();
  test_loop_states_are_isolated();
  test_error_scope_does_not_extend_owner_lifetime();
  test_replay_exhaustion_is_typed_and_signal_free();
  return 0;
}
