// SPDX-License-Identifier: Apache-2.0

#include "fact_kernel_internal.h"

#include <utility>

#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/runtime/storage/json_edge.h>

namespace kungfu::runtime::storage_service_api::fact_kernel_internal {

nlohmann::json capabilities_document() {
  auto actions = nlohmann::json::array();
  for (const auto &registration : ACTION_REGISTRY) {
    actions.push_back(std::string(registration.name));
  }
  return {
      {"schema", "kungfu.fact-kernel.capabilities/v1"},
      {"owner", "libkungfu"},
      {"authority", "yijinjing-hana-pod-journal"},
      {"root_protocol", WRITER_ROOT_PROTOCOL},
      {"root_protocols",
       {{{"id", LEGACY_ROOT_PROTOCOL},
         {"status", "required-legacy-reader"},
         {"reader", true},
         {"writer_default", false},
         {"independently_implementable", false}},
        {{"id", PORTABLE_ROOT_PROTOCOL},
         {"status", "authoritative-writer"},
         {"reader", true},
         {"writer_default", true},
         {"independently_implementable", true},
         {"conformance_implementations", 2}}}},
      {"writer_authority",
       {{"schema", "kungfu.fact-writer-authority/v2"},
        {"record_schema_version", PORTABLE_RECORD_SCHEMA_VERSION},
        {"mapping_receipt", "kungfu.fact.root-mapping-receipt/v1"},
        {"legacy_rewrite", false},
        {"downgrade_write", "fail-closed"}}},
      {"content_namespaces", {{"metadata", METADATA_NAMESPACE}, {"bodies", BODY_NAMESPACE}}},
      {"actions", std::move(actions)},
      {"failure_taxonomy",
       {{"schema", "kungfu.fact-kernel.failure-taxonomy/v1"},
        {"automation_field", "failure_category"},
        {"detail_field", "failure_code"},
        {"categories",
         {"invalid-request", "invalid-action", "invalid-field", "invalid-identity", "stale-ref", "backend-failure"}}}},
      {"fold_diagnostics",
       {{"schema", "kungfu.fact-kernel.fold-issue/v1"},
        {"fields", {"sequence", "frame_tag", "record_root", "failure_code", "message", "phase", "recovery"}},
        {"payloads_exposed", false}}},
      {"cas",
       {{"mode", "exact-expected-old-and-revision"},
        {"contention", "serialized-stale-ref"},
        {"stale_write", "no-journal-append"}}},
      {"authority_import",
       {{"batch_atomicity", "accepted-logical-append-prefix"},
        {"interruption", "truthful-prefix-restart-and-retry"},
        {"qualification_fault", "test-only-logical-append-boundary"}}},
      {"query",
       {{"include_bodies", "opt-in-immutable-content"},
        {"include_inventory", "opt-in-authority-scan-for-integrity-and-portability"}}},
      {"durable_admission",
       {{"profile", "fact-durable-admission/current-hardware-candidate-v1"},
        {"activation", "explicit-ref-cas-only"},
        {"default_enabled", false},
        {"production_eligible", false},
        {"content_closure_schema", "kungfu.fact.content-closure/v1"},
        {"journal_pair_schema", "kungfu.fact.journal-pair-position/v1"},
        {"providers",
         {{{"profile", "yijinjing-file/v1"}, {"durability", "fsync-on-publish"}, {"admitted", true}},
          {{"profile", "rocksdb/v1"}, {"durability", "wal-os-buffered"}, {"admitted", false}}}},
        {"requested_profiles", {"durable_group", "durable_sync"}},
        {"qualification_faults",
         {"before-journal-sync", "after-journal-sync", "before-record-write", "after-record-write", "before-data-sync",
          "after-data-sync", "before-checkpoint-write", "before-checkpoint-rename", "after-checkpoint-rename",
          "before-directory-sync", "after-directory-sync"}},
        {"reconciliation_action", "durability-reconcile"},
        {"evidence", "docs/qualification/evidence/fact-durable-admission/current-hardware-candidate-v1/report.json"},
        {"release_gate", "durability.contracts"}}},
      {"projection_role", "rebuildable-edge-only"},
      {"clock_free_identity", true},
      {"product_vocabulary", false}};
}

nlohmann::json query_kernel(const std::string &runtime_dir, const kernel_state &state, const nlohmann::json &request) {
  const auto ref_name = text_or(request, "ref_name");
  const auto include_bodies = request.value("include_bodies", false);
  auto cut_root = text_or(request, "cut_root");
  nlohmann::json resolution = nullptr;
  if (!ref_name.empty()) {
    const auto found = state.refs.find(ref_name);
    if (found == state.refs.end()) {
      return failure("query", "unknown-cut", "Fact ref does not resolve to a known Cut", {{"ref_name", ref_name}});
    }
    resolution = found->second;
    cut_root = found->second.at("cut_root").get<std::string>();
  }
  if (cut_root.empty()) {
    auto result = nlohmann::json{{"schema", FACT_KERNEL_STATE_SCHEMA_V1},
                                 {"ok", true},
                                 {"authority", "yijinjing-hana-pod-journal"},
                                 {"counts",
                                  {{"objects", state.objects.size()},
                                   {"versions", state.versions.size()},
                                   {"relations", state.relations.size()},
                                   {"cuts", state.cuts.size()},
                                   {"refs", state.refs.size()},
                                   {"receipts", state.receipts.size()},
                                   {"unknown_records", state.unknown_records}}},
                                 {"refs", state.refs},
                                 {"issues", fold_issues_json(state.issues)}};
    if (request.value("include_inventory", false)) {
      auto inventory =
          nlohmann::json{{"objects", state.objects},     {"versions", state.versions},
                         {"relations", state.relations}, {"revoked_relation_roots", state.revoked_relations},
                         {"cuts", state.cuts},           {"transitions", state.transitions},
                         {"receipts", state.receipts}};
      if (request.value("include_bodies", false)) {
        auto bodies = nlohmann::json::object();
        for (const auto &[version_root, version] : state.versions) {
          const auto body_root = version.value("bodyRoot", std::string{});
          try {
            bodies[version_root] = {{"body", content_store_get(runtime_dir, BODY_NAMESPACE, body_root)},
                                    {"body_root", body_root},
                                    {"status", "available"}};
          } catch (const std::exception &error) {
            bodies[version_root] = {
                {"body", nullptr}, {"body_root", body_root}, {"status", "missing"}, {"error", error.what()}};
          }
        }
        inventory["bodies"] = std::move(bodies);
      }
      result["inventory"] = std::move(inventory);
    }
    return result;
  }
  const auto found = state.cuts.find(cut_root);
  if (found == state.cuts.end()) {
    return failure("query", "unknown-cut", "Fact cut does not exist", {{"cut_root", cut_root}});
  }
  const auto &cut = found->second;
  auto objects = nlohmann::json::array();
  for (const auto &member : cut.at("objectVersions")) {
    const auto version_root = member.at(1).get<std::string>();
    const auto version = state.versions.find(version_root);
    auto projected = nlohmann::json{
        {"member", member}, {"version", version == state.versions.end() ? nlohmann::json(nullptr) : version->second}};
    if (include_bodies) {
      if (version == state.versions.end()) {
        projected["body"] = nullptr;
        projected["body_status"] = "version-missing";
      } else {
        try {
          projected["body"] =
              content_store_get(runtime_dir, BODY_NAMESPACE, version->second.at("bodyRoot").get<std::string>());
          projected["body_status"] = "present";
        } catch (const std::exception &error) {
          projected["body"] = nullptr;
          projected["body_status"] = "unavailable";
          projected["body_error"] = error.what();
        }
      }
    }
    objects.push_back(std::move(projected));
  }
  auto relations = nlohmann::json::array();
  for (const auto &root : cut.at("activeRelationRoots")) {
    const auto relation = state.relations.find(root.get<std::string>());
    relations.push_back({{"relation_root", root},
                         {"relation", relation == state.relations.end() ? nlohmann::json(nullptr) : relation->second}});
  }
  return {{"schema", FACT_KERNEL_STATE_SCHEMA_V1},
          {"ok", true},
          {"authority", "yijinjing-hana-pod-journal"},
          {"cut_root", cut_root},
          {"cut", cut},
          {"objects", std::move(objects)},
          {"relations", std::move(relations)},
          {"ref_resolution", resolution},
          {"diagnostics", {{"unknown_records", state.unknown_records}, {"issues", fold_issues_json(state.issues)}}}};
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
