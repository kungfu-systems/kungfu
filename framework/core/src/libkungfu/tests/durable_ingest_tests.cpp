// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/io.h>
#include <kungfu/runtime/state_service.h>
#include <kungfu/yijinjing/time.h>

#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <thread>

namespace fs = std::filesystem;
using namespace kungfu::runtime::durability;
using kungfu::yijinjing::data::location;
using kungfu::yijinjing::data::locator;
using kungfu::yijinjing::enums::location_role;
using kungfu::yijinjing::enums::mode;
using kungfu::yijinjing::journal::bus;
using kungfu::yijinjing::journal::noop_publisher;
using kungfu::yijinjing::journal::writer;
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
    root_ = fs::temp_directory_path() / ("kungfu-durable-ingest-test-" + std::to_string(nonce));
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

ingest_options options(const fs::path &root, bool qualified = true, uint64_t segment_max_bytes = 4096) {
  return {root.string(), 7, 11, "00000001.00000002", "test/macos-apfs-local-file/v1", qualified, segment_max_bytes};
}

stream_position position(uint64_t sequence) { return {7, 11, sequence, 100 + sequence}; }

struct owners {
  explicit owners(const fs::path &root)
      : service(lease::acquire_data_root_service(root.string())),
        writer(lease::acquire_stream_writer(root.string(), "00000001.00000002")) {}
  lease service;
  lease writer;
};

class address_frame : public kungfu::yijinjing::journal::frame {
public:
  explicit address_frame(uintptr_t address) { set_address(address); }
};

void test_group_barrier_survives_verified_restart() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "one", owner.service, owner.writer);
    log.append(position(2), 1002, "two", owner.service, owner.writer);
    const auto result = log.barrier(41, durability_profile::DurableGroup, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Succeeded, "qualified group barrier did not succeed");
    require(result.receipt.durable_watermark == position(2), "receipt did not bind the durable cut");
    require(result.receipt.barrier_id == 1, "first barrier identity was wrong");
    require(result.receipt.qualification_profile == options(tree.root()).qualification_profile,
            "receipt omitted its qualification profile");
  }
  durable_ingest_log reopened(options(tree.root()));
  require(reopened.status().segment_schema == DURABLE_SEGMENT_SCHEMA_V2 &&
              reopened.status().checkpoint_schema == DURABLE_CHECKPOINT_SCHEMA_V2,
          "restart did not report the KFDL v2 segment/checkpoint schemas");
  require(reopened.status().durable_watermark == position(2), "verified restart lost durable watermark");
  require(reopened.status().unacknowledged_tail_bytes == 0, "verified restart invented a tail");
}

void test_unqualified_profile_fails_closed_and_tail_stays_unacknowledged() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root(), false));
    log.append(position(1), 1001, "visible-only", owner.service, owner.writer);
    const auto result = log.barrier(42, durability_profile::DurableSync, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Failed, "unqualified profile returned success");
    require(!result.receipt.durable_watermark.has_value(), "unqualified profile invented durable progress");
    require(result.error == ingest_error::UnsupportedProfile, "unqualified profile lost typed error");
  }
  durable_ingest_log reopened(options(tree.root(), false));
  require(!reopened.status().durable_watermark.has_value(), "unqualified tail became durable after restart");
  require(reopened.status().unacknowledged_tail_bytes > 0, "unqualified bytes were not classified as tail");
}

void test_arbitrary_production_profile_string_cannot_self_qualify() {
  temp_tree tree;
  owners owner(tree.root());
  auto claimed = options(tree.root(), true);
  claimed.qualification_profile = "production/macos-apfs-claimed";
  durable_ingest_log log(claimed);
  log.append(position(1), 1001, "unverified", owner.service, owner.writer);
  const auto result = log.barrier(420, durability_profile::DurableSync, owner.service, owner.writer);
  require(result.receipt.status == receipt_status::Failed && result.error == ingest_error::UnsupportedProfile,
          "arbitrary production profile string enabled durability");
}

void test_data_sync_without_checkpoint_never_acknowledges() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
      if (point == ingest_fault_point::BeforeCheckpointWrite) {
        throw std::runtime_error("injected checkpoint failure");
      }
    });
    log.append(position(1), 1001, "synced-tail", owner.service, owner.writer);
    const auto result = log.barrier(43, durability_profile::DurableSync, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Unknown, "post-sync checkpoint failure was guessed");
    require(!result.receipt.durable_watermark.has_value(), "failed checkpoint emitted a durable watermark");
  }
  durable_ingest_log reopened(options(tree.root()));
  require(!reopened.status().durable_watermark.has_value(), "data sync alone advanced restart watermark");
  require(reopened.status().unacknowledged_tail_bytes > 0, "post-sync bytes were not retained as unknown tail");
}

