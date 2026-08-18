// SPDX-License-Identifier: Apache-2.0

#include "fact_actions.h"
#include "fact_kernel_internal.h"

#include <filesystem>
#include <memory>
#include <stdexcept>
#include <type_traits>

#include <kungfu/common.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/io/advisory_file_lock.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/types.h>
#include <kungfu/yijinjing/storage/fact_ledger.h>
#include <kungfu/yijinjing/time.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace fs = std::filesystem;
namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using kungfu::yijinjing::io::advisory_file_lock;
using kungfu::yijinjing::io::advisory_file_lock_error;
using kungfu::yijinjing::io::advisory_file_lock_options;
using kungfu::yijinjing::io::advisory_lock_region;
using kungfu::yijinjing::io::advisory_lock_wait;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace {

template <size_t N> void set_fixed(kungfu::array<char, N> &target, const std::string &value, const char *field) {
  if (value.size() >= N) {
    throw fact_request_error("invalid-field", std::string(field) + " exceeds native record capacity");
  }
  kungfu::copy_string(target, value.c_str());
}

template <typename T> const char *record_domain();
template <> const char *record_domain<FactObjectRecorded>() { return "kungfu.fact.object/v1"; }
template <> const char *record_domain<FactVersionRecorded>() { return "kungfu.fact.version/v1"; }
template <> const char *record_domain<FactRelationAdded>() { return "kungfu.fact.relation-add/v1"; }
template <> const char *record_domain<FactRelationRevoked>() { return "kungfu.fact.relation-revoke/v1"; }
template <> const char *record_domain<FactCutCommitted>() { return "kungfu.fact.cut/v1"; }
template <> const char *record_domain<FactRefTransition>() { return "kungfu.fact.ref-transition/v1"; }

location_ptr kernel_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<yy::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
}

advisory_file_lock acquire_writer_guard(const std::string &path, advisory_lock_wait wait) {
  auto options = advisory_file_lock_options{};
  options.region = advisory_lock_region::byte(0);
  options.wait = wait;
  try {
    return advisory_file_lock(path, options);
  } catch (const advisory_file_lock_error &error) {
    throw std::runtime_error(error.operation() == kungfu::yijinjing::io::advisory_lock_operation::open
                                 ? "fact_kernel_writer_guard_open_failed"
                                 : "fact_kernel_writer_busy");
  }
}

std::string writer_lock_path(const std::string &runtime_dir) {
  const auto target = kernel_location(runtime_dir);
  return (fs::path(target->locator->layout_dir(target, layout::JOURNAL, true)) / "writer.lock").string();
}

std::string request_id(const std::string &request_root) {
  return "op:" + request_root.substr(std::string("sha256:").size(), 32);
}

template <typename T>
nlohmann::json append_record_with_receipt(const std::string &runtime_dir, kernel_state &state,
                                          const std::string &action, const std::string &operation_id,
                                          const std::string &request_root, const std::string &record_root,
                                          const mutation_result &result, T record, const std::string &root_protocol) {
  const auto record_schema_version =
      root_protocol == LEGACY_ROOT_PROTOCOL ? LEGACY_RECORD_SCHEMA_VERSION : PORTABLE_RECORD_SCHEMA_VERSION;
  record.schema_version = record_schema_version;
  record.sequence = state.next_sequence++;
  operation_receipt typed_receipt;
  typed_receipt.operation_id = operation_id;
  typed_receipt.operation = action;
  typed_receipt.status = "accepted";
  typed_receipt.request_root = request_root;
  typed_receipt.record_root = record_root;
  typed_receipt.write_occurred = true;
  typed_receipt.result = result;
  if (const auto *ref = std::get_if<ref_cas_result>(&result)) {
    typed_receipt.prior_cut_root = ref->prior_cut_root;
    typed_receipt.current_cut_root = ref->current_cut_root;
    typed_receipt.prior_revision = ref->prior_revision;
    typed_receipt.current_revision = ref->current_revision;
  }
  auto receipt_document = operation_receipt_json(typed_receipt);
  const auto receipt_root =
      store_metadata(runtime_dir, "kungfu.fact.operation-receipt/v1", receipt_document, root_protocol);
  const auto document = load_metadata(runtime_dir, record_root, record_domain<T>());
  const auto successor_root = root_protocol == PORTABLE_ROOT_PROTOCOL
                                  ? record_root
                                  : metadata_root(record_domain<T>(), document, PORTABLE_ROOT_PROTOCOL);
  const auto mapping = root_mapping_receipt(record_domain<T>(), document, successor_root, request_root);
  const auto mapping_root = store_metadata(runtime_dir, "kungfu.fact.root-mapping-receipt/v1", mapping);
  FactOperationReceipt receipt{};
  receipt.schema_version = record_schema_version;
  receipt.sequence = state.next_sequence++;
  receipt.write_occurred = 1;
  set_fixed(receipt.operation_id, operation_id, "operation_id");
  set_fixed(receipt.operation, action, "operation");
  set_fixed(receipt.status, "accepted", "status");
  set_fixed(receipt.record_root, record_root, "record_root");
  set_fixed(receipt.request_root, request_root, "request_root");
  set_fixed(receipt.receipt_root, receipt_root, "receipt_root");
  if (action == "ref-cas") {
    receipt.prior_revision = typed_receipt.prior_revision;
    receipt.current_revision = typed_receipt.current_revision;
    set_fixed(receipt.prior_cut_root, typed_receipt.prior_cut_root, "prior_cut_root");
    set_fixed(receipt.current_cut_root, typed_receipt.current_cut_root, "current_cut_root");
  }
  const auto authority_record = yy::storage::fact_record(record);
  if (authority_record.record_root != record_root)
    throw std::invalid_argument("fact-record-root-mismatch");
  yy::storage::fact_ledger_store(runtime_dir).append(authority_record, receipt);
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", true},
          {"action", action},
          {"status", "accepted"},
          {"write_occurred", true},
          {"result", mutation_result_json(result)},
          {"receipt", receipt_document},
          {"receipt_root", receipt_root},
          {"writer_protocol", root_protocol},
          {"root_mapping_receipt", mapping},
          {"root_mapping_receipt_root", mapping_root}};
}

