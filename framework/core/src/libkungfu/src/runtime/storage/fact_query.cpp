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
  return {{"schema", "kungfu.fact-kernel.capabilities/v1"},
          {"owner", "libkungfu"},
          {"authority", "yijinjing-hana-pod-journal"},
          {"root_protocol", ROOT_PROTOCOL},
          {"root_protocols",
           {{{"id", ROOT_PROTOCOL},
             {"status", "legacy-reader-internal-only"},
             {"writer_default", true},
             {"independently_implementable", false}},
            {{"id", PORTABLE_ROOT_PROTOCOL},
             {"status", "portable-independently-implemented"},
             {"writer_default", false},
             {"independently_implementable", true},
             {"conformance_implementations", 2}}}},
          {"content_namespaces", {{"metadata", METADATA_NAMESPACE}, {"bodies", BODY_NAMESPACE}}},
          {"actions", std::move(actions)},
          {"cas", {{"mode", "exact-expected-old-and-revision"}, {"stale_write", "no-journal-append"}}},
          {"query",
           {{"include_bodies", "opt-in-immutable-content"},
            {"include_inventory", "opt-in-authority-scan-for-integrity-and-portability"}}},
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
                                 {"refs", state.refs}};
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
          {"ref_resolution", resolution}};
}

} // namespace kungfu::runtime::storage_service_api::fact_kernel_internal
