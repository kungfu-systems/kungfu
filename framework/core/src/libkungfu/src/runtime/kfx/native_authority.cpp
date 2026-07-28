// SPDX-License-Identifier: Apache-2.0

#include "native_authority.h"

#include <algorithm>
#include <cctype>
#include <set>
#include <stdexcept>
#include <vector>

#include <kungfu/yijinjing/storage/content_hash.h>

namespace kungfu::runtime::kfx::authority {

namespace {

using json = nlohmann::json;

[[noreturn]] void refuse(const std::string &code, const std::string &message) {
  throw std::invalid_argument(code + ": " + message);
}

std::string sha256(const std::string &value) {
  return yijinjing::storage::compute_content_hash_value(value, yijinjing::storage::CONTENT_HASH_ALGORITHM_SHA256);
}

std::string root_of(const json &value) { return "sha256:" + sha256(value.dump()); }

std::string required_text(const json &value, const char *field, const std::string &path) {
  if (!value.is_object() || !value.contains(field) || !value.at(field).is_string() ||
      value.at(field).get<std::string>().empty())
    refuse("KF_KFX_SCHEMA_INVALID", path + "." + field + " must be a non-empty string");
  return value.at(field).get<std::string>();
}

json object_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return json::object();
  if (!value.at(field).is_object())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an object");
  return value.at(field);
}

std::vector<std::string> string_array_or_empty(const json &value, const char *field) {
  if (!value.is_object() || !value.contains(field) || value.at(field).is_null())
    return {};
  if (!value.at(field).is_array())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must be an array");
  std::vector<std::string> result;
  for (const auto &entry : value.at(field)) {
    if (!entry.is_string() || entry.get<std::string>().empty())
      refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must contain non-empty strings");
    result.push_back(entry.get<std::string>());
  }
  std::sort(result.begin(), result.end());
  if (std::adjacent_find(result.begin(), result.end()) != result.end())
    refuse("KF_KFX_SCHEMA_INVALID", std::string(field) + " must not contain duplicates");
  return result;
}

void require_exact_fields(const json &value, const std::set<std::string> &fields, const std::string &label) {
  if (!value.is_object())
    refuse("KF_KFX_SCHEMA_INVALID", label + " must be an object");
  for (const auto &field : fields)
    if (!value.contains(field))
      refuse("KF_KFX_SCHEMA_INVALID", label + " is missing required field " + field);
  for (const auto &[field, ignored] : value.items()) {
    (void)ignored;
    if (!fields.contains(field))
      refuse("KF_KFX_SCHEMA_INVALID", label + " contains unknown field " + field);
  }
}

bool is_content_root(const std::string &value) {
  return value.size() == 71 && value.starts_with("sha256:") &&
         std::all_of(value.begin() + 7, value.end(),
                     [](unsigned char ch) { return std::isdigit(ch) != 0 || (ch >= 'a' && ch <= 'f'); });
}

json find_package(const json &packages, const std::string &key) {
  for (const auto &package : packages)
    if (package.at("key") == key)
      return package;
  return nullptr;
}

json canonical_approval_roots(const json &request) {
  const auto roots = string_array_or_empty(request, "approvalRoots");
  json result = json::array();
  for (const auto &root : roots) {
    if (!is_content_root(root))
      refuse("KF_KFX_APPROVAL_INVALID", "approval roots must be canonical sha256 content roots");
    result.push_back(root);
  }
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}

std::string fact_id(const std::string &kind, const std::string &identity) {
  return "fact:" + sha256("kungfu-kfx-domain-profile:" + kind + ":" + identity).substr(0, 32);
}

} // namespace

