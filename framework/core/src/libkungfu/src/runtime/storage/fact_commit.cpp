// SPDX-License-Identifier: Apache-2.0

#include "fact_kernel_internal.h"

#include <algorithm>
#include <filesystem>
#include <memory>
#include <stdexcept>

#include <kungfu/common.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>
#include <kungfu/yijinjing/common.h>
#include <kungfu/yijinjing/journal/journal.h>
#include <kungfu/yijinjing/schema/types.h>
#include <kungfu/yijinjing/time.h>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

namespace fs = std::filesystem;
namespace yy = kungfu::yijinjing;
using namespace kungfu::yijinjing::data;
using namespace kungfu::yijinjing::enums;
using namespace kungfu::yijinjing::journal;
using namespace kungfu::yijinjing::types;

namespace {
template <size_t N> void set_fixed(kungfu::array<char, N> &target, const std::string &value, const char *field) {
  if (value.size() >= N)
    throw std::invalid_argument(std::string(field) + " exceeds native record capacity");
  kungfu::copy_string(target, value.c_str());
}
location_ptr kernel_location(const std::string &runtime_dir) {
  auto locator = std::make_shared<yy::data::locator>(runtime_dir, mode::LIVE);
  return location::make_shared(mode::LIVE, location_role::SYSTEM, JOURNAL_NAMESPACE, JOURNAL_NAME, locator);
}
writer make_writer(const std::string &runtime_dir) {
  return writer(kernel_location(runtime_dir), location::PUBLIC, std::make_shared<noop_publisher>(), false,
                std::make_shared<bus>(false));
}

class writer_guard {
public:
  explicit writer_guard(const std::string &path) : path_(path) {
#ifdef _WIN32
    handle_ = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                          OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) {
      throw std::runtime_error("fact_kernel_writer_guard_open_failed");
    }
    OVERLAPPED overlap{};
    if (!LockFileEx(handle_, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlap)) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw std::runtime_error("fact_kernel_writer_busy");
    }
#else
    fd_ = ::open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0644);
    if (fd_ < 0) {
      throw std::runtime_error("fact_kernel_writer_guard_open_failed");
    }
    if (::flock(fd_, LOCK_EX | LOCK_NB) != 0) {
      ::close(fd_);
      fd_ = -1;
      throw std::runtime_error("fact_kernel_writer_busy");
    }
#endif
  }
  writer_guard(const writer_guard &) = delete;
  writer_guard &operator=(const writer_guard &) = delete;
  ~writer_guard() {
#ifdef _WIN32
    if (handle_ != INVALID_HANDLE_VALUE) {
      OVERLAPPED overlap{};
      UnlockFileEx(handle_, 0, 1, 0, &overlap);
      CloseHandle(handle_);
    }
#else
    if (fd_ >= 0) {
      ::flock(fd_, LOCK_UN);
      ::close(fd_);
    }
#endif
  }

private:
  std::string path_;
#ifdef _WIN32
  HANDLE handle_ = INVALID_HANDLE_VALUE;
#else
  int fd_ = -1;