void test_unknown_after_checkpoint_publish_resolves_on_restart() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
      if (point == ingest_fault_point::AfterCheckpointRename) {
        throw std::runtime_error("injected post-rename crash window");
      }
    });
    log.append(position(1), 1001, "checkpoint-visible", owner.service, owner.writer);
    const auto result = log.barrier(44, durability_profile::DurableSync, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Unknown, "post-publish uncertainty was guessed as success");
  }
  durable_ingest_log reopened(options(tree.root()));
  require(reopened.status().durable_watermark == position(1), "restart did not resolve a valid checkpoint");
  const auto retry = reopened.barrier(44, durability_profile::DurableSync, owner.service, owner.writer);
  require(retry.receipt.status == receipt_status::Succeeded && retry.receipt.barrier_id == 1,
          "retry did not reconcile the published checkpoint by request id");
}

void test_unknown_append_requires_reopen_and_preserves_tail() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
      if (point == ingest_fault_point::AfterRecordWrite) {
        throw std::runtime_error("injected append completion loss");
      }
    });
    bool failed = false;
    try {
      log.append(position(1), 1001, "unknown-append", owner.service, owner.writer);
    } catch (const std::runtime_error &) {
      failed = true;
    }
    require(failed, "post-write fault was not surfaced");
    require(!log.status().available && log.status().requires_reopen &&
                log.status().last_error == ingest_error::AppendOutcomeUnknown,
            "post-write uncertainty did not poison the active append session");
    require(log.status().unacknowledged_tail_bytes > 0, "unknown append bytes were not retained as tail");
    bool refused = false;
    try {
      log.append(position(1), 1001, "unsafe-retry", owner.service, owner.writer);
    } catch (const std::logic_error &) {
      refused = true;
    }
    require(refused, "poisoned append session accepted a retry before reopen");
  }
  {
    durable_ingest_log reopened(options(tree.root()));
    require(reopened.status().active_segment_id == 2 && reopened.status().unacknowledged_tail_bytes > 0,
            "restart did not isolate the unknown append tail");
    reopened.append(position(1), 1001, "known-retry", owner.service, owner.writer);
    const auto result = reopened.barrier(440, durability_profile::DurableSync, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Succeeded && result.receipt.durable_watermark == position(1),
            "reopen could not safely re-admit the unknown position");
  }
  durable_ingest_log verified(options(tree.root()));
  require(verified.status().durable_chain_start_segment_id == 2 && verified.status().active_segment_id == 2 &&
              verified.status().durable_watermark == position(1) && verified.status().unacknowledged_tail_bytes > 0,
          "verified restart mixed the excluded unknown segment into the durable chain");
}

void test_stale_generation_cannot_commit_pending_bytes() {
  temp_tree tree;
  durable_ingest_log log(options(tree.root()));
  {
    owners first(tree.root());
    log.append(position(1), 1001, "old-generation", first.service, first.writer);
  }
  owners replacement(tree.root());
  const auto result = log.barrier(45, durability_profile::DurableSync, replacement.service, replacement.writer);
  require(result.receipt.status == receipt_status::Unknown, "replacement generation committed stale pending bytes");
  require(result.error == ingest_error::FencingLost, "stale generation did not fail on fencing surface");
  require(!result.receipt.durable_watermark.has_value(), "stale generation advanced durable watermark");
}

void test_writer_may_exit_after_admission_without_invalidating_frame() {
  temp_tree tree;
  auto service = lease::acquire_data_root_service(tree.root().string());
  durable_ingest_log log(options(tree.root()));
  {
    auto writer = lease::acquire_stream_writer(tree.root().string(), "00000001.00000002");
    log.append(position(1), 1001, "admitted", service, writer.status());
  }
  const auto result = log.barrier(450, durability_profile::DurableSync, service);
  require(result.receipt.status == receipt_status::Succeeded,
          "writer exit after active-generation admission invalidated an accepted frame");
}