json plan(const json &packages, const std::string &registry_root, const std::string &graph_root, const json &prior_cut,
          uint64_t revision, const json &request, const json &load_plan, const assessment_fn &assess) {
  const auto operation = required_text(request, "operation", "request");
  static const std::set<std::string> operations = {"install", "update",   "remove", "enable",
                                                   "disable", "activate", "qualify"};
  if (!operations.contains(operation))
    refuse("KF_KFX_SCHEMA_INVALID", "lifecycle operation is not supported: " + operation);
  const auto package_key = required_text(request, "packageKey", "request");
  const auto package = find_package(packages, package_key);
  if (package.is_null())
    refuse("KF_KFX_MEMBER_MISSING", "KFX package is not present in the registry: " + package_key);
  if (!request.contains("authorizationTime") || !request.at("authorizationTime").is_number_integer() ||
      request.at("authorizationTime").get<int64_t>() < 0)
    refuse("KF_KFX_AUTHORIZATION_REQUIRED", "mutation planning requires a non-negative authorizationTime");
  const auto authorization_time = request.at("authorizationTime").get<int64_t>();
  const auto approval_roots = canonical_approval_roots(request);

  json assessment = nullptr;
  json report_root = nullptr;
  json admission_plan_root = nullptr;
  json receipt_dependency_root = nullptr;
  json core_policy_root = nullptr;
  json requested_policy_root = nullptr;
  json policy_root = nullptr;
  json dependency_root = nullptr;
  json required_approvals = json::array();
  std::string mode = "release-passport";

  if (operation == "remove" || operation == "disable") {
    mode = "owner-system-recovery";
    const auto recovery = object_or_empty(request, "recoveryWarrant");
    if (recovery.empty() || recovery.value("schema", "") != "kungfu.kfx-recovery-warrant/v1")
      refuse("KF_KFX_RECOVERY_WARRANT_REQUIRED",
             "disable/remove requires an explicit owner or system recovery Warrant");
    require_exact_fields(recovery,
                         {"schema", "issuerClass", "operation", "packageRoot", "expectedCutRoot", "expectedRevision",
                          "approvalRoots", "issuedAt", "expiresAt", "nonce"},
                         "recovery Warrant");
    const auto issuer_class = recovery.value("issuerClass", "");
    if (issuer_class != "workspace-owner" && issuer_class != "core-system")
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant issuer must be workspace-owner or core-system");
    if (recovery.value("operation", "") != operation ||
        recovery.value("packageRoot", "") != package.at("packageRoot").get<std::string>() ||
        recovery.at("expectedCutRoot") != prior_cut || !recovery.at("expectedRevision").is_number_unsigned() ||
        recovery.at("expectedRevision").get<uint64_t>() != revision)
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant does not bind the exact package and prior Cut");
    if (!recovery.at("issuedAt").is_number_integer() || !recovery.at("expiresAt").is_number_integer() ||
        recovery.at("issuedAt").get<int64_t>() < 0 ||
        recovery.at("expiresAt").get<int64_t>() <= recovery.at("issuedAt").get<int64_t>() ||
        authorization_time < recovery.at("issuedAt").get<int64_t>() ||
        authorization_time >= recovery.at("expiresAt").get<int64_t>())
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant is not fresh at authorizationTime");
    if (!recovery.at("approvalRoots").is_array() || recovery.at("approvalRoots") != approval_roots ||
        approval_roots.empty())
      refuse("KF_KFX_RECOVERY_WARRANT_INVALID", "recovery Warrant requires the exact non-empty approval roots");
    policy_root = root_of({{"schema", "kungfu.kfx-recovery-policy/v1"},
                           {"issuerClasses", json::array({"core-system", "workspace-owner"})},
                           {"operations", json::array({"disable", "remove"})},
                           {"packageCooperationRequired", false}});
    core_policy_root = policy_root;
    dependency_root = root_of(recovery);
    receipt_dependency_root = root_of({{"recoveryWarrantRoot", dependency_root},
                                       {"policyRoot", policy_root},
                                       {"packageRoot", package.at("packageRoot")},
                                       {"priorCutRoot", prior_cut},
                                       {"priorRevision", revision}});
    required_approvals = json::array({issuer_class});
  } else {
    auto assessment_request = request;
    assessment_request["cut"] = prior_cut.is_null() ? "unborn" : prior_cut;
    assessment_request["operation"] = operation;
    assessment = assess(package, registry_root, assessment_request);
    const auto &report = assessment.at("trustReport");
    const auto &admission = assessment.at("admissionPlan");
    if (!admission.value("allowed", false) || !report.value("fresh", false))
      refuse("KF_KFX_ADMISSION_REQUIRED",
             "mutation requires a fresh, exact-root, allowed Release Passport AdmissionPlan");
    report_root = report.at("reportRoot");
    admission_plan_root = admission.at("planRoot");
    receipt_dependency_root = admission.at("receiptDependencyRoot");
    policy_root = report.at("policyRoot");
    core_policy_root = report.at("corePolicyRoot");
    requested_policy_root = report.at("requestedPolicyRoot");
    dependency_root = admission.at("dependencyRoot");
    required_approvals = admission.at("requiredApprovals");
    if (!required_approvals.empty() && approval_roots.empty())
      refuse("KF_KFX_APPROVAL_REQUIRED", "AdmissionPlan requires explicit approval roots");
  }

  const json basis = {{"cutRoot", prior_cut},
                      {"revision", revision},
                      {"registryRoot", registry_root},
                      {"graphRoot", graph_root},
                      {"loadPlanRoot", load_plan.at("planRoot")},
                      {"packageRoot", package.at("packageRoot")},
                      {"dependencyRoot", dependency_root}};
  const json authority_roots = {{"reportRoot", report_root},
                                {"admissionPlanRoot", admission_plan_root},
                                {"receiptDependencyRoot", receipt_dependency_root},
                                {"corePolicyRoot", core_policy_root},
                                {"requestedPolicyRoot", requested_policy_root},
                                {"policyRoot", policy_root},
                                {"packageRoot", package.at("packageRoot")},
                                {"dependencyRoot", dependency_root},
                                {"requiredApprovals", required_approvals},
                                {"approvalRoots", approval_roots}};
  const auto requested_capabilities = string_array_or_empty(request, "requestedCapabilities");
  const auto declared_capabilities = package.at("declaredCapabilities").get<std::vector<std::string>>();
  for (const auto &capability : requested_capabilities) {
    if (std::find(declared_capabilities.begin(), declared_capabilities.end(), capability) ==
        declared_capabilities.end())
      refuse("KF_KFX_CAPABILITY_BROADENING",
             "capability grant contains a capability absent from the exact package declaration");
  }
  const auto authority_basis_root = root_of({{"schema", "kungfu.kfx-mutation-authority-basis/v1"},
                                             {"mode", mode},
                                             {"operation", operation},
                                             {"packageKey", package_key},
                                             {"basis", basis},
                                             {"authorityRoots", authority_roots},
                                             {"requestedCapabilities", requested_capabilities},
                                             {"authorizationTime", authorization_time}});
  const json capability_declaration = {{"schema", "kungfu.kfx-capability-declaration/v1"},
                                       {"packageKey", package_key},
                                       {"packageRoot", package.at("packageRoot")},
                                       {"capabilities", declared_capabilities}};
  const auto capability_declaration_root = root_of(capability_declaration);
  const json capability_grant_identity = {{"schema", "kungfu.kfx-capability-grant/v1"},
                                          {"mode", mode},
                                          {"operation", operation},
                                          {"packageKey", package_key},
                                          {"packageRoot", package.at("packageRoot")},
                                          {"capabilityDeclarationRoot", capability_declaration_root},
                                          {"corePolicyRoot", core_policy_root},
                                          {"requestedPolicyRoot", requested_policy_root},
                                          {"policyRoot", policy_root},
                                          {"reportRoot", report_root},
                                          {"admissionPlanRoot", admission_plan_root},
                                          {"receiptDependencyRoot", receipt_dependency_root},
                                          {"authorityBasisRoot", authority_basis_root},
                                          {"requiredApprovals", required_approvals},
                                          {"approvalRoots", approval_roots},
                                          {"grantedCapabilities", requested_capabilities},
                                          {"priorCutRoot", prior_cut},
                                          {"priorRevision", revision},
                                          {"issuedAt", authorization_time}};
  const auto capability_grant_root = root_of(capability_grant_identity);
  const auto warrant_root = root_of({{"schema", "kungfu.kfx.warrant-fact/v2"},
                                     {"mode", mode},
                                     {"operation", operation},
                                     {"packageKey", package_key},
                                     {"authorityBasisRoot", authority_basis_root},
                                     {"capabilityGrantRoot", capability_grant_root},
                                     {"basis", basis},
                                     {"authorityRoots", authority_roots},
                                     {"state", "issued"},
                                     {"issuedAt", authorization_time}});
  json identity = {{"schema", "kungfu.kfx-mutation-authorization-plan/v1"},
                   {"mode", mode},
                   {"operation", operation},
                   {"packageKey", package_key},
                   {"basis", basis},
                   {"authorityRoots", authority_roots},
                   {"requestedCapabilities", requested_capabilities},
                   {"grantedCapabilities", requested_capabilities},
                   {"capabilityDeclaration", capability_declaration},
                   {"capabilityDeclarationRoot", capability_declaration_root},
                   {"capabilityGrant", capability_grant_identity},
                   {"capabilityGrantRoot", capability_grant_root},
                   {"authorizationTime", authorization_time},
                   {"warrantRoot", warrant_root},
                   {"warrantObjectId", fact_id("warrant", warrant_root)},
                   {"workObjectId", fact_id("work", authority_basis_root)}};
  const auto authorization_plan_root = root_of(identity);
  auto result = identity;
  result["authorizationPlanRoot"] = authorization_plan_root;
  result["actionId"] = "kfx-action:" + sha256(authorization_plan_root).substr(0, 32);
  result["assessment"] = assessment;
  return result;
}

} // namespace kungfu::runtime::kfx::authority
