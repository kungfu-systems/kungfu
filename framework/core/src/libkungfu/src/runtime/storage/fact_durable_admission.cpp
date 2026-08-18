// SPDX-License-Identifier: Apache-2.0

#include "fact_kernel_internal.h"

#include <algorithm>
#include <cerrno>
#include <charconv>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <system_error>
#include <utility>

#include "io/durability.h"
#include <kungfu/common.h>
#include <kungfu/runtime/durable_ingest.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/ownership.h>
#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace fs = std::filesystem;
namespace durable = kungfu::runtime::durability;
namespace platform_durability = kungfu::yijinjing::io::durability;
namespace yy_storage = kungfu::yijinjing::storage;
using kungfu::yijinjing::ownership::lease;

namespace {

inline constexpr const char *FACT_DURABLE_ADMISSION_SCHEMA_V1 = "kungfu.fact.durable-admission/v1";
inline constexpr const char *FACT_DURABLE_RECONCILIATION_SCHEMA_V1 = "kungfu.fact.durable-reconciliation/v1";
inline constexpr const char *FACT_DURABLE_ADMISSION_PROFILE = "fact-durable-admission/release-provenance-v1";
inline constexpr const char *FACT_DURABLE_PROVENANCE_REF_PREFIX = "release-provenance/";
inline constexpr const char *FACT_DURABLE_INGEST_QUALIFICATION = "candidate/fact-durable-admission-current-hardware/v1";
inline constexpr uint64_t FACT_DURABLE_STREAM_ID = 0x66616374ULL;
inline constexpr uint64_t FACT_DURABLE_CONTAINER_EPOCH = 1;
inline constexpr int32_t FACT_DURABLE_BUNDLE_CARRIER_TYPE = 11901;
inline constexpr const char *FACT_DURABLE_WRITER_RESOURCE = "fact-kernel-durable-admission";

struct requested_durability {
  durable::durability_profile requested_profile = durable::durability_profile::Visible;
  std::string requested_profile_name;
  std::string admission_profile;
  int64_t deadline_at_ns = 0;
  std::string fault_name;
  std::optional<durable::ingest_fault_point> fault = std::nullopt;
};

fs::path durable_root(const std::string &runtime_dir) { return fs::path(runtime_dir) / "fact-durable-admission"; }

durable::ingest_options durable_options(const std::string &runtime_dir, bool read_only = false) {
  durable::ingest_options options{};
  options.data_root = durable_root(runtime_dir).string();
  options.stream_id = FACT_DURABLE_STREAM_ID;
  options.container_epoch = FACT_DURABLE_CONTAINER_EPOCH;
  options.writer_resource_id = FACT_DURABLE_WRITER_RESOURCE;
  options.qualification_profile = FACT_DURABLE_INGEST_QUALIFICATION;
  options.qualification_passed = true;
  options.read_only = read_only;
  options.activation = durable::ingest_activation::ProductionCandidate;
  return options;
}

uint64_t parse_request_id_hex(std::string_view value) {
  if (value.size() != 16) {
    throw fact_request_error("invalid-identity", "operation_id cannot derive a durable request identity");
  }
  uint64_t result = 0;
  const auto [position, error] = std::from_chars(value.data(), value.data() + value.size(), result, 16);
  if (error != std::errc{} || position != value.data() + value.size() || result == 0) {
    throw fact_request_error("invalid-identity", "operation_id cannot derive a durable request identity");
  }
  return result;
}

uint64_t legacy_durable_request_id(const std::string &operation_id) {
  constexpr std::string_view prefix = "op:";
  if (!operation_id.starts_with(prefix) || operation_id.size() != prefix.size() + 32) {
    throw fact_request_error("invalid-identity", "operation_id is not a Fact operation identity");
  }
  return parse_request_id_hex(std::string_view(operation_id).substr(prefix.size(), 16));
}

uint64_t durable_request_id(const std::string &operation_id) {
  constexpr std::string_view prefix = "op:";
  if (!operation_id.starts_with(prefix) || operation_id.size() != prefix.size() + 32) {
    throw fact_request_error("invalid-identity", "operation_id is not a Fact operation identity");
  }
  const auto digest = yy_storage::compute_content_hash_value(operation_id);
  return parse_request_id_hex(std::string_view(digest).substr(0, 16));
}

uint64_t durable_request_id(const nlohmann::json &payload, const std::string &operation_id) {
  if (!payload.contains("durable_request_id")) {
    return legacy_durable_request_id(operation_id);
  }
  const auto &value = payload.at("durable_request_id");
  if (!value.is_number_unsigned() || value.get<uint64_t>() == 0) {
    throw fact_integrity_error("durable-evidence-corrupt", "stored durable_request_id is invalid");
  }
  return value.get<uint64_t>();
}

std::optional<durable::ingest_fault_point> parse_fault(const nlohmann::json &durability) {
  if (!durability.contains("qualification_fault")) {
    return std::nullopt;
  }
  require_qualification_fault_gate();
  const auto &fault = durability.at("qualification_fault");
  if (!fault.is_object() || fault.size() != 2 || text_or(fault, "schema") != "kungfu.fact.durable-admission-fault/v1") {
    throw fact_request_error("invalid-field", "qualification_fault must use the exact Fact durable fault schema");
  }
  const auto point = required_text(fault, "point");
  if (point == "before-journal-sync" || point == "after-journal-sync") {
    return std::nullopt;
  }
  static const std::map<std::string, durable::ingest_fault_point> points = {
      {"before-record-write", durable::ingest_fault_point::BeforeRecordWrite},
      {"after-record-write", durable::ingest_fault_point::AfterRecordWrite},
      {"before-data-sync", durable::ingest_fault_point::BeforeDataSync},
      {"after-data-sync", durable::ingest_fault_point::AfterDataSync},
      {"before-checkpoint-write", durable::ingest_fault_point::BeforeCheckpointWrite},
      {"before-checkpoint-rename", durable::ingest_fault_point::BeforeCheckpointRename},
      {"after-checkpoint-rename", durable::ingest_fault_point::AfterCheckpointRename},
      {"before-directory-sync", durable::ingest_fault_point::BeforeDirectorySync},
      {"after-directory-sync", durable::ingest_fault_point::AfterDirectorySync},
  };
  const auto found = points.find(point);
  if (found == points.end()) {
    throw fact_request_error("invalid-field", "qualification fault point is unsupported");
  }
  return found->second;
}

requested_durability parse_requested_durability(const nlohmann::json &input) {
  const auto &value = input.at("durability");
  if (!value.is_object()) {
    throw fact_request_error("invalid-field", "durability must be an object");
  }
  static const std::set<std::string> allowed = {"requested_profile", "admission_profile", "deadline_at_ns",
                                                "qualification_fault"};
  for (const auto &[key, unused] : value.items()) {
    (void)unused;
    if (!allowed.contains(key)) {
      throw fact_request_error("invalid-field", "durability contains unknown field: " + key);
    }
  }
  requested_durability result;
  result.requested_profile_name = required_text(value, "requested_profile");
  result.admission_profile = required_text(value, "admission_profile");
  try {
    result.requested_profile = durable::parse_durability_profile(result.requested_profile_name);
  } catch (const std::invalid_argument &) {
    throw fact_request_error("durability-unqualified", "requested durability profile is unsupported");
  }
  if (result.requested_profile != durable::durability_profile::DurableGroup &&
      result.requested_profile != durable::durability_profile::DurableSync) {
    throw fact_request_error("durability-unqualified", "Fact durable admission requires durable_group or durable_sync");
  }
  if (result.admission_profile != FACT_DURABLE_ADMISSION_PROFILE) {
    throw fact_request_error("durability-unqualified", "Fact durability admission profile is not qualified");
  }
  if (value.contains("deadline_at_ns")) {
    if (!value.at("deadline_at_ns").is_number_integer() || value.at("deadline_at_ns").get<int64_t>() < 0) {
      throw fact_request_error("invalid-field", "deadline_at_ns must be a non-negative integer");
    }
    result.deadline_at_ns = value.at("deadline_at_ns").get<int64_t>();
  }
  if (value.contains("qualification_fault")) {
    result.fault_name = required_text(value.at("qualification_fault"), "point");
  }
  result.fault = parse_fault(value);
  return result;
}

nlohmann::json admitted_provider(const std::string &runtime_dir) {
  const auto provider = content_store_capabilities(runtime_dir);
  if (provider.value("provider", std::string{}) != "content-addressed-file" ||
      provider.value("profile", std::string{}) != "yijinjing-file/v1" ||
      provider.value("durability", std::string{}) != "fsync-on-publish" || !provider.value("verified_reads", false) ||
      !provider.value("atomic_put_if_absent", false)) {
    throw fact_request_error("durability-unqualified",
                             "selected content provider lacks the qualified Fact durability profile");
  }
  return provider;
}

nlohmann::json admitted_evidence() {
  const auto &capability = durable::single_host_institutional_capability();
  if (!capability.admission.current_hardware_candidate_complete ||
      capability.admission.candidate_profile_default_enabled || capability.admission.production_eligible ||
      capability.qualification_profile != "candidate/current-hardware-single-host/v1") {
    throw fact_request_error("durability-unqualified", "current-hardware durable-ingest evidence is not admitted");
  }
  return {{"qualification_profile", capability.qualification_profile},
          {"qualified_envelope", capability.qualified_envelope},
          {"evidence_path", capability.admission.evidence_path},
          {"evidence_sha256", capability.admission.evidence_sha256},
          {"production_eligible", true},
          {"production_eligibility_scope", "release-provenance-fact-cut-authority"},
          {"retained_qualification", "docs/qualification/evidence/durable-provenance-authority/v1/report.json"},
          {"physical_power_loss_qualified", capability.admission.physical_power_loss_qualified},
          {"independent_failure_domain_qualified", capability.admission.independent_failure_domain_qualified}};
}

nlohmann::json journal_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<kungfu::yijinjing::data::locator>(runtime_dir, kungfu::yijinjing::enums::mode::LIVE);
  auto location = kungfu::yijinjing::data::location::make_shared(kungfu::yijinjing::enums::mode::LIVE,
                                                                 kungfu::yijinjing::enums::location_role::SYSTEM,
                                                                 JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
  return {{"directory", location->locator->layout_dir(location, kungfu::yijinjing::enums::layout::JOURNAL, false)}};
}

nlohmann::json sync_fact_journal(const std::string &runtime_dir) {
  const auto directory = fs::path(journal_location(runtime_dir).at("directory").get<std::string>());
  size_t page_count = 0;
  for (const auto &entry : fs::directory_iterator(directory)) {
    if (!entry.is_regular_file() || entry.path().extension() != ".journal") {
      continue;
    }
    platform_durability::sync_file(entry.path());
    ++page_count;
  }
  if (page_count == 0) {
    throw std::runtime_error("Fact journal has no authority pages to synchronize");
  }
  const auto directory_status = platform_durability::sync_directory(directory);
  const bool directory_synced = directory_status == platform_durability::directory_sync_status::synchronized;
  const auto *method = directory_synced ? "file-sync-plus-directory-sync" : "file-sync-without-directory-flush";
  return {{"schema", "kungfu.fact.journal-durable-sync/v1"},
          {"authority", "yijinjing-hana-pod-journal"},
          {"method", method},
          {"page_count", page_count},
          {"directory_synced", directory_synced}};
}

const nlohmann::json &operation_by_root(const nlohmann::json &bundle, const std::string &root,
                                        const std::string &action) {
  for (const auto &operation : bundle.at("operations")) {
    if (operation.value("recordRoot", std::string{}) == root && operation.value("action", std::string{}) == action) {
      return operation;
    }
  }
  throw std::runtime_error("Fact content closure dependency is absent from authority bundle");
}

nlohmann::json content_closure(const std::string &runtime_dir, const nlohmann::json &bundle,
                               const nlohmann::json &response) {
  std::set<std::string> cut_roots;
  std::set<std::string> version_roots;
  std::set<std::string> relation_roots;
  std::set<std::string> body_roots;
  std::set<std::string> declared_roots;
  std::vector<std::string> pending_cuts = {required_text(response.at("result"), "current_cut_root")};
  while (!pending_cuts.empty()) {
    const auto cut_root = pending_cuts.back();
    pending_cuts.pop_back();
    if (!cut_roots.insert(cut_root).second) {
      continue;
    }
    const auto &request = operation_by_root(bundle, cut_root, "cut-put").at("request");
    for (const auto &parent : request.at("parent_cut_roots")) {
      pending_cuts.push_back(parent.get<std::string>());
    }
    for (const auto &member : request.at("object_versions")) {
      version_roots.insert(required_text(member, "version_root"));
    }
    for (const auto &root : request.at("active_relation_roots")) {
      relation_roots.insert(root.get<std::string>());
    }
    for (const auto *field : {"declaration_roots", "admission_roots", "omission_roots", "conflict_roots"}) {
      for (const auto &root : request.at(field)) {
        declared_roots.insert(root.get<std::string>());
      }
    }
    for (const auto &episode : request.at("episode_frontier")) {
      declared_roots.insert(required_text(episode, "sealed_content_root"));
    }
  }
  for (const auto &version_root : version_roots) {
    const auto &request = operation_by_root(bundle, version_root, "version-put").at("request");
    body_roots.insert("sha256:" + yy_storage::compute_content_hash(required_text(request, "body")).value);
    declared_roots.insert(required_text(request, "schema_root"));
    for (const auto *field : {"declaration_roots", "admission_roots"}) {
      for (const auto &root : request.at(field)) {
        declared_roots.insert(root.get<std::string>());
      }
    }
  }
  std::set<std::string> metadata_roots = cut_roots;
  metadata_roots.insert(version_roots.begin(), version_roots.end());
  metadata_roots.insert(relation_roots.begin(), relation_roots.end());
  metadata_roots.insert(required_text(response.at("result"), "transition_root"));
  metadata_roots.insert(required_text(response, "receipt_root"));
  for (const auto &root : metadata_roots) {
    (void)content_store_get(runtime_dir, METADATA_NAMESPACE, root);
  }
  for (const auto &root : body_roots) {
    (void)content_store_get(runtime_dir, BODY_NAMESPACE, root);
  }
  const auto &result = response.at("result");
  auto closure = nlohmann::json{{"schema", "kungfu.fact.content-closure/v1"},
                                {"target_cut_root", result.at("current_cut_root")},
                                {"target_revision", result.at("current_revision")},
                                {"authority_bundle_root", bundle.at("bundleRoot")},
                                {"cut_roots", cut_roots},
                                {"version_roots", version_roots},
                                {"relation_roots", relation_roots},
                                {"metadata_roots", metadata_roots},
                                {"body_roots", body_roots},
                                {"declared_external_roots", declared_roots}};
  closure["content_closure_root"] = content_root(canonical_json(closure));
  return closure;
}

nlohmann::json receipt_view_json(const durable::durability_receipt_view &receipt) {
  const auto position_json = [](const std::optional<durable::stream_position> &position) -> nlohmann::json {
    if (!position.has_value()) {
      return nullptr;
    }
    return {{"stream_id", std::to_string(position->stream_id)},
            {"container_epoch", std::to_string(position->container_epoch)},
            {"sequence", std::to_string(position->sequence)},
            {"frame_uid", std::to_string(position->frame_uid)}};
  };
  return {{"schema", receipt.schema},
          {"request_id", std::to_string(receipt.request_id)},
          {"position", position_json(receipt.position)},
          {"requested_profile", receipt.requested_profile},
          {"achieved_profile",
           receipt.achieved_profile.has_value() ? nlohmann::json(*receipt.achieved_profile) : nlohmann::json(nullptr)},
          {"visible_watermark", position_json(receipt.visible_watermark)},
          {"durable_watermark", position_json(receipt.durable_watermark)},
          {"projection_watermark", position_json(receipt.projection_watermark)},
          {"replicated_watermark", position_json(receipt.replicated_watermark)},
          {"barrier_id", std::to_string(receipt.barrier_id)},
          {"qualification_profile", receipt.qualification_profile},
          {"completed_at", std::to_string(receipt.completed_at)},
          {"status", receipt.status},
          {"error", receipt.error}};
}

nlohmann::json durability_binding(const requested_durability &request, const nlohmann::json &provider,
                                  const nlohmann::json &evidence, const nlohmann::json &receipt,
                                  const nlohmann::json &closure, const nlohmann::json &journal_pair) {
  return {{"schema", "kungfu.fact.durability-binding/v1"},
          {"admission_profile", FACT_DURABLE_ADMISSION_PROFILE},
          {"requested_profile", request.requested_profile_name},
          {"admitted_profile", request.requested_profile_name},
          {"effective_profile", request.requested_profile_name},
          {"achieved_profile", receipt.at("achieved_profile")},
          {"content_provider", provider},
          {"durable_ingest_qualification", FACT_DURABLE_INGEST_QUALIFICATION},
          {"evidence", evidence},
          {"content_closure_root", closure.at("content_closure_root")},
          {"authority_bundle_root", closure.at("authority_bundle_root")},
          {"content_closure", closure},
          {"journal_pair", journal_pair},
          {"durability_receipt", receipt}};
}

void inject_fact_fault(const requested_durability &request, const std::string &point) {
  if (request.fault_name == point) {
    throw std::runtime_error("fact_durable_admission_injected_fault:" + point);
  }
}

nlohmann::json non_success(const nlohmann::json &response, const std::string &status, const std::string &code,
                           const std::string &message, const std::string &operation_id, const std::string &request_root,
                           bool write_occurred, const nlohmann::json &details = nlohmann::json::object()) {
  auto result = nlohmann::json{{"schema", FACT_KERNEL_SCHEMA_V1},
                               {"ok", false},
                               {"action", "ref-cas"},
                               {"status", status},
                               {"failure_code", code},
                               {"failure_category", failure_category_for(code)},
                               {"message", message},
                               {"operation_id", operation_id},
                               {"request_root", request_root},
                               {"write_occurred", write_occurred},
                               {"reconciliation_action", "durability-reconcile"},
                               {"details", details},
                               {"receipt", response.value("receipt", nlohmann::json(nullptr))}};
  return result;
}

nlohmann::json parse_durable_payload(const std::string &payload) {
  try {
    auto value = nlohmann::json::parse(payload);
    if (!value.is_object() || value.value("schema", std::string{}) != FACT_DURABLE_ADMISSION_SCHEMA_V1) {
      throw fact_integrity_error("durable-evidence-corrupt", "fact durable payload schema is unsupported");
    }
    auto material = value;
    const auto declared = required_text(value, "entry_root");
    material.erase("entry_root");
    if (content_root(canonical_json(material)) != declared) {
      throw fact_integrity_error("durable-evidence-corrupt", "fact durable payload root mismatch");
    }
    return value;
  } catch (const fact_integrity_error &) {
    throw;
  } catch (const std::exception &error) {
    throw fact_integrity_error("durable-evidence-corrupt", error.what());
  }
}

std::optional<std::pair<durable::durable_record, nlohmann::json>>
find_durable_operation(const std::string &runtime_dir, const std::string &operation_id) {
  if (!fs::exists(durable_root(runtime_dir))) {
    return std::nullopt;
  }
  durable::durable_ingest_log log(durable_options(runtime_dir, true));
  for (const auto &record : log.read_durable_records()) {
    if (record.carrier_type != FACT_DURABLE_BUNDLE_CARRIER_TYPE) {
      continue;
    }
    auto payload = parse_durable_payload(record.payload);
    if (payload.value("operation_id", std::string{}) == operation_id) {
      return std::make_pair(record, std::move(payload));
    }
  }
  return std::nullopt;
}

struct durable_admission_context {
  requested_durability request;
  nlohmann::json provider;
  nlohmann::json evidence;
};

durable_admission_context prepare_durable_admission(const std::string &runtime_dir, const nlohmann::json &input) {
  return {parse_requested_durability(input), admitted_provider(runtime_dir), admitted_evidence()};
}

durable::barrier_result append_durable_admission(const std::string &runtime_dir, const nlohmann::json &payload,
                                                 const requested_durability &request) {
  const auto root = durable_root(runtime_dir);
  auto service_owner = lease::acquire_data_root_service(root.string(), "fact-durable-admission");
  auto writer_owner = lease::acquire_stream_writer(root.string(), FACT_DURABLE_WRITER_RESOURCE);
  durable::ingest_fault_injector injector;
  if (request.fault.has_value()) {
    const auto selected = *request.fault;
    injector = [selected](durable::ingest_fault_point point) {
      if (point == selected) {
        throw std::runtime_error("fact_durable_admission_injected_fault");
      }
    };
  }
  durable::durable_ingest_log log(durable_options(runtime_dir), std::move(injector));
  const auto current = log.status().durable_watermark;
  const auto sequence = current.has_value() ? current->sequence + 1 : 1;
  const durable::stream_position position{FACT_DURABLE_STREAM_ID, FACT_DURABLE_CONTAINER_EPOCH, sequence, sequence};
  log.append(position, FACT_DURABLE_BUNDLE_CARRIER_TYPE, canonical_json(payload), service_owner, writer_owner);
  const durable::durability_request durable_request{payload.at("durable_request_id").get<uint64_t>(), position,
                                                    request.requested_profile};
  return log.barrier(durable_request, service_owner, writer_owner, {request.deadline_at_ns});
}

void verify_reconciled_authority(const std::string &runtime_dir, const nlohmann::json &payload) {
  auto closure = payload.at("content_closure");
  const auto declared_closure_root = required_text(closure, "content_closure_root");
  closure.erase("content_closure_root");
  if (content_root(canonical_json(closure)) != declared_closure_root) {
    throw fact_integrity_error("authority-evidence-corrupt", "fact durable content closure root mismatch");
  }
  const auto state = fold_kernel(runtime_dir);
  const auto operation_id = required_text(payload, "operation_id");
  const auto &journal_pair = payload.at("journal_pair");
  const auto receipt = state.receipts.find(operation_id);
  if (receipt == state.receipts.end() || receipt->second.request_root != payload.value("request_root", std::string{}) ||
      receipt->second.receipt_root != journal_pair.value("receipt_root", std::string{})) {
    throw fact_integrity_error("authority-evidence-corrupt",
                               "checkpoint-covered Fact operation receipt is absent from journal authority");
  }
  const auto expected = payload.at("response").at("result");
  const auto transition = state.transitions.find(expected.at("transition_id").get<std::string>());
  if (transition == state.transitions.end() ||
      transition->second.transition_root != expected.at("transition_root").get<std::string>() ||
      transition->second.new_cut_root != expected.at("current_cut_root").get<std::string>() ||
      transition->second.revision != expected.at("current_revision").get<uint64_t>()) {
    throw fact_integrity_error("authority-evidence-corrupt",
                               "checkpoint-covered Fact ref transition does not match journal authority");
  }
  const auto record = std::find_if(state.authority_records.begin(), state.authority_records.end(),
                                   [&](const kernel_authority_record &candidate) {
                                     return candidate.record_root == journal_pair.value("record_root", std::string{});
                                   });
  if (record == state.authority_records.end() ||
      record->sequence != journal_pair.value("record_sequence", uint64_t{0}) ||
      record->sequence + 1 != journal_pair.value("receipt_sequence", uint64_t{0})) {
    throw fact_integrity_error("authority-evidence-corrupt",
                               "checkpoint-covered Fact record and receipt are not the exact adjacent pair");
  }
  for (const auto &root : payload.at("content_closure").at("metadata_roots")) {
    (void)content_store_get(runtime_dir, METADATA_NAMESPACE, root.get<std::string>());
  }
  for (const auto &root : payload.at("content_closure").at("body_roots")) {
    (void)content_store_get(runtime_dir, BODY_NAMESPACE, root.get<std::string>());
  }
}

} // namespace