void test_stale_writer_attestation_is_rejected_at_admission() {
  temp_tree tree;
  auto service = lease::acquire_data_root_service(tree.root().string());
  durable_ingest_log log(options(tree.root()));
  kungfu::yijinjing::ownership::evidence stale;
  {
    auto first = lease::acquire_stream_writer(tree.root().string(), "00000001.00000002");
    stale = first.status();
  }
  auto current = lease::acquire_stream_writer(tree.root().string(), "00000001.00000002");
  (void)current;
  bool refused = false;
  try {
    log.append(position(1), 1001, "stale", service, stale);
  } catch (const std::logic_error &) {
    refused = true;
  }
  require(refused, "stale writer generation was admitted while a newer generation owned the stream");
}

void test_position_gap_is_rejected_before_append() {
  temp_tree tree;
  owners owner(tree.root());
  durable_ingest_log log(options(tree.root()));
  log.append(position(1), 1001, "one", owner.service, owner.writer);
  bool refused = false;
  try {
    log.append(position(3), 1003, "gap", owner.service, owner.writer);
  } catch (const std::logic_error &) {
    refused = true;
  }
  require(refused, "position gap was appended");
}

void test_rollover_preserves_order_and_checkpoint() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root(), true, 250));
    log.append(position(1), 1001, std::string(64, 'a'), owner.service, owner.writer);
    require(log.barrier(46, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "pre-rollover barrier failed");
    log.append(position(2), 1002, std::string(64, 'b'), owner.service, owner.writer);
    const auto result = log.barrier(47, durability_profile::DurableGroup, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Succeeded, "post-rollover barrier failed");
    require(result.status.active_segment_id == 2, "segment did not roll over");
  }
  durable_ingest_log reopened(options(tree.root(), true, 250));
  require(reopened.status().durable_watermark == position(2), "rollover restart lost ordering frontier");
}

