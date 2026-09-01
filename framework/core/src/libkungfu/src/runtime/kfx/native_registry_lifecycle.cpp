// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_registry.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#include <kungfu/runtime/kfx/native_contract.h>
#include <kungfu/runtime/profile/profile_lifecycle.h>
#include <kungfu/runtime/profile/profile_source_contract.h>
#include <kungfu/runtime/storage/fact_kernel.h>
#include <kungfu/yijinjing/storage/content_hash.h>

#include "native_authority.h"

#include "native_registry_internal.h"

namespace kungfu::runtime::kfx {
namespace native_registry_internal {

namespace fs = std::filesystem;
using json = nlohmann::json;

fs::path lifecycle_root(const std::string &runtime_dir) {
  if (runtime_dir.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "native KFX lifecycle requires an explicit runtime directory");
  return fs::absolute(runtime_dir) / "kfx";
}

json fact_call(const std::string &runtime_dir, const std::string &action, json request) {
  request["action"] = action;
  auto response = storage_service_api::run_fact_kernel_operation(runtime_dir, request);
  if (!response.value("ok", false)) {
    refuse(action == "ref-cas" && response.value("failure_code", "") == "stale-ref" ? "KF_KFX_CUT_STALE"
                                                                                    : "KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact kernel rejected KFX"));
  }
  return response;
}

std::string fact_id(const std::string &kind, const std::string &identity) {
  return "fact:" + sha256(std::string(KFX_PROFILE_ID) + ":" + kind + ":" + identity).substr(0, 32);
}

std::string relation_id(const std::string &kind, const std::string &source, const std::string &target) {
  return fact_id("relation", kind + ":" + source + ":" + target);
}

json parse_fact_body(const json &member) {
  if (!member.is_object() || member.value("body_status", "") != "present" || !member.contains("body") ||
      !member.at("body").is_string())
    return nullptr;
  try {
    return json::parse(member.at("body").get<std::string>());
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "KFX Fact body is not canonical JSON: " + std::string(error.what()));
  }
}

lifecycle_view load_lifecycle(const std::string &runtime_dir) {
  lifecycle_view result;
  if (runtime_dir.empty())
    return result;
  const auto response = storage_service_api::run_fact_kernel_operation(
      runtime_dir, {{"action", "query"}, {"ref_name", KFX_REGISTRY_REF}, {"include_bodies", true}});
  if (!response.value("ok", false)) {
    if (response.value("failure_code", "") == "unknown-cut")
      return result;
    refuse("KF_KFX_FACT_REJECTED",
           response.value("failure_code", "unknown") + ": " + response.value("message", "Fact query failed"));
  }
  result.present = true;
  result.cut_root = response.at("cut_root").get<std::string>();
  result.cut = response.at("cut");
  const auto &resolution = response.at("ref_resolution");
  result.revision = resolution.at("revision").get<uint64_t>();
  for (const auto &member : result.cut.at("objectVersions")) {
    result.current_versions[member.at(0).get<std::string>()] = member.at(1).get<std::string>();
  }
  for (const auto &root : result.cut.at("activeRelationRoots"))
    result.relation_roots.insert(root.get<std::string>());
  for (const auto &member : response.at("objects")) {
    const auto body = parse_fact_body(member);
    if (body.is_null() || !body.contains("schema") || !body.at("schema").is_string())
      continue;
    const auto schema = body.at("schema").get<std::string>();
    if (schema == "kungfu.kfx.registry-projection-fact/v1") {
      if (body.value("domainProfileRoot", "") != native_kfx_domain_profile().at("domainProfileRoot").get<std::string>())
        refuse("KF_KFX_SCHEMA_INVALID", "KFX registry projection binds a different Domain Profile");
      result.authoritative = snapshot_from_projection(body.at("projection"));
    } else if (schema == "kungfu.kfx.package-fact/v1") {
      result.desired_states[body.at("transport").at("packageKey").get<std::string>()] =
          body.at("desiredState").get<std::string>();
    } else if (schema == "kungfu.kfx.episode-fact/v1" || schema == "kungfu.kfx.episode-fact/v2") {
      const auto key = body.value("packageKey", "");
      if (!key.empty())
        result.observed_states[key] = body.value("observedState", "unknown");
      result.work_history.push_back(body);
    } else if (schema == "kungfu.kfx.work-fact/v1" || schema == "kungfu.kfx.work-fact/v2" ||
               schema == "kungfu.kfx.settlement-fact/v1" || schema == "kungfu.kfx.settlement-fact/v2") {
      result.work_history.push_back(body);
    }
  }
  if (result.authoritative.registry_root.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "named KFX Fact Cut has no registry projection Fact");
  return result;
}

lifecycle_writer_lock::lifecycle_writer_lock(const std::string &runtime_dir)
    : path_(lifecycle_root(runtime_dir) / ".writer-lock") {
  fs::create_directories(path_.parent_path());
  std::error_code error;
  if (!fs::create_directory(path_, error))
    refuse("KF_KFX_WRITER_BUSY", "another native KFX writer owns this runtime directory");
  held_ = true;
}

lifecycle_writer_lock::~lifecycle_writer_lock() {
  if (!held_)
    return;
  std::error_code ignored;
  fs::remove(path_, ignored);
}

const json &provider_for(const snapshot &value, const std::string &provider_id) {
  for (const auto &provider : value.graph.at("providers")) {
    if (provider.at("providerId") == provider_id)
      return provider;
  }
  refuse("KF_KFX_MEMBER_MISSING", "KFX provider is not present in the semantic graph: " + provider_id);
}

std::string derived_verdict(const json &provider, const std::string &desired, const std::string &observed) {
  if (provider.value("state", "active") == "degraded" || observed == "failed" || observed == "degraded")
    return "degraded";
  if (desired == "dormant" || desired == "removed" || desired == "disabled")
    return "dormant";
  return observed == "unknown" ? "dormant" : "active";
}

std::string runtime_placement(const std::string &host) {
  if (host == "gui")
    return "sandboxed-ipc";
  if (host == "wasm")
    return "wasm-confined";
  if (host.starts_with("service-"))
    return "process-isolated";
  if (host.starts_with("adapter-"))
    return "integrated-explicit";
  if (host == "profile")
    return "metadata-only";
  refuse("KF_KFX_HOST_UNKNOWN", "Core cannot derive a physical placement for host " + host);
}

bool capabilities_cover(const json &granted, const json &required) {
  if (!granted.is_array() || !required.is_array())
    return false;
  return std::all_of(required.begin(), required.end(), [&](const auto &capability) {
    return std::find(granted.begin(), granted.end(), capability) != granted.end();
  });
}

json host_generation(const snapshot &value, const lifecycle_view &lifecycle) {
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  return {{"schema", "kungfu.kfx.host-generation/v2"},
          {"registryRoot", value.registry_root},
          {"graphRoot", value.graph_root},
          {"cutRoot", cut_root},
          {"revision", lifecycle.revision}};
}