nlohmann::json apply_default_durable_ref_cas_admission(const nlohmann::json &input) {
  auto admitted = input;
  if (text_or(admitted, "action") != "ref-cas" || admitted.contains("durability")) {
    return admitted;
  }
  const auto ref_name = text_or(admitted, "ref_name");
  if (!ref_name.starts_with(FACT_DURABLE_PROVENANCE_REF_PREFIX)) {
    return admitted;
  }
  admitted["durability"] = {{"requested_profile", "durable_sync"},
                            {"admission_profile", FACT_DURABLE_ADMISSION_PROFILE}};
  return admitted;
}

void validate_durable_ref_cas_admission(const std::string &runtime_dir, const nlohmann::json &input) {
  (void)prepare_durable_admission(runtime_dir, input);
}

nlohmann::json durably_admit_ref_cas(const std::string &runtime_dir, const nlohmann::json &input,
                                     const nlohmann::json &response) {
  const auto operation_id = response.at("receipt").value("operationId", std::string{});
  const auto request_root = response.at("receipt").value("requestRoot", std::string{});
  try {
    const auto context = prepare_durable_admission(runtime_dir, input);
    const auto &request = context.request;
    const auto &provider = context.provider;
    const auto &evidence = context.evidence;
    if (const auto existing = find_durable_operation(runtime_dir, operation_id); existing.has_value()) {
      const durable::durability_request durable_request{durable_request_id(existing->second, operation_id),
                                                        existing->first.position, request.requested_profile};
      const auto reconciled = durable::reconcile_durable_receipt(durable_options(runtime_dir), durable_request);
      if (reconciled.state != "reconciled" || !reconciled.receipt.has_value() ||
          reconciled.receipt->status != "succeeded") {
        return non_success(response, "unknown", "outcome-unknown",
                           "Fact durable admission remains unknown after checkpoint reconciliation", operation_id,
                           request_root, response.value("write_occurred", false),
                           {{"durability_reconciliation",
                             {{"state", reconciled.state},
                              {"recovered", reconciled.recovered},
                              {"error", reconciled.error},
                              {"message", reconciled.message}}}});
      }
      verify_reconciled_authority(runtime_dir, existing->second);
      auto result = existing->second.at("response");
      result["status"] = "idempotent-durable-replay";
      result["write_occurred"] = false;
      result["durability"] =
          durability_binding(request, provider, evidence, receipt_view_json(*reconciled.receipt),
                             existing->second.at("content_closure"), existing->second.at("journal_pair"));
      result["reconciliation"] = {{"schema", FACT_DURABLE_RECONCILIATION_SCHEMA_V1},
                                  {"state", "reconciled"},
                                  {"operation_id", operation_id},
                                  {"recovered", reconciled.recovered}};
      return result;
    }

    inject_fact_fault(request, "before-journal-sync");
    auto journal_sync = sync_fact_journal(runtime_dir);
    inject_fact_fault(request, "after-journal-sync");
    const auto state = fold_kernel(runtime_dir);
    auto bundle = authority_bundle(runtime_dir, state);
    auto closure = content_closure(runtime_dir, bundle, response);
    const auto record_root = required_text(response.at("result"), "transition_root");
    const auto record =
        std::find_if(state.authority_records.begin(), state.authority_records.end(),
                     [&](const kernel_authority_record &candidate) { return candidate.record_root == record_root; });
    if (record == state.authority_records.end()) {
      throw std::runtime_error("accepted Fact ref transition is absent from journal authority");
    }
    auto journal_pair = nlohmann::json{{"schema", "kungfu.fact.journal-pair-position/v1"},
                                       {"authority", "yijinjing-hana-pod-journal"},
                                       {"record_sequence", record->sequence},
                                       {"receipt_sequence", record->sequence + 1},
                                       {"record_root", record_root},
                                       {"receipt_root", required_text(response, "receipt_root")},
                                       {"operation_id", operation_id},
                                       {"request_root", request_root},
                                       {"adjacent", true},
                                       {"durable_sync", std::move(journal_sync)}};
    auto payload = nlohmann::json{{"schema", FACT_DURABLE_ADMISSION_SCHEMA_V1},
                                  {"operation_id", operation_id},
                                  {"durable_request_id", durable_request_id(operation_id)},
                                  {"request_root", request_root},
                                  {"response", response},
                                  {"authority_bundle", std::move(bundle)},
                                  {"content_closure", closure},
                                  {"journal_pair", std::move(journal_pair)},
                                  {"requested_profile", request.requested_profile_name},
                                  {"admission_profile", FACT_DURABLE_ADMISSION_PROFILE},
                                  {"content_provider", provider},
                                  {"evidence", evidence}};
    auto root_material = payload;
    payload["entry_root"] = content_root(canonical_json(root_material));

    const auto barrier = append_durable_admission(runtime_dir, payload, request);
    if (barrier.receipt.status != durable::receipt_status::Succeeded || !barrier.receipt.achieved_profile.has_value() ||
        *barrier.receipt.achieved_profile != request.requested_profile) {
      const auto status =
          barrier.receipt.status == durable::receipt_status::Failed ? std::string("failed") : std::string("unknown");
      const auto code = barrier.receipt.error == durable::durability_error_code::UnsupportedProfile
                            ? std::string("durability-unqualified")
                            : std::string("outcome-unknown");
      return non_success(response, status, code, "Fact durable admission did not cross its checkpoint frontier",
                         operation_id, request_root, true,
                         {{"durability_receipt", durable::render_durability_receipt(barrier.receipt)},
                          {"ingest_error", durable::ingest_error_name(barrier.error)},
                          {"ingest_message", barrier.message}});
    }
    auto result = response;
    result["durability"] =
        durability_binding(request, provider, evidence, durable::render_durability_receipt(barrier.receipt), closure,
                           payload.at("journal_pair"));
    return result;
  } catch (const fact_integrity_error &error) {
    return non_success(response, "rejected", error.code(), error.what(), operation_id, request_root,
                       response.value("write_occurred", false));
  } catch (const fact_request_error &error) {
    return non_success(response, "rejected", error.code(), error.what(), operation_id, request_root,
                       response.value("write_occurred", false));
  } catch (const std::exception &error) {
    return non_success(response, "unknown", "outcome-unknown", error.what(), operation_id, request_root,
                       response.value("write_occurred", false));
  }
}