void test_restart_verifies_prior_sealed_segments_in_durable_chain() {
  temp_tree tree;
  owners owner(tree.root());
  const auto sealed = tree.root() / "durable" / "streams" / "7" / "11" / "sealed-1.kfdl";
  {
    durable_ingest_log log(options(tree.root(), true, 250));
    log.append(position(1), 1001, std::string(64, 'a'), owner.service, owner.writer);
    require(log.barrier(461, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "prior-segment fixture first barrier failed");
    log.append(position(2), 1002, std::string(64, 'b'), owner.service, owner.writer);
    require(log.barrier(462, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "prior-segment fixture second barrier failed");
  }
  require(fs::exists(sealed), "rollover fixture did not seal the prior segment");
  {
    std::fstream file(sealed, std::ios::binary | std::ios::in | std::ios::out);
    file.seekp(-1, std::ios::end);
    file.put('X');
  }
  durable_ingest_log corrupt(options(tree.root(), true, 250));
  require(!corrupt.status().available && corrupt.status().last_error == ingest_error::CheckpointCorrupt &&
              !corrupt.status().durable_watermark.has_value() && corrupt.status().unacknowledged_tail_bytes > 0,
          "restart trusted a corrupt sealed segment below the checkpoint frontier");
  bool refused = false;
  try {
    corrupt.append(position(1), 1001, "unsafe", owner.service, owner.writer);
  } catch (const std::logic_error &) {
    refused = true;
  }
  require(refused, "unprovable checkpoint evidence remained writable");
}

void test_corrupt_newest_checkpoint_falls_back_without_overwriting_tail() {
  temp_tree tree;
  owners owner(tree.root());
  const auto stream_dir = tree.root() / "durable" / "streams" / "7" / "11";
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "one", owner.service, owner.writer);
    require(log.barrier(51, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "first checkpoint failed");
    log.append(position(2), 1002, "two", owner.service, owner.writer);
    require(log.barrier(52, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "second checkpoint failed");
  }
  const auto original_size = fs::file_size(stream_dir / "active-1.kfdl");
  std::ofstream(stream_dir / "checkpoint.0", std::ios::binary | std::ios::trunc) << "corrupt";
  durable_ingest_log reopened(options(tree.root()));
  require(reopened.status().durable_watermark == position(1), "did not fall back to prior valid checkpoint");
  require(reopened.status().last_error == ingest_error::CheckpointCorrupt,
          "checkpoint fallback did not retain a typed diagnostic");
  require(reopened.status().unacknowledged_tail_bytes > 0, "bytes after fallback checkpoint were not classified");
  require(reopened.status().active_segment_id == 2, "fallback restart did not isolate the retained tail");
  require(fs::file_size(stream_dir / "active-1.kfdl") == original_size, "fallback restart overwrote retained tail");
}

void test_newest_checkpoint_with_corrupt_covered_data_falls_back() {
  temp_tree tree;
  owners owner(tree.root());
  const auto segment = tree.root() / "durable" / "streams" / "7" / "11" / "active-1.kfdl";
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "first-valid", owner.service, owner.writer);
    require(log.barrier(521, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "data-fallback first checkpoint failed");
    log.append(position(2), 1002, "second-corrupt", owner.service, owner.writer);
    require(log.barrier(522, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "data-fallback second checkpoint failed");
  }
  {
    std::fstream file(segment, std::ios::binary | std::ios::in | std::ios::out);
    file.seekp(-1, std::ios::end);
    file.put('X');
  }
  durable_ingest_log reopened(options(tree.root()));
  require(reopened.status().durable_watermark == position(1) &&
              reopened.status().last_error == ingest_error::CheckpointCorrupt &&
              reopened.status().unacknowledged_tail_bytes > 0 && reopened.status().active_segment_id == 2,
          "checkpoint/data disagreement did not fall back to the last provable frontier");
}

void test_durable_record_checksum_is_verified_on_restart() {
  temp_tree tree;
  owners owner(tree.root());
  const auto segment = tree.root() / "durable" / "streams" / "7" / "11" / "active-1.kfdl";
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "integrity", owner.service, owner.writer);
    require(log.barrier(53, durability_profile::DurableSync, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "integrity checkpoint failed");
  }
  {
    std::fstream file(segment, std::ios::binary | std::ios::in | std::ios::out);
    file.seekp(-1, std::ios::end);
    file.put('X');
  }
  durable_ingest_log corrupt(options(tree.root()));
  require(!corrupt.status().available && corrupt.status().last_error == ingest_error::CheckpointCorrupt &&
              !corrupt.status().durable_watermark.has_value(),
          "corrupt durable record was accepted as a provable restart frontier");
}

void test_completed_request_is_deduplicated_after_restart() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "dedup", owner.service, owner.writer);
    require(log.barrier(54, durability_profile::DurableSync, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "dedup fixture barrier failed");
  }
  durable_ingest_log reopened(options(tree.root()));
  const auto duplicate = reopened.barrier(54, durability_profile::DurableSync, owner.service, owner.writer);
  require(duplicate.receipt.status == receipt_status::Succeeded && duplicate.receipt.barrier_id == 1,
          "completed request was executed or lost after restart");
  const auto conflict = reopened.barrier(54, durability_profile::DurableGroup, owner.service, owner.writer);
  require(conflict.receipt.status == receipt_status::Failed &&
              conflict.receipt.error == durability_error_code::ConflictingRequestId,
          "conflicting request-id reuse was not rejected");
}

void test_all_completed_requests_are_deduplicated_after_restart() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()));
    log.append(position(1), 1001, "first", owner.service, owner.writer);
    require(log.barrier(541, durability_profile::DurableGroup, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "first historical dedup barrier failed");
    log.append(position(2), 1002, "second", owner.service, owner.writer);
    require(log.barrier(542, durability_profile::DurableSync, owner.service, owner.writer).receipt.status ==
                receipt_status::Succeeded,
            "second historical dedup barrier failed");
  }
  durable_ingest_log reopened(options(tree.root()));
  require(reopened.status().persisted_request_count == 2, "checkpoint lost historical request index entries");
  const auto first = reopened.barrier(541, durability_profile::DurableGroup, owner.service, owner.writer);
  require(first.receipt.status == receipt_status::Succeeded && first.receipt.position == position(1) &&
              first.receipt.barrier_id == 1,
          "restart lost an older completed request");
  const auto conflict = reopened.barrier(541, durability_profile::DurableSync, owner.service, owner.writer);
  require(conflict.receipt.status == receipt_status::Failed &&
              conflict.receipt.error == durability_error_code::ConflictingRequestId,
          "restart accepted conflicting reuse of an older request id");
}