json package_host_authorization(const json &package, const json &provider, const json &required_capabilities,
                                const std::string &placement, const lifecycle_view &lifecycle,
                                const std::string &generation_root) {
  const auto package_authority = package.value("authority", json::object());
  const auto granted_capabilities = package.value("grantedCapabilities", json::array());
  const auto desired = lifecycle.desired_states.contains(package.at("key").get<std::string>())
                           ? lifecycle.desired_states.at(package.at("key").get<std::string>())
                           : "dormant";
  const bool confinement_ok = placement != "integrated-disabled" && placement != "metadata-only";
  const bool execution_allowed = lifecycle.present && package.value("admitted", false) && desired == "active" &&
                                 !package_authority.empty() && confinement_ok &&
                                 capabilities_cover(granted_capabilities, required_capabilities);
  const json identity = {
      {"schema", "kungfu.kfx.host-authorization/v2"},
      {"packageKey", package.at("key")},
      {"packageRoot", package.at("packageRoot")},
      {"manifestRoot", package.at("manifestRoot")},
      {"ownerProviderRoot", provider.at("providerRoot")},
      {"trustRoot", provider.at("trustRoot")},
      {"runtimeTier", package.at("runtimeTier")},
      {"admissionGrade", package.at("admissionGrade")},
      {"placement", placement},
      {"requiredCapabilities", required_capabilities},
      {"grantedCapabilities", granted_capabilities},
      {"reportRoot", package_authority.value("reportRoot", json(nullptr))},
      {"admissionPlanRoot", package_authority.value("admissionPlanRoot", json(nullptr))},
      {"corePolicyRoot", package_authority.value("corePolicyRoot", json(nullptr))},
      {"requestedPolicyRoot", package_authority.value("requestedPolicyRoot", json(nullptr))},
      {"policyRoot", package_authority.value("policyRoot", json(nullptr))},
      {"authorizationPlanRoot", package_authority.value("authorizationPlanRoot", json(nullptr))},
      {"capabilityDeclarationRoot", package_authority.value("capabilityDeclarationRoot", json(nullptr))},
      {"capabilityGrantRoot", package_authority.value("capabilityGrantRoot", json(nullptr))},
      {"warrantRoot", package_authority.value("warrantRoot", json(nullptr))},
      {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
      {"revision", lifecycle.revision},
      {"generationRoot", generation_root},
      {"executionAllowed", execution_allowed}};
  auto result = identity;
  result["authorizationRoot"] = root_of(identity);
  return result;
}

json lifecycle_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request) {
  json package_plan = json::array();
  for (const auto &package : value.packages) {
    const auto key = package.at("key").get<std::string>();
    const auto &provider = provider_for(value, key);
    const auto desired_state =
        lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
    const auto observed_state =
        lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
    const auto verdict = derived_verdict(provider, desired_state, observed_state);
    package_plan.push_back({{"key", package.at("key")},
                            {"providerRoot", provider.at("providerRoot")},
                            {"packageRoot", package.at("packageRoot")},
                            {"apiCompatibility", package.at("apiCompatibility")},
                            {"facets", package.at("facets")},
                            {"runtimeTier", package.at("runtimeTier")},
                            {"admissionGrade", package.at("admissionGrade")},
                            {"trustRoot", provider.at("trustRoot")},
                            {"capabilityRoot", provider.at("capabilityRoot")},
                            {"hosts", package.at("hosts")},
                            {"declaredCapabilities", package.at("declaredCapabilities")},
                            {"semanticState", provider.at("state")},
                            {"desiredState", desired_state},
                            {"observedState", observed_state},
                            {"verdict", verdict},
                            {"state", verdict},
                            {"causes", provider.at("causes")},
                            {"recoveryGuidance", provider.at("recoveryGuidance")}});
  }
  json intent = nullptr;
  if (request.contains("operation") || request.contains("packageKey")) {
    intent = {{"operation", request.value("operation", "")}, {"packageKey", request.value("packageKey", "")}};
  }
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  json identity = {{"schema", "kungfu.kfx.load-plan/v2"},
                   {"registryRoot", value.registry_root},
                   {"graphRoot", value.graph_root},
                   {"authorityMode", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
                   {"cutRef", KFX_REGISTRY_REF},
                   {"cutRoot", cut_root},
                   {"revision", lifecycle.revision},
                   {"packages", package_plan},
                   {"suites", value.suites},
                   {"diagnostics", value.diagnostics},
                   {"intent", intent},
                   {"readOnly", false}};
  auto result = identity;
  const auto plan_root = root_of(identity);
  result["planRoot"] = plan_root;
  result["graph"] = value.graph;
  result["nextRevision"] = intent.is_null() ? lifecycle.revision : lifecycle.revision + 1;
  result["hostContract"] = experience_flow_descriptor(value, lifecycle, plan_root);
  return result;
}

bool is_lifecycle_event_schema(const std::string &schema) {
  static const std::set<std::string> schemas = {
      "kungfu.kfx.work-fact/v1",       "kungfu.kfx.work-fact/v2",       "kungfu.kfx.warrant-fact/v1",
      "kungfu.kfx.warrant-fact/v2",    "kungfu.kfx.episode-fact/v1",    "kungfu.kfx.episode-fact/v2",
      "kungfu.kfx.settlement-fact/v1", "kungfu.kfx.settlement-fact/v2",
  };
  return schemas.contains(schema);
}

std::optional<json> lifecycle_event(const json &entry, const std::string &package_key) {
  if (!entry.is_object() || entry.value("status", "") != "available" || !entry.contains("body") ||
      !entry.at("body").is_string())
    return std::nullopt;
  json body;
  try {
    body = json::parse(entry.at("body").get<std::string>());
  } catch (const json::exception &) {
    return std::nullopt;
  }
  if (!is_lifecycle_event_schema(body.value("schema", "")) ||
      (!package_key.empty() && body.value("packageKey", "") != package_key))
    return std::nullopt;
  return body;
}

json collect_lifecycle_events(const json &inventory, const std::string &package_key) {
  json events = json::array();
  if (!inventory.contains("bodies") || !inventory.at("bodies").is_object())
    return events;
  for (const auto &[ignored, entry] : inventory.at("bodies").items()) {
    (void)ignored;
    const auto event = lifecycle_event(entry, package_key);
    if (event.has_value())
      events.push_back(*event);
  }
  std::sort(events.begin(), events.end(), [](const auto &left, const auto &right) {
    if (left.value("recordedAt", int64_t{0}) != right.value("recordedAt", int64_t{0}))
      return left.value("recordedAt", int64_t{0}) < right.value("recordedAt", int64_t{0});
    return left.value("actionId", "") < right.value("actionId", "");
  });
  return events;
}

json lifecycle_history(const std::string &runtime_dir, const json &request) {
  if (runtime_dir.empty())
    refuse("KF_KFX_SCHEMA_INVALID", "KFX history requires an explicit runtime directory");
  const auto state = storage_service_api::run_fact_kernel_operation(
      runtime_dir, {{"action", "query"}, {"include_inventory", true}, {"include_bodies", true}});
  if (!state.value("ok", false))
    refuse("KF_KFX_FACT_REJECTED", state.value("message", "Fact inventory query failed"));
  const auto events = collect_lifecycle_events(state.at("inventory"), request.value("packageKey", ""));
  const auto lifecycle = load_lifecycle(runtime_dir);
  return {{"schema", "kungfu.kfx.lifecycle-history/v2"},
          {"authority", "yijinjing-hana-pod-journal"},
          {"cutRef", KFX_REGISTRY_REF},
          {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
          {"revision", lifecycle.revision},
          {"historyRoot", root_of(events)},
          {"events", events}};
}

json experience_flow_descriptor(const snapshot &value, const lifecycle_view &lifecycle, const std::string &plan_root) {
  const auto generation = host_generation(value, lifecycle);
  const auto generation_root = root_of(generation);
  json runtime_authorizations = json::array();
  for (const auto &package : value.packages) {
    const auto &provider = provider_for(value, package.at("key").get<std::string>());
    for (const auto &host : package.at("hosts")) {
      const auto host_name = host.get<std::string>();
      auto authorization = package_host_authorization(package, provider, package.at("declaredCapabilities"),
                                                      runtime_placement(host_name), lifecycle, generation_root);
      authorization["host"] = host_name;
      runtime_authorizations.push_back(authorization);
    }
  }
  json contributions = json::array();
  for (const auto &contribution : value.graph.at("contributions")) {
    if (!contribution.contains("surface") ||
        (contribution.at("surface") != "experience" && contribution.at("surface") != "flow"))
      continue;
    json projected = contribution;
    const auto provider_id = contribution.at("ownerProviderId").get<std::string>();
    const auto desired =
        lifecycle.desired_states.contains(provider_id) ? lifecycle.desired_states.at(provider_id) : "dormant";
    const auto observed =
        lifecycle.observed_states.contains(provider_id) ? lifecycle.observed_states.at(provider_id) : "unknown";
    const auto &provider = provider_for(value, provider_id);
    const auto package = find_package(value.packages, provider_id);
    projected["providerState"] = derived_verdict(provider, desired, observed);
    const json facet_identity = {{"schema", "kungfu.kfx.presentation-facet/v1"},
                                 {"contributionRoot", contribution.at("contributionRoot")},
                                 {"presentation", contribution.value("presentation", json::object())}};
    const auto authorization = package_host_authorization(package, provider, contribution.at("capabilities"),
                                                          "host-native-projection", lifecycle, generation_root);
    projected["ownerProviderRoot"] = provider.at("providerRoot");
    projected["ownerTrustRoot"] = provider.at("trustRoot");
    projected["facetRoot"] = root_of(facet_identity);
    projected["authorization"] = authorization;
    contributions.push_back(projected);
  }
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  json contribution_roots = json::array();
  json facet_roots = json::array();
  json capability_roots = json::array();
  json authorization_roots = json::array();
  json runtime_authorization_roots = json::array();
  for (const auto &contribution : contributions) {
    contribution_roots.push_back(contribution.at("contributionRoot"));
    facet_roots.push_back(contribution.at("facetRoot"));
    capability_roots.push_back(contribution.at("capabilityRoot"));
    authorization_roots.push_back(contribution.at("authorization").at("authorizationRoot"));
  }
  for (const auto &authorization : runtime_authorizations)
    runtime_authorization_roots.push_back(authorization.at("authorizationRoot"));
  const json admission = {{"schema", "kungfu.kfx.host-admission/v2"},
                          {"state", lifecycle.present ? "admitted" : "preview-only"},
                          {"exactRootRequired", true},
                          {"registryRoot", value.registry_root},
                          {"graphRoot", value.graph_root},
                          {"planRoot", plan_root},
                          {"cutRoot", cut_root},
                          {"revision", lifecycle.revision},
                          {"generationRoot", generation_root},
                          {"contributionRoots", contribution_roots},
                          {"facetRoots", facet_roots},
                          {"capabilityRoots", capability_roots},
                          {"authorizationRoots", authorization_roots},
                          {"runtimeAuthorizationRoots", runtime_authorization_roots}};
  const json receipt_dependency = {{"registryRoot", value.registry_root},
                                   {"graphRoot", value.graph_root},
                                   {"planRoot", plan_root},
                                   {"cutRoot", cut_root},
                                   {"revision", lifecycle.revision},
                                   {"generationRoot", generation_root},
                                   {"authorizationRoots", authorization_roots},
                                   {"runtimeAuthorizationRoots", runtime_authorization_roots}};
  const json identity = {{"schema", "kungfu.kfx.experience-flow-host/v3"},
                         {"registryRoot", value.registry_root},
                         {"graphRoot", value.graph_root},
                         {"planRoot", plan_root},
                         {"cutRoot", cut_root},
                         {"revision", lifecycle.revision},
                         {"generation", generation},
                         {"generationRoot", generation_root},
                         {"admission", admission},
                         {"receiptDependencies", receipt_dependency},
                         {"receiptDependencyRoot", root_of(receipt_dependency)},
                         {"hosts", json::array({"gui", "tui", "cli", "agent"})},
                         {"runtimeAuthorizations", runtime_authorizations},
                         {"contributions", contributions}};
  auto descriptor = identity;
  descriptor["descriptorRoot"] = root_of(identity);
  return descriptor;
}

json authorize_host_launch(const json &descriptor, const lifecycle_view &lifecycle, const json &request) {
  if (!lifecycle.present)
    refuse("KF_KFX_HOST_NOT_ADMITTED", "host launch requires a settled named KFX Fact Cut");
  const auto package_key = required_text(request, "packageKey", "request");
  const auto host = required_text(request, "host", "request");
  if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
      request.at("expectedRevision").get<int64_t>() < 0 ||
      static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision ||
      request.value("expectedCutRoot", "") != lifecycle.cut_root)
    refuse("KF_KFX_CUT_STALE", "host launch does not bind the current named Fact Cut");
  if (request.value("expectedGenerationRoot", "") != descriptor.at("generationRoot").get<std::string>())
    refuse("KF_KFX_GENERATION_MISMATCH", "host launch generation is stale");
  for (const auto &authorization : descriptor.at("runtimeAuthorizations")) {
    if (authorization.at("packageKey") != package_key || authorization.at("host") != host)
      continue;
    if (request.value("expectedPackageRoot", "") != authorization.at("packageRoot").get<std::string>())
      refuse("KF_KFX_REGISTRY_STALE", "host launch package root changed");
    if (!authorization.at("capabilityGrantRoot").is_string() ||
        request.value("expectedCapabilityGrantRoot", "") != authorization.at("capabilityGrantRoot").get<std::string>())
      refuse("KF_KFX_CAPABILITY_GRANT_STALE", "host launch capability grant changed or was replayed");
    if (request.value("expectedAuthorizationRoot", "") != authorization.at("authorizationRoot").get<std::string>())
      refuse("KF_KFX_AUTHORIZATION_STALE", "host launch authorization root changed");
    const auto expected_capabilities = request.value("expectedGrantedCapabilities", json::array());
    if (!expected_capabilities.is_array() || expected_capabilities != authorization.at("grantedCapabilities"))
      refuse("KF_KFX_CAPABILITY_GRANT_STALE", "host launch capability set does not match the exact grant");
    if (!authorization.at("executionAllowed").get<bool>())
      refuse("KF_KFX_RUNTIME_ISOLATION_REQUIRED",
             "host launch is not active, fully granted, or confined by the Core placement");
    return {{"schema", "kungfu.kfx.host-launch-authorization/v1"},
            {"descriptorRoot", descriptor.at("descriptorRoot")},
            {"generationRoot", descriptor.at("generationRoot")},
            {"cutRoot", descriptor.at("cutRoot")},
            {"revision", descriptor.at("revision")},
            {"authorization", authorization},
            {"executionAllowed", true}};
  }
  refuse("KF_KFX_HOST_UNKNOWN", "package does not declare the requested Core host placement");
}

json mutation_authorization_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request,
                                 const json &load_plan) {
  const json prior_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  return authority::plan(value.packages, value.registry_root, value.graph_root, prior_cut, lifecycle.revision, request,
                         load_plan, assess_package);
}

