// SPDX-License-Identifier: Apache-2.0

#include "service_internal.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iomanip>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::storage_service_api {

namespace fs = std::filesystem;
namespace yy_storage = kungfu::yijinjing::storage;
namespace yy_enums = kungfu::yijinjing::enums;

namespace detail {
namespace {

constexpr const char *EPISODE_WRITE_RETRY_SCHEMA_V1 = "kungfu.episode.write-retry/v1";
constexpr const char *EPISODE_RECOVERY_PLAN_SCHEMA_V1 = "kungfu.episode.recovery-plan/v1";
constexpr const char *EPISODE_RECOVERY_RECEIPT_SCHEMA_V1 = "kungfu.episode.recovery-receipt/v1";

double number_or(const nlohmann::json &object, const std::string &field, double fallback) {
  const auto iter = object.find(field);
  if (iter == object.end() || iter->is_null())
    return fallback;
  if (!iter->is_number())
    throw std::invalid_argument(field + " must be a number");
  return iter->get<double>();
}

bool manifest_writer_busy(const std::exception &error) {
  return std::string_view(error.what()).rfind("manifest_writer_busy:", 0) == 0;
}

std::string episode_writer_resource_id(uint32_t location_uid) {
  std::ostringstream value;
  value << std::hex << std::setfill('0') << std::setw(8) << location_uid << '.' << std::setw(8) << uint32_t{0};
  return value.str();
}

nlohmann::json ownership_evidence_json(const yijinjing::ownership::evidence &evidence) {
  return {{"schema", evidence.schema},
          {"scope", yijinjing::ownership::scope_name(evidence.ownership_scope)},
          {"dataRoot", evidence.data_root},
          {"resourceId", evidence.resource_id},
          {"generation", evidence.generation},
          {"fenceToken", evidence.fence_token},
          {"ownerPid", evidence.owner_pid},
          {"acquiredAt", evidence.acquired_at},
          {"recoveredStaleOwner", evidence.recovered_stale_owner},
          {"owned", evidence.owned}};
}

nlohmann::json episode_age_json(const yy_storage::episode_current_view &episode, int64_t now_ns,
                                double stale_after_seconds) {
  const auto heartbeat_time = episode.heartbeat_seen ? episode.update_time : int64_t{0};
  const auto begin_time = episode.opened ? episode.open.begin_time : int64_t{0};
  std::string anchor_kind = "manifest-open";
  int64_t anchor_ns = episode.open_manifest_gen_time;
  if (heartbeat_time > 0) {
    anchor_kind = "heartbeat";
    anchor_ns = heartbeat_time;
  } else if (begin_time > 0) {
    anchor_kind = "begin";
    anchor_ns = begin_time;
  }
  const auto has_age = anchor_ns > 0;
  const auto age_seconds = has_age ? static_cast<double>(now_ns - anchor_ns) / 1'000'000'000.0 : 0.0;
  return {{"heartbeatSeen", episode.heartbeat_seen},
          {"heartbeatTime", heartbeat_time > 0 ? nlohmann::json(heartbeat_time) : nlohmann::json(nullptr)},
          {"beginTime", begin_time > 0 ? nlohmann::json(begin_time) : nlohmann::json(nullptr)},
          {"anchorKind", anchor_kind},
          {"anchorTime", anchor_ns > 0 ? nlohmann::json(anchor_ns) : nlohmann::json(nullptr)},
          {"ageSeconds", has_age ? nlohmann::json(age_seconds) : nlohmann::json(nullptr)},
          {"staleAfterSeconds", stale_after_seconds},
          {"stale", has_age && age_seconds >= stale_after_seconds}};
}

nlohmann::json episode_writer_json(const std::string &runtime_dir, uint32_t location_uid) {
  if (location_uid == 0) {
    return {{"resourceId", nullptr}, {"evidencePath", nullptr}, {"active", false},
            {"status", "unknown"},   {"evidence", nullptr},     {"error", "episode location_uid is zero"}};
  }
  const auto resource_id = episode_writer_resource_id(location_uid);
  const auto evidence_path = fs::path(runtime_dir) / "ownership" / "writers" / (resource_id + ".lock");
  nlohmann::json result = {{"resourceId", resource_id},
                           {"evidencePath", evidence_path.string()},
                           {"active", false},
                           {"status", "absent"},
                           {"evidence", nullptr}};
  if (!fs::exists(evidence_path))
    return result;
  try {
    const auto evidence = yijinjing::ownership::inspect_active_stream_writer(runtime_dir, resource_id);
    result["active"] = true;
    result["status"] = "active";
    result["evidence"] = ownership_evidence_json(evidence);
  } catch (const std::exception &error) {
    const auto message = std::string(error.what());
    if (message.rfind("ownership_not_active:", 0) == 0) {
      result["status"] = "inactive";
    } else {
      result["status"] = "unknown";
      result["error"] = message;
    }
  }
  return result;
}

nlohmann::json recovery_error(const char *code, const char *message, nlohmann::json plan,
                              nlohmann::json fence = nullptr) {
  nlohmann::json result = {{"schema", EPISODE_RECOVERY_RECEIPT_SCHEMA_V1},
                           {"ok", false},
                           {"error", {{"code", code}, {"message", message}}},
                           {"plan", std::move(plan)}};
  if (!fence.is_null())
    result["fence"] = std::move(fence);
  return result;
}

} // namespace

nlohmann::json retry_episode_manifest_write(const std::string &operation, const nlohmann::json &operation_options,
                                            const std::function<nlohmann::json()> &action) {
  const auto policy = object_or_empty(operation_options, "write_retry");
  const auto timeout_ms = uint64_or(policy, "timeout_ms", 4000);
  const auto initial_delay_ms = uint64_or(policy, "initial_delay_ms", 20);
  const auto max_delay_ms = uint64_or(policy, "max_delay_ms", 250);
  const auto jitter_ratio = number_or(policy, "jitter_ratio", 0.2);
  if (timeout_ms == 0 || initial_delay_ms == 0 || max_delay_ms < initial_delay_ms || jitter_ratio < 0.0 ||
      jitter_ratio > 1.0)
    throw std::invalid_argument("invalid episode write retry policy");

  const auto started = std::chrono::steady_clock::now();
  const auto deadline = started + std::chrono::milliseconds(timeout_ms);
  auto delay_ms = initial_delay_ms;
  uint64_t attempts = 0;
  uint64_t busy_retries = 0;
  std::mt19937_64 random{std::random_device{}()};
  std::uniform_real_distribution<double> jitter{-1.0, 1.0};
  while (true) {
    ++attempts;
    try {
      auto result = action();
      const auto elapsed =
          std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
      result["write_retry"] = {{"schema", EPISODE_WRITE_RETRY_SCHEMA_V1},
                               {"operation", operation},
                               {"attempts", attempts},
                               {"busyRetries", busy_retries},
                               {"elapsedMs", std::max<int64_t>(0, elapsed)},
                               {"exhausted", false}};
      return result;
    } catch (const std::runtime_error &error) {
      if (!manifest_writer_busy(error))
        throw;
      ++busy_retries;
      const auto now = std::chrono::steady_clock::now();
      if (now >= deadline)
        throw std::runtime_error("episode_writer_busy_timeout: " + operation + " exhausted manifest_writer_busy");
      const auto jittered = static_cast<double>(delay_ms) * (1.0 + jitter_ratio * jitter(random));
      const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
      const auto wait_ms = std::min<uint64_t>(static_cast<uint64_t>(std::max<double>(0.0, jittered)),
                                              static_cast<uint64_t>(std::max<int64_t>(0, remaining)));
      if (wait_ms == 0)
        throw std::runtime_error("episode_writer_busy_timeout: " + operation + " exhausted manifest_writer_busy");
      std::this_thread::sleep_for(std::chrono::milliseconds(wait_ms));
      delay_ms = std::min<uint64_t>(delay_ms * 2, max_delay_ms);
    }
  }
}

nlohmann::json episode_recovery_plan_impl(const storage_service_options &options) {
  const auto episode_id = uint64_or(options.operation_options, "episode_id", options.episode_id);
  const auto requested_location_uid = uint32_or(options.operation_options, "location_uid");
  const auto stale_after_seconds = number_or(options.operation_options, "stale_after_seconds", 300.0);
  const auto now_ns = int64_or(options.operation_options, "now_ns", yijinjing::time::now_in_nano());
  if (episode_id == 0)
    throw std::invalid_argument("episode_id must be positive");
  if (stale_after_seconds < 0.0)
    throw std::invalid_argument("stale_after_seconds must be non-negative");

  const auto inspected = episode_store(options).inspect_typed(episode_id);
  const auto &episode = inspected.episode;
  const auto owner_location_uid = episode.opened ? episode.open.location_uid : uint32_t{0};
  const auto expected_manifest_frame_uid =
      episode.records.empty() ? uint64_t{0} : episode.records.back().manifest_frame_uid;
  const auto age = episode_age_json(episode, now_ns, stale_after_seconds);
  const auto writer = episode_writer_json(options.runtime_dir, owner_location_uid);
  nlohmann::json blockers = nlohmann::json::array();
  const auto block = [&blockers](const char *code, const char *message) {
    blockers.push_back({{"code", code}, {"message", message}});
  };
  if (!episode.opened)
    block("episode_not_opened", "Episode has no open record");
  if (episode.closed || episode.close_count > 0)
    block("episode_terminal_record_present", "Episode already has a terminal record");
  if (owner_location_uid == 0)
    block("episode_location_unknown", "Episode does not identify a recoverable writer location");
  if (requested_location_uid != 0 && requested_location_uid != owner_location_uid)
    block("episode_location_mismatch", "requested location does not own the Episode open record");
  if (writer.at("active").get<bool>())
    block("episode_writer_active", "the Episode event-stream writer lease is live");
  else if (writer.at("status") == "unknown")
    block("episode_writer_liveness_unknown", "writer liveness could not be proven inactive");
  if (age.at("ageSeconds").is_null() || age.at("ageSeconds").get<double>() < 0.0)
    block("episode_age_unknown", "Episode age cannot be established from its manifest facts");
  else if (!age.at("stale").get<bool>())
    block("episode_not_stale", "Episode is newer than the declared stale threshold");

  nlohmann::json result = {
      {"schema", EPISODE_RECOVERY_PLAN_SCHEMA_V1},
      {"ok", true},
      {"action", "abort-open-episode"},
      {"runtimeDir", options.runtime_dir},
      {"episodeId", episode_id},
      {"locationUid", owner_location_uid},
      {"terminalRecordPresent", episode.closed || episode.close_count > 0},
      {"expectedManifestFrameUid", expected_manifest_frame_uid},
      {"age", age},
      {"writer", writer},
      {"eligible", blockers.empty()},
      {"blockers", blockers},
      {"preconditions",
       {"Episode remains open and has no terminal record", "the exact event-stream writer lease can be acquired",
        "the Episode remains older than staleAfterSeconds",
        "native manifest recovery acquires the data-root writer guard"}}};
  nlohmann::json blocker_codes = nlohmann::json::array();
  for (const auto &item : blockers)
    blocker_codes.push_back(item.at("code"));
  const nlohmann::json identity = {
      {"schema", result.at("schema")},
      {"action", result.at("action")},
      {"runtimeDir", result.at("runtimeDir")},
      {"episodeId", result.at("episodeId")},
      {"locationUid", result.at("locationUid")},
      {"terminalRecordPresent", result.at("terminalRecordPresent")},
      {"expectedManifestFrameUid", result.at("expectedManifestFrameUid")},
      {"age",
       {{"anchorKind", age.at("anchorKind")},
        {"anchorTime", age.at("anchorTime")},
        {"staleAfterSeconds", age.at("staleAfterSeconds")},
        {"stale", age.at("stale")}}},
      {"writer",
       {{"resourceId", writer.at("resourceId")}, {"status", writer.at("status")}, {"active", writer.at("active")}}},
      {"eligible", result.at("eligible")},
      {"blockers", blocker_codes}};
  result["planId"] = yy_storage::format_content_hash(yy_storage::compute_content_hash(canonical_json(identity)));
  return result;
}

nlohmann::json episode_recovery_execute_impl(const storage_service_options &options) {
  auto plan = episode_recovery_plan_impl(options);
  if (!plan.at("eligible").get<bool>())
    return recovery_error("episode_recovery_not_eligible", "recovery preconditions are not satisfied", std::move(plan));

  const auto resource_id = plan.at("writer").at("resourceId").get<std::string>();
  yijinjing::ownership::lease recovery_lease;
  try {
    recovery_lease = yijinjing::ownership::lease::acquire_stream_writer(options.runtime_dir, resource_id);
  } catch (const std::exception &) {
    return recovery_error("episode_recovery_writer_active",
                          "the event-stream writer lease became active before execute", std::move(plan));
  }
  const auto fence = ownership_evidence_json(recovery_lease.status());
  const auto episode_id = plan.at("episodeId").get<uint64_t>();
  const auto inspected = episode_store(options).inspect_typed(episode_id);
  const auto &episode = inspected.episode;
  const auto stale_after_seconds = number_or(options.operation_options, "stale_after_seconds", 300.0);
  const auto now_ns = int64_or(options.operation_options, "now_ns", yijinjing::time::now_in_nano());
  const auto age = episode_age_json(episode, now_ns, stale_after_seconds);
  const auto current_manifest_frame_uid =
      episode.records.empty() ? uint64_t{0} : episode.records.back().manifest_frame_uid;
  if (!episode.opened || episode.closed || episode.close_count > 0 ||
      episode.open.location_uid != plan.at("locationUid").get<uint32_t>() || !age.at("stale").get<bool>() ||
      current_manifest_frame_uid == 0 ||
      current_manifest_frame_uid != plan.at("expectedManifestFrameUid").get<uint64_t>())
    return recovery_error("episode_recovery_state_changed", "Episode facts changed after planning; generate a new plan",
                          std::move(plan), fence);

  yy_storage::episode_recover_options recover{};
  recover.episode_id = episode_id;
  recover.location_uid = episode.open.location_uid;
  recover.end_time = int64_or(options.operation_options, "end_time", now_ns);
  recover.reason = text_or(options.operation_options, "reason", "operator recovery");
  recover.expected_manifest_frame_uid = current_manifest_frame_uid;
  auto recovered = retry_episode_manifest_write("episode_recover", options.operation_options, [&] {
    return render_episode_recover_result(episode_store(options).recover(recover));
  });
  auto write_retry = recovered.at("write_retry");
  recovered.erase("write_retry");
  bool applied = false;
  for (const auto &item : recovered.at("recovered"))
    applied = applied || item.at("episode_id").get<uint64_t>() == episode_id;
  if (!applied)
    return recovery_error("episode_recovery_not_applied", "native recovery did not append the expected terminal record",
                          std::move(plan), fence);
  return {{"schema", EPISODE_RECOVERY_RECEIPT_SCHEMA_V1},
          {"ok", true},
          {"plan", std::move(plan)},
          {"fence", fence},
          {"writeRetry", std::move(write_retry)},
          {"recovery", std::move(recovered)}};
}

nlohmann::json dispatch_episode_control_operation(storage_operation operation, const storage_service_options &options) {
  switch (operation) {
  case storage_operation::EpisodeBegin:
    return retry_episode_manifest_write("episode_begin", options.operation_options, [&] {
      return episode_record_body_json(
          episode_store(options).begin(parse_episode_begin_options(options.operation_options)));
    });
  case storage_operation::EpisodeHeartbeat:
    return retry_episode_manifest_write("episode_heartbeat", options.operation_options, [&] {
      return episode_record_body_json(
          episode_store(options).heartbeat(parse_episode_heartbeat_options(options.operation_options)));
    });
  case storage_operation::EpisodeEnd:
    return retry_episode_manifest_write("episode_end", options.operation_options, [&] {
      return render_episode_close_write_result(episode_store(options).end(
          parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Ended)));
    });
  case storage_operation::EpisodeAbort:
    return retry_episode_manifest_write("episode_abort", options.operation_options, [&] {
      return render_episode_close_write_result(episode_store(options).abort(
          parse_episode_close_options(options.operation_options, yy_enums::EpisodeStatus::Aborted)));
    });
  case storage_operation::EpisodeAttachFrame:
    return retry_episode_manifest_write("episode_attach_frame", options.operation_options, [&] {
      return episode_record_body_json(
          episode_store(options).attach_frame(parse_episode_frame_attach_options(options.operation_options)));
    });
  case storage_operation::EpisodeAttachRef:
    return retry_episode_manifest_write("episode_attach_ref", options.operation_options, [&] {
      return episode_record_body_json(
          episode_store(options).attach_ref(parse_episode_ref_attach_options(options.operation_options)));
    });
  case storage_operation::EpisodeRecover:
    return retry_episode_manifest_write("episode_recover", options.operation_options, [&] {
      return render_episode_recover_result(
          episode_store(options).recover(parse_episode_recover_options(options.operation_options)));
    });
  case storage_operation::EpisodeRecoveryPlan:
    return episode_recovery_plan_impl(options);
  case storage_operation::EpisodeRecoveryExecute:
    return episode_recovery_execute_impl(options);
  default:
    throw std::invalid_argument("not an Episode control operation");
  }
}

} // namespace detail
} // namespace kungfu::runtime::storage_service_api