void test_concurrent_same_request_barriers_share_one_completion() {
  temp_tree tree;
  owners owner(tree.root());
  durable_ingest_log log(options(tree.root()));
  log.append(position(1), 1001, "concurrent-retry", owner.service, owner.writer);
  std::array<barrier_result, 4> results;
  std::array<std::thread, 4> workers;
  for (size_t index = 0; index < workers.size(); ++index) {
    workers[index] = std::thread([&, index] {
      results[index] = log.barrier(549, durability_profile::DurableGroup, owner.service, owner.writer);
    });
  }
  for (auto &worker : workers) {
    worker.join();
  }
  for (const auto &result : results) {
    require(result.receipt.status == receipt_status::Succeeded && result.receipt.barrier_id == 1 &&
                result.receipt.durable_watermark == position(1),
            "concurrent same-request retry did not return the single completed barrier");
  }
  require(log.status().last_barrier_id == 1 && log.status().persisted_request_count == 1,
          "concurrent same-request retry executed more than one barrier");
}

void test_deadline_before_barrier_io_fails_and_retry_can_succeed() {
  temp_tree tree;
  owners owner(tree.root());
  durable_ingest_log log(options(tree.root()));
  log.append(position(1), 1001, "deadline", owner.service, owner.writer);
  const auto timed_out =
      log.barrier(543, durability_profile::DurableSync, owner.service, owner.writer, {.deadline_at_ns = 1});
  require(timed_out.receipt.status == receipt_status::Failed && timed_out.error == ingest_error::Timeout &&
              timed_out.receipt.error == durability_error_code::Timeout,
          "expired pre-I/O deadline was not a typed known failure");
  const auto retry = log.barrier(543, durability_profile::DurableSync, owner.service, owner.writer);
  require(retry.receipt.status == receipt_status::Succeeded,
          "known pre-I/O timeout consumed the request id or pending batch");
}

void test_deadline_after_data_sync_is_unknown_without_false_ack() {
  temp_tree tree;
  owners owner(tree.root());
  durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
    if (point == ingest_fault_point::AfterDataSync) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  });
  log.append(position(1), 1001, "deadline-after-sync", owner.service, owner.writer);
  const auto deadline = kungfu::yijinjing::time::now_in_nano() + 1'000'000;
  const auto result =
      log.barrier(544, durability_profile::DurableSync, owner.service, owner.writer, {.deadline_at_ns = deadline});
  require(result.receipt.status == receipt_status::Unknown && result.error == ingest_error::Timeout &&
              result.receipt.error == durability_error_code::Timeout,
          "post-sync deadline was guessed instead of reported unknown");
  require(!result.status.durable_watermark.has_value(), "post-sync timeout emitted a false durable watermark");
}

void test_injected_sync_io_error_has_no_false_ack() {
  temp_tree tree;
  owners owner(tree.root());
  durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
    if (point == ingest_fault_point::BeforeDataSync) {
      throw std::system_error(std::make_error_code(std::errc::no_space_on_device));
    }
  });
  log.append(position(1), 1001, "enospc", owner.service, owner.writer);
  const auto result = log.barrier(55, durability_profile::DurableSync, owner.service, owner.writer);
  require(result.receipt.status == receipt_status::Unknown && result.error == ingest_error::IoError,
          "injected sync I/O failure was not surfaced as unknown");
  require(!result.receipt.durable_watermark.has_value() && !result.status.durable_watermark.has_value(),
          "injected sync I/O failure advanced durable progress");
}

void test_injected_record_write_error_has_no_false_ack_and_can_retry() {
  temp_tree tree;
  owners owner(tree.root());
  bool fail_once = true;
  durable_ingest_log log(options(tree.root()), [&](ingest_fault_point point) {
    if (point == ingest_fault_point::BeforeRecordWrite && fail_once) {
      fail_once = false;
      throw std::system_error(std::make_error_code(std::errc::no_space_on_device));
    }
  });
  bool failed = false;
  std::string failure_message;
  try {
    log.append(position(1), 1001, "write-enospc", owner.service, owner.writer);
  } catch (const std::system_error &error) {
    failed = true;
    failure_message = error.what();
  }
  const auto failed_status = log.status();
  require(failed && failed_status.last_error == ingest_error::IoError && failed_status.available &&
              !failed_status.requires_reopen,
          "pre-write I/O failure was not retryable: error=" + std::string(ingest_error_name(failed_status.last_error)) +
              " available=" + (failed_status.available ? "true" : "false") + " requires_reopen=" +
              (failed_status.requires_reopen ? "true" : "false") + " exception=" + failure_message);
  require(log.status().pending_records == 0 && !log.status().durable_watermark.has_value(),
          "pre-write I/O failure advanced pending or durable progress");
  log.append(position(1), 1001, "write-retry", owner.service, owner.writer);
  const auto retry = log.barrier(546, durability_profile::DurableSync, owner.service, owner.writer);
  require(retry.receipt.status == receipt_status::Succeeded, "retry after known write failure did not succeed");
}