nlohmann::json serialize_failure(const std::string &action, const action_failure &rejection) {
  return failure(action, rejection.code, rejection.message, rejection.details);
}

nlohmann::json import_interrupted(const std::string &runtime_dir, const kernel_state &before,
                                  const std::set<std::string> &expected_existing_roots,
                                  const nlohmann::json &completed_responses,
                                  const nlohmann::json &committed_prefix_record_roots, size_t next_operation_index,
                                  size_t operation_count, const mutation_batch_options &options,
                                  const std::string &fault_mode, const nlohmann::json &backend_response) {
  const auto after = fold_kernel(runtime_dir);
  auto observed_record_roots = nlohmann::json::array();
  for (const auto &record : after.authority_records) {
    observed_record_roots.push_back(record.record_root);
  }
  const auto write_occurred = !committed_prefix_record_roots.empty() || after.next_sequence != before.next_sequence ||
                              after.unknown_records != before.unknown_records;
  const auto recovery = after.issues.empty() ? "restart-and-retry-same-bundle" : "preserve-authority-and-run-fsck";
  auto receipt = nlohmann::json{{"schema", "kungfu.fact-authority-import-interruption/v1"},
                                {"authority", "fold-observation"},
                                {"bundleRoot", options.bundle_root},
                                {"status", "interrupted"},
                                {"faultMode", fault_mode},
                                {"writeOccurred", write_occurred},
                                {"preexistingRecordRoots", expected_existing_roots},
                                {"committedPrefixRecordRoots", committed_prefix_record_roots},
                                {"observedRecordRoots", observed_record_roots},
                                {"completedOperationCount", committed_prefix_record_roots.size()},
                                {"nextOperationIndex", next_operation_index},
                                {"remainingOperationCount", operation_count - next_operation_index},
                                {"foldIssues", fold_issues_json(after.issues)},
                                {"recovery", recovery}};
  const auto receipt_root = content_root(canonical_json(receipt));
  receipt["receiptRoot"] = receipt_root;
  const auto failure_code = write_occurred ? "import-interrupted" : "backend-failure";
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", false},
          {"action", "authority-import"},
          {"status", "interrupted"},
          {"failure_code", failure_code},
          {"failure_category", failure_category_for(failure_code)},
          {"message", "Fact authority import stopped at a logical append boundary"},
          {"details",
           {{"fault_mode", fault_mode},
            {"next_operation_index", next_operation_index},
            {"completed_operation_count", committed_prefix_record_roots.size()},
            {"remaining_operation_count", operation_count - next_operation_index},
            {"preexisting_record_roots", expected_existing_roots},
            {"committed_prefix_record_roots", committed_prefix_record_roots},
            {"observed_record_roots", observed_record_roots},
            {"completed_responses", completed_responses},
            {"backend_response", backend_response},
            {"recovery", recovery}}},
          {"write_occurred", write_occurred},
          {"receipt", receipt},
          {"receipt_root", receipt_root}};
}

