// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/io.h>
#include <kungfu/runtime/projection_bootstrap.h>
#include <kungfu/runtime/state_service.h>
#include <kungfu/yijinjing/ownership.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using kungfu::runtime::durability::durability_profile;
using kungfu::runtime::durability::durable_record;
using kungfu::runtime::durability::ingest_options;
using kungfu::runtime::durability::receipt_status;
using kungfu::runtime::durability::stream_position;
using kungfu::runtime::state_service::bootstrap_outcome;
using kungfu::runtime::state_service::peer_state_requirement;
using kungfu::runtime::state_service::projection_bootstrap_store;
using kungfu::runtime::state_service::projection_error;
using kungfu::runtime::state_service::projection_mutation;
using kungfu::runtime::state_service::projection_options;
using kungfu::runtime::state_service::service;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::ownership::lease;

namespace {

void require(bool condition, const std::string &message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

class temp_tree {
public:
  temp_tree() {
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    root_ = fs::temp_directory_path() / ("kungfu-projection-bootstrap-test-" + std::to_string(nonce));
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

durable_record record(uint64_t sequence, std::string payload) {
  durable_record value;
  value.position = {71, 5, sequence, 1000 + sequence};
  value.carrier_type = 9001;
  value.payload = std::move(payload);
  return value;
}

std::vector<durable_record> records() {
  return {record(1, "alpha=one"), record(2, "alpha=two"), record(3, "beta=three")};
}

std::optional<projection_mutation> key_value_projector(const durable_record &input) {
  const auto separator = input.payload.find('=');
  if (separator == std::string::npos) {
    throw std::invalid_argument("test_payload_missing_separator");
  }
  return projection_mutation{input.payload.substr(0, separator), input.payload.substr(separator + 1), false};
}

projection_options options(const fs::path &root, std::string schema = "test-state-v1",
                           std::string qualification_profile = "test/macos-apfs-projection-bootstrap") {
  return {root.string(), 71, 5, "test-state", std::move(schema), std::move(qualification_profile)};
}

void test_snapshot_through_t_replays_strictly_after_t() {
  temp_tree tree;
  projection_bootstrap_store store(options(tree.root()), key_value_projector);
  const auto all = records();
  const auto snapshot = store.rebuild(all, all[1].position);
  require(snapshot.through_position == all[1].position, "snapshot cut did not stop at T");
  require(snapshot.state.at("alpha") == "two" && !snapshot.state.contains("beta"),
          "snapshot state included a record after T");

  const auto first = store.bootstrap(all, peer_state_requirement::Required);
  require(first.outcome == bootstrap_outcome::Ready, "required bootstrap did not become ready");
  require(first.replayed_records == 1 && first.replay_through == all[2].position,
          "replay did not use the strict after-T boundary");
  require(first.state.at("alpha") == "two" && first.state.at("beta") == "three",
          "snapshot plus replay produced the wrong state");

  const auto repeated = store.bootstrap(all, peer_state_requirement::Required);
  require(repeated.state == first.state && repeated.replayed_records == first.replayed_records,
          "repeated bootstrap was not idempotent");
  require(repeated.status.projection_watermark == all.back().position && repeated.status.lag_records == 0,
          "projection watermark did not reach the durable cut");
}

void test_restart_loads_verified_snapshot_and_replays() {
  temp_tree tree;
  const auto all = records();
  {
    projection_bootstrap_store first(options(tree.root()), key_value_projector);
    (void)first.rebuild(all, all[1].position);
  }
  projection_bootstrap_store reopened(options(tree.root()), key_value_projector);
  const auto result = reopened.bootstrap(all, peer_state_requirement::Required);
  require(result.outcome == bootstrap_outcome::Ready && result.replayed_records == 1,
          "restart did not recover snapshot-through-T plus replay-after-T");
}

void test_missing_snapshot_honors_peer_requirement() {
  temp_tree tree;
  projection_bootstrap_store store(options(tree.root()), key_value_projector);
  const auto all = records();
  const auto required = store.bootstrap(all, peer_state_requirement::Required);
  require(required.outcome == bootstrap_outcome::Refused && required.error == projection_error::SnapshotMissing,
          "required peer did not fail closed on a missing snapshot");
  const auto optional = store.bootstrap(all, peer_state_requirement::Optional);
  require(optional.outcome == bootstrap_outcome::Degraded && optional.state.empty(),
          "optional peer did not report an explicit degraded state");
  const auto none = store.bootstrap(all, peer_state_requirement::None);
  require(none.outcome == bootstrap_outcome::Ready && none.state.empty(),
          "no-state peer unexpectedly depended on a snapshot");
}

void test_corrupt_or_wrong_schema_snapshot_fails_closed() {
  temp_tree tree;
  const auto all = records();
  projection_bootstrap_store store(options(tree.root()), key_value_projector);
  (void)store.rebuild(all, all[1].position);
  {
    std::ofstream output(store.snapshot_path(), std::ios::binary | std::ios::app);
    output << "corrupt";
  }
  const auto corrupt = store.bootstrap(all, peer_state_requirement::Required);
  require(corrupt.outcome == bootstrap_outcome::Refused && corrupt.error == projection_error::SnapshotCorrupt,
          "corrupt snapshot was accepted");

  temp_tree schema_tree;
  projection_bootstrap_store v1(options(schema_tree.root()), key_value_projector);
  (void)v1.rebuild(all, all[1].position);
  projection_bootstrap_store v2(options(schema_tree.root(), "test-state-v2"), key_value_projector);
  const auto mismatch = v2.bootstrap(all, peer_state_requirement::Required);
  require(mismatch.outcome == bootstrap_outcome::Refused && mismatch.error == projection_error::SchemaMismatch,
          "wrong projection schema inherited an older snapshot");

  temp_tree profile_tree;
  projection_bootstrap_store qualified(options(profile_tree.root()), key_value_projector);
  (void)qualified.rebuild(all, all[1].position);
  projection_bootstrap_store other_profile(
      options(profile_tree.root(), "test-state-v1", "test/linux-ext4-projection-bootstrap"), key_value_projector);
  const auto profile_mismatch = other_profile.bootstrap(all, peer_state_requirement::Required);
  require(profile_mismatch.outcome == bootstrap_outcome::Refused &&
              profile_mismatch.error == projection_error::SchemaMismatch,
          "snapshot inherited qualification evidence from another storage profile");
}

void test_deleted_projection_rebuilds_deterministically_from_durable_records() {
  temp_tree tree;
  const auto all = records();
  projection_bootstrap_store store(options(tree.root()), key_value_projector);
  const auto first = store.rebuild(all);
  fs::remove(store.snapshot_path());
  require(store.bootstrap(all, peer_state_requirement::Required).outcome == bootstrap_outcome::Refused,
          "deleted projection remained authoritative");
  const auto rebuilt = store.rebuild(all);
  require(rebuilt.state == first.state && rebuilt.integrity_sha256 == first.integrity_sha256,
          "durable rebuild was not deterministic");
}

void test_gap_never_becomes_a_projection_watermark() {
  temp_tree tree;
  projection_bootstrap_store store(options(tree.root()), key_value_projector);
  auto gapped = records();
  gapped.erase(gapped.begin() + 1);
  bool refused = false;
  try {
    (void)store.rebuild(gapped);
  } catch (const std::invalid_argument &) {
    refused = true;
  }
  require(refused, "gapped durable input produced a snapshot");
  require(!store.status().projection_watermark.has_value(), "failed rebuild advanced projection watermark");
}

void test_failed_rebuild_preserves_previous_readable_snapshot() {
  temp_tree tree;
  const auto all = records();
  projection_bootstrap_store good(options(tree.root()), key_value_projector);
  const auto previous = good.rebuild(all, all[1].position);
  projection_bootstrap_store failing(options(tree.root()), [](const durable_record &input) {
    if (input.position.sequence == 3) {
      throw std::runtime_error("injected_projection_failure");
    }
    return key_value_projector(input);
  });
  bool failed = false;
  try {
    (void)failing.rebuild(all);
  } catch (const std::runtime_error &) {
    failed = true;
  }
  require(failed, "projector failure was hidden");
  const auto retained = good.load_snapshot();
  require(retained.integrity_sha256 == previous.integrity_sha256 && retained.state == previous.state,
          "failed rebuild destroyed the previous readable snapshot");
}

void test_state_service_owns_projection_shadow_and_stopped_service_is_unavailable() {
  temp_tree tree;
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto home = location::make_shared(mode::LIVE, location_role::SYSTEM, "service", "projection", page_locator);
  auto io_device = std::make_shared<kungfu::runtime::io_device_coordinator>(home, false);
  service state_service(io_device);
  state_service.start();

  auto writer = lease::acquire_stream_writer(tree.root().string(), "projection-test-writer");
  ingest_options ingest;
  ingest.data_root = tree.root().string();
  ingest.stream_id = 71;
  ingest.container_epoch = 5;
  ingest.writer_resource_id = "projection-test-writer";
  ingest.qualification_profile = "test/macos-apfs-projection-bootstrap";
  ingest.qualification_passed = true;
  state_service.open_durable_shadow(ingest);
  state_service.append_durable_shadow({71, 5, 1, 1001}, 9001, "alpha=one", writer.status());
  state_service.append_durable_shadow({71, 5, 2, 1002}, 9001, "alpha=two", writer.status());
  const auto first_barrier = state_service.barrier_durable_shadow(71, 5, 1, durability_profile::DurableGroup);
  require(first_barrier.receipt.status == receipt_status::Succeeded, "fixture durable barrier failed");

  state_service.open_projection_shadow(options(tree.root()), key_value_projector);
  const auto snapshot = state_service.rebuild_projection_shadow(71, 5, "test-state", stream_position{71, 5, 1, 1001});
  require(snapshot.state.at("alpha") == "one", "state service rebuilt the wrong cut");
  const auto ready = state_service.bootstrap_projection_shadow(71, 5, "test-state", peer_state_requirement::Required);
  require(ready.outcome == bootstrap_outcome::Ready && ready.state.at("alpha") == "two" && ready.replayed_records == 1,
          "state service did not bootstrap from its durable shadow");

  const auto snapshot_path = tree.root() / ".kungfu" / "durability" / "projections" / "test-state-s71-e5.kfproj";
  {
    std::ofstream output(snapshot_path, std::ios::binary | std::ios::app);
    output << "corrupt";
  }
  const auto refused = state_service.bootstrap_projection_shadow(71, 5, "test-state", peer_state_requirement::Required);
  require(refused.outcome == bootstrap_outcome::Refused, "corrupt projection did not fail closed");
  state_service.append_durable_shadow({71, 5, 3, 1003}, 9001, "beta=three", writer.status());
  const auto second_barrier = state_service.barrier_durable_shadow(71, 5, 2, durability_profile::DurableGroup);
  require(second_barrier.receipt.status == receipt_status::Succeeded,
          "projection failure blocked independent durable ingest progress");

  state_service.stop();
  const auto stopped = state_service.bootstrap_projection_shadow(71, 5, "test-state", peer_state_requirement::Required);
  require(stopped.outcome == bootstrap_outcome::Refused && stopped.error == projection_error::ServiceUnavailable,
          "stopped state service returned projection success");
  const auto stopped_none =
      state_service.bootstrap_projection_shadow(71, 5, "test-state", peer_state_requirement::None);
  require(stopped_none.outcome == bootstrap_outcome::Ready,
          "peer with no state requirement depended on a stopped projection service");
}

int run_tests() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"snapshot through T replays strictly after T", test_snapshot_through_t_replays_strictly_after_t},
      {"restart loads verified snapshot and replays", test_restart_loads_verified_snapshot_and_replays},
      {"missing snapshot honors peer requirement", test_missing_snapshot_honors_peer_requirement},
      {"corrupt and wrong-schema snapshots fail closed", test_corrupt_or_wrong_schema_snapshot_fails_closed},
      {"deleted projection rebuilds deterministically",
       test_deleted_projection_rebuilds_deterministically_from_durable_records},
      {"gapped durable input never advances projection", test_gap_never_becomes_a_projection_watermark},
      {"failed rebuild preserves the previous snapshot", test_failed_rebuild_preserves_previous_readable_snapshot},
      {"state service owns projection shadow and fails closed when stopped",
       test_state_service_owns_projection_shadow_and_stopped_service_is_unavailable},
  };
  int failures = 0;
  for (const auto &[name, test] : tests) {
    try {
      test();
      std::cout << "ok - " << name << '\n';
    } catch (const std::exception &error) {
      ++failures;
      std::cerr << "not ok - " << name << ": " << error.what() << '\n';
    }
  }
  return failures == 0 ? 0 : 1;
}

} // namespace

int main() { return run_tests(); }