#endif
};

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
                                          const nlohmann::json &result, T record) {
  record.schema_version = SCHEMA_VERSION;
  record.sequence = state.next_sequence++;
  auto receipt_document = nlohmann::json{{"schema", "kungfu.fact.operation-receipt/v1"},
                                         {"operationId", operation_id},
                                         {"operation", action},
                                         {"status", "accepted"},
                                         {"failureCode", nullptr},
                                         {"requestRoot", request_root},
                                         {"recordRoot", record_root},
                                         {"priorCutRoot", result.value("prior_cut_root", std::string{})},
                                         {"currentCutRoot", result.value("current_cut_root", std::string{})},
                                         {"priorRevision", result.value("prior_revision", uint64_t{0})},
                                         {"currentRevision", result.value("current_revision", uint64_t{0})},
                                         {"writeOccurred", true},
                                         {"result", result}};
  const auto receipt_root = store_metadata(runtime_dir, "kungfu.fact.operation-receipt/v1", receipt_document);
  FactOperationReceipt receipt{};
  receipt.schema_version = SCHEMA_VERSION;
  receipt.sequence = state.next_sequence++;
  receipt.write_occurred = 1;
  set_fixed(receipt.operation_id, operation_id, "operation_id");
  set_fixed(receipt.operation, action, "operation");
  set_fixed(receipt.status, "accepted", "status");
  set_fixed(receipt.record_root, record_root, "record_root");
  set_fixed(receipt.request_root, request_root, "request_root");
  set_fixed(receipt.receipt_root, receipt_root, "receipt_root");
  if (action == "ref-cas") {
    receipt.prior_revision = result.value("prior_revision", uint64_t{0});
    receipt.current_revision = result.value("current_revision", uint64_t{0});
    set_fixed(receipt.prior_cut_root, result.value("prior_cut_root", std::string{}), "prior_cut_root");
    set_fixed(receipt.current_cut_root, result.value("current_cut_root", std::string{}), "current_cut_root");
  }
  auto output = make_writer(runtime_dir);
  output.write_at(yy::time::now_in_nano(), 0, record);
  output.write_at(yy::time::now_in_nano(), 0, receipt);
  return {{"schema", FACT_KERNEL_SCHEMA_V1},
          {"ok", true},
          {"action", action},
          {"status", "accepted"},
          {"write_occurred", true},
          {"result", result},
          {"receipt", receipt_document},
          {"receipt_root", receipt_root}};
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

namespace {

nlohmann::json execute_mutation_under_guard(const std::string &runtime_dir, const nlohmann::json &input) {
  const auto action = text_or(input, "action", "capabilities");
  try {
    reject_environment_identity(input);
    auto state = fold_kernel(runtime_dir);
    // Request identity is committed by the receipt. Rejected requests do not
    // materialize an orphan content-store object or append a journal frame.
    const auto request_root = metadata_root("fact-operation-request/v1", input);
    const auto operation_id = request_id(request_root);
    const auto replay = state.receipts.find(operation_id);
    if (replay != state.receipts.end()) {
      if (replay->second.value("requestRoot", std::string{}) != request_root) {
        return failure(action, "transition-id-reused", "operation_id was reused for different bytes",
                       {{"operation_id", operation_id}});
      }
      return {{"schema", FACT_KERNEL_SCHEMA_V1},
              {"ok", true},
              {"action", action},
              {"status", "idempotent-replay"},
              {"write_occurred", false},
              {"result", {{"record_root", replay->second.value("recordRoot", std::string{})}}},
              {"receipt", replay->second}};
    }

    if (action == "object-put") {
      const auto object_id = required_text(input, "object_id");
      validate_fact_id(object_id, "object_id");
      const auto object_type = required_text(input, "object_type");
      const auto created_by = required_text(input, "created_by_receipt_root");
      validate_root(created_by, "created_by_receipt_root");
      const nlohmann::json document = {{"schema", "kungfu.fact.object/v1"},
                                       {"objectId", object_id},
                                       {"objectType", object_type},
                                       {"createdByReceiptRoot", created_by}};
      const auto object_root = metadata_root("kungfu.fact.object/v1", document);
      const auto existing = state.objects.find(object_id);
      if (existing != state.objects.end()) {
        const auto existing_root = metadata_root("kungfu.fact.object/v1", existing->second);
        if (existing_root != object_root) {
          return failure(action, "invalid-identity", "object_id already names different immutable metadata",
                         {{"object_id", object_id}, {"existing_root", existing_root}, {"requested_root", object_root}});
        }
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"object_id", object_id}, {"object_root", object_root}}},
                {"receipt", nullptr}};
      }
      FactObjectRecorded record{};
      set_fixed(record.object_id, object_id, "object_id");
      set_fixed(record.object_type, object_type, "object_type");
      set_fixed(record.created_by_receipt_root, created_by, "created_by_receipt_root");
      set_fixed(record.object_root, object_root, "object_root");
      if (store_metadata(runtime_dir, "kungfu.fact.object/v1", document) != object_root) {
        throw std::runtime_error("fact object root changed during admission");
      }
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, object_root,
                                        {{"object_id", object_id}, {"object_root", object_root}}, record);
    }

    if (action == "version-put") {
      const auto object_id = required_text(input, "object_id");
      validate_fact_id(object_id, "object_id");
      if (state.objects.count(object_id) == 0) {
        return failure(action, "unknown-object", "version object does not exist", {{"object_id", object_id}});
      }
      if (!input.contains("body") || !input.at("body").is_string()) {
        return failure(action, "body-missing", "body must be an opaque string");
      }
      const auto body = input.at("body").get<std::string>();
      const auto body_root = content_root(body);
      const auto schema_root = required_text(input, "schema_root");
      validate_root(schema_root, "schema_root");
      const auto parents = normalized_roots(input, "parent_version_roots");
      const auto declarations = normalized_roots(input, "declaration_roots");
      const auto admissions = normalized_roots(input, "admission_roots");
      if (declarations.empty() || admissions.empty()) {
        return failure(action, "admission-missing", "version requires exact declaration and admission support");
      }
      for (const auto &parent : parents) {
        if (state.versions.count(parent) == 0) {
          return failure(action, "unknown-version", "parent version is unavailable", {{"version_root", parent}});
        }
      }
      const auto stored = content_store_put_if_absent(runtime_dir, BODY_NAMESPACE, body, body_root);
      if (!stored.value("ok", false)) {
        throw std::runtime_error("fact body store failed");
      }
      const auto parents_root = store_root_set(runtime_dir, "fact-version-parents/v1", parents);
      const auto declarations_root = store_root_set(runtime_dir, "fact-declaration-roots/v1", declarations);
      const auto admissions_root = store_root_set(runtime_dir, "fact-admission-roots/v1", admissions);
      const nlohmann::json document = {{"schema", "kungfu.fact.version/v1"},
                                       {"objectId", object_id},
                                       {"bodyRoot", body_root},
                                       {"schemaRoot", schema_root},
                                       {"parentVersionRoots", root_array(parents)},
                                       {"declarationRoots", root_array(declarations)},
                                       {"admissionRoots", root_array(admissions)}};
      const auto version_root = store_metadata(runtime_dir, "kungfu.fact.version/v1", document);
      if (state.versions.count(version_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"object_id", object_id}, {"version_root", version_root}, {"body_root", body_root}}},
                {"receipt", nullptr}};
      }
      FactVersionRecorded record{};
      set_fixed(record.object_id, object_id, "object_id");
      set_fixed(record.version_root, version_root, "version_root");
      set_fixed(record.body_root, body_root, "body_root");
      set_fixed(record.schema_root, schema_root, "schema_root");
      set_fixed(record.parent_versions_root, parents_root, "parent_versions_root");
      set_fixed(record.declaration_roots_root, declarations_root, "declaration_roots_root");
      set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
      return append_record_with_receipt(
          runtime_dir, state, action, operation_id, request_root, version_root,
          {{"object_id", object_id}, {"version_root", version_root}, {"body_root", body_root}}, record);
    }

    if (action == "relation-add") {
      const auto relation_id = required_text(input, "relation_id");
      validate_fact_id(relation_id, "relation_id");
      const auto relation_type = required_text(input, "relation_type");
      if (!input.contains("source") || !input.at("source").is_object() || !input.contains("target") ||
          !input.at("target").is_object()) {
        throw std::invalid_argument("source and target endpoint objects are required");
      }
      const auto source_kind = required_text(input.at("source"), "kind");
      const auto source_id = required_text(input.at("source"), "id");
      const auto target_kind = required_text(input.at("target"), "kind");
      const auto target_id = required_text(input.at("target"), "id");
      const auto attributes_root = required_text(input, "attributes_root");
      validate_root(attributes_root, "attributes_root");
      const auto admissions = normalized_roots(input, "admission_roots");
      if (admissions.empty()) {
        return failure(action, "admission-missing", "relation requires exact admission support");
      }
      const auto endpoint_is_valid = [&state](const std::string &kind, const std::string &id,
                                              const nlohmann::json &endpoint) {
        if (kind == "logical-object") {
          return state.objects.count(id) != 0;
        }
        if (kind == "pinned-version") {
          return state.versions.count(id) != 0;
        }
        if (kind == "external-identity-with-mapping-receipt") {
          const auto mapping = text_or(endpoint, "mapping_receipt_root");
          try {
            validate_root(mapping, "mapping_receipt_root");
            return true;
          } catch (const std::invalid_argument &) {
            return false;
          }
        }
        return false;
      };
      if (!endpoint_is_valid(source_kind, source_id, input.at("source")) ||
          !endpoint_is_valid(target_kind, target_id, input.at("target"))) {
        return failure(action, "relation-endpoint-invalid", "relation endpoint is absent or not explicitly external");
      }
      const auto canonical_endpoint = [](const nlohmann::json &endpoint, const std::string &kind,
                                         const std::string &id) {
        const auto external = kind == "external-identity-with-mapping-receipt";
        const std::set<std::string> allowed = external ? std::set<std::string>{"kind", "id", "mapping_receipt_root"}
                                                       : std::set<std::string>{"kind", "id"};
        for (const auto &[key, unused] : endpoint.items()) {
          (void)unused;
          if (allowed.count(key) == 0) {
            throw std::invalid_argument("relation endpoint contains unknown field: " + key);
          }
        }
        auto result = nlohmann::json{{"kind", kind}, {"id", id}};
        if (external) {
          result["mapping_receipt_root"] = endpoint.at("mapping_receipt_root");
        }
        return result;
      };
      nlohmann::json source;
      nlohmann::json target;
      try {
        source = canonical_endpoint(input.at("source"), source_kind, source_id);
        target = canonical_endpoint(input.at("target"), target_kind, target_id);
      } catch (const std::invalid_argument &error) {
        return failure(action, "relation-endpoint-invalid", error.what());
      }
      const auto admissions_root = store_root_set(runtime_dir, "fact-admission-roots/v1", admissions);
      const nlohmann::json document = {{"schema", "kungfu.fact.relation-add/v1"},
                                       {"relationId", relation_id},
                                       {"relationType", relation_type},
                                       {"source", source},
                                       {"target", target},
                                       {"attributesRoot", attributes_root},
                                       {"admissionRoots", root_array(admissions)}};
      const auto relation_root = metadata_root("kungfu.fact.relation-add/v1", document);
      if (state.relations.count(relation_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"relation_id", relation_id}, {"relation_root", relation_root}}},
                {"receipt", nullptr}};
      }
      for (const auto &[root, relation] : state.relations) {
        if (relation.value("relationId", std::string{}) == relation_id && root != relation_root) {
          return failure(action, "invalid-identity", "relation_id already names different immutable metadata");
        }
      }
      FactRelationAdded record{};
      set_fixed(record.relation_id, relation_id, "relation_id");
      set_fixed(record.relation_type, relation_type, "relation_type");
      set_fixed(record.source_kind, source_kind, "source.kind");
      set_fixed(record.source_id, source_id, "source.id");
      set_fixed(record.target_kind, target_kind, "target.kind");
      set_fixed(record.target_id, target_id, "target.id");
      set_fixed(record.attributes_root, attributes_root, "attributes_root");
      set_fixed(record.admission_roots_root, admissions_root, "admission_roots_root");
      set_fixed(record.relation_root, relation_root, "relation_root");
      if (store_metadata(runtime_dir, "kungfu.fact.relation-add/v1", document) != relation_root) {
        throw std::runtime_error("fact relation root changed during admission");
      }
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, relation_root,
                                        {{"relation_id", relation_id}, {"relation_root", relation_root}}, record);
    }

    if (action == "relation-revoke") {
      const auto relation_root = required_text(input, "relation_root");
      const auto reason_root = required_text(input, "reason_root");
      validate_root(relation_root, "relation_root");
      validate_root(reason_root, "reason_root");
      if (state.relations.count(relation_root) == 0) {
        return failure(action, "unknown-relation", "relation root does not exist");
      }
      if (state.revoked_relations.count(relation_root) != 0) {
        return failure(action, "relation-already-revoked", "relation has already been revoked");
      }
      const nlohmann::json document = {
          {"schema", "kungfu.fact.relation-revoke/v1"}, {"relationRoot", relation_root}, {"reasonRoot", reason_root}};
      const auto revoke_root = store_metadata(runtime_dir, "kungfu.fact.relation-revoke/v1", document);
      FactRelationRevoked record{};
      set_fixed(record.relation_root, relation_root, "relation_root");
      set_fixed(record.reason_root, reason_root, "reason_root");
      set_fixed(record.revoke_root, revoke_root, "revoke_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, revoke_root,
                                        {{"relation_root", relation_root}, {"revoke_root", revoke_root}}, record);
    }

    if (action == "cut-put") {
      const auto parents = normalized_roots(input, "parent_cut_roots");
      const auto relations = normalized_roots(input, "active_relation_roots");
      const auto declarations = normalized_roots(input, "declaration_roots");
      const auto admissions = normalized_roots(input, "admission_roots");
      const auto omissions = normalized_roots(input, "omission_roots");
      const auto conflicts = normalized_roots(input, "conflict_roots");
      auto input_object_versions = array_or_empty(input, "object_versions");
      std::sort(input_object_versions.begin(), input_object_versions.end(), [](const auto &left, const auto &right) {
        return std::pair(left.value("object_id", std::string{}), left.value("version_root", std::string{})) <
               std::pair(right.value("object_id", std::string{}), right.value("version_root", std::string{}));
      });
      std::set<std::string> object_ids;
      auto object_versions = nlohmann::json::array();
      for (const auto &member : input_object_versions) {
        const auto object_id = required_text(member, "object_id");
        const auto version_root = required_text(member, "version_root");
        validate_fact_id(object_id, "object_versions.object_id");
        validate_root(version_root, "object_versions.version_root");
        if (!object_ids.insert(object_id).second) {
          throw std::invalid_argument("object_versions contains duplicate object_id");
        }
        const auto version = state.versions.find(version_root);
        if (version == state.versions.end() || version->second.value("objectId", std::string{}) != object_id) {
          return failure(action, "unknown-version", "cut member version is not admitted for object",
                         {{"object_id", object_id}, {"version_root", version_root}});
        }
        object_versions.push_back({object_id, version_root});
      }
      for (const auto &root : relations) {
        if (state.relations.count(root) == 0 || state.revoked_relations.count(root) != 0) {
          return failure(action, "unknown-relation", "cut relation is missing or revoked", {{"relation_root", root}});
        }
      }
      const auto input_frontier = array_or_empty(input, "episode_frontier");
      std::vector<std::tuple<uint64_t, std::string, std::string>> frontier_entries;
      std::set<uint64_t> episode_ids;
      for (const auto &entry : input_frontier) {
        if (!entry.is_object() || !entry.contains("episode_id") ||
            !(entry.at("episode_id").is_number_unsigned() ||
              (entry.at("episode_id").is_number_integer() && entry.at("episode_id").get<int64_t>() >= 0))) {
          return failure(action, "invalid-cut", "episode_frontier.episode_id must be an unsigned 64-bit integer");
        }
        const auto episode_id = uint64_or(entry, "episode_id");
        const auto sealed_root = required_text(entry, "sealed_content_root");
        const auto manifest_uid = required_text(entry, "accepted_manifest_frame_uid");
        validate_root(sealed_root, "episode_frontier.sealed_content_root");
        if (!episode_ids.insert(episode_id).second) {
          return failure(action, "invalid-cut", "episode_frontier contains duplicate episode_id");
        }
        frontier_entries.emplace_back(episode_id, sealed_root, manifest_uid);
      }
      std::sort(frontier_entries.begin(), frontier_entries.end());
      auto frontier = nlohmann::json::array();
      for (const auto &[episode_id, sealed_root, manifest_uid] : frontier_entries) {
        frontier.push_back({episode_id, sealed_root, manifest_uid});
      }
      for (const auto &root : parents) {
        if (state.cuts.count(root) == 0) {
          return failure(action, "unknown-cut", "parent cut is unavailable", {{"parent_cut_root", root}});
        }
      }
      const nlohmann::json document = {{"schema", "kungfu.fact.cut/v1"},
                                       {"parentCutRoots", root_array(parents)},
                                       {"objectVersions", object_versions},
                                       {"activeRelationRoots", root_array(relations)},
                                       {"declarationRoots", root_array(declarations)},
                                       {"admissionRoots", root_array(admissions)},
                                       {"episodeFrontier", frontier},
                                       {"omissionRoots", root_array(omissions)},
                                       {"conflictRoots", root_array(conflicts)}};
      const auto cut_root = store_metadata(runtime_dir, "kungfu.fact.cut/v1", document);
      if (state.cuts.count(cut_root) != 0) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent"},
                {"write_occurred", false},
                {"result", {{"cut_root", cut_root}}},
                {"receipt", nullptr}};
      }
      FactCutCommitted record{};
      set_fixed(record.cut_root, cut_root, "cut_root");
      set_fixed(record.parent_cuts_root, store_root_set(runtime_dir, "fact-parent-cuts/v1", parents),
                "parent_cuts_root");
      set_fixed(record.object_versions_root, store_metadata(runtime_dir, "fact-object-versions/v1", object_versions),
                "object_versions_root");
      set_fixed(record.active_relations_root, store_root_set(runtime_dir, "fact-active-relations/v1", relations),
                "active_relations_root");
      set_fixed(record.declaration_roots_root, store_root_set(runtime_dir, "fact-declaration-roots/v1", declarations),
                "declaration_roots_root");
      set_fixed(record.admission_roots_root, store_root_set(runtime_dir, "fact-admission-roots/v1", admissions),
                "admission_roots_root");
      set_fixed(record.episode_frontier_root, store_metadata(runtime_dir, "fact-episode-frontier/v1", frontier),
                "episode_frontier_root");
      set_fixed(record.omission_roots_root, store_root_set(runtime_dir, "fact-omission-roots/v1", omissions),
                "omission_roots_root");
      set_fixed(record.conflict_roots_root, store_root_set(runtime_dir, "fact-conflict-roots/v1", conflicts),
                "conflict_roots_root");
      return append_record_with_receipt(runtime_dir, state, action, operation_id, request_root, cut_root,
                                        {{"cut_root", cut_root}}, record);
    }

    if (action == "ref-cas") {
      const auto transition_id = required_text(input, "transition_id");
      validate_transition_id(transition_id);
      const auto ref_name = required_text(input, "ref_name");
      validate_ref_name(ref_name);
      const auto has_expected_root =
          input.contains("expected_old_cut_root") &&
          (input.at("expected_old_cut_root").is_null() || input.at("expected_old_cut_root").is_string());
      const auto has_expected_revision =
          input.contains("expected_old_revision") && is_nonnegative_integer(input.at("expected_old_revision"));
      const auto expected_old = text_or(input, "expected_old_cut_root");
      validate_root(expected_old, "expected_old_cut_root", true);
      const auto expected_revision = uint64_or(input, "expected_old_revision");
      const auto new_cut = required_text(input, "new_cut_root");
      validate_root(new_cut, "new_cut_root");
      if (state.cuts.count(new_cut) == 0) {
        return failure(action, "unknown-cut", "new cut is not admitted", {{"new_cut_root", new_cut}});
      }
      const auto kind = required_text(input, "kind");
      static const std::set<std::string> kinds = {"create", "advance", "fork", "merge-view", "rollback"};
      if (kinds.count(kind) == 0) {
        throw std::invalid_argument("kind is not a supported ref transition");
      }
      const auto reason_root = required_text(input, "reason_root");
      validate_root(reason_root, "reason_root");
      const nlohmann::json document = {{"schema", "kungfu.fact.ref-transition/v1"},
                                       {"transitionId", transition_id},
                                       {"refName", ref_name},
                                       {"expectedOldCutRoot", expected_old},
                                       {"expectedOldRevision", expected_revision},
                                       {"newCutRoot", new_cut},
                                       {"kind", kind},
                                       {"reasonRoot", reason_root}};
      const auto transition_root = metadata_root("kungfu.fact.ref-transition/v1", document);
      const auto transition_replay = state.transitions.find(transition_id);
      if (transition_replay != state.transitions.end()) {
        if (transition_replay->second.at("transition_root").get<std::string>() != transition_root) {
          return failure(action, "transition-id-reused", "transition_id was reused for different bytes",
                         {{"transition_id", transition_id}});
        }
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", true},
                {"action", action},
                {"status", "idempotent-replay"},
                {"write_occurred", false},
                {"result", transition_replay->second},
                {"receipt", nullptr}};
      }
      const auto current = state.refs.find(ref_name);
      const auto current_cut =
          current == state.refs.end() ? std::string{} : current->second.at("cut_root").get<std::string>();
      const auto current_revision =
          current == state.refs.end() ? uint64_t{0} : current->second.at("revision").get<uint64_t>();
      if (!has_expected_root || !has_expected_revision ||
          (current == state.refs.end() && (!input.at("expected_old_cut_root").is_null() || expected_revision != 0)) ||
          (current != state.refs.end() && input.at("expected_old_cut_root").is_null())) {
        return failure(action, "expected-old-required", "exact expected-old cut root and revision are required");
      }
      if (current_cut != expected_old || current_revision != expected_revision) {
        return failure(action, "stale-ref", "ref changed since expected-old was observed",
                       {{"ref_name", ref_name},
                        {"expected_old_cut_root", expected_old},
                        {"expected_old_revision", expected_revision},
                        {"current_cut_root", current_cut},
                        {"current_revision", current_revision}});
      }
      // Only accepted transitions materialize their canonical preimage.
      const auto stored_transition_root = store_metadata(runtime_dir, "kungfu.fact.ref-transition/v1", document);
      if (stored_transition_root != transition_root) {
        throw std::runtime_error("fact transition root changed during admission");
      }
      FactRefTransition record{};
      record.expected_old_revision = expected_revision;
      set_fixed(record.transition_id, transition_id, "transition_id");
      set_fixed(record.ref_name, ref_name, "ref_name");
      set_fixed(record.expected_old_cut_root, expected_old, "expected_old_cut_root");
      set_fixed(record.new_cut_root, new_cut, "new_cut_root");
      set_fixed(record.transition_kind, kind, "kind");
      set_fixed(record.reason_root, reason_root, "reason_root");
      set_fixed(record.transition_root, transition_root, "transition_root");
      auto result = nlohmann::json{{"transition_id", transition_id},
                                   {"transition_root", transition_root},
                                   {"ref_name", ref_name},
                                   {"prior_cut_root", current_cut},
                                   {"current_cut_root", new_cut},
                                   {"prior_revision", current_revision},
                                   {"current_revision", current_revision + 1}};
      auto response = append_record_with_receipt(runtime_dir, state, action, operation_id, request_root,
                                                 transition_root, result, record);
      return response;
    }

    return failure(action, "unsupported-version", "unsupported Fact kernel action");
  } catch (const std::invalid_argument &error) {
    return failure(action, "invalid-identity", error.what());
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

} // namespace