nlohmann::json execute_mutation_under_guard(const std::string &runtime_dir, const nlohmann::json &input,
                                            const std::string &root_protocol) {
  const auto requested_action = text_or(input, "action", "capabilities");
  try {
    const auto admitted_input = apply_default_durable_ref_cas_admission(input);
    reject_environment_identity(admitted_input);
    auto parsed = parse_mutation_request(admitted_input, requested_action);
    if (const auto *rejection = std::get_if<action_failure>(&parsed)) {
      return serialize_failure(requested_action, *rejection);
    }
    auto request = std::get<mutation_request>(std::move(parsed));
    const auto action = action_name(request);
    if (action == "ref-cas" && admitted_input.contains("durability")) {
      validate_durable_ref_cas_admission(runtime_dir, admitted_input);
    }
    auto state = fold_kernel(runtime_dir);
    if (state.unknown_records != 0) {
      return failure(action, "destination-diverged", "Fact writer refuses an authority it cannot fully read",
                     {{"unknown_records", state.unknown_records}, {"issues", fold_issues_json(state.issues)}});
    }
    // Request identity is committed by the receipt. Rejected requests do not
    // materialize an orphan content-store object or append a journal frame.
    const auto request_root = metadata_root("fact-operation-request/v1", admitted_input, root_protocol);
    const auto operation_id = request_id(request_root);
    const auto replay = state.receipts.find(operation_id);
    if (replay != state.receipts.end()) {
      if (replay->second.request_root != request_root) {
        return failure(action, "transition-id-reused", "operation_id was reused for different bytes",
                       {{"operation_id", operation_id}});
      }
      auto response = nlohmann::json{{"schema", FACT_KERNEL_SCHEMA_V1},
                                     {"ok", true},
                                     {"action", action},
                                     {"status", "idempotent-replay"},
                                     {"write_occurred", false},
                                     {"result", {{"record_root", replay->second.record_root}}},
                                     {"receipt", operation_receipt_json(replay->second)}};
      if (action == "ref-cas" && admitted_input.contains("durability")) {
        const auto transition_id = required_text(admitted_input, "transition_id");
        const auto transition = state.transitions.find(transition_id);
        if (transition == state.transitions.end()) {
          return failure(action, "backend-failure", "accepted ref transition is missing during durable replay");
        }
        response["result"] = {{"transition_id", transition->second.transition_id},
                              {"transition_root", transition->second.transition_root},
                              {"ref_name", transition->second.ref_name},
                              {"prior_cut_root", transition->second.expected_old_cut_root},
                              {"current_cut_root", transition->second.new_cut_root},
                              {"prior_revision", transition->second.expected_old_revision},
                              {"current_revision", transition->second.revision}};
        return durably_admit_ref_cas(runtime_dir, admitted_input, response);
      }
      return response;
    }

    auto outcome = handle_mutation(runtime_dir, state, request, root_protocol);
    if (const auto *rejection = std::get_if<action_failure>(&outcome)) {
      return serialize_failure(action, *rejection);
    }
    if (const auto *noop = std::get_if<mutation_noop>(&outcome)) {
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", noop->status},
              {"write_occurred", false},
              {"result", result_json(noop->result)},
              {"receipt", nullptr}};
    }
    const auto &commit = std::get<mutation_commit>(outcome);
    const auto result = result_json(commit.result);
    auto response = std::visit(
        [&](const auto &record) {
          return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, commit.record_root,
                                            commit.result, record, root_protocol);
        },
        commit.record);
    if (action == "ref-cas" && admitted_input.contains("durability")) {
      return durably_admit_ref_cas(runtime_dir, admitted_input, response);
    }
    return response;
  } catch (const fact_request_error &error) {
    return failure(requested_action, error.code(), error.what());
  } catch (const std::invalid_argument &error) {
    return failure(requested_action, "invalid-request", error.what());
  } catch (const std::exception &error) {
    return failure(requested_action, "backend-failure", error.what());
  }
}

} // namespace

std::string response_record_root(const std::string &action, const nlohmann::json &response) {
  if (!response.is_object() || !response.value("ok", false)) {
    return {};
  }
  const auto result = response.value("result", nlohmann::json::object());
  static const std::map<std::string, std::string> fields = {
      {"object-put", "object_root"},      {"version-put", "version_root"}, {"relation-add", "relation_root"},
      {"relation-revoke", "revoke_root"}, {"cut-put", "cut_root"},         {"ref-cas", "transition_root"}};
  const auto field = fields.find(action);
  return field == fields.end() ? std::string{} : result.value(field->second, std::string{});
}

nlohmann::json execute_mutation(const std::string &runtime_dir, const nlohmann::json &input) {
  return execute_mutation_with_protocol(runtime_dir, input, WRITER_ROOT_PROTOCOL);
}