json development_source_bootstrap_policy() {
  return {{"schema", "kungfu.kfx-development-source-bootstrap/v1"},
          {"sourceCandidate", "sourceRoot/extensions/system/kfx-manager"},
          {"workspaceScope", "same-git-common-directory local workspace only"},
          {"runtimePlacement", "workspaceRoot/.kungfu/runtime"},
          {"operations", json::array({"install"})},
          {"grantedCapabilities", json::array({"kfxControl"})},
          {"publicationAllowed", false},
          {"sharedInstallationAllowed", false},
          {"externalCapabilitiesAllowed", false}};
}

json control_bootstrap_policy() {
  const json identity = {
      {"schema", "kungfu.kfx.control-bootstrap-policy/v1"},
      {"controllerId", KFX_CONTROL_SUITE_ID},
      {"maximumCapabilities", json::array({"kfxControl", "profile"})},
      {"requiredCapabilities", json::array({"kfxControl"})},
      {"runtimePlacement", "sandboxed-ipc"},
      {"bootstrapTcb", json::array({"manifest-and-closure-verifier", "release-passport-verifier",
                                    "core-policy-interpreter", "fact-work-warrant-settlement",
                                    "last-known-good-selector", "safe-mode", "owner-authorized-emergency-removal"})},
      {"authority",
       {{"candidateIdentity", "Core-computed package closure selected by the controller route"},
        {"lifecycle", "public-kfx-status-plan-apply"},
        {"settlement", "fact-work-named-cut-cas"},
        {"selfGrant", false},
        {"originAuthority", false},
        {"productAssemblyAuthority", false},
        {"receiptsBypassPolicy", false}}},
      {"developmentSourceBootstrap", development_source_bootstrap_policy()},
      {"recovery",
       {{"lastKnownGood", "retained-package-referenced-by-sealed-kfx-episode-fact"},
        {"corruptOrMissingActive", "deterministic-safe-mode"},
        {"automaticActivation", false}}}};
  auto result = identity;
  result["policyRoot"] = root_of(identity);
  return result;
}

const std::vector<const char *> &control_authority_roots(bool development_source_bootstrap) {
  static const std::vector<const char *> development = {
      "corePolicyRoot",      "requestedPolicyRoot", "policyRoot", "authorizationPlanRoot", "capabilityDeclarationRoot",
      "capabilityGrantRoot", "warrantRoot"};
  static const std::vector<const char *> production = {"reportRoot",
                                                       "admissionPlanRoot",
                                                       "corePolicyRoot",
                                                       "requestedPolicyRoot",
                                                       "policyRoot",
                                                       "authorizationPlanRoot",
                                                       "capabilityDeclarationRoot",
                                                       "capabilityGrantRoot",
                                                       "warrantRoot"};
  return development_source_bootstrap ? development : production;
}

bool authority_roots_present(const json &authority, bool development_source_bootstrap) {
  return std::all_of(control_authority_roots(development_source_bootstrap).begin(),
                     control_authority_roots(development_source_bootstrap).end(), [&](const char *root) {
                       return authority.contains(root) && authority.at(root).is_string() &&
                              !authority.at(root).get<std::string>().empty();
                     });
}