nlohmann::json execute_mutation(const std::string &runtime_dir, const nlohmann::json &input) {
  const auto action = text_or(input, "action", "capabilities");
  try {
    const auto guard = writer_guard(writer_lock_path(runtime_dir));
    return execute_mutation_under_guard(runtime_dir, input);
  } catch (const std::exception &error) {
    return failure(action, "backend-failure", error.what());
  }
}

nlohmann::json execute_mutation_batch(const std::string &runtime_dir, const nlohmann::json &operations,
                                      const std::set<std::string> &expected_existing_roots) {
  try {
    const auto guard = writer_guard(writer_lock_path(runtime_dir));
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
    bool write_occurred = false;
    for (size_t index = 0; index < operations.size(); ++index) {
      const auto &operation = operations.at(index);
      const auto action = operation.at("action").get<std::string>();
      const auto expected_root = operation.at("recordRoot").get<std::string>();
      auto response = execute_mutation_under_guard(runtime_dir, operation.at("request"));
      write_occurred = write_occurred || response.value("write_occurred", false);
      const auto actual_root = response_record_root(action, response);
      responses.push_back(response);
      if (!response.value("ok", false) || actual_root != expected_root) {
        return {{"schema", FACT_KERNEL_SCHEMA_V1},
                {"ok", false},
                {"action", "authority-import"},
                {"status", "rejected"},
                {"failure_code", "import-operation-mismatch"},
                {"message", "Fact authority import did not reproduce the declared record root"},
                {"details",
                 {{"index", index},
                  {"operation", action},
                  {"expected_record_root", expected_root},
                  {"actual_record_root", actual_root},
                  {"kernel_response", response},
                  {"completed_responses", responses}}},
                {"write_occurred", write_occurred},
                {"receipt", nullptr}};
      }
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
            {"refs", after.refs},
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
