// SPDX-License-Identifier: Apache-2.0

#include <kungfu/runtime/kfx/native_registry.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
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

using json = nlohmann::json;
using namespace native_registry_internal;

json native_kfx_control_bootstrap_policy() { return control_bootstrap_policy(); }

static json query_native_kfx_registry_unchecked(const std::string &action, const json &request,
                                                const std::string &runtime_dir) {
  static const std::set<std::string> actions = {"list",
                                                "inspect",
                                                "resolve",
                                                "plan",
                                                "status",
                                                "assess",
                                                "apply",
                                                "authorize-host",
                                                "history",
                                                "runtime-warrant-issue",
                                                "runtime-warrant-heartbeat",
                                                "runtime-warrant-revoke",
                                                "runtime-warrant-settle",
                                                "runtime-warrant-recover",
                                                "kfd-10-witness"};
  if (!actions.contains(action))
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "unsupported native KFX registry operation: " + action);
  const auto controller = request.value("controller", "");
  const bool control_request = !controller.empty();
  if (control_request && controller != KFX_CONTROL_SUITE_ID)
    refuse("KF_KFX_CONTROL_IDENTITY_MISMATCH", "unknown KFX lifecycle controller");
  for (const auto *field : {"bootstrapPolicy", "systemAuthority", "grantedCapabilities"}) {
    if (request.contains(field))
      refuse("KF_KFX_CONTROL_SELF_GRANT",
             std::string("caller may not supply embedded Control Suite authority field ") + field);
  }
  if (action == "history")
    return lifecycle_history(runtime_dir, request);
  const bool runtime_transition = action == "runtime-warrant-heartbeat" || action == "runtime-warrant-revoke" ||
                                  action == "runtime-warrant-settle" || action == "runtime-warrant-recover";
  const bool runtime_mutation = action == "runtime-warrant-issue" || runtime_transition;
  if ((action == "apply" || runtime_mutation || action == "kfd-10-witness") && runtime_dir.empty())
    refuse("KF_KFX_AUTHORITY_CLAIM_FORBIDDEN", "native KFX authority operation requires an explicit runtime directory");
  std::optional<lifecycle_writer_lock> writer_lock;
  if (action == "apply" || runtime_mutation)
    writer_lock.emplace(runtime_dir);
  if (runtime_transition)
    return authority::transition_runtime_warrant(action, request, runtime_dir);
  if (action == "kfd-10-witness")
    return authority::kfd10_runtime_witness(
        request, runtime_dir, lifecycle_history(runtime_dir, {{"packageKey", request.value("packageKey", "")}}));
  const auto lifecycle = load_lifecycle(runtime_dir);
  auto snapshot_request = request;
  if (action == "apply")
    snapshot_request.erase("expectedRegistryRoot");
  const bool has_observation = snapshot_request.contains("roots") && snapshot_request.at("roots").is_array() &&
                               !snapshot_request.at("roots").empty();
  snapshot selected;
  if (lifecycle.present) {
    selected = lifecycle.authoritative;
    const auto operation = request.value("operation", "");
    if (has_observation && (operation == "install" || operation == "update")) {
      selected = merge_candidate_observation(selected, build_snapshot(snapshot_request));
    }
  } else if (has_observation) {
    selected = build_snapshot(snapshot_request);
  } else if (action == "list" || action == "status") {
    selected = empty_observation();
  } else {
    refuse("KF_KFX_CUT_MISSING", "no named KFX Fact Cut exists; provide a bounded discovery observation to plan");
  }
  const auto load_plan = lifecycle_plan(selected, lifecycle, request);
  if (action == "runtime-warrant-issue") {
    const auto &descriptor = load_plan.at("hostContract");
    return authority::issue_runtime_warrant(descriptor, authorize_host_launch(descriptor, lifecycle, request), request,
                                            runtime_dir);
  }
  if (action == "authorize-host")
    return authorize_host_launch(load_plan.at("hostContract"), lifecycle, request);
  if (control_request && action == "apply") {
    const auto candidate = find_package(selected.packages, KFX_CONTROL_PACKAGE_KEY);
    const json actual_cut = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
    if (!request.contains("expectedRevision") || !request.at("expectedRevision").is_number_integer() ||
        request.at("expectedRevision").get<int64_t>() < 0 ||
        static_cast<uint64_t>(request.at("expectedRevision").get<int64_t>()) != lifecycle.revision ||
        !request.contains("expectedCutRoot") || request.at("expectedCutRoot") != actual_cut || candidate.is_null() ||
        request.value("expectedPackageRoot", "") != candidate.value("packageRoot", ""))
      refuse("KF_KFX_CONTROL_PLAN_STALE", "Control Suite Cut or candidate root changed since planning");
    const auto planned = control_plan(selected, lifecycle, request, load_plan);
    if (request.value("expectedControlPlanRoot", "") != planned.at("controlPlanRoot").get<std::string>())
      refuse("KF_KFX_CONTROL_PLAN_STALE", "Control Suite plan root changed since authorization");
    if (request.value("expectedBootstrapPolicyRoot", "") != planned.at("bootstrapPolicyRoot").get<std::string>())
      refuse("KF_KFX_CONTROL_POLICY_STALE", "Control Suite bootstrap policy root changed since authorization");
    const auto application = apply_lifecycle_mutation(selected, lifecycle, load_plan, request, runtime_dir);
    const auto settled = load_lifecycle(runtime_dir);
    return {{"schema", "kungfu.kfx.control-suite-application/v1"},
            {"controllerId", KFX_CONTROL_SUITE_ID},
            {"controlPlanRoot", planned.at("controlPlanRoot")},
            {"bootstrapPolicyRoot", planned.at("bootstrapPolicyRoot")},
            {"authorizationPlanRoot", planned.at("authorizationPlanRoot")},
            {"capabilityGrantRoot", planned.at("capabilityGrantRoot")},
            {"warrantRoot", planned.at("warrantRoot")},
            {"application", application},
            {"status", control_status(settled)},
            {"verified", true}};
  }
  if (action == "apply")
    return apply_lifecycle_mutation(selected, lifecycle, load_plan, request, runtime_dir);
  if (control_request && action == "status")
    return control_status(lifecycle);
  if (control_request && action == "plan")
    return control_plan(selected, lifecycle, request, load_plan);
  if (control_request)
    refuse("KF_KFX_CONTROL_OPERATION_REJECTED", "Control Suite supports only public status, plan, and apply");
  const json cut_root = lifecycle.present ? json(lifecycle.cut_root) : json(nullptr);
  if (action == "status") {
    return {{"schema", "kungfu.kfx.registry-status/v3"},
            {"authority", lifecycle.present ? "yijinjing-hana-pod-journal" : "observation-preview"},
            {"domainProfileRoot", native_kfx_domain_profile().at("domainProfileRoot")},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"writer", "one-libkungfu-writer-per-runtime-directory"},
            {"readOnly", false},
            {"cacheAuthority", false},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"packageCount", selected.packages.size()},
            {"suiteCount", selected.suites.size()},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "list") {
    json packages = json::array();
    for (const auto &package : selected.packages) {
      auto projected = public_package(package);
      const auto key = package.at("key").get<std::string>();
      const auto desired =
          lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
      const auto observed =
          lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
      projected["desiredState"] = desired;
      projected["observedState"] = observed;
      projected["verdict"] = derived_verdict(provider_for(selected, key), desired, observed);
      projected["state"] = projected["verdict"];
      projected["providerRoot"] = provider_for(selected, key).at("providerRoot");
      packages.push_back(projected);
    }
    return {{"schema", "kungfu.kfx.registry-list/v3"},
            {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"packages", packages},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "inspect") {
    const auto key = required_text(request, "packageKey", "request");
    const auto package = find_package(selected.packages, key);
    if (package.is_null())
      refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + key);
    auto projected = package;
    projected.erase("semantic");
    projected["provider"] = provider_for(selected, key);
    const auto desired =
        lifecycle.desired_states.contains(key) ? lifecycle.desired_states.at(key) : std::string{"dormant"};
    const auto observed =
        lifecycle.observed_states.contains(key) ? lifecycle.observed_states.at(key) : std::string{"unknown"};
    projected["desiredState"] = desired;
    projected["observedState"] = observed;
    projected["verdict"] = derived_verdict(projected.at("provider"), desired, observed);
    projected["state"] = projected["verdict"];
    return {{"schema", "kungfu.kfx.registry-inspection/v3"},
            {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
            {"cutRef", KFX_REGISTRY_REF},
            {"cutRoot", cut_root},
            {"revision", lifecycle.revision},
            {"registryRoot", selected.registry_root},
            {"graphRoot", selected.graph_root},
            {"package", projected},
            {"diagnostics", selected.diagnostics}};
  }
  if (action == "assess") {
    const auto key = required_text(request, "packageKey", "request");
    const auto package = find_package(selected.packages, key);
    if (package.is_null())
      refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + key);
    auto result = assess_package(package, selected.registry_root, request);
    result["authority"] = lifecycle.present ? "pinned-fact-cut" : "observation-preview";
    result["cutRef"] = KFX_REGISTRY_REF;
    result["cutRoot"] = cut_root;
    result["revision"] = lifecycle.revision;
    result["registryRoot"] = selected.registry_root;
    result["graphRoot"] = selected.graph_root;
    result["diagnostics"] = selected.diagnostics;
    return result;
  }
  if (action == "resolve") {
    const auto key = required_text(request, "suiteKey", "request");
    for (const auto &suite : selected.suites) {
      if (suite.at("suiteKey") == key)
        return {{"schema", "kungfu.kfx.registry-resolution/v3"},
                {"authority", lifecycle.present ? "pinned-fact-cut" : "observation-preview"},
                {"cutRef", KFX_REGISTRY_REF},
                {"cutRoot", cut_root},
                {"revision", lifecycle.revision},
                {"registryRoot", selected.registry_root},
                {"graphRoot", selected.graph_root},
                {"suite", suite},
                {"diagnostics", selected.diagnostics}};
    }
    refuse("KF_KFX_MEMBER_MISSING", "KFX Suite is not present in the registry: " + key);
  }

  if (action == "plan" && !request.value("operation", "").empty()) {
    const auto authorization = mutation_authorization_plan(selected, lifecycle, request, load_plan);
    auto result = load_plan;
    result["mutationAuthorization"] = authorization;
    result["authorizationPlanRoot"] = authorization.at("authorizationPlanRoot");
    result["capabilityGrantRoot"] = authorization.at("capabilityGrantRoot");
    result["warrantRoot"] = authorization.at("warrantRoot");
    return result;
  }
  return load_plan;
}

json native_kfx_domain_profile() {
  const auto profile = embedded_domain_profile();
  auto result = profile;
  result["domainProfileRoot"] = root_of(profile);
  return result;
}

json query_native_kfx_registry(const std::string &action, const json &request, const std::string &runtime_dir) {
  try {
    return query_native_kfx_registry_unchecked(action, request, runtime_dir);
  } catch (const json::exception &error) {
    refuse("KF_KFX_SCHEMA_INVALID", "invalid KFX registry document: " + std::string(error.what()));
  }
}

} // namespace kungfu::runtime::kfx
