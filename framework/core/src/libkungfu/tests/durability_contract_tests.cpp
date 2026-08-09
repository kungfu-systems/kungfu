// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/durability.h>

#include <iostream>
#include <stdexcept>
#include <string>

using namespace kungfu::runtime::durability;

namespace {

void require(bool condition, const std::string &message) {
  if (not condition) {
    throw std::runtime_error(message);
  }
}

stream_position position(uint64_t sequence, uint64_t frame_uid = 100, uint64_t stream_id = 7, uint64_t epoch = 11) {
  return {stream_id, epoch, sequence, frame_uid};
}

void test_position_order_is_epoch_scoped() {
  require(compare_positions(position(1), position(2)) == position_order::Before, "sequence order was not preserved");
  require(compare_positions(position(2), position(1)) == position_order::After, "reverse sequence order was wrong");
  require(compare_positions(position(2), position(2)) == position_order::Equal, "identical positions differed");
  require(compare_positions(position(2), position(2, 101)) == position_order::Unordered,
          "conflicting identities at one sequence were ordered");
  require(compare_positions(position(2), position(2, 100, 8)) == position_order::Unordered,
          "positions from different streams were globally ordered");
  require(compare_positions(position(2), position(2, 100, 7, 12)) == position_order::Unordered,
          "positions from different epochs were ordered");
}

void test_visible_receipt_never_overstates_frontier() {
  durability_request visible{41, position(3, 103), durability_profile::Visible};
  const auto success = make_visible_receipt(visible, 900);
  require(success.status == receipt_status::Succeeded, "visible request did not succeed");
  require(success.achieved_profile == durability_profile::Visible, "visible receipt did not name achieved profile");
  require(success.visible_watermark == visible.position, "visible receipt omitted its watermark");
  require(not success.durable_watermark.has_value(), "visible receipt invented a durable watermark");
  require(success.barrier_id == 0, "visible receipt invented a durability barrier");

  durability_request strong{42, position(4, 104), durability_profile::DurableSync};
  const auto rejected = make_visible_receipt(strong, 901);
  require(rejected.status == receipt_status::Failed, "strong request was silently downgraded to success");
  require(rejected.error == durability_error_code::UnsupportedProfile, "strong request lost its typed error");
  require(rejected.achieved_profile == durability_profile::Visible, "achieved visible frontier was not reported");
  require(not rejected.durable_watermark.has_value(), "rejected request invented durable progress");

  const auto rendered = render_durability_receipt(rejected);
  require(rendered.at("schema") == DURABILITY_RECEIPT_SCHEMA_V1, "JSON edge lost schema identity");
  require(rendered.at("request_id") == "42", "JSON edge did not preserve uint64 request identity");
  require(rendered.at("position").at("sequence") == "4", "JSON edge did not preserve position sequence");
  require(rendered.at("durable_watermark").is_null(), "JSON edge projected false durable progress");
}

void test_request_dedup_and_unknown_are_explicit() {
  visible_receipt_registry registry;
  durability_request request{51, position(5, 105), durability_profile::Visible};
  const auto first = registry.complete(request, 1000);
  const auto duplicate = registry.complete(request, 2000);
  require(duplicate.completed_at == first.completed_at, "deduplicated request was executed twice");

  auto conflicting = request;
  conflicting.position = position(6, 106);
  const auto conflict = registry.complete(conflicting, 2001);
  require(conflict.status == receipt_status::Failed && conflict.error == durability_error_code::ConflictingRequestId,
          "conflicting request id was not rejected");

  const auto unknown = make_unknown_receipt({52, position(7, 107), durability_profile::DurableGroup},
                                            durability_error_code::Timeout, 2002);
  require(unknown.status == receipt_status::Unknown && unknown.error == durability_error_code::Timeout,
          "timeout was guessed as success or failure");
  require(not unknown.achieved_profile.has_value(), "unknown result invented an achieved profile");
}

void test_watermarks_are_monotonic_and_dependency_bounded() {
  watermark_tracker tracker;
  require(tracker.advance(watermark_kind::Durable, position(1)).error == durability_error_code::FrontierNotEstablished,
          "durable watermark advanced before visibility");
  require(tracker.advance(watermark_kind::Visible, position(3)).advanced, "visible watermark did not initialize");
  require(tracker.advance(watermark_kind::Durable, position(2)).advanced, "durable watermark did not advance");
  require(tracker.advance(watermark_kind::Projection, position(2)).advanced,
          "projection watermark did not advance to durable cut");
  require(tracker.advance(watermark_kind::Replicated, position(1)).advanced,
          "replicated watermark did not advance below durable cut");
  require(tracker.advance(watermark_kind::Durable, position(4)).error ==
              durability_error_code::FrontierAheadOfDependency,
          "durable watermark advanced beyond visibility");
  require(tracker.advance(watermark_kind::Projection, position(3)).error ==
              durability_error_code::FrontierAheadOfDependency,
          "projection watermark advanced beyond durable cut");
  require(tracker.advance(watermark_kind::Visible, position(2)).error == durability_error_code::WatermarkRegression,
          "visible watermark regressed");
  require(tracker.advance(watermark_kind::Visible, position(4, 104, 7, 12)).error ==
              durability_error_code::PositionEpochMismatch,
          "visible watermark crossed epochs without a new tracker");
}

void test_capability_report_is_evidence_bound_and_fail_closed() {
  const auto &report = single_host_institutional_capability();
  require(report.schema == DURABILITY_CAPABILITY_SCHEMA_V1, "capability schema drifted");
  require(report.authority == "libkungfu", "capability authority moved outside C++");
  require(report.support_level == "production-candidate" && not report.production_eligible,
          "candidate evidence was promoted into production eligibility");
  require(report.profiles.size() == 4, "profile catalog is incomplete");
  require(report.profiles[0].name == "visible" && report.profiles[0].availability == "runtime",
          "visible compatibility profile disappeared");
  require(report.profiles[1].name == "durable_group" && not report.profiles[1].production_eligible,
          "durable_group was over-advertised");
  require(report.profiles[2].name == "durable_sync" && not report.profiles[2].production_eligible,
          "durable_sync was over-advertised");
  require(report.profiles[3].name == "replicated" && report.profiles[3].availability == "unavailable",
          "future replication was advertised");
  require(report.evidence.size() == 7 && report.evidence[4].id == "same-office-offhost-restore" &&
              report.restore.verified && report.restore.off_host && not report.restore.independent_failure_domain,
          "restore evidence lost its exact failure-domain boundary");
  require(report.admission.current_hardware_candidate_complete &&
              not report.admission.candidate_profile_default_enabled && report.admission.clean_host_restart_qualified &&
              report.admission.off_host_restore_qualified && not report.admission.physical_power_loss_qualified &&
              not report.admission.independent_failure_domain_qualified && not report.admission.production_eligible &&
              not report.admission.replication_supported,
          "candidate admission widened or lost its claim boundary");

  const auto rendered = render_durability_capability(report);
  require(rendered.at("schema") == DURABILITY_CAPABILITY_SCHEMA_V1, "capability JSON lost schema identity");
  require(rendered.at("authority") == "libkungfu", "capability JSON lost C++ authority");
  require(not rendered.at("production_eligible").get<bool>(), "capability JSON overclaimed production support");
  require(rendered.at("admission").at("current_hardware_candidate_complete").get<bool>() &&
              not rendered.at("admission").at("candidate_profile_default_enabled").get<bool>() &&
              not rendered.at("admission").at("physical_power_loss_qualified").get<bool>(),
          "capability JSON lost the candidate admission boundary");
  require(rendered.at("profiles").at(2).at("refusal_reason").is_string(),
          "strong profile rejection stopped being machine-readable");
  require(rendered.at("non_claims").size() >= 10, "capability JSON omitted load-bearing non-claims");
}

} // namespace

int main() {
  const std::pair<const char *, void (*)()> tests[] = {
      {"position order is stream/epoch scoped", test_position_order_is_epoch_scoped},
      {"visible receipts never overstate frontier", test_visible_receipt_never_overstates_frontier},
      {"request dedup and unknown outcomes are explicit", test_request_dedup_and_unknown_are_explicit},
      {"watermarks are monotonic and dependency bounded", test_watermarks_are_monotonic_and_dependency_bounded},
      {"capability report is evidence-bound and fail-closed", test_capability_report_is_evidence_bound_and_fail_closed},
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
