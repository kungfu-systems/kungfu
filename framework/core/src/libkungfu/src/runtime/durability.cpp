// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/durability.h>

#include <stdexcept>

namespace kungfu::runtime::durability {
namespace {

nlohmann::json position_json(const stream_position &position) {
  return {{"stream_id", std::to_string(position.stream_id)},
          {"container_epoch", std::to_string(position.container_epoch)},
          {"sequence", std::to_string(position.sequence)},
          {"frame_uid", std::to_string(position.frame_uid)}};
}

nlohmann::json position_json(const std::optional<stream_position> &position) {
  if (not position.has_value()) {
    return nullptr;
  }
  return position_json(*position);
}

durability_receipt failure_receipt(const durability_request &request, durability_error_code error,
                                   receipt_status status, int64_t completed_at) {
  durability_receipt receipt{};
  receipt.request_id = request.request_id;
  receipt.position = request.position;
  receipt.requested_profile = request.requested_profile;
  receipt.completed_at = completed_at;
  receipt.status = status;
  receipt.error = error;
  return receipt;
}

} // namespace

const char *durability_profile_name(durability_profile profile) noexcept {
  switch (profile) {
  case durability_profile::Visible:
    return "visible";
  case durability_profile::DurableGroup:
    return "durable_group";
  case durability_profile::DurableSync:
    return "durable_sync";
  case durability_profile::Replicated:
    return "replicated";
  }
  return "unknown";
}

const char *receipt_status_name(receipt_status status) noexcept {
  switch (status) {
  case receipt_status::Succeeded:
    return "succeeded";
  case receipt_status::Failed:
    return "failed";
  case receipt_status::Unknown:
    return "unknown";
  }
  return "unknown";
}

const char *durability_error_name(durability_error_code error) noexcept {
  switch (error) {
  case durability_error_code::None:
    return "none";
  case durability_error_code::InvalidRequest:
    return "invalid_request";
  case durability_error_code::UnsupportedProfile:
    return "unsupported_profile";
  case durability_error_code::Timeout:
    return "timeout";
  case durability_error_code::OutcomeUnknown:
    return "outcome_unknown";
  case durability_error_code::ServiceUnavailable:
    return "service_unavailable";
  case durability_error_code::ConflictingRequestId:
    return "conflicting_request_id";
  case durability_error_code::PositionEpochMismatch:
    return "position_epoch_mismatch";
  case durability_error_code::WatermarkRegression:
    return "watermark_regression";
  case durability_error_code::FrontierNotEstablished:
    return "frontier_not_established";
  case durability_error_code::FrontierAheadOfDependency:
    return "frontier_ahead_of_dependency";
  }
  return "unknown";
}

durability_profile parse_durability_profile(const std::string &name) {
  if (name == "visible")
    return durability_profile::Visible;
  if (name == "durable_group")
    return durability_profile::DurableGroup;
  if (name == "durable_sync")
    return durability_profile::DurableSync;
  if (name == "replicated")
    return durability_profile::Replicated;
  throw std::invalid_argument("unknown durability profile: " + name);
}

position_order compare_positions(const stream_position &left, const stream_position &right) noexcept {
  if (left.stream_id != right.stream_id || left.container_epoch != right.container_epoch) {
    return position_order::Unordered;
  }
  if (left.sequence < right.sequence)
    return position_order::Before;
  if (left.sequence > right.sequence)
    return position_order::After;
  return left.frame_uid == right.frame_uid ? position_order::Equal : position_order::Unordered;
}

durability_receipt make_visible_receipt(const durability_request &request, int64_t completed_at) {
  if (request.request_id == 0) {
    return failure_receipt(request, durability_error_code::InvalidRequest, receipt_status::Failed, completed_at);
  }

  auto receipt = failure_receipt(request, durability_error_code::None, receipt_status::Succeeded, completed_at);
  receipt.achieved_profile = durability_profile::Visible;
  receipt.visible_watermark = request.position;
  if (request.requested_profile != durability_profile::Visible) {
    receipt.status = receipt_status::Failed;
    receipt.error = durability_error_code::UnsupportedProfile;
  }
  return receipt;
}

durability_receipt make_unknown_receipt(const durability_request &request, durability_error_code error,
                                        int64_t completed_at) {
  return failure_receipt(request, error, receipt_status::Unknown, completed_at);
}

durability_receipt_view make_receipt_view(const durability_receipt &receipt) {
  return {DURABILITY_RECEIPT_SCHEMA_V1,
          receipt.request_id,
          receipt.position,
          durability_profile_name(receipt.requested_profile),
          receipt.achieved_profile.has_value()
              ? std::optional<std::string>{durability_profile_name(*receipt.achieved_profile)}
              : std::nullopt,
          receipt.visible_watermark,
          receipt.durable_watermark,
          receipt.projection_watermark,
          receipt.replicated_watermark,
          receipt.barrier_id,
          receipt.qualification_profile,
          receipt.completed_at,
          receipt_status_name(receipt.status),
          durability_error_name(receipt.error)};
}

nlohmann::json render_durability_receipt(const durability_receipt &receipt) {
  const auto view = make_receipt_view(receipt);
  return {{"schema", view.schema},
          {"request_id", std::to_string(view.request_id)},
          {"position", position_json(view.position)},
          {"requested_profile", view.requested_profile},
          {"achieved_profile", view.achieved_profile.has_value() ? nlohmann::json(*view.achieved_profile) : nullptr},
          {"visible_watermark", position_json(view.visible_watermark)},
          {"durable_watermark", position_json(view.durable_watermark)},
          {"projection_watermark", position_json(view.projection_watermark)},
          {"replicated_watermark", position_json(view.replicated_watermark)},
          {"barrier_id", std::to_string(view.barrier_id)},
          {"qualification_profile", view.qualification_profile},
          {"completed_at", std::to_string(view.completed_at)},
          {"status", view.status},
          {"error", view.error}};
}

const durability_capability_report &single_host_institutional_capability() {
  static const durability_capability_report report{
      DURABILITY_CAPABILITY_SCHEMA_V1,
      "libkungfu",
      "single-host-institutional-production-candidate-v1",
      "production-candidate",
      false,
      "agent120-linux-x64-ext4-nvme-plus-same-office-ubuntu222-v1",
      "candidate/current-hardware-single-host/v1",
      {{"visible", "runtime", "compatibility", true, "process visibility only; no power-loss guarantee", ""},
       {"durable_group", "candidate-explicit", "current-hardware-candidate-qualified", false,
        "batch durable watermark inside the named current-hardware candidate envelope",
        "candidate activation is default-off and physical power loss is unqualified"},
       {"durable_sync", "candidate-explicit", "current-hardware-candidate-qualified", false,
        "data and metadata barrier inside the named current-hardware candidate envelope",
        "candidate activation is default-off and physical power loss is unqualified"},
       {"replicated", "unavailable", "unqualified", false, "none",
        "replication and high availability are outside the v1 local profile"}},
      {{"live-durable-receipts", "framework/core/src/libkungfu/tests/durable_ingest_tests.cpp",
        "d15f34686222511515815eff5d46e29740a4d5b0606cd562aa9da9f73814a4c7"},
       {"projection-authority-candidate", "framework/core/src/libkungfu/tests/projection_bootstrap_tests.cpp",
        "0d2480afd1eedb7f8376821ba40f1bd650bbe45ee39d0f192c74f454ab02613c"},
       {"agent120-fault-campaign", "docs/qualification/evidence/durability/791e09a70/evidence/fault-campaign-v2.json",
        "0ae769d3befabf3b382f5f116d638d68addafaedb6c263d7171369ff5bda0256"},
       {"agent120-durability-slo", "docs/qualification/evidence/durability/070e0804b/agent120-durability-slo-v1.json",
        "bd5497228f51eaea6c38e3e82bb07a7bfb549d6969da03b4bfb0d421511a232e"},
       {"same-office-offhost-restore", "docs/qualification/evidence/durability/987201493/aggregate-report.json",
        "4034b2653c1acd5f1b1608d7e68c3328f91fa501c04f180252c4f22e232bc574"},
       {"agent120-clean-host-restart", "docs/qualification/evidence/durability/17e807700/aggregate-report.json",
        "7d377977a3bae516624cd1f9d6656e7f2c54b37eb9cef59b77ee68e979c4acb6"},
       {"production-candidate-admission",
        "docs/qualification/evidence/durability/production-candidate-v1/admission-report.json",
        "24bd0a5ff5f40167982227e7a37af23121988a1a9e97f7a38cba3695d91d90f9"}},
      {true, "same-office-agent120-to-ubuntu222", "through-checkpoint-covered-durable-frontier", 0, true, false},
      {"kungfu.durability-production-candidate-report/v1", "passed-current-hardware-production-candidate", true, false,
       true, true, false, false, false, false, false, false,
       "docs/qualification/evidence/durability/production-candidate-v1/admission-report.json",
       "24bd0a5ff5f40167982227e7a37af23121988a1a9e97f7a38cba3695d91d90f9",
       "fail-closed-on-source-artifact-or-environment-drift", "retained-until-production-qualified"},
      {"trusted host and administrator", "one authoritative data root per workspace instance",
       "one active fenced state and durability service owner per data root", "one active writer per stream"},
      {"unclean host restart", "physical power loss", "macOS device power cut", "Windows device power cut",
       "independent backup failure domain", "whole-device loss", "production profile eligibility",
       "absolute performance SLO", "replication or high availability", "distributed consensus",
       "network-partition or cross-machine ordering", "malicious-administrator resistance"}};
  return report;
}

nlohmann::json render_durability_capability(const durability_capability_report &report) {
  auto profiles = nlohmann::json::array();
  for (const auto &profile : report.profiles) {
    profiles.push_back({{"name", profile.name},
                        {"availability", profile.availability},
                        {"qualification", profile.qualification},
                        {"production_eligible", profile.production_eligible},
                        {"guarantee", profile.guarantee},
                        {"refusal_reason", profile.refusal_reason.empty() ? nlohmann::json(nullptr)
                                                                          : nlohmann::json(profile.refusal_reason)}});
  }
  auto evidence = nlohmann::json::array();
  for (const auto &reference : report.evidence) {
    evidence.push_back({{"id", reference.id}, {"path", reference.path}, {"sha256", reference.sha256}});
  }
  return {{"schema", report.schema},
          {"authority", report.authority},
          {"profile", report.profile},
          {"support_level", report.support_level},
          {"production_eligible", report.production_eligible},
          {"qualified_envelope", report.qualified_envelope},
          {"qualification_profile", report.qualification_profile},
          {"profiles", profiles},
          {"evidence", evidence},
          {"restore",
           {{"verified", report.restore.verified},
            {"scope", report.restore.scope},
            {"backup_cut", report.restore.backup_cut},
            {"maximum_observed_rpo_records", report.restore.maximum_observed_rpo_records},
            {"off_host", report.restore.off_host},
            {"independent_failure_domain", report.restore.independent_failure_domain}}},
          {"admission",
           {{"schema", report.admission.schema},
            {"verdict", report.admission.verdict},
            {"current_hardware_candidate_complete", report.admission.current_hardware_candidate_complete},
            {"candidate_profile_default_enabled", report.admission.candidate_profile_default_enabled},
            {"clean_host_restart_qualified", report.admission.clean_host_restart_qualified},
            {"off_host_restore_qualified", report.admission.off_host_restore_qualified},
            {"physical_power_loss_qualified", report.admission.physical_power_loss_qualified},
            {"independent_failure_domain_qualified", report.admission.independent_failure_domain_qualified},
            {"production_eligible", report.admission.production_eligible},
            {"high_availability_supported", report.admission.high_availability_supported},
            {"replication_supported", report.admission.replication_supported},
            {"consensus_supported", report.admission.consensus_supported},
            {"evidence_path", report.admission.evidence_path},
            {"evidence_sha256", report.admission.evidence_sha256},
            {"freshness_policy", report.admission.freshness_policy},
            {"compatibility_bridge", report.admission.compatibility_bridge}}},
          {"trust_assumptions", report.trust_assumptions},
          {"non_claims", report.non_claims}};
}

durability_receipt visible_receipt_registry::complete(const durability_request &request, int64_t completed_at) {
  const auto found = entries_.find(request.request_id);
  if (found != entries_.end()) {
    if (found->second.request.position == request.position &&
        found->second.request.requested_profile == request.requested_profile) {
      return found->second.receipt;
    }
    return failure_receipt(request, durability_error_code::ConflictingRequestId, receipt_status::Failed, completed_at);
  }
  auto receipt = make_visible_receipt(request, completed_at);
  if (request.request_id != 0) {
    entries_.emplace(request.request_id, entry{request, receipt});
  }
  return receipt;
}

watermark_update_result watermark_tracker::advance_monotonic(std::optional<stream_position> &frontier,
                                                             const stream_position &position) {
  if (not frontier.has_value()) {
    frontier = position;
    return {true, durability_error_code::None};
  }
  switch (compare_positions(*frontier, position)) {
  case position_order::Before:
    frontier = position;
    return {true, durability_error_code::None};
  case position_order::Equal:
    return {false, durability_error_code::None};
  case position_order::After:
    return {false, durability_error_code::WatermarkRegression};
  case position_order::Unordered:
    return {false, durability_error_code::PositionEpochMismatch};
  }
  return {false, durability_error_code::PositionEpochMismatch};
}

watermark_update_result watermark_tracker::require_at_or_below(const std::optional<stream_position> &dependency,
                                                               const stream_position &position) const {
  if (not dependency.has_value()) {
    return {false, durability_error_code::FrontierNotEstablished};
  }
  const auto order = compare_positions(position, *dependency);
  if (order == position_order::Unordered) {
    return {false, durability_error_code::PositionEpochMismatch};
  }
  if (order == position_order::After) {
    return {false, durability_error_code::FrontierAheadOfDependency};
  }
  return {false, durability_error_code::None};
}

watermark_update_result watermark_tracker::advance(watermark_kind kind, const stream_position &position) {
  switch (kind) {
  case watermark_kind::Visible:
    return advance_monotonic(visible_, position);
  case watermark_kind::Durable: {
    const auto check = require_at_or_below(visible_, position);
    return check.error == durability_error_code::None ? advance_monotonic(durable_, position) : check;
  }
  case watermark_kind::Projection: {
    const auto check = require_at_or_below(durable_, position);
    return check.error == durability_error_code::None ? advance_monotonic(projection_, position) : check;
  }
  case watermark_kind::Replicated: {
    const auto check = require_at_or_below(durable_, position);
    return check.error == durability_error_code::None ? advance_monotonic(replicated_, position) : check;
  }
  }
  return {false, durability_error_code::InvalidRequest};
}

} // namespace kungfu::runtime::durability