nlohmann::json execute_mutation_with_protocol(const std::string &runtime_dir, const nlohmann::json &input,
                                              const std::string &root_protocol) {
  const auto action = text_or(input, "action", "capabilities");
  try {
    if (root_protocol != LEGACY_ROOT_PROTOCOL && root_protocol != PORTABLE_ROOT_PROTOCOL)
      return failure(action, "unsupported-version", "Fact writer protocol is unsupported",
                     {{"root_protocol", root_protocol}});
    // Exact expected-old CAS contenders must observe the winner's committed
    // state so they deterministically reject as stale instead of leaking lock
    // scheduling as a backend-failure. Other mutation actions retain their
    // existing fail-fast contention behavior.
    const auto wait = action == "ref-cas" ? advisory_lock_wait::blocking : advisory_lock_wait::non_blocking;
    const auto guard = acquire_writer_guard(writer_lock_path(runtime_dir), wait);
    return execute_mutation_under_guard(runtime_dir, input, root_protocol);
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

nlohmann::json execute_mutation_batch(const std::string &runtime_dir, const nlohmann::json &operations,
                                      const std::set<std::string> &expected_existing_roots,
                                      const mutation_batch_options &options) {
  try {
    const auto guard = acquire_writer_guard(writer_lock_path(runtime_dir), advisory_lock_wait::non_blocking);
    const auto before = fold_kernel(runtime_dir);
    std::set<std::string> actual_existing_roots;
    for (const auto &record : before.authority_records) {
      actual_existing_roots.insert(record.record_root);
    }
    if (before.unknown_records != 0 || actual_existing_roots != expected_existing_roots) {
      return failure("authority-import", "destination-drift",
                     "Destination Fact authority changed after import preflight",
                     {{"expected_record_roots", expected_existing_roots},
                      {"actual_record_roots", actual_existing_roots},
                      {"unknown_records", before.unknown_records}});
    }

    auto responses = nlohmann::json::array();
    auto committed_prefix_record_roots = nlohmann::json::array();
    bool write_occurred = false;
    for (size_t index = 0; index < operations.size(); ++index) {
      if (options.inject_import_failure && index == options.fail_after_logical_appends) {
        return import_interrupted(runtime_dir, before, expected_existing_roots, responses,
                                  committed_prefix_record_roots, index, operations.size(), options,
                                  "qualification-logical-append-boundary",
                                  {{"schema", "kungfu.fact-authority-import-fault/v1"},
                                   {"injected", true},
                                   {"fail_after_logical_appends", options.fail_after_logical_appends}});
      }
      const auto &operation = operations.at(index);
      const auto action = operation.at("action").get<std::string>();
      const auto expected_root = operation.at("recordRoot").get<std::string>();
      const auto root_protocol = operation.value("rootProtocol", std::string(WRITER_ROOT_PROTOCOL));
      auto response = execute_mutation_under_guard(runtime_dir, operation.at("request"), root_protocol);
      write_occurred = write_occurred || response.value("write_occurred", false);
      const auto actual_root = response_record_root(action, response);
      if (!response.value("ok", false) && response.value("failure_category", std::string{}) == "backend-failure") {
        return import_interrupted(runtime_dir, before, expected_existing_roots, responses,
                                  committed_prefix_record_roots, index, operations.size(), options, "backend-response",
                                  response);
      }
      if (!response.value("ok", false) || actual_root != expected_root) {
        auto result = failure("authority-import", "import-operation-mismatch",
                              "Fact authority import did not reproduce the declared record root",
                              {{"index", index},
                               {"operation", action},
                               {"expected_record_root", expected_root},
                               {"actual_record_root", actual_root},
                               {"kernel_response", response},
                               {"completed_responses", responses}});
        result["write_occurred"] = write_occurred;
        return result;
      }
      responses.push_back(response);
      committed_prefix_record_roots.push_back(expected_root);
    }

    const auto after = fold_kernel(runtime_dir);
    std::set<std::string> final_roots;
    for (const auto &record : after.authority_records) {
      final_roots.insert(record.record_root);
    }
    return {{"ok", true},
            {"responses", std::move(responses)},
            {"write_occurred", write_occurred},
            {"record_roots", final_roots},
            {"refs", fact_refs_json(after.refs)},
            {"counts",
             {{"objects", after.objects.size()},
              {"versions", after.versions.size()},
              {"relations", after.relations.size()},
              {"revocations", after.revocations.size()},
              {"cuts", after.cuts.size()},
              {"transitions", after.transitions.size()}}}};
  } catch (const std::exception &error) {
    return failure("authority-import", "backend-failure", error.what());
  }
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