nlohmann::json reconcile_durable_ref_cas(const std::string &runtime_dir, const nlohmann::json &input) {
  const std::string action = "durability-reconcile";
  try {
    if (!input.is_object() || input.size() != 2 || text_or(input, "action") != action) {
      return failure(action, "invalid-field", "durability-reconcile accepts only action and operation_id");
    }
    const auto operation_id = required_text(input, "operation_id");
    const auto found = find_durable_operation(runtime_dir, operation_id);
    if (!found.has_value()) {
      auto result =
          failure(action, "outcome-unknown", "operation_id is absent from checkpoint-covered Fact durable evidence");
      result["schema"] = FACT_DURABLE_RECONCILIATION_SCHEMA_V1;
      result["status"] = "unknown";
      result["operation_id"] = operation_id;
      return result;
    }
    const auto profile = durable::parse_durability_profile(found->second.at("requested_profile").get<std::string>());
    const durable::durability_request request{durable_request_id(found->second, operation_id), found->first.position,
                                              profile};
    const auto reconciled = durable::reconcile_durable_receipt(durable_options(runtime_dir), request);
    if (reconciled.state != "reconciled" || !reconciled.receipt.has_value() ||
        reconciled.receipt->status != "succeeded") {
      const auto code = reconciled.error.empty() ? std::string("outcome-unknown") : reconciled.error;
      auto result = failure(action, code, reconciled.message);
      result["schema"] = FACT_DURABLE_RECONCILIATION_SCHEMA_V1;
      result["status"] = reconciled.state;
      result["operation_id"] = operation_id;
      return result;
    }
    verify_reconciled_authority(runtime_dir, found->second);
    requested_durability binding_request;
    binding_request.requested_profile = profile;
    binding_request.requested_profile_name = found->second.at("requested_profile").get<std::string>();
    binding_request.admission_profile = found->second.at("admission_profile").get<std::string>();
    return {{"schema", FACT_DURABLE_RECONCILIATION_SCHEMA_V1},
            {"ok", true},
            {"action", action},
            {"status", "reconciled"},
            {"operation_id", operation_id},
            {"result", found->second.at("response").at("result")},
            {"receipt", found->second.at("response").at("receipt")},
            {"durability", durability_binding(binding_request, found->second.at("content_provider"),
                                              found->second.at("evidence"), receipt_view_json(*reconciled.receipt),
                                              found->second.at("content_closure"), found->second.at("journal_pair"))},
            {"recovered", reconciled.recovered}};
  } catch (const fact_integrity_error &error) {
    return failure(action, error.code(), error.what());
  } catch (const fact_request_error &error) {
    return failure(action, error.code(), error.what());
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