void test_checkpoint_rename_error_has_no_false_ack() {
  temp_tree tree;
  owners owner(tree.root());
  {
    durable_ingest_log log(options(tree.root()), [](ingest_fault_point point) {
      if (point == ingest_fault_point::BeforeCheckpointRename) {
        throw std::system_error(std::make_error_code(std::errc::io_error));
      }
    });
    log.append(position(1), 1001, "rename-failure", owner.service, owner.writer);
    const auto result = log.barrier(547, durability_profile::DurableSync, owner.service, owner.writer);
    require(result.receipt.status == receipt_status::Unknown && result.error == ingest_error::IoError &&
                !result.status.durable_watermark.has_value(),
            "checkpoint rename error emitted a false acknowledgement");
  }
  durable_ingest_log reopened(options(tree.root()));
  require(!reopened.status().durable_watermark.has_value() && reopened.status().unacknowledged_tail_bytes > 0,
          "failed checkpoint rename advanced restart frontier or lost tail evidence");
}

void test_published_hot_frame_matches_inspected_durable_record_after_restart() {
  temp_tree tree;
  auto service = lease::acquire_data_root_service(tree.root().string());
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto hot_location =
      location::make_shared(mode::LIVE, location_role::SYSTEM, "durable_test", "hot_writer", page_locator);
  auto publisher = std::make_shared<noop_publisher>();
  auto page_bus = std::make_shared<bus>(false);
  writer hot_writer(hot_location, 2, publisher, false, page_bus, 1024 * 1024, 0);
  const std::string input = "published-hot-frame";
  uintptr_t published_address = 0;
  {
    auto transaction = hot_writer.reserve_frame(1, 1001, input.size(), 7);
    std::memcpy(transaction.data(), input.data(), input.size());
    published_address = transaction.frame()->address();
    transaction.commit(input.size(), 1234);
  }
  address_frame published(published_address);
  require(published.has_data() && published.stream_id() == 7, "hot-path fixture did not publish a complete frame");
  const stream_position hot_position{published.stream_id(), 11, 1, published.frame_uid()};
  const auto hot_payload = published.data_as_string();
  const durable_frame_context hot_context{published.gen_time(),
                                          published.trigger_time(),
                                          published.source(),
                                          published.dest(),
                                          static_cast<int32_t>(published.data_type()),
                                          published.initial_source(),
                                          published.trigger_frame_uid()};
  auto shadow_options = options(tree.root());
  shadow_options.writer_resource_id = hot_writer.ownership_status().resource_id;
  {
    durable_ingest_log log(shadow_options);
    log.append(hot_position, published.carrier_type(), hot_context, published.data_address(), published.data_length(),
               service, hot_writer.ownership_status());
    require(log.barrier(548, durability_profile::DurableGroup, service).receipt.status == receipt_status::Succeeded,
            "published hot frame did not cross the shadow barrier");
  }
  durable_ingest_log reopened(shadow_options);
  const auto records = reopened.read_durable_records();
  require(records.size() == 1 && records.front().position == hot_position &&
              records.front().carrier_type == published.carrier_type() && records.front().frame == hot_context &&
              records.front().payload == hot_payload,
          "restart inspection did not match the published hot frame context/position/carrier/payload");
}

void test_state_service_owns_shadow_ingest_lifecycle() {
  temp_tree tree;
  auto page_locator = std::make_shared<locator>(tree.root().string());
  auto home = location::make_shared(mode::LIVE, location_role::SYSTEM, "service", "coordinator", page_locator);
  auto io_device = std::make_shared<kungfu::runtime::io_device_coordinator>(home, false);
  kungfu::runtime::state_service::service state_service(io_device);
  state_service.start();
  auto writer = lease::acquire_stream_writer(tree.root().string(), "00000001.00000002");
  state_service.open_durable_shadow(options(tree.root()));
  state_service.append_durable_shadow(position(1), 1001, "through-service", writer.status());
  const auto result = state_service.barrier_durable_shadow(7, 11, 56, durability_profile::DurableGroup);
  require(result.receipt.status == receipt_status::Succeeded,
          "state service did not own shadow ingest/barrier lifecycle");
  require(state_service.durable_shadow_status(7, 11).durable_watermark == position(1),
          "state service shadow status lost durable cut");
  state_service.stop();
  const auto unavailable = state_service.barrier_durable_shadow(7, 11, 545, durability_profile::DurableSync);
  require(unavailable.receipt.status == receipt_status::Unknown &&
              unavailable.receipt.error == durability_error_code::ServiceUnavailable &&
              unavailable.error == ingest_error::ServiceUnavailable,
          "stopped state service did not return typed service-unavailable");
}

} // namespace