bool development_authority_is_confined(const json &authority, const json &granted) {
  return authority.value("reportRoot", json(nullptr)).is_null() &&
         authority.value("admissionPlanRoot", json(nullptr)).is_null() && granted == json::array({"kfxControl"});
}

void validate_control_authority(json &reasons, const json &package, const json &policy) {
  const auto authority = package.value("authority", json::object());
  const auto granted = package.value("grantedCapabilities", json::array());
  const bool development_source_bootstrap = authority.value("mode", "") == "development-source-bootstrap";
  if (!authority_roots_present(authority, development_source_bootstrap) ||
      (development_source_bootstrap && !development_authority_is_confined(authority, granted)))
    reasons.push_back("KF_KFX_CONTROL_AUTHORITY_MISSING");
  for (const auto &required : policy.at("requiredCapabilities")) {
    if (std::find(granted.begin(), granted.end(), required) == granted.end())
      reasons.push_back("KF_KFX_CONTROL_GRANT_MISSING");
  }
}

json validate_control_package(const json &package, bool require_authority = false) {
  const auto policy = control_bootstrap_policy();
  json reasons = json::array();
  if (package.is_null() || !package.is_object()) {
    reasons.push_back("KF_KFX_CONTROL_CANDIDATE_MISSING");
  } else {
    const auto capabilities = package.value("declaredCapabilities", json::array());
    if (!capabilities_cover(capabilities, policy.at("requiredCapabilities")))
      reasons.push_back("KF_KFX_CONTROL_CAPABILITY_MISSING");
    if (!capabilities_cover(policy.at("maximumCapabilities"), capabilities))
      reasons.push_back("KF_KFX_CONTROL_SELF_GRANT");
    if (require_authority)
      validate_control_authority(reasons, package, policy);
  }
  return {{"schema", "kungfu.kfx.control-bootstrap-verification/v1"},
          {"controllerId", KFX_CONTROL_SUITE_ID},
          {"policyRoot", policy.at("policyRoot")},
          {"packageRoot", package.is_object() ? package.value("packageRoot", "") : ""},
          {"manifestRoot", package.is_object() ? package.value("manifestRoot", "") : ""},
          {"valid", reasons.empty()},
          {"reasons", reasons}};
}

json inspect_control_package_path(const fs::path &path) {
  if (!fs::is_directory(path))
    refuse("KF_KFX_CONTROL_ACTIVE_CORRUPT", "Control Suite package path is missing");
  const json request = {{"roots", json::array({{{"kind", "product"}, {"path", path.string()}}})}};
  const auto observed = build_snapshot(request);
  const auto package = find_package(observed.packages, KFX_CONTROL_PACKAGE_KEY);
  const auto verification = validate_control_package(package);
  if (!verification.at("valid").get<bool>())
    refuse("KF_KFX_CONTROL_ACTIVE_CORRUPT", "Control Suite package failed embedded bootstrap verification");
  return package;
}

std::vector<json> retained_control_candidates(const lifecycle_view &lifecycle) {
  std::vector<std::pair<int64_t, fs::path>> paths;
  for (const auto &event : lifecycle.work_history) {
    const auto schema = event.value("schema", "");
    if ((schema != "kungfu.kfx.episode-fact/v1" && schema != "kungfu.kfx.episode-fact/v2") ||
        event.value("packageKey", "") != KFX_CONTROL_PACKAGE_KEY)
      continue;
    const auto materialization = event.value("materialization", json::object());
    if (!materialization.contains("retainedPath") || !materialization.at("retainedPath").is_string() ||
        materialization.at("retainedPath").get<std::string>().empty())
      continue;
    paths.emplace_back(event.value("recordedAt", int64_t{0}),
                       fs::path(materialization.at("retainedPath").get<std::string>()));
  }
  std::sort(paths.begin(), paths.end(), [](const auto &left, const auto &right) { return left.first > right.first; });
  std::vector<json> result;
  std::set<std::string> seen_roots;
  for (const auto &[ignored, path] : paths) {
    (void)ignored;
    try {
      const auto package = inspect_control_package_path(path);
      const auto root = package.at("packageRoot").get<std::string>();
      if (!seen_roots.insert(root).second)
        continue;
      result.push_back({{"packageRoot", root},
                        {"manifestRoot", package.at("manifestRoot")},
                        {"version", package.value("version", "")},
                        {"sourcePath", path.string()}});
    } catch (const std::invalid_argument &) {
      // Retained bytes are recovery candidates, never authority. Corrupt or
      // stale candidates stay excluded and cannot weaken safe mode.
    }
  }
  return result;
}

std::pair<json, json> active_control_verification(const lifecycle_view &lifecycle, const json &policy) {
  json active = lifecycle.present ? find_package(lifecycle.authoritative.packages, KFX_CONTROL_PACKAGE_KEY) : nullptr;
  json active_verification = {{"schema", "kungfu.kfx.control-bootstrap-verification/v1"},
                              {"controllerId", KFX_CONTROL_SUITE_ID},
                              {"policyRoot", policy.at("policyRoot")},
                              {"packageRoot", ""},
                              {"manifestRoot", ""},
                              {"valid", false},
                              {"reasons", json::array({"KF_KFX_CONTROL_ACTIVE_MISSING"})}};
  if (active.is_null())
    return {active, active_verification};
  active_verification = validate_control_package(active, true);
  if (!active_verification.at("valid").get<bool>())
    return {active, active_verification};
  try {
    const auto physical = inspect_control_package_path(active.at("path").get<std::string>());
    if (physical.at("packageRoot") != active.at("packageRoot") ||
        physical.at("manifestRoot") != active.at("manifestRoot")) {
      active_verification["valid"] = false;
      active_verification["reasons"] = json::array({"KF_KFX_CONTROL_ACTIVE_CORRUPT"});
    }
  } catch (const std::invalid_argument &) {
    active_verification["valid"] = false;
    active_verification["reasons"] = json::array({"KF_KFX_CONTROL_ACTIVE_CORRUPT"});
  }
  return {active, active_verification};
}

json last_known_good_control(const json &active, bool active_valid, const std::vector<json> &retained) {
  if (!retained.empty())
    return retained.front();
  if (!active_valid)
    return nullptr;
  return {{"packageRoot", active.at("packageRoot")},
          {"manifestRoot", active.at("manifestRoot")},
          {"version", active.value("version", "")},
          {"sourcePath", active.value("path", "")}};
}

