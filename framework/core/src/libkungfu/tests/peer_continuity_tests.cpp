// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/live/continuity.h>
#include <kungfu/runtime/live/key_value_store.h>
#include <kungfu/runtime/os.h>

#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using kungfu::runtime::live::continuity_admission;
using kungfu::runtime::live::coordinator_authority;
using kungfu::runtime::live::peer_continuity_observation;
using kungfu::runtime::live::peer_continuity_phase;
using kungfu::runtime::live::peer_continuity_tracker;

namespace {

namespace fs = std::filesystem;

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

void test_coordinator_admission_fences_stale_authority() {
  const coordinator_authority observed{7, 11};
  require(kungfu::runtime::live::admit_coordinator(observed, {7, 12}).accepted(),
          "same-generation replacement coordinator was rejected");
  require(kungfu::runtime::live::admit_coordinator(observed, {8, 1}).accepted(), "new runtime generation was rejected");
  require(kungfu::runtime::live::admit_coordinator(observed, {6, 99}).admission ==
              continuity_admission::StaleGeneration,
          "older runtime generation was not fenced");
  require(kungfu::runtime::live::admit_coordinator(observed, {7, 11}).admission ==
              continuity_admission::StaleCoordinator,
          "duplicate coordinator epoch was not fenced");
}

void test_coordinator_rejects_peer_from_the_future() {
  peer_continuity_observation peer{{coordinator_authority{7, 12}}, 2};
  require(kungfu::runtime::live::admit_peer_observation(peer, {7, 11}).admission ==
              continuity_admission::FutureCoordinator,
          "older coordinator accepted a peer that observed its replacement");
  require(kungfu::runtime::live::admit_peer_observation(peer, {6, 99}).admission ==
              continuity_admission::FutureGeneration,
          "older runtime generation accepted a peer from the future");
  require(kungfu::runtime::live::admit_peer_observation(peer, {8, 1}).accepted(),
          "new runtime generation rejected an older peer observation");
}

void test_registration_payload_round_trip_is_exact() {
  const peer_continuity_observation observation{{coordinator_authority{17, 23}}, 4};
  const auto request = kungfu::runtime::live::attach_peer_continuity_observation(R"({"name":"peer"})", observation);
  const auto parsed_request = kungfu::runtime::live::parse_peer_continuity_observation(request);
  require(parsed_request.reconnect_attempt == 4 && parsed_request.last_authority.has_value() &&
              parsed_request.last_authority->runtime_generation == 17 &&
              parsed_request.last_authority->coordinator_epoch == 23,
          "peer continuity observation did not round-trip");

  const auto response = kungfu::runtime::live::attach_coordinator_authority(request, {18, 1});
  const auto parsed_response = kungfu::runtime::live::parse_coordinator_authority(response);
  require(parsed_response.runtime_generation == 18 && parsed_response.coordinator_epoch == 1,
          "coordinator authority did not round-trip");
}

void test_tracker_uses_bounded_retry_and_requires_bootstrap() {
  peer_continuity_tracker tracker;
  tracker.disconnect(1'000);
  require(tracker.retry_due(1'000), "disconnected peer did not retry immediately");
  tracker.begin_attempt(1'000);
  require(tracker.phase() == peer_continuity_phase::Registering && tracker.reconnect_attempt() == 1,
          "first reconnect attempt was not recorded");
  require(!tracker.retry_due(1'000), "reconnect backoff was not applied");
  require(tracker.retry_due(100'001'000), "first bounded reconnect backoff did not expire");
  tracker.begin_attempt(100'001'000);
  require(tracker.reconnect_attempt() == 2 && tracker.next_attempt_at() == 300'001'000,
          "exponential reconnect backoff drifted");

  const auto admitted = tracker.admit({7, 11}, 300'001'000);
  require(admitted.accepted() && tracker.phase() == peer_continuity_phase::Recovering,
          "accepted authority bypassed the recovery phase");
  tracker.mark_ready();
  require(tracker.phase() == peer_continuity_phase::Ready && !tracker.retry_due(9'000'000'000),
          "ready peer kept retrying registration");

  tracker.disconnect(10'000'000'000);
  tracker.begin_attempt(10'000'000'000);
  require(tracker.admit({7, 11}, 10'000'000'001).admission == continuity_admission::StaleCoordinator,
          "tracker accepted a duplicate coordinator after disconnect");
  require(tracker.phase() == peer_continuity_phase::Registering, "rejected coordinator changed peer recovery phase");
}

void test_empty_live_kv_directory_is_an_uninitialized_store() {
#if KUNGFU_HAS_ROCKSDB
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::temp_directory_path() / ("kungfu-live-kv-cold-start-" + std::to_string(nonce));
  const auto store_path = root / "map" / "system" / "master" / "master" / "live";
  fs::create_directories(store_path);

  try {
    const auto store = kungfu::runtime::live::make_live_key_value_store(store_path.string(), true);
    require(store->get("location_uid64").empty(), "empty live-KV directory did not read as uninitialized");
    store->put("cold-start", "ready");
    require(store->get("cold-start") == "ready", "uninitialized live-KV store did not bootstrap on first write");
  } catch (...) {
    std::error_code ignored;
    fs::remove_all(root, ignored);
    throw;
  }

  std::error_code ignored;
  fs::remove_all(root, ignored);
#endif
}

void test_writable_live_kv_reopens_after_reading_an_existing_store() {
#if KUNGFU_HAS_ROCKSDB
  const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
  const auto root = fs::temp_directory_path() / ("kungfu-live-kv-read-then-write-" + std::to_string(nonce));
  const auto store_path = root / "map" / "system" / "master" / "master" / "live";

  try {
    {
      const auto seed = kungfu::runtime::live::make_live_key_value_store(store_path.string(), true);
      seed->put("existing", "value");
    }
    const auto store = kungfu::runtime::live::make_live_key_value_store(store_path.string(), true);
    require(store->get("existing") == "value", "existing live-KV store did not open for reading");
    store->put_many({{"replacement", "ready"}});
    require(store->get("replacement") == "ready", "writable live-KV store retained a read-only handle");
  } catch (...) {
    std::error_code ignored;
    fs::remove_all(root, ignored);
    throw;
  }

  std::error_code ignored;
  fs::remove_all(root, ignored);
#endif
}

void test_process_liveness_fails_closed_around_the_current_process() {
  require(kungfu::runtime::os::is_process_alive(GETPID()), "current process was reported dead");
  require(not kungfu::runtime::os::is_process_alive(-1), "invalid process identity was reported alive");
}
} // namespace

int main() {
  const std::vector<std::pair<const char *, void (*)()>> tests{
      {"coordinator admission fences stale authority", test_coordinator_admission_fences_stale_authority},
      {"coordinator rejects peer from the future", test_coordinator_rejects_peer_from_the_future},
      {"registration payload round trip is exact", test_registration_payload_round_trip_is_exact},
      {"tracker uses bounded retry and requires bootstrap", test_tracker_uses_bounded_retry_and_requires_bootstrap},
      {"empty live KV directory is an uninitialized store", test_empty_live_kv_directory_is_an_uninitialized_store},
      {"writable live KV reopens after reading an existing store",
       test_writable_live_kv_reopens_after_reading_an_existing_store},
      {"process liveness fails closed around current process",
       test_process_liveness_fails_closed_around_the_current_process},
  };
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "PASS " << name << '\n';
    } catch (const std::exception &error) {
      std::cerr << "FAIL " << name << ": " << error.what() << '\n';
      return 1;
    }
  }
  return 0;
}