int main(int argc, char **argv) {
  if (argc > 1) {
    if (argc < 3) {
      return 64;
    }
    const fs::path root = argv[2];
    try {
      if (std::string(argv[1]) == "--hold-writer") {
        if (argc < 5) {
          return 64;
        }
        auto writer = lease::acquire_stream_writer(root.string(), "00000001.00000002");
        std::ofstream(argv[3]) << writer.status().generation << '\n' << writer.status().fence_token << '\n';
        while (!fs::exists(argv[4])) {
          std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        return 0;
      }
      if (std::string(argv[1]) == "--inspect-writer") {
        const auto active =
            kungfu::yijinjing::ownership::inspect_active_stream_writer(root.string(), "00000001.00000002");
        require(active.owned && active.generation > 0 && !active.fence_token.empty(),
                "cross-process writer attestation was incomplete");
        return 0;
      }
    } catch (const std::exception &error) {
      std::cerr << error.what() << '\n';
      return 1;
    }
    return 64;
  }
  const std::pair<const char *, void (*)()> tests[] = {
      {"group barrier survives verified restart", test_group_barrier_survives_verified_restart},
      {"unqualified profile fails closed and retains tail",
       test_unqualified_profile_fails_closed_and_tail_stays_unacknowledged},
      {"arbitrary production profile cannot self qualify",
       test_arbitrary_production_profile_string_cannot_self_qualify},
      {"data sync without checkpoint never acknowledges", test_data_sync_without_checkpoint_never_acknowledges},
      {"unknown after checkpoint publish resolves on restart",
       test_unknown_after_checkpoint_publish_resolves_on_restart},
      {"unknown append requires reopen and preserves tail", test_unknown_append_requires_reopen_and_preserves_tail},
      {"stale generation cannot commit pending bytes", test_stale_generation_cannot_commit_pending_bytes},
      {"writer may exit after active admission", test_writer_may_exit_after_admission_without_invalidating_frame},
      {"stale writer attestation is rejected at admission", test_stale_writer_attestation_is_rejected_at_admission},
      {"position gap is rejected before append", test_position_gap_is_rejected_before_append},
      {"rollover preserves order and checkpoint", test_rollover_preserves_order_and_checkpoint},
      {"restart verifies prior sealed segments in durable chain",
       test_restart_verifies_prior_sealed_segments_in_durable_chain},
      {"corrupt newest checkpoint falls back without overwriting tail",
       test_corrupt_newest_checkpoint_falls_back_without_overwriting_tail},
      {"newest checkpoint with corrupt covered data falls back",
       test_newest_checkpoint_with_corrupt_covered_data_falls_back},
      {"durable record checksum is verified on restart", test_durable_record_checksum_is_verified_on_restart},
      {"completed request is deduplicated after restart", test_completed_request_is_deduplicated_after_restart},
      {"all completed requests are deduplicated after restart",
       test_all_completed_requests_are_deduplicated_after_restart},
      {"concurrent same-request barriers share one completion",
       test_concurrent_same_request_barriers_share_one_completion},
      {"deadline before barrier I/O fails and retry succeeds",
       test_deadline_before_barrier_io_fails_and_retry_can_succeed},
      {"deadline after data sync is unknown without false acknowledgement",
       test_deadline_after_data_sync_is_unknown_without_false_ack},
      {"injected sync I/O error has no false acknowledgement", test_injected_sync_io_error_has_no_false_ack},
      {"injected record write error has no false acknowledgement and can retry",
       test_injected_record_write_error_has_no_false_ack_and_can_retry},
      {"checkpoint rename error has no false acknowledgement", test_checkpoint_rename_error_has_no_false_ack},
      {"published hot frame matches inspected durable record after restart",
       test_published_hot_frame_matches_inspected_durable_record_after_restart},
      {"state service owns shadow ingest lifecycle", test_state_service_owns_shadow_ingest_lifecycle},
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