json control_status(const lifecycle_view &lifecycle) {
  const auto policy = control_bootstrap_policy();
  const auto [active, active_verification] = active_control_verification(lifecycle, policy);
  const auto retained = retained_control_candidates(lifecycle);
  const auto active_valid = active_verification.at("valid").get<bool>();
  const auto last_known_good = last_known_good_control(active, active_valid, retained);
  const auto mode = active_valid ? "active" : "safe-mode";
  json identity = {
      {"schema", "kungfu.kfx.control-suite-status/v1"},
      {"controllerId", KFX_CONTROL_SUITE_ID},
      {"authority", lifecycle.present ? "pinned-fact-cut" : "bootstrap-safe-mode"},
      {"cutRef", KFX_REGISTRY_REF},
      {"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
      {"revision", lifecycle.revision},
      {"policy", policy},
      {"active", active.is_null() ? json(nullptr)
                                  : json({{"packageRoot", active.at("packageRoot")},
                                          {"manifestRoot", active.at("manifestRoot")},
                                          {"version", active.value("version", "")}})},
      {"activeVerification", active_verification},
      {"lastKnownGood", last_known_good},
      {"mode", mode},
      {"executionAllowed", active_valid},
      {"diagnostics",
       active_valid
           ? json::array()
           : json::array({{{"code", "KF_KFX_CONTROL_SAFE_MODE"},
                           {"recoveryGuidance", last_known_good.is_null()
                                                    ? json::array({"install-qualified-control-suite"})
                                                    : json::array({"plan-explicit-last-known-good-rollback"})}}})}};
  auto result = identity;
  result["statusRoot"] = root_of(identity);
  return result;
}

bool development_source_bootstrap(const json &mutation_authorization) {
  return mutation_authorization.at("mode") == "development-source-bootstrap";
}

const char *control_plan_authority(const json &mutation_authorization) {
  if (development_source_bootstrap(mutation_authorization))
    return "development-source-local-only";
  const auto assessment = mutation_authorization.at("assessment");
  if (assessment.is_null() || assessment.at("trustReport").value("admissionGrade", "") != "kfd-attested")
    refuse("KF_KFX_CONTROL_TRUST_REJECTED",
           "Control Suite requires exact KFD eligibility before public Fact/Work authorization");
  return "public-kfx-plan-plus-fact-work-settlement";
}

json control_plan(const snapshot &value, const lifecycle_view &lifecycle, const json &request, const json &load_plan) {
  const auto operation = request.value("operation", "");
  if (operation != "install" && operation != "update")
    refuse("KF_KFX_CONTROL_OPERATION_REJECTED", "Control Suite only admits explicit install or update plans");
  if (request.value("packageKey", "") != KFX_CONTROL_PACKAGE_KEY)
    refuse("KF_KFX_CONTROL_IDENTITY_MISMATCH", "Control Suite cannot mutate another package identity");
  const auto candidate = find_package(value.packages, KFX_CONTROL_PACKAGE_KEY);
  const auto verification = validate_control_package(candidate);
  if (!verification.at("valid").get<bool>()) {
    const auto reasons = verification.at("reasons");
    const auto code = reasons.empty() ? "KF_KFX_CONTROL_TRUST_REJECTED" : reasons.front().get<std::string>();
    refuse(code, "Control Suite candidate exceeds the embedded bootstrap contract");
  }
  const auto status = control_status(lifecycle);
  const auto mutation_authorization = mutation_authorization_plan(value, lifecycle, request, load_plan);
  const auto authority = control_plan_authority(mutation_authorization);
  const json identity = {
      {"schema", "kungfu.kfx.control-suite-plan/v1"},
      {"controllerId", KFX_CONTROL_SUITE_ID},
      {"operation", operation},
      {"packageKey", KFX_CONTROL_PACKAGE_KEY},
      {"basis",
       {{"cutRoot", lifecycle.present ? json(lifecycle.cut_root) : json(nullptr)},
        {"revision", lifecycle.revision},
        {"activePackageRoot", status.at("active").is_null() ? json(nullptr) : status.at("active").at("packageRoot")}}},
      {"candidate",
       {{"packageRoot", candidate.at("packageRoot")},
        {"manifestRoot", candidate.at("manifestRoot")},
        {"version", candidate.value("version", "")}}},
      {"bootstrapVerification", verification},
      {"bootstrapPolicyRoot", control_bootstrap_policy().at("policyRoot")},
      {"loadPlanRoot", load_plan.at("planRoot")},
      {"registryRoot", load_plan.at("registryRoot")},
      {"graphRoot", load_plan.at("graphRoot")},
      {"mutationAuthorization", mutation_authorization},
      {"authorizationPlanRoot", mutation_authorization.at("authorizationPlanRoot")},
      {"capabilityGrantRoot", mutation_authorization.at("capabilityGrantRoot")},
      {"warrantRoot", mutation_authorization.at("warrantRoot")},
      {"allowed", true},
      {"requiresAuthorization", true},
      {"authority", authority}};
  auto result = identity;
  result["controlPlanRoot"] = root_of(identity);
  result["loadPlan"] = load_plan;
  return result;
}

struct fact_work_builder {
  std::string runtime_dir;
  std::map<std::string, std::string> versions;
  std::set<std::string> relations;
  json steps = json::array();
  std::string profile_root;
  std::string admission_root;

  fact_work_builder(std::string runtime, const lifecycle_view &current)
      : runtime_dir(std::move(runtime)), versions(current.current_versions), relations(current.relation_roots),
        profile_root(native_kfx_domain_profile().at("domainProfileRoot").get<std::string>()),
        admission_root(
            root_of({{"schema", "kungfu.kfx-domain-profile-admission/v1"}, {"domainProfileRoot", profile_root}})) {}

  json invoke(const std::string &action, const json &request) {
    auto response = fact_call(runtime_dir, action, request);
    if (response.value("status", "") == "idempotent-replay" && response.contains("result") &&
        response.at("result").contains("record_root")) {
      static const std::map<std::string, std::string> replay_root_fields = {{"object-put", "object_root"},
                                                                            {"version-put", "version_root"},
                                                                            {"relation-add", "relation_root"},
                                                                            {"cut-put", "cut_root"}};
      if (replay_root_fields.contains(action))
        response["result"][replay_root_fields.at(action)] = response.at("result").at("record_root");
    }
    steps.push_back({{"action", action},
                     {"status", response.value("status", "accepted")},
                     {"writeOccurred", response.value("write_occurred", false)},
                     {"receiptRoot", response.contains("receipt_root") ? response.at("receipt_root") : json(nullptr)}});
    return response;
  }

  json put(const std::string &object_id, const std::string &object_type, const json &body) {
    const auto created_by = root_of({{"schema", "kungfu.kfx-object-declaration/v1"},
                                     {"domainProfileRoot", profile_root},
                                     {"objectId", object_id},
                                     {"objectType", object_type}});
    invoke("object-put",
           {{"object_id", object_id}, {"object_type", object_type}, {"created_by_receipt_root", created_by}});
    json parents = json::array();
    if (versions.contains(object_id))
      parents.push_back(versions.at(object_id));
    const auto response = invoke(
        "version-put",
        {{"object_id", object_id},
         {"body", body.dump()},
         {"schema_root", root_of({{"schema", "kungfu.kfx-fact-body-schema/v1"}, {"bodySchema", body.at("schema")}})},
         {"parent_version_roots", parents},
         {"declaration_roots", json::array({profile_root})},
         {"admission_roots", json::array({admission_root})}});
    versions[object_id] = response.at("result").at("version_root").get<std::string>();
    return response.at("result");
  }

  void relate(const std::string &type, const std::string &source, const std::string &target, const json &attributes) {
    const auto attributes_root = root_of(attributes);
    const auto response = invoke("relation-add", {{"relation_id", relation_id(type, source, target)},
                                                  {"relation_type", type},
                                                  {"source", {{"kind", "logical-object"}, {"id", source}}},
                                                  {"target", {{"kind", "logical-object"}, {"id", target}}},
                                                  {"attributes_root", attributes_root},
                                                  {"admission_roots", json::array({admission_root})}});
    relations.insert(response.at("result").at("relation_root").get<std::string>());
  }
};

std::string package_identity_root(const json &package) {
  return root_of(
      {{"schema", "kungfu.kfx.package-identity/v1"},
       {"name", package.value("name", "")},
       {"manifestIdentity", package.value("name", "").empty() ? package.at("manifestRoot") : package.at("name")}});
}

json issue_fact_work_authority(const std::string &runtime_dir, const snapshot &value, const lifecycle_view &current,
                               const json &authorization) {
  const auto action_id = authorization.at("actionId").get<std::string>();
  const auto work_id = authorization.at("workObjectId").get<std::string>();
  const auto warrant_id = authorization.at("warrantObjectId").get<std::string>();
  const auto recorded_at = authorization.at("authorizationTime").get<int64_t>();
  const auto profile_root = native_kfx_domain_profile().at("domainProfileRoot");
  fact_work_builder builder(runtime_dir, current);
  const auto projection_id = fact_id("registry-projection", KFX_REGISTRY_REF);
  builder.put(projection_id, "kungfu.kfx.registry-projection",
              {{"schema", "kungfu.kfx.registry-projection-fact/v1"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"cutRef", KFX_REGISTRY_REF},
               {"projection", snapshot_projection(value)}});
  builder.put(work_id, "kungfu.kfx.work",
              {{"schema", "kungfu.kfx.work-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", authorization.at("operation")},
               {"packageKey", authorization.at("packageKey")},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"recordedAt", recorded_at},
               {"status", "authorized"}});
  builder.put(warrant_id, "kungfu.kfx.warrant",
              {{"schema", "kungfu.kfx.warrant-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", authorization.at("operation")},
               {"packageKey", authorization.at("packageKey")},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"state", "issued"},
               {"recordedAt", recorded_at}});
  builder.relate("kfx-work-authorized-by", work_id, warrant_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"},
                  {"actionId", action_id},
                  {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")}});

  json object_versions = json::array();
  for (const auto &[object_id, version_root] : builder.versions)
    object_versions.push_back({{"object_id", object_id}, {"version_root", version_root}});
  json relation_roots = json::array();
  for (const auto &root : builder.relations)
    relation_roots.push_back(root);
  json parent_cuts = json::array();
  if (current.present)
    parent_cuts.push_back(current.cut_root);
  const auto cut_response = builder.invoke(
      "cut-put",
      {{"parent_cut_roots", parent_cuts},
       {"object_versions", object_versions},
       {"active_relation_roots", relation_roots},
       {"declaration_roots", json::array({builder.profile_root})},
       {"admission_roots", json::array({builder.admission_root, authorization.at("authorizationPlanRoot"),
                                        authorization.at("capabilityGrantRoot"), authorization.at("warrantRoot")})},
       {"episode_frontier", json::array()},
       {"omission_roots", json::array()},
       {"conflict_roots", json::array()}});
  const auto new_cut_root = cut_response.at("result").at("cut_root");
  const auto ref_response = builder.invoke(
      "ref-cas", {{"transition_id", action_id + ":authorize"},
                  {"ref_name", KFX_REGISTRY_REF},
                  {"expected_old_cut_root", current.present ? json(current.cut_root) : json(nullptr)},
                  {"expected_old_revision", current.revision},
                  {"new_cut_root", new_cut_root},
                  {"kind", current.present ? "advance" : "create"},
                  {"reason_root", root_of({{"schema", "kungfu.kfx.warrant-issuance-reason/v1"},
                                           {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                           {"warrantRoot", authorization.at("warrantRoot")}})}});
  const auto result = ref_response.at("result");
  const json receipt_identity = {{"schema", "kungfu.kfx.warrant-issuance-receipt/v1"},
                                 {"actionId", action_id},
                                 {"operation", authorization.at("operation")},
                                 {"packageKey", authorization.at("packageKey")},
                                 {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                 {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                 {"warrantRoot", authorization.at("warrantRoot")},
                                 {"workObjectId", work_id},
                                 {"warrantObjectId", warrant_id},
                                 {"priorCutRoot", current.present ? json(current.cut_root) : json(nullptr)},
                                 {"cutRoot", result.at("current_cut_root")},
                                 {"priorRevision", current.revision},
                                 {"revision", result.at("current_revision")},
                                 {"kernelReceiptRoot", ref_response.at("receipt_root")},
                                 {"recordedAt", recorded_at}};
  auto receipt = receipt_identity;
  receipt["receiptRoot"] = root_of(receipt_identity);
  receipt["steps"] = builder.steps;
  return receipt;
}

json commit_fact_work(const std::string &runtime_dir, const snapshot &value, const lifecycle_view &current,
                      const json &request, const std::string &operation, const std::string &desired_state,
                      const std::string &observed_state, const json &materialization, const json &authorization,
                      const json &warrant_receipt) {
  const auto key = required_text(request, "packageKey", "request");
  const auto recorded_at = authorization.at("authorizationTime").get<int64_t>();
  const auto action_id = authorization.at("actionId").get<std::string>();
  fact_work_builder builder(runtime_dir, current);
  const auto projection_id = fact_id("registry-projection", KFX_REGISTRY_REF);
  const auto profile_root = native_kfx_domain_profile().at("domainProfileRoot");
  builder.put(projection_id, "kungfu.kfx.registry-projection",
              {{"schema", "kungfu.kfx.registry-projection-fact/v1"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"cutRef", KFX_REGISTRY_REF},
               {"projection", snapshot_projection(value)}});

  std::map<std::string, std::string> package_objects;
  std::map<std::string, std::string> provider_objects;
  for (const auto &package : value.packages) {
    const auto package_key = package.at("key").get<std::string>();
    const auto identity_root = package_identity_root(package);
    const auto package_id = fact_id("package", identity_root);
    package_objects[package_key] = package_id;
    const auto package_desired =
        package_key == key
            ? desired_state
            : (current.desired_states.contains(package_key) ? current.desired_states.at(package_key) : "dormant");
    builder.put(package_id, "kungfu.kfx.package",
                {{"schema", "kungfu.kfx.package-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"identity", {{"objectId", package_id}, {"logicalIdentityRoot", identity_root}}},
                 {"name", package.value("name", "")},
                 {"version", package.value("version", "")},
                 {"manifestRoot", package.at("manifestRoot")},
                 {"packageRoot", package.at("packageRoot")},
                 {"desiredState", package_desired},
                 {"transport", {{"packageKey", package_key}, {"path", package.value("path", "")}}},
                 {"lastActionId", action_id}});
  }
  for (const auto &provider : value.graph.at("providers")) {
    const auto provider_key = provider.at("providerId").get<std::string>();
    const auto provider_id = fact_id("provider", package_identity_root(find_package(value.packages, provider_key)));
    provider_objects[provider_key] = provider_id;
    builder.put(provider_id, "kungfu.kfx.provider",
                {{"schema", "kungfu.kfx.provider-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"provider", provider}});
    if (package_objects.contains(provider_key))
      builder.relate("kfx-package-provides", package_objects.at(provider_key), provider_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"kind", "provider"}});
  }
  for (const auto &contribution : value.graph.at("contributions")) {
    const auto contribution_id = fact_id("contribution", contribution.at("contributionRoot").get<std::string>());
    builder.put(contribution_id, "kungfu.kfx.contribution",
                {{"schema", "kungfu.kfx.contribution-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"contribution", contribution}});
    const auto owner = contribution.value("ownerProviderId", "");
    if (provider_objects.contains(owner))
      builder.relate("kfx-provider-contributes", provider_objects.at(owner), contribution_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"kind", "contribution"}});
  }
  for (const auto &dependency : value.graph.at("dependencies")) {
    const auto dependency_id = fact_id("dependency", dependency.at("dependencyRoot").get<std::string>());
    builder.put(dependency_id, "kungfu.kfx.dependency",
                {{"schema", "kungfu.kfx.dependency-fact/v1"},
                 {"profile", KFX_PROFILE_ID},
                 {"domainProfileRoot", profile_root},
                 {"dependency", dependency}});
    const auto source = dependency.value("providerId", "");
    const auto target = dependency.value("targetProviderId", dependency.value("requiresProviderId", ""));
    if (provider_objects.contains(source)) {
      const auto target_id = provider_objects.contains(target) ? provider_objects.at(target) : dependency_id;
      builder.relate("kfx-provider-depends-on", provider_objects.at(source), target_id,
                     {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"mode", dependency.value("mode", "required")}});
    }
  }

  const auto work_id = authorization.at("workObjectId").get<std::string>();
  const auto warrant_id = authorization.at("warrantObjectId").get<std::string>();
  const auto episode_id = fact_id("episode", action_id);
  const auto settlement_id = fact_id("settlement", action_id);
  builder.put(work_id, "kungfu.kfx.work",
              {{"schema", "kungfu.kfx.work-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"actor", request.value("actor", "anonymous")},
               {"recordedAt", recorded_at},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"status", "settled"}});
  builder.put(warrant_id, "kungfu.kfx.warrant",
              {{"schema", "kungfu.kfx.warrant-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"state", "consumed"},
               {"recordedAt", recorded_at}});
  const auto episode_result = builder.put(episode_id, "kungfu.kfx.episode",
                                          {{"schema", "kungfu.kfx.episode-fact/v2"},
                                           {"profile", KFX_PROFILE_ID},
                                           {"domainProfileRoot", profile_root},
                                           {"actionId", action_id},
                                           {"operation", operation},
                                           {"packageKey", key},
                                           {"basis", authorization.at("basis")},
                                           {"authorityRoots", authorization.at("authorityRoots")},
                                           {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                           {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
                                           {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                           {"grantedCapabilities", authorization.at("grantedCapabilities")},
                                           {"warrantRoot", authorization.at("warrantRoot")},
                                           {"outcome", "applied"},
                                           {"observedState", observed_state},
                                           {"materialization", materialization},
                                           {"recordedAt", recorded_at}});
  builder.put(settlement_id, "kungfu.kfx.settlement",
              {{"schema", "kungfu.kfx.settlement-fact/v2"},
               {"profile", KFX_PROFILE_ID},
               {"domainProfileRoot", profile_root},
               {"actionId", action_id},
               {"operation", operation},
               {"packageKey", key},
               {"basis", authorization.at("basis")},
               {"authorityRoots", authorization.at("authorityRoots")},
               {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
               {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
               {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
               {"grantedCapabilities", authorization.at("grantedCapabilities")},
               {"warrantRoot", authorization.at("warrantRoot")},
               {"outcome", "accepted"},
               {"desiredState", desired_state},
               {"observedState", observed_state},
               {"recordedAt", recorded_at}});
  builder.relate("kfx-work-authorized-by", work_id, warrant_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"},
                  {"actionId", action_id},
                  {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")}});
  builder.relate("kfx-work-observed-in", work_id, episode_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  builder.relate("kfx-work-settled-by", work_id, settlement_id,
                 {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"actionId", action_id}});
  if (package_objects.contains(key))
    builder.relate("kfx-settlement-updates-package", settlement_id, package_objects.at(key),
                   {{"schema", "kungfu.kfx.relation-attributes/v1"}, {"desiredState", desired_state}});

  json object_versions = json::array();
  for (const auto &[object_id, version_root] : builder.versions)
    object_versions.push_back({{"object_id", object_id}, {"version_root", version_root}});
  json relation_roots = json::array();
  for (const auto &root : builder.relations)
    relation_roots.push_back(root);
  json parent_cuts = json::array();
  if (current.present)
    parent_cuts.push_back(current.cut_root);
  const auto episode_number = std::stoull(sha256(action_id).substr(0, 16), nullptr, 16);
  const auto cut_response = builder.invoke(
      "cut-put",
      {{"parent_cut_roots", parent_cuts},
       {"object_versions", object_versions},
       {"active_relation_roots", relation_roots},
       {"declaration_roots", json::array({builder.profile_root})},
       {"admission_roots", json::array({builder.admission_root, authorization.at("authorizationPlanRoot"),
                                        authorization.at("capabilityGrantRoot"), authorization.at("warrantRoot")})},
       {"episode_frontier", json::array({{{"episode_id", episode_number},
                                          {"sealed_content_root", episode_result.at("body_root")},
                                          {"accepted_manifest_frame_uid", std::string("kfx:") + action_id}}})},
       {"omission_roots", json::array()},
       {"conflict_roots", json::array()}});
  const auto new_cut_root = cut_response.at("result").at("cut_root");
  const auto ref_response = builder.invoke(
      "ref-cas",
      {{"transition_id", action_id},
       {"ref_name", KFX_REGISTRY_REF},
       {"expected_old_cut_root", current.present ? json(current.cut_root) : json(nullptr)},
       {"expected_old_revision", current.revision},
       {"new_cut_root", new_cut_root},
       {"kind", current.present ? "advance" : "create"},
       {"reason_root", root_of({{"schema", "kungfu.kfx.settlement-reason/v1"}, {"settlementId", settlement_id}})}});
  const auto result = ref_response.at("result");
  const json receipt_identity = {{"schema", "kungfu.kfx.work-settlement-receipt/v1"},
                                 {"actionId", action_id},
                                 {"operation", operation},
                                 {"packageKey", key},
                                 {"outcome", "applied"},
                                 {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
                                 {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
                                 {"warrantRoot", authorization.at("warrantRoot")},
                                 {"authorityRoots", authorization.at("authorityRoots")},
                                 {"workObjectId", work_id},
                                 {"warrantObjectId", warrant_id},
                                 {"episodeObjectId", episode_id},
                                 {"settlementObjectId", settlement_id},
                                 {"priorCutRoot", authorization.at("basis").at("cutRoot")},
                                 {"authorityCutRoot", warrant_receipt.at("cutRoot")},
                                 {"cutRoot", result.at("current_cut_root")},
                                 {"priorRevision", authorization.at("basis").at("revision")},
                                 {"authorityRevision", warrant_receipt.at("revision")},
                                 {"revision", result.at("current_revision")},
                                 {"warrantReceiptRoot", warrant_receipt.at("receiptRoot")},
                                 {"kernelReceiptRoot", ref_response.at("receipt_root")},
                                 {"recordedAt", recorded_at},
                                 {"materialization", materialization}};
  auto receipt = receipt_identity;
  receipt["receiptRoot"] = root_of(receipt_identity);
  receipt["steps"] = builder.steps;
  return receipt;
}

json apply_lifecycle_mutation(const snapshot &value, const lifecycle_view &lifecycle, const json &plan,
                              const json &request, const std::string &runtime_dir) {
  const auto operation = required_text(request, "operation", "request");
  static const std::set<std::string> operations = {"install", "update",   "remove", "enable",
                                                   "disable", "activate", "qualify"};
  validate_enum(operation, operations, "lifecycle operation");
  const auto package_key = required_text(request, "packageKey", "request");
  const auto package = find_package(value.packages, package_key);
  if (package.is_null())
    refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + package_key);
  const auto &provider = provider_for(value, package_key);
  const auto prior_state = lifecycle.desired_states.contains(package_key) ? lifecycle.desired_states.at(package_key)
                                                                          : std::string{"dormant"};
  if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
      request.at("expectedRevision").get<int64_t>() < 0 ||
      static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision)
    refuse("KF_KFX_CUT_STALE", "named KFX Fact Cut revision changed since planning");
  const json expected_cut = request.contains("expectedCutRoot") ? request.at("expectedCutRoot") : json(nullptr);
  const json actual_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  if (expected_cut != actual_cut)
    refuse("KF_KFX_CUT_STALE", "named KFX Fact Cut root changed since planning");
  if (request.value("expectedRegistryRoot", "") != value.registry_root)
    refuse("KF_KFX_REGISTRY_STALE", "registry projection changed since planning");
  if (request.value("expectedGraphRoot", "") != value.graph_root)
    refuse("KF_KFX_GRAPH_STALE", "semantic graph root changed since planning");
  if (request.value("expectedPlanRoot", "") != plan.at("planRoot").get<std::string>())
    refuse("KF_KFX_PLAN_STALE", "load plan root changed since planning");
  if (request.value("expectedTrustRoot", "") != provider.at("trustRoot").get<std::string>())
    refuse("KF_KFX_ASSESSMENT_STALE", "provider trust root changed since planning");
  if (request.value("expectedPackageRoot", "") != package.at("packageRoot").get<std::string>())
    refuse("KF_KFX_REGISTRY_STALE", "package root changed since planning");
  const auto authorization = mutation_authorization_plan(value, lifecycle, request, plan);
  if (request.value("expectedAuthorizationPlanRoot", "") !=
      authorization.at("authorizationPlanRoot").get<std::string>())
    refuse("KF_KFX_AUTHORIZATION_STALE", "mutation authorization plan changed since planning");
  if (request.value("expectedCapabilityGrantRoot", "") != authorization.at("capabilityGrantRoot").get<std::string>())
    refuse("KF_KFX_CAPABILITY_GRANT_STALE", "mutation does not present the exact planned capability grant root");
  if (request.value("expectedWarrantRoot", "") != authorization.at("warrantRoot").get<std::string>())
    refuse("KF_KFX_WARRANT_INVALID", "mutation does not present the exact planned Warrant root");

  const auto runtime_root = lifecycle_root(runtime_dir);
  const auto install_root = fs::absolute(runtime_dir).parent_path() / "extensions";
  const auto destination = install_root / package_key;
  const auto source = fs::path(package.at("path").get<std::string>());
  const auto next_revision = lifecycle.revision + 2;
  fs::path retained_path;
  fs::path staged_path;
  fs::path content_path;
  bool destination_replaced = false;
  bool destination_materialized = false;
  bool appending_receipt = false;
  json warrant_receipt = nullptr;

  auto rollback = [&] {
    std::error_code ignored;
    if (destination_materialized && fs::exists(destination))
      fs::rename(destination, staged_path, ignored);
    if (destination_replaced && !retained_path.empty() && fs::exists(retained_path) && !fs::exists(destination))
      fs::rename(retained_path, destination, ignored);
    if (!staged_path.empty() && fs::exists(staged_path))
      fs::remove_all(staged_path, ignored);
  };

  if (operation == "install" && fs::exists(destination) && !request.value("replaceExisting", false))
    refuse("KF_KFX_PACKAGE_DUPLICATE", "KFX package is already installed: " + package_key);
  if (operation == "update" && !fs::exists(destination))
    refuse("KF_KFX_MEMBER_MISSING", "cannot update an absent KFX package: " + package_key);
  if (operation == "remove") {
    const auto canonical_destination = fs::weakly_canonical(source);
    const auto canonical_install_root = fs::weakly_canonical(install_root);
    if (canonical_destination.parent_path() != canonical_install_root)
      refuse("KF_KFX_PATH_TRAVERSAL", "remove is confined to the managed KFX install root");
  }
  const auto planned_stage = install_root / (".kfx-stage-" + package_key + "-" + std::to_string(next_revision));
  if ((operation == "install" || operation == "update") && fs::exists(planned_stage))
    refuse("KF_KFX_WRITER_BUSY", "a staged KFX package already exists for this Fact Cut revision");

  try {
    warrant_receipt = issue_fact_work_authority(runtime_dir, value, lifecycle, authorization);
    if (operation == "install" || operation == "update") {
      content_path = runtime_root / "content" / package.at("packageRoot").get<std::string>().substr(7);
      fs::create_directories(content_path.parent_path());
      if (!fs::exists(content_path)) {
        fs::copy(source, content_path, fs::copy_options::recursive);
      } else if (root_of(package_closure(content_path)) != package.at("packageRoot").get<std::string>()) {
        refuse("KF_KFX_SCHEMA_INVALID", "retained KFX content does not match its package root");
      }
      fs::create_directories(install_root);
      staged_path = install_root / (".kfx-stage-" + package_key + "-" + std::to_string(next_revision));
      if (fs::exists(staged_path))
        refuse("KF_KFX_WRITER_BUSY", "a staged KFX package already exists for this Fact Cut revision");
      fs::copy(content_path, staged_path, fs::copy_options::recursive);
      if (fs::exists(destination)) {
        if (operation == "install" && !request.value("replaceExisting", false))
          refuse("KF_KFX_PACKAGE_DUPLICATE", "KFX package is already installed: " + package_key);
        retained_path =
            runtime_root / "retained" /
            (std::to_string(next_revision) + "-" + package_key + "-" + root_of(package_closure(destination)).substr(7));
        fs::create_directories(retained_path.parent_path());
        fs::rename(destination, retained_path);
        destination_replaced = true;
      } else if (operation == "update") {
        refuse("KF_KFX_MEMBER_MISSING", "cannot update an absent KFX package: " + package_key);
      }
      fs::rename(staged_path, destination);
      destination_materialized = true;
    } else if (operation == "remove") {
      const auto canonical_destination = fs::weakly_canonical(source);
      const auto canonical_install_root = fs::weakly_canonical(install_root);
      if (canonical_destination.parent_path() != canonical_install_root)
        refuse("KF_KFX_PATH_TRAVERSAL", "remove is confined to the managed KFX install root");
      retained_path = runtime_root / "retained" /
                      (std::to_string(next_revision) + "-" + package_key + "-" +
                       package.at("packageRoot").get<std::string>().substr(7));
      fs::create_directories(retained_path.parent_path());
      fs::rename(canonical_destination, retained_path);
      destination_replaced = true;
    }

    const auto desired_state = operation == "remove" || operation == "disable" ? "dormant"
                               : operation == "qualify"                        ? prior_state
                                                                               : "active";
    const auto observed_state = provider.at("state") == "degraded" ? "degraded" : "applied";
    snapshot accepted = value;
    for (auto &accepted_package : accepted.packages) {
      if (accepted_package.at("key") != package_key)
        continue;
      if (operation == "remove" && !retained_path.empty())
        accepted_package["path"] = retained_path.string();
      else if (!destination.empty() && fs::exists(destination))
        accepted_package["path"] = destination.string();
      accepted_package["candidate"] = false;
      accepted_package["installed"] = operation != "remove";
      accepted_package["admitted"] = operation != "remove" && operation != "disable";
      accepted_package["runtimeTier"] = "isolated";
      accepted_package["grantedCapabilities"] = authorization.at("grantedCapabilities");
      const auto assessment = authorization.at("assessment");
      if (!assessment.is_null()) {
        const auto &report = assessment.at("trustReport");
        accepted_package["supplyChainGrade"] = report.at("supplyChainGrade");
        accepted_package["admissionGrade"] = report.at("admissionGrade");
      } else {
        accepted_package["supplyChainGrade"] = "unverified";
        accepted_package["admissionGrade"] = "unverified";
      }
      accepted_package["authority"] = {
          {"schema", "kungfu.kfx-package-authority/v1"},
          {"mode", authorization.at("mode")},
          {"packageRoot", accepted_package.at("packageRoot")},
          {"manifestRoot", accepted_package.at("manifestRoot")},
          {"reportRoot", authorization.at("authorityRoots").at("reportRoot")},
          {"admissionPlanRoot", authorization.at("authorityRoots").at("admissionPlanRoot")},
          {"corePolicyRoot", authorization.at("authorityRoots").at("corePolicyRoot")},
          {"requestedPolicyRoot", authorization.at("authorityRoots").at("requestedPolicyRoot")},
          {"policyRoot", authorization.at("authorityRoots").at("policyRoot")},
          {"receiptDependencyRoot", authorization.at("authorityRoots").at("receiptDependencyRoot")},
          {"authorizationPlanRoot", authorization.at("authorizationPlanRoot")},
          {"capabilityDeclarationRoot", authorization.at("capabilityDeclarationRoot")},
          {"capabilityGrantRoot", authorization.at("capabilityGrantRoot")},
          {"warrantRoot", authorization.at("warrantRoot")},
          {"grantedCapabilities", authorization.at("grantedCapabilities")}};
    }
    json structural_diagnostics = json::array();
    for (const auto &diagnostic : accepted.diagnostics) {
      if (diagnostic.value("code", "") == "KF_KFX_OPTIONAL_MEMBER_MISSING")
        structural_diagnostics.push_back(diagnostic);
    }
    accepted.diagnostics = structural_diagnostics;
    accepted.graph = semantic_graph(accepted.packages, accepted.diagnostics);
    accepted.graph_root = accepted.graph.at("graphRoot").get<std::string>();
    json accepted_package_identity = json::array();
    for (const auto &accepted_package : accepted.packages) {
      accepted_package_identity.push_back(
          {{"key", accepted_package.at("key")},
           {"packageRoot", accepted_package.at("packageRoot")},
           {"manifestRoot", accepted_package.at("manifestRoot")},
           {"apiCompatibility", accepted_package.at("apiCompatibility")},
           {"facets", accepted_package.at("facets")},
           {"runtimeTier", accepted_package.at("runtimeTier")},
           {"admissionGrade", accepted_package.at("admissionGrade")},
           {"grantedCapabilities", accepted_package.at("grantedCapabilities")},
           {"capabilityGrantRoot", accepted_package.at("authority").at("capabilityGrantRoot")},
           {"hosts", accepted_package.at("hosts")}});
    }
    accepted.registry_root = root_of({{"schema", "kungfu.kfx-registry-snapshot/v2"},
                                      {"packages", accepted_package_identity},
                                      {"suites", accepted.suites},
                                      {"diagnostics", accepted.diagnostics}});
    const json materialization = {{"contentPath", content_path.empty() ? nullptr : json(content_path.string())},
                                  {"retainedPath", retained_path.empty() ? nullptr : json(retained_path.string())},
                                  {"destinationPath", destination.string()}};
    appending_receipt = true;
    const auto authorized_lifecycle = load_lifecycle(runtime_dir);
    if (!authorized_lifecycle.present ||
        authorized_lifecycle.cut_root != warrant_receipt.at("cutRoot").get<std::string>() ||
        authorized_lifecycle.revision != warrant_receipt.at("revision"))
      refuse("KF_KFX_WARRANT_INVALID", "issued Warrant Cut is not the current mutation authority");
    auto receipt = commit_fact_work(runtime_dir, accepted, authorized_lifecycle, request, operation, desired_state,
                                    observed_state, materialization, authorization, warrant_receipt);
    return {{"schema", "kungfu.kfx.lifecycle-application/v2"},
            {"applied", true},
            {"cutRoot", receipt.at("cutRoot")},
            {"revision", receipt.at("revision")},
            {"desiredState", desired_state},
            {"observedState", observed_state},
            {"verdict", provider.at("state") == "degraded" ? "degraded"
                        : desired_state == "dormant"       ? "dormant"
                                                           : "active"},
            {"receipt", receipt}};
  } catch (const std::invalid_argument &error) {
    rollback();
    if (appending_receipt)
      throw;
    const std::string detail = error.what();
    const auto separator = detail.find(':');
    const auto code = detail.starts_with("KF_") ? detail.substr(0, separator) : "KF_KFX_SCHEMA_INVALID";
    refuse(code, detail);
  } catch (const std::exception &error) {
    rollback();
    if (appending_receipt)
      throw;
    refuse("KF_KFX_SCHEMA_INVALID", error.what());
  } catch (...) {
    rollback();
    if (appending_receipt)
      throw;
    refuse("KF_KFX_SCHEMA_INVALID", "unknown native KFX lifecycle failure");
  }
  return json::object();
}

} // namespace native_registry_internal
} // namespace kungfu::runtime::kfx
